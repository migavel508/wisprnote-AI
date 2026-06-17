import { getSecrets } from '../secrets';

/**
 * Turbopuffer client for the unified BRAIN index — one vector per knowledge_item
 * (meeting | jira | github | …). Lets chat retrieve the most RELEVANT records across
 * ALL sources via a single ANN query, instead of source-by-source recency SQL.
 * Mirrors kgVector (cosine distance), but its own namespace + a workspace_id filter so
 * a query is hard-scoped to (user_id AND workspace_id) — tenant + workspace isolation.
 */

const REGION = 'gcp-us-central1';
const NAMESPACE = 'lumina-knowledge-items';
const BASE = `https://${REGION}.turbopuffer.com/v2/namespaces/${NAMESPACE}`;

async function tpFetch(path: string, body: unknown, timeoutMs = 8000): Promise<any | null> {
  const { TURBOPUFFER_API_KEY } = await getSecrets();
  if (!TURBOPUFFER_API_KEY) return null;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const resp = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TURBOPUFFER_API_KEY}` },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      if (resp.status !== 404) {
        const t = await resp.text().catch(() => '');
        console.error('brain_vector_not_ok', JSON.stringify({ path, status: resp.status, body: t.slice(0, 200) }));
      }
      return null;
    }
    return await resp.json();
  } catch (e: any) {
    console.error('brain_vector_fetch_err', JSON.stringify({ path, name: e?.name, message: e?.message }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface ItemVectorRow { id: string; vector: number[]; user_id: string; workspace_id: string; source: string }

/** Upsert knowledge_item vectors. Idempotent by id (= knowledge_item.id). */
export async function upsertItemVectors(rows: ItemVectorRow[]): Promise<boolean> {
  if (rows.length === 0) return true;
  const res = await tpFetch('', {
    upsert_rows: rows.map((r) => ({ id: r.id, vector: r.vector, user_id: r.user_id, workspace_id: r.workspace_id, source: r.source })),
    distance_metric: 'cosine_distance',
    schema: { user_id: { type: 'string' }, workspace_id: { type: 'string' }, source: { type: 'string' } },
  }, 15000);
  return res != null;
}

export interface ItemHit { id: string; source: string; similarity: number }

/** Top-K nearest knowledge_items to `vector` within (user, workspace). null on failure.
 *  `sources` restricts the search to specific sources (e.g. ['jira','github']) — essential
 *  for candidate generation, since meetings cluster so tightly they'd otherwise fill every
 *  top-K slot and crowd out the cross-source work items we actually want. */
export async function queryNearestItems(userId: string, workspaceId: string, vector: number[], k: number, sources?: string[]): Promise<ItemHit[] | null> {
  const filters: any[] = [['user_id', 'Eq', userId], ['workspace_id', 'Eq', workspaceId]];
  if (sources?.length) filters.push(['source', 'In', sources]);
  const res = await tpFetch('/query', {
    rank_by: ['vector', 'ANN', vector],
    top_k: k,
    filters: ['And', filters],
    include_attributes: ['source'],
  });
  if (res == null) return null;
  const rows: any[] = Array.isArray(res.rows) ? res.rows : Array.isArray(res) ? res : [];
  const out: ItemHit[] = [];
  for (const r of rows) {
    const id = r.id ?? r.ID;
    if (id == null) continue;
    const dist = typeof r.$dist === 'number' ? r.$dist : typeof r.dist === 'number' ? r.dist : undefined;
    out.push({ id: String(id), source: r.source ?? '', similarity: dist == null ? 0 : Math.max(0, 1 - dist) });
  }
  return out;
}
