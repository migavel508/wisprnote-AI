import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('HistoryPage');
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Search, ChevronRight, X, Loader2, Sparkles, Calendar, Clock } from 'lucide-react';
import { TaskHistory, TaskMetadata, getTasksLightweight, getTaskById, updateTaskTitle } from '../services/awsService';
import { generateMeetingTitle } from '../services/geminiService';
import { MeetingGridSkeleton } from '../components/Skeleton';

interface HistoryPageProps {
  history: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
  isLoading?: boolean;
  onTaskUpdated?: (task: TaskHistory) => void;
}

// Cache for full task details to avoid re-fetching
const taskCache = new Map<string, TaskHistory>();

// Semantic search function - searches across multiple fields with relevance scoring
function searchMeetings(meetings: (TaskHistory | TaskMetadata)[], query: string): (TaskHistory | TaskMetadata)[] {
  if (!query.trim()) return meetings;
  
  const searchTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 1);
  if (searchTerms.length === 0) return meetings;
  
  // Score each meeting based on matches
  const scoredMeetings = meetings.map(meeting => {
    let score = 0;
    const filename = (meeting.filename || '').toLowerCase();
    const transcription = ('transcription' in meeting ? meeting.transcription || '' : '').toLowerCase();
    const summary = (meeting.summary || '').toLowerCase();
    const notes = ('notes' in meeting ? meeting.notes || '' : '').toLowerCase();
    
    for (const term of searchTerms) {
      // Title/filename matches are weighted highest
      if (filename.includes(term)) {
        score += 10;
        // Exact word match in title gets bonus
        if (filename.split(/[\s_\-\.]+/).some(word => word === term)) {
          score += 5;
        }
      }
      
      // Summary matches are weighted high (most relevant content)
      if (summary.includes(term)) {
        score += 5;
        // Count occurrences for relevance
        const summaryMatches = (summary.match(new RegExp(term, 'gi')) || []).length;
        score += Math.min(summaryMatches, 3); // Cap at 3 extra points
      }
      
      // Notes matches
      if (notes.includes(term)) {
        score += 3;
        const notesMatches = (notes.match(new RegExp(term, 'gi')) || []).length;
        score += Math.min(notesMatches, 2);
      }
      
      // Transcription matches (lowest weight as it's raw content)
      if (transcription.includes(term)) {
        score += 1;
        const transcriptionMatches = (transcription.match(new RegExp(term, 'gi')) || []).length;
        score += Math.min(transcriptionMatches * 0.1, 2);
      }
    }
    
    return { meeting, score };
  });
  
  // Filter out zero-score meetings and sort by score descending
  return scoredMeetings
    .filter(item => item.score > 0)
    .sort((a, b) => b.score - a.score)
    .map(item => item.meeting);
}

const PAGE_SIZE = 12; // Number of items to show initially and load more

export default function HistoryPage({ history, onSelectTask, isLoading = false, onTaskUpdated }: HistoryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [generatingTitleId, setGeneratingTitleId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  
  // Handle generating title for a task
  const handleGenerateTitle = useCallback(async (e: React.MouseEvent, task: TaskHistory) => {
    e.stopPropagation(); // Prevent card click
    if (!task.id || !task.transcription) return;
    
    setGeneratingTitleId(task.id);
    
    try {
      const newTitle = await generateMeetingTitle(task.transcription);
      const updatedTask = await updateTaskTitle(task.id, newTitle);
      
      // Merge with original task to ensure all fields are preserved
      const mergedTask = { ...task, ...updatedTask };
      
      if (onTaskUpdated) {
        onTaskUpdated(mergedTask);
      }
      
      // Update cache with merged task
      taskCache.set(task.id, mergedTask);
    } catch (error) {
      log.error('generate_title_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setGeneratingTitleId(null);
    }
  }, [onTaskUpdated]);
  
  // Memoized filtered results
  const filteredHistory = useMemo(() => {
    return searchMeetings(history, searchQuery) as TaskHistory[];
  }, [history, searchQuery]);
  
  // Visible items (paginated)
  const visibleHistory = useMemo(() => {
    return filteredHistory.slice(0, visibleCount);
  }, [filteredHistory, visibleCount]);
  
  const hasMore = visibleCount < filteredHistory.length;
  const hasSearchQuery = searchQuery.trim().length > 0;
  
  // Reset visible count when search changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery]);
  
  // Infinite scroll - load more when reaching bottom
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setIsLoadingMore(true);
          // Simulate small delay for smooth UX
          setTimeout(() => {
            setVisibleCount(prev => prev + PAGE_SIZE);
            setIsLoadingMore(false);
          }, 200);
        }
      },
      { threshold: 0.1 }
    );
    
    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }
    
    return () => observer.disconnect();
  }, [hasMore, isLoadingMore]);
  
  // Handle task selection - fetch full details if needed
  const handleSelectTask = useCallback(async (task: TaskHistory) => {
    // If task already has transcription, use it directly
    if (task.transcription) {
      onSelectTask(task);
      return;
    }
    
    // Check cache first
    if (task.id && taskCache.has(task.id)) {
      onSelectTask(taskCache.get(task.id)!);
      return;
    }
    
    // Fetch full task details
    if (task.id) {
      setLoadingTaskId(task.id);
      try {
        const fullTask = await getTaskById(task.id);
        if (fullTask) {
          taskCache.set(task.id, fullTask);
          onSelectTask(fullTask);
        }
      } catch (error) {
        log.error('fetch_task_details_failed', { error: error instanceof Error ? error : undefined });
      } finally {
        setLoadingTaskId(null);
      }
    }
  }, [onSelectTask]);
  
  return (
    <div className="absolute inset-0 flex flex-col bg-app-panel text-app-fg overflow-hidden font-[system-ui]">
      {/* Fixed Header */}
      <div className="flex-none px-3 sm:px-6 md:px-10 pt-5 sm:pt-8 pb-3 sm:pb-5">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
            <div>
              <h2 className="text-[22px] sm:text-[32px] font-serif italic text-[#1a1a1a]/70 leading-tight">
                All Meetings
              </h2>
              {!isLoading && history.length > 0 && (
                <p className="text-[11px] sm:text-[12px] text-[#1a1a1a]/45 mt-0.5 sm:mt-1">
                  {filteredHistory.length} meeting{filteredHistory.length !== 1 ? 's' : ''}
                  {hasSearchQuery && ` matching "${searchQuery}"`}
                </p>
              )}
            </div>

            {/* Search */}
            <div className={`relative flex items-center gap-2 bg-[#1a1a1a]/[0.05] rounded-full px-3 sm:px-4 py-2 sm:py-2.5 w-full sm:w-auto transition-all duration-200 border border-[#1a1a1a]/[0.06] ${
              searchQuery ? 'ring-1 ring-[#1a1a1a]/10' : 'hover:bg-[#1a1a1a]/[0.05]'
            }`}>
              <Search className="w-[15px] h-[15px] text-[#1a1a1a]/20 flex-shrink-0" />
              <input 
                type="text" 
                placeholder="Search meetings..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none outline-none text-[13px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/35 w-full sm:w-56" 
              />
              <AnimatePresence>
                {hasSearchQuery && (
                  <motion.button 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    onClick={() => setSearchQuery('')}
                    className="p-0.5 hover:bg-[#1a1a1a]/[0.06] rounded-full flex-shrink-0 transition-colors"
                  >
                    <X className="w-3.5 h-3.5 text-[#1a1a1a]/30" />
                  </motion.button>
                )}
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-5xl mx-auto px-3 sm:px-6 md:px-10 pb-4 sm:pb-8">
          {isLoading ? (
            <MeetingGridSkeleton count={6} />
          ) : history.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-14 h-14 rounded-2xl bg-[#1a1a1a]/[0.03] flex items-center justify-center mx-auto mb-5">
                <FileText className="w-6 h-6 text-[#1a1a1a]/15" />
              </div>
              <p className="text-[14px] font-medium text-[#1a1a1a]/50 mb-1">No meetings yet</p>
              <p className="text-[12px] text-[#1a1a1a]/35">Process your first audio to get started</p>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-14 h-14 rounded-2xl bg-[#1a1a1a]/[0.03] flex items-center justify-center mx-auto mb-5">
                <Search className="w-6 h-6 text-[#1a1a1a]/15" />
              </div>
              <p className="text-[14px] font-medium text-[#1a1a1a]/50 mb-1">No results found</p>
              <p className="text-[12px] text-[#1a1a1a]/35 mb-4">Try different search terms</p>
              <button 
                onClick={() => setSearchQuery('')}
                className="px-4 py-2 text-[12px] font-medium text-[#1a1a1a]/50 bg-[#1a1a1a]/[0.04] hover:bg-[#1a1a1a]/[0.08] rounded-full transition-colors"
              >
                Clear Search
              </button>
            </div>
          ) : (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
                {visibleHistory.map((task, index) => (
                <motion.div 
                  key={task.id}
                  initial={{ opacity: 0, y: 12 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ duration: 0.3, delay: Math.min(index * 0.04, 0.3), ease: [0.22, 1, 0.36, 1] }}
                  whileHover={{ y: -2 }}
                  onClick={() => handleSelectTask(task)}
                  className="bg-[#f5f2ef] hover:bg-[#eeebe7] rounded-xl sm:rounded-2xl p-4 sm:p-5 cursor-pointer group relative transition-colors duration-200 border border-[#1a1a1a]/[0.04]"
                >
                  {/* Loading overlay */}
                  {loadingTaskId === task.id && (
                    <div className="absolute inset-0 bg-app-panel/85 dark:bg-app-panel/90 backdrop-blur-sm rounded-2xl flex items-center justify-center z-10">
                      <Loader2 className="w-5 h-5 animate-spin text-[#1a1a1a]/40" />
                    </div>
                  )}

                  <div className="flex justify-between items-start mb-3 sm:mb-4">
                    <div className="w-8 h-8 sm:w-9 sm:h-9 rounded-lg sm:rounded-xl bg-white shadow-[0_1px_4px_rgba(0,0,0,0.06)] flex items-center justify-center">
                      <FileText className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-[#1a1a1a]/50" />
                    </div>
                    <span className="text-[11px] text-[#1a1a1a]/40 font-medium">
                      {new Date(task.created_at!).toLocaleDateString('en-US', { month: 'numeric', day: 'numeric', year: 'numeric' })}
                    </span>
                  </div>

                  <div className="flex items-center gap-2 mb-2">
                    <h3 className="text-[14px] font-semibold text-[#1a1a1a] truncate flex-1 leading-snug">{task.filename}</h3>
                    <button
                      onClick={(e) => handleGenerateTitle(e, task)}
                      disabled={generatingTitleId === task.id}
                      className="flex-shrink-0 p-1.5 opacity-0 group-hover:opacity-50 hover:!opacity-100 hover:bg-white/80 rounded-lg transition-all disabled:opacity-30"
                      title="Generate AI title"
                    >
                      {generatingTitleId === task.id ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin text-[#1a1a1a]/50" />
                      ) : (
                        <Sparkles className="w-3.5 h-3.5 text-[#1a1a1a]/40" />
                      )}
                    </button>
                  </div>

                  <p className="text-[12px] text-[#1a1a1a]/50 line-clamp-2 sm:line-clamp-3 leading-relaxed mb-3 sm:mb-4">
                    {task.summary || (task.transcription ? task.transcription.substring(0, 120) + '...' : 'No summary available')}
                  </p>

                  <div className="flex items-center gap-1.5 text-[11px] font-medium text-[#1a1a1a]/30 group-hover:text-[#1a1a1a]/60 transition-colors">
                    View <ChevronRight className="w-3 h-3" />
                  </div>
                </motion.div>
              ))}
              </div>
              
              {/* Load More Trigger */}
              {hasMore && (
                <div ref={loadMoreRef} className="flex justify-center py-8">
                  {isLoadingMore ? (
                    <div className="flex items-center gap-2 text-[12px] text-[#1a1a1a]/30">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading more…
                    </div>
                  ) : (
                    <p className="text-[12px] text-[#1a1a1a]/15">Scroll for more</p>
                  )}
                </div>
              )}
              
              {/* Show count */}
              {!hasSearchQuery && filteredHistory.length > PAGE_SIZE && (
                <p className="text-center text-[11px] text-[#1a1a1a]/15 py-4">
                  {visibleHistory.length} of {filteredHistory.length}
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
