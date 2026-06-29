import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { X, Loader2, BrainCircuit, ExternalLink, Users, Calendar, GitCommitHorizontal, ArrowRight, ArrowLeft, RefreshCw, Activity, GitCommit, ArrowRightLeft, AlertTriangle } from 'lucide-react';
import { getBrainGraph, getBrainNode, syncBrain, getBrainPulse, getBrainAlerts, type BrainNode, type BrainLink, type BrainNodeDetail, type BrainEvent, type BrainAlert } from '../services/brainService';
import { useTheme } from '../theme/ThemeProvider';

/**
 * The Living-Brain map — one graph across all sources. Design idea: "lineage spotlight".
 * At rest it's a calm, layered field — soft glowing reasoning arcs (coloured by VERDICT:
 * aligned / partial / divergent) over a quiet web of structural threads. Hovering or selecting
 * any node spotlights its lineage (meeting → Jira task → GitHub commit) and dims the rest, so
 * you read one story at a time instead of a tangle. Theme-native (warm cream / dark) — matches
 * the app's knowledge-graph language without copying its constellation layout.
 */

// Source hues — DESATURATED so nodes recede and the reasoning edges carry the signal.
const SOURCE_HUE: Record<string, { light: string; dark: string }> = {
  meeting: { light: '#7d951f', dark: '#b9d96a' },  // brand green (the "home" source)
  jira: { light: '#5a7fb5', dark: '#7aa6da' },     // muted blue
  github: { light: '#8b6fb0', dark: '#ab8fd4' },   // muted violet
  'claude-code': { light: '#b06a3d', dark: '#d79b6e' }, // warm clay — local dev sessions
  codex: { light: '#3d8a82', dark: '#6ec3b8' },         // teal — local dev sessions
};
// Verdict hues — the saturated, meaningful signal (kept distinct from the olive meeting green).
const VERDICT_HUE: Record<string, { light: string; dark: string }> = {
  aligned: { light: '#2f9e6b', dark: '#46c98c' },  // emerald
  partial: { light: '#c4862a', dark: '#e0a64a' },  // amber
  divergent: { light: '#c44d47', dark: '#e0635c' },// red
  unrelated: { light: '#c44d47', dark: '#e0635c' },
};

export default function BrainMapModal({ workspaceId, workspaceName, folderId = null, folderName, spaceId = null, onClose }: { workspaceId: string; workspaceName: string; folderId?: string | null; folderName?: string; spaceId?: string | null; onClose: () => void }) {
  const [data, setData] = useState<{ nodes: BrainNode[]; links: BrainLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const fgRef = useRef<any>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const [dims, setDims] = useState({ w: 1000, h: 600 });
  const { resolved: themeResolved } = useTheme();
  const isDark = themeResolved === 'dark';
  const [hoverId, setHoverId] = useState<string | null>(null);

  const [syncing, setSyncing] = useState(false);
  const [lastSync, setLastSync] = useState<string | null>(null);
  const [pulse, setPulse] = useState<BrainEvent[]>([]);
  const [pulseOpen, setPulseOpen] = useState(false);
  const [alerts, setAlerts] = useState<BrainAlert[]>([]);
  const [alertsOpen, setAlertsOpen] = useState(false);

  const srcColor = (source?: string): string => (source && SOURCE_HUE[source]?.[isDark ? 'dark' : 'light']) || (isDark ? '#9aa0aa' : '#9ca3af');
  const verdictColor = (v?: string | null): string | null => (v ? (VERDICT_HUE[v]?.[isDark ? 'dark' : 'light'] || (isDark ? '#e0a64a' : '#c4862a')) : null);
  const nodeColor = (n: any): string => srcColor(n?.source);
  // Status → a small ring colour. Backend-agnostic (done/closed/merged = complete; etc).
  const statusRing = (s?: string | null): string | null => {
    if (!s) return null;
    if (/done|closed|merged|resolved|complete|shipped/i.test(s)) return isDark ? '#46c98c' : '#2f9e6b';
    if (/progress|review|doing|started|active/i.test(s)) return isDark ? '#7aa6da' : '#5a7fb5';
    return isDark ? '#888a90' : '#b5b0a6';   // todo / open / backlog
  };

  const reloadView = async (cancelledRef?: { v: boolean }) => {
    const [g, p, a] = await Promise.all([getBrainGraph(workspaceId, folderId, spaceId), getBrainPulse(workspaceId, folderId, spaceId), getBrainAlerts(workspaceId, folderId, spaceId)]);
    if (cancelledRef?.v) return;
    setData(g); setPulse(p); setAlerts(a);
  };
  const doSync = async (cancelledRef?: { v: boolean }) => {
    setSyncing(true);
    const r = await syncBrain(workspaceId, spaceId);
    if (cancelledRef?.v) return;
    if (r?.syncedAt) setLastSync(r.syncedAt);
    await reloadView(cancelledRef);
    if (!cancelledRef?.v) setSyncing(false);
  };

  useEffect(() => {
    const ref = { v: false };
    // 1) paint the CURRENT brain instantly, 2) sync-on-open in the background, then refresh.
    getBrainGraph(workspaceId, folderId, spaceId).then((g) => { if (!ref.v) setData(g); }).finally(() => { if (!ref.v) setLoading(false); });
    getBrainPulse(workspaceId, folderId, spaceId).then((p) => { if (!ref.v) setPulse(p); });
    getBrainAlerts(workspaceId, folderId, spaceId).then((a) => { if (!ref.v) setAlerts(a); });
    doSync(ref);
    return () => { ref.v = true; };
  }, [workspaceId, folderId, spaceId]);

  // Responsive canvas: fill the available area (the graph needs ROOM to breathe).
  useEffect(() => {
    const measure = () => {
      const el = canvasRef.current;
      if (el) setDims({ w: el.clientWidth, h: el.clientHeight });
    };
    measure();
    const ro = typeof ResizeObserver !== 'undefined' ? new ResizeObserver(measure) : null;
    if (ro && canvasRef.current) ro.observe(canvasRef.current);
    window.addEventListener('resize', measure);
    return () => { ro?.disconnect(); window.removeEventListener('resize', measure); };
  }, [loading]);

  const graph = useMemo(() => ({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }), [data]);
  const sources = useMemo(() => Array.from(new Set(data.nodes.map((n) => n.source))), [data.nodes]);
  const hasVerdicts = useMemo(() => data.links.some((l) => l.verdict), [data.links]);
  // 1-hop adjacency (from the ORIGINAL string-id links, before force-graph mutates them into
  // node objects) — powers the focus-spotlight: highlight a node's lineage, dim the rest.
  const adjacency = useMemo(() => {
    const m = new Map<string, Set<string>>();
    const add = (a: string, b: string) => { (m.get(a) ?? m.set(a, new Set<string>()).get(a)!).add(b); };
    for (const l of data.links) { add(l.source, l.target); add(l.target, l.source); }
    return m;
  }, [data.links]);

  // Spread the layout out so nodes + lines aren't congested: strong repulsion, longer links,
  // capped attraction. Tuned once the graph instance + data exist.
  useEffect(() => {
    const fg = fgRef.current;
    if (!fg || !graph.nodes.length) return;
    const n = graph.nodes.length;
    // Obsidian-style spread: strong even repulsion + long, LOOSE links so clusters
    // open up into a readable web instead of collapsing into a hairball.
    const charge = fg.d3Force?.('charge');
    if (charge?.strength) { charge.strength(-260 - Math.min(n * 9, 1000)); charge.distanceMax?.(1600); }
    const link = fg.d3Force?.('link');
    if (link?.distance) { link.distance((l: any) => (l.verdict ? 95 : 165)); link.strength?.((l: any) => (l.verdict ? 0.2 : 0.045)); }
    const center = fg.d3Force?.('center');
    if (center?.strength) center.strength(0.05);
    fg.d3ReheatSimulation?.();
  }, [graph]);

  const [selLink, setSelLink] = useState<any>(null);
  const [detail, setDetail] = useState<BrainNodeDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Clicking a node opens a RICH info card (content + reasoned connections) — like the
  // knowledge graph — rather than just navigating away.
  const loadNode = (id: string, fallbackTitle?: string, fallbackSource?: string) => {
    setSelLink(null);
    setDetail({ node: { id, source: fallbackSource || '', title: fallbackTitle || '' }, connections: [] });
    setDetailLoading(true);
    getBrainNode(workspaceId, id, spaceId)
      .then((d) => { if (d) setDetail(d); })
      .finally(() => setDetailLoading(false));
  };
  const onNodeClick = (n: any) => loadNode(n.id, n.title, n.source);
  const onLinkClick = (l: any) => { setDetail(null); setSelLink(l); };

  const openUrl = (url?: string | null) => {
    if (!url) return;
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
    if (isTauri) import('@tauri-apps/plugin-shell').then(({ open }) => open(url)).catch(() => window.open(url, '_blank'));
    else window.open(url, '_blank');
  };

  const ago = (at?: string | null): string => {
    if (!at) return '';
    const ms = Date.now() - new Date(at).getTime();
    if (!Number.isFinite(ms) || ms < 0) return '';
    const m = Math.floor(ms / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m}m ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h}h ago`;
    return `${Math.floor(h / 24)}d ago`;
  };

  const titleOf = (end: any) => (typeof end === 'object' ? end?.title : null) || String(end || '');
  const peopleLine = (p: any): string => {
    if (!p) return '';
    const parts: string[] = [];
    if (p.author) parts.push(p.author);
    if (Array.isArray(p.assignees) && p.assignees.length) parts.push(`→ ${p.assignees.join(', ')}`);
    if (Array.isArray(p.participants) && p.participants.length) parts.push(p.participants.slice(0, 4).join(', '));
    return parts.join(' ');
  };

  // Spotlight: the hovered node (or the open detail node) + its 1-hop neighbours stay lit;
  // everything else dims. null = nothing focused → the calm resting field.
  const focusId = hoverId || detail?.node?.id || null;
  const focusSet = focusId ? new Set<string>([focusId, ...Array.from(adjacency.get(focusId) || [])]) : null;
  const selectedId = detail?.node?.id || null;
  const bg = isDark ? '#141414' : '#f4f2ec';
  const idOf = (end: any): string => (typeof end === 'object' ? end?.id : end) || '';

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[1180px] max-w-[96vw] h-[800px] max-h-[92vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-divider flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <BrainCircuit size={16} className="text-app-accent flex-shrink-0" />
            <h3 className="text-[15px] font-semibold text-app-fg truncate">Brain map · {workspaceName}{folderName ? ` › ${folderName}` : ''}</h3>
            <span className="text-[10px] text-app-fg-subtle px-1.5 py-0.5 rounded-full bg-app-chip flex-shrink-0">{folderId ? 'project' : spaceId ? 'space' : 'all projects'}</span>
            {!loading && <span className="text-[11px] text-app-fg-subtle">{data.nodes.length} nodes · {data.links.length} links</span>}
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"><X size={15} /></button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 px-6 py-2.5 border-b border-app-divider text-[11px] text-app-fg-subtle flex-shrink-0 flex-wrap">
          {sources.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="w-2 h-2 rounded-full" style={{ background: srcColor(s), boxShadow: `0 0 6px ${srcColor(s)}80` }} /> {s}
            </span>
          ))}
          {hasVerdicts && (
            <span className="inline-flex items-center gap-3 pl-3 ml-1 border-l border-app-divider">
              <span className="text-app-fg-subtle/80">reasoning:</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-5 h-[2.5px] rounded-full" style={{ background: verdictColor('aligned')!, boxShadow: `0 0 5px ${verdictColor('aligned')}` }} /> aligned</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-5 h-[2.5px] rounded-full" style={{ background: verdictColor('partial')!, boxShadow: `0 0 5px ${verdictColor('partial')}` }} /> partial</span>
              <span className="inline-flex items-center gap-1.5"><span className="w-5 h-[2.5px] rounded-full" style={{ background: verdictColor('divergent')!, boxShadow: `0 0 5px ${verdictColor('divergent')}` }} /> divergent</span>
            </span>
          )}
          <span className="ml-auto text-app-fg-subtle/70">Hover to spotlight a lineage · click a line for its reasoning · click a node for details</span>
        </div>

        <div ref={canvasRef} className="flex-1 relative overflow-hidden" style={{ background: bg }}>
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin text-app-fg-subtle" size={22} /></div>
          ) : data.nodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-app-fg-subtle px-8 text-center">
              {spaceId && !folderId
                ? "This space's brain is empty. Add meetings to the space and connect Jira/GitHub, then let the sync run."
                : "No connected-tool records in this workspace's brain yet. Connect Jira/GitHub and let the sync run."}
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              graphData={graph}
              width={dims.w}
              height={dims.h}
              backgroundColor={bg}
              nodeRelSize={6}
              nodeVal={3}
              // Settle slower so nodes drift apart before locking, then auto-fit the whole graph.
              d3VelocityDecay={0.32}
              cooldownTicks={200}
              warmupTicks={60}
              onEngineStop={() => fgRef.current?.zoomToFit?.(450, 60)}
              minZoom={0.15}
              maxZoom={9}
              linkCurvature={(l: any) => (l.verdict ? 0.08 : 0)}
              linkDirectionalParticles={(l: any) => (l.verdict && focusSet && (focusSet.has(idOf(l.source)) && focusSet.has(idOf(l.target))) ? 3 : 0)}
              linkDirectionalParticleWidth={2}
              linkDirectionalParticleSpeed={0.006}
              linkDirectionalParticleColor={(l: any) => verdictColor(l.verdict) || '#999'}
              onLinkClick={onLinkClick}
              onNodeClick={onNodeClick}
              onNodeHover={(n: any) => setHoverId(n?.id ?? null)}
              onBackgroundClick={() => { setDetail(null); setSelLink(null); }}
              // LINES: reasoning = glowing "synapse" coloured by verdict; structural = quiet
              // dashed thread. Focus-dim fades anything not on the spotlighted lineage.
              linkCanvasObjectMode={() => 'replace'}
              linkCanvasObject={(link: any, ctx: CanvasRenderingContext2D, scale: number) => {
                const a = link.source, b = link.target;
                if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
                // Three honest states: REST (no hover) is calm + readable; a spotlighted
                // lineage is bold + glowing; everything off the lineage fades back.
                const spotlighting = !!focusSet;
                const onLineage = spotlighting && focusSet.has(idOf(a)) && focusSet.has(idOf(b));
                const vCol = verdictColor(link.verdict);
                const cx = (a.x + b.x) / 2, cy = (a.y + b.y) / 2;
                const curv = link.verdict ? 0.08 : 0;   // near-straight, Obsidian-style
                const nx = -(b.y - a.y), ny = (b.x - a.x);
                const mx = cx + nx * curv, my = cy + ny * curv;
                const draw = (w: number) => {
                  ctx.beginPath(); ctx.moveTo(a.x, a.y);
                  if (curv) ctx.quadraticCurveTo(mx, my, b.x, b.y); else ctx.lineTo(b.x, b.y);
                  ctx.lineWidth = w / scale; ctx.stroke();
                };
                ctx.save();
                ctx.lineCap = 'round';
                // SOLID everywhere — no dashes (divergent stays distinct by its red colour).
                if (vCol) {
                  ctx.strokeStyle = vCol;
                  if (onLineage) {
                    ctx.shadowColor = vCol; ctx.shadowBlur = 9 / scale;
                    ctx.globalAlpha = 0.95; draw(2.1);
                    ctx.shadowBlur = 0; ctx.globalAlpha = 1; draw(0.9);     // tight core
                  } else if (spotlighting) {
                    ctx.globalAlpha = 0.08; draw(1);                        // off-lineage — recede
                  } else {
                    ctx.globalAlpha = 0.6; draw(1.2);                       // REST — calm, no glow
                  }
                } else {
                  // structural threads — a solid, clearly legible web (secondary to
                  // reasoning by being thinner + neutral grey, not by being dotted).
                  ctx.strokeStyle = isDark ? 'rgba(150,156,172,1)' : 'rgba(124,116,104,1)';
                  ctx.globalAlpha = onLineage ? 0.65 : spotlighting ? 0.07 : 0.5;
                  draw(0.7);
                }
                ctx.restore();
              }}
              nodeCanvasObjectMode={() => 'replace'}
              nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, scale: number) => {
                if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
                const isAnchor = node.source === 'meeting' || node.source === 'jira';
                const col = nodeColor(node);
                const lit = !focusSet || focusSet.has(node.id);
                const isSel = node.id === selectedId;
                const isHover = node.id === hoverId;
                const r = (isAnchor ? 5 : 3.4) * (isSel || isHover ? 1.25 : 1);
                ctx.save();
                ctx.globalAlpha = lit ? 1 : 0.18;
                // soft radial glow — subtle at rest (keeps dense clusters clean),
                // brighter only for the hovered/selected node.
                const hot = isSel || isHover;
                const glowR = r * (hot ? 2.8 : 1.9);
                const g = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, glowR);
                g.addColorStop(0, `${col}${hot ? 'cc' : '88'}`);
                g.addColorStop(0.5, `${col}${hot ? '33' : '1f'}`);
                g.addColorStop(1, `${col}00`);
                ctx.fillStyle = g;
                ctx.beginPath(); ctx.arc(node.x, node.y, glowR, 0, 2 * Math.PI); ctx.fill();
                // solid core with a thin ring against the canvas so dense areas stay legible
                ctx.beginPath(); ctx.arc(node.x, node.y, r, 0, 2 * Math.PI);
                ctx.fillStyle = col; ctx.fill();
                ctx.lineWidth = 1 / scale; ctx.strokeStyle = bg; ctx.stroke();
                // status ring — live backend state (done = green, in-progress = blue, todo = grey)
                const sRing = statusRing(node.status);
                if (sRing) { ctx.beginPath(); ctx.arc(node.x, node.y, r + 1.6 / scale + 0.8, 0, 2 * Math.PI); ctx.lineWidth = 1.4 / scale; ctx.strokeStyle = sRing; ctx.globalAlpha = lit ? 0.95 : 0.2; ctx.stroke(); ctx.globalAlpha = lit ? 1 : 0.18; }
                if (isSel) { ctx.beginPath(); ctx.arc(node.x, node.y, r + 3.5 / scale + 1.5, 0, 2 * Math.PI); ctx.lineWidth = 1.5 / scale; ctx.strokeStyle = col; ctx.globalAlpha = lit ? 0.9 : 0.3; ctx.stroke(); }
                // labels: anchors when zoomed, or anything in the spotlight
                const showLabel = (isAnchor && scale > 1.3) || (lit && focusSet && (isSel || isHover || isAnchor));
                if (showLabel) {
                  const label = String(node.title || '').slice(0, 28);
                  const fs = Math.max(3.5, 9 / scale);
                  ctx.font = `${(isSel || isHover) ? '600 ' : ''}${fs}px Inter, sans-serif`;
                  ctx.textAlign = 'center'; ctx.textBaseline = 'top';
                  ctx.globalAlpha = lit ? 0.9 : 0.25;
                  ctx.fillStyle = isDark ? 'rgba(235,235,235,0.92)' : 'rgba(40,38,34,0.9)';
                  ctx.fillText(label, node.x, node.y + r + 2 / scale);
                }
                ctx.restore();
              }}
              nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                ctx.beginPath();
                ctx.arc(node.x, node.y, 8, 0, 2 * Math.PI);
                ctx.fillStyle = color;
                ctx.fill();
              }}
              nodeLabel={(n: any) => `[${n.source}] ${n.title}`}
            />
          )}
          {/* Control cluster — live freshness + activity */}
          {!loading && (
            <div className="absolute top-3 right-3 flex items-center gap-1.5">
              {(syncing || lastSync) && (
                <span className="text-[10px] text-app-fg-subtle/80 px-1.5 select-none">
                  {syncing ? 'Syncing…' : `updated ${ago(lastSync)}`}
                </span>
              )}
              <button onClick={() => doSync()} disabled={syncing} title="Sync the latest backend state now"
                className="flex items-center gap-1 text-[11px] px-2 py-1 rounded-md bg-app-canvas/90 border border-app-divider text-app-fg-subtle hover:text-app-fg shadow-sm disabled:opacity-60">
                <RefreshCw size={11} className={syncing ? 'animate-spin' : ''} /> Sync
              </button>
              <button onClick={() => { setAlertsOpen((o) => !o); setPulseOpen(false); }} title="Off-track — what needs attention"
                className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border shadow-sm ${alertsOpen ? 'bg-red-500/15 border-red-500/40 text-red-500' : alerts.length ? 'bg-red-500/10 border-red-500/30 text-red-500' : 'bg-app-canvas/90 border-app-divider text-app-fg-subtle hover:text-app-fg'}`}>
                <AlertTriangle size={11} /> Off-track{alerts.length ? ` · ${alerts.length}` : ''}
              </button>
              <button onClick={() => { setPulseOpen((o) => !o); setAlertsOpen(false); }} title="Activity — who did what, when"
                className={`flex items-center gap-1 text-[11px] px-2 py-1 rounded-md border shadow-sm ${pulseOpen ? 'bg-app-accent/15 border-app-accent/40 text-app-accent' : 'bg-app-canvas/90 border-app-divider text-app-fg-subtle hover:text-app-fg'}`}>
                <Activity size={11} /> Activity{pulse.length ? ` · ${pulse.length}` : ''}
              </button>
              <button onClick={() => fgRef.current?.zoomToFit?.(450, 60)}
                className="text-[11px] px-2 py-1 rounded-md bg-app-canvas/90 border border-app-divider text-app-fg-subtle hover:text-app-fg shadow-sm">
                Fit
              </button>
            </div>
          )}

          {/* Pulse — the who-did-what-when activity feed */}
          {pulseOpen && (
            <div className="absolute left-0 top-0 bottom-0 w-[300px] max-w-[78%] bg-app-canvas/97 border-r border-app-divider shadow-2xl flex flex-col z-20">
              <div className="px-4 py-3 border-b border-app-divider flex items-center gap-2 flex-shrink-0">
                <Activity size={14} className="text-app-accent" />
                <span className="text-[12px] font-semibold text-app-fg">Activity</span>
                <span className="text-[10px] text-app-fg-subtle">who did what, when</span>
                <button onClick={() => setPulseOpen(false)} className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={13} /></button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1">
                {pulse.length === 0 ? (
                  <p className="text-[11px] text-app-fg-subtle px-1 py-3 text-center">No tracked activity yet. State changes (status moves, new commits) appear here as they happen.</p>
                ) : pulse.map((e, i) => (
                  <div key={i} className="flex items-start gap-2 p-2 rounded-lg hover:bg-app-nav-hover-bg/40">
                    <span className="mt-0.5 flex-shrink-0" style={{ color: srcColor(e.source) }}>
                      {e.kind === 'commit' ? <GitCommit size={13} /> : e.kind === 'status_change' ? <ArrowRightLeft size={13} /> : <Activity size={13} />}
                    </span>
                    <div className="min-w-0 flex-1">
                      <div className="text-[11.5px] text-app-fg leading-snug">
                        {e.actor && <span className="font-medium">{e.actor}</span>}{' '}
                        {e.kind === 'commit' ? 'pushed' : e.kind === 'status_change' ? <>moved to <span className="font-medium">{e.to}</span></> : e.kind === 'created' ? 'created' : 'updated'}{' '}
                        <span className="text-app-fg-muted">{(e.title || e.sourceId || '').slice(0, 40)}</span>
                      </div>
                      <div className="text-[9.5px] text-app-fg-subtle mt-0.5">{e.source}{e.from && e.to ? ` · ${e.from} → ${e.to}` : ''} · {ago(e.at)}</div>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Off-track — the leader digest: what needs attention */}
          {alertsOpen && (
            <div className="absolute left-0 top-0 bottom-0 w-[320px] max-w-[80%] bg-app-canvas/97 border-r border-app-divider shadow-2xl flex flex-col z-20">
              <div className="px-4 py-3 border-b border-app-divider flex items-center gap-2 flex-shrink-0">
                <AlertTriangle size={14} className="text-red-500" />
                <span className="text-[12px] font-semibold text-app-fg">Off-track</span>
                <span className="text-[10px] text-app-fg-subtle">what needs attention</span>
                <button onClick={() => setAlertsOpen(false)} className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={13} /></button>
              </div>
              <div className="flex-1 overflow-y-auto px-3 py-2 space-y-1.5">
                {alerts.length === 0 ? (
                  <p className="text-[11px] text-app-fg-subtle px-1 py-3 text-center">Nothing off-track — work aligns with what was decided. ✓</p>
                ) : alerts.map((a, i) => {
                  const c = a.severity === 'high' ? (isDark ? '#e0635c' : '#c44d47') : (isDark ? '#e0a64a' : '#c4862a');
                  const label = a.type === 'divergent' ? 'Divergent' : a.type === 'risk' ? 'Risk' : a.type === 'concern' ? 'Concern' : a.type === 'untracked' ? 'Untracked' : 'Stalled';
                  return (
                    <button key={i} onClick={() => a.url && openUrl(a.url)} className="w-full text-left p-2.5 rounded-lg border" style={{ borderColor: `${c}44`, background: `${c}0f` }}>
                      <div className="flex items-center gap-1.5 mb-0.5">
                        <span className="text-[9px] font-semibold uppercase px-1.5 py-px rounded-full" style={{ background: `${c}22`, color: c }}>{label}</span>
                        <span className="text-[11.5px] font-medium text-app-fg truncate">{a.title}</span>
                      </div>
                      {a.detail && <div className="text-[10.5px] text-app-fg-muted leading-snug line-clamp-3">{a.detail}</div>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          {/* Reasoning panel — what the clicked LINE means */}
          {selLink && (
            <div className="absolute bottom-3 left-3 right-3 max-w-[600px] bg-app-canvas/95 border border-app-divider rounded-xl p-3 shadow-lg">
              <div className="flex items-center gap-2 mb-1.5">
                {selLink.verdict ? (
                  <span className="text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded-full" style={{ background: `${verdictColor(selLink.verdict)}22`, color: verdictColor(selLink.verdict) || '#888' }}>{selLink.verdict}</span>
                ) : (
                  <span className="text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full bg-app-chip text-app-fg-subtle">{selLink.relation || selLink.origin}</span>
                )}
                <span className="text-[12px] font-medium text-app-fg truncate">{titleOf(selLink.source)} → {titleOf(selLink.target)}</span>
                <button onClick={() => setSelLink(null)} className="ml-auto text-app-fg-subtle hover:text-app-fg flex-shrink-0"><X size={13} /></button>
              </div>
              <p className="text-[12px] text-app-fg-muted leading-relaxed">
                {selLink.rationale || (selLink.verdict ? 'Judged but no rationale recorded.' : `${selLink.origin} link (${selLink.relation}) — no reasoning verdict on this connection.`)}
              </p>
            </div>
          )}

          {/* Node detail — a rich info card (content + reasoned connections), like the KG */}
          {detail && (() => {
            const n = detail.node;
            const isCommit = n.type === 'commit';
            const ppl = peopleLine(n.people);
            const when = n.occurredAt ? new Date(n.occurredAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
            return (
              <div className="absolute right-0 top-0 bottom-0 w-[340px] max-w-[80%] bg-app-canvas border-l border-app-divider shadow-2xl flex flex-col z-10 animate-[slideIn_.18s_ease-out]">
                <div className="px-4 py-3 border-b border-app-divider flex items-center gap-2 flex-shrink-0">
                  <span className="w-2.5 h-2.5 rounded-full flex-shrink-0" style={{ background: nodeColor(n) }} />
                  <span className="text-[10px] font-semibold uppercase tracking-wider text-app-fg-subtle">{n.source}{n.type ? ` · ${n.type}` : ''}</span>
                  {n.status && (
                    <span className="text-[10px] font-medium px-1.5 py-0.5 rounded-full inline-flex items-center gap-1" style={{ background: `${statusRing(n.status)}1f`, color: statusRing(n.status) || undefined }}>
                      <span className="w-1.5 h-1.5 rounded-full" style={{ background: statusRing(n.status) || undefined }} />{n.status}
                    </span>
                  )}
                  <button onClick={() => setDetail(null)} className="ml-auto w-6 h-6 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={14} /></button>
                </div>

                <div className="flex-1 overflow-y-auto px-4 py-3.5 space-y-3.5">
                  <h4 className="text-[14px] font-semibold text-app-fg leading-snug">{n.title}</h4>

                  {/* Meta */}
                  <div className="space-y-1.5 text-[11.5px] text-app-fg-muted">
                    {ppl && <div className="flex items-start gap-1.5"><Users size={12} className="mt-0.5 flex-shrink-0 text-app-fg-subtle" /><span className="break-words">{ppl}</span></div>}
                    {when && <div className="flex items-center gap-1.5"><Calendar size={12} className="flex-shrink-0 text-app-fg-subtle" />{when}</div>}
                    {n.sourceId && <div className="flex items-center gap-1.5"><GitCommitHorizontal size={12} className="flex-shrink-0 text-app-fg-subtle" /><span className="font-mono text-[10.5px] truncate">{n.sourceId}</span></div>}
                  </div>

                  {/* Content — for commits this is the DIFF-grounded summary, not the fluff message */}
                  {n.summary && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-app-fg-subtle mb-1">{isCommit ? 'What the code changed' : 'Content'}</div>
                      <p className="text-[12px] text-app-fg-muted leading-relaxed whitespace-pre-wrap break-words max-h-44 overflow-y-auto">{n.summary.slice(0, 1200)}</p>
                    </div>
                  )}

                  {/* Co-architect advisory — the brain's read on the code (diff-grounded) */}
                  {n.advisoryAssessment && (() => {
                    const aCol = n.advisoryAssessment === 'sound' ? (isDark ? '#46c98c' : '#2f9e6b') : n.advisoryAssessment === 'risk' ? (isDark ? '#e0635c' : '#c44d47') : (isDark ? '#e0a64a' : '#c4862a');
                    return (
                      <div className="rounded-lg border p-2.5" style={{ borderColor: `${aCol}55`, background: `${aCol}12` }}>
                        <div className="flex items-center gap-1.5 mb-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: aCol }}>Architectural insight</span>
                          <span className="text-[9px] font-semibold uppercase px-1.5 py-px rounded-full" style={{ background: `${aCol}22`, color: aCol }}>{n.advisoryAssessment}</span>
                        </div>
                        <p className="text-[11.5px] text-app-fg-muted leading-relaxed">{n.advisoryNote || (n.advisoryAssessment === 'sound' ? 'No concerns — the change is well-structured.' : '')}</p>
                      </div>
                    );
                  })()}

                  {/* Connections — the reasoned lineage, the highly-important part */}
                  <div>
                    <div className="text-[10px] font-semibold uppercase tracking-wider text-app-fg-subtle mb-1.5">
                      Connections {detail.connections.length > 0 && <span className="text-app-fg-subtle/70">· {detail.connections.length}</span>}
                    </div>
                    {detailLoading && detail.connections.length === 0 ? (
                      <div className="flex items-center gap-2 text-[11px] text-app-fg-subtle py-2"><Loader2 size={13} className="animate-spin" /> Loading…</div>
                    ) : detail.connections.length === 0 ? (
                      <p className="text-[11px] text-app-fg-subtle py-1">No links yet — the brain is still associating this item.</p>
                    ) : (
                      <div className="space-y-1.5">
                        {detail.connections.map((c, i) => (
                          <button key={i} onClick={() => loadNode(c.id, c.title, c.source)}
                            className="w-full text-left p-2 rounded-lg border border-app-divider hover:border-app-fg-subtle/40 hover:bg-app-nav-hover-bg/50 transition-colors">
                            <div className="flex items-center gap-1.5 mb-0.5">
                              {c.direction === 'out' ? <ArrowRight size={11} className="text-app-fg-subtle flex-shrink-0" /> : <ArrowLeft size={11} className="text-app-fg-subtle flex-shrink-0" />}
                              <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: nodeColor(c) }} />
                              {c.verdict && <span className="text-[9px] font-semibold uppercase px-1.5 py-px rounded-full" style={{ background: `${verdictColor(c.verdict)}22`, color: verdictColor(c.verdict) || '#888' }}>{c.verdict}</span>}
                              <span className="text-[9px] text-app-fg-subtle">{c.relation}</span>
                            </div>
                            <div className="text-[11.5px] font-medium text-app-fg truncate">{c.title}</div>
                            {c.rationale && <div className="text-[10.5px] text-app-fg-muted leading-snug mt-0.5 line-clamp-3">{c.rationale}</div>}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* Timeline — observed state changes for this item (who moved it when) */}
                  {Array.isArray(detail.events) && detail.events.length > 0 && (
                    <div>
                      <div className="text-[10px] font-semibold uppercase tracking-wider text-app-fg-subtle mb-1.5">Timeline</div>
                      <div className="space-y-1">
                        {detail.events.map((ev, i) => (
                          <div key={i} className="flex items-center gap-1.5 text-[11px] text-app-fg-muted">
                            <span className="w-1.5 h-1.5 rounded-full flex-shrink-0" style={{ background: ev.kind === 'status_change' ? (statusRing(ev.to) || '#888') : srcColor(n.source) }} />
                            <span className="text-app-fg">{ev.actor || 'someone'}</span>
                            {ev.kind === 'status_change' ? <>moved to <span className="font-medium">{ev.to}</span></> : ev.kind === 'commit' ? 'pushed' : 'updated'}
                            <span className="ml-auto text-app-fg-subtle text-[10px] flex-shrink-0">{ago(ev.at)}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>

                {n.url && (
                  <div className="px-4 py-3 border-t border-app-divider flex-shrink-0">
                    <button onClick={() => openUrl(n.url)}
                      className="w-full flex items-center justify-center gap-1.5 text-[12px] font-medium px-3 py-2 rounded-lg bg-app-accent/10 text-app-accent hover:bg-app-accent/20 transition-colors">
                      <ExternalLink size={13} /> Open in {n.source}
                    </button>
                  </div>
                )}
              </div>
            );
          })()}
        </div>
      </div>
    </div>
  );
}
