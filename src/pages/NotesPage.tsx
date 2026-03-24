import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { BookOpen, FileBox, Sparkles, Loader2, Check } from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { TaskHistory, updateTaskTitle } from '../services/supabaseService';
import { generateMeetingTitle } from '../services/geminiService';
import { NotesPageSkeleton } from '../components/Skeleton';

interface NotesPageProps {
  selectedTask: TaskHistory | null;
  onNavigateToAssets: () => void;
  isLoading?: boolean;
  onTaskUpdated?: (task: TaskHistory) => void;
}

type NoteTab = 'transcription' | 'summary' | 'notes';

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
      
      if (onTaskUpdated) {
        onTaskUpdated(updatedTask);
      }
      
      setTitleGenerated(true);
      setTimeout(() => setTitleGenerated(false), 2000);
    } catch (error) {
      console.error('Error generating title:', error);
    } finally {
      setIsGeneratingTitle(false);
    }
  };

  return (
    <div className="absolute inset-0 flex flex-col bg-white overflow-hidden">
      {/* Compact Fixed Header */}
      <div className="flex-none bg-white border-b border-[#141414]/10">
        <div className="max-w-4xl mx-auto w-full px-4 sm:px-6 py-3">
          {/* Top row: Breadcrumb + Assets button */}
          <div className="flex items-center justify-between gap-4 mb-2">
            <div className="flex items-center gap-2 opacity-50 text-xs overflow-hidden">
              <BookOpen className="w-3 h-3 flex-shrink-0" />
              <span className="truncate">{selectedTask.filename}</span>
            </div>
            <button 
              onClick={onNavigateToAssets}
              className="flex-shrink-0 flex items-center gap-1.5 px-3 py-1.5 border border-[#141414] text-[10px] font-mono uppercase tracking-wider hover:bg-[#141414] hover:text-white transition-all"
            >
              <FileBox className="w-3 h-3" />
              Assets
            </button>
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
            <button 
              onClick={() => setNoteTab('transcription')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${noteTab === 'transcription' ? 'bg-[#141414] text-white' : 'text-[#141414]/60 hover:text-[#141414] hover:bg-[#141414]/5'}`}
            >
              Transcription
            </button>
            <button 
              onClick={() => setNoteTab('summary')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${noteTab === 'summary' ? 'bg-[#141414] text-white' : 'text-[#141414]/60 hover:text-[#141414] hover:bg-[#141414]/5'}`}
            >
              Summary
            </button>
            <button 
              onClick={() => setNoteTab('notes')}
              className={`px-3 py-1.5 rounded-md text-xs font-medium transition-all ${noteTab === 'notes' ? 'bg-[#141414] text-white' : 'text-[#141414]/60 hover:text-[#141414] hover:bg-[#141414]/5'}`}
            >
              Notes
            </button>
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
                    <h3 className="text-xl font-serif italic mb-4">Key Summary</h3>
                    <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.summary || 'No summary generated.'}</Markdown>
                  </div>
                )}
                {noteTab === 'notes' && (
                  <div className="space-y-6">
                    <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.notes || 'No structured notes generated.'}</Markdown>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>
          </div>
        </div>
      </div>
    </div>
  );
}
