import { query } from '../db';
import { embedTexts } from '../kgEmbed';
import { ensureConnectorSchema } from './schema';
import { upsertItemVectors, queryNearestItems } from './brainVector';
import { neighboursOf } from './brainEdges';

/**
 * Brain embedding (Living-Brain Phase B). Embeds knowledge_item rows (Jira, GitHub, …)
 * into the unified Turbopuffer index so chat can retrieve the most RELEVANT records
 * across all sources — not just the most recent. Reuses the meeting embedder
 * (`embedTexts`, gemini-embedding-001, 3072-dim) so everything shares one vector space.
 * Idempotent + incremental: only rows that are new or changed since last embed.
 */

const EMBED_CAP = 64;            // rows embedded per sweep tick (bounded)
const PER_ITEM_CHARS = 2200;

let colReady: Promise<void> | null = null;
/** Additive: a marker column so we re-embed only new/changed items. */
function ensureEmbedColumn(): Promise<void> {
  if (!colReady) {
    colReady = query(`ALTER TABLE knowledge_item ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ`)
      .then(() => {}).catch((e) => { colReady = null; throw e; });
  }
  return colReady;
}

function itemText(r: any): string {
  return [r.title, (r.body || '').toString().slice(0, PER_ITEM_CHARS)].filter(Boolean).join('\n').slice(0, PER_ITEM_CHARS + 200);
}

/** Embed a bounded batch of new/changed knowledge_items into the brain index. */
export async function embedKnowledgeItems(cap = EMBED_CAP): Promise<{ embedded: number }> {
  await ensureConnectorSchema();
  await ensureEmbedColumn();
  const rows = await query<any>(
    `SELECT id, user_id, workspace_id, source, title, body
       FROM knowledge_item
      WHERE embedded_at IS NULL OR embedded_at < synced_at
      ORDER BY synced_at DESC LIMIT ${cap}`,
  );
  if (!rows.length) return { embedded: 0 };
  const vectors = await embedTexts(rows.map(itemText));
  if (!vectors) return { embedded: 0 };   // transient embed failure → retry next tick
  const ok = await upsertItemVectors(rows.map((r, i) => ({
    id: String(r.id), vector: vectors[i], user_id: r.user_id, workspace_id: r.workspace_id, source: r.source,
  })));
  if (!ok) return { embedded: 0 };
  await query(`UPDATE knowledge_item SET embedded_at = NOW() WHERE id = ANY($1)`, [rows.map((r) => r.id)]);
  console.log('brain_embed', JSON.stringify({ embedded: rows.length }));
  return { embedded: rows.length };
}

/** Semantic cross-source retrieval: top-K knowledge_items most relevant to `q`. */
export async function semanticSearchItems(userId: string, workspaceId: string, q: string, k = 12): Promise<any[]> {
  if (!q || q.trim().length < 2) return [];
  const qv = await embedTexts([q]).catch(() => null);
  if (!qv?.[0]) return [];
  const hits = await queryNearestItems(userId, workspaceId, qv[0], k).catch(() => null);
  if (!hits?.length) return [];
  const ids = hits.map((h) => Number(h.id)).filter(Number.isFinite);
  if (!ids.length) return [];
  const rows = await query<any>(
    `SELECT id, source, source_id, type, title, body, people, links, occurred_at
       FROM knowledge_item WHERE user_id=$1 AND id = ANY($2)`,
    [userId, ids],
  );
  const order = new Map<string, number>(hits.map((h, i) => [String(h.id), i] as [string, number]));
  rows.sort((a: any, b: any) => (order.get(String(a.id)) ?? 99) - (order.get(String(b.id)) ?? 99));
  return rows;
}

/**
 * Graph-expansion (Phase D): given semantically-retrieved seed items, pull their LINKED
 * neighbours across tools (brain_edge) so the answer can trace lineage (e.g. a Jira
 * issue + the GitHub PR related to it appear together). Annotates seeds with `_linked`
 * (neighbour title + relation) and appends the neighbour items (tagged `_linkedVia`).
 */
export async function expandWithNeighbours(userId: string, workspaceId: string, seed: any[], extraCap = 8): Promise<any[]> {
  if (!seed.length) return seed;
  const seedIds = new Set(seed.map((r) => String(r.id)));
  const linksBySeed = new Map<string, Array<{ id: string; relation: string }>>();
  const relById = new Map<string, string>();
  const neighbourIds = new Set<string>();

  for (const r of seed.slice(0, 8)) {
    const edges = await neighboursOf(userId, workspaceId, 'item', String(r.id), 8).catch(() => []);
    for (const e of edges) {
      const isSrc = e.src_kind === 'item' && e.src_id === String(r.id);
      const nKind = isSrc ? e.dst_kind : e.src_kind;
      const nId = isSrc ? e.dst_id : e.src_id;
      if (nKind !== 'item') continue;   // (meeting neighbours are surfaced via the meeting path)
      (linksBySeed.get(String(r.id)) ?? linksBySeed.set(String(r.id), []).get(String(r.id))!).push({ id: nId, relation: e.relation });
      if (!seedIds.has(nId)) { neighbourIds.add(nId); if (!relById.has(nId)) relById.set(nId, e.relation); }
    }
  }

  const extraIds = [...neighbourIds].slice(0, extraCap).map(Number).filter(Number.isFinite);
  let extras: any[] = [];
  if (extraIds.length) {
    extras = await query<any>(
      `SELECT id, source, source_id, type, title, body, people, links, occurred_at
         FROM knowledge_item WHERE user_id=$1 AND id = ANY($2)`,
      [userId, extraIds],
    ).catch(() => []);
    for (const x of extras) x._linkedVia = relById.get(String(x.id));
  }
  // Annotate seeds with their linked neighbour titles (for lineage in the answer).
  const titleById = new Map([...seed, ...extras].map((r) => [String(r.id), r.title]));
  for (const r of seed) {
    const links = linksBySeed.get(String(r.id));
    if (links?.length) r._linked = links.map((l) => ({ title: titleById.get(l.id) || l.id, relation: l.relation })).filter((l) => l.title);
  }
  return [...seed, ...extras];
}
