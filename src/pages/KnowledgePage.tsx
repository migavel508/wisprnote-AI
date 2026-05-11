import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('KnowledgePage');
const env = (import.meta as any).env || {};
import { motion, AnimatePresence } from 'framer-motion';
import ForceGraph2D from 'react-force-graph-2d';
import { 
  Search, 
  Send, 
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
  buildChatContext,
} from '../lib/knowledgeGraph.utils';
import { buildFingerprint, loadCachedArtifact, saveCachedArtifact } from '../lib/kgArtifactCache';
import { useTheme } from '../theme/ThemeProvider';

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
  kgData,
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
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);
  /** meetings-only graph vs full detail (topics, people, …) */
  const [graphViewMode, setGraphViewMode] = useState<'overview' | 'full'>('overview');
  /** show 1-hop neighborhood of selected node */
  const [egoFocus, setEgoFocus] = useState(false);
  const [hoveredNode, setHoveredNode] = useState<any>(null);
  const [browsePanelOpen, setBrowsePanelOpen] = useState(false);
  const [kgDimensions, setKgDimensions] = useState({ width: 800, height: 600 });
  const shouldAutoFitRef = useRef(true);
  const pendingFocusIdRef = useRef<string | null>(null);

  const kgContainerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
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

  // Scroll chat to bottom
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

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
        const charge = g.d3Force('charge');
        if (charge) charge.strength(-200);
        const linkF = g.d3Force('link');
        if (linkF) {
          linkF.strength(0.35);
          linkF.distance((link: any) => {
            if (link.type === 'meeting-sibling') return 140;
            if (link.type === 'meeting-topic') return 65;
            if (link.type?.startsWith?.('meeting-')) return 55;
            return 42;
          });
        }
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
      <div key={idx} className="bg-gradient-to-br from-purple-50/80 to-blue-50/80 dark:from-purple-950/50 dark:to-blue-950/50 rounded-xl border border-purple-100/50 dark:border-purple-800/40 overflow-hidden transition-all duration-300 hover:shadow-md">
        {/* Collapsed Header (Always visible) */}
        <div 
          className="p-3.5 flex items-center justify-between cursor-pointer hover:bg-white/40 dark:hover:bg-white/5 transition-colors group"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-bold text-gray-800 dark:text-app-fg truncate group-hover:text-purple-700 dark:group-hover:text-purple-300 transition-colors">
                {relatedMeetingData.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
              </span>
              <span className="text-[9px] px-2 py-0.5 bg-purple-200/50 dark:bg-purple-900/60 text-purple-800 dark:text-purple-200 rounded-md font-mono shrink-0 font-medium">
                {related.totalScore.toFixed(1)} pts
              </span>
            </div>
            <div className="text-[10px] text-gray-500 dark:text-zinc-400 truncate flex items-center gap-1.5 flex-wrap">
              {related.relationships.length > 0 ? related.relationships.map((r, rIdx) => (
                <span key={rIdx} className={`text-[8px] px-1.5 py-0.5 rounded font-mono ${REL_BADGE_COLORS[r.relationshipType] || 'bg-gray-100 dark:bg-app-chip text-gray-600 dark:text-zinc-300'}`}>
                  {r.relationshipType}
                </span>
              )) : (
                <span className="text-[8px] px-1.5 py-0.5 rounded font-mono bg-indigo-50 dark:bg-indigo-950/50 text-indigo-600 dark:text-indigo-300">
                  similar content
                </span>
              )}
              {related.embeddingScore > 0 && (
                <span className="flex items-center gap-1 bg-white/60 dark:bg-app-chip/80 px-1.5 py-0.5 rounded text-gray-600 dark:text-zinc-300">
                  sim: {(related.embeddingScore * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
          <div className={`shrink-0 p-1.5 bg-white/80 dark:bg-app-chip rounded-lg text-purple-600 dark:text-purple-400 shadow-sm transition-transform duration-300 ${isExpanded ? '-rotate-90 bg-purple-100 dark:bg-purple-900/70' : 'rotate-90'}`}>
            <ChevronRight className="w-3.5 h-3.5" />
          </div>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="p-3 pt-0 border-t border-purple-100 dark:border-purple-900/50 bg-white/40 dark:bg-app-panel/60">
            <div className="pt-3">
              {/* Contextual Relationships */}
              {related.relationships.length > 0 ? (
                <div className="mb-3 space-y-1.5">
                  <span className="text-[9px] font-mono uppercase text-purple-700 dark:text-purple-300 block mb-2 flex items-center gap-1">
                    <Share2 className="w-3 h-3" />
                    Why Connected:
                  </span>
                  {related.relationships.map((r, rIdx) => (
                    <div key={rIdx} className="p-2 bg-white/70 dark:bg-app-raised rounded border border-purple-200 dark:border-purple-800/50">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[8px] px-1.5 py-0.5 rounded font-mono font-medium ${REL_BADGE_COLORS[r.relationshipType] || 'bg-gray-100 dark:bg-app-chip text-gray-600 dark:text-zinc-300'}`}>
                          {r.relationshipType}
                        </span>
                        <span className="text-[8px] text-gray-400 dark:text-zinc-500 font-mono">{r.confidence}</span>
                      </div>
                      <p className="text-[10px] text-gray-700 dark:text-zinc-200">{r.sharedThread || 'Related by shared context'}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div className="mb-3 p-2 bg-indigo-50/60 dark:bg-indigo-950/40 rounded border border-indigo-100 dark:border-indigo-900/50">
                  <span className="text-[9px] font-mono uppercase text-indigo-700 dark:text-indigo-300 block mb-1 flex items-center gap-1">
                    <Share2 className="w-3 h-3" />
                    Why Connected:
                  </span>
                  <p className="text-[10px] text-indigo-800 dark:text-indigo-200">
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
                  <span className="text-[9px] font-mono uppercase text-indigo-700 dark:text-indigo-300 block mb-2 flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    What Was Discussed:
                  </span>
                  <div className="space-y-1.5">
                    {validRelTopics.map((topic: any, tIdx: number) => (
                      <div key={tIdx} className="p-2 rounded bg-white/80 dark:bg-app-chip/90">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-[10px] font-semibold text-gray-800 dark:text-app-fg">
                            {topic.name}
                          </span>
                          <span className={`text-[8px] px-1 py-0.5 rounded font-mono shrink-0 ${
                            topic.status === 'resolved' ? 'bg-green-100 text-green-700' :
                            topic.status === 'off-track' ? 'bg-red-100 text-red-700' :
                            topic.status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                            topic.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                          }`}>{topic.status}</span>
                        </div>
                        {topic.summary && <p className="text-[9px] text-gray-600 dark:text-zinc-300 leading-relaxed line-clamp-2 hover:line-clamp-none transition-all">"{topic.summary}"</p>}
                      </div>
                    ))}
                  </div>
                </div>
                );
              })()}
              
              {/* Decisions and Actions */}
              <div className="grid grid-cols-1 gap-2 mt-3">
                {(relatedMeetingData.decisions || []).length > 0 && (
                  <div className="bg-yellow-50/50 dark:bg-yellow-950/40 rounded p-2 border border-yellow-100 dark:border-yellow-900/50">
                    <span className="text-[9px] font-mono uppercase text-yellow-700 dark:text-yellow-300 block mb-1">Decisions</span>
                    <ul className="space-y-1">
                      {(relatedMeetingData.decisions || []).slice(0, 2).map((dec: any, dIdx: number) => (
                        <li key={dIdx} className="text-[9px] text-yellow-900 dark:text-yellow-100 truncate">• {dec.decision}</li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {(relatedMeetingData.actionItems || []).length > 0 && (
                  <div className="bg-pink-50/50 dark:bg-pink-950/40 rounded p-2 border border-pink-100 dark:border-pink-900/50">
                    <span className="text-[9px] font-mono uppercase text-pink-700 dark:text-pink-300 block mb-1">Actions</span>
                    <ul className="space-y-1">
                      {(relatedMeetingData.actionItems || []).slice(0, 2).map((action: any, aIdx: number) => (
                        <li key={aIdx} className="text-[9px] text-pink-900 dark:text-pink-100 truncate">
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

  // Chat with knowledge graph
  const handleChatSubmit = async () => {
    if (!chatInput.trim() || isChatting) return;

    const userMessage = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', content: userMessage }]);
    setIsChatting(true);

    try {
      const systemPrompt = kgBuildArtifact
        ? buildChatContext(
            kgData as MeetingRecord[],
            kgBuildArtifact.meetingEdgeMatrix,
            kgBuildArtifact.relationships
          )
        : `You are a helpful assistant that answers questions about the user's meeting knowledge graph.\n${kgData.map((m: any, i: number) => `Meeting ${i + 1}: ${m.meetingTitle}\n- Topics: ${(m.topics || []).map((t: any) => `${t.name} (${t.status}): ${t.summary}`).join('; ') || 'None'}\n- Decisions: ${(m.decisions || []).map((d: any) => d.decision).join('; ') || 'None'}\n- People: ${(m.people || []).join(', ') || 'None'}\n- Actions: ${(m.actionItems || []).map((a: any) => `${a.owner}: ${a.task}`).join('; ') || 'None'}`).join('\n\n')}\n\nAnswer the user's question based on this data. Be concise and helpful.`;

      const aiProvider = env.VITE_AI_PROVIDER || process.env.VITE_AI_PROVIDER || 'gemini';
      let assistantMessage: string;

      const historyForApi = chatMessages.slice(-10).map(m => ({
        role: m.role === 'assistant' ? 'model' as const : m.role as 'user',
        content: m.content,
      }));

      if (aiProvider === 'openrouter') {
        const openRouterKey = env.VITE_OPENROUTER_API_KEY || process.env.VITE_OPENROUTER_API_KEY;
        if (!openRouterKey) throw new Error('Missing OpenRouter API key');

        const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${openRouterKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': window.location.origin,
            'X-Title': 'Lumina AI',
          },
          body: JSON.stringify({
            model: 'google/gemini-3-flash-preview',
            messages: [
              { role: 'system', content: systemPrompt },
              ...historyForApi.map(m => ({ role: m.role === 'model' ? 'assistant' : m.role, content: m.content })),
              { role: 'user', content: userMessage },
            ],
            temperature: 0.15,
            max_tokens: 2400,
          })
        });

        const data = await response.json();
        assistantMessage = data.choices?.[0]?.message?.content || 'Sorry, I could not generate a response.';
      } else {
        const geminiApiKey = env.VITE_GEMINI_API_KEY || env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
        if (!geminiApiKey) throw new Error('Missing Gemini API key');

        const geminiHistory = historyForApi.map(m => ({
          role: m.role === 'model' ? 'model' : 'user',
          parts: [{ text: m.content }],
        }));

        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${geminiApiKey}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [
                { role: 'user', parts: [{ text: systemPrompt }] },
                { role: 'model', parts: [{ text: 'I understand. I will help answer questions about your meeting knowledge graph based on the data provided. I will only state facts supported by the data.' }] },
                ...geminiHistory,
                { role: 'user', parts: [{ text: userMessage }] }
              ],
              generationConfig: { temperature: 0.15, maxOutputTokens: 2400 }
            })
          }
        );

        const data = await response.json();
        assistantMessage = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
      }
      
      setChatMessages(prev => [...prev, { role: 'assistant', content: assistantMessage }]);
    } catch (error) {
      log.error('chat_failed', { error: error instanceof Error ? error : undefined });
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, there was an error processing your question.' }]);
    } finally {
      setIsChatting(false);
    }
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
      <div className="flex-none bg-app-panel border-b border-zinc-200/80 dark:border-app-border px-3 sm:px-6 py-2.5 sm:py-4">
        <div className="flex items-center justify-between gap-2 sm:gap-4">
          <div className="min-w-0">
            <h2 className="text-base sm:text-xl font-serif italic font-bold flex items-center gap-1.5 sm:gap-2">
              <Network className="w-4 sm:w-5 h-4 sm:h-5 flex-shrink-0" />
              <span className="truncate">Knowledge Graph</span>
            </h2>
            <p className="text-[10px] sm:text-xs text-zinc-500 dark:text-zinc-400 mt-0.5 hidden sm:block">Cross-meeting memory — see how topics, decisions, and people connect</p>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto">
            {/* Search - Hidden on mobile, shown as icon */}
            <div className="relative hidden sm:block">
              <div className="flex items-center gap-2 border border-zinc-200/90 dark:border-app-border bg-app-panel dark:bg-app-raised px-3 py-2 rounded-lg w-48 lg:w-64">
                <Search className="w-4 h-4 text-zinc-400 dark:text-zinc-500" />
                <input
                  type="text"
                  placeholder="Search nodes..."
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="bg-transparent border-none outline-none text-sm w-full text-zinc-900 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                />
                {searchQuery && (
                  <button onClick={() => { setSearchQuery(''); setSearchResults([]); }}>
                    <X className="w-3 h-3 text-zinc-400 hover:text-zinc-600 dark:text-zinc-500 dark:hover:text-zinc-300" />
                  </button>
                )}
              </div>
              
              {/* Search Results Dropdown */}
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-app-panel dark:bg-app-raised border border-zinc-200/80 dark:border-app-border rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                  {searchResults.map((result, idx) => (
                    <button
                      key={idx}
                      onClick={() => focusOnNode(result)}
                      className="w-full px-3 py-2 text-left text-zinc-800 dark:text-app-fg hover:bg-zinc-50 dark:hover:bg-app-chip flex items-center gap-2 border-b border-zinc-100 dark:border-app-border last:border-0"
                    >
                      <span 
                        className="w-2 h-2 rounded-full flex-shrink-0" 
                        style={{ backgroundColor: result.color }} 
                      />
                      <span className="text-xs font-medium truncate">{result.label}</span>
                      <span className="text-[10px] text-zinc-500 dark:text-zinc-400 uppercase ml-auto">{result.type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Chat Toggle */}
            <button
              onClick={() => setShowChat(!showChat)}
              className={`px-3 sm:px-4 py-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 rounded-lg transition-colors flex-shrink-0 ${
                showChat ? 'bg-[#141414] dark:bg-zinc-100 text-white dark:text-zinc-900' : 'border border-zinc-300/80 dark:border-app-border text-zinc-700 dark:text-app-fg-muted hover:bg-zinc-50 dark:hover:bg-app-chip'
              }`}
            >
              <Sparkles className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
              <span className="hidden sm:inline">Chat</span>
            </button>

            {/* Build/Rebuild Button */}
            <button 
              onClick={buildKnowledgeGraph}
              disabled={isLoadingKG || historyLength === 0}
              className="px-3 sm:px-4 py-2 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 text-[10px] sm:text-xs font-mono uppercase tracking-wider hover:bg-zinc-800 dark:hover:bg-white disabled:opacity-30 flex items-center gap-1.5 sm:gap-2 rounded-lg transition-colors flex-shrink-0"
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
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-xs font-mono"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>Extracting latest meeting data...</span>
              </motion.div>
            )}
            {isEmbedding && kgBuilt && (
              <motion.div
                initial={{ opacity: 0, y: -20 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -20 }}
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-gradient-to-r from-purple-600 to-blue-600 text-white px-5 py-2.5 rounded-full shadow-lg flex items-center gap-3 text-xs font-mono"
              >
                <Loader2 className="w-3 h-3 animate-spin" />
                <span>
                  {embedProgress.current === 1 && 'Embedding topics & meetings...'}
                  {embedProgress.current === 2 && 'Extracting cross-meeting relationships...'}
                  {embedProgress.current === 3 && 'Building edge matrix & graph...'}
                  {embedProgress.current === 0 && 'Preparing embedding pipeline...'}
                </span>
                <span className="text-white/60">{embedProgress.current}/{embedProgress.total}</span>
              </motion.div>
            )}
          </AnimatePresence>

          {!kgBuilt && !isExtractingNewKG ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-zinc-50 dark:bg-app-canvas text-zinc-800 dark:text-app-fg">
              {isLoadingKG ? (
                <div className="w-full max-w-md flex flex-col items-center">
                  <Loader2 className="w-16 h-16 animate-spin text-zinc-400 dark:text-zinc-500 mb-6" />
                  <h3 className="text-lg font-bold text-zinc-800 dark:text-app-fg mb-2">
                    Analyzing Meeting {kgProgress.current} of {kgProgress.total}
                  </h3>
                  <div className="w-full bg-zinc-200 dark:bg-app-chip rounded-full h-2.5 mb-4">
                    <motion.div 
                      className="bg-zinc-900 dark:bg-zinc-200 h-2.5 rounded-full" 
                      initial={{ width: 0 }}
                      animate={{ width: `${(kgProgress.current / kgProgress.total) * 100}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2">
                    Extracting topics, decisions, people, and action items...
                  </p>
                </div>
              ) : (
                <>
                  <Share2 className="w-16 h-16 text-zinc-300 dark:text-zinc-600 mb-6" />
                  <h3 className="text-lg font-serif italic text-zinc-500 dark:text-zinc-400">No Graph Built Yet</h3>
                  <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-2 max-w-md">
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
                  <div className="flex-none flex items-center gap-1.5 sm:gap-2 px-2 sm:px-3 py-1.5 sm:py-2 bg-app-panel dark:bg-app-raised border-b border-zinc-200/80 dark:border-app-border overflow-x-auto no-scrollbar">
                    <button
                      type="button"
                      onClick={() => setBrowsePanelOpen((v) => !v)}
                      className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-md border flex items-center gap-1.5 transition-colors ${
                        browsePanelOpen
                          ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                          : 'border-zinc-200 dark:border-app-border text-zinc-700 dark:text-app-fg-muted bg-app-panel dark:bg-app-panel hover:bg-zinc-50 dark:hover:bg-app-chip'
                      }`}
                      title="Open or close the meeting list"
                    >
                      <List className="w-3.5 h-3.5" />
                      <span className="hidden sm:inline">Meeting index</span>
                    </button>
                    <div className="h-4 w-px bg-zinc-200 dark:bg-app-border" />
                    <div className="flex items-center rounded-lg border border-zinc-200/90 dark:border-app-border p-0.5 bg-zinc-50 dark:bg-app-canvas">
                      <button
                        type="button"
                        onClick={() => {
                          setGraphViewMode('overview');
                          setEgoFocus(false);
                          setSelectedNode(null);
                        }}
                        className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-md flex items-center gap-1.5 transition-colors ${
                          graphViewMode === 'overview' ? 'bg-app-panel dark:bg-app-chip shadow-sm text-zinc-900 dark:text-app-fg' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-app-fg'
                        }`}
                        title="Only meetings and cross-meeting links — clearest map"
                      >
                        <LayoutGrid className="w-3.5 h-3.5" />
                        Overview
                      </button>
                      <button
                        type="button"
                        onClick={() => setGraphViewMode('full')}
                        className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-md flex items-center gap-1.5 transition-colors ${
                          graphViewMode === 'full' ? 'bg-app-panel dark:bg-app-chip shadow-sm text-zinc-900 dark:text-app-fg' : 'text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-app-fg'
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
                      className={`px-2.5 py-1.5 text-[10px] font-mono uppercase tracking-wide rounded-md border flex items-center gap-1.5 transition-colors ${
                        egoFocus && selectedNode
                          ? 'bg-violet-50 dark:bg-violet-950/50 border-violet-200 dark:border-violet-800 text-violet-900 dark:text-violet-200'
                          : 'border-zinc-200 dark:border-app-border text-zinc-600 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-app-chip'
                      } ${graphViewMode === 'overview' || !selectedNode ? 'opacity-40 pointer-events-none' : ''}`}
                      title={!selectedNode ? 'Select a node on the graph first' : 'Show only this node and its direct connections'}
                    >
                      <Crosshair className="w-3.5 h-3.5" />
                      Neighborhood
                    </button>
                    <div className="h-4 w-px bg-zinc-200 dark:bg-app-border hidden sm:block" />
                    <span className="text-[10px] text-zinc-500 dark:text-zinc-400 tabular-nums hidden sm:inline">
                      {displayGraphData.nodes.length} nodes · {displayGraphData.links.length} links
                    </span>
                    {graphViewMode === 'overview' && (
                      <span className="text-[10px] text-zinc-500 dark:text-zinc-400 ml-auto hidden sm:inline">Cross-meeting links only</span>
                    )}
                    <button
                      type="button"
                      onClick={() => graphRef.current?.zoomToFit(450, 70)}
                      className="ml-auto sm:ml-0 px-2 py-1 text-[9px] font-mono uppercase text-zinc-500 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-app-fg sm:hidden"
                    >
                      Fit
                    </button>
                  </div>

                  {graphViewMode === 'full' && (
                    <div className="flex-none px-3 py-2 bg-zinc-50 dark:bg-app-canvas border-b border-zinc-100 dark:border-app-border flex items-center gap-1.5 flex-wrap">
                      <Filter className="w-3 h-3 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                      <span className="text-[9px] font-mono uppercase text-zinc-500 dark:text-zinc-400 flex-shrink-0">Show:</span>
                      <button
                        onClick={() => setFilterType(null)}
                        className={`px-2 py-0.5 text-[9px] rounded-md transition-colors ${
                          !filterType ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-app-panel dark:bg-app-raised border border-zinc-200 dark:border-app-border text-zinc-700 dark:text-app-fg hover:bg-zinc-50 dark:hover:bg-app-chip'
                        }`}
                      >
                        All types
                      </button>
                      {nodeTypes.map(nt => (
                        <button
                          key={nt.type}
                          onClick={() => setFilterType(filterType === nt.type ? null : nt.type)}
                          className={`px-2 py-0.5 text-[9px] rounded-md transition-colors flex items-center gap-1 ${
                            filterType === nt.type ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900' : 'bg-app-panel dark:bg-app-raised border border-zinc-200 dark:border-app-border text-zinc-700 dark:text-app-fg hover:bg-zinc-50 dark:hover:bg-app-chip'
                          }`}
                        >
                          <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: nt.color }} />
                          {nt.label}
                        </button>
                      ))}
                    </div>
                  )}

                  <div ref={kgContainerRef} className="flex-1 bg-zinc-100 dark:bg-app-canvas relative min-h-0 overflow-hidden">
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
                            className="absolute left-0 top-0 bottom-0 w-72 z-30 flex flex-col bg-app-panel dark:bg-app-raised border-r border-zinc-200/90 dark:border-app-border shadow-2xl"
                          >
                            <div className="px-3 py-2.5 border-b border-zinc-100 dark:border-app-border bg-app-panel dark:bg-app-raised">
                              <div className="flex items-center justify-between">
                                <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400">
                                  <List className="w-3.5 h-3.5 flex-shrink-0" />
                                  Meeting index
                                  <span className="text-[9px] text-zinc-400 dark:text-zinc-500 tabular-nums">{meetingNodesSorted.length}</span>
                                </div>
                                <button
                                  type="button"
                                  onClick={() => setBrowsePanelOpen(false)}
                                  className="p-1.5 rounded-lg hover:bg-zinc-100 dark:hover:bg-app-chip text-zinc-500 dark:text-zinc-400"
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
                                        <p className="text-[9px] font-mono uppercase tracking-widest text-zinc-500 dark:text-zinc-500 px-1 pt-3 pb-1 first:pt-1">
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
                                            ? 'bg-zinc-900 text-white border-zinc-900 dark:bg-zinc-100 dark:text-zinc-900 dark:border-zinc-100'
                                            : 'bg-app-panel dark:bg-app-panel border-zinc-200/70 dark:border-app-border text-zinc-800 dark:text-app-fg hover:border-zinc-300 dark:hover:border-zinc-600 hover:bg-zinc-50 dark:hover:bg-app-chip'
                                        }`}
                                      >
                                        <span className="block text-[11px] leading-snug line-clamp-2 break-words">
                                          {m.label || 'Meeting'}
                                        </span>
                                        {dayLabel && (
                                          <span className={`block text-[9px] mt-0.5 tabular-nums ${isSel ? 'text-white/70 dark:text-zinc-600' : 'text-zinc-500 dark:text-zinc-400'}`}>
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
                        className="bg-app-panel dark:bg-app-raised border border-zinc-200/90 dark:border-app-border p-2 rounded-lg shadow-sm hover:bg-zinc-50 dark:hover:bg-app-chip text-zinc-700 dark:text-app-fg transition-colors"
                        title="Zoom In"
                        type="button"
                      >
                        <ZoomIn className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => graphRef.current?.zoom(graphRef.current.zoom() / 1.3, 300)}
                        className="bg-app-panel dark:bg-app-raised border border-zinc-200/90 dark:border-app-border p-2 rounded-lg shadow-sm hover:bg-zinc-50 dark:hover:bg-app-chip text-zinc-700 dark:text-app-fg transition-colors"
                        title="Zoom Out"
                        type="button"
                      >
                        <ZoomOut className="w-4 h-4" />
                      </button>
                      <button
                        onClick={() => { shouldAutoFitRef.current = false; graphRef.current?.zoomToFit(450, 70); }}
                        className="bg-app-panel dark:bg-app-raised border border-zinc-200/90 dark:border-app-border p-2 rounded-lg shadow-sm hover:bg-zinc-50 dark:hover:bg-app-chip text-zinc-700 dark:text-app-fg transition-colors"
                        title="Fit everything in view"
                        type="button"
                      >
                        <Maximize2 className="w-4 h-4" />
                      </button>
                    </div>

                    <div className="absolute top-3 left-3 z-10 max-w-[200px] sm:max-w-[220px] bg-app-panel/95 dark:bg-app-chip/95 backdrop-blur-sm border border-zinc-200/80 dark:border-app-border rounded-lg px-2.5 py-2 shadow-sm hidden sm:block">
                      <h4 className="text-[9px] font-mono uppercase tracking-widest text-zinc-500 dark:text-zinc-400 mb-1.5">Key</h4>
                      <div className="flex flex-wrap gap-x-2 gap-y-1">
                        {nodeTypes.map(item => (
                          <span key={item.label} className="inline-flex items-center gap-1 text-[9px] text-zinc-600 dark:text-zinc-300">
                            <span
                              className={`rounded-full ${item.shape === 'large' ? 'w-2.5 h-2.5' : item.shape === 'medium' ? 'w-2 h-2' : 'w-1.5 h-1.5'}`}
                              style={{ backgroundColor: item.color }}
                            />
                            {item.label}
                          </span>
                        ))}
                      </div>
                      <p className="text-[8px] text-zinc-500 dark:text-zinc-400 mt-2 leading-tight">Zoom in for more labels, or use the meeting list.</p>
                    </div>

                    <ForceGraph2D
                      ref={graphRef}
                      graphData={displayGraphData}
                      width={kgDimensions.width}
                      height={kgDimensions.height}
                      nodeLabel={(node: any) => `${node.type.toUpperCase()}: ${node.label}`}
                      nodeColor={(node: any) => node.color}
                      nodeVal={(node: any) => node.size}
                      linkColor={(link: any) =>
                        link.type === 'meeting-sibling'
                          ? link.color || '#9ca3af'
                          : themeResolved === 'dark'
                            ? 'rgba(120,120,135,0.4)'
                            : 'rgba(200,200,200,0.7)'}
                      linkWidth={(link: any) => (link.type === 'meeting-sibling' ? Math.min(0.6 + (link.weight || 0) / 8, 2.2) : 1)}
                      linkLineDash={(link: any) => link.type === 'meeting-sibling' ? [5, 4] : [2, 4]}
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
                        const isDarkBg = themeResolved === 'dark';
                        const isSel = selectedNode && node.id === selectedNode.id;
                        const isHover = hoveredNode && node.id === hoveredNode.id;
                        const label = node.label || '';
                        const showLabel = globalScale >= 0.5 || isSel || isHover;
                        const fontSize = node.type === 'meeting' ? 11 / globalScale : 9 / globalScale;
                        ctx.font = `${node.type === 'meeting' ? '600 ' : ''}${fontSize}px Inter, system-ui, sans-serif`;

                        const r = node.type === 'meeting' ? 10 : node.type === 'topic' ? 7 : 5;

                        if (node.type === 'meeting') {
                          ctx.beginPath();
                          ctx.arc((node as any).x + 1, (node as any).y + 1, r, 0, 2 * Math.PI, false);
                          ctx.fillStyle = isDarkBg ? 'rgba(0,0,0,0.35)' : 'rgba(0,0,0,0.08)';
                          ctx.fill();
                        }

                        if (isSel) {
                          ctx.beginPath();
                          ctx.arc(node.x, node.y, r + 4 / globalScale, 0, 2 * Math.PI, false);
                          ctx.strokeStyle = isDarkBg ? 'rgba(255,255,255,0.45)' : 'rgba(20, 20, 20, 0.45)';
                          ctx.lineWidth = 2.5 / globalScale;
                          ctx.stroke();
                        } else if (isHover) {
                          ctx.beginPath();
                          ctx.arc(node.x, node.y, r + 3 / globalScale, 0, 2 * Math.PI, false);
                          ctx.strokeStyle = isDarkBg ? 'rgba(255,255,255,0.22)' : 'rgba(20, 20, 20, 0.2)';
                          ctx.lineWidth = 1.5 / globalScale;
                          ctx.stroke();
                        }

                        ctx.beginPath();
                        ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                        ctx.fillStyle = node.color || '#888';
                        ctx.fill();

                        if (node.type === 'meeting') {
                          ctx.strokeStyle = isDarkBg ? '#27272a' : '#000';
                          ctx.lineWidth = 1.5 / globalScale;
                          ctx.stroke();
                        }

                        if (!showLabel) return;

                        const maxLen = node.type === 'meeting' ? 22 : 16;
                        const displayLabel = label.length > maxLen ? label.substring(0, maxLen) + '…' : label;
                        const textWidth = ctx.measureText(displayLabel).width;

                        ctx.fillStyle = isDarkBg ? 'rgba(30,30,34,0.94)' : 'rgba(255,255,255,0.94)';
                        const pad = 3;
                        const boxW = textWidth + pad * 2;
                        const boxH = fontSize + pad;
                        const rx = node.x - boxW / 2;
                        const ry = node.y + r + 2 / globalScale;
                        ctx.fillRect(rx, ry, boxW, boxH);

                        ctx.textAlign = 'center';
                        ctx.textBaseline = 'top';
                        ctx.fillStyle = isDarkBg ? '#e4e4e7' : '#1a1a1a';
                        ctx.fillText(displayLabel, node.x, ry + 2);
                      }}
                      cooldownTicks={180}
                      d3AlphaDecay={0.02}
                      d3VelocityDecay={0.32}
                      d3AlphaMin={0.01}
                      warmupTicks={60}
                    />
                  </div>
                </div>
              </div>

            </>
          )}
        </div>

        {/* Chat Panel - Bottom Sheet on Mobile, Side Panel on Desktop */}
        <AnimatePresence>
          {showChat && kgBuilt && (
            <>
              {/* Mobile Backdrop */}
              <motion.div
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="fixed inset-0 bg-black/30 z-30 sm:hidden"
                onClick={() => setShowChat(false)}
              />
              
              {/* Chat Panel */}
              <motion.div
                initial={{ y: '100%', opacity: 0 }}
                animate={{ y: 0, opacity: 1 }}
                exit={{ y: '100%', opacity: 0 }}
                transition={{ type: 'spring', damping: 25, stiffness: 300 }}
                className="fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto sm:left-auto sm:right-auto w-full sm:w-[380px] h-[70vh] sm:h-auto max-h-[70vh] sm:max-h-none flex-shrink-0 border-t sm:border-t-0 sm:border-l border-zinc-200 dark:border-app-border bg-app-panel dark:bg-app-raised flex flex-col z-40 sm:z-20 rounded-t-2xl sm:rounded-none shadow-[0_-4px_30px_rgba(0,0,0,0.15)] sm:shadow-[0_0_15px_rgba(0,0,0,0.05)] dark:sm:shadow-[0_0_20px_rgba(0,0,0,0.4)]"
              >
                {/* Drag Handle - Mobile Only */}
                <div className="flex justify-center py-2 sm:hidden">
                  <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-600 rounded-full" />
                </div>
                
                <div className="flex-none px-4 py-3 border-b border-zinc-100 dark:border-app-border flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-purple-500 dark:text-purple-400" />
                    <span className="text-sm font-bold text-zinc-900 dark:text-app-fg">Chat with Knowledge</span>
                  </div>
                  <button onClick={() => setShowChat(false)} className="p-1.5 hover:bg-zinc-100 dark:hover:bg-app-chip rounded-lg text-zinc-700 dark:text-app-fg">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Chat Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {chatMessages.length === 0 && (
                    <div className="text-center py-6">
                      <Sparkles className="w-8 h-8 mx-auto mb-3 text-zinc-300 dark:text-zinc-600" />
                      <p className="text-sm text-zinc-600 dark:text-zinc-300">Ask questions about your meetings</p>
                      <p className="text-xs text-zinc-500 dark:text-zinc-400 mt-1">e.g., "What decisions were made?"</p>
                    </div>
                  )}
                  {chatMessages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm ${
                        msg.role === 'user' 
                          ? 'bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 rounded-br-md' 
                          : 'bg-zinc-100 dark:bg-app-chip text-zinc-800 dark:text-app-fg rounded-bl-md'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  ))}
                  {isChatting && (
                    <div className="flex justify-start">
                      <div className="bg-zinc-100 dark:bg-app-chip px-4 py-3 rounded-2xl rounded-bl-md text-zinc-700 dark:text-app-fg">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat Input */}
                <div className="flex-none p-3 sm:p-4 border-t border-zinc-100 dark:border-app-border bg-app-panel dark:bg-app-raised">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleChatSubmit()}
                      placeholder="Ask about your meetings..."
                      className="flex-1 px-4 py-2.5 border border-zinc-200 dark:border-app-border rounded-full text-sm outline-none focus:border-zinc-900 dark:focus:border-zinc-300 bg-zinc-50 dark:bg-app-canvas text-zinc-900 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                      disabled={isChatting}
                    />
                    <button
                      onClick={handleChatSubmit}
                      disabled={isChatting || !chatInput.trim()}
                      className="p-2.5 bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 rounded-full disabled:opacity-30 hover:bg-zinc-800 dark:hover:bg-white transition-colors"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            </>
          )}
        </AnimatePresence>

        {/* Node Detail Panel - Bottom Sheet on Mobile */}
        <AnimatePresence>
          {selectedNode && !showChat && (
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
                className="fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto sm:left-auto sm:right-auto w-full sm:w-[380px] max-h-[70vh] sm:max-h-none flex-shrink-0 bg-app-panel dark:bg-app-raised border-t sm:border-t-0 sm:border-l border-zinc-200 dark:border-app-border overflow-y-auto overflow-x-hidden z-40 sm:z-20 rounded-t-2xl sm:rounded-none shadow-[0_-4px_30px_rgba(0,0,0,0.15)] sm:shadow-[0_0_15px_rgba(0,0,0,0.05)] dark:sm:shadow-[0_0_20px_rgba(0,0,0,0.4)]"
              >
                {/* Drag Handle - Mobile Only */}
                <div className="flex justify-center py-2 sm:hidden">
                  <div className="w-10 h-1 bg-zinc-300 dark:bg-zinc-600 rounded-full" />
                </div>
              <div className="p-4 border-b border-zinc-100 dark:border-app-border flex items-center justify-between sticky top-0 bg-app-panel dark:bg-app-raised z-10">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                  <span className="text-[10px] font-mono uppercase font-bold text-zinc-500 dark:text-zinc-400 tracking-wider">
                    {selectedNode.type}
                  </span>
                </div>
                <button 
                  onClick={() => setSelectedNode(null)} 
                  className="p-1 hover:bg-zinc-100 dark:hover:bg-app-chip rounded text-zinc-700 dark:text-app-fg"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              
              <div className="p-4 text-zinc-900 dark:text-app-fg">
                <h3 className="font-bold text-lg mb-4">{selectedNode.label}</h3>
                
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
                        <div className="p-3 bg-amber-50 dark:bg-amber-950/30 rounded-lg border border-amber-200 dark:border-amber-800/50 text-center">
                          <p className="text-xs text-amber-800 dark:text-amber-200 font-medium mb-1">
                            {hasAny ? 'Topics not extracted' : 'No insights extracted'}
                          </p>
                          <p className="text-[10px] text-amber-600 dark:text-amber-400 mb-2">
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
                              className="px-3 py-1.5 bg-amber-600 hover:bg-amber-700 disabled:bg-amber-400 text-white text-[11px] font-medium rounded-lg transition-colors"
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
                        <h4 className="text-[10px] font-mono uppercase text-zinc-500 dark:text-zinc-400 mb-2 flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> Topics
                        </h4>
                        <div className="space-y-2">
                          {validTopics.map((t: any, i: number) => (
                            <div key={i} className="p-2 bg-zinc-50 dark:bg-app-canvas rounded-lg border border-transparent dark:border-app-border/60">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-semibold text-zinc-900 dark:text-app-fg">{t.name}</span>
                                <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                                  t.status === 'resolved' ? 'bg-green-100 text-green-700' :
                                  t.status === 'off-track' ? 'bg-red-100 text-red-700' :
                                  t.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                }`}>{t.status}</span>
                              </div>
                              {t.summary && <p className="text-[11px] text-zinc-600 dark:text-zinc-300">{t.summary}</p>}
                            </div>
                          ))}
                        </div>
                      </div>
                      );
                    })()}
                    
                    {(selectedNode.data.people || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-zinc-500 dark:text-zinc-400 mb-2 flex items-center gap-1">
                          <Users className="w-3 h-3" /> People
                        </h4>
                        <div className="flex flex-wrap gap-1">
                          {selectedNode.data.people.map((p: string, i: number) => (
                            <span key={i} className="px-2 py-1 bg-cyan-50 dark:bg-cyan-950/50 text-cyan-700 dark:text-cyan-200 text-[10px] rounded border border-cyan-100/80 dark:border-cyan-800/40">{p}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {(selectedNode.data.decisions || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-zinc-500 dark:text-zinc-400 mb-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Decisions
                        </h4>
                        <ul className="space-y-1">
                          {selectedNode.data.decisions.map((d: any, i: number) => (
                            <li key={i} className="text-xs text-yellow-950 dark:text-yellow-100 bg-yellow-50 dark:bg-yellow-950/40 border border-yellow-100/80 dark:border-yellow-900/40 p-2 rounded">• {d.decision}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(selectedNode.data.actionItems || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-zinc-500 dark:text-zinc-400 mb-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Action Items
                        </h4>
                        <ul className="space-y-2">
                          {selectedNode.data.actionItems.map((a: any, i: number) => (
                            <li key={i} className="p-2 bg-pink-50 dark:bg-pink-950/40 rounded-lg border border-pink-100/80 dark:border-pink-900/40">
                              <span className="text-sm font-medium text-pink-900 dark:text-pink-100 block mb-1">{a.task}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-pink-600 dark:text-pink-300 font-medium">Assignee: {a.owner}</span>
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
                        <div className="border-t border-zinc-200 dark:border-app-border pt-5 mt-5">
                          <h4 className="text-[10px] font-mono uppercase tracking-widest text-zinc-500 dark:text-zinc-400 mb-4 flex items-center gap-2">
                            <Share2 className="w-3 h-3" />
                            Connected Meetings ({relatedMeetings.length})
                          </h4>
                          <div className="space-y-3">
                            {relatedMeetings.slice(0, 5).map((related, idx) => (
                              <ExpandableMeetingCard key={idx} related={related} idx={idx} />
                            ))}
                          </div>
                          {relatedMeetings.length > 5 && (
                            <button className="w-full mt-3 py-2 text-[10px] font-mono uppercase tracking-wider text-zinc-500 dark:text-zinc-400 hover:text-zinc-800 dark:hover:text-app-fg bg-zinc-50 dark:bg-app-canvas hover:bg-zinc-100 dark:hover:bg-app-chip rounded-lg transition-colors border border-transparent dark:border-app-border/50">
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
                    <div className={`px-2 py-1 rounded text-xs inline-block ${
                      selectedNode.data.status === 'resolved' ? 'bg-green-100 text-green-700' :
                      selectedNode.data.status === 'off-track' ? 'bg-red-100 text-red-700' :
                      selectedNode.data.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                    }`}>
                      Status: {selectedNode.data.status}
                    </div>
                    <p className="text-sm text-zinc-700 dark:text-zinc-200">{selectedNode.data.summary}</p>
                    
                    {selectedNode.data.allStatuses && selectedNode.data.allStatuses.length > 1 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-zinc-500 dark:text-zinc-400 mb-2 flex items-center gap-1">
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
                                <span className="text-[10px] font-medium text-zinc-800 dark:text-app-fg">{status}</span>
                                <p className="text-[10px] text-zinc-600 dark:text-zinc-300 italic">"{selectedNode.data.allSummaries?.[idx]}"</p>
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
                        <p className="font-bold">{selectedNode.label}</p>
                        <p className="text-xs text-zinc-500 dark:text-zinc-400">
                          {selectedNode.data.meetings?.length || 0} meeting(s)
                        </p>
                      </div>
                    </div>
                    {selectedNode.data.meetings && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-zinc-500 dark:text-zinc-400 mb-2">Present in:</h4>
                        <ul className="space-y-1">
                          {selectedNode.data.meetings.map((m: string, i: number) => (
                            <li key={i} className="text-xs text-zinc-800 dark:text-zinc-200 bg-zinc-50 dark:bg-app-canvas p-2 rounded border border-transparent dark:border-app-border/60">
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
                    <div className="p-3 bg-yellow-50 dark:bg-yellow-950/40 rounded-lg border border-yellow-100 dark:border-yellow-900/40">
                      <p className="text-sm text-yellow-900 dark:text-yellow-100">{selectedNode.data.decision}</p>
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-300">
                      <p><strong>Related Topic:</strong> {selectedNode.data.relatedTopic || 'General'}</p>
                      <p><strong>Meeting:</strong> {selectedNode.data.meetingTitle?.replace(/\.[^.]+$/, '')}</p>
                    </div>
                  </div>
                )}

                {selectedNode.type === 'action' && selectedNode.data && (
                  <div className="space-y-4">
                    <div className="p-3 bg-pink-50 dark:bg-pink-950/40 rounded-lg border border-pink-100 dark:border-pink-900/40">
                      <p className="text-sm text-pink-900 dark:text-pink-100">{selectedNode.data.task}</p>
                    </div>
                    <div className="text-xs text-zinc-600 dark:text-zinc-300">
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
