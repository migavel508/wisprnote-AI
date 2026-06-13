import { useState, useEffect } from 'react';
import { Check, Loader2, ExternalLink, Sparkles, Building2, User, Activity, Cpu, Mic, CalendarClock, Clock } from 'lucide-react';
import type { AuthSession } from '../../services/awsAuthService';
import {
  openCheckout,
  openCustomerPortal,
  isPaddleConfigured,
  type PlanId,
} from '../../services/paddleService';
import { getUsage, type UsageSummary, type ModelTokenUsage } from '../../services/awsService';

const fmtTokens = (n: number): string =>
  n >= 1_000_000 ? `${(n / 1_000_000).toFixed(2)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(1)}K` : `${n}`;

const fmtMinutes = (seconds: number): string => {
  const m = seconds / 60;
  if (m >= 60) return `${(m / 60).toFixed(1)}h`;
  if (m >= 1) return `${m.toFixed(1)} min`;
  return `${Math.round(seconds)}s`;
};

const prettyModel = (provider: string, model: string | null): string => {
  if (!model) return provider;
  return model
    .replace(/^google\//, '')
    .replace(/^anthropic\//, '')
    .replace(/-preview$/, '')
    .replace(/-\d{8}$/, '');
};

const isAudioModel = (r: ModelTokenUsage): boolean => (r.audio_seconds ?? 0) > 0 && r.total_tokens === 0;

// ── Usage / analytics dashboard ────────────────────────────────────────────────

/** A compact metric tile with an optional usage bar. */
function StatTile({
  icon: Icon,
  label,
  value,
  sub,
  pct,
}: {
  icon: typeof Activity;
  label: string;
  value: string;
  sub?: string;
  pct?: number | null;
}) {
  return (
    <div className="rounded-xl bg-app-panel border border-app-card-border p-3.5">
      <div className="flex items-center gap-1.5 mb-1.5 text-app-fg-subtle">
        <Icon className="w-3.5 h-3.5" strokeWidth={2} />
        <span className="text-[11px] font-medium tracking-[-0.01em]">{label}</span>
      </div>
      <div className="text-[19px] font-semibold text-app-fg tabular-nums leading-none">{value}</div>
      {sub && <div className="text-[10.5px] text-app-fg-subtle mt-1">{sub}</div>}
      {pct != null && (
        <div className="mt-2.5 h-1.5 rounded-full bg-app-divider overflow-hidden">
          <div className="h-full rounded-full bg-app-accent transition-all" style={{ width: `${pct}%` }} />
        </div>
      )}
    </div>
  );
}

function UsagePanel({ usage, loading }: { usage: UsageSummary | null; loading: boolean }) {
  if (loading) {
    return (
      <div className="mb-7 rounded-2xl border border-app-divider bg-app-canvas p-5 flex items-center gap-2 text-[12.5px] text-app-fg-subtle">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading usage…
      </div>
    );
  }
  if (!usage) return null;

  const m = usage.meetings;
  const b = usage.batchHours;
  const audioSec = usage.tokens.totalAudioSeconds ?? usage.tokens.byModel.reduce((s, r) => s + (r.audio_seconds ?? 0), 0);

  const meetingValue = m.limit === null ? `${m.used}` : `${m.used} / ${m.limit}`;
  const meetingSub = m.limit === null ? 'Unlimited' : `${m.period === 'total' ? 'total' : 'this month'} · ${Math.max(0, (m.limit ?? 0) - m.used)} left`;
  const meetingPct = m.limit ? Math.min(100, (m.used / m.limit) * 100) : null;

  const hoursValue = b.limitHours === null ? `${b.usedHours.toFixed(1)}h` : `${b.usedHours.toFixed(1)} / ${b.limitHours}h`;
  const hoursSub = b.limitHours === null ? 'Unlimited' : `${Math.max(0, (b.limitHours ?? 0) - b.usedHours).toFixed(1)}h left`;
  const hoursPct = b.limitHours ? Math.min(100, (b.usedHours / b.limitHours) * 100) : null;

  const maxModelTotal = Math.max(1, ...usage.tokens.byModel.map((r) => (isAudioModel(r) ? (r.audio_seconds ?? 0) : r.total_tokens)));

  return (
    <div className="mb-7 rounded-2xl border border-app-divider bg-app-canvas p-5">
      <div className="flex items-center gap-2 mb-4">
        <Activity className="w-4 h-4 text-app-accent" strokeWidth={2} />
        <h2 className="text-[14px] font-semibold text-app-fg tracking-[-0.01em]">Usage this month</h2>
        <span className="ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-full bg-app-raised text-app-fg-muted">{usage.planLabel} plan</span>
      </div>

      {/* Top-line metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-5">
        <StatTile icon={CalendarClock} label={m.period === 'total' ? 'Meetings (total)' : 'Meetings'} value={meetingValue} sub={meetingSub} pct={meetingPct} />
        <StatTile icon={Clock} label="Batch hours" value={hoursValue} sub={hoursSub} pct={hoursPct} />
        <StatTile icon={Mic} label="Transcription" value={fmtMinutes(audioSec)} sub="audio processed" />
      </div>

      {/* AI model breakdown */}
      <div className="flex items-center gap-2 mb-2.5">
        <Cpu className="w-3.5 h-3.5 text-app-fg-subtle" strokeWidth={2} />
        <span className="text-[12px] font-medium text-app-fg">AI usage by model</span>
        <span className="ml-auto text-[12px] font-semibold text-app-fg tabular-nums">
          {fmtTokens(usage.tokens.totalTokens)} tokens · {usage.tokens.calls} calls
        </span>
      </div>

      {usage.tokens.byModel.length === 0 ? (
        <div className="text-[12px] text-app-fg-subtle py-3 text-center rounded-lg bg-app-raised/50">No AI usage yet this month.</div>
      ) : (
        <div className="space-y-2">
          {usage.tokens.byModel.map((r, i) => {
            const audio = isAudioModel(r);
            const magnitude = audio ? (r.audio_seconds ?? 0) : r.total_tokens;
            const barPct = Math.max(3, Math.min(100, (magnitude / maxModelTotal) * 100));
            return (
              <div key={i} className="rounded-lg bg-app-raised/50 px-3 py-2">
                <div className="flex items-center gap-2 text-[12px] mb-1.5">
                  <span className="font-medium text-app-fg">{prettyModel(r.provider, r.model)}</span>
                  <span className="text-[10px] px-1.5 py-px rounded-full bg-app-badge-bg text-app-badge-fg">{r.provider}</span>
                  <span className="ml-auto text-app-fg-muted tabular-nums">
                    {audio ? (
                      <span className="font-semibold text-app-fg">{fmtMinutes(r.audio_seconds ?? 0)}</span>
                    ) : (
                      <>
                        {fmtTokens(r.input_tokens)} in · {fmtTokens(r.output_tokens)} out · <span className="font-semibold text-app-fg">{fmtTokens(r.total_tokens)}</span>
                      </>
                    )}
                  </span>
                </div>
                <div className="h-1 rounded-full bg-app-divider overflow-hidden">
                  <div className={`h-full rounded-full ${audio ? 'bg-app-fg-subtle' : 'bg-app-accent'}`} style={{ width: `${barPct}%` }} />
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ── Plan catalog (monthly only) ────────────────────────────────────────────────
// Display metadata only. The amount actually charged is whatever the matching
// Paddle MONTHLY price (VITE_PADDLE_*_PRICE_ID) is configured to in the Paddle
// dashboard; keep these labels in sync with that configuration.
interface PlanDef {
  id: PlanId;
  name: string;
  icon: typeof User;
  tagline: string;
  price: string;
  priceSuffix: string;
  features: string[];
  highlight?: boolean;
  /** Sales-led plan — no self-serve checkout; opens a Contact Sales email. */
  salesLed?: boolean;
}

const SALES_EMAIL = 'sales@wisprnote.com';

const PLANS: PlanDef[] = [
  {
    id: 'pro',
    name: 'Pro',
    icon: User,
    tagline: 'For professionals who want clarity from every meeting',
    price: '$29',
    priceSuffix: 'per month',
    features: [
      '20 meetings per month',
      '5 batch hours per month',
      'Real-time transcription (10 languages)',
      'AI summaries, action items & follow-up emails',
      'Personal workspace & folders',
    ],
  },
  {
    id: 'pro_plus',
    name: 'Pro Plus',
    icon: Sparkles,
    tagline: 'Real-time + multilingual batch, across every meeting',
    price: '$49',
    priceSuffix: 'per month',
    features: [
      'Unlimited meetings',
      '15 batch hours · 70+ languages',
      'Search & chat across all past meetings',
      'Personal knowledge graph',
      'Team workspace (up to 8 members)',
    ],
    highlight: true,
  },
  {
    id: 'enterprise',
    name: 'Enterprise',
    icon: Building2,
    tagline: 'Governance and controls your organisation can trust',
    price: '$99',
    priceSuffix: 'per user / month',
    salesLed: true,
    features: [
      'Unlimited everything',
      'Org-wide knowledge graph & decision log',
      'Role-based access controls',
      'SSO & SCIM provisioning',
      'Dedicated onboarding & priority support',
    ],
  },
];

// Until subscription state is synced from Paddle webhooks (into a `subscriptions`
// table reconciled via custom_data.user_id), everyone is treated as Free.
const CURRENT_PLAN: PlanId = 'free';

function PlanCard({
  plan,
  isCurrent,
  busy,
  onChoose,
}: {
  plan: PlanDef;
  isCurrent: boolean;
  busy: boolean;
  onChoose: () => void;
}) {
  const Icon = plan.icon;

  return (
    <div
      className={`relative flex flex-col rounded-2xl border p-5 transition-all ${
        plan.highlight
          ? 'border-app-accent/50 bg-app-panel shadow-md ring-1 ring-app-accent/20'
          : 'border-app-card-border bg-app-panel hover:border-app-fg-subtle/40'
      }`}
    >
      {plan.highlight && (
        <div className="absolute -top-2.5 left-1/2 -translate-x-1/2 px-2.5 py-0.5 rounded-full bg-app-accent text-app-accent-fg text-[10px] font-semibold tracking-[0.04em] uppercase shadow-sm">
          Most popular
        </div>
      )}

      <div className="flex items-center gap-2 mb-1">
        <div className="w-7 h-7 rounded-lg bg-app-accent/15 text-app-accent flex items-center justify-center flex-shrink-0">
          <Icon size={15} strokeWidth={1.8} />
        </div>
        <div className="text-[15px] font-semibold text-app-fg tracking-[-0.01em]">{plan.name}</div>
        {isCurrent && (
          <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full bg-app-raised text-app-fg-muted">Current</span>
        )}
      </div>
      <div className="text-[12px] text-app-fg-subtle mb-4 leading-snug min-h-[32px]">{plan.tagline}</div>

      <div className="flex items-baseline gap-1.5">
        <span className="text-[30px] font-serif text-app-fg tracking-[-0.02em] leading-none">{plan.price}</span>
      </div>
      <div className="text-[11.5px] text-app-fg-subtle mt-1.5 mb-5">{plan.priceSuffix}</div>

      <ul className="space-y-2 mb-6 flex-1">
        {plan.features.map((f) => (
          <li key={f} className="flex items-start gap-2 text-[12.5px] text-app-fg leading-snug">
            <span className="mt-0.5 flex-shrink-0 w-4 h-4 rounded-full bg-app-accent/15 flex items-center justify-center">
              <Check size={11} strokeWidth={2.6} className="text-app-accent" />
            </span>
            <span className="tracking-[-0.01em]">{f}</span>
          </li>
        ))}
      </ul>

      <button
        disabled={isCurrent || busy}
        onClick={onChoose}
        className={`w-full flex items-center justify-center gap-1.5 py-2.5 rounded-xl text-[13px] font-medium tracking-[-0.01em] transition-all duration-200 ${
          isCurrent
            ? 'bg-app-raised border border-app-divider text-app-fg-subtle cursor-default'
            : plan.highlight
              ? 'bg-app-fg text-app-canvas hover:opacity-90'
              : 'bg-app-canvas border border-app-divider text-app-fg hover:border-app-fg-subtle/40'
        }`}
      >
        {busy ? (
          <>
            <Loader2 size={14} className="animate-spin" /> Opening…
          </>
        ) : isCurrent ? (
          'Current plan'
        ) : plan.salesLed ? (
          <>
            Contact Sales <ExternalLink size={13} strokeWidth={1.8} />
          </>
        ) : (
          <>
            Upgrade to {plan.name} <ExternalLink size={13} strokeWidth={1.8} />
          </>
        )}
      </button>
    </div>
  );
}

export default function BillingTab({ session }: { session: AuthSession | null }) {
  const [busyPlan, setBusyPlan] = useState<PlanId | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [usageLoading, setUsageLoading] = useState(true);
  const configured = isPaddleConfigured();

  useEffect(() => {
    let cancelled = false;
    getUsage()
      .then((u) => { if (!cancelled) setUsage(u); })
      .catch(() => { /* non-fatal — panel just hides */ })
      .finally(() => { if (!cancelled) setUsageLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const currentPlan: PlanId = (usage?.plan as PlanId) || CURRENT_PLAN;

  const handleChoose = async (plan: PlanDef) => {
    if (busyPlan) return;
    setError(null);

    // Enterprise is sales-led — open a Contact Sales email instead of checkout.
    if (plan.salesLed) {
      const subject = encodeURIComponent('Wisprnote AI — Enterprise enquiry');
      const body = encodeURIComponent(
        `Hi, I'm interested in the Enterprise plan for my team.\n\nAccount: ${session?.user?.email || ''}\n`,
      );
      window.open(`mailto:${SALES_EMAIL}?subject=${subject}&body=${body}`, '_blank');
      return;
    }

    setBusyPlan(plan.id);
    try {
      const ok = await openCheckout({
        plan: plan.id as 'pro' | 'pro_plus',
        cycle: 'monthly',
        quantity: 1,
        session,
      });
      if (!ok) {
        setError('Checkout isn’t available yet — payment configuration is pending. Please try again later.');
      }
    } catch {
      setError('Could not open checkout. Please try again.');
    } finally {
      setBusyPlan(null);
    }
  };

  const handleManage = async () => {
    const ok = await openCustomerPortal();
    if (!ok) setError('The billing portal isn’t configured yet.');
  };

  return (
    <div className="max-w-[920px] mx-auto px-8 pb-16">
      <div className="pt-2 mb-1">
        <h1 className="text-[28px] font-serif text-app-fg tracking-[-0.02em]">Billing</h1>
      </div>
      <p className="text-[13px] text-app-fg-subtle tracking-[-0.01em] mb-6">
        Choose the plan that fits your workflow. Checkout opens securely in your browser, powered by Paddle.
      </p>

      <UsagePanel usage={usage} loading={usageLoading} />

      {!configured && (
        <div className="mb-6 rounded-xl border border-dashed border-app-divider bg-app-canvas px-4 py-3 text-[12px] text-app-fg-subtle tracking-[-0.01em]">
          Payments aren’t fully set up yet. Once the Paddle account is approved and{' '}
          <code className="font-mono text-[11px]">VITE_PADDLE_*</code> env vars are filled in, the upgrade buttons
          below will open live checkout.
        </div>
      )}

      {error && (
        <div className="mb-6 rounded-xl border border-red-200 dark:border-red-900/50 bg-red-50 dark:bg-red-950/30 px-4 py-3 text-[12.5px] text-red-700 dark:text-red-300 tracking-[-0.01em]">
          {error}
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 items-stretch">
        {PLANS.map((plan) => (
          <PlanCard
            key={plan.id}
            plan={plan}
            isCurrent={plan.id === currentPlan}
            busy={busyPlan === plan.id}
            onChoose={() => handleChoose(plan)}
          />
        ))}
      </div>

      <div className="mt-8 flex items-center justify-between rounded-2xl border border-app-divider bg-app-canvas px-5 py-4 flex-wrap gap-3">
        <div>
          <div className="text-[13.5px] font-medium text-app-fg tracking-[-0.01em]">Manage your subscription</div>
          <div className="text-[12px] text-app-fg-subtle mt-0.5">
            Update payment method, download invoices, or cancel anytime.
          </div>
        </div>
        <button
          onClick={handleManage}
          className="flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-[12.5px] font-medium text-app-fg bg-app-panel border border-app-divider hover:border-app-fg-subtle/40 transition-colors tracking-[-0.01em]"
        >
          Billing portal <ExternalLink size={13} strokeWidth={1.8} />
        </button>
      </div>

      <p className="mt-6 text-[11px] text-app-fg-subtle text-center tracking-[-0.01em]">
        Payments are securely processed by Paddle, our Merchant of Record. Prices shown exclude any applicable taxes.
      </p>
    </div>
  );
}
