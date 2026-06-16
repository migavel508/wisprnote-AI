import { useEffect, useMemo, useRef, useState } from 'react';
import ForceGraph2D from 'react-force-graph-2d';
import { X, Loader2, BrainCircuit } from 'lucide-react';
import { getBrainGraph, type BrainNode, type BrainLink } from '../services/brainService';

/**
 * The Living-Brain map — one graph across all sources. Nodes coloured by source
 * (meeting / jira / github / …), edges = cross-source associations (related / references
 * / spawned). Clicking a node opens it in its tool. Read-only visualization of brain_edge.
 */

const SOURCE_COLOR: Record<string, string> = {
  meeting: '#819C1F',  // brand green
  jira: '#2684FF',     // atlassian blue
  github: '#8957e5',   // github violet
};
const colorFor = (s: string) => SOURCE_COLOR[s] || '#9ca3af';

export default function BrainMapModal({ workspaceId, workspaceName, onClose }: { workspaceId: string; workspaceName: string; onClose: () => void }) {
  const [data, setData] = useState<{ nodes: BrainNode[]; links: BrainLink[] }>({ nodes: [], links: [] });
  const [loading, setLoading] = useState(true);
  const fgRef = useRef<any>(null);

  useEffect(() => {
    let cancelled = false;
    getBrainGraph(workspaceId)
      .then((g) => { if (!cancelled) setData(g); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Show connected nodes first; keep isolated ones too but they drift to the edge.
  const graph = useMemo(() => ({ nodes: data.nodes.map((n) => ({ ...n })), links: data.links.map((l) => ({ ...l })) }), [data]);
  const sources = useMemo(() => Array.from(new Set(data.nodes.map((n) => n.source))), [data.nodes]);

  const openNode = (n: any) => {
    if (!n?.url) return;
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
    if (isTauri) import('@tauri-apps/plugin-shell').then(({ open }) => open(n.url)).catch(() => window.open(n.url, '_blank'));
    else window.open(n.url, '_blank');
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[860px] max-w-[94vw] h-[640px] max-h-[88vh] flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-6 py-4 border-b border-app-divider flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <BrainCircuit size={16} className="text-app-accent flex-shrink-0" />
            <h3 className="text-[15px] font-semibold text-app-fg truncate">Brain map · {workspaceName}</h3>
            {!loading && <span className="text-[11px] text-app-fg-subtle">{data.nodes.length} nodes · {data.links.length} links</span>}
          </div>
          <button onClick={onClose} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"><X size={15} /></button>
        </div>

        {/* Legend */}
        <div className="flex items-center gap-4 px-6 py-2 border-b border-app-divider text-[11px] text-app-fg-subtle flex-shrink-0">
          {sources.map((s) => (
            <span key={s} className="inline-flex items-center gap-1.5">
              <span className="w-2.5 h-2.5 rounded-full" style={{ background: colorFor(s) }} /> {s}
            </span>
          ))}
          <span className="ml-auto">Click a node to open it in its tool · edges = cross-source links</span>
        </div>

        <div className="flex-1 relative bg-app-panel/30">
          {loading ? (
            <div className="absolute inset-0 flex items-center justify-center"><Loader2 className="animate-spin text-app-fg-subtle" size={22} /></div>
          ) : data.nodes.length === 0 ? (
            <div className="absolute inset-0 flex items-center justify-center text-[13px] text-app-fg-subtle px-8 text-center">
              No connected-tool records in this workspace's brain yet. Connect Jira/GitHub and let the sync run.
            </div>
          ) : (
            <ForceGraph2D
              ref={fgRef}
              graphData={graph}
              width={860}
              height={520}
              backgroundColor="rgba(0,0,0,0)"
              nodeRelSize={5}
              nodeColor={(n: any) => colorFor(n.source)}
              nodeLabel={(n: any) => `[${n.source}] ${n.title}`}
              linkColor={() => 'rgba(120,120,120,0.25)'}
              linkWidth={(l: any) => (l.origin === 'provenance' || l.origin === 'reference' ? 1.6 : 0.6)}
              linkDirectionalParticles={1}
              linkDirectionalParticleWidth={1.6}
              onNodeClick={openNode}
              cooldownTicks={120}
            />
          )}
        </div>
      </div>
    </div>
  );
}
