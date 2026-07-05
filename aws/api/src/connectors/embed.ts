import { createHash } from 'crypto';
import { query } from '../db';
import { embedTexts, getMeetingVectors } from '../kgEmbed';
import { ensureConnectorSchema } from './schema';
import { upsertItemVectors, queryNearestItems } from './brainVector';
import { neighboursOf } from './brainEdges';

/** Stable fingerprint of the exact text we embed — so re-embedding is gated on CONTENT change, not
 *  on synced_at (which a re-sync bumps even when nothing changed → the recurring embed waste). */
const contentHash = (text: string): string => createHash('sha1').update(text).digest('hex').slice(0, 16);

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
/** Additive: a marker column so we re-embed only new/changed items, + a content hash so a re-sync
 *  that only bumps synced_at (unchanged body) does NOT trigger a wasted re-embed. */
function ensureEmbedColumn(): Promise<void> {
  if (!colReady) {
    colReady = query(`ALTER TABLE knowledge_item ADD COLUMN IF NOT EXISTS embedded_at TIMESTAMPTZ`)
      .then(() => query(`ALTER TABLE knowledge_item ADD COLUMN IF NOT EXISTS embedded_hash TEXT`))
      .then(() => {}).catch((e) => { colReady = null; throw e; });
  }
  return colReady;
}

function itemText(r: any): string {
  // Priority: enriched diff-summary (Tier 2, only link candidates have it) → fingerprint
  // (Tier 1, deterministic filenames+stats — cheap, strong candidate signal) → raw body
  // (fluff message). This lets ALL commits be matched semantically without an LLM pass.
  const content = (r.enriched_summary || r.fingerprint || r.body || '').toString().slice(0, PER_ITEM_CHARS);
  return [r.title, content].filter(Boolean).join('\n').slice(0, PER_ITEM_CHARS + 200);
}

/** Embed a bounded batch of new/changed knowledge_items into the brain index. Content-hash gated: an
 *  item whose embed-text is byte-identical to what we last embedded is SKIPPED (just advance the
 *  cursor) — this is the fix for re-embedding every item on every 15-min sync even when unchanged. */
export async function embedKnowledgeItems(cap = EMBED_CAP): Promise<{ embedded: number; skipped: number }> {
  await ensureConnectorSchema();
  await ensureEmbedColumn();
  const rows = await query<any>(
    `SELECT id, user_id, workspace_id, source, source_id, title, body, enriched_summary, fingerprint, embedded_hash
       FROM knowledge_item
      WHERE embedded_at IS NULL OR embedded_at < synced_at
      ORDER BY synced_at DESC LIMIT ${cap}`,
  ).catch(() => []);
  if (!rows.length) return { embedded: 0, skipped: 0 };

  const enriched = rows.map((r) => { const text = itemText(r); return { r, text, h: contentHash(text) }; });
  const changed = enriched.filter((x) => x.h !== x.r.embedded_hash);
  const unchanged = enriched.filter((x) => x.h === x.r.embedded_hash);

  // Unchanged content — advance the cursor so it drops out of the candidate set WITHOUT re-embedding.
  if (unchanged.length) {
    await query(`UPDATE knowledge_item SET embedded_at = NOW() WHERE id = ANY($1)`, [unchanged.map((x) => x.r.id)]).catch(() => {});
  }
  if (!changed.length) { if (unchanged.length) console.log('brain_embed', JSON.stringify({ embedded: 0, skipped: unchanged.length })); return { embedded: 0, skipped: unchanged.length }; }

  // EMBED-ONCE: for meetings, REUSE the vector the KG pipeline already computed (kg_embeddings) instead
  // of embedding the same meeting a second time. Fetch per user; fall back to embedding any meeting the
  // KG hasn't reached yet + all non-meeting items.
  const vecById = new Map<string, number[]>();
  const meetingByUser = new Map<string, string[]>();
  for (const x of changed) if (x.r.source === 'meeting' && x.r.source_id) (meetingByUser.get(x.r.user_id) ?? meetingByUser.set(x.r.user_id, []).get(x.r.user_id)!).push(String(x.r.source_id));
  for (const [uid, tids] of meetingByUser) {
    const m = await getMeetingVectors(uid, tids).catch(() => new Map());
    for (const x of changed) if (x.r.source === 'meeting' && x.r.user_id === uid && m.has(String(x.r.source_id))) vecById.set(String(x.r.id), m.get(String(x.r.source_id))!);
  }
  const toEmbed = changed.filter((x) => !vecById.has(String(x.r.id)));
  if (toEmbed.length) {
    const vectors = await embedTexts(toEmbed.map((x) => x.text));
    if (!vectors) return { embedded: 0, skipped: unchanged.length };   // transient embed failure → retry next tick
    toEmbed.forEach((x, i) => vecById.set(String(x.r.id), vectors[i]));
  }
  const ok = await upsertItemVectors(changed.map((x) => ({
    id: String(x.r.id), vector: vecById.get(String(x.r.id))!, user_id: x.r.user_id, workspace_id: x.r.workspace_id, source: x.r.source,
  })).filter((r) => Array.isArray(r.vector) && r.vector.length));
  if (!ok) return { embedded: 0, skipped: unchanged.length };
  // Record BOTH the cursor and the content hash we embedded, so the next unchanged sync skips it.
  await query(
    `UPDATE knowledge_item k SET embedded_at = NOW(), embedded_hash = v.h
       FROM (SELECT unnest($1::bigint[]) AS id, unnest($2::text[]) AS h) v WHERE k.id = v.id`,
    [changed.map((x) => Number(x.r.id)), changed.map((x) => x.h)],
  ).catch(() => {});
  console.log('brain_embed', JSON.stringify({ embedded: changed.length, skipped: unchanged.length }));
  return { embedded: changed.length, skipped: unchanged.length };
}

// RERANK helpers (Memory-OS — deterministic, $0). The held-out set showed retrieval RECALL is strong
// (0.91) but RANKING is weak (MRR 0.62): the right memory is retrieved but not #1. Rerank reorders the
// already-retrieved top-k by a blend of signals, so it can lift MRR without touching recall@k.
const RERANK_STOP = new Set(['the', 'a', 'an', 'of', 'to', 'and', 'is', 'are', 'what', 'was', 'were', 'for', 'on', 'in', 'about', 'how', 'where', 'did', 'do', 'does', 'with', 'that', 'this', 'it', 'we', 'our', 'their', 'status', 'decided', 'stand', 'across', 'meetings']);
const rerankTokens = (s: string): Set<string> => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(' ').filter((t) => t.length >= 3 && !RERANK_STOP.has(t)));
/** Composite rerank score: vector similarity + a boost when a specific ATOM matched (high precision) +
 *  lexical overlap of query terms with the item's title/body (recovers the entity even on rewordings)
 *  + a mild recency bonus. Weights are conservative so vector similarity still leads. */
// Vector similarity DOMINATES; atom-match + recency are gentle tiebreakers only. Lexical overlap is
// intentionally dropped — it demotes correct items on reworded queries (measured 83→56). These weights
// are small so the vector ranking is only nudged, not overturned.
function rerankScore(r: any, _qTokens: Set<string>): number {
  const sim = Number(r._sim) || 0;
  const atom = r._matched ? 0.04 : 0;          // an atom hit is a tighter, higher-precision match
  const days = r.occurred_at ? (Date.now() - new Date(r.occurred_at).getTime()) / 86_400_000 : 9999;
  const rec = days < 9999 ? Math.max(0, 1 - days / 180) : 0;
  return sim + atom + 0.02 * rec;
}

/** Semantic cross-source retrieval: top-K knowledge_items most relevant to `q`. Phase 3: a hit may be
 *  a DERIVED MEMORY UNIT (decision/action/topic) — it is resolved to its PARENT item, deduped keeping
 *  the best rank, and the item is tagged `_matched` with the unit type that hit (a tighter match than
 *  the whole-item vector, which is what lifts recall). We over-fetch then dedup to k parents. */
export async function semanticSearchItems(userId: string, workspaceId: string, q: string, k = 12, opts?: { rerank?: boolean; noChunks?: boolean }): Promise<any[]> {
  if (!q || q.trim().length < 2) return [];
  const qv = await embedTexts([q]).catch(() => null);
  if (!qv?.[0]) return [];
  // noChunks (A/B): restrict to non-chunk granularities to measure what item chunks add.
  const unitTypes = opts?.noChunks ? ['item', 'decision', 'action', 'topic'] : undefined;
  const hits = await queryNearestItems(userId, workspaceId, qv[0], Math.min(k * 3, 40), undefined, unitTypes).catch(() => null);
  if (!hits?.length) return [];
  // Resolve each hit to its parent knowledge_item; keep the best rank + best similarity + matched unit.
  const parentRank = new Map<string, number>();
  const parentSim = new Map<string, number>();
  const matchedUnit = new Map<string, { type: string; id: string }>();
  hits.forEach((h, i) => {
    const pid = h.parent_id || h.id;
    if (!parentRank.has(pid)) parentRank.set(pid, i);
    parentSim.set(pid, Math.max(parentSim.get(pid) ?? 0, h.similarity));
    if (h.unit_type && h.unit_type !== 'item' && !matchedUnit.has(pid)) matchedUnit.set(pid, { type: h.unit_type, id: h.id });
  });
  const ids = [...parentRank.keys()].map(Number).filter(Number.isFinite).slice(0, k * 2);
  const rows: any[] = ids.length ? await query<any>(
    `SELECT id, source, source_id, type, title, body, people, links, occurred_at
       FROM knowledge_item WHERE user_id=$1 AND id = ANY($2)`,
    [userId, ids],
  ) : [];
  for (const r of rows) {
    const m = matchedUnit.get(String(r.id)); if (m) { r._matched = m.type; r._matchedUnitId = m.id; }
    r._sim = parentSim.get(String(r.id)) ?? 0;
  }
  // Parent-less STATE units (the space brief) — their "parent" is their own id, not a knowledge_item.
  // Surface them as synthetic results so work-state is retrievable (the "threads + brief" chip).
  const foundIds = new Set(rows.map((r: any) => String(r.id)));
  const unresolved = [...parentRank.keys()].filter((p) => !foundIds.has(p));
  if (unresolved.length) {
    const su = await query<any>(`SELECT id, unit_type, text, source FROM mem_unit WHERE id = ANY($1)`, [unresolved]).catch(() => []);
    for (const u of su) rows.push({ id: u.id, source: u.source || 'brain-state', source_id: u.id, type: u.unit_type,
      title: u.unit_type === 'brief' ? 'Space brief' : 'Work status', body: u.text, occurred_at: null,
      _matched: u.unit_type, _matchedUnitId: u.id, _sim: parentSim.get(String(u.id)) ?? 0 });
  }
  if (!rows.length) return [];
  if (opts?.rerank) {
    const qTokens = rerankTokens(q);
    for (const r of rows) r._score = rerankScore(r, qTokens);
    rows.sort((a: any, b: any) => (b._score - a._score) || ((parentRank.get(String(a.id)) ?? 99) - (parentRank.get(String(b.id)) ?? 99)));
  } else {
    rows.sort((a: any, b: any) => (parentRank.get(String(a.id)) ?? 99) - (parentRank.get(String(b.id)) ?? 99));
  }
  return rows.slice(0, k);
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
