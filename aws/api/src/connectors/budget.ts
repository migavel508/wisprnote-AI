import { query, queryOne } from '../db';

/**
 * BUDGET GOVERNANCE + LLM HEALTH (Brain CF-4 / D-5) — the token-cost guardrail.
 *
 * The brain's DETERMINISTIC spine (threads, gaps, topics, brief skeleton, edge tiering, consolidation)
 * is $0 and must NEVER stop. The MEANING layer (LLM verdict, embeddings, brief polish) is where tokens
 * are spent — and it must be BOUNDED and OBSERVABLE, not open-ended:
 *   • a per-user DAILY brain-token budget, read from the existing usage_events ledger (feature='brain');
 *   • a hard stop when the budget is hit → the meaning layer falls back to the deterministic path and
 *     records a VISIBLE "deferred" state (never a silent catch{});
 *   • an llm_health table so a provider outage / credit depletion shows as `meaning: degraded` in the
 *     progress endpoint + UI instead of failing invisibly.
 *
 * This is what lets the meaning layer be turned back on safely once credits are topped up.
 */

// Default daily brain-token budget per user. Generous by default (the deterministic spine is free);
// override with env BRAIN_DAILY_TOKEN_BUDGET. 0 or negative → unlimited (governance off).
const DEFAULT_DAILY_BUDGET = 3_000_000;
function dailyBudget(): number {
  const v = Number(process.env.BRAIN_DAILY_TOKEN_BUDGET);
  return Number.isFinite(v) ? v : DEFAULT_DAILY_BUDGET;
}

let ready: Promise<void> | null = null;
export function ensureBudgetSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS llm_health (
          provider TEXT PRIMARY KEY,       -- 'anthropic' | 'gemini' | 'embeddings'
          status TEXT NOT NULL,            -- 'ok' | 'degraded' | 'down'
          detail TEXT,                     -- last error reason (http status / message)
          checked_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export type LlmStatus = 'ok' | 'degraded' | 'down';

/** Classify a failed provider HTTP call into a health status. Credit/quota depletion = degraded. */
export function classifyLlmFailure(httpStatus: number, body?: string): LlmStatus {
  const b = String(body || '').toLowerCase();
  if (httpStatus === 429 || /credit|quota|insufficient|balance|billing|depleted|exceeded/.test(b)) return 'degraded';
  if (httpStatus >= 500) return 'down';
  return 'degraded';
}

/** Record a provider's latest health (best-effort — must never break a call). */
export async function recordLlmHealth(provider: string, status: LlmStatus, detail?: string | null): Promise<void> {
  try {
    await ensureBudgetSchema();
    await query(
      `INSERT INTO llm_health (provider, status, detail, checked_at) VALUES ($1,$2,$3,NOW())
       ON CONFLICT (provider) DO UPDATE SET status=EXCLUDED.status, detail=EXCLUDED.detail, checked_at=NOW()`,
      [provider, status, (detail || '').slice(0, 300)],
    );
  } catch { /* health recording is best-effort */ }
}

export interface LlmHealthRow { provider: string; status: LlmStatus; detail: string | null; checked_at: string }

/** Read all providers' health + an overall roll-up for `meaning:` in the progress endpoint. */
export async function getLlmHealth(): Promise<{ status: LlmStatus; providers: LlmHealthRow[] }> {
  await ensureBudgetSchema();
  const rows = await query<LlmHealthRow>(`SELECT provider, status, detail, checked_at FROM llm_health ORDER BY provider`).catch(() => []);
  // Overall: down if every known provider is down; degraded if any is not ok; else ok. Empty = ok
  // (never probed) — we don't cry wolf before the first real call.
  let status: LlmStatus = 'ok';
  if (rows.length) {
    if (rows.every((r) => r.status === 'down')) status = 'down';
    else if (rows.some((r) => r.status !== 'ok')) status = 'degraded';
  }
  return { status, providers: rows };
}

export interface BrainBudget { allowed: boolean; spentToday: number; dailyLimit: number; remaining: number; unlimited: boolean }

/**
 * Is this user under their daily brain-token budget? Reads the SAME usage_events ledger that meters
 * every brain LLM call (feature='brain'), so no new bookkeeping. Called before an expensive pass; the
 * caller falls back to the deterministic path when `allowed` is false.
 */
export async function checkBrainBudget(userId: string): Promise<BrainBudget> {
  const dailyLimit = dailyBudget();
  if (!userId || dailyLimit <= 0) return { allowed: true, spentToday: 0, dailyLimit, remaining: Infinity, unlimited: true };
  const r = await queryOne<{ spent: string }>(
    `SELECT COALESCE(SUM(total_tokens),0)::text AS spent FROM usage_events
      WHERE user_id=$1 AND feature='brain' AND created_at >= date_trunc('day', now())`,
    [userId],
  ).catch(() => null);
  const spentToday = r ? parseInt(r.spent, 10) || 0 : 0;
  const remaining = Math.max(0, dailyLimit - spentToday);
  return { allowed: remaining > 0, spentToday, dailyLimit, remaining, unlimited: false };
}
