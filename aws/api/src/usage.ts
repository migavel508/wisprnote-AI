import { query, queryCount } from './db';
import { planLimits } from './plans';

/**
 * Usage metering — the billing source of truth in OUR database.
 *
 * 1. Every AI provider call's token usage is persisted here (per user, provider,
 *    model) so spend is queryable for billing/analytics independent of Braintrust.
 * 2. Meeting + batch-hour usage is derived from `task_history`.
 *
 * All limits come from plans.ts, which mirrors the public pricing.
 */

let schemaReady: Promise<void> | null = null;

export function ensureUsageSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS usage_events (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          provider TEXT,
          model TEXT,
          input_tokens INTEGER NOT NULL DEFAULT 0,
          output_tokens INTEGER NOT NULL DEFAULT 0,
          total_tokens INTEGER NOT NULL DEFAULT 0
        )
      `);
      await query('CREATE INDEX IF NOT EXISTS idx_usage_user_created ON usage_events(user_id, created_at)');
      // Distinguish uploaded ("batch") meetings from realtime recordings so the
      // batch-hour caps can be enforced without counting live transcription.
      await query("ALTER TABLE task_history ADD COLUMN IF NOT EXISTS source TEXT NOT NULL DEFAULT 'realtime'");
    })();
  }
  return schemaReady;
}

export interface TokenMetrics {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** Persist one AI call's token usage. Never throws (billing must not break calls). */
export async function recordTokenUsage(
  userId: string,
  provider: string,
  model: string | undefined,
  m: TokenMetrics,
): Promise<void> {
  const total = m.total_tokens || ((m.input_tokens || 0) + (m.output_tokens || 0));
  if (!userId || total <= 0) return;
  try {
    await ensureUsageSchema();
    await query(
      `INSERT INTO usage_events (user_id, provider, model, input_tokens, output_tokens, total_tokens)
       VALUES ($1,$2,$3,$4,$5,$6)`,
      [userId, provider, model || null, m.input_tokens || 0, m.output_tokens || 0, total],
    );
  } catch (e) {
    console.error('recordTokenUsage failed:', e);
  }
}

export interface ModelUsageRow {
  provider: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  calls: number;
}

/** Token usage for the current calendar month, grouped by model. */
export async function getMonthlyTokenUsage(userId: string): Promise<{ totalTokens: number; calls: number; byModel: ModelUsageRow[] }> {
  await ensureUsageSchema();
  const byModel = await query<ModelUsageRow>(
    `SELECT provider, model,
            SUM(input_tokens)::int  AS input_tokens,
            SUM(output_tokens)::int AS output_tokens,
            SUM(total_tokens)::int  AS total_tokens,
            COUNT(*)::int           AS calls
     FROM usage_events
     WHERE user_id=$1 AND created_at >= date_trunc('month', now())
     GROUP BY provider, model
     ORDER BY total_tokens DESC`,
    [userId],
  );
  const totalTokens = byModel.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const calls = byModel.reduce((s, r) => s + (r.calls || 0), 0);
  return { totalTokens, calls, byModel };
}

/** Meeting count used vs the plan's cap (lifetime total for free, else this month). */
export async function getMeetingUsage(userId: string, plan: string): Promise<{ used: number; limit: number | null; period: 'total' | 'month' }> {
  const lim = planLimits(plan);
  const used = lim.meetingsPeriod === 'month'
    ? await queryCount("SELECT COUNT(*) FROM task_history WHERE user_id=$1 AND created_at >= date_trunc('month', now())", [userId])
    : await queryCount('SELECT COUNT(*) FROM task_history WHERE user_id=$1', [userId]);
  return { used, limit: lim.meetings, period: lim.meetingsPeriod };
}

/** Batch (uploaded) processing hours used this month vs the plan's cap. */
export async function getBatchHoursUsage(userId: string, plan: string): Promise<{ usedHours: number; limitHours: number | null }> {
  const lim = planLimits(plan);
  await ensureUsageSchema();
  const rows = await query<{ seconds: string | null }>(
    "SELECT COALESCE(SUM(duration),0) AS seconds FROM task_history WHERE user_id=$1 AND source='batch' AND created_at >= date_trunc('month', now())",
    [userId],
  );
  const seconds = Number(rows[0]?.seconds || 0);
  return { usedHours: seconds / 3600, limitHours: lim.batchHours };
}
