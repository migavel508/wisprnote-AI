import crypto from 'crypto';
import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, queryOne } from './db';
import { ok, badRequest } from './response';
import { getSecrets } from './secrets';
import { planLabel } from './plans';
import { getMonthlyTokenUsage, getMonthlyUsageByFeature, getMeetingUsage, getBatchHoursUsage } from './usage';

/**
 * Paddle billing: webhook ingestion + subscription status.
 *
 * Flow:
 *  - Checkout (website/app) passes custom_data.user_id = the Cognito sub.
 *  - Paddle POSTs subscription.* / transaction.* events to /billing/webhook.
 *  - We verify the Paddle-Signature header, map the price → plan, and upsert
 *    the user's row in `subscriptions`.
 *  - The app reads GET /billing/status to gate paid features.
 */

// Live price IDs → plan/cycle (created in the Paddle catalog). Keep in sync with
// paddleService.ts on the client.
const PRICE_TO_PLAN: Record<string, { plan: string; cycle: 'monthly' | 'yearly' }> = {
  // ── Live ──
  pri_01ktk4bhps03ydb5w01mbe66xf: { plan: 'pro', cycle: 'monthly' },
  pri_01ktk4bjc4n1r7j79050b2aeq9: { plan: 'pro', cycle: 'yearly' },
  pri_01ktk4bjryvtypx056f14nb3ew: { plan: 'pro_plus', cycle: 'monthly' },
  pri_01ktk4bk7ffa438r0rcnccx2d5: { plan: 'pro_plus', cycle: 'yearly' },
  // ── Sandbox (dev/test) ──
  pri_01ktkk59hb5fq4h6wxxbxvws58: { plan: 'pro', cycle: 'monthly' },
  pri_01ktkk59y0adykdwrjshx4rb8j: { plan: 'pro', cycle: 'yearly' },
  pri_01ktkk5aqgkh5ya0q6cxws9zee: { plan: 'pro_plus', cycle: 'monthly' },
  pri_01ktkk5b4pqfmfgamnm6xjyevf: { plan: 'pro_plus', cycle: 'yearly' },
};

// Paddle statuses that grant the paid plan. Anything else falls back to free.
const ACTIVE_STATUSES = new Set(['active', 'trialing', 'past_due']);

let schemaReady = false;
async function ensureSchema(): Promise<void> {
  if (schemaReady) return;
  await query(`
    CREATE TABLE IF NOT EXISTS subscriptions (
      user_id TEXT PRIMARY KEY,
      plan TEXT NOT NULL DEFAULT 'free',
      cycle TEXT,
      status TEXT NOT NULL DEFAULT 'inactive',
      price_id TEXT,
      paddle_subscription_id TEXT,
      paddle_customer_id TEXT,
      current_period_end TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`);
  schemaReady = true;
}

/** Constant-time verify of the `Paddle-Signature: ts=..;h1=..` header. */
function verifyPaddleSignature(rawBody: string, signatureHeader: string, secret: string): boolean {
  if (!signatureHeader || !secret) return false;
  const parts = Object.fromEntries(
    signatureHeader.split(';').map((kv) => kv.split('=') as [string, string]),
  );
  const ts = parts.ts;
  const h1 = parts.h1;
  if (!ts || !h1) return false;

  const expected = crypto.createHmac('sha256', secret).update(`${ts}:${rawBody}`).digest('hex');
  try {
    return crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(h1, 'hex'));
  } catch {
    return false;
  }
}

function rawBodyOf(event: APIGatewayProxyEvent): string {
  if (!event.body) return '';
  return event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
}

/** Resolve the effective plan from a stored row (expired/canceled → free). */
function effectivePlan(row: { plan: string; status: string; current_period_end: string | null } | null): string {
  if (!row) return 'free';
  if (!ACTIVE_STATUSES.has(row.status)) return 'free';
  return row.plan || 'free';
}

/** Free plan is capped at this many meetings; paid plans are unlimited. */
export const FREE_MEETING_LIMIT = 5;

/**
 * Pricing-exempt accounts — TEMPORARY, for testing only.
 *
 * Any email listed resolves to the unlimited `enterprise` plan regardless of
 * billing state, so the account is free from every plan limit while we finish
 * the consumption/cost-control work. Matching is case-insensitive. Everyone NOT
 * listed is completely unaffected.
 *
 * Configured via the PRICING_EXEMPT_EMAILS environment variable as a
 * comma-separated list, e.g. `PRICING_EXEMPT_EMAILS=a@example.com,b@example.com`.
 * Deliberately NOT hardcoded: this is an allowlist that bypasses billing, and it
 * has no business sitting in a public repository. Unset means nobody is exempt.
 */
const PRICING_EXEMPT_EMAILS = new Set<string>(
  (process.env.PRICING_EXEMPT_EMAILS || '')
    .split(',')
    .map((email) => email.trim().toLowerCase())
    .filter(Boolean),
);

/** Is this account temporarily exempt from all plan limits? */
export function isPricingExempt(email: string | null | undefined): boolean {
  return !!email && PRICING_EXEMPT_EMAILS.has(email.trim().toLowerCase());
}

/** The caller's effective plan ('free' | 'pro' | 'pro_plus' | 'enterprise').
    Used to gate paid-only capacity (e.g. the free meeting limit) server-side.
    Pass `email` to honour the temporary pricing-exempt allowlist above. */
export async function getUserPlan(userId: string, email?: string | null): Promise<string> {
  // Testing exemption: short-circuit to unlimited before touching billing state.
  if (isPricingExempt(email)) return 'enterprise';
  await ensureSchema();
  const row = await queryOne<{ plan: string; status: string; current_period_end: string | null }>(
    'SELECT plan, status, current_period_end FROM subscriptions WHERE user_id=$1',
    [userId],
  );
  return effectivePlan(row);
}

interface PaddleEvent {
  event_type: string;
  data: any;
}

/** Public webhook endpoint (NOT JWT-authed — verified by signature instead). */
export async function handlePaddleWebhook(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const raw = rawBodyOf(event);
  const sig = event.headers?.['Paddle-Signature'] || event.headers?.['paddle-signature'] || '';
  const { PADDLE_WEBHOOK_SECRET, PADDLE_SANDBOX_WEBHOOK_SECRET } = await getSecrets();

  // Accept either the live OR the sandbox signing secret, so the same endpoint
  // serves production and dev/test webhooks.
  const valid =
    verifyPaddleSignature(raw, sig, PADDLE_WEBHOOK_SECRET) ||
    verifyPaddleSignature(raw, sig, PADDLE_SANDBOX_WEBHOOK_SECRET);
  if (!valid) {
    console.warn('paddle_webhook_bad_signature');
    return { statusCode: 401, body: 'invalid signature' } as APIGatewayProxyResult;
  }

  let body: PaddleEvent;
  try { body = JSON.parse(raw); } catch { return badRequest('invalid json'); }

  const type = body.event_type || '';
  const data = body.data || {};

  try {
    await ensureSchema();

    if (type.startsWith('subscription.')) {
      await upsertFromSubscription(type, data);
    } else if (type === 'transaction.completed') {
      // One-off safety net: a completed transaction that created a subscription.
      if (data.subscription_id && data.custom_data?.user_id) {
        await upsertFromTransaction(data);
      }
    }
  } catch (err: any) {
    console.error('paddle_webhook_error', type, err?.message || err);
    // Still 200 so Paddle doesn't hammer retries on a transient DB blip; we log it.
  }

  return ok({ received: true });
}

async function upsertFromSubscription(type: string, data: any): Promise<void> {
  const subId: string | undefined = data.id;
  const customerId: string | undefined = data.customer_id;
  const status: string = data.status || 'inactive';
  const userId: string | undefined = data.custom_data?.user_id;
  const priceId: string | undefined = data.items?.[0]?.price?.id;
  const periodEnd: string | null = data.current_billing_period?.ends_at || null;

  const mapped = priceId ? PRICE_TO_PLAN[priceId] : undefined;
  const plan = type === 'subscription.canceled' ? 'free' : (mapped?.plan || 'free');
  const cycle = mapped?.cycle || null;
  const effectiveStatus = type === 'subscription.canceled' ? 'canceled' : status;

  // Prefer reconciling by user_id (set at checkout); fall back to the Paddle sub id.
  if (userId) {
    await query(
      `INSERT INTO subscriptions
         (user_id, plan, cycle, status, price_id, paddle_subscription_id, paddle_customer_id, current_period_end, updated_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         plan=EXCLUDED.plan, cycle=EXCLUDED.cycle, status=EXCLUDED.status, price_id=EXCLUDED.price_id,
         paddle_subscription_id=EXCLUDED.paddle_subscription_id, paddle_customer_id=EXCLUDED.paddle_customer_id,
         current_period_end=EXCLUDED.current_period_end, updated_at=NOW()`,
      [userId, plan, cycle, effectiveStatus, priceId || null, subId || null, customerId || null, periodEnd],
    );
  } else if (subId) {
    await query(
      `UPDATE subscriptions SET
         plan=$2, cycle=$3, status=$4, price_id=$5, paddle_customer_id=$6, current_period_end=$7, updated_at=NOW()
       WHERE paddle_subscription_id=$1`,
      [subId, plan, cycle, effectiveStatus, priceId || null, customerId || null, periodEnd],
    );
  }
}

async function upsertFromTransaction(data: any): Promise<void> {
  const userId: string = data.custom_data.user_id;
  const subId: string | undefined = data.subscription_id;
  const customerId: string | undefined = data.customer_id;
  const priceId: string | undefined = data.items?.[0]?.price?.id;
  const mapped = priceId ? PRICE_TO_PLAN[priceId] : undefined;
  if (!mapped) return;

  await query(
    `INSERT INTO subscriptions
       (user_id, plan, cycle, status, price_id, paddle_subscription_id, paddle_customer_id, updated_at)
     VALUES ($1,$2,$3,'active',$4,$5,$6,NOW())
     ON CONFLICT (user_id) DO UPDATE SET
       plan=EXCLUDED.plan, cycle=EXCLUDED.cycle, status='active', price_id=EXCLUDED.price_id,
       paddle_subscription_id=EXCLUDED.paddle_subscription_id, paddle_customer_id=EXCLUDED.paddle_customer_id,
       updated_at=NOW()`,
    [userId, mapped.plan, mapped.cycle, priceId || null, subId || null, customerId || null],
  );
}

/** Authed: GET /billing/status → the caller's current plan. */
export async function handleBilling(
  method: string,
  segments: string[],
  userId: string,
  email: string | null = null,
): Promise<APIGatewayProxyResult> {
  if (method === 'GET' && segments[1] === 'status') {
    await ensureSchema();
    const row = await queryOne<{ plan: string; cycle: string | null; status: string; current_period_end: string | null }>(
      'SELECT plan, cycle, status, current_period_end FROM subscriptions WHERE user_id=$1',
      [userId],
    );
    // Honour the temporary pricing-exempt allowlist so the client UI also
    // reflects the unlimited plan (unlocks premium models / advanced features).
    return ok({
      plan: isPricingExempt(email) ? 'enterprise' : effectivePlan(row),
      cycle: row?.cycle || null,
      status: isPricingExempt(email) ? 'active' : (row?.status || 'inactive'),
      current_period_end: row?.current_period_end || null,
    });
  }

  // GET /billing/usage → detailed usage for the billing/usage UI: this month's
  // token usage per model + meeting and batch-hour consumption vs plan limits.
  if (method === 'GET' && segments[1] === 'usage') {
    const plan = await getUserPlan(userId, email);
    const [tokens, byFeature, meeting, batch] = await Promise.all([
      getMonthlyTokenUsage(userId),
      getMonthlyUsageByFeature(userId),
      getMeetingUsage(userId, plan),
      getBatchHoursUsage(userId, plan),
    ]);
    return ok({
      plan,
      planLabel: planLabel(plan),
      tokens: { ...tokens, byFeature },
      meetings: {
        used: meeting.used,
        limit: meeting.limit,
        period: meeting.period,
        remaining: meeting.limit === null ? null : Math.max(0, meeting.limit - meeting.used),
      },
      batchHours: {
        usedHours: Math.round(batch.usedHours * 100) / 100,
        limitHours: batch.limitHours,
        remainingHours: batch.limitHours === null ? null : Math.max(0, Math.round((batch.limitHours - batch.usedHours) * 100) / 100),
      },
    });
  }

  return badRequest('unsupported billing route');
}
