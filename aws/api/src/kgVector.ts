import { getSecrets } from './secrets';

/**
 * Server-side Turbopuffer client for the knowledge-graph pipeline.
 *
 * Holds one vector per meeting (the meeting-level KG embedding from Stage B) in a
 * dedicated namespace, so Stage C can find a new meeting's nearest neighbours via
 * an indexed ANN query — across the WHOLE corpus, any age — in sub-linear time,
 * instead of brute-forcing the 200 most-recent vectors in the Lambda. This is the
 * change that makes the reasoning node correct AND cheap at 1k–1M meetings.
 *
 * Multi-tenant: every row is stamped with user_id and every query is hard-filtered
 * to it (mirrors the proxy's tenantScopeTurbopuffer). Cosine distance; similarity
 * = 1 − distance.
 */

const REGION = 'gcp-us-central1';
const NAMESPACE = 'lumina-kg-meetings';
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
      // 404 = namespace doesn't exist yet (no upserts) — benign for queries.
      if (resp.status !== 404) {
        const t = await resp.text().catch(() => '');
        console.error('kg_vector_not_ok', JSON.stringify({ path, status: resp.status, body: t.slice(0, 200) }));
      }
      return null;
    }
    return await resp.json();
  } catch (e: any) {
    console.error('kg_vector_fetch_err', JSON.stringify({ path, name: e?.name, message: e?.message }));
    return null;
  } finally {
    clearTimeout(timer);
  }
}

export interface MeetingVectorRow { user_id: string; task_id: string; vector: number[]; created_ms: number }

/** Upsert many meeting vectors in one request. Idempotent by id (=task_id). */
export async function upsertMeetingVectors(rows: MeetingVectorRow[]): Promise<boolean> {
  if (rows.length === 0) return true;
  const res = await tpFetch('', {
    upsert_rows: rows.map((r) => ({ id: r.task_id, vector: r.vector, user_id: r.user_id, created_ms: r.created_ms })),
    distance_metric: 'cosine_distance',
    schema: { user_id: { type: 'string' }, created_ms: { type: 'int' } },
  }, 15000);
  return res != null;
}

/** Upsert one meeting's KG vector. Idempotent by id (=task_id). Returns false on failure (caller may retry). */
export async function upsertMeetingVector(userId: string, taskId: string, vector: number[], createdMs: number): Promise<boolean> {
  return upsertMeetingVectors([{ user_id: userId, task_id: taskId, vector, created_ms: createdMs }]);
}

export interface Neighbour { taskId: string; similarity: number }

/**
 * Top-K nearest meetings to `vector` for this user (excluding `selfTaskId`),
 * via an indexed ANN query over the whole corpus. Returns null on failure so the
 * caller can fall back to the Postgres brute-force path.
 */
export async function queryNearestMeetings(userId: string, selfTaskId: string, vector: number[], k: number): Promise<Neighbour[] | null> {
  const res = await tpFetch('/query', {
    rank_by: ['vector', 'ANN', vector],
    top_k: k + 1, // +1 because the meeting itself may be in the index
    filters: ['user_id', 'Eq', userId],
  });
  if (res == null) return null;
  const rows: any[] = Array.isArray(res.rows) ? res.rows : Array.isArray(res) ? res : [];
  const out: Neighbour[] = [];
  for (const r of rows) {
    const id = r.id ?? r.ID;
    if (!id || id === selfTaskId) continue;
    // Turbopuffer returns cosine distance (0 = identical). similarity = 1 − dist.
    const dist = typeof r.$dist === 'number' ? r.$dist : typeof r.dist === 'number' ? r.dist : undefined;
    out.push({ taskId: String(id), similarity: dist == null ? 0 : Math.max(0, 1 - dist) });
    if (out.length >= k) break;
  }
  return out;
}
