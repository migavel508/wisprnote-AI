import { useState, useEffect, useRef } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('NotesPage');
import { motion, AnimatePresence } from 'framer-motion';
import { Sparkles, Loader2, Check, RefreshCw, Image as ImageIcon, Share2, Plus, X, Search, Calendar, Users, FolderOpen } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TaskHistory, updateTaskTitle, updateTaskSummary, updateTaskNotes, updateTaskVisualization } from '../services/awsService';
import { generateMeetingTitle, generateSummary, generateNotes, generateNotesVisualization } from '../services/geminiService';
import { NotesPageSkeleton } from '../components/Skeleton';
import { MeetingNoteTab } from '../components/ManualNotes/MeetingNoteTab';
import ShareModal from '../components/ShareModal';
import {
  Workspace, getWorkspacesForTask, createWorkspace,
  addMeetingToWorkspace, removeMeetingFromWorkspace,
} from '../services/workspaceService';

interface NotesPageProps {
  selectedTask: TaskHistory | null;
  onNavigateToAssets?: () => void;
  isLoading?: boolean;
  isLoadingDetails?: boolean;
  onTaskUpdated?: (task: TaskHistory) => void;
  session?: { user: { name?: string; email: string } } | null;
}

type NoteTab = 'transcription' | 'summary' | 'notes' | 'note';

// Helper function to format transcription with bold speaker labels
function formatTranscriptionWithBoldSpeakers(text: string): string {
  if (!text) return '';
  
  // Match patterns like "Speaker 1:", "Speaker 2:", "Speaker A:", etc.
  // Also match common variations like "Host:", "Guest:", "Interviewer:", etc.
  const speakerPattern = /^(Speaker\s*\d+|Speaker\s*[A-Z]|Host|Guest|Interviewer|Interviewee|Moderator|Participant\s*\d*|Person\s*\d*)\s*:/gim;
  
  return text.replace(speakerPattern, (match) => `**${match.trim()}**`);
}

export default function NotesPage({ selectedTask, isLoading = false, isLoadingDetails = false, onTaskUpdated, session }: NotesPageProps) {
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
  const [showWorkspacePicker, setShowWorkspacePicker] = useState(false);
  const [showPeoplePicker, setShowPeoplePicker] = useState(false);
  const [wsSearch, setWsSearch] = useState('');
  const [newWsName, setNewWsName] = useState('');
  const [creatingWs, setCreatingWs] = useState(false);
  const [togglingWsId, setTogglingWsId] = useState<string | null>(null);
  const wsPicker = useRef<HTMLDivElement>(null);
  const peoplePicker = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setVisualizationImage(selectedTask?.visualization_image || null);
  }, [selectedTask?.id, selectedTask?.visualization_image]);

  // Load task workspaces whenever task changes
  useEffect(() => {
    if (!selectedTask?.id) { setWorkspaces([]); return; }
    getWorkspacesForTask(selectedTask.id).then(setWorkspaces).catch(() => setWorkspaces([]));
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
    setTogglingWsId(ws.id);
    try {
      if (ws.has_task) {
        await removeMeetingFromWorkspace(ws.id, selectedTask.id);
      } else {
        await addMeetingToWorkspace(ws.id, selectedTask.id);
      }
      setWorkspaces(prev => prev.map(w => w.id === ws.id ? { ...w, has_task: !w.has_task } : w));
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

  const assignedWorkspaces = workspaces.filter(w => w.has_task);
  const filteredWs = workspaces.filter(w =>
    !wsSearch || w.name.toLowerCase().includes(wsSearch.toLowerCase())
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
            <h1
              className="text-[17px] sm:text-[22px] font-semibold tracking-[-0.02em] text-zinc-900 dark:text-zinc-50 truncate flex-1 leading-tight"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
            >
              {selectedTask.filename}
            </h1>
            <button
              onClick={handleGenerateTitle}
              disabled={isGeneratingTitle}
              className="flex-shrink-0 flex items-center justify-center w-7 h-7 sm:w-auto sm:h-auto sm:gap-1.5 sm:px-2.5 sm:py-1 text-[10.5px] font-semibold text-app-fg-muted hover:text-app-fg bg-zinc-200/60 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip rounded-md transition-all disabled:opacity-30"
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
              className="flex-shrink-0 flex items-center justify-center w-7 h-7 sm:w-auto sm:h-auto sm:gap-1.5 sm:px-2.5 sm:py-1 text-[10.5px] font-semibold text-app-fg-muted hover:text-app-fg bg-zinc-200/60 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip rounded-md transition-all"
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
                <span>Me</span>
              </button>
              {showPeoplePicker && (
                <div className="absolute top-full left-0 mt-1.5 z-50 bg-app-panel border border-app-border rounded-2xl shadow-xl w-56 overflow-hidden">
                  <div className="px-3 pt-3 pb-2">
                    <input
                      autoFocus
                      placeholder="Add attendees…"
                      className="w-full text-[12px] text-app-fg bg-transparent outline-none placeholder:text-app-fg-subtle border-b border-app-border pb-2"
                    />
                  </div>
                  <div className="px-2 pb-2.5">
                    <div className="flex items-center gap-2 px-2 py-1.5 rounded-xl hover:bg-app-nav-hover-bg">
                      <div className="w-6 h-6 rounded-full bg-[#f06060]/15 flex items-center justify-center flex-shrink-0">
                        <span className="text-[10px] font-semibold text-[#f06060]">{(session?.user?.name || session?.user?.email || 'M')[0].toUpperCase()}</span>
                      </div>
                      <p className="text-[12px] font-medium text-app-fg leading-tight">
                        {session?.user?.name || session?.user?.email}
                        <span className="text-app-fg-subtle font-normal"> (me)</span>
                      </p>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Assigned workspace chips */}
            {assignedWorkspaces.map(ws => (
              <button
                key={ws.id}
                onClick={() => { setShowWorkspacePicker(true); setShowPeoplePicker(false); setWsSearch(''); }}
                className="flex items-center gap-1 px-2.5 py-1 rounded-full border border-zinc-200 dark:border-app-border text-[11.5px] text-zinc-500 dark:text-app-fg-muted hover:border-zinc-400 dark:hover:border-app-fg-subtle hover:text-zinc-700 dark:hover:text-app-fg transition-all"
              >
                <FolderOpen className="w-3 h-3 flex-shrink-0" />
                <span className="max-w-[120px] truncate">{ws.name}</span>
              </button>
            ))}

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
                  <div className="py-1.5 max-h-56 overflow-y-auto">
                    {filteredWs.map(ws => (
                      <button
                        key={ws.id}
                        onClick={() => toggleWorkspace(ws)}
                        disabled={togglingWsId === ws.id}
                        className="w-full flex items-center gap-3 px-3 py-2 hover:bg-app-nav-hover-bg transition-colors text-left disabled:opacity-60"
                      >
                        <span className="text-base leading-none w-5 flex-shrink-0">{ws.emoji}</span>
                        <span className="flex-1 text-[13px] text-app-fg truncate">{ws.name}</span>
                        {togglingWsId === ws.id ? (
                          <Loader2 className="w-3.5 h-3.5 animate-spin text-app-fg-subtle" />
                        ) : ws.has_task ? (
                          <Check className="w-3.5 h-3.5 text-emerald-500" />
                        ) : null}
                      </button>
                    ))}
                    {filteredWs.length === 0 && wsSearch && (
                      <p className="px-4 py-3 text-[12px] text-app-fg-subtle">No spaces found</p>
                    )}
                  </div>
                  <div className="border-t border-app-border px-3 py-2.5">
                    {newWsName ? (
                      <div className="flex items-center gap-2">
                        <input
                          autoFocus
                          value={newWsName}
                          onChange={e => setNewWsName(e.target.value)}
                          onKeyDown={e => { if (e.key === 'Enter') handleCreateWorkspace(); if (e.key === 'Escape') setNewWsName(''); }}
                          placeholder="Space name…"
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
                        className="w-full flex items-center gap-2.5 text-[11.5px] text-[#10b981] font-medium hover:opacity-80 transition-opacity"
                      >
                        <Plus className="w-3.5 h-3.5" />
                        New space
                      </button>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>

          {/* Tab Switcher — horizontally scrollable on mobile */}
          <div className="overflow-x-auto no-scrollbar -mx-3 sm:mx-0 px-3 sm:px-0">
            <div className="flex gap-[3px] bg-zinc-200/70 dark:bg-app-raised rounded-lg p-[3px] w-fit">
              {(['transcription', 'summary', 'notes', 'note'] as NoteTab[]).map((tab) => (
                <button
                  key={tab}
                  onClick={() => setNoteTab(tab)}
                  className={`px-2.5 sm:px-3 py-[4px] rounded-md text-[11px] sm:text-[11.5px] font-semibold transition-all whitespace-nowrap ${
                    noteTab === tab
                      ? 'bg-app-chip text-zinc-900 dark:text-app-fg shadow-sm shadow-black/10 dark:shadow-black/50 ring-1 ring-zinc-300/80 dark:ring-white/[0.08]'
                      : 'text-app-fg-muted hover:text-app-fg'
                  }`}
                >
                  {tab === 'note' ? 'My Note' : tab.charAt(0).toUpperCase() + tab.slice(1)}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="h-px bg-gradient-to-r from-transparent via-zinc-300/80 to-transparent dark:via-zinc-600/50" />
      </div>

      {/* Scrollable Content Area */}
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
                <div className="bg-zinc-100 dark:bg-app-raised p-4 sm:p-6 md:p-8 rounded-xl sm:rounded-2xl border border-zinc-200/90 dark:border-app-border">
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
