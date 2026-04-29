import { useState, useEffect } from 'react';
import { logger } from '../lib/logger';

const log = logger.scope('NotesPage');
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Sparkles, Loader2, Check, RefreshCw, Image as ImageIcon, Share2 } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TaskHistory, updateTaskTitle, updateTaskSummary, updateTaskNotes, updateTaskVisualization } from '../services/supabaseService';
import { generateMeetingTitle, generateSummary, generateNotes, generateNotesVisualization } from '../services/geminiService';
import { NotesPageSkeleton } from '../components/Skeleton';
import { MeetingNoteTab } from '../components/ManualNotes/MeetingNoteTab';
import ShareModal from '../components/ShareModal';

interface NotesPageProps {
  selectedTask: TaskHistory | null;
  onNavigateToAssets?: () => void;
  isLoading?: boolean;
  onTaskUpdated?: (task: TaskHistory) => void;
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

export default function NotesPage({ selectedTask, onNavigateToAssets, isLoading = false, onTaskUpdated }: NotesPageProps) {
  const [noteTab, setNoteTab] = useState<NoteTab>('transcription');
  const [isGeneratingTitle, setIsGeneratingTitle] = useState(false);
  const [titleGenerated, setTitleGenerated] = useState(false);
  const [isRegeneratingSummary, setIsRegeneratingSummary] = useState(false);
  const [summaryRegenerated, setSummaryRegenerated] = useState(false);
  const [isRegeneratingNotes, setIsRegeneratingNotes] = useState(false);
  const [notesRegenerated, setNotesRegenerated] = useState(false);
  const [isVisualizing, setIsVisualizing] = useState(false);
  const [visualizationImage, setVisualizationImage] = useState<string | null>(selectedTask?.visualization_image || null);
  const [isShareOpen, setIsShareOpen] = useState(false);

  useEffect(() => {
    setVisualizationImage(selectedTask?.visualization_image || null);
  }, [selectedTask?.id, selectedTask?.visualization_image]);

  // Show skeleton while loading
  if (isLoading || !selectedTask) {
    return <NotesPageSkeleton />;
  }

  const handleGenerateTitle = async () => {
    if (!selectedTask.id || !selectedTask.transcription) return;
    
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
    <div className="absolute inset-0 flex flex-col bg-white overflow-hidden">
      {/* Header */}
      <div className="flex-none bg-white/95 backdrop-blur-xl sticky top-0 z-10">
        <div className="max-w-3xl lg:max-w-4xl mx-auto w-full px-6 sm:px-8 pt-4 pb-3">
          {/* Breadcrumb + date */}
          <div className="flex items-center gap-1.5 mb-1.5 text-[10.5px] tracking-[0.04em] uppercase">
            <BookOpen className="w-3 h-3 text-[#a89888]" />
            <span className="truncate max-w-[180px] text-[#9a8d7f] font-semibold">{selectedTask.filename}</span>
            <span className="text-[#c4bab0]">·</span>
            <span className="flex-shrink-0 text-[#b5a99a] font-medium">
              {new Date(selectedTask.created_at!).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}
            </span>
          </div>
          
          {/* Title row — tighter, warmer, editorial */}
          <div className="flex items-center gap-2.5 mb-2.5">
            <h1
              className="text-[19px] sm:text-[22px] font-semibold tracking-[-0.02em] text-[#2c2520] truncate flex-1 leading-tight"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
            >
              {selectedTask.filename}
            </h1>
            <button
              onClick={handleGenerateTitle}
              disabled={isGeneratingTitle}
              className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-semibold text-[#a89888] hover:text-[#5c5147] bg-[#e8e2da]/40 hover:bg-[#e8e2da]/80 rounded-md transition-all disabled:opacity-30"
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
              className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[10.5px] font-semibold text-[#a89888] hover:text-[#5c5147] bg-[#e8e2da]/40 hover:bg-[#e8e2da]/80 rounded-md transition-all"
              title="Share meeting notes"
            >
              <Share2 className="w-3 h-3" />
              <span className="hidden sm:inline">Share</span>
            </button>
          </div>

          {/* Tab Switcher — compact warm pills */}
          <div className="flex gap-[3px] bg-[#e8e2da]/60 rounded-lg p-[3px] w-fit">
            {(['transcription', 'summary', 'notes', 'note'] as NoteTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setNoteTab(tab)}
                className={`px-3 py-[4px] rounded-md text-[11.5px] font-semibold transition-all ${
                  noteTab === tab
                    ? 'bg-white text-[#2c2520] shadow-sm shadow-[#c4bab0]/25'
                    : 'text-[#9a8d7f] hover:text-[#5c5147]'
                }`}
              >
                {tab === 'note' ? 'My Note' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>
        {/* Thin warm accent line */}
        <div className="h-[1.5px] bg-gradient-to-r from-transparent via-[#c4bab0]/80 to-transparent" />
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-3xl lg:max-w-4xl mx-auto w-full px-6 sm:px-8 py-8">
          <AnimatePresence mode="wait">
            <motion.div
              key={noteTab}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2 }}
            >
              {noteTab === 'transcription' && (
                <div className="prose prose-sm max-w-none prose-p:text-[14.5px] prose-p:leading-[1.75] prose-p:text-[#1a1a1a]/75 prose-strong:text-[#1a1a1a] prose-headings:tracking-tight transcription-content markdown-body">
                  <Markdown remarkPlugins={[remarkGfm]}>{formatTranscriptionWithBoldSpeakers(selectedTask.transcription)}</Markdown>
                </div>
              )}

              {noteTab === 'summary' && (
                <div className="bg-[#faf8f6] p-6 sm:p-8 rounded-2xl border border-[#141414]/[0.05]">
                  <div className="flex items-center justify-between mb-5">
                    <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[#1a1a1a]">Key Summary</h3>
                    <button
                      onClick={handleRegenerateSummary}
                      disabled={isRegeneratingSummary}
                      className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[#141414]/40 hover:text-[#141414]/70 hover:bg-white rounded-lg transition-all disabled:opacity-30"
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
                      <Loader2 className="w-5 h-5 animate-spin text-[#141414]/20" />
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none prose-p:text-[14px] prose-p:leading-[1.75] prose-p:text-[#1a1a1a]/70 prose-strong:text-[#1a1a1a] prose-headings:tracking-tight markdown-body">
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.summary || 'No summary generated.'}</Markdown>
                    </div>
                  )}
                </div>
              )}

              {noteTab === 'notes' && (
                <div className="space-y-6">
                  {/* Notes toolbar */}
                  <div className="flex items-center justify-between">
                    <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[#1a1a1a]">Structured Notes</h3>
                    <div className="flex items-center gap-1">
                      <button
                        onClick={handleVisualizeNotes}
                        disabled={isVisualizing || (!selectedTask.notes && !selectedTask.summary)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[#141414]/40 hover:text-[#141414]/70 hover:bg-[#141414]/[0.04] rounded-lg transition-all disabled:opacity-30"
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
                        className="flex items-center gap-1.5 px-2.5 py-1.5 text-[11px] font-medium text-[#141414]/40 hover:text-[#141414]/70 hover:bg-[#141414]/[0.04] rounded-lg transition-all disabled:opacity-30"
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
                    <div className="rounded-2xl overflow-hidden border border-[#141414]/[0.05] bg-[#faf8f6]">
                      <div className="px-4 py-3 border-b border-[#141414]/[0.05] flex items-center justify-between">
                        <span className="text-[12px] font-medium text-[#1a1a1a]/60 flex items-center gap-1.5">
                          <Sparkles className="w-3.5 h-3.5 text-amber-500" />
                          AI Visualization
                        </span>
                        <button 
                          onClick={() => setVisualizationImage(null)}
                          className="text-[11px] font-medium text-[#141414]/30 hover:text-[#141414]/60 transition-colors"
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
                      <Loader2 className="w-5 h-5 animate-spin text-[#141414]/20" />
                    </div>
                  ) : (
                    <div className="prose prose-sm max-w-none prose-p:text-[14px] prose-p:leading-[1.75] prose-p:text-[#1a1a1a]/70 prose-strong:text-[#1a1a1a] prose-headings:tracking-tight prose-h2:text-[16px] prose-h2:font-semibold prose-h3:text-[14px] prose-h3:font-semibold prose-li:text-[14px] prose-li:text-[#1a1a1a]/70 markdown-body">
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
