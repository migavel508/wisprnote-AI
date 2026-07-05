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
      // Transcription (Deepgram) is billed by AUDIO time, not tokens — track the
      // seconds of audio processed alongside token columns so one usage_events
      // table covers every model (Deepgram, Gemini, Claude) uniformly.
      await query('ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS audio_seconds NUMERIC NOT NULL DEFAULT 0');
      // FEATURE dimension — which product function spent the tokens (transcription, meeting,
      // chat, brain, knowledge-graph, assets, dictionary, …). Lets the Analytics panel break
      // usage down by function, not just by model. Rows written before this default to 'other'.
      await query("ALTER TABLE usage_events ADD COLUMN IF NOT EXISTS feature TEXT NOT NULL DEFAULT 'other'");
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

/** Product function that spent the tokens (drives the Analytics breakdown). */
export type UsageFeature =
  | 'transcription' | 'meeting' | 'chat' | 'brain' | 'knowledge-graph' | 'assets' | 'dictionary' | 'other';

/** Normalize an arbitrary feature string (e.g. from a client header) to a known bucket. */
export function normalizeFeature(f?: string | null): UsageFeature {
  const v = String(f || '').toLowerCase().trim();
  const known: UsageFeature[] = ['transcription', 'meeting', 'chat', 'brain', 'knowledge-graph', 'assets', 'dictionary', 'other'];
  return (known as string[]).includes(v) ? (v as UsageFeature) : 'other';
}

/** Persist one AI call's token usage, tagged by FEATURE. Never throws (billing must not break calls). */
export async function recordTokenUsage(
  userId: string,
  provider: string,
  model: string | undefined,
  m: TokenMetrics,
  feature: UsageFeature | string = 'other',
): Promise<void> {
  const total = m.total_tokens || ((m.input_tokens || 0) + (m.output_tokens || 0));
  if (!userId || total <= 0) return;
  try {
    await ensureUsageSchema();
    await query(
      `INSERT INTO usage_events (user_id, provider, model, input_tokens, output_tokens, total_tokens, feature)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [userId, provider, model || null, m.input_tokens || 0, m.output_tokens || 0, total, normalizeFeature(feature)],
    );
  } catch (e) {
    console.error('recordTokenUsage failed:', e);
  }
}

/**
 * Parse a raw provider response's usage block and record it, tagged by feature. Handles the
 * three response shapes (Anthropic `usage`, Gemini `usageMetadata`, OpenAI/OpenRouter `usage`).
 * Best-effort — used to meter the server-side direct calls (brain verdict, KG extract/link)
 * that don't go through the proxy. Never throws.
 */
export async function recordProviderUsage(
  userId: string,
  feature: UsageFeature | string,
  provider: string,
  model: string | undefined,
  apiJson: any,
): Promise<void> {
  try {
    let input = 0, output = 0;
    if (provider === 'anthropic') {
      input = Number(apiJson?.usage?.input_tokens) || 0;
      output = Number(apiJson?.usage?.output_tokens) || 0;
    } else if (provider === 'gemini' || provider === 'google') {
      const u = apiJson?.usageMetadata || {};
      input = Number(u.promptTokenCount) || 0;
      output = (Number(u.candidatesTokenCount) || 0) + (Number(u.thoughtsTokenCount) || 0);
      if (!input && !output) output = Number(u.totalTokenCount) || 0;
    } else {
      const u = apiJson?.usage || {};
      input = Number(u.prompt_tokens) || 0;
      output = Number(u.completion_tokens) || 0;
    }
    if (input || output) await recordTokenUsage(userId, provider, model, { input_tokens: input, output_tokens: output }, feature);
  } catch { /* best-effort — metering must never break a call */ }
}

/**
 * Persist one transcription call's AUDIO usage (Deepgram, billed by seconds).
 * The token columns stay 0; `audio_seconds` carries the cost signal. Used for
 * both prerecorded `/ai/transcribe` and realtime-streaming usage reports.
 * Never throws (billing must not break the call).
 */
export async function recordAudioUsage(
  userId: string,
  provider: string,
  model: string | undefined,
  audioSeconds: number,
  feature: UsageFeature | string = 'transcription',
): Promise<void> {
  if (!userId || !(audioSeconds > 0)) return;
  try {
    await ensureUsageSchema();
    await query(
      `INSERT INTO usage_events (user_id, provider, model, audio_seconds, feature)
       VALUES ($1,$2,$3,$4,$5)`,
      [userId, provider, model || null, audioSeconds, normalizeFeature(feature)],
    );
  } catch (e) {
    console.error('recordAudioUsage failed:', e);
  }
}

export interface ModelUsageRow {
  provider: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  audio_seconds: number;
  calls: number;
}

/** Token usage for the current calendar month, grouped by model. */
export async function getMonthlyTokenUsage(userId: string): Promise<{ totalTokens: number; totalAudioSeconds: number; calls: number; byModel: ModelUsageRow[] }> {
  await ensureUsageSchema();
  const byModel = await query<ModelUsageRow>(
    `SELECT provider, model,
            SUM(input_tokens)::int   AS input_tokens,
            SUM(output_tokens)::int  AS output_tokens,
            SUM(total_tokens)::int   AS total_tokens,
            SUM(audio_seconds)::float AS audio_seconds,
            COUNT(*)::int            AS calls
     FROM usage_events
     WHERE user_id=$1 AND created_at >= date_trunc('month', now())
     GROUP BY provider, model
     ORDER BY total_tokens DESC, audio_seconds DESC`,
    [userId],
  );
  const totalTokens = byModel.reduce((s, r) => s + (r.total_tokens || 0), 0);
  const totalAudioSeconds = byModel.reduce((s, r) => s + (Number(r.audio_seconds) || 0), 0);
  const calls = byModel.reduce((s, r) => s + (r.calls || 0), 0);
  return { totalTokens, totalAudioSeconds, calls, byModel };
}

export interface FeatureUsageRow {
  feature: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  audio_seconds: number;
  calls: number;
}

/** Token + audio usage for the current calendar month, grouped by FEATURE (the Analytics breakdown). */
export async function getMonthlyUsageByFeature(userId: string): Promise<FeatureUsageRow[]> {
  await ensureUsageSchema();
  return query<FeatureUsageRow>(
    `SELECT COALESCE(feature,'other') AS feature,
            SUM(input_tokens)::int    AS input_tokens,
            SUM(output_tokens)::int   AS output_tokens,
            SUM(total_tokens)::int    AS total_tokens,
            SUM(audio_seconds)::float AS audio_seconds,
            COUNT(*)::int             AS calls
     FROM usage_events
     WHERE user_id=$1 AND created_at >= date_trunc('month', now())
     GROUP BY COALESCE(feature,'other')
     ORDER BY total_tokens DESC, audio_seconds DESC`,
    [userId],
  );
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
