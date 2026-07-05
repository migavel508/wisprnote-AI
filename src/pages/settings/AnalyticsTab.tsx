import { useEffect, useMemo, useState } from 'react';
import {
  Activity, Cpu, Mic, CalendarClock, Clock, Loader2, FileText, MessageSquare,
  Brain, Network, Sparkles, BookOpen, LayoutGrid,
} from 'lucide-react';
import { getUsage, type UsageSummary, type ModelTokenUsage, type FeatureTokenUsage } from '../../services/awsService';

// ── formatting helpers ──────────────────────────────────────────────────────────
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
  return model.replace(/^google\//, '').replace(/^anthropic\//, '').replace(/-preview$/, '').replace(/-\d{8}$/, '');
};

const isAudioModel = (r: ModelTokenUsage): boolean => (r.audio_seconds ?? 0) > 0 && r.total_tokens === 0;

// ── feature display metadata ─────────────────────────────────────────────────────
const FEATURE_META: Record<string, { label: string; icon: typeof Activity; audio?: boolean }> = {
  transcription: { label: 'Transcription', icon: Mic, audio: true },
  meeting: { label: 'Meeting notes & summaries', icon: FileText },
  chat: { label: 'Chat', icon: MessageSquare },
  brain: { label: 'Brain map', icon: Brain },
  'knowledge-graph': { label: 'Knowledge graph', icon: Network },
  assets: { label: 'Assets (email · wiki · deck)', icon: Sparkles },
  dictionary: { label: 'Dictionary', icon: BookOpen },
  other: { label: 'Other', icon: Cpu },
};
const featureMeta = (f: string) => FEATURE_META[f] || { label: f, icon: Cpu };

function StatTile({ icon: Icon, label, value, sub, pct }: {
  icon: typeof Activity; label: string; value: string; sub?: string; pct?: number | null;
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

/** The per-FEATURE breakdown — the heart of the Analytics panel. */
function FeatureBreakdown({ rows }: { rows: FeatureTokenUsage[] }) {
  const maxTokens = Math.max(1, ...rows.map((r) => r.total_tokens));
  const maxAudio = Math.max(1, ...rows.map((r) => r.audio_seconds || 0));
  if (rows.length === 0) {
    return <div className="text-[12px] text-app-fg-subtle py-3 text-center rounded-lg bg-app-raised/50">No usage recorded yet this month.</div>;
  }
  return (
    <div className="space-y-2">
      {rows.map((r) => {
        const meta = featureMeta(r.feature);
        const Icon = meta.icon;
        const audio = (r.audio_seconds || 0) > 0 && r.total_tokens === 0;
        const barPct = Math.max(3, Math.min(100, audio ? (r.audio_seconds / maxAudio) * 100 : (r.total_tokens / maxTokens) * 100));
        return (
          <div key={r.feature} className="rounded-lg bg-app-raised/50 px-3 py-2.5">
            <div className="flex items-center gap-2 text-[12.5px] mb-1.5">
              <Icon className="w-3.5 h-3.5 text-app-fg-subtle" strokeWidth={2} />
              <span className="font-medium text-app-fg">{meta.label}</span>
              <span className="text-[10px] text-app-fg-subtle">{r.calls} call{r.calls === 1 ? '' : 's'}</span>
              <span className="ml-auto tabular-nums text-app-fg-muted">
                {audio ? (
                  <span className="font-semibold text-app-fg">{fmtMinutes(r.audio_seconds)}</span>
                ) : (
                  <>{fmtTokens(r.input_tokens)} in · {fmtTokens(r.output_tokens)} out · <span className="font-semibold text-app-fg">{fmtTokens(r.total_tokens)}</span></>
                )}
              </span>
            </div>
            <div className="h-1.5 rounded-full bg-app-divider overflow-hidden">
              <div className={`h-full rounded-full ${audio ? 'bg-app-fg-subtle' : 'bg-app-accent'}`} style={{ width: `${barPct}%` }} />
            </div>
          </div>
        );
      })}
    </div>
  );
}

export default function AnalyticsTab() {
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    getUsage()
      .then((u) => { if (!cancelled) setUsage(u); })
      .catch(() => { /* non-fatal */ })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const byFeature = useMemo(() => (usage?.tokens.byFeature ?? []).slice().sort((a, b) => (b.total_tokens - a.total_tokens) || (b.audio_seconds - a.audio_seconds)), [usage]);

  if (loading) {
    return (
      <div className="flex items-center gap-2 text-[12.5px] text-app-fg-subtle py-10">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading usage analytics…
      </div>
    );
  }
  if (!usage) {
    return <div className="text-[13px] text-app-fg-subtle py-10">Usage analytics are unavailable right now. Please try again later.</div>;
  }

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
    <div className="max-w-[760px]">
      <div className="flex items-center gap-2 mb-1">
        <h2 className="text-[15px] font-semibold text-app-fg tracking-[-0.01em]">Usage this month</h2>
        <span className="ml-auto text-[11px] font-semibold px-2 py-0.5 rounded-full bg-app-raised text-app-fg-muted">{usage.planLabel} plan</span>
      </div>
      <p className="text-[12px] text-app-fg-subtle mb-5">Token and audio usage across every AI feature. This is what your charges are based on.</p>

      {/* Top-line metrics */}
      <div className="grid grid-cols-2 md:grid-cols-3 gap-3 mb-6">
        <StatTile icon={CalendarClock} label={m.period === 'total' ? 'Meetings (total)' : 'Meetings'} value={meetingValue} sub={meetingSub} pct={meetingPct} />
        <StatTile icon={Clock} label="Batch hours" value={hoursValue} sub={hoursSub} pct={hoursPct} />
        <StatTile icon={Mic} label="Transcription" value={fmtMinutes(audioSec)} sub="audio processed" />
      </div>

      {/* Per-FEATURE breakdown */}
      <div className="rounded-2xl border border-app-divider bg-app-canvas p-5 mb-5">
        <div className="flex items-center gap-2 mb-3">
          <LayoutGrid className="w-4 h-4 text-app-accent" strokeWidth={2} />
          <span className="text-[13px] font-semibold text-app-fg">Usage by feature</span>
          <span className="ml-auto text-[12px] font-semibold text-app-fg tabular-nums">
            {fmtTokens(usage.tokens.totalTokens)} tokens · {usage.tokens.calls} calls
          </span>
        </div>
        <FeatureBreakdown rows={byFeature} />
      </div>

      {/* By-model breakdown (secondary) */}
      <div className="rounded-2xl border border-app-divider bg-app-canvas p-5">
        <div className="flex items-center gap-2 mb-3">
          <Cpu className="w-3.5 h-3.5 text-app-fg-subtle" strokeWidth={2} />
          <span className="text-[13px] font-semibold text-app-fg">By model</span>
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
                        <>{fmtTokens(r.input_tokens)} in · {fmtTokens(r.output_tokens)} out · <span className="font-semibold text-app-fg">{fmtTokens(r.total_tokens)}</span></>
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
    </div>
  );
}
