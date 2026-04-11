import { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, Sparkles, Loader2, Check, RefreshCw, Image as ImageIcon } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TaskHistory, updateTaskTitle, updateTaskSummary, updateTaskNotes, updateTaskVisualization } from '../services/supabaseService';
import { generateMeetingTitle, generateSummary, generateNotes, generateNotesVisualization } from '../services/geminiService';
import { NotesPageSkeleton } from '../components/Skeleton';
import { MeetingNoteTab } from '../components/ManualNotes/MeetingNoteTab';

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
      console.error('Error generating title:', error);
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
      console.error('Error regenerating summary:', error);
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
      console.error('Error visualizing notes:', error);
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
      console.error('Error regenerating notes:', error);
    } finally {
      setIsRegeneratingNotes(false);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-[#faf9f7] overflow-hidden">
      {/* Compact Fixed Header */}
      <div className="flex-none bg-[#faf9f7] border-b border-[#141414]/10">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-3">
          {/* Top row: Breadcrumb */}
          <div className="flex items-center gap-2 mb-2 opacity-50 text-xs overflow-hidden">
            <BookOpen className="w-3 h-3 flex-shrink-0" />
            <span className="truncate">{selectedTask.filename}</span>
          </div>
          
          {/* Title + Meta inline */}
          <div className="flex items-center gap-4 mb-3">
            <h1 className="text-lg sm:text-xl font-bold tracking-tight truncate flex-1">{selectedTask.filename}</h1>
            <button
              onClick={handleGenerateTitle}
              disabled={isGeneratingTitle}
              className="flex-shrink-0 flex items-center gap-1.5 px-2 py-1 text-[10px] font-mono opacity-60 hover:opacity-100 hover:bg-gray-100 rounded transition-all disabled:opacity-40"
              title="Generate AI title based on content"
            >
              {isGeneratingTitle ? (
                <Loader2 className="w-3 h-3 animate-spin" />
              ) : titleGenerated ? (
                <Check className="w-3 h-3 text-green-600" />
              ) : (
                <Sparkles className="w-3 h-3" />
              )}
              <span className="hidden sm:inline">{titleGenerated ? 'Done!' : 'Generate Title'}</span>
            </button>
            <span className="text-[10px] font-mono opacity-40 flex-shrink-0 hidden sm:block">
              {new Date(selectedTask.created_at!).toLocaleDateString()}
            </span>
          </div>

          {/* Tab Switcher - Compact */}
          <div className="flex gap-1">
            {(['transcription', 'summary', 'notes', 'note'] as NoteTab[]).map((tab) => (
              <button
                key={tab}
                onClick={() => setNoteTab(tab)}
                className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all capitalize ${noteTab === tab ? 'bg-[#141414] text-white' : 'text-[#141414]/60 hover:text-[#141414] hover:bg-[#141414]/5'}`}
              >
                {tab === 'note' ? 'My Note' : tab.charAt(0).toUpperCase() + tab.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Scrollable Content Area */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-8 py-8">
          <div className="prose prose-lg max-w-none">
            <AnimatePresence mode="wait">
              <motion.div
                key={noteTab}
                initial={{ opacity: 0, x: 10 }}
                animate={{ opacity: 1, x: 0 }}
                exit={{ opacity: 0, x: -10 }}
                transition={{ duration: 0.2 }}
                className="markdown-body"
              >
                {noteTab === 'transcription' && (
                  <div className="space-y-4 transcription-content">
                    <Markdown remarkPlugins={[remarkGfm]}>{formatTranscriptionWithBoldSpeakers(selectedTask.transcription)}</Markdown>
                  </div>
                )}
                {noteTab === 'summary' && (
                  <div className="bg-[#F5F5F5] p-4 sm:p-8 rounded-2xl border border-[#141414]/5">
                    <div className="flex items-center justify-between mb-4">
                      <h3 className="text-xl font-serif italic">Key Summary</h3>
                      <button
                        onClick={handleRegenerateSummary}
                        disabled={isRegeneratingSummary}
                        className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-[#141414]/60 hover:text-[#141414] hover:bg-white rounded-lg transition-all disabled:opacity-40"
                        title="Regenerate summary with improved multilingual support"
                      >
                        {isRegeneratingSummary ? (
                          <Loader2 className="w-4 h-4 animate-spin" />
                        ) : summaryRegenerated ? (
                          <Check className="w-4 h-4 text-green-600" />
                        ) : (
                          <RefreshCw className="w-4 h-4" />
                        )}
                        <span>{summaryRegenerated ? 'Updated!' : 'Regenerate'}</span>
                      </button>
                    </div>
                    {isRegeneratingSummary ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin text-[#141414]/40" />
                      </div>
                    ) : (
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.summary || 'No summary generated.'}</Markdown>
                    )}
                  </div>
                )}
                {noteTab === 'notes' && (
                  <div className="space-y-6">
                    <div className="flex items-center justify-between mb-4 pb-4 border-b border-[#141414]/10">
                      <h3 className="text-xl font-bold">Structured Notes</h3>
                      <div className="flex items-center gap-2">
                        <button
                          onClick={handleVisualizeNotes}
                          disabled={isVisualizing || (!selectedTask.notes && !selectedTask.summary)}
                          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-[#141414]/60 hover:text-[#141414] hover:bg-[#F5F5F5] rounded-lg transition-all disabled:opacity-40"
                          title="Generate a hand-drawn style visualization of these notes"
                        >
                          {isVisualizing ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : (
                            <ImageIcon className="w-4 h-4" />
                          )}
                          <span>Visualize</span>
                        </button>
                        <button
                          onClick={handleRegenerateNotes}
                          disabled={isRegeneratingNotes}
                          className="flex items-center gap-2 px-3 py-1.5 text-xs font-medium text-[#141414]/60 hover:text-[#141414] hover:bg-[#F5F5F5] rounded-lg transition-all disabled:opacity-40"
                          title="Regenerate notes with improved multilingual support"
                        >
                          {isRegeneratingNotes ? (
                            <Loader2 className="w-4 h-4 animate-spin" />
                          ) : notesRegenerated ? (
                            <Check className="w-4 h-4 text-green-600" />
                          ) : (
                            <RefreshCw className="w-4 h-4" />
                          )}
                          <span>{notesRegenerated ? 'Updated!' : 'Regenerate'}</span>
                        </button>
                      </div>
                    </div>
                    
                    {/* Visualization Result */}
                    {visualizationImage && (
                      <div className="mb-6 border border-[#141414]/10 rounded-xl overflow-hidden bg-[#F5F5F5]">
                        <div className="p-3 border-b border-[#141414]/10 bg-white flex items-center justify-between">
                          <span className="text-sm font-medium flex items-center gap-2">
                            <Sparkles className="w-4 h-4 text-amber-500" />
                            AI Visualization
                          </span>
                          <button 
                            onClick={() => setVisualizationImage(null)}
                            className="text-xs opacity-60 hover:opacity-100"
                          >
                            Close
                          </button>
                        </div>
                        <div className="p-4 flex justify-center">
                          <img 
                            src={visualizationImage} 
                            alt="Notes Visualization" 
                            className="max-w-full h-auto rounded-lg shadow-sm"
                            style={{ maxHeight: '600px' }}
                          />
                        </div>
                      </div>
                    )}
                    
                    {isRegeneratingNotes ? (
                      <div className="flex items-center justify-center py-12">
                        <Loader2 className="w-6 h-6 animate-spin text-[#141414]/40" />
                      </div>
                    ) : (
                      <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.notes || 'No structured notes generated.'}</Markdown>
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
      </div>
    </div>
  );
}
