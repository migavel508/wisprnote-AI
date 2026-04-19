import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
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
  Maximize2
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

interface KnowledgePageProps {
  kgData: any[];
  isLoadingKG: boolean;
  kgProgress: { current: number; total: number };
  isExtractingNewKG: boolean;
  kgBuilt: boolean;
  buildKnowledgeGraph: () => void;
  historyLength: number;
  isInitialLoading?: boolean;
}

export default function KnowledgePage({
  kgData,
  isLoadingKG,
  kgProgress,
  isExtractingNewKG,
  kgBuilt,
  buildKnowledgeGraph,
  historyLength,
  isInitialLoading = false
}: KnowledgePageProps) {
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<any[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [chatMessages, setChatMessages] = useState<Array<{ role: 'user' | 'assistant'; content: string }>>([]);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [filterType, setFilterType] = useState<string | null>(null);
  const [kgDimensions, setKgDimensions] = useState({ width: 800, height: 600 });
  
  const kgContainerRef = useRef<HTMLDivElement>(null);
  const graphRef = useRef<any>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const kgArtifactRef = useRef<KGBuildArtifact | null>(null);
  const [isEmbedding, setIsEmbedding] = useState(false);
  const [embedProgress, setEmbedProgress] = useState({ current: 0, total: 3 });

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

  // Fingerprint of the kgData the last artifact was built from
  const lastBuildKeyRef = useRef('');

  // Clear the artifact when a rebuild is initiated (kgBuilt goes false)
  useEffect(() => {
    if (!kgBuilt) {
      kgArtifactRef.current = null;
      lastBuildKeyRef.current = '';
    }
  }, [kgBuilt]);

  // Compute a stable data fingerprint so we can detect actual data changes
  const kgDataKey = useMemo(() => {
    if (kgData.length === 0) return '';
    return kgData.map((m: any) => m.meetingId).sort().join(',');
  }, [kgData]);

  // Embedding pipeline: runs once when kgData is available after extraction
  // Re-runs if kgData changes (rebuild or new meeting auto-synced)
  useEffect(() => {
    if (!kgBuilt || kgData.length === 0 || isEmbedding) return;
    // Skip if artifact already built from the same data
    if (kgArtifactRef.current && lastBuildKeyRef.current === kgDataKey) return;

    let cancelled = false;
    const run = async () => {
      setIsEmbedding(true);
      setEmbedProgress({ current: 0, total: 3 });
      try {
        const artifact = await buildKnowledgeGraphPipeline(
          kgData as MeetingRecord[],
          (current, total) => {
            if (!cancelled) setEmbedProgress({ current, total });
          }
        );
        if (!cancelled) {
          kgArtifactRef.current = artifact;
          lastBuildKeyRef.current = kgDataKey;
        }
      } catch (err) {
        console.error('Embedding pipeline failed:', err);
      } finally {
        if (!cancelled) setIsEmbedding(false);
      }
    };
    run();
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

    const artifact = kgArtifactRef.current;
    if (artifact && artifact.embeddings.size) {
      return buildGraphDataUtil(
        kgData as MeetingRecord[],
        artifact.embeddings,
        artifact.meetingEdgeMatrix,
        artifact.relationships,
        filterType
      );
    }

    // Fallback: build a basic graph from raw kgData without embeddings
    return buildGraphDataUtil(
      kgData as MeetingRecord[],
      new Map(),           // empty embeddings
      new Map(),           // empty edge matrix
      [],                  // no relationships
      filterType
    );
  }, [kgDataKey, filterType, isEmbedding]);

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

  // Focus on a node from search
  const focusOnNode = (node: any) => {
    setSelectedNode(node);
    setSearchQuery('');
    setSearchResults([]);
    
    if (graphRef.current) {
      const graphNode = graphData.nodes.find((n: any) => n.id === node.id);
      if (graphNode && graphNode.x !== undefined && graphNode.y !== undefined) {
        graphRef.current.centerAt(graphNode.x, graphNode.y, 1000);
      }
    }
  };

  // O(1) related meetings lookup from pre-built edge matrix
  const findRelatedMeetings = useCallback((meetingId: string): MeetingEdge[] => {
    const artifact = kgArtifactRef.current;
    if (!artifact) return [];
    return findRelatedMeetingsUtil(meetingId, artifact.meetingEdgeMatrix);
  }, [isEmbedding]);

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
      <div key={idx} className="bg-gradient-to-br from-purple-50/80 to-blue-50/80 rounded-xl border border-purple-100/50 overflow-hidden transition-all duration-300 hover:shadow-md">
        {/* Collapsed Header (Always visible) */}
        <div 
          className="p-3.5 flex items-center justify-between cursor-pointer hover:bg-white/40 transition-colors group"
          onClick={() => setIsExpanded(!isExpanded)}
        >
          <div className="flex-1 min-w-0 pr-3">
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-sm font-bold text-gray-800 truncate group-hover:text-purple-700 transition-colors">
                {relatedMeetingData.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
              </span>
              <span className="text-[9px] px-2 py-0.5 bg-purple-200/50 text-purple-800 rounded-md font-mono shrink-0 font-medium">
                {related.totalScore.toFixed(1)} pts
              </span>
            </div>
            <div className="text-[10px] text-gray-500 truncate flex items-center gap-1.5 flex-wrap">
              {related.relationships.length > 0 && related.relationships.map((r, rIdx) => (
                <span key={rIdx} className={`text-[8px] px-1.5 py-0.5 rounded font-mono ${REL_BADGE_COLORS[r.relationshipType] || 'bg-gray-100 text-gray-600'}`}>
                  {r.relationshipType}
                </span>
              ))}
              {related.embeddingScore > 0 && (
                <span className="flex items-center gap-1 bg-white/60 px-1.5 py-0.5 rounded text-gray-600">
                  sim: {(related.embeddingScore * 100).toFixed(0)}%
                </span>
              )}
            </div>
          </div>
          <div className={`shrink-0 p-1.5 bg-white/80 rounded-lg text-purple-600 shadow-sm transition-transform duration-300 ${isExpanded ? '-rotate-90 bg-purple-100' : 'rotate-90'}`}>
            <ChevronRight className="w-3.5 h-3.5" />
          </div>
        </div>

        {/* Expanded Content */}
        {isExpanded && (
          <div className="p-3 pt-0 border-t border-purple-100 bg-white/40">
            <div className="pt-3">
              {/* Contextual Relationships */}
              {related.relationships.length > 0 && (
                <div className="mb-3 space-y-1.5">
                  {related.relationships.map((r, rIdx) => (
                    <div key={rIdx} className="p-2 bg-white/70 rounded border border-purple-200">
                      <div className="flex items-center gap-2 mb-1">
                        <span className={`text-[8px] px-1.5 py-0.5 rounded font-mono font-medium ${REL_BADGE_COLORS[r.relationshipType] || 'bg-gray-100 text-gray-600'}`}>
                          {r.relationshipType}
                        </span>
                        <span className="text-[8px] text-gray-400 font-mono">{r.confidence}</span>
                      </div>
                      <p className="text-[10px] text-gray-700">{r.sharedThread}</p>
                    </div>
                  ))}
                </div>
              )}
              
              {/* What Was Discussed in That Meeting - All Topics */}
              {(relatedMeetingData.topics || []).length > 0 && (
                <div className="mb-3">
                  <span className="text-[9px] font-mono uppercase text-indigo-700 block mb-2 flex items-center gap-1">
                    <MessageSquare className="w-3 h-3" />
                    What Was Discussed:
                  </span>
                  <div className="space-y-1.5">
                    {(relatedMeetingData.topics || []).map((topic: any, tIdx: number) => (
                      <div key={tIdx} className="p-2 rounded bg-white/80">
                        <div className="flex items-start justify-between gap-2 mb-1">
                          <span className="text-[10px] font-semibold text-gray-800">
                            {topic.name}
                          </span>
                          <span className={`text-[8px] px-1 py-0.5 rounded font-mono shrink-0 ${
                            topic.status === 'resolved' ? 'bg-green-100 text-green-700' :
                            topic.status === 'off-track' ? 'bg-red-100 text-red-700' :
                            topic.status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                            topic.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                          }`}>{topic.status}</span>
                        </div>
                        <p className="text-[9px] text-gray-600 leading-relaxed line-clamp-2 hover:line-clamp-none transition-all">"{topic.summary}"</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              
              {/* Decisions and Actions */}
              <div className="grid grid-cols-1 gap-2 mt-3">
                {(relatedMeetingData.decisions || []).length > 0 && (
                  <div className="bg-yellow-50/50 rounded p-2 border border-yellow-100">
                    <span className="text-[9px] font-mono uppercase text-yellow-700 block mb-1">Decisions</span>
                    <ul className="space-y-1">
                      {(relatedMeetingData.decisions || []).slice(0, 2).map((dec: any, dIdx: number) => (
                        <li key={dIdx} className="text-[9px] text-yellow-900 truncate">• {dec.decision}</li>
                      ))}
                    </ul>
                  </div>
                )}
                
                {(relatedMeetingData.actionItems || []).length > 0 && (
                  <div className="bg-pink-50/50 rounded p-2 border border-pink-100">
                    <span className="text-[9px] font-mono uppercase text-pink-700 block mb-1">Actions</span>
                    <ul className="space-y-1">
                      {(relatedMeetingData.actionItems || []).slice(0, 2).map((action: any, aIdx: number) => (
                        <li key={aIdx} className="text-[9px] text-pink-900 truncate">
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
      const artifact = kgArtifactRef.current;
      const systemPrompt = artifact
        ? buildChatContext(
            kgData as MeetingRecord[],
            artifact.meetingEdgeMatrix,
            artifact.relationships
          )
        : `You are a helpful assistant that answers questions about the user's meeting knowledge graph.\n${kgData.map((m: any, i: number) => `Meeting ${i + 1}: ${m.meetingTitle}\n- Topics: ${(m.topics || []).map((t: any) => `${t.name} (${t.status}): ${t.summary}`).join('; ') || 'None'}\n- Decisions: ${(m.decisions || []).map((d: any) => d.decision).join('; ') || 'None'}\n- People: ${(m.people || []).join(', ') || 'None'}\n- Actions: ${(m.actionItems || []).map((a: any) => `${a.owner}: ${a.task}`).join('; ') || 'None'}`).join('\n\n')}\n\nAnswer the user's question based on this data. Be concise and helpful.`;

      const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
      if (!geminiApiKey) throw new Error('Missing Gemini API key');

      const response = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-3-flash-preview:generateContent?key=${geminiApiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [
              { role: 'user', parts: [{ text: systemPrompt }] },
              { role: 'model', parts: [{ text: 'I understand. I will help answer questions about your meeting knowledge graph based on the data provided.' }] },
              { role: 'user', parts: [{ text: userMessage }] }
            ],
            generationConfig: { temperature: 0.7, maxOutputTokens: 1024 }
          })
        }
      );

      const data = await response.json();
      const assistantMessage = data.candidates?.[0]?.content?.parts?.[0]?.text || 'Sorry, I could not generate a response.';
      
      setChatMessages(prev => [...prev, { role: 'assistant', content: assistantMessage }]);
    } catch (error) {
      console.error('Chat error:', error);
      setChatMessages(prev => [...prev, { role: 'assistant', content: 'Sorry, there was an error processing your question.' }]);
    } finally {
      setIsChatting(false);
    }
  };

  // Node type colors for legend
  const nodeTypes = [
    { type: 'meeting', color: '#141414', label: 'Meeting', shape: 'large' },
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
    <div className="absolute inset-0 flex flex-col bg-white overflow-hidden">
      {/* Header */}
      <div className="flex-none bg-white border-b border-[#141414]/10 px-4 sm:px-6 py-3 sm:py-4">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 sm:gap-4">
          <div>
            <h2 className="text-lg sm:text-xl font-serif italic font-bold flex items-center gap-2">
              <Network className="w-4 sm:w-5 h-4 sm:h-5" />
              Knowledge Graph
            </h2>
            <p className="text-[10px] sm:text-xs opacity-50 mt-0.5 hidden sm:block">Cross-meeting memory — see how topics, decisions, and people connect</p>
          </div>
          
          <div className="flex items-center gap-2 sm:gap-3 overflow-x-auto">
            {/* Search - Hidden on mobile, shown as icon */}
            <div className="relative hidden sm:block">
              <div className="flex items-center gap-2 border border-[#141414]/20 bg-white px-3 py-2 rounded-lg w-48 lg:w-64">
                <Search className="w-4 h-4 opacity-40" />
                <input
                  type="text"
                  placeholder="Search nodes..."
                  value={searchQuery}
                  onChange={(e) => handleSearch(e.target.value)}
                  className="bg-transparent border-none outline-none text-sm w-full"
                />
                {searchQuery && (
                  <button onClick={() => { setSearchQuery(''); setSearchResults([]); }}>
                    <X className="w-3 h-3 opacity-40 hover:opacity-100" />
                  </button>
                )}
              </div>
              
              {/* Search Results Dropdown */}
              {searchResults.length > 0 && (
                <div className="absolute top-full left-0 right-0 mt-1 bg-white border border-[#141414]/10 rounded-lg shadow-lg z-50 max-h-64 overflow-y-auto">
                  {searchResults.map((result, idx) => (
                    <button
                      key={idx}
                      onClick={() => focusOnNode(result)}
                      className="w-full px-3 py-2 text-left hover:bg-gray-50 flex items-center gap-2 border-b border-gray-100 last:border-0"
                    >
                      <span 
                        className="w-2 h-2 rounded-full flex-shrink-0" 
                        style={{ backgroundColor: result.color }} 
                      />
                      <span className="text-xs font-medium truncate">{result.label}</span>
                      <span className="text-[10px] text-gray-400 uppercase ml-auto">{result.type}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>

            {/* Chat Toggle */}
            <button
              onClick={() => setShowChat(!showChat)}
              className={`px-3 sm:px-4 py-2 text-[10px] sm:text-xs font-mono uppercase tracking-wider flex items-center gap-1.5 sm:gap-2 rounded-lg transition-colors flex-shrink-0 ${
                showChat ? 'bg-[#141414] text-white' : 'border border-[#141414]/20 hover:bg-gray-50'
              }`}
            >
              <Sparkles className="w-3.5 sm:w-4 h-3.5 sm:h-4" />
              <span className="hidden sm:inline">Chat</span>
            </button>

            {/* Build/Rebuild Button */}
            <button 
              onClick={buildKnowledgeGraph}
              disabled={isLoadingKG || historyLength === 0}
              className="px-3 sm:px-4 py-2 bg-[#141414] text-white text-[10px] sm:text-xs font-mono uppercase tracking-wider hover:bg-[#333] disabled:opacity-30 flex items-center gap-1.5 sm:gap-2 rounded-lg transition-colors flex-shrink-0"
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
                className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-[#141414] text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-xs font-mono"
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
            <div className="flex-1 flex flex-col items-center justify-center text-center p-8 bg-[#FAFAFA]">
              {isLoadingKG ? (
                <div className="w-full max-w-md flex flex-col items-center">
                  <Loader2 className="w-16 h-16 animate-spin opacity-20 mb-6" />
                  <h3 className="text-lg font-bold opacity-80 mb-2">
                    Analyzing Meeting {kgProgress.current} of {kgProgress.total}
                  </h3>
                  <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
                    <motion.div 
                      className="bg-[#141414] h-2.5 rounded-full" 
                      initial={{ width: 0 }}
                      animate={{ width: `${(kgProgress.current / kgProgress.total) * 100}%` }}
                      transition={{ duration: 0.5 }}
                    />
                  </div>
                  <p className="text-xs opacity-50 mt-2">
                    Extracting topics, decisions, people, and action items...
                  </p>
                </div>
              ) : (
                <>
                  <Share2 className="w-16 h-16 opacity-10 mb-6" />
                  <h3 className="text-lg font-serif italic opacity-30">No Graph Built Yet</h3>
                  <p className="text-xs opacity-30 mt-2 max-w-md">
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
              {/* Filter Bar */}
              <div className="flex-none px-4 py-2 bg-[#FAFAFA] border-b border-gray-100 flex items-center gap-2">
                <Filter className="w-3 h-3 opacity-40" />
                <span className="text-[10px] font-mono uppercase opacity-40">Filter:</span>
                <button
                  onClick={() => setFilterType(null)}
                  className={`px-2 py-1 text-[10px] rounded-md transition-colors ${
                    !filterType ? 'bg-[#141414] text-white' : 'bg-white border border-gray-200 hover:bg-gray-50'
                  }`}
                >
                  All
                </button>
                {nodeTypes.map(nt => (
                  <button
                    key={nt.type}
                    onClick={() => setFilterType(filterType === nt.type ? null : nt.type)}
                    className={`px-2 py-1 text-[10px] rounded-md transition-colors flex items-center gap-1 ${
                      filterType === nt.type ? 'bg-[#141414] text-white' : 'bg-white border border-gray-200 hover:bg-gray-50'
                    }`}
                  >
                    <span className="w-1.5 h-1.5 rounded-full" style={{ backgroundColor: nt.color }} />
                    {nt.label}
                  </button>
                ))}
              </div>

              {/* Graph Canvas */}
              <div ref={kgContainerRef} className="flex-1 bg-[#FAFAFA] relative min-h-0">
                {/* Graph Controls */}
                <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-2">
                  <button 
                    onClick={() => graphRef.current?.zoom(graphRef.current.zoom() * 1.3, 300)}
                    className="bg-white border border-gray-200 p-2 rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
                    title="Zoom In"
                  >
                    <ZoomIn className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => graphRef.current?.zoom(graphRef.current.zoom() / 1.3, 300)}
                    className="bg-white border border-gray-200 p-2 rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
                    title="Zoom Out"
                  >
                    <ZoomOut className="w-4 h-4" />
                  </button>
                  <button 
                    onClick={() => graphRef.current?.zoomToFit(400, 50)}
                    className="bg-white border border-gray-200 p-2 rounded-lg shadow-sm hover:bg-gray-50 transition-colors"
                    title="Fit View"
                  >
                    <Maximize2 className="w-4 h-4" />
                  </button>
                </div>

                {/* Legend - Hidden on mobile */}
                <div className="absolute top-4 left-4 z-10 bg-white/95 backdrop-blur-sm border border-gray-200 rounded-lg p-2 sm:p-3 shadow-sm hidden sm:block">
                  <h4 className="text-[10px] font-mono uppercase tracking-widest opacity-50 mb-2">Legend</h4>
                  <div className="space-y-1.5">
                    {nodeTypes.map(item => (
                      <div key={item.label} className="flex items-center gap-2">
                        <span 
                          className={`rounded-full ${item.shape === 'large' ? 'w-3 h-3' : item.shape === 'medium' ? 'w-2.5 h-2.5' : 'w-2 h-2'}`} 
                          style={{ backgroundColor: item.color }} 
                        />
                        <span className="text-[10px] text-gray-600">{item.label}</span>
                      </div>
                    ))}
                  </div>
                </div>

                <ForceGraph2D
                  ref={graphRef}
                  graphData={graphData}
                  width={kgDimensions.width}
                  height={kgDimensions.height}
                  nodeLabel={(node: any) => `${node.type.toUpperCase()}: ${node.label}`}
                  nodeColor={(node: any) => node.color}
                  nodeVal={(node: any) => node.size}
                  linkColor={(link: any) => link.type === 'meeting-sibling' ? (link.color || '#9ca3af') : '#e5e5e5'}
                  linkWidth={(link: any) => link.type === 'meeting-sibling' ? Math.min(1 + (link.weight || 0) / 5, 2) : 1.5}
                  linkLineDash={(link: any) => link.type === 'meeting-sibling' ? [4, 3] : undefined}
                  linkLabel={(link: any) => link.type === 'meeting-sibling' && link.label ? link.label : ''}
                  minZoom={0.3}
                  maxZoom={10}
                  onNodeClick={(node: any) => {
                    setSelectedNode(node);
                    if (graphRef.current) {
                      graphRef.current.centerAt(node.x, node.y, 800);
                    }
                  }}
                  onNodeDragEnd={(node: any) => {
                    const bounds = 2000;
                    node.fx = Math.max(-bounds, Math.min(bounds, node.x));
                    node.fy = Math.max(-bounds, Math.min(bounds, node.y));
                  }}
                  nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                    const label = node.label || '';
                    const fontSize = node.type === 'meeting' ? 12 / globalScale : 10 / globalScale;
                    ctx.font = `${node.type === 'meeting' ? 'bold ' : ''}${fontSize}px Inter, system-ui, sans-serif`;
                    
                    // Draw node circle with better sizing
                    const r = node.type === 'meeting' ? 10 : node.type === 'topic' ? 7 : 5;
                    
                    // Draw shadow for meetings
                    if (node.type === 'meeting') {
                      ctx.beginPath();
                      ctx.arc(node.x + 1, node.y + 1, r, 0, 2 * Math.PI, false);
                      ctx.fillStyle = 'rgba(0,0,0,0.1)';
                      ctx.fill();
                    }
                    
                    ctx.beginPath();
                    ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                    ctx.fillStyle = node.color || '#888';
                    ctx.fill();
                    
                    // Draw border for meeting nodes
                    if (node.type === 'meeting') {
                      ctx.strokeStyle = '#000';
                      ctx.lineWidth = 2 / globalScale;
                      ctx.stroke();
                    }
                    
                    // Draw label with background for better readability
                    const maxLen = node.type === 'meeting' ? 18 : 14;
                    const displayLabel = label.length > maxLen ? label.substring(0, maxLen) + '...' : label;
                    const textWidth = ctx.measureText(displayLabel).width;
                    
                    // Label background
                    ctx.fillStyle = 'rgba(255,255,255,0.85)';
                    ctx.fillRect(node.x - textWidth / 2 - 2, node.y + r + 1, textWidth + 4, fontSize + 2);
                    
                    // Label text
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'top';
                    ctx.fillStyle = '#333';
                    ctx.fillText(displayLabel, node.x, node.y + r + 2);
                  }}
                  cooldownTicks={150}
                  d3AlphaDecay={0.015}
                  d3VelocityDecay={0.25}
                  d3AlphaMin={0.001}
                  warmupTicks={50}
                />
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
                className="fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto sm:left-auto sm:right-auto w-full sm:w-[380px] h-[70vh] sm:h-auto max-h-[70vh] sm:max-h-none flex-shrink-0 border-t sm:border-t-0 sm:border-l border-gray-200 bg-white flex flex-col z-40 sm:z-20 rounded-t-[20px] sm:rounded-none shadow-[0_-4px_30px_rgba(0,0,0,0.15)] sm:shadow-[0_0_15px_rgba(0,0,0,0.05)]"
              >
                {/* Drag Handle - Mobile Only */}
                <div className="flex justify-center py-2 sm:hidden">
                  <div className="w-10 h-1 bg-gray-300 rounded-full" />
                </div>
                
                <div className="flex-none px-4 py-3 border-b border-gray-100 flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-purple-500" />
                    <span className="text-sm font-bold">Chat with Knowledge</span>
                  </div>
                  <button onClick={() => setShowChat(false)} className="p-1.5 hover:bg-gray-100 rounded-lg">
                    <X className="w-4 h-4" />
                  </button>
                </div>

                {/* Chat Messages */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3">
                  {chatMessages.length === 0 && (
                    <div className="text-center py-6">
                      <Sparkles className="w-8 h-8 mx-auto mb-3 opacity-20" />
                      <p className="text-sm text-gray-500">Ask questions about your meetings</p>
                      <p className="text-xs text-gray-400 mt-1">e.g., "What decisions were made?"</p>
                    </div>
                  )}
                  {chatMessages.map((msg, idx) => (
                    <div key={idx} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] px-3 py-2 rounded-2xl text-sm ${
                        msg.role === 'user' 
                          ? 'bg-[#141414] text-white rounded-br-md' 
                          : 'bg-gray-100 text-gray-800 rounded-bl-md'
                      }`}>
                        {msg.content}
                      </div>
                    </div>
                  ))}
                  {isChatting && (
                    <div className="flex justify-start">
                      <div className="bg-gray-100 px-4 py-3 rounded-2xl rounded-bl-md">
                        <Loader2 className="w-4 h-4 animate-spin" />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Chat Input */}
                <div className="flex-none p-3 sm:p-4 border-t border-gray-100 bg-white">
                  <div className="flex items-center gap-2">
                    <input
                      type="text"
                      value={chatInput}
                      onChange={(e) => setChatInput(e.target.value)}
                      onKeyDown={(e) => e.key === 'Enter' && handleChatSubmit()}
                      placeholder="Ask about your meetings..."
                      className="flex-1 px-4 py-2.5 border border-gray-200 rounded-full text-sm outline-none focus:border-[#141414] bg-gray-50"
                      disabled={isChatting}
                    />
                    <button
                      onClick={handleChatSubmit}
                      disabled={isChatting || !chatInput.trim()}
                      className="p-2.5 bg-[#141414] text-white rounded-full disabled:opacity-30 hover:bg-[#333] transition-colors"
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
                className="fixed bottom-0 left-0 right-0 sm:relative sm:bottom-auto sm:left-auto sm:right-auto w-full sm:w-[380px] max-h-[70vh] sm:max-h-none flex-shrink-0 bg-white border-t sm:border-t-0 sm:border-l border-gray-200 overflow-y-auto overflow-x-hidden z-40 sm:z-20 rounded-t-[20px] sm:rounded-none shadow-[0_-4px_30px_rgba(0,0,0,0.15)] sm:shadow-[0_0_15px_rgba(0,0,0,0.05)]"
              >
                {/* Drag Handle - Mobile Only */}
                <div className="flex justify-center py-2 sm:hidden">
                  <div className="w-10 h-1 bg-gray-300 rounded-full" />
                </div>
              <div className="p-4 border-b border-gray-100 flex items-center justify-between sticky top-0 bg-white z-10">
                <div className="flex items-center gap-2">
                  <span className="w-3 h-3 rounded-full" style={{ backgroundColor: selectedNode.color }} />
                  <span className="text-[10px] font-mono uppercase font-bold text-gray-500 tracking-wider">
                    {selectedNode.type}
                  </span>
                </div>
                <button 
                  onClick={() => setSelectedNode(null)} 
                  className="p-1 hover:bg-gray-100 rounded"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
              
              <div className="p-4">
                <h3 className="font-bold text-lg mb-4">{selectedNode.label}</h3>
                
                {selectedNode.type === 'meeting' && selectedNode.data && (
                  <div className="space-y-4">
                    {(selectedNode.data.topics || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-gray-400 mb-2 flex items-center gap-1">
                          <MessageSquare className="w-3 h-3" /> Topics
                        </h4>
                        <div className="space-y-2">
                          {selectedNode.data.topics.map((t: any, i: number) => (
                            <div key={i} className="p-2 bg-gray-50 rounded-lg">
                              <div className="flex items-center justify-between mb-1">
                                <span className="text-xs font-semibold">{t.name}</span>
                                <span className={`text-[9px] px-1.5 py-0.5 rounded ${
                                  t.status === 'resolved' ? 'bg-green-100 text-green-700' :
                                  t.status === 'off-track' ? 'bg-red-100 text-red-700' :
                                  t.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                }`}>{t.status}</span>
                              </div>
                              <p className="text-[11px] text-gray-500">{t.summary}</p>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {(selectedNode.data.people || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-gray-400 mb-2 flex items-center gap-1">
                          <Users className="w-3 h-3" /> People
                        </h4>
                        <div className="flex flex-wrap gap-1">
                          {selectedNode.data.people.map((p: string, i: number) => (
                            <span key={i} className="px-2 py-1 bg-cyan-50 text-cyan-700 text-[10px] rounded">{p}</span>
                          ))}
                        </div>
                      </div>
                    )}
                    
                    {(selectedNode.data.decisions || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-gray-400 mb-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Decisions
                        </h4>
                        <ul className="space-y-1">
                          {selectedNode.data.decisions.map((d: any, i: number) => (
                            <li key={i} className="text-xs text-gray-700 bg-yellow-50 p-2 rounded">• {d.decision}</li>
                          ))}
                        </ul>
                      </div>
                    )}

                    {(selectedNode.data.actionItems || []).length > 0 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-gray-400 mb-2 flex items-center gap-1">
                          <CheckCircle2 className="w-3 h-3" /> Action Items
                        </h4>
                        <ul className="space-y-2">
                          {selectedNode.data.actionItems.map((a: any, i: number) => (
                            <li key={i} className="p-2 bg-pink-50 rounded-lg">
                              <span className="text-sm font-medium text-pink-900 block mb-1">{a.task}</span>
                              <div className="flex items-center gap-1.5">
                                <span className="text-[10px] text-pink-600 font-medium">Assignee: {a.owner}</span>
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
                        <div className="border-t border-gray-200 pt-5 mt-5">
                          <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                            <Share2 className="w-3 h-3" />
                            Connected Meetings ({relatedMeetings.length})
                          </h4>
                          <div className="space-y-3">
                            {relatedMeetings.slice(0, 5).map((related, idx) => (
                              <ExpandableMeetingCard key={idx} related={related} idx={idx} />
                            ))}
                          </div>
                          {relatedMeetings.length > 5 && (
                            <button className="w-full mt-3 py-2 text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
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
                    <p className="text-sm text-gray-700">{selectedNode.data.summary}</p>
                    
                    {selectedNode.data.allStatuses && selectedNode.data.allStatuses.length > 1 && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-gray-400 mb-2 flex items-center gap-1">
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
                                <span className="text-[10px] font-medium">{status}</span>
                                <p className="text-[10px] text-gray-500 italic">"{selectedNode.data.allSummaries?.[idx]}"</p>
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
                      <div className="w-12 h-12 rounded-full bg-cyan-100 flex items-center justify-center">
                        <Users className="w-6 h-6 text-cyan-600" />
                      </div>
                      <div>
                        <p className="font-bold">{selectedNode.label}</p>
                        <p className="text-xs text-gray-500">
                          {selectedNode.data.meetings?.length || 0} meeting(s)
                        </p>
                      </div>
                    </div>
                    {selectedNode.data.meetings && (
                      <div>
                        <h4 className="text-[10px] font-mono uppercase text-gray-400 mb-2">Present in:</h4>
                        <ul className="space-y-1">
                          {selectedNode.data.meetings.map((m: string, i: number) => (
                            <li key={i} className="text-xs text-gray-700 bg-gray-50 p-2 rounded">
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
                    <div className="p-3 bg-yellow-50 rounded-lg">
                      <p className="text-sm text-yellow-900">{selectedNode.data.decision}</p>
                    </div>
                    <div className="text-xs text-gray-500">
                      <p><strong>Related Topic:</strong> {selectedNode.data.relatedTopic || 'General'}</p>
                      <p><strong>Meeting:</strong> {selectedNode.data.meetingTitle?.replace(/\.[^.]+$/, '')}</p>
                    </div>
                  </div>
                )}

                {selectedNode.type === 'action' && selectedNode.data && (
                  <div className="space-y-4">
                    <div className="p-3 bg-pink-50 rounded-lg">
                      <p className="text-sm text-pink-900">{selectedNode.data.task}</p>
                    </div>
                    <div className="text-xs text-gray-500">
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
