import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('HistoryPage');
import { motion, AnimatePresence } from 'framer-motion';
import { FileText, Search, X, Loader2 } from 'lucide-react';
import { TaskHistory, TaskMetadata, getTasksLightweight, getTaskById, updateTaskTitle } from '../services/awsService';
import { generateMeetingTitle } from '../services/geminiService';
import { MeetingGridSkeleton } from '../components/Skeleton';
import {
  getSpaces, getSpaceFolders, createFolderInSpace, moveNoteToSpace,
  type Workspace, type Folder,
} from '../services/workspaceService';
import { cacheGet, cacheSet } from '../services/appCache';
import { FolderPicker } from './WorkspacePage';
import CreateFolderModal, { type FolderDraft } from '../components/CreateFolderModal';
import { onVaultEvent } from '../lib/vaultEvents';

// ── Date grouping (Today / Yesterday / "Fri, Jun 5") — matches the workspace UI ──
function groupHistoryByDate(items: TaskHistory[]) {
  const groups: { label: string; items: TaskHistory[] }[] = [];
  const map = new Map<string, TaskHistory[]>();
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  for (const m of items) {
    const d = new Date(m.created_at || Date.now());
    let label: string;
    if (d.toDateString() === today.toDateString()) label = 'Today';
    else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (!map.has(label)) { const arr: TaskHistory[] = []; map.set(label, arr); groups.push({ label, items: arr }); }
    map.get(label)!.push(m);
  }
  return groups;
}

function formatTime(iso?: string) {
  if (!iso) return '';
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}


interface HistoryPageProps {
  history: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
  isLoading?: boolean;
  onTaskUpdated?: (task: TaskHistory) => void;
  onLoadMore?: () => Promise<void>;
  hasMoreFromServer?: boolean;
  totalCount?: number;
  /** Open a workspace when its badge is clicked. */
  onOpenWorkspace?: (workspaceId: string) => void;
}

// Cache for full task details to avoid re-fetching
const taskCache = new Map<string, TaskHistory>();
const prefetchingIds = new Set<string>();

function prefetchTask(taskId: string) {
  if (taskCache.has(taskId) || prefetchingIds.has(taskId)) return;
  prefetchingIds.add(taskId);
  getTaskById(taskId).then(full => {
    if (full) taskCache.set(taskId, full);
  }).catch(() => {}).finally(() => {
    prefetchingIds.delete(taskId);
  });
}

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

export default function HistoryPage({ history, onSelectTask, isLoading = false, onTaskUpdated, onLoadMore, hasMoreFromServer = false, totalCount, onOpenWorkspace }: HistoryPageProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [generatingTitleId, setGeneratingTitleId] = useState<string | null>(null);
  // Workspace/folder context for the per-row picker (move a note between spaces).
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [foldersByWs, setFoldersByWs] = useState<Record<string, Folder[]>>({});
  // Optimistic per-note location override (meetingId → {spaceId, folderId}). It wins
  // over the meeting's own space_id/folder_id from the list, so a move shows instantly
  // (incl. moving to a space ROOT, where folderId is explicitly null). Kept in sync by
  // vault events too, so a move on ANY page updates this row's badge here.
  const [locOverride, setLocOverride] = useState<Record<string, { spaceId: string | null; folderId: string | null }>>({});
  const [folderModalWsId, setFolderModalWsId] = useState<string | null>(null);

  // The per-row picker lists the active workspace's SPACES + their folders.
  const loadWorkspaceContext = useCallback(async () => {
    try {
      const spaces = await getSpaces();
      setWorkspaces(spaces as unknown as Workspace[]);
      const rows = await Promise.all(
        spaces.map(s => getSpaceFolders(s.id).then(f => ({ id: s.id, f })).catch(() => ({ id: s.id, f: [] as Folder[] }))),
      );
      const fbw: Record<string, Folder[]> = {};
      for (const r of rows) fbw[r.id] = r.f;
      setFoldersByWs(fbw);
    } catch { /* keep empty */ }
  }, []);

  useEffect(() => { void loadWorkspaceContext(); }, [loadWorkspaceContext, history.length]);

  // Keep this page live: a note moved anywhere updates its badge here; spaces/folders
  // changing anywhere reloads the picker list. One change → reflected everywhere.
  useEffect(() => {
    const offNotes = onVaultEvent('notes:changed', ({ taskId, spaceId, folderId }) =>
      setLocOverride(prev => ({ ...prev, [taskId]: { spaceId, folderId } })));
    const offSpaces = onVaultEvent('spaces:changed', () => { void loadWorkspaceContext(); });
    return () => { offNotes(); offSpaces(); };
  }, [loadWorkspaceContext]);

  // Move a note into a SPACE (and optionally a folder within it).
  const changeMeetingFolder = useCallback(async (taskId: string, spaceId: string, newFolderId: string | null) => {
    setLocOverride(prev => ({ ...prev, [taskId]: { spaceId, folderId: newFolderId } }));
    await moveNoteToSpace(spaceId, taskId, newFolderId).catch(() => { /* local state already reflects intent */ });
  }, []);

  const handleCreateFolder = useCallback(async (draft: FolderDraft) => {
    if (!draft.workspaceId) return; // draft.workspaceId carries the target SPACE id here
    const created = await createFolderInSpace(draft.workspaceId, draft.title, {
      iconType: draft.iconType, iconName: draft.iconName, color: draft.iconColor, emoji: draft.emoji,
    });
    setFoldersByWs(p => ({ ...p, [draft.workspaceId]: [...(p[draft.workspaceId] || []), created] }));
    setFolderModalWsId(null);
  }, []);
  const [visibleCount, setVisibleCount] = useState(PAGE_SIZE);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const loadMoreRef = useRef<HTMLDivElement>(null);
  
  // Handle generating title for a task
  const handleGenerateTitle = useCallback(async (e: React.MouseEvent, task: TaskHistory) => {
    e.stopPropagation();
    if (!task.id) return;
    
    setGeneratingTitleId(task.id);
    
    try {
      // Fetch full task if transcription not loaded yet
      let transcription = task.transcription;
      if (!transcription && task.id) {
        const full = await getTaskById(task.id);
        transcription = full?.transcription;
      }
      if (!transcription) return;

      const newTitle = await generateMeetingTitle(transcription);
      const updatedTask = await updateTaskTitle(task.id, newTitle);
      
      const mergedTask = { ...task, ...updatedTask };
      
      if (onTaskUpdated) {
        onTaskUpdated(mergedTask);
      }
      
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

  // Prefetch full data for the first few visible tasks in background
  useEffect(() => {
    const toPrefetch = visibleHistory
      .filter(t => t.id && !t.transcription)
      .slice(0, 6);
    toPrefetch.forEach(t => prefetchTask(t.id!));
  }, [visibleHistory]);
  
  const hasSearchQuery = searchQuery.trim().length > 0;
  const hasMoreLocal = visibleCount < filteredHistory.length;
  const hasMore = hasMoreLocal || (hasMoreFromServer && !hasSearchQuery);
  
  // Reset visible count when search changes
  useEffect(() => {
    setVisibleCount(PAGE_SIZE);
  }, [searchQuery]);
  
  // Infinite scroll - load more from local slice or fetch next server page
  useEffect(() => {
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && hasMore && !isLoadingMore) {
          setIsLoadingMore(true);

          if (hasMoreLocal) {
            setTimeout(() => {
              setVisibleCount(prev => prev + PAGE_SIZE);
              setIsLoadingMore(false);
            }, 150);
          } else if (hasMoreFromServer && onLoadMore && !hasSearchQuery) {
            onLoadMore().then(() => {
              setVisibleCount(prev => prev + PAGE_SIZE);
            }).finally(() => {
              setIsLoadingMore(false);
            });
          } else {
            setIsLoadingMore(false);
          }
        }
      },
      { threshold: 0.1 }
    );
    
    if (loadMoreRef.current) {
      observer.observe(loadMoreRef.current);
    }
    
    return () => observer.disconnect();
  }, [hasMore, hasMoreLocal, hasMoreFromServer, isLoadingMore, hasSearchQuery, onLoadMore]);
  
  // Navigate immediately -- App.tsx handles fetching full details in background
  const handleSelectTask = useCallback((task: TaskHistory) => {
    if (task.id && taskCache.has(task.id)) {
      const cached = taskCache.get(task.id)!;
      // Prefer `task` from live history state (has latest attendees, title, etc.
      // updated via onTaskUpdated) but recover heavy fields that are absent from
      // lightweight history entries (transcription, notes, etc.) from the cache.
      onSelectTask({
        ...cached,
        ...task,
        transcription: task.transcription ?? cached.transcription,
        notes: task.notes ?? cached.notes,
        visualization_image: task.visualization_image ?? cached.visualization_image,
        personal_note: task.personal_note ?? cached.personal_note,
        audio_url: task.audio_url ?? cached.audio_url,
      });
      return;
    }
    onSelectTask(task);
  }, [onSelectTask]);
  
  return (
    <div className="absolute inset-0 flex flex-col bg-app-panel text-app-fg overflow-hidden font-[system-ui]">
      {/* Fixed Header */}
      <div className="flex-none px-3 sm:px-6 md:px-10 pt-5 sm:pt-8 pb-3 sm:pb-5">
        <div className="max-w-5xl mx-auto">
          <div className="flex flex-col sm:flex-row items-start sm:items-end justify-between gap-3 sm:gap-4 mb-4 sm:mb-6">
            <div>
              <h2 className="text-[22px] sm:text-[30px] font-serif font-semibold text-app-fg leading-tight">
                Meetings
              </h2>
              {!isLoading && history.length > 0 && (
                <p className="text-[11px] sm:text-[12px] text-app-fg-label mt-0.5 sm:mt-1">
                  {hasSearchQuery
                    ? `${filteredHistory.length} meeting${filteredHistory.length !== 1 ? 's' : ''} matching "${searchQuery}"`
                    : `${totalCount || filteredHistory.length} meeting${(totalCount || filteredHistory.length) !== 1 ? 's' : ''}`
                  }
                </p>
              )}
            </div>

            {/* Search */}
            <div className={`relative flex items-center gap-2 bg-[#1a1a1a]/[0.05] dark:bg-white/[0.06] rounded-lg px-3 sm:px-4 py-2 sm:py-2.5 w-full sm:w-auto transition-all duration-200 border border-[#1a1a1a]/[0.06] dark:border-white/[0.08] ${
              searchQuery ? 'ring-1 ring-[#1a1a1a]/10 dark:ring-white/10' : 'hover:bg-[#1a1a1a]/[0.08] dark:hover:bg-white/[0.09]'
            }`}>
              <Search className="w-[15px] h-[15px] text-[#1a1a1a]/30 dark:text-app-fg/40 flex-shrink-0" />
              <input 
                type="text" 
                placeholder="Search meetings..." 
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="bg-transparent border-none outline-none text-[13px] text-[#1a1a1a] dark:text-app-fg placeholder:text-[#1a1a1a]/35 dark:placeholder:text-app-fg/35 w-full sm:w-56" 
              />
              <AnimatePresence>
                {hasSearchQuery && (
                  <motion.button 
                    initial={{ opacity: 0, scale: 0.8 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.8 }}
                    onClick={() => setSearchQuery('')}
                    className="p-0.5 hover:bg-[#1a1a1a]/[0.06] dark:hover:bg-white/[0.08] rounded-lg flex-shrink-0 transition-colors"
                  >
                    <X className="w-3.5 h-3.5 text-[#1a1a1a]/30 dark:text-app-fg/40" />
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
              <div className="w-14 h-14 rounded-2xl bg-[#1a1a1a]/[0.03] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-5">
                <FileText className="w-6 h-6 text-[#1a1a1a]/15 dark:text-app-fg/20" />
              </div>
              <p className="text-[14px] font-medium text-[#1a1a1a]/50 dark:text-app-fg/50 mb-1">No meetings yet</p>
              <p className="text-[12px] text-[#1a1a1a]/35 dark:text-app-fg/35">Process your first audio to get started</p>
            </div>
          ) : filteredHistory.length === 0 ? (
            <div className="text-center py-20">
              <div className="w-14 h-14 rounded-2xl bg-[#1a1a1a]/[0.03] dark:bg-white/[0.04] flex items-center justify-center mx-auto mb-5">
                <Search className="w-6 h-6 text-[#1a1a1a]/15 dark:text-app-fg/20" />
              </div>
              <p className="text-[14px] font-medium text-[#1a1a1a]/50 dark:text-app-fg/50 mb-1">No results found</p>
              <p className="text-[12px] text-[#1a1a1a]/35 dark:text-app-fg/35 mb-4">Try different search terms</p>
              <button 
                onClick={() => setSearchQuery('')}
                className="px-4 py-2 text-[12px] font-medium text-[#1a1a1a]/50 dark:text-app-fg/50 bg-[#1a1a1a]/[0.04] dark:bg-white/[0.06] hover:bg-[#1a1a1a]/[0.08] dark:hover:bg-white/[0.1] rounded-lg transition-colors"
              >
                Clear Search
              </button>
            </div>
          ) : (
            <>
              {/* Date-grouped list */}
              <div className="-mx-1">
                {groupHistoryByDate(visibleHistory).map(group => (
                  <div key={group.label} className="mb-4">
                    <div className="px-3 py-1.5 text-[10.5px] font-medium text-app-fg-label uppercase tracking-[0.08em]">{group.label}</div>
                    {group.items.map(task => {
                      const durSecs = task.duration ?? 0;
                      const durMins = Math.floor(durSecs / 60);
                      const durRem = durSecs % 60;
                      const durationStr = durMins > 0
                        ? `${durMins}m${durRem > 0 ? ` ${durRem}s` : ''}`
                        : durSecs > 0 ? `${durSecs}s` : '';

                      return (
                        <div
                          key={task.id}
                          onClick={() => handleSelectTask(task)}
                          className="group flex items-start gap-3 px-3 py-2.5 rounded-xl hover:bg-app-nav-hover-bg cursor-pointer transition-colors"
                        >
                          <div className="mt-0.5 w-8 h-8 rounded-lg bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0">
                            <FileText size={14} strokeWidth={1.7} className="text-app-fg-subtle" />
                          </div>
                          <div className="flex-1 min-w-0">
                            <p className="text-[13.5px] font-medium text-app-fg truncate leading-tight tracking-[-0.01em]">
                              {task.filename || 'Untitled'}
                            </p>
                            {(durationStr || (task.attendees && task.attendees.length > 1)) && (
                              <div className="flex items-center gap-2 mt-1">
                                {durationStr && (
                                  <span className="text-[10px] font-mono text-app-fg-label">{durationStr}</span>
                                )}
                                {task.attendees && task.attendees.length > 1 && (
                                  <span className="text-[10px] text-app-fg-label">
                                    {task.attendees.length} people
                                  </span>
                                )}
                              </div>
                            )}
                          </div>
                          <div className="flex items-center gap-1.5 flex-shrink-0 mt-0.5" onClick={e => e.stopPropagation()}>
                            {task.id && (() => {
                              // The note's location: optimistic override (latest move)
                              // else the meeting's own space_id/folder_id from the list.
                              const loc = locOverride[task.id]
                                ?? { spaceId: task.space_id ?? null, folderId: task.folder_id ?? null };
                              return (
                                <FolderPicker
                                  workspaces={workspaces}
                                  foldersByWs={foldersByWs}
                                  currentWsId={loc.spaceId}
                                  currentFolderId={loc.folderId}
                                  onSelectWorkspace={(wsId) => changeMeetingFolder(task.id!, wsId, null)}
                                  onSelectFolder={(wsId, folderId) => changeMeetingFolder(task.id!, wsId, folderId)}
                                  onCreateFolder={() => setFolderModalWsId(loc.spaceId ?? workspaces[0]?.id ?? null)}
                                />
                              );
                            })()}
                            <span className="text-[11.5px] text-app-fg-subtle px-1 tabular-nums group-hover:hidden">{formatTime(task.created_at)}</span>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                ))}
              </div>

              {/* Load More Trigger */}
              {hasMore && (
                <div ref={loadMoreRef} className="flex justify-center py-8">
                  {isLoadingMore ? (
                    <div className="flex items-center gap-2 text-[12px] text-[#1a1a1a]/30 dark:text-app-fg/30">
                      <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      Loading more…
                    </div>
                  ) : (
                    <p className="text-[12px] text-[#1a1a1a]/15 dark:text-app-fg/20">Scroll for more</p>
                  )}
                </div>
              )}
              
              {/* Show count */}
              {!hasSearchQuery && (totalCount || filteredHistory.length) > PAGE_SIZE && (
                <p className="text-center text-[11px] text-[#1a1a1a]/15 dark:text-app-fg/20 py-4">
                  {visibleHistory.length} of {totalCount || filteredHistory.length}
                </p>
              )}
            </>
          )}
        </div>
      </div>

      {/* New folder (from the row's workspace picker) */}
      {folderModalWsId && (
        <CreateFolderModal
          workspaces={workspaces}
          defaultWorkspaceId={folderModalWsId}
          onClose={() => setFolderModalWsId(null)}
          onCreate={handleCreateFolder}
        />
      )}
    </div>
  );
}
