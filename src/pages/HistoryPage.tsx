import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { motion } from 'framer-motion';
import { FileAudio, Search, ChevronRight, X, Loader2 } from 'lucide-react';
import { TaskHistory, TaskMetadata, getTasksLightweight, getTaskById } from '../services/supabaseService';
import { MeetingGridSkeleton } from '../components/Skeleton';

interface HistoryPageProps {
  history: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
  isLoading?: boolean;
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

export default function HistoryPage({ history, onSelectTask, isLoading = false }: HistoryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [loadingTaskId, setLoadingTaskId] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  
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
        console.error('Error fetching task details:', error);
      } finally {
        setLoadingTaskId(null);
      }
    }
  }, [onSelectTask]);
  
  return (
    <div className="absolute inset-0 flex flex-col bg-[#E4E3E0] overflow-hidden">
      {/* Fixed Header */}
      <div className="flex-none bg-[#E4E3E0] border-b border-[#141414]/10 px-4 sm:px-8 py-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <h2 className="text-2xl font-serif italic font-bold">All Meetings</h2>
          <div className="flex items-center gap-2 border border-[#141414] bg-white px-3 py-1.5 w-full sm:w-auto rounded-lg">
            <Search className="w-4 h-4 opacity-50 flex-shrink-0" />
            <input 
              type="text" 
              placeholder="Search by title, topic, or content..." 
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="bg-transparent border-none outline-none text-xs font-mono w-full sm:w-56" 
            />
            {hasSearchQuery && (
              <button 
                onClick={() => setSearchQuery('')}
                className="p-0.5 hover:bg-gray-100 rounded flex-shrink-0"
              >
                <X className="w-3 h-3 opacity-50" />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div ref={scrollContainerRef} className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6">
          {isLoading ? (
            <MeetingGridSkeleton count={6} />
          ) : history.length === 0 ? (
            <div className="text-center py-16">
              <FileAudio className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="text-sm opacity-50">No meetings yet</p>
              <p className="text-xs opacity-40 mt-2">Process your first audio to get started</p>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="text-center py-16">
              <Search className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="text-sm opacity-50">No meetings found</p>
              <p className="text-xs opacity-40 mt-2">Try different search terms or clear the search</p>
              <button 
                onClick={() => setSearchQuery('')}
                className="mt-4 px-4 py-2 text-xs font-mono bg-[#141414] text-white rounded-lg hover:bg-[#333] transition-colors"
              >
                Clear Search
              </button>
            </div>
          ) : (
            <>
              {hasSearchQuery && (
                <p className="text-xs font-mono opacity-50 mb-4">
                  Found {filteredHistory.length} meeting{filteredHistory.length !== 1 ? 's' : ''} matching "{searchQuery}"
                </p>
              )}
              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                {visibleHistory.map((task) => (
                <motion.div 
                  key={task.id}
                  whileHover={{ y: -4 }}
                  onClick={() => handleSelectTask(task)}
                  className="border border-[#141414] bg-white p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] cursor-pointer group relative"
                >
                  {/* Loading overlay */}
                  {loadingTaskId === task.id && (
                    <div className="absolute inset-0 bg-white/80 flex items-center justify-center z-10">
                      <Loader2 className="w-6 h-6 animate-spin text-[#141414]" />
                    </div>
                  )}
                  <div className="flex justify-between items-start mb-4">
                    <div className="p-2 bg-[#141414]/5 rounded">
                      <FileAudio className="w-6 h-6" />
                    </div>
                    <span className="text-[10px] font-mono opacity-40 uppercase">
                      {new Date(task.created_at!).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="font-bold text-sm mb-2 group-hover:underline truncate">{task.filename}</h3>
                  <p className="text-[10px] opacity-50 line-clamp-3 font-mono mb-4">
                    {task.summary || (task.transcription ? task.transcription.substring(0, 100) + '...' : 'No summary available')}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                    View Details <ChevronRight className="w-3 h-3" />
                  </div>
                </motion.div>
              ))}
              </div>
              
              {/* Load More Trigger */}
              {hasMore && (
                <div ref={loadMoreRef} className="flex justify-center py-8">
                  {isLoadingMore ? (
                    <div className="flex items-center gap-2 text-xs font-mono opacity-50">
                      <Loader2 className="w-4 h-4 animate-spin" />
                      Loading more...
                    </div>
                  ) : (
                    <p className="text-xs font-mono opacity-30">Scroll for more</p>
                  )}
                </div>
              )}
              
              {/* Show count */}
              {!hasSearchQuery && filteredHistory.length > PAGE_SIZE && (
                <p className="text-center text-xs font-mono opacity-40 py-4">
                  Showing {visibleHistory.length} of {filteredHistory.length} meetings
                </p>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
