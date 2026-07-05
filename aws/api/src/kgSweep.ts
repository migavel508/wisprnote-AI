import { query, queryOne } from './db';
import { extractKnowledgeGraph } from './kgExtract';
import { runEmbedStage, embedMeetingById } from './kgEmbed';
import { runLinkStage, linkMeeting } from './kgLink';

/**
 * Background knowledge-graph sweep.
 *
 * Finds meetings that have a transcription but no knowledge_graph row yet
 * (across ALL users), extracts each one's KG server-side, and upserts it. Driven
 * by an EventBridge schedule (see deploy notes) so it runs continuously,
 * regardless of whether any desktop app is open. Because a transcript is
 * immutable, each meeting is processed exactly once; new meetings are picked up
 * automatically on the next tick, and the existing backlog is drained over the
 * first few ticks.
 *
 * Idempotent + self-healing: a transient extraction failure leaves the row
 * un-written, so the next sweep retries it; a successful-but-empty extraction
 * writes an (empty) row so it isn't reprocessed forever.
 */

interface PendingMeeting {
  id: string;
  user_id: string;
  filename: string | null;
  transcription: string | null;
}

// Bounded so one tick stays well under the 30s Lambda timeout. Newest meetings
// first — that's what a user is most likely to open right after recording.
const BATCH_LIMIT = 40;
const CONCURRENCY = 4;
const TIME_BUDGET_MS = 24_000;

async function findPending(limit: number): Promise<PendingMeeting[]> {
  return query<PendingMeeting>(
    `SELECT th.id, th.user_id, th.filename, th.transcription
       FROM task_history th
       LEFT JOIN knowledge_graph kg
         ON kg.task_id = th.id AND kg.user_id = th.user_id
      WHERE kg.id IS NULL
        AND th.transcription IS NOT NULL
        AND length(btrim(th.transcription)) >= 50
      ORDER BY th.created_at DESC
      LIMIT $1`,
    [limit],
  );
}

async function processOne(m: PendingMeeting): Promise<'done' | 'empty' | 'retry'> {
  try {
    const title = m.filename || 'Untitled meeting';
    const kg = await extractKnowledgeGraph(title, m.transcription || '', m.user_id);
    if (kg == null) return 'retry'; // transient — leave for the next sweep

    await queryOne(
      `INSERT INTO knowledge_graph (user_id, task_id, meeting_title, topics, decisions, people, action_items, refs)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
       ON CONFLICT (user_id, task_id) DO UPDATE SET
         meeting_title=EXCLUDED.meeting_title, topics=EXCLUDED.topics, decisions=EXCLUDED.decisions,
         people=EXCLUDED.people, action_items=EXCLUDED.action_items, refs=EXCLUDED.refs, updated_at=NOW()`,
      [
        m.user_id, m.id, title,
        JSON.stringify(kg.topics), JSON.stringify(kg.decisions),
        JSON.stringify(kg.people), JSON.stringify(kg.action_items), JSON.stringify(kg.refs),
      ],
    );
    return kg.topics.length > 0 ? 'done' : 'empty';
  } catch (err: any) {
    console.error('kg_sweep_meeting_failed', JSON.stringify({ taskId: m.id, message: err?.message }));
    return 'retry';
  }
}

/**
 * Fast-path: run the full pipeline (extract → embed → link) for ONE meeting,
 * the instant it's saved. Each stage is a no-op if already done, so this is safe
 * to call alongside the cron and safe to retry. Bounded to a single meeting, so
 * no full-sweep overlap / wasted cost.
 */
export async function runPipelineForMeeting(userId: string, taskId: string): Promise<{ ok: boolean }> {
  // Stage A — extract (only if not already extracted and there's a transcription).
  const hasKg = await queryOne(`SELECT 1 FROM knowledge_graph WHERE user_id=$1 AND task_id=$2`, [userId, taskId]);
  if (!hasKg) {
    const m = await queryOne<PendingMeeting>(
      `SELECT id, user_id, filename, transcription FROM task_history WHERE id=$1 AND user_id=$2`,
      [taskId, userId],
    );
    if (m && m.transcription && m.transcription.trim().length >= 50) {
      await processOne(m);
    } else {
      return { ok: false }; // nothing to process yet (no/short transcription)
    }
  }
  // Stage B — embed, Stage C — link.
  await embedMeetingById(userId, taskId);
  await linkMeeting(userId, taskId);
  return { ok: true };
}

export interface SweepResult {
  processed: number; empty: number; retry: number; pending: number;
  embed?: { embedded: number; retry: number; pending: number };
  link?: { linked: number; retry: number; pending: number };
}

/**
 * Run one sweep tick. Three stages share the tick's time budget:
 *   Stage A (EXTRACT) — meetings with a transcription but no knowledge_graph row.
 *   Stage B (EMBED)   — meetings with a KG row but no stored vectors yet.
 *   Stage C (LINK)    — embedded meetings not yet linked to the existing graph.
 * All are bounded + idempotent; whatever doesn't fit is picked up next tick.
 */
export async function runKgSweep(): Promise<SweepResult> {
  const started = Date.now();

  // ── Stage A: extract ──────────────────────────────────────────────────────
  const pending = await findPending(BATCH_LIMIT);
  const result: SweepResult = { processed: 0, empty: 0, retry: 0, pending: pending.length };
  if (pending.length > 0) {
    let cursor = 0;
    async function worker() {
      while (cursor < pending.length && Date.now() - started < TIME_BUDGET_MS) {
        const m = pending[cursor++];
        const outcome = await processOne(m);
        if (outcome === 'done') result.processed++;
        else if (outcome === 'empty') result.empty++;
        else result.retry++;
      }
    }
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, pending.length) }, worker));
  }

  // ── Stage B: embed (uses whatever time is left in the tick) ────────────────
  try {
    const remaining = TIME_BUDGET_MS - (Date.now() - started);
    if (remaining > 3_000) {
      result.embed = await runEmbedStage(BATCH_LIMIT, remaining, CONCURRENCY);
    }
  } catch (err: any) {
    console.error('kg_embed_stage_failed', JSON.stringify({ message: err?.message, code: err?.code, detail: err?.detail }));
  }

  // ── Stage C: link / reason (uses whatever time is left after A + B) ─────────
  // Conservatively bounded: each link makes a reasoning LLM call (≤9s, hard
  // timeout). Cap the budget so 2 in-flight calls finishing after the cutoff
  // still land well under the 30s Lambda limit. Backlog drains over ticks.
  try {
    const remaining = TIME_BUDGET_MS - (Date.now() - started);
    if (remaining > 4_000) {
      // 60s Lambda ceiling: cutoff 18s + 24s in-flight worst case = ~42s, safe.
      result.link = await runLinkStage(BATCH_LIMIT, Math.min(remaining, 18_000), 2);
    }
  } catch (err: any) {
    console.error('kg_link_stage_failed', JSON.stringify({ message: err?.message, code: err?.code, detail: err?.detail }));
  }

  console.log('kg_sweep_tick', JSON.stringify(result));
  return result;
}
