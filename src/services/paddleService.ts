import { logger } from '../lib/logger';
import type { AuthSession } from './awsAuthService';

const log = logger.scope('Paddle');

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

/**
 * Paddle Billing configuration, read from Vite env vars.
 *
 * We open Paddle's hosted checkout in the system browser (see `openCheckout`),
 * so the only values strictly required are a default payment-link URL
 * (`VITE_PADDLE_CHECKOUT_URL`) plus the price IDs for each plan/cycle.
 *
 * `VITE_PADDLE_CLIENT_TOKEN` / `VITE_PADDLE_ENV` are kept here so the app can
 * later switch to the inline Paddle.js overlay without re-plumbing config.
 *
 * Fill these in once your Paddle account is approved — see `.env.example`.
 */
export const paddleConfig = {
  environment: (import.meta.env.VITE_PADDLE_ENV as 'sandbox' | 'production') || 'sandbox',
  clientToken: import.meta.env.VITE_PADDLE_CLIENT_TOKEN || '',
  /** Default payment-link URL from Paddle → Checkout settings (e.g. https://pay.wisprnote.com). */
  checkoutUrl: import.meta.env.VITE_PADDLE_CHECKOUT_URL || '',
  /** Customer portal URL for managing an existing subscription. */
  customerPortalUrl: import.meta.env.VITE_PADDLE_CUSTOMER_PORTAL_URL || '',
};

export type PlanId = 'free' | 'pro' | 'pro_plus' | 'enterprise';
// Monthly-only billing. (Kept as a named type so call sites read clearly.)
export type BillingCycle = 'monthly';

/**
 * Live Paddle price IDs, baked in so checkout works without per-env wiring.
 * An env var (VITE_PADDLE_<PLAN>_MONTHLY_PRICE_ID), if set, overrides the default
 * — handy for sandbox testing. Enterprise is sales-led (no self-serve price).
 */
const DEFAULT_PRICE_IDS: Record<'pro' | 'pro_plus', Record<BillingCycle, string>> = {
  pro: { monthly: 'pri_01ktk4bhps03ydb5w01mbe66xf' },
  pro_plus: { monthly: 'pri_01ktk4bjryvtypx056f14nb3ew' },
};

/** Resolve the Paddle price ID for a paid self-serve plan (monthly). */
function priceIdFor(plan: Exclude<PlanId, 'free' | 'enterprise'>, cycle: BillingCycle = 'monthly'): string {
  const key = `VITE_PADDLE_${plan.toUpperCase()}_${cycle.toUpperCase()}_PRICE_ID`;
  const fromEnv = import.meta.env[key as keyof ImportMetaEnv] as string | undefined;
  return fromEnv || DEFAULT_PRICE_IDS[plan]?.[cycle] || '';
}

/**
 * Where the desktop app sends users to check out. We open the WEBSITE checkout
 * page in the system browser (it hosts Paddle.js with the public client token),
 * so the desktop never needs the token itself.
 */
const WEBSITE_CHECKOUT_URL = import.meta.env.VITE_WEBSITE_CHECKOUT_URL || 'https://www.wisprnote.com/checkout';

/** Price IDs are baked in + checkout is hosted on the website, so this is always ready. */
export function isPaddleConfigured(): boolean {
  return true;
}

/** Open a URL in the system browser — Tauri shell on desktop, new tab on web. */
async function openExternal(url: string): Promise<void> {
  if (isTauri) {
    const { open } = await import('@tauri-apps/plugin-shell');
    await open(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export interface CheckoutOptions {
  /** Self-serve paid plans only — Enterprise is sales-led (Contact Sales). */
  plan: Exclude<PlanId, 'free' | 'enterprise'>;
  /** Billing cycle — monthly only. Optional; defaults to 'monthly'. */
  cycle?: BillingCycle;
  /** Number of seats. Defaults to 1. */
  quantity?: number;
  session: AuthSession | null;
}

/**
 * Launch Paddle's hosted checkout in the browser, pre-filled with the plan's
 * price, the signed-in user's email, and their id as custom_data so the
 * subscription can be reconciled back to the account via webhook.
 *
 * Returns `false` (and logs) when config is missing, so the UI can show a
 * "not yet available" state instead of opening a broken link.
 */
export async function openCheckout({ plan, cycle = 'monthly', quantity = 1, session }: CheckoutOptions): Promise<boolean> {
  const priceId = priceIdFor(plan as 'pro' | 'pro_plus', cycle);
  if (!priceId) {
    log.warn('checkout_no_price', { plan, cycle });
    return false;
  }

  // Open the website's checkout page in the system browser. It reads these
  // params and launches the Paddle overlay, stamping custom_data.user_id so the
  // resulting subscription is attributed back to this account via webhook.
  const url = new URL(WEBSITE_CHECKOUT_URL);
  url.searchParams.set('price', priceId);
  if (quantity > 1) url.searchParams.set('quantity', String(quantity));

  const email = session?.user?.email;
  if (email) url.searchParams.set('email', email);

  const userId = session?.user?.id;
  if (userId) url.searchParams.set('user_id', userId);

  log.info('open_checkout', { plan, cycle, quantity });
  await openExternal(url.toString());
  return true;
}

/** Open the Paddle customer portal so the user can manage/cancel their plan. */
export async function openCustomerPortal(): Promise<boolean> {
  if (!paddleConfig.customerPortalUrl) {
    log.warn('portal_not_configured');
    return false;
  }
  await openExternal(paddleConfig.customerPortalUrl);
  return true;
}
