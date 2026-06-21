import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('KnowledgePage');
const env = (import.meta as any).env || {};
import { motion, AnimatePresence } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { 
  Search,
  Loader2,
  X, 
  Network, 
  Layout, 
  MessageSquare, 
  Users, 
  CheckCircle2, 
  Share2, 
  ChevronRight,
  Presentation,
  Clock,
  Sparkles,
  Filter,
  ZoomIn,
  ZoomOut,
  Maximize2,
  LayoutGrid,
  List,
  Crosshair,
  PanelLeftClose,
} from 'lucide-react';
import { KnowledgeGraphSkeleton } from '../components/Skeleton';
import {
  type KGBuildArtifact,
  type MeetingEdge,
  type MeetingRecord,
  buildKnowledgeGraphPipeline,
  buildGraphData as buildGraphDataUtil,
  findRelatedMeetings as findRelatedMeetingsUtil,
  searchNodes,
} from '../lib/knowledgeGraph.utils';
import { buildFingerprint, loadCachedArtifact, saveCachedArtifact } from '../lib/kgArtifactCache';
import { useTheme } from '../theme/ThemeProvider';
import { getWorkspaces } from '../services/workspaceService';
import { getWorkspaceKnowledgeGraph, getKnowledgeGraphEdges } from '../services/awsService';
import { isServerKgEnabled, buildArtifactFromServerEdges } from '../lib/serverKgGraph';

/**
 * Lightweight collision force (no extra dependency). Each tick it relaxes
 * overlapping nodes apart, so the layout self-organises with even spacing and
 * non-overlapping labels — the clean, "tree-forming" look of Obsidian's graph.
 * O(n²) per tick, which is fine for the tens–low-hundreds of nodes here.
 */
function makeCollideForce(radius: (n: any) => number, strength = 0.7) {
  let nodes: any[] = [];
  const force = () => {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      const ra = radius(a);
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = (b.x ?? 0) - (a.x ?? 0);
        const dy = (b.y ?? 0) - (a.y ?? 0);
        const dist = Math.sqrt(dx * dx + dy * dy) || 0.01;
        const min = ra + radius(b);
        if (dist < min) {
          const push = ((min - dist) / dist) * strength * 0.5;
          const ox = dx * push, oy = dy * push;
          a.x -= ox; a.y -= oy;
          b.x += ox; b.y += oy;
        }
      }
    }
  };
  (force as any).initialize = (n: any[]) => { nodes = n; };
  return force;
}

interface KnowledgePageProps {
  kgData: any[];
  isLoadingKG: boolean;
  kgProgress: { current: number; total: number };
  isExtractingNewKG: boolean;
  kgBuilt: boolean;
  buildKnowledgeGraph: () => void;
  historyLength: number;
  isInitialLoading?: boolean;
  onReExtractMeeting?: (meetingId: string) => Promise<void>;
}

export default function KnowledgePage({
  kgData: kgDataAll,
  isLoadingKG,
  kgProgress,
  isExtractingNewKG,
  kgBuilt,
  buildKnowledgeGraph,
  historyLength,
  isInitialLoading = false,
  onReExtractMeeting,
}: KnowledgePageProps) {
  const { resolved: themeResolved } = useTheme();
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);
  /** meetings-only graph vs full detail (topics, people, …) */
  const [graphViewMode, setGraphViewMode] = useState<'overview' | 'full'>('overview');
  // task_ids whose server-side KG pipeline hasn't finished — drives the "Analysing…" badge.
  const [processingMeetings, setProcessingMeetings] = useState<string[]>([]);
  /** show 1-hop neighborhood of selected node */
  const [egoFocus, setEgoFocus] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [browsePanelOpen, setBrowsePanelOpen] = useState(false);
  const [kgDimensions, setKgDimensions] = useState({ width: 800, height: 600 });
  const shouldAutoFitRef = useRef(true);
  const pendingFocusIdRef = useRef<string | null>(null);

  const kgContainerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  /** Kept in React state (not a ref) so graph data / related-meeting chips re-render when cache or pipeline finishes. */
  const [kgBuildArtifact, setKgBuildArtifact] = useState<KGBuildArtifact | null>(null);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [embedProgress, setEmbedProgress] = useState({ current: 0, total: 3 });
  const [isReExtracting, setIsReExtracting] = useState(false);

  // Handle container resize
  useEffect(() => {
    if (!kgContainerRef.current) return;

    const observer = new ResizeObserver(entries => {
      requestAnimationFrame(() => {
        for (let entry of entries) {
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            setKgDimensions({ width, height });
          }
        }
      });
    });

    observer.observe(kgContainerRef.current);
    return () => observer.disconnect();
  }, [kgBuilt]);

  // ── Workspace scoping ───────────────────────────────────────────────────────
  // The graph can be filtered to a single workspace. null = "All meetings".
  // Because the build pipeline + artifact cache are keyed by the meeting-id set
  // (kgDataKey below), simply filtering the meetings here scopes everything
  // downstream — each workspace gets its own cached graph automatically.
  const [workspaces, setWorkspaces] = useState<{ id: string; name: string }[]>([]);
  const [selectedWsId, setSelectedWsId] = useState<string | null>(null);
  const [wsTaskIds, setWsTaskIds] = useState<Set<string> | null>(null);
  const [wsLoading, setWsLoading] = useState(false);

  // Load the workspace list for the scope selector.
  useEffect(() => {
    let cancelled = false;
    getWorkspaces()
      .then((ws) => { if (!cancelled) setWorkspaces(ws.map((w) => ({ id: w.id, name: w.name }))); })
      .catch(() => { /* selector just shows "All meetings" */ });
    return () => { cancelled = true; };
  }, []);

  // When a workspace is picked, load the set of meeting (task) ids in it.
  useEffect(() => {
    if (!selectedWsId) { setWsTaskIds(null); return; }
    let cancelled = false;
    setWsLoading(true);
    getWorkspaceKnowledgeGraph(selectedWsId)
      .then((entries) => { if (!cancelled) setWsTaskIds(new Set(entries.map((e) => e.task_id))); })
      .catch(() => { if (!cancelled) setWsTaskIds(new Set()); })
      .finally(() => { if (!cancelled) setWsLoading(false); });
    return () => { cancelled = true; };
  }, [selectedWsId]);

  // Effective graph data: all meetings, or only those in the selected workspace.
  const kgData = useMemo(() => {
    if (!selectedWsId) return kgDataAll;
    if (!wsTaskIds) return [];                 // workspace selected, still loading
    return kgDataAll.filter((m: any) => wsTaskIds.has(m.meetingId));
  }, [kgDataAll, selectedWsId, wsTaskIds]);

  // Compute a stable data fingerprint so we can detect actual data changes
  const kgDataKey = useMemo(() => {
    if (kgData.length === 0) return '';
    return kgData.map((m: any) => m.meetingId).sort().join(',');
  }, [kgData]);

  // Fingerprint of the kgData the last artifact was built from
  const lastBuildKeyRef = useRef('');
  const kgDataKeyRef = useRef(kgDataKey);
  kgDataKeyRef.current = kgDataKey;

  // Clear the artifact when a rebuild is initiated (kgBuilt goes false)
  useEffect(() => {
    if (!kgBuilt) {
      setKgBuildArtifact(null);
      lastBuildKeyRef.current = '';
    }
  }, [kgBuilt]);

  // Embedding pipeline: runs once when kgData is available after extraction.
  // Checks IndexedDB artifact cache first — if fingerprint matches, hydrates
  // instantly (zero API calls). Otherwise runs the full pipeline and caches result.
  //
  // Do NOT gate on `isEmbedding` — React Strict Mode cancels the first in-flight run
  // while leaving isEmbedding=true, which would permanently skip this effect before
  // we ever hydrate the cached artifact or reset isEmbedding=false.
  useEffect(() => {
    if (!kgBuilt || kgData.length === 0) return;
    if (lastBuildKeyRef.current === kgDataKey) return;

    const snapshotKey = kgDataKey;
    let cancelled = false;
    const run = async () => {
      setIsEmbedding(true);
      setEmbedProgress({ current: 0, total: 3 });

      const fingerprint = buildFingerprint(kgData.map((m: any) => m.meetingId));

      try {
        // Server-side render path (opt-in, VITE_SERVER_KG_GRAPH=1): use the
        // precomputed edges from the cloud pipeline — ZERO client embedding/LLM
        // work. Falls through to the client pipeline below if unavailable, so
        // nothing breaks when the flag is off or the fetch fails.
        if (isServerKgEnabled()) {
          const server = await getKnowledgeGraphEdges();
          if (server && !cancelled && snapshotKey === kgDataKeyRef.current) {
            const artifact = buildArtifactFromServerEdges(kgData as MeetingRecord[], server.edges);
            setKgBuildArtifact(artifact);
            lastBuildKeyRef.current = snapshotKey;
            setProcessingMeetings(server.processing || []);
            log.info('kg_server_render', { meetings: kgData.length, edges: server.edges.length, processing: server.processing?.length || 0 });
            return;
          }
        }

        // Try IndexedDB artifact cache first — instant render, zero API calls
        const cached = await loadCachedArtifact(fingerprint);
        if (cached && !cancelled) {
          if (snapshotKey === kgDataKeyRef.current) {
            setKgBuildArtifact(cached);
            lastBuildKeyRef.current = snapshotKey;
            log.info('artifact_cache_hit_render', { meetings: kgData.length });
          }
          return;
        }

        // Cache miss — run full pipeline
        const artifact = await buildKnowledgeGraphPipeline(
          kgData as MeetingRecord[],
          (current, total) => {
            if (!cancelled) setEmbedProgress({ current, total });
          }
        );
        if (!cancelled && snapshotKey === kgDataKeyRef.current) {
          setKgBuildArtifact(artifact);
          lastBuildKeyRef.current = snapshotKey;
          // Persist to IndexedDB so next load is instant
          saveCachedArtifact(fingerprint, artifact).catch(err =>
            log.warn('artifact_cache_save_failed', { error: err instanceof Error ? err : undefined })
          );
        }
      } catch (err) {
        log.error('embedding_pipeline_failed', { error: err instanceof Error ? err : undefined });
      } finally {
        if (!cancelled) setIsEmbedding(false);
      }
    };
    void run();
    return () => { cancelled = true; };
  }, [kgBuilt, kgDataKey]);

  // Build graph data using the artifact from the embedding pipeline
  // Falls back to a basic graph (no embedding features) while pipeline runs
  const graphData = useMemo(() => {
    if (kgData.length === 0) return { nodes: [], links: [] };

    if (kgBuildArtifact) {
      return buildGraphDataUtil(
        kgData as MeetingRecord[],
        kgBuildArtifact.embeddings,
        kgBuildArtifact.meetingEdgeMatrix,
        kgBuildArtifact.relationships,
        filterType
      );
    }

    // Fallback: build a basic graph from raw kgData without embeddings
    return buildGraphDataUtil(
      kgData as MeetingRecord[],
      new Map(),
      new Map(),
      [],
      filterType
    );
  }, [kgDataKey, filterType, kgBuildArtifact]);

  /** Subset / mode passed to ForceGraph — reduces clutter (overview) and optional ego network */
  const displayGraphData = useMemo(() => {
    let g = graphData;

    if (graphViewMode === 'overview') {
      const meetingNodes = g.nodes.filter((n: any) => n.type === 'meeting');
      const mIds = new Set(meetingNodes.map((n: any) => n.id));
      const meetingLinks = g.links.filter((l: any) => {
        if (l.type !== 'meeting-sibling') return false;
        const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
        return mIds.has(s) && mIds.has(t);
      });
      g = { nodes: meetingNodes, links: meetingLinks };
    }

    if (egoFocus && selectedNode?.id) {
      const selId = selectedNode.id as string;
      const keep = new Set<string>([selId]);
      g.links.forEach((l: any) => {
        const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
        const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
        if (s === selId || t === selId) {
          keep.add(s);
          keep.add(t);
        }
      });
      g = {
        nodes: g.nodes.filter((n: any) => keep.has(n.id)),
        links: g.links.filter((l: any) => {
          const s = typeof l.source === 'object' ? (l.source as any).id : l.source;
          const t = typeof l.target === 'object' ? (l.target as any).id : l.target;
          return keep.has(s) && keep.has(t);
        }),
      };
    }

    return g;
  }, [graphData, graphViewMode, egoFocus, selectedNode?.id]);

  /** Focus set: the hovered OR selected node + its direct neighbours. Hovering
      previews; clicking pins the focus. Used to light up the focused node's
      connections in accent and fade the rest of the graph (Obsidian-style), so
      structure is readable instead of a congested web. */
  const focus = useMemo(() => {
    const focusId = (hoveredNode?.id || selectedNode?.id) as string | undefined;
    if (!focusId) return null;
    const set = new Set<string>([focusId]);
    displayGraphData.links.forEach((l: any) => {
      const a = typeof l.source === 'object' ? (l.source as any).id : l.source;
      const b = typeof l.target === 'object' ? (l.target as any).id : l.target;
      if (a === focusId) set.add(b);
      if (b === focusId) set.add(a);
    });
    return { id: focusId, set };
  }, [hoveredNode?.id, selectedNode?.id, displayGraphData]);

  const meetingNodesSorted = useMemo(() => {
    return graphData.nodes
      .filter((n: any) => n.type === 'meeting')
      .slice()
      .sort((a: any, b: any) => {
        const dateA = a.data?.meetingDate ? new Date(a.data.meetingDate).getTime() : 0;
        const dateB = b.data?.meetingDate ? new Date(b.data.meetingDate).getTime() : 0;
        if (dateB !== dateA) return dateB - dateA; // newest first
        return (a.label || '').localeCompare(b.label || '');
      });
  }, [graphData]);

  useEffect(() => {
    shouldAutoFitRef.current = true;
  }, [kgDataKey, filterType, graphViewMode, egoFocus, selectedNode?.id, kgBuildArtifact]);

  useEffect(() => {
    const raf0 = requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        const g = graphRef.current;
        if (!g) return;
        // Obsidian-style "brain" layout: strong repulsion + long links + generous
        // collision → wide, breathable spacing instead of a congested hairball.
        const charge = g.d3Force('charge');
        if (charge) {
          charge.strength(-720);
          charge.distanceMax?.(900); // let repulsion reach across clusters so they separate
        }
        const linkF = g.d3Force('link');
        if (linkF) {
          linkF.strength(0.16); // weaker pull so repulsion can spread the graph out
          linkF.distance((link: any) => {
            if (link.type === 'meeting-sibling') return 280;
            if (link.type === 'meeting-topic') return 120;
            if (link.type?.startsWith?.('meeting-')) return 92;
            return 70;
          });
        }
        // Collision spacing → even, non-overlapping layout (Obsidian-style).
        g.d3Force('collide', makeCollideForce((n: any) =>
          n.type === 'meeting' ? 36 : n.type === 'topic' ? 22 : 16));
        g.d3ReheatSimulation?.();
      });
    });
    return () => cancelAnimationFrame(raf0);
  }, [displayGraphData]);

  // Search functionality
  const handleSearch = useCallback((query: string) => {
    setSearchQuery(query);
    if (!query.trim()) {
      setSearchResults([]);
      return;
    }
    setIsSearching(true);
    setSearchResults(searchNodes(query, graphData.nodes));
    setIsSearching(false);
  }, [graphData]);

  // Focus on a node from search (center after sim settles in onEngineStop)
  const focusOnNode = (node: any) => {
    if (node.type !== 'meeting') {
      setGraphViewMode('full');
    }
    setSelectedNode(node);
    setSearchQuery('');
    setSearchResults([]);
    setBrowsePanelOpen(false);
    pendingFocusIdRef.current = node.id;
  };

  // O(1) related meetings lookup from pre-built edge matrix
  const findRelatedMeetings = useCallback((meetingId: string): MeetingEdge[] => {
    if (!kgBuildArtifact) return [];
    return findRelatedMeetingsUtil(meetingId, kgBuildArtifact.meetingEdgeMatrix);
  }, [kgBuildArtifact]);

  // Expandable Meeting Card Component — now receives MeetingEdge
  const ExpandableMeetingCard = ({ related, idx }: { related: MeetingEdge, idx: number }) => {
    const [isExpanded, setIsExpanded] = useState(false);
    const relatedMeetingData = related.meeting;
    if (!relatedMeetingData) return null;

    const REL_BADGE_COLORS: Record<string, string> = {
      continuation: 'bg-blue-100 text-blue-700',
      resolution: 'bg-green-100 text-green-700',
      escalation: 'bg-red-100 text-red-700',
      recurring: 'bg-amber-100 text-amber-700',
      reference: 'bg-purple-100 text-purple-700',
    };
    
    return (
      <div key={idx} className="bg-app-raised border border-app-border rounded-xl overflow-hidden transition-all duration-300 hover:border-kg-accent-border hover:shadow-md">
        {/* Collapsed Header (Always visible) */}
        <div 
          className="p-3.5 flex items-center justify-between cursor-pointer hover:bg-app-chip transition-colors group"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-bold text-app-fg truncate group-hover:text-kg-accent transition-colors">
                {relatedMeetingData.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
              </span>
              <span className="text-[9px] px-2 py-0.5 bg-kg-accent-soft text-kg-accent rounded-lg font-mono shrink-0 font-medium">
                {related.totalScore.toFixed(1)} pts
              </span>
            </div>
            <div className="text-[10px] text-app-fg-subtle truncate flex items-center gap-1.5 flex-wrap">
              {related.relationships.length > 0 ? related.relationships.map((r, rIdx) => (
                <span key={rIdx} className={`text-[8px] px-1.5 py-0.5 rounded-lg font-mono ${REL_BADGE_COLORS[r.relationshipType] || 'bg-app-chip text-app-fg-muted'}`}>
                  {r.relationshipType}
                </span>
              )) : (
                <span className="text-[8px] px-1.5 py-0.5 rounded-lg font-mono bg-kg-accent-soft text-kg-accent">
                  similar content
                </span>
              )}
              {related.embeddingScore > 0 && (
                <span className="flex items-center gap-1 bg-app-chip px-1.5 py-0.5 rounded-lg text-app-fg-muted">
                  sim: {(related.embeddingScore * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
          <div className={`shrink-0 p-1.5 rounded-lg text-kg-accent shadow-sm transition-transform duration-300 ${isExpanded ? '-rotate-90 bg-kg-accent-soft' : 'rotate-90 bg-app-chip'}`}>
            <ChevronRight className="w-3.5 h-3.5" />
          </div>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="p-3 pt-0 border-t border-app-border bg-app-panel/40">
            <div className="pt-3">
              {/* Contextual Relationships */}
              {related.relationships.length > 0 ? (
                <div className="mb-3 space-y-1.5">
                  <span className="text-[9px] font-mono uppercase text-kg-accent block mb-2 flex items-center gap-1">
                    <Share2 className="w-3 h-3" />
                    Why Connected:
                  </span>
                  {related.relationships.map((r, rIdx) => (
                    <div key={rIdx} className="p-2 bg-app-raised rounded-lg border border-app-border">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[8px] px-1.5 py-0.5 rounded-lg font-mono font-medium ${REL_BADGE_COLORS[r.relationshipType] || 'bg-app-chip text-app-fg-muted'}`}>
                          {r.relationshipType}
                        </span>
                        <span className="text-[8px] text-app-fg-subtle font-mono">{r.confidence}</span>
                      </div>
                      <p className="text-[10px] text-app-fg-muted">{r.sharedThread || 'Related by shared context'}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mb-3 p-2 bg-kg-accent-soft rounded-lg border border-kg-accent-border">
                  <span className="text-[9px] font-mono uppercase text-kg-accent block mb-1 flex items-center gap-1">
                    <Share2 className="w-3 h-3" />
                    Why Connected:
                  </span>
                  <p className="text-[10px] text-app-fg">
                    {(() => {
                      const currentTopics = (selectedNode?.data?.topics || []).map((t: any) => t.name?.toLowerCase()).filter(Boolean);
                      const relatedTopics = (relatedMeetingData.topics || []).map((t: any) => t.name?.toLowerCase()).filter(Boolean);
                      const shared = currentTopics.filter((t: string) => relatedTopics.some((rt: string) => rt.includes(t) || t.includes(rt)));
                      if (shared.length > 0) {
                        return `Shares ${shared.length} common topic${shared.length > 1 ? 's' : ''}: ${(relatedMeetingData.topics || []).filter((t: any) => shared.some((s: string) => t.name?.toLowerCase().includes(s) || s.includes(t.name?.toLowerCase()))).map((t: any) => t.name).join(', ')}`;
                      }
                      const currentPeople = (selectedNode?.data?.people || []).map((p: string) => p.toLowerCase());
                      const relatedPeople = (relatedMeetingData.people || []).map((p: string) => p.toLowerCase());
                      const sharedPeople = currentPeople.filter((p: string) => relatedPeople.includes(p));
                      if (sharedPeople.length > 0) {
                        return `${sharedPeople.length} shared participant${sharedPeople.length > 1 ? 's' : ''}: ${(relatedMeetingData.people || []).filter((p: string) => sharedPeople.includes(p.toLowerCase())).join(', ')}`;
                      }
                      return `Semantically similar content (${(related.embeddingScore * 100).toFixed(0)}% match)`;
                    })()}
                  </p>
                </div>
              )}
              
              {/* What Was Discussed in That Meeting - All Topics */}
              {(() => {
                const validRelTopics = (relatedMeetingData.topics || []).filter((t: any) => t?.name?.trim());
                if (validRelTopics.length === 0) return null;
                return (
                <div className="mb-3">
                  <span className="text-[9px] font-mono uppercase text-app-fg-subtle block mb-2 flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    What Was Discussed:
                  </span>
                  <div className="space-y-1.5">
                    {validRelTopics.map((topic: any, tIdx: number) => (
                      <div key={tIdx} className="p-2 rounded-lg bg-app-chip">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-[10px] font-semibold text-app-fg">
                            {topic.name}
                          </span>
                          <span className={`text-[8px] px-1 py-0.5 rounded-lg font-mono shrink-0 ${
                            topic.status === 'resolved' ? 'bg-green-100 text-green-700' :
                            topic.status === 'off-track' ? 'bg-red-100 text-red-700' :
                            topic.status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                            topic.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                          }`}>{topic.status}</span>
                        </div>
                        {topic.summary && <p className="text-[9px] text-app-fg-muted leading-relaxed line-clamp-2 hover:line-clamp-none transition-all">"{topic.summary}"</p>}
                      </div>
                    ))}
                  </div>
                </div>
                );
              })()}
              
              {/* Decisions and Actions */}
              <div className="grid grid-cols-1 gap-2 mt-3">
                {(relatedMeetingData.decisions || []).length > 0 && (
                  <div className="bg-app-raised rounded-lg p-2 border border-app-border">
                    <span className="text-[9px] font-mono uppercase text-app-fg-subtle block mb-1">Decisions</span>
                    <ul className="space-y-1">
                      {(relatedMeetingData.decisions || []).slice(0, 2).map((dec: any, dIdx: number) => (
                        <li key={dIdx} className="text-[9px] text-app-fg-muted truncate">• {dec.decision}</li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {(relatedMeetingData.actionItems || []).length > 0 && (
                  <div className="bg-app-raised rounded-lg p-2 border border-app-border">
                    <span className="text-[9px] font-mono uppercase text-app-fg-subtle block mb-1">Actions</span>
                    <ul className="space-y-1">
                      {(relatedMeetingData.actionItems || []).slice(0, 2).map((action: any, aIdx: number) => (
                        <li key={aIdx} className="text-[9px] text-app-fg-muted truncate">
                          <span className="font-medium">{action.owner}:</span> {action.task}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}
      </div>
    );
  };

  // Node type colors for legend
  const nodeTypes = [
    { type: 'meeting', color: '#475569', label: 'Meeting', shape: 'large' },
    { type: 'topic', color: '#8b5cf6', label: 'Topic', shape: 'medium' },
    { type: 'person', color: '#06b6d4', label: 'Person', shape: 'small' },
    { type: 'decision', color: '#f59e0b', label: 'Decision', shape: 'small' },
    { type: 'action', color: '#ec4899', label: 'Action', shape: 'small' }
  ];

  // Show skeleton during initial data loading
  if (isInitialLoading) {
    return <KnowledgeGraphSkeleton />;
  }

  return (
    <div className="absolute inset-0 flex flex-col bg-app-panel text-app-fg overflow-hidden">
      {/* Header */}
      <div className="flex-none bg-app-panel border-b border-app-border px-3 sm:px-6 py-2.5 sm:py-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-base sm:text-xl font-serif font-semibold flex items-center gap-1.5 sm:gap-2">
              <Network className="w-4 sm:w-5 h-4 sm:h-5 flex-shrink-0" />
              <span className="truncate">Knowledge Graph</span>
            </h2>
            <p className="text-[10px] sm:text-xs text-app-fg-subtle mt-0.5 hidden sm:block">Cross-meeting memory — see how topics, decisions, and people connect</p>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto">
            {/* Search - Hidden on mobile, shown as icon */}
            <div className="relative hidden sm:block">
              <div className="flex items-center gap-2 border border-app-border bg-app-raised px-3 py-2 rounded-lg w-48 lg:w-64 focus-within:border-kg-accent transition-colors">
                <Search className="w-4 h-4 text-app-fg-subtle" />
                <input
                  type="text"
                  placeholder="Search nodes…"
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="bg-transparent border-none outline-none text-sm w-full text-app-fg placeholder:text-app-fg-subtle"
                />
                {searchQuery && (
                  <button onClick={() => { setSearchQuery(''); setSearchResults([]); }}>
                    <X className="w-3 h-3 text-app-fg-subtle hover:text-app-fg" />
                  </button>
                )}
              </div>
              
              {/* Search Results Dropdown */}
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-app-panel dark:bg-app-raised border border-app-border rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                  {searchResults.map((result, idx) => (
                    <button
                      key={idx}
                      onClick={() => focusOnNode(result)}
                      className="w-full px-3 py-2 text-left text-app-fg hover:bg-app-chip flex items-center gap-2 border-b border-app-border last:border-0"
                    >
                      <span 
                        className="w-2 h-2 rounded-full flex-shrink-0" 
                        style={{ backgroundColor: result.color }} 
                      />
                      <span className="text-xs font-medium truncate">{result.label}</span>
                      <span className="text-[10px] text-app-fg-subtle uppercase ml-auto">{result.type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Workspace scope selector — filter the graph to one workspace,
                or "All meetings" for the global view. */}
            <div className="relative flex items-center flex-shrink-0">
              <select
                value={selectedWsId ?? ''}
                onChange={(e) => setSelectedWsId(e.target.value || null)}
                title="Scope the knowledge graph to a workspace"
                className="appearance-none pl-3 pr-7 py-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider rounded-lg bg-app-chip text-app-fg border border-app-border outline-none cursor-pointer max-w-[160px] truncate"
              >
                <option value="">All meetings</option>
                {workspaces.map((ws) => (
                  <option key={ws.id} value={ws.id}>{ws.name}</option>
                ))}
              </select>
              {wsLoading
                ? <Loader2 className="w-3 h-3 animate-spin absolute right-2 pointer-events-none text-app-fg-subtle" />
                : <ChevronRight className="w-3 h-3 rotate-90 absolute right-2 pointer-events-none text-app-fg-subtle" />}
            </div>

            {/* Build/Rebuild Button */}
            <button
              onClick={buildKnowledgeGraph}
              disabled={isLoadingKG || historyLength === 0}
              className="px-3 sm:px-4 py-2 bg-kg-accent text-kg-accent-fg text-[10px] sm:text-xs font-mono uppercase tracking-wider hover:bg-kg-accent-strong disabled:opacity-30 flex items-center gap-1.5 sm:gap-2 rounded-lg transition-colors flex-shrink-0"
            >
              {isLoadingKG ? <Loader2 className="w-3.5 sm:w-4 h-3.5 sm:h-4 animate-spin" /> : <Network className="w-3.5 sm:w-4 h-3.5 sm:h-4" />}
              <span className="hidden sm:inline">{kgBuilt ? 'Rebuild' : 'Build Graph'}</span>
              <span className="sm:hidden">{kgBuilt ? 'Rebuild' : 'Build'}</span>
            </button>
          </div>
        </div>
      </div>

      {/* Main Content */}
      <div className="flex-1 flex overflow-hidden">
        {/* Graph Area */}
        <div className="flex-1 min-w-0 flex flex-col relative">
          {/* Background extraction indicator */}
          <AnimatePresence>
            {isExtractingNewKG && kgBuilt && (
              <motion.div 
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-app-panel/90 backdrop-blur-md border border-app-border text-app-fg px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-xs"
              >
                <Loader2 className="w-3 h-3 animate-spin text-kg-accent" />
                <span>Extracting latest meeting data…</span>
              </motion.div>
            )}
            {isEmbedding && kgBuilt && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-app-panel/90 backdrop-blur-md border border-app-border text-app-fg px-5 py-2.5 rounded-full shadow-lg flex items-center gap-3 text-xs"
              >
                <Loader2 className="w-3 h-3 animate-spin text-kg-accent" />
                <span>
                  {embedProgress.current === 1 && 'Embedding topics & meetings…'}
                  {embedProgress.current === 2 && 'Extracting cross-meeting relationships…'}
                  {embedProgress.current === 3 && 'Building edge matrix & graph…'}
                  {embedProgress.current === 0 && 'Preparing embedding pipeline…'}
                </span>
                <span className="text-app-fg-subtle">{embedProgress.current}/{embedProgress.total}</span>
              </motion.div>
            )}

            {/* Server-side processing status: some meetings are still being analysed
                in the cloud. We're NOT processing anything here — just reading status. */}
            {processingMeetings.length > 0 && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-app-panel border border-app-border text-app-fg px-4 py-2 rounded-full shadow-lg flex items-center gap-2.5 text-xs"
              >
                <Loader2 className="w-3 h-3 animate-spin text-kg-accent" />
                <span>
                  Analysing {processingMeetings.length} {processingMeetings.length === 1 ? 'meeting' : 'meetings'} on our servers…
                </span>
              </motion.div>
            )}
          </AnimatePresence>

          {!kgBuilt && !isExtractingNewKG ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-app-canvas text-app-fg">
              {isLoadingKG ? (
                <div className="w-full max-w-md flex flex-col items-center">
                  <Loader2 className="w-16 h-16 animate-spin text-kg-accent mb-6" />
                  <h3 className="text-lg font-bold text-app-fg mb-2">
                    Analyzing Meeting {kgProgress.current} of {kgProgress.total}
                  </h3>
                  <div className="w-full bg-app-chip rounded-full h-2.5 mb-4 overflow-hidden">
                    <motion.div
                      className="bg-kg-accent h-2.5 rounded-full"
                      initial={{ width: 0 }}
                      animate={{ width: `${(kgProgress.current / kgProgress.total) * 100}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                  <p className="text-xs text-app-fg-subtle mt-2">
                    Extracting topics, decisions, people, and action items…
                  </p>
                </div>
              ) : (
                <>
                  <Share2 className="w-16 h-16 text-app-fg-subtle/50 mb-6" />
                  <h3 className="text-lg font-serif font-semibold text-app-fg-subtle">No Graph Built Yet</h3>
                  <p className="text-xs text-app-fg-subtle mt-2 max-w-md">
                    {historyLength === 0 
                      ? 'Process some audio files first, then come back to build your knowledge graph.'
                      : `You have ${historyLength} meeting${historyLength !== 1 ? 's' : ''} ready. Click "Build Graph" to analyze and connect them.`
                    }
                  </p>
                </>
              )}
            </div>
          ) : (
            <>
              <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
                <div className="flex-1 flex flex-col min-w-0 min-h-0">
                  {/* View controls */}
                  <div className="flex-none flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 bg-app-panel dark:bg-app-raised border-b border-app-border overflow-x-auto no-scrollbar">
                    <button
                      type="button"
                      onClick={() => setBrowsePanelOpen((v) => !v)}
                      className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-lg border flex items-center gap-1.5 transition-colors ${
                        browsePanelOpen
                          ? 'bg-kg-accent text-kg-accent-fg border-kg-accent'
                          : 'border-app-border text-app-fg-muted bg-app-panel hover:bg-app-chip'
                      }`}
                      title="Open or close the meeting list"
                    >
                      <List className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Meeting index</span>
                    </button>
                    <div className="h-4 w-px bg-app-border" />
                    <div className="flex items-center rounded-lg border border-app-border p-0.5 bg-app-canvas">
                      <button
                        type="button"
                        onClick={() => {
                          setGraphViewMode('overview');
                          setEgoFocus(false);
                          setSelectedNode(null);
                        }}
                        className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-lg flex items-center gap-1.5 transition-colors ${
                          graphViewMode === 'overview' ? 'bg-app-chip shadow-sm text-kg-accent' : 'text-app-fg-subtle hover:text-app-fg'
                        }`}
                        title="Only meetings and cross-meeting links — clearest map"
                      >
                        <LayoutGrid className="w-3.5 h-3.5" />
                        Overview
                      </button>
                      <button
                        type="button"
                        onClick={() => setGraphViewMode('full')}
                        className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-lg flex items-center gap-1.5 transition-colors ${
                          graphViewMode === 'full' ? 'bg-app-chip shadow-sm text-kg-accent' : 'text-app-fg-subtle hover:text-app-fg'
                        }`}
                        title="Topics, people, decisions, and actions"
                      >
                        <Network className="w-3.5 h-3.5" />
                        Full
                      </button>
                    </div>
                    <button
                      type="button"
                      disabled={graphViewMode === 'overview' || !selectedNode}
                      onClick={() => setEgoFocus(f => !f)}
                      className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-lg border flex items-center gap-1.5 transition-colors ${
                        egoFocus && selectedNode
                          ? 'bg-kg-accent-soft border-kg-accent-border text-kg-accent'
                          : 'border-app-border text-app-fg-muted hover:bg-app-chip'
                      } ${graphViewMode === 'overview' || !selectedNode ? 'opacity-40 pointer-events-none' : ''}`}
                      title={!selectedNode ? 'Select a node on the graph first' : 'Show only this node and its direct connections'}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                      Neighborhood
                    </button>
                    <div className="h-4 w-px bg-app-border hidden sm:block" />
                    <span className="text-[10px] text-app-fg-subtle tabular-nums hidden sm:inline">
                      {displayGraphData.nodes.length} nodes · {displayGraphData.links.length} links
                    </span>
                    {graphViewMode === 'overview' && (
                      <span className="text-[10px] text-app-fg-subtle ml-auto hidden sm:inline">Cross-meeting links only</span>
                    )}
                    <button
                      type="button"
                      onClick={() => graphRef.current?.zoomToFit(450, 70)}
                      className="ml-auto sm:ml-0 px-2 py-1 text-[9px] font-mono uppercase text-app-fg-subtle hover:text-app-fg sm:hidden"
                    >
                      Fit
                    </button>
                  </div>

                  {graphViewMode === 'full' && (
                    <div className="flex-none px-3 py-2 bg-app-canvas border-b border-app-border flex items-center gap-1.5 flex-wrap">
                      <Filter className="w-3 h-3 text-app-fg-subtle flex-shrink-0" />
                      <span className="text-[9px] font-mono uppercase text-app-fg-subtle flex-shrink-0">Show:</span>
                      <button
                        onClick={() => setFilterType(null)}
                        className={`px-2 py-0.5 text-[9px] rounded-lg transition-colors ${
                          !filterType ? 'bg-kg-accent text-kg-accent-fg' : 'bg-app-panel border border-app-border text-app-fg-muted hover:bg-app-chip'
                        }`}
                      >
                        All types
                      </button>
                      {nodeTypes.map(nt => (
                        <button
                          key={nt.type}
                          onClick={() => setFilterType(filterType === nt.type ? null : nt.type)}
                          className={`px-2 py-0.5 text-[9px] rounded-lg transition-colors flex items-center gap-1 ${
                            filterType === nt.type ? 'bg-kg-accent text-kg-accent-fg' : 'bg-app-panel border border-app-border text-app-fg-muted hover:bg-app-chip'
                          }`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: nt.color }} />
                          {nt.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <div ref={kgContainerRef} className="flex-1 bg-app-canvas relative min-h-0 overflow-hidden">
                    {/* Meeting index drawer — scoped to this canvas */}
                    <AnimatePresence>
                      {browsePanelOpen && (
                        <>
                          <motion.div
                            initial={{ opacity: 0 }}
                            animate={{ opacity: 1 }}
                            exit={{ opacity: 0 }}
                            transition={{ duration: 0.18 }}
                            className="absolute inset-0 z-20 bg-black/30"
                            onClick={() => setBrowsePanelOpen(false)}
                          />
                          <motion.aside
                            initial={{ x: '-100%' }}
                            animate={{ x: 0 }}
                            exit={{ x: '-100%' }}
                            transition={{ type: 'spring', damping: 30, stiffness: 340 }}
                            className="absolute left-0 top-0 bottom-0 w-72 z-30 flex flex-col bg-app-panel/95 backdrop-blur-md border-r border-app-border shadow-2xl"
                          >
                            <div className="px-3 py-2.5 border-b border-app-border">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-app-fg-subtle">
                                  <List className="w-3.5 h-3.5 flex-shrink-0" />
                                  Meeting index
                                  <span className="text-[9px] text-app-fg-subtle tabular-nums">{meetingNodesSorted.length}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setBrowsePanelOpen(false)}
                                  className="p-1.5 rounded-lg hover:bg-app-chip text-app-fg-subtle"
                                  aria-label="Close"
                                >
                                  <PanelLeftClose className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-0.5">
                              {(() => {
                                let lastMonth = '';
                                return meetingNodesSorted.map((m: any) => {
                                  const raw = m.data?.meetingDate;
                                  const dateObj = raw ? new Date(raw) : null;
                                  const monthLabel = dateObj
                                    ? dateObj.toLocaleDateString('en-US', { month: 'long', year: 'numeric' })
                                    : 'Unknown date';
                                  const dayLabel = dateObj
                                    ? dateObj.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })
                                    : null;
                                  const isNewMonth = monthLabel !== lastMonth;
                                  lastMonth = monthLabel;
                                  const isSel = selectedNode?.id === m.id;
                                  return (
                                    <div key={m.id}>
                                      {isNewMonth && (
                                        <p className="text-[9px] font-mono uppercase tracking-widest text-app-fg-subtle px-1 pt-3 pb-1 first:pt-1">
                                          {monthLabel}
                                        </p>
                                      )}
                                      <button
                                        type="button"
                                        onClick={() => {
                                          setGraphViewMode('overview');
                                          focusOnNode(m);
                                        }}
                                        className={`w-full text-left px-2.5 py-2 rounded-lg border transition-colors ${
                                          isSel
                                            ? 'bg-kg-accent-soft border-kg-accent-border text-app-fg'
                                            : 'bg-app-panel border-app-border text-app-fg hover:bg-app-chip hover:border-app-border-strong'
                                        }`}
                                      >
                                        <span className="block text-[11px] leading-snug line-clamp-2 break-words">
                                          {m.label || 'Meeting'}
                                        </span>
                                        {dayLabel && (
                                          <span className={`block text-[9px] mt-0.5 tabular-nums ${isSel ? 'text-kg-accent' : 'text-app-fg-subtle'}`}>
                                            {dayLabel}
                                          </span>
                                        )}
                                      </button>
                                    </div>
                                  );
                                });
                              })()}
                            </div>
                          </motion.aside>
                        </>
                      )}
                    </AnimatePresence>

                    <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-1.5">
                      <button
                        onClick={() => graphRef.current?.zoom(graphRef.current.zoom() * 1.3, 300)}
                        className="bg-app-panel/90 backdrop-blur-md border border-app-border p-2 rounded-lg shadow-sm hover:bg-app-chip text-app-fg-muted hover:text-app-fg transition-colors"
                        title="Zoom In"
                        type="button"
                      >
                        <ZoomIn className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => graphRef.current?.zoom(graphRef.current.zoom() / 1.3, 300)}
                        className="bg-app-panel/90 backdrop-blur-md border border-app-border p-2 rounded-lg shadow-sm hover:bg-app-chip text-app-fg-muted hover:text-app-fg transition-colors"
                        title="Zoom Out"
                        type="button"
                      >
                        <ZoomOut className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => { shouldAutoFitRef.current = false; graphRef.current?.zoomToFit(450, 70); }}
                        className="bg-app-panel/90 backdrop-blur-md border border-app-border p-2 rounded-lg shadow-sm hover:bg-app-chip text-app-fg-muted hover:text-app-fg transition-colors"
                        title="Fit everything in view"
                        type="button"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="absolute top-3 left-3 z-10 max-w-[200px] sm:max-w-[220px] bg-app-panel/95 dark:bg-app-chip/95 backdrop-blur-sm border border-app-border rounded-lg px-2.5 py-2 shadow-sm hidden sm:block">
                      <h4 className="text-[9px] font-mono uppercase tracking-widest text-app-fg-subtle mb-1.5">Key</h4>
                      <div className="flex flex-wrap gap-x-2 gap-y-1">
                        {nodeTypes.map(item => (
                          <span key={item.label} className="inline-flex items-center gap-1 text-[9px] text-app-fg-muted">
                            <span
                              className={`rounded-full ${item.shape === 'large' ? 'w-2.5 h-2.5' : item.shape === 'medium' ? 'w-2 h-2' : 'w-1.5 h-1.5'}`}
                              style={{ backgroundColor: item.color }}
                            />
                            {item.label}
                          </span>
                        ))}
                      </div>
                      <p className="text-[8px] text-app-fg-subtle mt-2 leading-tight">Zoom in for more labels, or use the meeting list.</p>
                    </div>

                    <ForceGraph2D
                      ref={graphRef}
                      graphData={displayGraphData}
                      width={kgDimensions.width}
                      height={kgDimensions.height}
                      backgroundColor={themeResolved === 'dark' ? '#141414' : '#f2f2f2'}
                      nodeLabel={(node: any) => {
                        if (node.type === 'person') {
                          const tag = node.data?.isAttendee === true ? ' · attendee'
                            : node.data?.isAttendee === false ? ' · mentioned' : '';
                          return `PERSON: ${node.label}${tag}`;
                        }
                        return `${node.type.toUpperCase()}: ${node.label}`;
                      }}
                      nodeColor={(node: any) => node.color}
                      nodeVal={(node: any) => node.size}
                      linkCanvasObjectMode={() => 'replace'}
                      linkCanvasObject={(link: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                        const a = link.source, b = link.target;
                        if (!a || !b || !Number.isFinite(a.x) || !Number.isFinite(a.y) || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return;
                        const isDark = themeResolved === 'dark';
                        const isRel = link.type === 'meeting-sibling';
                        const touchesFocus = focus && (a.id === focus.id || b.id === focus.id);
                        const faded = focus && !touchesFocus;

                        if (isRel) {
                          // Neon "synapse": a glowing line in the relationship colour
                          // (amber when the focused node owns it). Few of these, so they
                          // can be bold without congesting.
                          const col = touchesFocus ? (isDark ? '#b9d96a' : '#819c1f') : (link.color || (isDark ? '#b9d96a' : '#819c1f'));
                          ctx.save();
                          ctx.globalAlpha = faded ? 0.14 : 0.95;
                          ctx.strokeStyle = col;
                          ctx.lineWidth = (touchesFocus ? 2.6 : 1.8) / globalScale;
                          ctx.lineCap = 'round';
                          ctx.shadowColor = col;
                          ctx.shadowBlur = (touchesFocus ? 18 : 11) / globalScale;
                          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                          // second pass tightens the core so it reads as neon, not fuzz
                          ctx.shadowBlur = 0; ctx.lineWidth = (touchesFocus ? 1.3 : 0.9) / globalScale;
                          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                          ctx.restore();
                        } else {
                          // Structural links: visible but secondary — a clean dashed thread.
                          ctx.save();
                          ctx.globalAlpha = faded ? 0.06 : 1;
                          ctx.strokeStyle = isDark ? 'rgba(190,190,205,0.26)' : 'rgba(120,112,100,0.30)';
                          ctx.lineWidth = 1 / globalScale;
                          ctx.setLineDash([2 / globalScale, 5 / globalScale]);
                          ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
                          ctx.restore();
                        }
                      }}
                      linkDirectionalParticles={(link: any) => (link.type === 'meeting-sibling' ? 4 : 0)}
                      linkDirectionalParticleColor={(link: any) => {
                        const a = link.source, b = link.target;
                        const touchesFocus = focus && a && b && (a.id === focus.id || b.id === focus.id);
                        const green = themeResolved === 'dark' ? '#b9d96a' : '#819c1f';
                        return touchesFocus ? green : (link.color || green);
                      }}
                      linkDirectionalParticleWidth={(link: any) => {
                        const a = link.source, b = link.target;
                        return focus && a && b && (a.id === focus.id || b.id === focus.id) ? 4 : 3;
                      }}
                      linkDirectionalParticleSpeed={0.006}
                      linkLabel={(link: any) =>
                        link.type === 'meeting-sibling' && graphViewMode === 'full' && link.label ? link.label : ''
                      }
                      minZoom={0.15}
                      maxZoom={12}
                      onNodeHover={(n: any) => setHoveredNode(n || null)}
                      onBackgroundClick={() => setSelectedNode(null)}
                      onNodeClick={(node: any) => {
                        setSelectedNode(node);
                        pendingFocusIdRef.current = null;
                        if (graphRef.current && node.x != null && node.y != null) {
                          const z = graphRef.current.zoom();
                          if (z < 0.85) {
                            graphRef.current.zoom(1, 500);
                          }
                          graphRef.current.centerAt(node.x, node.y, 600);
                        }
                      }}
                      onNodeDragEnd={(node: any) => {
                        const bounds = 2000;
                        node.fx = Math.max(-bounds, Math.min(bounds, node.x));
                        node.fy = Math.max(-bounds, Math.min(bounds, node.y));
                      }}
                      onEngineStop={() => {
                        const g = graphRef.current;
                        if (!g) return;
                        const pending = pendingFocusIdRef.current;
                        if (pending) {
                          const n = graphData.nodes.find((x: any) => x.id === pending) as
                            | { x?: number; y?: number }
                            | undefined;
                          if (n && n.x !== undefined && n.y !== undefined) {
                            g.centerAt(n.x, n.y, 500);
                            const z = g.zoom();
                            if (z < 1.1) g.zoom(1.45, 500);
                          }
                          pendingFocusIdRef.current = null;
                          shouldAutoFitRef.current = false;
                          return;
                        }
                        if (shouldAutoFitRef.current) {
                          g.zoomToFit(500, 70);
                          shouldAutoFitRef.current = false;
                        }
                      }}
                      nodePointerAreaPaint={(node: any, color: string, ctx: CanvasRenderingContext2D) => {
                        const r = node.type === 'meeting' ? 14 : node.type === 'topic' ? 10 : 8;
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                        ctx.fillStyle = color;
                        ctx.fill();
                      }}
                      nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                        // Guard: react-force-graph paints nodes before the simulation
                        // assigns coordinates. createRadialGradient() throws on
                        // non-finite values, and an uncaught throw here kills the canvas
                        // render loop (crashing the tab). Skip until the node is placed.
                        if (!Number.isFinite(node.x) || !Number.isFinite(node.y)) return;
                        const isDark = themeResolved === 'dark';
                        const ACCENT = isDark ? '#b9d96a' : '#819c1f';
                        const bg = isDark ? '#141414' : '#f2f2f2';
                        const isSel = selectedNode && node.id === selectedNode.id;
                        const isHover = hoveredNode && node.id === hoveredNode.id;
                        const dim = focus ? !focus.set.has(node.id) : false;
                        const label = node.label || '';
                        const isMeeting = node.type === 'meeting';
                        // Normalise to a valid 6-digit hex so `color + alpha` is always a
                        // legal #rrggbbaa — addColorStop() throws on malformed colours.
                        const rawColor = node.color || '#888888';
                        const color = /^#[0-9a-fA-F]{6}$/.test(rawColor) ? rawColor : '#888888';
                        const r = isMeeting ? 10 : node.type === 'topic' ? 7 : 5;
                        const showLabel = isSel || isHover || (isMeeting ? globalScale >= 0.62 : globalScale >= 1.3);

                        ctx.globalAlpha = dim ? 0.2 : 1;

                        // Glow — a soft radial halo in the node's own colour. Softer on
                        // the light/paper canvas so it stays calm and on-brand.
                        if (!dim) {
                          const gr = r * (isMeeting ? 3.4 : 2.4);
                          const g = ctx.createRadialGradient(node.x, node.y, 0, node.x, node.y, gr);
                          const inner = isDark ? (isMeeting ? '5a' : '38') : (isMeeting ? '3a' : '22');
                          g.addColorStop(0, color + inner);
                          g.addColorStop(1, color + '00');
                          ctx.fillStyle = g;
                          ctx.beginPath();
                          ctx.arc(node.x, node.y, gr, 0, 2 * Math.PI, false);
                          ctx.fill();
                        }

                        // Focus rings — amber accent for selection / hover.
                        if (isSel || isHover) {
                          ctx.beginPath();
                          ctx.arc(node.x, node.y, r + (isSel ? 5 : 4) / globalScale, 0, 2 * Math.PI, false);
                          ctx.strokeStyle = ACCENT;
                          ctx.globalAlpha = (dim ? 0.2 : 1) * (isSel ? 0.95 : 0.55);
                          ctx.lineWidth = (isSel ? 2.2 : 1.6) / globalScale;
                          ctx.stroke();
                          ctx.globalAlpha = dim ? 0.2 : 1;
                        }

                        // Body. People nodes carry a confirmation state: a confirmed
                        // attendee gets a crisp ring; someone merely *mentioned* in the
                        // transcript is ghosted (lower opacity) so you can tell them apart.
                        const isPerson = node.type === 'person';
                        const isAttendee = isPerson && node.data?.isAttendee === true;
                        const isMentioned = isPerson && node.data?.isAttendee === false;
                        const baseAlpha = ctx.globalAlpha;
                        if (isMentioned) ctx.globalAlpha = baseAlpha * 0.55;
                        ctx.beginPath();
                        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                        ctx.fillStyle = color;
                        ctx.fill();
                        ctx.globalAlpha = baseAlpha;

                        if (isAttendee) {
                          ctx.beginPath();
                          ctx.arc(node.x, node.y, r + 2.5 / globalScale, 0, 2 * Math.PI, false);
                          ctx.strokeStyle = isDark ? 'rgba(245,245,245,0.85)' : 'rgba(28,26,23,0.7)';
                          ctx.lineWidth = 1.3 / globalScale;
                          ctx.stroke();
                        }

                        // Meetings: ring + hollow core (core matches the backdrop) so
                        // they read as "anchors" in either theme.
                        if (isMeeting) {
                          ctx.strokeStyle = bg;
                          ctx.lineWidth = 2 / globalScale;
                          ctx.stroke();
                          ctx.beginPath();
                          ctx.arc(node.x, node.y, r * 0.34, 0, 2 * Math.PI, false);
                          ctx.fillStyle = bg;
                          ctx.fill();
                        }

                        if (!showLabel || dim) { ctx.globalAlpha = 1; return; }

                        // Label — pill background for legibility on the dark canvas.
                        const maxLen = isMeeting ? 26 : 18;
                        const displayLabel = label.length > maxLen ? label.substring(0, maxLen) + '…' : label;
                        const fontSize = (isMeeting ? 10 : 8.5) / globalScale;
                        ctx.font = `${isMeeting ? '600 ' : '500 '}${fontSize}px Inter, system-ui, sans-serif`;
                        const tw = ctx.measureText(displayLabel).width;
                        const padX = 6 / globalScale;
                        const ly = node.y + r + (isMeeting ? 14 : 11) / globalScale;
                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'middle';
                        ctx.globalAlpha = isDark ? 0.78 : 0.86;
                        ctx.fillStyle = isDark ? 'rgba(28,28,28,0.92)' : 'rgba(255,255,255,0.94)';
                        const ph = fontSize + 7 / globalScale;
                        const px = node.x - tw / 2 - padX, py = ly - ph / 2, pw = tw + padX * 2, rad = 5 / globalScale;
                        ctx.beginPath();
                        ctx.moveTo(px + rad, py);
                        ctx.arcTo(px + pw, py, px + pw, py + ph, rad);
                        ctx.arcTo(px + pw, py + ph, px, py + ph, rad);
                        ctx.arcTo(px, py + ph, px, py, rad);
                        ctx.arcTo(px, py, px + pw, py, rad);
                        ctx.closePath();
                        ctx.fill();
                        ctx.globalAlpha = 1;
                        ctx.fillStyle = isSel || isHover ? ACCENT : (isDark ? 'rgba(235,235,235,0.94)' : 'rgba(28,26,23,0.92)');
                        ctx.fillText(displayLabel, node.x, ly);
                        ctx.globalAlpha = 1;
                      }}
                      cooldownTicks={300}
                      d3AlphaDecay={0.018}
                      d3VelocityDecay={0.34}
                      d3AlphaMin={0.008}
                      warmupTicks={80}
                    />
                  </div>
                </div>
              </div>

            </>
          )}
        </div>

        {/* Node Detail Panel - Bottom Sheet on Mobile */}
        <AnimatePresence>
          {selectedNode && (
            <>
              {/* Mobile Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/30 z-30 sm:hidden"
                onClick={() => setSelectedNode(null)}
              />
              
              <motion.div 
                initial={{ y: '100%', opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: '100%', opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto sm:left-auto sm:right-auto w-full sm:w-[380px] max-h-[70vh] sm:max-h-none flex-shrink-0 bg-app-panel dark:bg-app-raised border-t sm:border-t-0 sm:border-l border-app-border overflow-y-auto overflow-x-hidden z-40 sm:z-20 rounded-t-2xl sm:rounded-none shadow-[0_-4px_30px_rgba(0,0,0,0.15)] sm:shadow-[0_0_15px_rgba(0,0,0,0.05)] dark:sm:shadow-[0_0_20px_rgba(0,0,0,0.4)]"
              >
                {/* Drag Handle - Mobile Only */}
                <div className="flex justify-center py-2 sm:hidden">
                  <div className="w-10 h-1 bg-app-border-strong rounded-full" />
                </div>
              <div className="p-4 border-b border-app-border flex items-center justify-between sticky top-0 bg-app-panel dark:bg-app-raised z-10">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                  <span className="text-[10px] font-mono uppercase font-bold text-app-fg-subtle tracking-wider">
                    {selectedNode.type}
                  </span>
                </div>
                <button 
                  onClick={() => setSelectedNode(null)} 
                  className="p-1 hover:bg-app-chip rounded-lg text-app-fg-muted"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              
              <div className="p-4 text-app-fg">
                <h3 className="font-serif font-semibold text-xl mb-4 leading-snug">{selectedNode.label}</h3>
                
                {selectedNode.type === 'meeting' && selectedNode.data && (
                  <div className="space-y-4">
                    {/* Show notice when meeting has no extracted data at all */}
                    {(() => {
                      const d = selectedNode.data;
                      const hasValidTopics = (d.topics || []).some((t: any) => t?.name?.trim());
                      const hasAny = hasValidTopics ||
                        (d.people || []).length > 0 ||
                        (d.decisions || []).some((dec: any) => dec?.decision?.trim()) ||
                        (d.actionItems || []).some((a: any) => a?.task?.trim());
                      if (hasAny && hasValidTopics) return null;
                      return (
                        <div className="p-3 bg-app-raised rounded-lg border border-app-border text-center">
                          <p className="text-xs text-app-fg font-medium mb-1">
                            {hasAny ? 'Topics not extracted' : 'No insights extracted'}
                          </p>
                          <p className="text-[10px] text-app-fg-muted mb-2">
                            {hasAny
                              ? 'Topics could not be extracted for this meeting. Click below to retry.'
                              : 'This meeting may have a very short transcription or the extraction needs to be re-run.'}
                          </p>
                          {onReExtractMeeting && (
                            <button
                              disabled={isReExtracting}
                              onClick={async () => {
                                setIsReExtracting(true);
                                try {
                                  await onReExtractMeeting(selectedNode.data.meetingId);
                                } finally {
                                  setIsReExtracting(false);
                                }
                              }}
                              className="px-3 py-1.5 bg-kg-accent hover:bg-kg-accent-strong disabled:opacity-50 text-kg-accent-fg text-[11px] font-medium rounded-lg transition-colors"
                            >
                              {isReExtracting ? (
                                <span className="flex items-center gap-1.5">
                                  <Loader2 className="w-3 h-3 animate-spin" />
                                  Re-extracting...
                                </span>
                              ) : (
                                <span className="flex items-center gap-1.5">
                                  <Sparkles className="w-3 h-3" />
                                  Re-extract Insights
                                </span>
                              )}
                            </button>
                          )}
                        </div>
                      );
                    })()}
                    {(() => {
                      const validTopics = (selectedNode.data.topics || []).filter(
                        (t: any) => t && t.name && t.name.trim().length > 0
                      );
                      if (validTopics.length === 0) return null;
                      return (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-app-fg-subtle mb-2 flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> Topics
                        </h4>
                        <div className="space-y-2">
                          {validTopics.map((t: any, i: number) => (
                            <div key={i} className="p-2 bg-app-raised rounded-lg border border-app-border">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-semibold text-app-fg">{t.name}</span>
                                <span className={`text-[9px] px-1.5 py-0.5 rounded-lg ${
                                  t.status === 'resolved' ? 'bg-green-100 text-green-700' :
                                  t.status === 'off-track' ? 'bg-red-100 text-red-700' :
                                  t.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                }`}>{t.status}</span>
                              </div>
                              {t.summary && <p className="text-[11px] text-app-fg-muted">{t.summary}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                      );
                    })()}
                    
                    {(selectedNode.data.people || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-app-fg-subtle mb-2 flex items-center gap-1">
                          <Users className="w-3 h-3" /> People
                        </h4>
                        <div className="flex flex-wrap gap-1">
                          {selectedNode.data.people.map((p: string, i: number) => (
                            <span key={i} className="px-2 py-1 bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-200 text-[10px] rounded-lg border border-cyan-100/80 dark:border-cyan-800/40">{p}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {(selectedNode.data.decisions || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-app-fg-subtle mb-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Decisions
                        </h4>
                        <ul className="space-y-1">
                          {selectedNode.data.decisions.map((d: any, i: number) => (
                            <li key={i} className="text-xs text-app-fg-muted bg-app-raised border border-app-border p-2 rounded-lg">• {d.decision}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(selectedNode.data.actionItems || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-app-fg-subtle mb-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Action Items
                        </h4>
                        <ul className="space-y-2">
                          {selectedNode.data.actionItems.map((a: any, i: number) => (
                            <li key={i} className="p-2 bg-app-raised rounded-lg border border-app-border">
                              <span className="text-sm font-medium text-app-fg block mb-1">{a.task}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-app-fg-muted font-medium">Assignee: {a.owner}</span>
                              </div>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {/* Related Meetings Section - Cross-Meeting Connections */}
                    {(() => {
                      const relatedMeetings = findRelatedMeetings(selectedNode.data.meetingId);
                      if (relatedMeetings.length === 0) return null;
                      
                      return (
                        <div className="border-t border-app-border pt-5 mt-5">
                          <h4 className="text-[10px] font-mono uppercase tracking-widest text-app-fg-subtle mb-4 flex items-center gap-2">
                            <Share2 className="w-3 h-3" />
                            Connected Meetings ({relatedMeetings.length})
                          </h4>
                          <div className="space-y-3">
                            {relatedMeetings.slice(0, 5).map((related, idx) => (
                              <ExpandableMeetingCard key={idx} related={related} idx={idx} />
                            ))}
                          </div>
                          {relatedMeetings.length > 5 && (
                            <button className="w-full mt-3 py-2 text-[10px] font-mono uppercase tracking-wider text-app-fg-subtle hover:text-app-fg bg-app-raised hover:bg-app-chip rounded-lg transition-colors border border-app-border">
                              View {relatedMeetings.length - 5} More
                            </button>
                          )}
                        </div>
                      );
                    })()}
                  </div>
                )}

                {selectedNode.type === 'topic' && selectedNode.data && (
                  <div className="space-y-4">
                    <div className={`px-2 py-1 rounded-lg text-xs inline-block ${
                      selectedNode.data.status === 'resolved' ? 'bg-green-100 text-green-700' :
                      selectedNode.data.status === 'off-track' ? 'bg-red-100 text-red-700' :
                      selectedNode.data.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                    }`}>
                      Status: {selectedNode.data.status}
                    </div>
                    <p className="text-sm text-app-fg-muted">{selectedNode.data.summary}</p>
                    
                    {selectedNode.data.allStatuses && selectedNode.data.allStatuses.length > 1 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-app-fg-subtle mb-2 flex items-center gap-1">
                          <Clock className="w-3 h-3" /> Evolution
                        </h4>
                        <div className="space-y-2">
                          {selectedNode.data.allStatuses.map((status: string, idx: number) => (
                            <div key={idx} className="flex items-start gap-2">
                              <span className={`w-2 h-2 rounded-full mt-1 ${
                                status === 'resolved' ? 'bg-green-500' :
                                status === 'off-track' ? 'bg-red-500' :
                                status === 'ongoing' ? 'bg-blue-500' : 'bg-purple-500'
                              }`} />
                              <div>
                                <span className="text-[10px] font-medium text-app-fg">{status}</span>
                                <p className="text-[10px] text-app-fg-muted italic">"{selectedNode.data.allSummaries?.[idx]}"</p>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {selectedNode.type === 'person' && selectedNode.data && (
                  <div className="space-y-4">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 rounded-full bg-cyan-100 dark:bg-cyan-950/50 flex items-center justify-center border border-cyan-200/60 dark:border-cyan-800/50">
                        <Users className="w-6 h-6 text-cyan-600 dark:text-cyan-400" />
                      </div>
                      <div>
                        <div className="flex items-center gap-2">
                          <p className="font-bold">{selectedNode.label}</p>
                          {selectedNode.data.isAttendee === true && (
                            <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-kg-accent-soft text-kg-accent border border-kg-accent-border">Attendee</span>
                          )}
                          {selectedNode.data.isAttendee === false && (
                            <span className="text-[9px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded-full bg-app-chip text-app-fg-muted border border-app-border">Mentioned</span>
                          )}
                        </div>
                        <p className="text-xs text-app-fg-subtle">
                          {selectedNode.data.meetings?.length || 0} meeting(s)
                        </p>
                      </div>
                    </div>
                    {selectedNode.data.meetings && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-app-fg-subtle mb-2">Present in:</h4>
                        <ul className="space-y-1">
                          {selectedNode.data.meetings.map((m: string, i: number) => (
                            <li key={i} className="text-xs text-app-fg bg-app-raised p-2 rounded-lg border border-app-border">
                              {m?.replace(/\.[^.]+$/, '')}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}

                {selectedNode.type === 'decision' && selectedNode.data && (
                  <div className="space-y-4">
                    <div className="p-3 bg-app-raised rounded-lg border border-app-border">
                      <p className="text-sm text-app-fg">{selectedNode.data.decision}</p>
                    </div>
                    <div className="text-xs text-app-fg-muted">
                      <p><strong>Related Topic:</strong> {selectedNode.data.relatedTopic || 'General'}</p>
                      <p><strong>Meeting:</strong> {selectedNode.data.meetingTitle?.replace(/\.[^.]+$/, '')}</p>
                    </div>
                  </div>
                )}

                {selectedNode.type === 'action' && selectedNode.data && (
                  <div className="space-y-4">
                    <div className="p-3 bg-app-raised rounded-lg border border-app-border">
                      <p className="text-sm text-app-fg">{selectedNode.data.task}</p>
                    </div>
                    <div className="text-xs text-app-fg-muted">
                      <p><strong>Owner:</strong> {selectedNode.data.owner}</p>
                      <p><strong>Related Topic:</strong> {selectedNode.data.relatedTopic || 'General'}</p>
                      <p><strong>Meeting:</strong> {selectedNode.data.meetingTitle?.replace(/\.[^.]+$/, '')}</p>
                    </div>
                  </div>
                )}
              </div>
            </motion.div>
            </>
          )}
        </AnimatePresence>
      </div>
    </div>
  );
}
