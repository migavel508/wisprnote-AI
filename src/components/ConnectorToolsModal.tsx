import { useEffect, useMemo, useState } from 'react';
import { Check, Hand, Ban, X, Loader2, Search, Shield } from 'lucide-react';
import {
  getConnectorTools, setConnectorToolPermission,
  type ConnectorTool, type ToolBehavior, type ToolKlass,
} from '../services/connectorService';

/**
 * Per-tool permission editor — the trust plane's UI (modelled on Claude's connector tool
 * permissions). Lists the connector's DYNAMICALLY discovered tools, grouped by class, each with a
 * 3-way policy: Allow (runs without asking) · Needs approval (shows a card) · Never (blocked).
 * Writes rules through `POST /connectors/{id}/tool-permission`; the server gate enforces them.
 */

const KLASS_LABEL: Record<ToolKlass, string> = { read: 'Read-only', write: 'Write', destructive: 'Delete & destructive' };
// Consequential tools first so the rules that matter are seen.
const KLASS_ORDER: ToolKlass[] = ['destructive', 'write', 'read'];

function humanize(name: string): string {
  return name.replace(/[_-]+/g, ' ').replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}

const BEHAVIORS: { id: ToolBehavior; Icon: typeof Check; title: string; color: string }[] = [
  { id: 'allow', Icon: Check, title: 'Always allow', color: '#10b981' },
  { id: 'ask', Icon: Hand, title: 'Needs approval', color: '#d4a017' },
  { id: 'deny', Icon: Ban, title: 'Never', color: '#ef4444' },
];

export default function ConnectorToolsModal({ connectorId, connectorName, workspaceId, onClose }: {
  connectorId: string; connectorName: string; workspaceId: string; onClose: () => void;
}) {
  const [tools, setTools] = useState<ConnectorTool[] | null>(null);
  const [q, setQ] = useState('');
  const [saving, setSaving] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    getConnectorTools(connectorId, workspaceId).then((t) => { if (!cancelled) setTools(t); });
    return () => { cancelled = true; };
  }, [connectorId, workspaceId]);

  const setBehavior = async (tool: string, behavior: ToolBehavior) => {
    setTools((prev) => prev ? prev.map((t) => t.tool_name === tool ? { ...t, behavior } : t) : prev);
    setSaving(tool);
    try { await setConnectorToolPermission(connectorId, workspaceId, tool, behavior); }
    finally { setSaving(null); }
  };

  const groups = useMemo(() => {
    const term = q.trim().toLowerCase();
    const filtered = (tools || []).filter((t) => !term || t.tool_name.toLowerCase().includes(term) || humanize(t.tool_name).toLowerCase().includes(term));
    return KLASS_ORDER.map((k) => ({ klass: k, label: KLASS_LABEL[k], items: filtered.filter((t) => t.klass === k) })).filter((g) => g.items.length);
  }, [tools, q]);

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[640px] max-w-[94vw] max-h-[84vh] flex flex-col p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-1">
          <h3 className="text-[15px] font-semibold text-app-fg flex items-center gap-2"><Shield size={15} className="text-app-fg-muted" /> {connectorName} · tool permissions</h3>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={15} /></button>
        </div>
        <p className="text-[12px] text-app-fg-subtle leading-relaxed mb-3">
          Choose when the agent may use each tool. <span className="text-emerald-500 font-medium">Allow</span> runs without asking,
          <span className="text-amber-500 font-medium"> Needs approval</span> shows a card first, <span className="text-red-400 font-medium">Never</span> blocks it.
          Defaults: read-only → allow, write → approval, destructive → never.
        </p>
        <div className="flex items-center gap-2 px-3 py-1.5 mb-2 rounded-lg border border-app-border bg-app-panel">
          <Search size={13} className="text-app-fg-subtle flex-shrink-0" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search tools…" className="flex-1 text-[12.5px] bg-transparent outline-none text-app-fg placeholder:text-app-fg-subtle" />
        </div>
        <div className="flex-1 overflow-y-auto -mx-1 px-1">
          {tools === null ? (
            <div className="py-10 flex items-center justify-center gap-2 text-[12.5px] text-app-fg-subtle"><Loader2 size={14} className="animate-spin" /> Loading tools…</div>
          ) : tools.length === 0 ? (
            <p className="py-10 text-center text-[12.5px] text-app-fg-subtle">No tools discovered yet — they populate right after connecting (and on the next sync).</p>
          ) : groups.map((g) => (
            <div key={g.klass} className="mb-3">
              <div className="text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] px-1 mb-1.5">{g.label} · {g.items.length}</div>
              <div className="space-y-1">
                {g.items.map((t) => (
                  <div key={t.tool_name} className="flex items-center gap-3 rounded-lg border border-app-border bg-app-panel px-3 py-2">
                    <div className="min-w-0 flex-1">
                      <div className="text-[12.5px] text-app-fg truncate">{humanize(t.tool_name)}</div>
                      {t.description && <div className="text-[10.5px] text-app-fg-subtle truncate">{t.description}</div>}
                    </div>
                    {saving === t.tool_name && <Loader2 size={12} className="animate-spin text-app-fg-subtle flex-shrink-0" />}
                    <div className="flex items-center gap-0.5 bg-app-canvas rounded-lg p-0.5 border border-app-border flex-shrink-0">
                      {BEHAVIORS.map((b) => {
                        const active = t.behavior === b.id;
                        return (
                          <button
                            key={b.id} title={b.title}
                            onClick={() => setBehavior(t.tool_name, b.id)}
                            className="w-7 h-6 flex items-center justify-center rounded-md transition-colors hover:bg-app-nav-hover-bg"
                            style={active ? { background: `${b.color}22`, color: b.color } : undefined}
                          >
                            <b.Icon size={13} className={active ? '' : 'text-app-fg-subtle'} strokeWidth={2} />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
