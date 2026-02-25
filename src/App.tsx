import React, { useState, useRef, useEffect } from 'react';
import { 
  Upload, 
  FileAudio, 
  CheckCircle2, 
  Loader2, 
  AlertCircle, 
  ChevronRight,
  Play,
  Layers,
  Clock,
  FileText,
  Save,
  History,
  ArrowLeft
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { format } from 'date-fns';
import { splitAudio, AudioBatch } from './services/audioService';
import { processAudioBatch, generateSummary, generateNotes, ProcessResult } from './services/geminiService';
import { TabSwitch } from './components/TabSwitch';
import { TabType } from './types/ui';
import { saveTaskHistory, uploadAudioFile, getTaskHistory } from './api/tasks';
import { TaskHistory } from './types';

type Status = 'idle' | 'splitting' | 'processing' | 'generating_extras' | 'completed' | 'error';
type ViewMode = 'processing' | 'history';

interface BatchStatus extends AudioBatch {
  status: 'pending' | 'processing' | 'completed' | 'error';
  result?: string;
  error?: string;
}

export default function App() {
  const [viewMode, setViewMode] = useState<ViewMode>('processing');
  const [historyTasks, setHistoryTasks] = useState<TaskHistory[]>([]);
  const [isLoadingHistory, setIsLoadingHistory] = useState(false);
  const [selectedHistoryTask, setSelectedHistoryTask] = useState<TaskHistory | null>(null);

  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [prompt, setPrompt] = useState('Please provide a detailed transcription of this audio.');
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<TabType>('transcription');
  const [summary, setSummary] = useState<string>('');
  const [notes, setNotes] = useState<string>('');
  const [processingTime, setProcessingTime] = useState<number>(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (viewMode === 'history') {
      loadHistory();
    }
  }, [viewMode]);

  const loadHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const tasks = await getTaskHistory();
      setHistoryTasks(tasks);
    } catch (err) {
      console.error('Failed to load history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      setFile(selectedFile);
      setError(null);
      setStatus('idle');
      setBatches([]);
      setSummary('');
      setNotes('');
      setActiveTab('transcription');
    }
  };

  const startProcessing = async () => {
    if (!file) return;

    const startTime = Date.now();
    try {
      setStatus('splitting');
      setError(null);
      setSummary('');
      setNotes('');
      setActiveTab('transcription');
      
      // Split audio into batches (max 15MB each to stay safe under 20MB limit)
      const audioBatches = await splitAudio(file, 15);
      
      const initialBatches: BatchStatus[] = audioBatches.map(b => ({
        ...b,
        status: 'pending'
      }));
      
      setBatches(initialBatches);
      setStatus('processing');

      // Process batches sequentially to avoid hitting rate limits too hard
      const results: BatchStatus[] = [...initialBatches];
      let fullTranscription = '';
      
      for (let i = 0; i < results.length; i++) {
        results[i].status = 'processing';
        setBatches([...results]);

        try {
          const result = await processAudioBatch(results[i], prompt);
          results[i].status = 'completed';
          results[i].result = result.text;
          fullTranscription += result.text + '\n\n';
        } catch (err: any) {
          console.error(`Error processing batch ${i}:`, err);
          results[i].status = 'error';
          results[i].error = err.message || 'Unknown error';
        }
        
        setBatches([...results]);
      }

      setStatus('generating_extras');
      
      // Generate Summary and Notes
      try {
        const [generatedSummary, generatedNotes, audioUrl] = await Promise.all([
          generateSummary(fullTranscription),
          generateNotes(fullTranscription),
          uploadAudioFile(file)
        ]);
        
        setSummary(generatedSummary);
        setNotes(generatedNotes);
        
        const duration = Date.now() - startTime;
        setProcessingTime(duration);
        
        // Save to Supabase
        await saveTaskHistory({
          filename: file.name,
          transcription: fullTranscription.trim(),
          summary: generatedSummary,
          notes: generatedNotes,
          audio_url: audioUrl,
          status: 'completed',
          duration: duration
        });
        
      } catch (err) {
        console.error('Error generating summary/notes or saving:', err);
        // Continue even if extras fail
      }

      setStatus('completed');
    } catch (err: any) {
      console.error('Processing failed:', err);
      setError(err.message || 'Failed to process audio. Make sure the file is a valid audio format.');
      setStatus('error');
    }
  };

  const totalProgress = batches.length > 0 
    ? (batches.filter(b => b.status === 'completed').length / batches.length) * 100 
    : 0;

  const combinedResult = batches
    .filter(b => b.status === 'completed')
    .map(b => b.result)
    .join('\n\n---\n\n');

  const getContentToCopy = () => {
    switch(activeTab) {
      case 'transcription': return combinedResult;
      case 'summary': return summary;
      case 'notes': return notes;
      default: return combinedResult;
    }
  };

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center bg-white sticky top-0 z-50">
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 cursor-pointer" onClick={() => setViewMode('processing')}>
            <Layers className="w-8 h-8" />
            <h1 className="text-2xl font-bold tracking-tight uppercase">AudioBatch AI</h1>
          </div>
          
          <nav className="hidden md:flex items-center gap-4 ml-8 border-l border-[#141414]/20 pl-8">
            <button 
              onClick={() => setViewMode('processing')}
              className={`text-sm font-medium uppercase tracking-wider transition-colors ${viewMode === 'processing' ? 'text-[#141414] font-bold' : 'text-[#141414]/50 hover:text-[#141414]'}`}
            >
              Process
            </button>
            <button 
              onClick={() => setViewMode('history')}
              className={`text-sm font-medium uppercase tracking-wider transition-colors flex items-center gap-2 ${viewMode === 'history' ? 'text-[#141414] font-bold' : 'text-[#141414]/50 hover:text-[#141414]'}`}
            >
              <History className="w-4 h-4" />
              History
            </button>
          </nav>
        </div>
        
        {viewMode === 'processing' && (
          <div className="text-xs font-mono opacity-50 uppercase tracking-widest">
            Status: {status}
          </div>
        )}
      </header>

      {viewMode === 'history' ? (
        <main className="max-w-7xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* History List */}
          <div className="lg:col-span-4 space-y-6">
            <section className="border border-[#141414] bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col h-[calc(100vh-140px)]">
              <div className="p-4 border-b border-[#141414] bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
                <h2 className="font-serif italic text-sm uppercase tracking-wider">Past Tasks</h2>
                <span className="font-mono text-[10px]">{historyTasks.length} total</span>
              </div>
              
              <div className="flex-1 overflow-y-auto p-4 space-y-3">
                {isLoadingHistory ? (
                  <div className="flex justify-center items-center h-32">
                    <Loader2 className="w-6 h-6 animate-spin opacity-50" />
                  </div>
                ) : historyTasks.length === 0 ? (
                  <div className="text-center opacity-50 font-serif italic py-8">
                    No history found. Process some audio first.
                  </div>
                ) : (
                  historyTasks.map(task => (
                    <div 
                      key={task.id}
                      onClick={() => {
                        setSelectedHistoryTask(task);
                        setActiveTab('transcription');
                      }}
                      className={`p-4 border border-[#141414] cursor-pointer transition-all ${selectedHistoryTask?.id === task.id ? 'bg-[#F5F5F5] shadow-[2px_2px_0px_0px_rgba(20,20,20,1)]' : 'hover:bg-[#F9F9F9]'}`}
                    >
                      <div className="flex items-start justify-between mb-2">
                        <div className="font-mono text-xs font-bold truncate pr-4">{task.filename}</div>
                        {task.status === 'completed' ? (
                          <CheckCircle2 className="w-4 h-4 text-green-600 shrink-0" />
                        ) : (
                          <AlertCircle className="w-4 h-4 text-red-600 shrink-0" />
                        )}
                      </div>
                      <div className="text-[10px] opacity-50 flex items-center justify-between font-mono">
                        <span>{format(new Date(task.created_at), 'MMM d, h:mm a')}</span>
                        <span>{Math.round(task.duration / 1000)}s</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </section>
          </div>

          {/* History Details */}
          <div className="lg:col-span-8">
            <section className="border border-[#141414] bg-white h-[calc(100vh-140px)] shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
              {selectedHistoryTask ? (
                <>
                  <div className="p-4 border-b border-[#141414] flex justify-between items-center bg-[#F5F5F5] flex-wrap gap-4">
                    <div className="flex items-center gap-2">
                      <FileText className="w-5 h-5" />
                      <h2 className="font-serif italic text-sm uppercase tracking-wider truncate max-w-[200px]">
                        {selectedHistoryTask.filename}
                      </h2>
                    </div>
                    
                    <div className="flex-1 flex justify-center">
                      <TabSwitch activeTab={activeTab} onChange={setActiveTab} />
                    </div>

                    <div className="flex items-center gap-4">
                      {selectedHistoryTask.audio_url && (
                        <a 
                          href={selectedHistoryTask.audio_url} 
                          target="_blank" 
                          rel="noreferrer"
                          className="flex items-center gap-1 text-[10px] font-mono uppercase underline hover:no-underline"
                        >
                          <Play className="w-3 h-3" /> Audio
                        </a>
                      )}
                      <button 
                        onClick={() => {
                          const content = activeTab === 'transcription' ? selectedHistoryTask.transcription : 
                                        activeTab === 'summary' ? selectedHistoryTask.summary : 
                                        selectedHistoryTask.notes;
                          navigator.clipboard.writeText(content || '');
                          alert('Copied to clipboard!');
                        }}
                        className="text-[10px] font-mono uppercase underline hover:no-underline"
                      >
                        Copy {activeTab}
                      </button>
                    </div>
                  </div>

                  <div className="flex-1 p-8 overflow-y-auto prose prose-sm max-w-none prose-headings:font-serif prose-headings:italic prose-p:font-sans prose-p:leading-relaxed">
                    {activeTab === 'transcription' && (
                      <div className="markdown-body">
                        <Markdown>{selectedHistoryTask.transcription}</Markdown>
                      </div>
                    )}
                    {activeTab === 'summary' && (
                      <div className="markdown-body">
                        {selectedHistoryTask.summary ? (
                          <Markdown>{selectedHistoryTask.summary}</Markdown>
                        ) : (
                          <p className="opacity-50 italic">No summary generated for this task.</p>
                        )}
                      </div>
                    )}
                    {activeTab === 'notes' && (
                      <div className="markdown-body custom-notes-styling">
                        {selectedHistoryTask.notes ? (
                          <Markdown>{selectedHistoryTask.notes}</Markdown>
                        ) : (
                          <p className="opacity-50 italic">No notes generated for this task.</p>
                        )}
                      </div>
                    )}
                  </div>
                </>
              ) : (
                <div className="h-full flex flex-col items-center justify-center opacity-20 grayscale">
                  <History className="w-20 h-20 mb-4" />
                  <p className="font-serif italic text-lg">Select a task to view details</p>
                </div>
              )}
            </section>
          </div>
        </main>
      ) : (
        <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
          {/* Left Column: Controls & Batches */}
          <div className="lg:col-span-5 space-y-6">
          {/* Upload Section */}
          <section className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <h2 className="font-serif italic text-sm uppercase opacity-50 mb-4 tracking-wider">01. Input Configuration</h2>
            
            <div 
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed border-[#141414]/20 p-8 text-center cursor-pointer hover:bg-[#F5F5F5] transition-colors mb-4 ${file ? 'bg-[#F5F5F5]' : ''}`}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
                accept="audio/*"
              />
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileAudio className="w-10 h-10 mb-2" />
                  <span className="font-mono text-sm font-bold">{file.name}</span>
                  <span className="text-xs opacity-50">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="w-10 h-10 mb-2 opacity-30" />
                  <span className="text-sm font-medium">Click or drag audio file to upload</span>
                  <span className="text-xs opacity-50">Supports MP3, M4A, WAV, etc.</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-mono uppercase opacity-50">Instruction / Prompt</label>
              <textarea 
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full border border-[#141414] p-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[#141414] resize-none h-24"
                placeholder="What should the AI do with this audio?"
              />
            </div>

            <button 
              onClick={startProcessing}
              disabled={!file || status === 'processing' || status === 'splitting' || status === 'generating_extras'}
              className="w-full mt-6 bg-[#141414] text-[#E4E3E0] py-4 font-bold uppercase tracking-widest hover:bg-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {(status === 'processing' || status === 'splitting' || status === 'generating_extras') ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  {status === 'generating_extras' ? 'Generating Summary & Notes...' : 'Processing...'}
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 fill-current" />
                  Start Batch Process
                </>
              )}
            </button>

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-600 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}
          </section>

          {/* Batch List */}
          <AnimatePresence>
            {batches.length > 0 && (
              <motion.section 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="border border-[#141414] bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] overflow-hidden"
              >
                <div className="p-4 border-b border-[#141414] bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
                  <h2 className="font-serif italic text-sm uppercase tracking-wider">02. Batch Queue</h2>
                  <span className="font-mono text-[10px]">{Math.round(totalProgress)}% Complete</span>
                </div>
                
                <div className="max-h-[400px] overflow-y-auto">
                  {batches.map((batch, idx) => (
                    <div 
                      key={idx} 
                      className={`p-4 border-b border-[#141414]/10 flex items-center justify-between hover:bg-[#F9F9F9] transition-colors ${batch.status === 'processing' ? 'bg-[#F9F9F9]' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full border border-[#141414] flex items-center justify-center text-xs font-mono ${batch.status === 'completed' ? 'bg-[#141414] text-[#E4E3E0]' : ''}`}>
                          {idx + 1}
                        </div>
                        <div>
                          <div className="text-xs font-bold font-mono">Batch {idx + 1}</div>
                          <div className="text-[10px] opacity-50 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {Math.floor(batch.startTime)}s - {Math.floor(batch.endTime)}s
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        {batch.status === 'pending' && <div className="w-2 h-2 rounded-full bg-[#141414]/20" />}
                        {batch.status === 'processing' && <Loader2 className="w-4 h-4 animate-spin opacity-50" />}
                        {batch.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                        {batch.status === 'error' && <AlertCircle className="w-4 h-4 text-red-600" />}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>

        {/* Right Column: Results */}
        <div className="lg:col-span-7">
          <section className="border border-[#141414] bg-white h-full min-h-[600px] shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
            <div className="p-4 border-b border-[#141414] flex justify-between items-center bg-[#F5F5F5] flex-wrap gap-4">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                <h2 className="font-serif italic text-sm uppercase tracking-wider">03. Output Analysis</h2>
              </div>
              
              <div className="flex-1 flex justify-center">
                <TabSwitch activeTab={activeTab} onChange={setActiveTab} />
              </div>

              <div className="flex items-center gap-4">
                {(status === 'processing' || status === 'generating_extras') && (
                  <div className="flex items-center gap-2 text-[10px] font-mono animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    {status === 'generating_extras' ? 'Synthesizing...' : 'Processing...'}
                  </div>
                )}
                {status === 'completed' && (
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(getContentToCopy());
                      alert('Copied to clipboard!');
                    }}
                    className="text-[10px] font-mono uppercase underline hover:no-underline"
                  >
                    Copy {activeTab}
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 p-8 overflow-y-auto prose prose-sm max-w-none prose-headings:font-serif prose-headings:italic prose-p:font-sans prose-p:leading-relaxed">
              {status === 'idle' && !file && (
                <div className="h-full flex flex-col items-center justify-center opacity-20 grayscale">
                  <FileText className="w-20 h-20 mb-4" />
                  <p className="font-serif italic text-lg">Waiting for input...</p>
                </div>
              )}

              {status === 'splitting' && (
                <div className="h-full flex flex-col items-center justify-center">
                  <Loader2 className="w-10 h-10 animate-spin mb-4" />
                  <p className="font-mono text-xs uppercase tracking-widest">Decoding & Splitting Audio...</p>
                  <p className="text-[10px] opacity-50 mt-2">Preparing batches for processing</p>
                </div>
              )}

              {/* Transcription Tab */}
              {activeTab === 'transcription' && batches.length > 0 && (
                <div className="space-y-8">
                  {batches.map((batch, idx) => (
                    <div key={idx} className={batch.status === 'completed' ? 'opacity-100' : 'opacity-30'}>
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-[10px] font-mono bg-[#141414] text-[#E4E3E0] px-2 py-0.5">BATCH {idx + 1}</span>
                        <span className="text-[10px] font-mono opacity-50">{Math.floor(batch.startTime)}s - {Math.floor(batch.endTime)}s</span>
                      </div>
                      {batch.status === 'completed' ? (
                        <div className="markdown-body">
                          <Markdown>{batch.result}</Markdown>
                        </div>
                      ) : batch.status === 'processing' ? (
                        <div className="space-y-2">
                          <div className="h-4 bg-[#141414]/5 w-full animate-pulse" />
                          <div className="h-4 bg-[#141414]/5 w-3/4 animate-pulse" />
                          <div className="h-4 bg-[#141414]/5 w-5/6 animate-pulse" />
                        </div>
                      ) : batch.status === 'error' ? (
                        <div className="text-red-500 text-xs font-mono italic">
                          Error: {batch.error}
                        </div>
                      ) : (
                        <div className="text-[10px] font-mono opacity-30 italic">Pending processing...</div>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Summary Tab */}
              {activeTab === 'summary' && (
                <div className="h-full">
                  {status === 'generating_extras' || status === 'processing' ? (
                    <div className="h-full flex flex-col items-center justify-center space-y-4">
                      <Loader2 className="w-8 h-8 animate-spin opacity-50" />
                      <p className="font-mono text-xs uppercase tracking-widest animate-pulse">Generating Summary...</p>
                    </div>
                  ) : summary ? (
                    <div className="markdown-body">
                      <Markdown>{summary}</Markdown>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center opacity-30">
                      <p className="font-serif italic">Process audio to view summary</p>
                    </div>
                  )}
                </div>
              )}

              {/* Notes Tab */}
              {activeTab === 'notes' && (
                <div className="h-full">
                  {status === 'generating_extras' || status === 'processing' ? (
                    <div className="h-full flex flex-col items-center justify-center space-y-4">
                      <Loader2 className="w-8 h-8 animate-spin opacity-50" />
                      <p className="font-mono text-xs uppercase tracking-widest animate-pulse">Structuring Notes...</p>
                    </div>
                  ) : notes ? (
                    <div className="markdown-body custom-notes-styling">
                      <Markdown>{notes}</Markdown>
                    </div>
                  ) : (
                    <div className="h-full flex flex-col items-center justify-center opacity-30">
                      <p className="font-serif italic">Process audio to view notes</p>
                    </div>
                  )}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>
      )}

      {/* Footer */}
      <footer className="mt-12 border-t border-[#141414] p-6 text-center">
        <p className="text-[10px] font-mono uppercase opacity-50 tracking-widest">
          Built with Gemini 3.1 & Web Audio API • No file size limits
        </p>
      </footer>
    </div>
  );
}
