import { query, queryOne } from './db';
import { getSecrets } from './secrets';
import { recordProviderUsage } from './usage';
import { ensureKgGraphSchema } from './kgEmbed';
import { queryNearestMeetings } from './kgVector';
import { MODELS, chain } from './models/registry';

/**
 * Stage C of the server-side knowledge-graph pipeline: LINK (the "reasoning node").
 *
 * For every meeting that has been embedded (Stage B) but not yet linked, find
 * its relationships to the EXISTING graph — incrementally, one new meeting at a
 * time. This is the fix for the "reasoning node was inaccurate over 10 meetings
 * at once" problem: instead of reasoning over the whole corpus in one giant
 * prompt, we
 *   1. use the cheap embeddings to rank the most-similar existing meetings, then
 *   2. ask the LLM to reason over ONLY that small, focused neighbourhood.
 * So every reasoning call has a small, bounded input and stays accurate no
 * matter how large the corpus grows.
 *
 * Outputs (idempotent — a meeting's outgoing edges are rewritten on each run):
 *   - similarity edges  (new meeting → each top-K neighbour, cosine score)
 *   - relationship edges (continuation|resolution|escalation|recurring|reference)
 * then the meeting is marked linked in kg_link_state so it isn't reprocessed.
 */

const TOP_K = 6;            // how many neighbours the reasoning LLM sees
const CANDIDATE_CAP = 200;  // most-recent meetings considered for similarity
// Model versions come from the registry (aws/api/src/models/registry.ts).
const LINK_MODELS = chain(MODELS.kgLink);
const REL_TYPES = ['continuation', 'resolution', 'escalation', 'recurring', 'reference'];

interface KGFull {
  task_id: string;
  meeting_title: string;
  topics: Array<{ name: string; status?: string; summary?: string }> | null;
  decisions: Array<{ decision: string }> | null;
  action_items: Array<{ task: string; owner?: string }> | null;
  created_at: string;
}

interface Relationship {
  fromMeetingId: string;
  toMeetingId: string;
  relationshipType: string;
  sharedThread: string;
  confidence: string;
}

function cosine(a: number[], b: number[]): number {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i]; }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** Mirror of the client buildMeetingSummary — the per-meeting text fed to the reasoner. */
function summarize(m: KGFull): string {
  const lines = [`ID: ${m.task_id}`, `Title: ${m.meeting_title}`];
  if (m.created_at) lines.push(`Date: ${m.created_at}`);
  const topics = (m.topics || []).filter((t) => t?.name);
  if (topics.length) lines.push(`Topics: ${topics.map((t) => `${t.name} [${t.status || 'new'}]: ${t.summary || ''}`).join(' | ')}`);
  if (m.decisions?.length) lines.push(`Decisions: ${m.decisions.map((d) => d.decision).join(' | ')}`);
  if (m.action_items?.length) lines.push(`Open actions: ${m.action_items.map((a) => `${a.owner || 'Unassigned'}: ${a.task}`).join(' | ')}`);
  return lines.join('\n');
}

function buildPrompt(newMeeting: KGFull, neighbours: KGFull[]): string {
  return `You are analyzing meeting records to find contextual relationships that would NOT be obvious from simple topic-name matching.

NEW MEETING:
${summarize(newMeeting)}

CANDIDATE RELATED MEETINGS:
${neighbours.map(summarize).join('\n---\n')}

Find relationships connecting the NEW meeting to any candidate meeting (in either direction). Look for:
- a decision in one meeting revisited, overturned, or confirmed in another
- an issue raised in one meeting escalated or resolved in another
- a recurring theme appearing across genuinely separate contexts
- one meeting explicitly referencing outcomes/discussions of another
- shared participants discussing related work
- action items from one meeting addressed in another

CRITICAL: use the EXACT ID values shown above. Do NOT modify or shorten them. Only use IDs that appear above.

Return ONLY a JSON array. Each object must have exactly:
- "fromMeetingId": string (exact ID — the earlier/source meeting)
- "toMeetingId": string (exact ID — the later/target meeting)
- "relationshipType": one of "continuation", "resolution", "escalation", "recurring", "reference"
- "sharedThread": one clear sentence explaining why they're connected
- "confidence": one of "high", "medium", "low"

No markdown, no prose. If no relationships are found, return [].`;
}

// One shot per model with a hard timeout — no internal backoff. If every model
// fails or times out, the meeting stays unlinked and the NEXT sweep tick retries
// it. This keeps a single tick safely bounded under the Lambda timeout.
const REASONER_TIMEOUT_MS = 24_000;

/** POST one generateContent call to `model`, hard-bounded. Returns raw text, or null to try the next model / retry. */
async function reasonerCall(model: string, prompt: string, apiKey: string, userId?: string): Promise<{ text: string } | { fail: 'next' | 'stop' }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REASONER_TIMEOUT_MS);
  let resp: Response;
  try {
    resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Same gemini-3 model as the client; thinkingLevel 'low' keeps the
        // structured relationship-extraction call fast enough for a background
        // tick (the client tolerates default thinking behind a 90s timeout).
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: {
            temperature: 0.1,
            maxOutputTokens: 4096,
            responseMimeType: 'application/json',
            thinkingConfig: { thinkingLevel: 'low' },
          },
        }),
        signal: ctrl.signal,
      },
    );
  } catch (e: any) {
    console.error('kg_reasoner_fetch_err', JSON.stringify({ model, name: e?.name, message: e?.message }));
    return { fail: 'stop' }; // aborted/timed out/network — retry whole meeting next tick
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    const body = await resp.text().catch(() => '');
    console.error('kg_reasoner_not_ok', JSON.stringify({ model, status: resp.status, body: body.slice(0, 200) }));
    return { fail: resp.status === 404 ? 'next' : 'stop' }; // 404 → try fallback model
  }
  const data: any = await resp.json();
  if (userId) void recordProviderUsage(userId, 'knowledge-graph', 'gemini', model, data).catch(() => {});
  return { text: String(data.candidates?.[0]?.content?.parts?.[0]?.text || '[]') };
}

async function callReasoner(prompt: string, userId?: string): Promise<Relationship[] | null> {
  const { GEMINI_API_KEY } = await getSecrets();
  if (!GEMINI_API_KEY) return null;

  let rawText: string | null = null;
  for (const model of LINK_MODELS) {
    const r = await reasonerCall(model, prompt, GEMINI_API_KEY, userId);
    if ('text' in r) { rawText = r.text; break; }
    if (r.fail === 'next') continue;  // model unavailable — try fallback
    return null;                       // transient — retry whole meeting next tick
  }
  if (rawText == null) return null;

  let raw = rawText.trim();
  raw = raw.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
  let parsed: any;
  try { parsed = JSON.parse(raw); } catch {
    const m = raw.match(/\[[\s\S]*\]/);
    if (!m) return [];
    try { parsed = JSON.parse(m[0]); } catch { return []; }
  }
  const arr = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.relationships) ? parsed.relationships : [];
  return arr;
}

// ─── Stage C driver ───────────────────────────────────────────────────────────

async function findPendingLink(limit: number): Promise<Array<{ user_id: string; task_id: string }>> {
  return query(
    `SELECT e.user_id, e.task_id
       FROM kg_embeddings e
       LEFT JOIN kg_link_state s ON s.user_id = e.user_id AND s.task_id = e.task_id
      WHERE e.kind = 'meeting' AND s.task_id IS NULL
      ORDER BY e.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

/** Link a single meeting by id (fast-path). No-op if already linked. */
export async function linkMeeting(userId: string, taskId: string): Promise<'done' | 'retry'> {
  await ensureKgGraphSchema();
  const linked = await queryOne(`SELECT 1 FROM kg_link_state WHERE user_id=$1 AND task_id=$2`, [userId, taskId]);
  if (linked) return 'done';
  return linkOne(userId, taskId);
}

async function linkOne(userId: string, taskId: string): Promise<'done' | 'retry'> {
  try {
    // This meeting's vector.
    const self = await queryOne<{ vector: number[] }>(
      `SELECT vector FROM kg_embeddings WHERE user_id=$1 AND task_id=$2 AND kind='meeting'`,
      [userId, taskId],
    );
    if (!self) return 'retry';
    const selfVec = self.vector as unknown as number[];

    // Find the top-K nearest meetings. Primary: Turbopuffer ANN over the WHOLE
    // corpus (any age), sub-linear — scales to 1k–1M meetings. Fallback: the
    // Postgres brute-force over the most-recent CANDIDATE_CAP, so a transient
    // Turbopuffer outage degrades gracefully instead of breaking.
    let ranked: Array<{ task_id: string; sim: number }>;
    // ONE-INDEX (2026-07-04): the `lumina-kg-meetings` turbopuffer namespace is RETIRED — the brain's
    // single index is `lumina-knowledge-items`. kgLink now uses the Postgres brute-force over
    // kg_embeddings directly (meeting counts are small → fine). Set KG_USE_TURBOPUFFER=1 to restore ANN.
    const ann = process.env.KG_USE_TURBOPUFFER === '1' ? await queryNearestMeetings(userId, taskId, selfVec, TOP_K) : null;
    if (ann != null) {
      ranked = ann.map((n) => ({ task_id: n.taskId, sim: n.similarity }));
    } else {
      const cands = await query<{ task_id: string; vector: number[] }>(
        `SELECT task_id, vector FROM kg_embeddings
          WHERE user_id=$1 AND kind='meeting' AND task_id <> $2
          ORDER BY created_at DESC LIMIT $3`,
        [userId, taskId, CANDIDATE_CAP],
      );
      ranked = cands
        .map((c) => ({ task_id: c.task_id, sim: cosine(selfVec, c.vector as unknown as number[]) }))
        .sort((a, b) => b.sim - a.sim)
        .slice(0, TOP_K);
    }

    // Rewrite this meeting's outgoing edges idempotently.
    await query(`DELETE FROM kg_edges WHERE user_id=$1 AND from_task=$2`, [userId, taskId]);

    if (ranked.length === 0) {
      await markLinked(userId, taskId);
      return 'done';
    }

    // Pull KG detail for the reasoner (this meeting + neighbours).
    const ids = [taskId, ...ranked.map((r) => r.task_id)];
    const kgRows = await query<KGFull>(
      `SELECT task_id, meeting_title, topics, decisions, action_items, created_at
         FROM knowledge_graph WHERE user_id=$1 AND task_id = ANY($2::uuid[])`,
      [userId, ids],
    );
    const byId = new Map(kgRows.map((r) => [r.task_id, r]));
    const selfKg = byId.get(taskId);
    const neighbourKg = ranked.map((r) => byId.get(r.task_id)).filter((x): x is KGFull => !!x);

    // Similarity edges (always recorded for the neighbourhood).
    for (const r of ranked) {
      await query(
        `INSERT INTO kg_edges (user_id, from_task, to_task, similarity) VALUES ($1,$2,$3,$4)`,
        [userId, taskId, r.task_id, r.sim],
      );
    }

    // Relationship edges (the reasoning node) — only if we have KG context.
    if (selfKg && neighbourKg.length > 0) {
      const rels = await callReasoner(buildPrompt(selfKg, neighbourKg), userId);
      if (rels == null) return 'retry'; // transient model failure — retry next sweep (edges already partial; DELETE on retry fixes it)
      const validIds = new Set(ids);
      for (const rel of rels) {
        if (!rel || !validIds.has(rel.fromMeetingId) || !validIds.has(rel.toMeetingId)) continue;
        if (rel.fromMeetingId === rel.toMeetingId) continue;
        if (!REL_TYPES.includes(rel.relationshipType)) continue;
        await query(
          `INSERT INTO kg_edges (user_id, from_task, to_task, relationship_type, shared_thread, confidence)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [userId, rel.fromMeetingId, rel.toMeetingId, rel.relationshipType,
           String(rel.sharedThread || '').slice(0, 500), ['high', 'medium', 'low'].includes(rel.confidence) ? rel.confidence : 'medium'],
        );
      }
    }

    await markLinked(userId, taskId);
    return 'done';
  } catch (err: any) {
    console.error('kg_link_failed', JSON.stringify({ taskId, message: err?.message, code: err?.code }));
    return 'retry';
  }
}

async function markLinked(userId: string, taskId: string): Promise<void> {
  await query(
    `INSERT INTO kg_link_state (user_id, task_id) VALUES ($1,$2)
     ON CONFLICT (user_id, task_id) DO UPDATE SET linked_at=NOW()`,
    [userId, taskId],
  );
}

/**
 * Maintenance: forget all link state so every meeting is re-linked from scratch
 * on subsequent sweeps (e.g. after a model or prompt change). Edges are rewritten
 * per-meeting by linkOne, so clearing the marker table is sufficient. Reachable
 * only via direct Lambda invoke / EventBridge (`__job`), never the public API.
 */
export async function resetLinkState(): Promise<{ cleared: number }> {
  await ensureKgGraphSchema();
  const rows = await query<{ count: string }>(`SELECT COUNT(*)::text AS count FROM kg_link_state`);
  await query(`DELETE FROM kg_link_state`);
  return { cleared: Number(rows[0]?.count || 0) };
}

export interface LinkStageResult { linked: number; retry: number; pending: number }

/**
 * Run Stage C for one tick: link up to `limit` embedded-but-unlinked meetings,
 * with bounded concurrency and a wall-clock budget. Each meeting reasons only
 * over its top-K most-similar neighbours, so calls stay small and accurate.
 */
export async function runLinkStage(limit: number, timeBudgetMs: number, concurrency: number): Promise<LinkStageResult> {
  await ensureKgGraphSchema();
  const started = Date.now();
  const pending = await findPendingLink(limit);
  const result: LinkStageResult = { linked: 0, retry: 0, pending: pending.length };
  if (pending.length === 0) return result;

  let cursor = 0;
  async function worker() {
    while (cursor < pending.length && Date.now() - started < timeBudgetMs) {
      const m = pending[cursor++];
      const outcome = await linkOne(m.user_id, m.task_id);
      if (outcome === 'done') result.linked++;
      else result.retry++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return result;
}
