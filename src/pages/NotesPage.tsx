import { useState, useEffect, useRef, useMemo, type ReactNode } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('NotesPage');
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Loader2, Check, RefreshCw, Image as ImageIcon, Share2, Plus, X, Search, Calendar, Users, FolderOpen, Lock, Folder as FolderIcon, FolderPlus } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TaskHistory, updateTaskTitle, updateTaskSummary, updateTaskNotes, updateTaskVisualization, updateTaskAttendees, getTaskVisualization } from '../services/awsService';
import { generateMeetingTitle, generateSummary, generateNotes, generateNotesVisualization } from '../services/geminiService';
import { NotesPageSkeleton } from '../components/Skeleton';
import { MeetingNoteTab } from '../components/ManualNotes/MeetingNoteTab';
import { formatDisplayName, formatDisplayInitials } from '../lib/displayName';
import ShareModal from '../components/ShareModal';
import {
  Workspace, Folder as FolderType,
  getWorkspacesForTask, getFolders, getFolderMeetings,
  createWorkspace, createFolder,
  addMeetingToWorkspace, removeMeetingFromWorkspace,
  addMeetingToFolder, removeMeetingFromFolder,
  isDefaultWorkspace,
} from '../services/workspaceService';
import CreateFolderModal, { type FolderDraft } from '../components/CreateFolderModal';

interface NotesPageProps {
  selectedTask: TaskHistory | null;
  onNavigateToAssets?: () => void;
  isLoading?: boolean;
  isLoadingDetails?: boolean;
  onTaskUpdated?: (task: TaskHistory) => void;
  session?: { user: { name?: string; email: string } } | null;
  allTasks?: TaskHistory[];
  /** The AI chat panel for THIS meeting, rendered inline in the "Ask AI" tab. */
  chatPanel?: ReactNode;
}

type NoteTab = 'transcription' | 'summary' | 'notes' | 'note' | 'chat';

// Helper function to format transcription with bold speaker labels
function formatTranscriptionWithBoldSpeakers(text: string): string {
  if (!text) return '';
  
  // Match patterns like "Speaker 1:", "Speaker 2:", "Speaker A:", etc.
  // Also match common variations like "Host:", "Guest:", "Interviewer:", etc.
  const speakerPattern = /^(Speaker\s*\d+|Speaker\s*[A-Z]|Host|Guest|Interviewer|Interviewee|Moderator|Participant\s*\d*|Person\s*\d*)\s*:/gim;
  
  return text.replace(speakerPattern, (match) => `**${match.trim()}**`);
}

export default function NotesPage({ selectedTask, isLoading = false, isLoadingDetails = false, onTaskUpdated, session, allTasks = [], chatPanel }: NotesPageProps) {
  const [noteTab, setNoteTab] = useState<NoteTab>('summary');
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [titleGenerated, setTitleGenerated] = useState(false);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);
  const [summaryRegenerated, setSummaryRegenerated] = useState(false);
  const [isRegeneratingNotes, setIsRegeneratingNotes] = useState(false);
  const [notesRegenerated, setNotesRegenerated] = useState(false);
  const [isVisualizing, setIsVisualizing] = useState(false);
  const [visualizationImage, setVisualizationImage] = useState<string | null>(selectedTask?.visualization_image || null);
  const [isShareOpen, setIsShareOpen] = useState(false);

  // Metadata chips state
  const [workspaces, setWorkspaces] = useState<(Workspace & { has_task: boolean })[]>([]);
  const [foldersByWs, setFoldersByWs] = useState<Record<string, FolderType[]>>({});
  const [assignedFolderIds, setAssignedFolderIds] = useState<Set<string>>(new Set());
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [showPeoplePicker, setShowPeoplePicker] = useState(false);
  const [wsSearch, setWsSearch] = useState('');
  const [newWsName, setNewWsName] = useState('');
  const [creatingWs, setCreatingWs] = useState(false);
  const [togglingWsId, setTogglingWsId] = useState<string | null>(null);
  const [togglingFolderId, setTogglingFolderId] = useState<string | null>(null);
  const [showNewFolderModal, setShowNewFolderModal] = useState(false);
  const wsPicker = useRef<HTMLDivElement>(null);
  const peoplePicker = useRef<HTMLDivElement>(null);

  // Attendee state — synced from task, persisted on change
  const [attendees, setAttendees] = useState<string[]>(selectedTask?.attendees ?? []);
  const [attendeeInput, setAttendeeInput] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(-1);

  // Per-user localStorage key for the known-people directory. MUST be scoped to
  // the signed-in account — a shared global key leaked one account's people into
  // another account's attendee suggestions on the same machine (cross-account
  // data leak). No session → no persistence (avoid writing to a shared key).
  const peopleStorageKey = session?.user?.email
    ? `lumina:knownPeople:${session.user.email.toLowerCase()}`
    : null;

  // Cross-session known people: loaded from the per-user localStorage key.
  const [persistedPeople, setPersistedPeople] = useState<string[]>(() => {
    if (!peopleStorageKey) return [];
    try { return JSON.parse(localStorage.getItem(peopleStorageKey) ?? '[]'); }
    catch { return []; }
  });

  // Reload the directory whenever the account changes (sign-out / switch). This
  // discards the previous user's in-memory list and loads the new user's — so
  // account A's people never appear under account B.
  const populatedFromTasksRef = useRef(false);
  useEffect(() => {
    populatedFromTasksRef.current = false;
    if (!peopleStorageKey) { setPersistedPeople([]); return; }
    try { setPersistedPeople(JSON.parse(localStorage.getItem(peopleStorageKey) ?? '[]')); }
    catch { setPersistedPeople([]); }
  }, [peopleStorageKey]);

  // Write persistedPeople to the per-user key asynchronously (never blocks render).
  useEffect(() => {
    if (!peopleStorageKey) return;
    const id = setTimeout(() => {
      try { localStorage.setItem(peopleStorageKey, JSON.stringify(persistedPeople)); } catch {}
    }, 0);
    return () => clearTimeout(id);
  }, [persistedPeople, peopleStorageKey]);

  // Populate persistedPeople from allTasks exactly once per account (the first
  // time allTasks has attendees). Reset by the account-change effect above.
  useEffect(() => {
    if (populatedFromTasksRef.current) return;
    const names: string[] = [];
    for (const task of allTasks) {
      for (const name of task.attendees ?? []) if (name) names.push(name);
    }
    if (!names.length) return; // wait until cache has loaded tasks with attendees
    populatedFromTasksRef.current = true;
    setPersistedPeople(prev => {
      const seen = new Set(prev.map(p => p.toLowerCase()));
      const fresh = names.filter(n => !seen.has(n.toLowerCase()));
      return fresh.length ? [...prev, ...fresh] : prev;
    });
  }, [allTasks]);

  // All known people: in-session allTasks attendees + localStorage cross-session cache
  const knownPeople = useMemo(() => {
    const seen = new Set<string>();
    const people: string[] = [];
    for (const task of allTasks) {
      for (const name of task.attendees ?? []) {
        const key = name.toLowerCase();
        if (!seen.has(key)) { seen.add(key); people.push(name); }
      }
    }
    for (const name of persistedPeople) {
      const key = name.toLowerCase();
      if (!seen.has(key)) { seen.add(key); people.push(name); }
    }
    return people;
  }, [allTasks, persistedPeople]);

  // Suggestions: known people matching the current input, not already added
  const suggestions = useMemo(() => {
    const q = attendeeInput.trim().toLowerCase();
    if (!q) return [];
    return knownPeople
      .filter(p => p.toLowerCase().includes(q) && !attendees.includes(p))
      .slice(0, 6);
  }, [attendeeInput, knownPeople, attendees]);

  // Stable, value-based key for the task's attendees. Details (including
  // attendees) are fetched asynchronously AFTER the task id is first set, so we
  // must re-sync when the attendee values arrive/change — not only when the id
  // changes. Keying on the id alone left the chip stuck on the initial empty
  // list until a full page refresh.
  const taskAttendeesKey = (selectedTask?.attendees ?? []).join(' ');
  useEffect(() => {
    setAttendees(selectedTask?.attendees ?? []);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedTask?.id, taskAttendeesKey]);

  const saveAttendees = async (next: string[]) => {
    if (!selectedTask?.id) return;
    // Update parent optimistically before the API round-trip so this batches
    // with the local setAttendees() call and causes only ONE combined re-render.
    if (onTaskUpdated) onTaskUpdated({ ...selectedTask, attendees: next });
    try {
      await updateTaskAttendees(selectedTask.id, next);
    } catch { /* silent — local state and parent already updated */ }
  };

  const handleAddAttendee = (name?: string) => {
    const value = (name ?? attendeeInput).trim();
    if (!value || attendees.includes(value)) { setAttendeeInput(''); setSuggestionIndex(-1); return; }
    const next = [...attendees, value];
    setAttendees(next);
    setAttendeeInput('');
    setSuggestionIndex(-1);
    // Add to persistent directory — the persistedPeople effect writes to localStorage
    setPersistedPeople(prev =>
      prev.some(p => p.toLowerCase() === value.toLowerCase()) ? prev : [...prev, value]
    );
    saveAttendees(next);
  };

  const handleRemoveAttendee = (name: string) => {
    const next = attendees.filter(a => a !== name);
    setAttendees(next);
    saveAttendees(next);
  };

  // The visualization image is no longer part of the main task fetch (it's heavy
  // base64). Use it if already present on the task; otherwise lazy-fetch it once
  // per task so it doesn't slow down every note open.
  useEffect(() => {
    if (selectedTask?.visualization_image) {
      setVisualizationImage(selectedTask.visualization_image);
      return;
    }
    setVisualizationImage(null);
    const id = selectedTask?.id;
    if (!id) return;
    let cancelled = false;
    getTaskVisualization(id)
      .then(img => { if (!cancelled && img) setVisualizationImage(img); })
      .catch(() => { /* non-fatal: just no image */ });
    return () => { cancelled = true; };
  }, [selectedTask?.id, selectedTask?.visualization_image]);

  // Load task workspaces whenever task changes
  useEffect(() => {
    if (!selectedTask?.id) {
      setWorkspaces([]); setFoldersByWs({}); setAssignedFolderIds(new Set());
      return;
    }
    const taskId = selectedTask.id;
    getWorkspacesForTask(taskId).then(async (ws) => {
      setWorkspaces(ws);
      // Load folders for all known workspaces (assigned + not yet assigned)
      const allFolders = await Promise.all(
        ws.map(w => getFolders(w.id).then(f => ({ id: w.id, f })).catch(() => ({ id: w.id, f: [] as FolderType[] })))
      );
      const map: Record<string, FolderType[]> = {};
      for (const r of allFolders) map[r.id] = r.f;
      setFoldersByWs(map);
      // Determine which folders the task is in (only check folders of workspaces task is in)
      const assignedWs = ws.filter(w => w.has_task);
      const assignedFolders = new Set<string>();
      await Promise.all(assignedWs.flatMap(w =>
        (map[w.id] || []).map(f =>
          getFolderMeetings(f.id)
            .then(meetings => { if (meetings.some(m => m.id === taskId)) assignedFolders.add(f.id); })
            .catch(() => {})
        )
      ));
      setAssignedFolderIds(assignedFolders);
    }).catch(() => setWorkspaces([]));
  }, [selectedTask?.id]);

  // Close pickers on outside click
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (wsPicker.current && !wsPicker.current.contains(e.target as Node)) setShowWorkspacePicker(false);
      if (peoplePicker.current && !peoplePicker.current.contains(e.target as Node)) setShowPeoplePicker(false);
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const toggleWorkspace = async (ws: Workspace & { has_task: boolean }) => {
    if (!selectedTask?.id || togglingWsId) return;
    const taskId = selectedTask.id;
    // If the note is filed inside one of this workspace's folders, the workspace row
    // isn't a second "location" — it's the parent. Clicking it files the note at the
    // workspace ROOT (out of the subfolder) rather than toggling membership, so we never
    // strand a folder membership or drop the note out of the workspace entirely.
    const wsFolders = (foldersByWs[ws.id] || []).filter(f => assignedFolderIds.has(f.id));
    setTogglingWsId(ws.id);
    try {
      if (wsFolders.length > 0) {
        await Promise.all(wsFolders.map(f => removeMeetingFromFolder(f.id, taskId)));
        setAssignedFolderIds(prev => { const n = new Set(prev); wsFolders.forEach(f => n.delete(f.id)); return n; });
        // Workspace membership stays (has_task already true) — the note now lives at the root.
      } else if (ws.has_task) {
        await removeMeetingFromWorkspace(ws.id, taskId);
        setWorkspaces(prev => prev.map(w => w.id === ws.id ? { ...w, has_task: false } : w));
      } else {
        await addMeetingToWorkspace(ws.id, taskId);
        setWorkspaces(prev => prev.map(w => w.id === ws.id ? { ...w, has_task: true } : w));
      }
    } finally {
      setTogglingWsId(null);
    }
  };

  const handleCreateWorkspace = async () => {
    if (!newWsName.trim() || !selectedTask?.id) return;
    setCreatingWs(true);
    try {
      const ws = await createWorkspace(newWsName.trim());
      await addMeetingToWorkspace(ws.id, selectedTask.id);
      setWorkspaces(prev => [...prev, { ...ws, has_task: true }]);
      setNewWsName('');
    } finally {
      setCreatingWs(false);
    }
  };

  const toggleFolder = async (ws: Workspace & { has_task: boolean }, folder: FolderType) => {
    if (!selectedTask?.id || togglingFolderId) return;
    setTogglingFolderId(folder.id);
    try {
      const isAssigned = assignedFolderIds.has(folder.id);
      if (isAssigned) {
        await removeMeetingFromFolder(folder.id, selectedTask.id);
        setAssignedFolderIds(prev => { const n = new Set(prev); n.delete(folder.id); return n; });
      } else {
        // Ensure note is also in the workspace
        if (!ws.has_task) {
          await addMeetingToWorkspace(ws.id, selectedTask.id);
          setWorkspaces(prev => prev.map(w => w.id === ws.id ? { ...w, has_task: true } : w));
        }
        await addMeetingToFolder(folder.id, selectedTask.id);
        setAssignedFolderIds(prev => new Set(prev).add(folder.id));
      }
    } finally {
      setTogglingFolderId(null);
    }
  };

  const handleCreateFolderFromPicker = async (draft: FolderDraft) => {
    if (!selectedTask?.id) return;
    const created = await createFolder(draft.workspaceId, draft.title, {
      iconType: draft.iconType,
      iconName: draft.iconName,
      color: draft.iconColor,
      emoji: draft.emoji,
      description: draft.description,
    });
    // Ensure workspace has the task
    const ws = workspaces.find(w => w.id === draft.workspaceId);
    if (ws && !ws.has_task) {
      await addMeetingToWorkspace(ws.id, selectedTask.id).catch(() => {});
      setWorkspaces(prev => prev.map(w => w.id === ws.id ? { ...w, has_task: true } : w));
    }
    await addMeetingToFolder(created.id, selectedTask.id).catch(() => {});
    setFoldersByWs(p => ({ ...p, [draft.workspaceId]: [...(p[draft.workspaceId] || []), created] }));
    setAssignedFolderIds(prev => new Set(prev).add(created.id));
    setShowNewFolderModal(false);
  };

  const assignedWorkspaces = workspaces.filter(w => w.has_task);
  const assignedFolders = workspaces.flatMap(w =>
    (foldersByWs[w.id] || []).filter(f => assignedFolderIds.has(f.id)).map(f => ({ folder: f, ws: w }))
  );
  // A note inside a folder is ALSO a member of the folder's workspace (required so it shows
  // in the workspace's master view). In the picker that read as "ticked in two places". So we
  // treat a workspace as a *location* only when the note sits at its ROOT (not inside one of
  // its folders); otherwise the folder is the location and the workspace is just its parent.
  const wsHasAssignedFolder = (wsId: string) =>
    (foldersByWs[wsId] || []).some(f => assignedFolderIds.has(f.id));
  const rootWorkspaces = assignedWorkspaces.filter(w => !wsHasAssignedFolder(w.id));
  const filteredWs = workspaces.filter(w =>
    !wsSearch || w.name.toLowerCase().includes(wsSearch.toLowerCase()) ||
    (foldersByWs[w.id] || []).some(f => f.name.toLowerCase().includes(wsSearch.toLowerCase()))
  );

  // Show skeleton while loading
  if (isLoading || !selectedTask) {
    return <NotesPageSkeleton />;
  }

  const handleGenerateTitle = async () => {
    if (!selectedTask.id || !selectedTask.transcription || isLoadingDetails) return;
    
    setIsGeneratingTitle(true);
    setTitleGenerated(false);
    
    try {
      const newTitle = await generateMeetingTitle(selectedTask.transcription);
      const updatedTask = await updateTaskTitle(selectedTask.id, newTitle);
      
      // Merge with original task to ensure all fields are preserved
      const mergedTask = { ...selectedTask, ...updatedTask };
      
      if (onTaskUpdated) {
        onTaskUpdated(mergedTask);
      }
      
      setTitleGenerated(true);
      setTimeout(() => setTitleGenerated(false), 2000);
    } catch (error) {
      log.error('generate_title_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setIsGeneratingTitle(false);
    }
  };

  const handleRegenerateSummary = async () => {
    if (!selectedTask.id || !selectedTask.transcription) return;
    
    setIsRegeneratingSummary(true);
    setSummaryRegenerated(false);
    
    try {
      const newSummary = await generateSummary(selectedTask.transcription);
      const updatedTask = await updateTaskSummary(selectedTask.id, newSummary);
      
      // Merge with original task to ensure all fields are preserved
      const mergedTask = { ...selectedTask, ...updatedTask };
      
      if (onTaskUpdated) {
        onTaskUpdated(mergedTask);
      }
      
      setSummaryRegenerated(true);
      setTimeout(() => setSummaryRegenerated(false), 2000);
    } catch (error) {
      log.error('regenerate_summary_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setIsRegeneratingSummary(false);
    }
  };

  const handleVisualizeNotes = async () => {
    if (!selectedTask.notes && !selectedTask.summary) return;
    
    setIsVisualizing(true);
    setVisualizationImage(null);
    
    try {
      const contentToVisualize = selectedTask.notes || selectedTask.summary || selectedTask.transcription;
      const image = await generateNotesVisualization(contentToVisualize);
      if (image) {
        setVisualizationImage(image);
        // Persist to Supabase so it loads next time
        if (selectedTask.id) {
          const updatedTask = await updateTaskVisualization(selectedTask.id, image);
          if (onTaskUpdated) onTaskUpdated({ ...selectedTask, ...updatedTask });
        }
      }
    } catch (error) {
      log.error('visualize_notes_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setIsVisualizing(false);
    }
  };

  const handleRegenerateNotes = async () => {
    if (!selectedTask.id || !selectedTask.transcription) return;
    
    setIsRegeneratingNotes(true);
    setNotesRegenerated(false);
    
    try {
      const newNotes = await generateNotes(selectedTask.transcription);
      const updatedTask = await updateTaskNotes(selectedTask.id, newNotes);
      
      // Merge with original task to ensure all fields are preserved
      const mergedTask = { ...selectedTask, ...updatedTask };
      
      if (onTaskUpdated) {
        onTaskUpdated(mergedTask);
      }
      
      setNotesRegenerated(true);
      setTimeout(() => setNotesRegenerated(false), 2000);
    } catch (error) {
      log.error('regenerate_notes_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setIsRegeneratingNotes(false);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-app-panel text-app-fg overflow-hidden">
      {/* Header */}
      <div className="flex-none bg-app-panel/95 dark:bg-app-panel/98 backdrop-blur-xl sticky top-0 z-10 border-b border-zinc-200/70 dark:border-app-border">
        <div className="max-w-3xl lg:max-w-4xl mx-auto w-full px-3 sm:px-6 md:px-8 pt-3 sm:pt-4 pb-2 sm:pb-3">
          {/* Title row */}
          <div className="flex items-center gap-2 mb-2.5">
            <h1 className="text-[17px] sm:text-[22px] font-serif font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-50 truncate flex-1 leading-tight">
              {selectedTask.filename}
            </h1>
            <button
              onClick={handleGenerateTitle}
              disabled={isGeneratingTitle}
              className="flex-shrink-0 flex items-center justify-center w-7 h-7 sm:w-auto sm:h-auto sm:gap-1.5 sm:px-2.5 sm:py-1 text-[10.5px] font-semibold text-app-fg-muted hover:text-app-fg bg-zinc-200/60 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip rounded-lg transition-all disabled:opacity-30"
              title="Generate AI title based on content"
            >
              {isGeneratingTitle ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : titleGenerated ? (
                <Check className="w-3 h-3 text-green-600" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              <span className="hidden sm:inline">{titleGenerated ? 'Done' : 'AI Title'}</span>
            </button>
            <button
              onClick={() => setIsShareOpen(true)}
              className="flex-shrink-0 flex items-center justify-center w-7 h-7 sm:w-auto sm:h-auto sm:gap-1.5 sm:px-2.5 sm:py-1 text-[10.5px] font-semibold text-app-fg-muted hover:text-app-fg bg-zinc-200/60 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip rounded-lg transition-all"
              title="Share meeting notes"
            >
              <Share2 className="w-3 h-3" />
              <span className="hidden sm:inline">Share</span>
            </button>
          </div>

          {/* Metadata chips */}
          <div className="flex items-center gap-2 mb-3 flex-wrap">

            {/* Date — static chip */}
            <div className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-zinc-200 dark:border-app-border text-[11.5px] text-zinc-500 dark:text-app-fg-muted select-none">
              <Calendar className="w-3 h-3 flex-shrink-0" />
              <span>{new Date(selectedTask.created_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
            </div>

            {/* People chip */}
            <div className="relative" ref={peoplePicker}>
              <button
                onClick={() => { setShowPeoplePicker(v => !v); setShowWorkspacePicker(false); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-zinc-200 dark:border-app-border text-[11.5px] text-zinc-500 dark:text-app-fg-muted hover:border-zinc-400 dark:hover:border-app-fg-subtle hover:text-zinc-700 dark:hover:text-app-fg transition-all"
              >
                <Users className="w-3 h-3 flex-shrink-0" />
                <span>Me{attendees.length > 0 ? ` +${attendees.length}` : ''}</span>
              </button>
              {showPeoplePicker && (
                <div className="absolute top-full left-0 mt-1.5 z-50 bg-app-panel border border-app-border rounded-2xl shadow-xl w-64 overflow-hidden">
                  {/* Input */}
                  <div className="px-3 pt-3 pb-2">
                    <input
                      autoFocus
                      value={attendeeInput}
                      onChange={e => { setAttendeeInput(e.target.value); setSuggestionIndex(-1); }}
                      onKeyDown={e => {
                        if (e.key === 'ArrowDown') { e.preventDefault(); setSuggestionIndex(i => Math.min(i + 1, suggestions.length - 1)); return; }
                        if (e.key === 'ArrowUp') { e.preventDefault(); setSuggestionIndex(i => Math.max(i - 1, -1)); return; }
                        if (e.key === 'Enter' || e.key === ',') {
                          e.preventDefault();
                          if (suggestionIndex >= 0 && suggestions[suggestionIndex]) {
                            handleAddAttendee(suggestions[suggestionIndex]);
                          } else {
                            handleAddAttendee();
                          }
                          return;
                        }
                        if (e.key === 'Escape') setShowPeoplePicker(false);
                      }}
                      placeholder="Add name or email, press Enter…"
                      className="w-full text-[12px] text-app-fg bg-transparent outline-none placeholder:text-app-fg-subtle border-b border-app-border pb-2"
                    />
                  </div>
                  <div className="px-2 pb-2.5 max-h-52 overflow-y-auto">
                    {/* Current user (me) — always shown, not removable */}
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded-xl">
                      <div className="w-6 h-6 rounded-full bg-[#f06060]/15 flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-semibold text-[#f06060]">
                          {formatDisplayInitials(session?.user?.email, session?.user?.name, 'M')[0]}
                        </span>
                      </div>
                      <p className="text-[12px] font-medium text-app-fg leading-tight flex-1 truncate">
                        {formatDisplayName(session?.user?.email, session?.user?.name)}
                        <span className="text-app-fg-subtle font-normal"> (me)</span>
                      </p>
                    </div>
                    {/* Added attendees */}
                    {attendees.map(name => (
                      <div key={name} className="flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-app-nav-hover-bg group">
                        <div className="w-6 h-6 rounded-full bg-zinc-200 dark:bg-app-raised flex items-center justify-center flex-shrink-0">
                          <span className="text-[10px] font-semibold text-zinc-600 dark:text-zinc-300">
                            {name[0].toUpperCase()}
                          </span>
                        </div>
                        <p className="text-[12px] text-app-fg flex-1 truncate">{name}</p>
                        <button
                          onClick={() => handleRemoveAttendee(name)}
                          className="opacity-0 group-hover:opacity-100 transition-opacity p-0.5 rounded hover:bg-zinc-200 dark:hover:bg-app-chip"
                        >
                          <X className="w-3 h-3 text-zinc-400" />
                        </button>
                      </div>
                    ))}
                    {/* Suggestions from known people */}
                    {suggestions.length > 0 && (
                      <>
                        <p className="text-[10px] font-mono text-app-fg-subtle uppercase tracking-wide px-2 pt-2 pb-1">Suggestions</p>
                        {suggestions.map((name, idx) => (
                          <button
                            key={name}
                            onMouseDown={e => { e.preventDefault(); handleAddAttendee(name); }}
                            className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-left transition-colors ${idx === suggestionIndex ? 'bg-app-nav-hover-bg' : 'hover:bg-app-nav-hover-bg'}`}
                          >
                            <div className="w-6 h-6 rounded-full bg-zinc-100 dark:bg-app-raised flex items-center justify-center flex-shrink-0">
                              <span className="text-[10px] font-semibold text-zinc-500 dark:text-zinc-300">{name[0].toUpperCase()}</span>
                            </div>
                            <p className="text-[12px] text-app-fg flex-1 truncate">{name}</p>
                            <Plus className="w-3 h-3 text-app-fg-subtle flex-shrink-0" />
                          </button>
                        ))}
                      </>
                    )}
                    {/* Add new entry when input doesn't exactly match a suggestion */}
                    {attendeeInput.trim() && !suggestions.some(s => s.toLowerCase() === attendeeInput.trim().toLowerCase()) && (
                      <button
                        onClick={() => handleAddAttendee()}
                        className="w-full flex items-center gap-2 px-2 py-1.5 mt-0.5 rounded-xl hover:bg-app-nav-hover-bg text-left"
                      >
                        <div className="w-6 h-6 rounded-full bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center flex-shrink-0">
                          <Plus className="w-3 h-3 text-blue-500" />
                        </div>
                        <p className="text-[12px] text-blue-500">Add &ldquo;{attendeeInput.trim()}&rdquo;</p>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {/* Assigned workspace chips — only workspaces the note is filed in directly
                (at the root). When it's inside a folder, the folder chip below represents
                that location and the workspace is its parent (shown in the picker). */}
            {rootWorkspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => { setShowWorkspacePicker(true); setShowPeoplePicker(false); setWsSearch(''); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-zinc-200 dark:border-app-border text-[11.5px] text-zinc-500 dark:text-app-fg-muted hover:border-zinc-400 dark:hover:border-app-fg-subtle hover:text-zinc-700 dark:hover:text-app-fg transition-all"
              >
                {isDefaultWorkspace(ws)
                  ? <Lock className="w-3 h-3 flex-shrink-0" />
                  : ws.emoji
                    ? <span className="text-[12px] leading-none flex-shrink-0">{ws.emoji}</span>
                    : <FolderOpen className="w-3 h-3 flex-shrink-0" />}
                <span className="max-w-[120px] truncate">{ws.name}</span>
              </button>
            ))}

            {/* Assigned folder chip (first folder + count) */}
            {assignedFolders.length > 0 && (
              <button
                onClick={() => { setShowWorkspacePicker(true); setShowPeoplePicker(false); setWsSearch(''); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-zinc-200 dark:border-app-border text-[11.5px] text-zinc-500 dark:text-app-fg-muted hover:border-zinc-400 dark:hover:border-app-fg-subtle hover:text-zinc-700 dark:hover:text-app-fg transition-all"
              >
                {assignedFolders[0].folder.emoji
                  ? <span className="text-[12px] leading-none flex-shrink-0">{assignedFolders[0].folder.emoji}</span>
                  : <FolderIcon className="w-3 h-3 flex-shrink-0" style={{ color: assignedFolders[0].folder.color || undefined }} />}
                <span className="max-w-[120px] truncate">{assignedFolders[0].folder.name}</span>
                {assignedFolders.length > 1 && (
                  <span className="text-app-fg-subtle">+{assignedFolders.length - 1}</span>
                )}
              </button>
            )}

            {/* Add to space */}
            <div className="relative" ref={wsPicker}>
              <button
                onClick={() => { setShowWorkspacePicker(v => !v); setShowPeoplePicker(false); setWsSearch(''); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-dashed border-zinc-300 dark:border-app-border/70 text-[11.5px] text-zinc-400 dark:text-app-fg-subtle hover:border-zinc-400 dark:hover:border-app-fg-subtle hover:text-zinc-600 dark:hover:text-app-fg-muted transition-all"
              >
                <Plus className="w-3 h-3 flex-shrink-0" />
                <span>{assignedWorkspaces.length === 0 ? 'Add to space' : 'Add more'}</span>
              </button>
              {showWorkspacePicker && (
                <div className="absolute top-full left-0 mt-1.5 z-50 bg-app-panel border border-app-border rounded-2xl shadow-xl w-72 overflow-hidden">
                  <div className="flex items-center gap-2 px-3 pt-3 pb-2 border-b border-app-border">
                    <Search className="w-3.5 h-3.5 text-app-fg-subtle flex-shrink-0" />
                    <input
                      autoFocus
                      value={wsSearch}
                      onChange={e => setWsSearch(e.target.value)}
                      placeholder="Search spaces…"
                      className="flex-1 text-[13px] text-app-fg bg-transparent outline-none placeholder:text-app-fg-subtle"
                    />
                  </div>
                  <div className="py-1.5 max-h-72 overflow-y-auto">
                    {filteredWs.map(ws => {
                      const q = wsSearch.toLowerCase();
                      const wsFolders = (foldersByWs[ws.id] || []).filter(f => !q || f.name.toLowerCase().includes(q));
                      return (
                        <div key={ws.id}>
                          <button
                            onClick={() => toggleWorkspace(ws)}
                            disabled={togglingWsId === ws.id}
                            title={wsHasAssignedFolder(ws.id) ? 'Note is in a folder below — click to move it to the workspace root' : ws.has_task ? 'Remove from workspace' : 'Add to workspace'}
                            className="w-full flex items-center gap-3 px-3 py-2 hover:bg-app-nav-hover-bg transition-colors text-left disabled:opacity-60"
                          >
                            {isDefaultWorkspace(ws) ? (
                              <span className="w-5 flex-shrink-0 flex items-center justify-center">
                                <span className="w-5 h-5 rounded-md bg-app-nav-hover-bg flex items-center justify-center">
                                  <Lock className="w-3 h-3 text-app-fg-muted" />
                                </span>
                              </span>
                            ) : (
                              <span className="text-base leading-none w-5 flex-shrink-0">{ws.emoji}</span>
                            )}
                            <span className="flex-1 text-[13px] text-app-fg truncate">{ws.name}</span>
                            {togglingWsId === ws.id ? (
                              <Loader2 className="w-3.5 h-3.5 animate-spin text-app-fg-subtle" />
                            ) : (ws.has_task && !wsHasAssignedFolder(ws.id)) ? (
                              <Check className="w-3.5 h-3.5 text-emerald-500" />
                            ) : wsHasAssignedFolder(ws.id) ? (
                              <span className="text-[10.5px] text-app-fg-subtle">in folder</span>
                            ) : null}
                          </button>
                          {wsFolders.map(f => {
                            const isAssigned = assignedFolderIds.has(f.id);
                            return (
                              <button
                                key={f.id}
                                onClick={() => toggleFolder(ws, f)}
                                disabled={togglingFolderId === f.id}
                                className="w-full flex items-center gap-3 pl-8 pr-3 py-1.5 hover:bg-app-nav-hover-bg transition-colors text-left disabled:opacity-60"
                              >
                                {f.emoji
                                  ? <span className="text-[13px] leading-none w-4 flex-shrink-0">{f.emoji}</span>
                                  : <FolderIcon className="w-3.5 h-3.5 flex-shrink-0" style={{ color: f.color || undefined }} />}
                                <span className="flex-1 text-[12.5px] text-app-fg-muted truncate">{f.name}</span>
                                {togglingFolderId === f.id ? (
                                  <Loader2 className="w-3.5 h-3.5 animate-spin text-app-fg-subtle" />
                                ) : isAssigned ? (
                                  <Check className="w-3.5 h-3.5 text-emerald-500" />
                                ) : null}
                              </button>
                            );
                          })}
                        </div>
                      );
                    })}
                    {filteredWs.length === 0 && wsSearch && (
                      <p className="px-4 py-3 text-[12px] text-app-fg-subtle">No spaces or folders found</p>
                    )}
                  </div>
                  <div className="border-t border-app-border px-3 py-2.5 space-y-1">
                    <button
                      onClick={() => { setShowNewFolderModal(true); setShowWorkspacePicker(false); }}
                      className="w-full flex items-center gap-2.5 text-[12px] text-[#10b981] font-medium hover:opacity-80 transition-opacity"
                    >
                      <FolderPlus className="w-3.5 h-3.5" />
                      New folder
                    </button>
                    {newWsName ? (
                      <div className="flex items-center gap-2 pt-1">
                        <input
                          autoFocus
                          value={newWsName}
                          onChange={e => setNewWsName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleCreateWorkspace(); if (e.key === 'Escape') setNewWsName(''); }}
                          placeholder="Workspace name…"
                          className="flex-1 text-[11.5px] text-app-fg bg-app-status-bg border border-app-border rounded-lg px-2.5 py-1.5 outline-none focus:ring-1 focus:ring-[#f06060]/30 placeholder:text-app-fg-subtle"
                        />
                        <button onClick={handleCreateWorkspace} disabled={creatingWs} className="p-1.5 rounded-lg bg-app-fg text-app-canvas disabled:opacity-40">
                          {creatingWs ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                        </button>
                        <button onClick={() => setNewWsName('')} className="p-1.5 rounded-lg hover:bg-app-nav-hover-bg text-app-fg-subtle">
                          <X className="w-3 h-3" />
                        </button>
                      </div>
                    ) : (
                      <button
                        onClick={() => setNewWsName(' ')}
                        className="w-full flex items-center gap-2.5 text-[11.5px] text-app-fg-subtle hover:text-app-fg transition-colors"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        New workspace
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>

            {showNewFolderModal && (
              <CreateFolderModal
                workspaces={workspaces.map(({ has_task: _, ...rest }) => rest)}
                defaultWorkspaceId={assignedWorkspaces[0]?.id || workspaces[0]?.id}
                onClose={() => setShowNewFolderModal(false)}
                onCreate={handleCreateFolderFromPicker}
              />
            )}
          </div>

          {/* Tab Switcher — horizontally scrollable on mobile */}
          <div className="overflow-x-auto no-scrollbar -mx-3 sm:mx-0 px-3 sm:px-0">
            <div className="flex gap-[3px] bg-zinc-200/70 dark:bg-app-raised rounded-lg p-[3px] w-fit">
              {(['transcription', 'summary', 'notes', 'note', 'chat'] as NoteTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setNoteTab(tab)}
                  className={`px-2.5 sm:px-3 py-[4px] rounded-lg text-[11px] sm:text-[11.5px] font-semibold transition-all whitespace-nowrap ${
                    noteTab === tab
                      ? 'bg-app-chip text-zinc-900 dark:text-app-fg shadow-sm shadow-black/10 dark:shadow-black/50 ring-1 ring-zinc-300/80 dark:ring-white/[0.08]'
                      : 'text-app-fg-muted hover:text-app-fg'
                  }`}
                >
                  {tab === 'note' ? 'My Note' : tab === 'chat' ? 'Ask AI' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-300/80 to-transparent dark:via-zinc-600/50" />
      </div>

      {/* Content Area — the "Ask AI" tab fills the full height with the inline
          chat (scoped to this meeting); other tabs scroll in a padded column. */}
      {noteTab === 'chat' ? (
        <div className="flex-1 min-h-0 overflow-hidden">
          {chatPanel ?? (
            <div className="h-full flex items-center justify-center text-[13px] text-app-fg-subtle">
              Chat isn’t available here.
            </div>
          )}
        </div>
      ) : (
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl lg:max-w-4xl mx-auto w-full px-3 sm:px-6 md:px-8 py-4 sm:py-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={noteTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              {noteTab === 'transcription' && (
                isLoadingDetails && !selectedTask.transcription ? (
                  <div className="flex flex-col items-center justify-center py-16 gap-3">
                    <Loader2 className="w-5 h-5 animate-spin text-app-fg-subtle" />
                    <p className="text-[13px] text-app-fg-muted">Loading transcription...</p>
                  </div>
                ) : (
                  <div className="prose prose-sm max-w-none prose-p:text-[14.5px] prose-p:leading-[1.75] prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100 prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-headings:tracking-tight transcription-content markdown-body">
                    <Markdown remarkPlugins={[remarkGfm]}>{formatTranscriptionWithBoldSpeakers(selectedTask.transcription || '')}</Markdown>
                  </div>
                )
              )}

              {noteTab === 'summary' && (
                <div className="bg-zinc-100 dark:bg-app-raised p-4 sm:p-6 md:p-8 rounded-xl border border-zinc-200/90 dark:border-app-border">
                  <div className="flex items-center justify-between mb-5">
                    <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">Key Summary</h3>
                    <button
                      onClick={handleRegenerateSummary}
                      disabled={isRegeneratingSummary}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-app-fg-muted hover:text-app-fg hover:bg-zinc-200/80 dark:hover:bg-app-chip rounded-lg transition-all disabled:opacity-30"
                    >
                      {isRegeneratingSummary ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : summaryRegenerated ? (
                        <Check className="w-3.5 h-3.5 text-green-600" />
                      ) : (
                        <RefreshCw className="w-3.5 h-3.5" />
                      )}
                      <span>{summaryRegenerated ? 'Updated!' : 'Regenerate'}</span>
                    </button>
                  </div>
                  {isRegeneratingSummary ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="w-5 h-5 animate-spin text-app-fg-subtle" />
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none prose-p:text-[14px] prose-p:leading-[1.75] prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100 prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-headings:tracking-tight markdown-body">
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.summary || 'No summary generated.'}</Markdown>
                    </div>
                  )}
                </div>
              )}

              {noteTab === 'notes' && (
                <div className="space-y-6">
                  {/* Notes toolbar */}
                  <div className="flex items-center justify-between">
                    <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-zinc-900 dark:text-zinc-50">Structured Notes</h3>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={handleVisualizeNotes}
                        disabled={isVisualizing || (!selectedTask.notes && !selectedTask.summary)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-app-fg-muted hover:text-app-fg hover:bg-zinc-200/70 dark:hover:bg-app-chip rounded-lg transition-all disabled:opacity-30"
                      >
                        {isVisualizing ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : (
                          <ImageIcon className="w-3.5 h-3.5" />
                        )}
                        <span>Visualize</span>
                      </button>
                      <button
                        onClick={handleRegenerateNotes}
                        disabled={isRegeneratingNotes}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-app-fg-muted hover:text-app-fg hover:bg-zinc-200/70 dark:hover:bg-app-chip rounded-lg transition-all disabled:opacity-30"
                      >
                        {isRegeneratingNotes ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin" />
                        ) : notesRegenerated ? (
                          <Check className="w-3.5 h-3.5 text-green-600" />
                        ) : (
                          <RefreshCw className="w-3.5 h-3.5" />
                        )}
                        <span>{notesRegenerated ? 'Updated!' : 'Regenerate'}</span>
                      </button>
                    </div>
                  </div>
                  
                  {/* Visualization Result */}
                  {visualizationImage && (
                    <div className="rounded-2xl overflow-hidden border border-zinc-200/90 dark:border-app-border bg-zinc-100 dark:bg-app-raised">
                      <div className="px-4 py-3 border-b border-zinc-200/90 dark:border-app-border flex items-center justify-between">
                        <span className="text-[12px] font-medium text-app-fg-muted flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                          AI Visualization
                        </span>
                        <button 
                          onClick={() => setVisualizationImage(null)}
                          className="text-[11px] font-medium text-app-fg-subtle hover:text-app-fg-muted transition-colors"
                        >
                          Dismiss
                        </button>
                      </div>
                      <div className="p-4 flex justify-center">
                        <img 
                          src={visualizationImage} 
                          alt="Notes Visualization" 
                          className="max-w-full h-auto rounded-xl"
                          style={{ maxHeight: '500px' }}
                        />
                      </div>
                    </div>
                  )}
                  
                  {/* Notes content */}
                  {isRegeneratingNotes ? (
                    <div className="flex items-center justify-center py-16">
                      <Loader2 className="w-5 h-5 animate-spin text-app-fg-subtle" />
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none prose-p:text-[14px] prose-p:leading-[1.75] prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100 prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-headings:tracking-tight prose-h2:text-[16px] prose-h2:font-semibold prose-h3:text-[14px] prose-h3:font-semibold prose-li:text-[14px] prose-li:text-zinc-700 dark:prose-li:text-zinc-300 markdown-body">
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.notes || 'No structured notes generated.'}</Markdown>
                    </div>
                  )}
                </div>
              )}

              {noteTab === 'note' && selectedTask.id && (
                <MeetingNoteTab
                  taskId={selectedTask.id}
                  initialContent={selectedTask.personal_note || ''}
                />
              )}
            </motion.div>
          </AnimatePresence>
        </div>
      </div>
      )}

      {selectedTask.id && (
        <ShareModal
          taskId={selectedTask.id}
          taskName={selectedTask.filename}
          isOpen={isShareOpen}
          onClose={() => setIsShareOpen(false)}
        />
      )}
    </div>
  );
}
