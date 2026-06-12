/**
 * Plan limits — the single source of truth for what each tier may use.
 * MUST mirror the public pricing on the marketing site (website/PricingPage):
 *   Free        — 5 meetings (lifetime trial), light batch processing
 *   Pro    $29  — 20 meetings / month, 5 batch hours / month
 *   Pro Plus $49 — unlimited meetings, 15 batch hours / month
 *   Enterprise $99 — unlimited meetings, unlimited batch hours
 *
 * Real-time transcription is identical across tiers and is NOT metered here;
 * only uploaded ("batch") processing hours count toward the hour caps.
 */
export type PlanId = 'free' | 'pro' | 'pro_plus' | 'enterprise';

export interface PlanLimits {
  /** Max meetings; null = unlimited. */
  meetings: number | null;
  /** Whether the meeting cap is a lifetime total (free trial) or per month. */
  meetingsPeriod: 'total' | 'month';
  /** Batch (uploaded) processing hours per month; null = unlimited. */
  batchHours: number | null;
}

export const PLAN_LIMITS: Record<string, PlanLimits> = {
  free:       { meetings: 5,    meetingsPeriod: 'total', batchHours: 2 },
  pro:        { meetings: 20,   meetingsPeriod: 'month', batchHours: 5 },
  pro_plus:   { meetings: null, meetingsPeriod: 'month', batchHours: 15 },
  enterprise: { meetings: null, meetingsPeriod: 'month', batchHours: null },
};

export function planLimits(plan: string): PlanLimits {
  return PLAN_LIMITS[plan] ?? PLAN_LIMITS.free;
}

/** Human label for a plan id. */
export function planLabel(plan: string): string {
  switch (plan) {
    case 'pro': return 'Pro';
    case 'pro_plus': return 'Pro Plus';
    case 'enterprise': return 'Enterprise';
    default: return 'Free';
  }
}
