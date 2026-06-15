import { query, queryOne } from './db';
import { getSecrets } from './secrets';
import { upsertMeetingVector, upsertMeetingVectors, MeetingVectorRow } from './kgVector';
import { MODELS, chain } from './models/registry';

/**
 * Stage B of the server-side knowledge-graph pipeline: EMBED.
 *
 * For every meeting that already has a knowledge_graph row (Stage A) but no
 * stored vectors yet, embed the meeting and each of its topics and persist the
 * vectors. These vectors are what later lets Stage C (LINK) find the most
 * relevant existing meetings for a NEW meeting cheaply — so the reasoning LLM
 * only ever reasons over a small, focused neighbourhood.
 *
 * Faithful port of the client embedding path (knowledgeGraph.utils.ts):
 * model `gemini-embedding-001` → `text-embedding-004`, taskType
 * SEMANTIC_SIMILARITY, 3072-dim (must match the `lumina-meetings` index).
 */

const EMBED_MODELS = chain(MODELS.embeddings);
const EMBED_BATCH = 16;

let schemaReady: Promise<void> | null = null;

/** Create the kg_embeddings table once per warm container. Additive — touches nothing existing. */
export function ensureKgGraphSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      // user_id/task_id are UUID to match knowledge_graph (so the LEFT JOIN works).
      await query(`
        CREATE TABLE IF NOT EXISTS kg_embeddings (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          task_id UUID NOT NULL,
          kind TEXT NOT NULL,            -- 'meeting' | 'topic'
          item_key TEXT NOT NULL,        -- '__meeting__' or normalized topic name
          vector JSONB NOT NULL,         -- float[] (3072)
          model TEXT,
          dim INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, task_id, kind, item_key)
        )
      `);
      // Idempotent repair: an earlier build created user_id as TEXT. The table is
      // dark (no data), so coerce it to UUID only if it's currently the wrong type.
      await query(`
        DO $$ BEGIN
          IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_name='kg_embeddings' AND column_name='user_id' AND data_type='text'
          ) THEN
            ALTER TABLE kg_embeddings ALTER COLUMN user_id TYPE UUID USING user_id::uuid;
          END IF;
        END $$;
      `);
      await query(`CREATE INDEX IF NOT EXISTS kg_embeddings_task_idx ON kg_embeddings (user_id, task_id)`);

      // Stage C outputs: cross-meeting edges (similarity + LLM relationships) and
      // a marker table recording which meetings have been linked.
      await query(`
        CREATE TABLE IF NOT EXISTS kg_edges (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          from_task UUID NOT NULL,
          to_task UUID NOT NULL,
          similarity REAL,                -- cosine (similarity edges)
          relationship_type TEXT,         -- continuation|resolution|escalation|recurring|reference
          shared_thread TEXT,
          confidence TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS kg_edges_user_idx ON kg_edges (user_id)`);
      await query(`CREATE INDEX IF NOT EXISTS kg_edges_from_idx ON kg_edges (user_id, from_task)`);
      await query(`
        CREATE TABLE IF NOT EXISTS kg_link_state (
          user_id UUID NOT NULL,
          task_id UUID NOT NULL,
          linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, task_id)
        )
      `);
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

/** Normalize a topic name into a stable key (matches the client's topic id convention). */
export function topicKey(name: string): string {
  return name.toLowerCase().trim().replace(/\s+/g, '_');
}

interface KGRowLite {
  meeting_title: string;
  topics: Array<{ name: string; status?: string; summary?: string }> | null;
  decisions: Array<{ decision: string }> | null;
  people: string[] | null;
}

/** Text embedded for the whole meeting — mirrors buildMeetingEmbedText. */
export function buildMeetingEmbedText(r: KGRowLite): string {
  const parts: string[] = [`Meeting: ${r.meeting_title}.`];
  if (r.topics?.length) {
    parts.push(`Topics discussed: ${r.topics.map(t => `${t.name} (${t.status || 'new'}): ${t.summary || ''}`).join('; ')}.`);
  }
  if (r.decisions?.length) {
    parts.push(`Decisions: ${r.decisions.map(d => d.decision).join('; ')}.`);
  }
  if (r.people?.length) {
    parts.push(`Participants: ${r.people.join(', ')}.`);
  }
  return parts.join(' ');
}

/** Text embedded per topic — mirrors buildTopicEmbedText. */
export function buildTopicEmbedText(t: { name: string; status?: string; summary?: string }): string {
  const parts: string[] = [`Topic: ${t.name}.`];
  if (t.status) parts.push(`Status: ${t.status}.`);
  if (t.summary) parts.push(t.summary);
  return parts.join(' ');
}

/**
 * Embed a list of texts via Gemini batchEmbedContents (taskType
 * SEMANTIC_SIMILARITY), with model fallback. Returns one vector per input in
 * order, or `null` on a hard failure (so the caller retries on the next sweep).
 */
export async function embedTexts(texts: string[]): Promise<number[][] | null> {
  if (texts.length === 0) return [];
  const { GEMINI_API_KEY } = await getSecrets();
  if (!GEMINI_API_KEY) return null;

  const out: number[][] = [];
  for (let start = 0; start < texts.length; start += EMBED_BATCH) {
    const batch = texts.slice(start, start + EMBED_BATCH);
    let vectors: number[][] | null = null;

    for (const model of EMBED_MODELS) {
      const modelPath = `models/${model}`;
      const resp = await fetchEmbed(GEMINI_API_KEY, modelPath, batch);
      if (resp == null) continue; // transient — try next model
      vectors = resp;
      break;
    }
    if (vectors == null) return null; // whole batch failed → retry later
    out.push(...vectors);
  }
  return out;
}

async function fetchEmbed(apiKey: string, modelPath: string, batch: string[]): Promise<number[][] | null> {
  const body = {
    requests: batch.map((text) => ({
      model: modelPath,
      content: { parts: [{ text }] },
      taskType: 'SEMANTIC_SIMILARITY',
    })),
  };
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${modelPath}:batchEmbedContents?key=${apiKey}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
    );
    if (resp.ok) {
      const data: any = await resp.json();
      const embeddings: Array<{ values: number[] }> = Array.isArray(data.embeddings) ? data.embeddings : [];
      if (embeddings.length !== batch.length) return null;
      return embeddings.map((e) => e.values);
    }
    if (resp.status === 404) return null;         // model unavailable — try fallback
    if (resp.status !== 429 && resp.status !== 503) return null;
    if (attempt < MAX_RETRIES) await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
  }
  return null;
}

// ─── Stage B driver: embed meetings that have a KG row but no vectors yet ──────

interface KGRow extends KGRowLite {
  user_id: string;
  task_id: string;
  created_at: string | null;
}

async function findPendingEmbed(limit: number): Promise<KGRow[]> {
  return query<KGRow>(
    `SELECT kg.user_id, kg.task_id, kg.meeting_title, kg.topics, kg.decisions, kg.people, kg.created_at
       FROM knowledge_graph kg
       LEFT JOIN kg_embeddings e
         ON e.user_id = kg.user_id AND e.task_id = kg.task_id AND e.kind = 'meeting'
      WHERE e.id IS NULL
      ORDER BY kg.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

function toMs(iso: string | null): number {
  if (!iso) return 0;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

async function embedOne(r: KGRow): Promise<'done' | 'retry'> {
  try {
    const topics = (r.topics || []).filter((t) => t && typeof t.name === 'string' && t.name.trim().length > 0);
    // Index 0 = the whole-meeting text; the rest are per-topic, in order.
    const texts = [buildMeetingEmbedText(r), ...topics.map(buildTopicEmbedText)];
    const vectors = await embedTexts(texts);
    if (vectors == null) return 'retry'; // transient — next sweep

    const rows: Array<{ kind: string; key: string; vec: number[] }> = [
      { kind: 'meeting', key: '__meeting__', vec: vectors[0] },
      ...topics.map((t, i) => ({ kind: 'topic', key: topicKey(t.name), vec: vectors[i + 1] })),
    ];
    for (const row of rows) {
      if (!Array.isArray(row.vec) || row.vec.length === 0) continue;
      await queryOne(
        `INSERT INTO kg_embeddings (user_id, task_id, kind, item_key, vector, model, dim)
         VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (user_id, task_id, kind, item_key)
         DO UPDATE SET vector=EXCLUDED.vector, model=EXCLUDED.model, dim=EXCLUDED.dim, created_at=NOW()`,
        [r.user_id, r.task_id, row.kind, row.key, JSON.stringify(row.vec), EMBED_MODELS[0], row.vec.length],
      );
    }

    // Mirror the meeting-level vector into Turbopuffer for indexed ANN neighbour
    // search (Stage C). Best-effort — Postgres is the source of truth, and the
    // reindex job repairs any gaps; a mirror failure must not re-trigger embedding.
    if (Array.isArray(vectors[0]) && vectors[0].length > 0) {
      await upsertMeetingVector(r.user_id, r.task_id, vectors[0], toMs(r.created_at)).catch(() => false);
    }
    return 'done';
  } catch (err: any) {
    console.error('kg_embed_failed', JSON.stringify({ taskId: r.task_id, message: err?.message }));
    return 'retry';
  }
}

/**
 * Maintenance/backfill: push every meeting-level vector already in Postgres into
 * the Turbopuffer ANN index, in batches. Idempotent (upsert by task_id). Used to
 * backfill the existing corpus and to repair any mirror gaps. Returns how many
 * were pushed.
 */
export async function reindexMeetingVectors(): Promise<{ indexed: number }> {
  await ensureKgGraphSchema();
  const rows = await query<{ user_id: string; task_id: string; vector: number[]; created_at: string | null }>(
    `SELECT e.user_id, e.task_id, e.vector, kg.created_at
       FROM kg_embeddings e
       JOIN knowledge_graph kg ON kg.user_id = e.user_id AND kg.task_id = e.task_id
      WHERE e.kind = 'meeting'`,
  );
  let indexed = 0;
  const BATCH = 100;
  for (let i = 0; i < rows.length; i += BATCH) {
    const batch: MeetingVectorRow[] = rows.slice(i, i + BATCH).map((r) => ({
      user_id: r.user_id,
      task_id: r.task_id,
      vector: r.vector as unknown as number[],
      created_ms: toMs(r.created_at),
    }));
    if (await upsertMeetingVectors(batch)) indexed += batch.length;
  }
  return { indexed };
}

/** Embed a single meeting by id (fast-path). No-op if already embedded. */
export async function embedMeetingById(userId: string, taskId: string): Promise<'done' | 'retry'> {
  await ensureKgGraphSchema();
  const has = await queryOne(`SELECT 1 FROM kg_embeddings WHERE user_id=$1 AND task_id=$2 AND kind='meeting'`, [userId, taskId]);
  if (has) return 'done';
  const r = await queryOne<KGRow>(
    `SELECT user_id, task_id, meeting_title, topics, decisions, people, created_at
       FROM knowledge_graph WHERE user_id=$1 AND task_id=$2`,
    [userId, taskId],
  );
  if (!r) return 'retry';
  return embedOne(r);
}

export interface EmbedStageResult { embedded: number; retry: number; pending: number }

/**
 * Run Stage B for one tick: embed up to `limit` meetings that have a KG row but
 * no stored vectors, with bounded concurrency and a wall-clock budget. Remaining
 * work is picked up on the next sweep. Self-healing: a transient failure simply
 * leaves the meeting un-embedded for a later retry.
 */
export async function runEmbedStage(limit: number, timeBudgetMs: number, concurrency: number): Promise<EmbedStageResult> {
  await ensureKgGraphSchema();
  const started = Date.now();
  const pending = await findPendingEmbed(limit);
  const result: EmbedStageResult = { embedded: 0, retry: 0, pending: pending.length };
  if (pending.length === 0) return result;

  let cursor = 0;
  async function worker() {
    while (cursor < pending.length && Date.now() - started < timeBudgetMs) {
      const outcome = await embedOne(pending[cursor++]);
      if (outcome === 'done') result.embedded++;
      else result.retry++;
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, pending.length) }, worker));
  return result;
}
