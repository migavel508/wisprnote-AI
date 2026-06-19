import React, { useState, useRef, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Upload, 
  FileAudio, 
  CheckCircle2, 
  Loader2, 
  Mic, 
  StopCircle, 
  PauseCircle, 
  PlayCircle,
  ChevronUp,
  ChevronDown,
  Sparkles,
  Radio,
  Layers
} from 'lucide-react';
import type { RecordingMode } from '../services/nativeRecorderService';
import PermissionsGate from '../components/PermissionsGate';

interface ProcessPageProps {
  file: File | null;
  setFile: (file: File | null) => void;
  isRecording: boolean;
  isPaused: boolean;
  recordingTime: number;
  startRecording: () => void;
  stopRecording: () => void;
  pauseRecording: () => void;
  resumeRecording: () => void;
  /** True while a pause/resume/stop op is in flight — disables pause/resume to block mashing. */
  isControlBusy?: boolean;
  prompt: string;
  setPrompt: (prompt: string) => void;
  startProcessing: () => void;
  status: string;
  batches: Array<{ status: string }>;
  totalProgress: number;
  processingHeadline?: string;
  processingSubtext?: string;
  inputMode: 'upload' | 'record';
  setInputMode: (mode: 'upload' | 'record') => void;
  nativeServerAvailable: boolean;
  desktopRecordingMode: RecordingMode;
  setDesktopRecordingMode: (mode: RecordingMode) => void;
  realtimeTranscript: string[];
  interimTranscript: string;
  permissionsGranted: boolean;
  onPermissionsGranted: () => void;
  currentInputDevice?: string | null;
  deviceRestartNotice?: boolean;
}

type ViewState = 'collapsed' | 'expanded';

// Committed (finalized) transcript lines. Memoized on the array reference so the
// fast interim updates — which fire several times a second and only change the
// faded partial line — don't re-render and re-diff the entire (ever-growing) list.
// In a long meeting that list is hundreds of lines; without this, every partial
// word reconciled all of them, which is what made the live transcript feel laggy.
const CommittedTranscript = React.memo(({ lines }: { lines: string[] }) => (
  <>
    {lines.map((line, i) => (
      <p key={i} className="text-[13px] text-zinc-700 dark:text-zinc-300 leading-relaxed py-1">{line}</p>
    ))}
  </>
));
CommittedTranscript.displayName = 'CommittedTranscript';

const formatTime = (seconds: number) => {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
};

export default function ProcessPage({
  file,
  setFile,
  isRecording,
  isPaused,
  recordingTime,
  startRecording,
  stopRecording,
  pauseRecording,
  resumeRecording,
  isControlBusy = false,
  prompt,
  setPrompt,
  startProcessing,
  status,
  batches,
  totalProgress,
  processingHeadline = 'Working my magic ✨',
  processingSubtext = 'Tiny wait, big result 😄',
  inputMode,
  setInputMode,
  nativeServerAvailable,
  desktopRecordingMode,
  setDesktopRecordingMode,
  realtimeTranscript,
  interimTranscript,
  permissionsGranted,
  onPermissionsGranted,
  currentInputDevice,
  deviceRestartNotice
}: ProcessPageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [viewState, setViewState] = useState<ViewState>('collapsed');
  const [barHeights, setBarHeights] = useState([8, 14, 6]);
  const [showTooltip, setShowTooltip] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

  // Auto-scroll live transcript. Use instant ('auto') not 'smooth': interim updates
  // fire several times a second, and queuing an overlapping smooth-scroll animation on
  // each one is what made the panel jitter and lag during an active meeting.
  useEffect(() => {
    if (transcriptEndRef.current) {
      transcriptEndRef.current.scrollIntoView({ behavior: 'auto', block: 'end' });
    }
  }, [realtimeTranscript, interimTranscript]);

  // Animate wave bars when recording
  useEffect(() => {
    if (!isRecording || isPaused) return;
    const interval = setInterval(() => {
      setBarHeights([
        6 + Math.random() * 8,
        10 + Math.random() * 8,
        5 + Math.random() * 6,
      ]);
    }, 120);
    return () => clearInterval(interval);
  }, [isRecording, isPaused]);

  // Auto-collapse panel when processing starts
  useEffect(() => {
    if (status === 'processing' || status === 'splitting' || status === 'finalizing') {
      setViewState('collapsed');
    }
  }, [status]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files[0]) {
      setFile(e.target.files[0]);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    if (e.dataTransfer.files && e.dataTransfer.files[0]) {
      const droppedFile = e.dataTransfer.files[0];
      if (droppedFile.type.startsWith('audio/')) {
        setFile(droppedFile);
      }
    }
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = () => {
    setIsDragOver(false);
  };

  const isProcessing = status === 'processing' || status === 'splitting' || status === 'finalizing';

  return (
    <div className="flex flex-col h-full bg-app-panel text-app-fg font-[system-ui] overflow-hidden relative">
      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto w-full flex flex-col pt-6 sm:pt-14 pb-32 sm:pb-48 px-4 sm:px-10 lg:px-16">
        {/* Hero Section */}
        <motion.div 
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="mb-8 max-w-3xl"
        >
          <h1 className="text-[22px] sm:text-[36px] font-serif italic text-zinc-500 dark:text-zinc-400 mb-2 sm:mb-3 leading-tight">
            {file ? file.name.replace(/\.[^/.]+$/, '') : 'New Recording'}
          </h1>
          <p className="text-[13px] sm:text-[14px] text-zinc-500 dark:text-zinc-400 leading-relaxed">
            {file 
              ? `${(file.size / (1024 * 1024)).toFixed(1)} MB · Ready to process`
              : isRecording 
                ? 'Recording in progress…'
                : 'Record a meeting or upload an audio file'
            }
          </p>
        </motion.div>

        {/* Status Pills */}
        <AnimatePresence>
          {(file || isRecording) && (
            <motion.div 
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex items-center gap-2 mb-8"
            >
              {file && !isRecording && (
                <span className="flex items-center gap-1.5 px-3 py-1.5 text-[12px] font-medium text-green-700/80 bg-green-50 border border-green-200/50 rounded-full">
                  <FileAudio className="w-3 h-3" />
                  {file.name}
                </span>
              )}
              {isRecording && (
                <span className="flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium text-red-600/80 bg-red-50 border border-red-200/50 rounded-full">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  Recording · {formatTime(recordingTime)}
                </span>
              )}
            </motion.div>
          )}
        </AnimatePresence>

        {/* Processing Progress — only shows during/after processing */}
        <AnimatePresence>
          {isProcessing && (
            <motion.div 
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              className="w-full max-w-[560px]"
            >
              <div className="bg-zinc-50 dark:bg-app-raised rounded-2xl border border-zinc-200/80 dark:border-app-border overflow-hidden">
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-7 h-7 rounded-full bg-[#1a1a1a]/[0.06] flex items-center justify-center">
                      <Loader2 className="w-3.5 h-3.5 text-zinc-600 dark:text-zinc-300 animate-spin" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[13px] font-medium text-zinc-700 dark:text-zinc-300">
                        {processingHeadline}
                      </span>
                      <span className="text-[11px] text-zinc-500 dark:text-zinc-400 mt-0.5">
                        {processingSubtext}
                      </span>
                    </div>
                  </div>
                  <span className="text-[12px] font-medium text-zinc-500 dark:text-zinc-500 tabular-nums">
                    {Math.round(totalProgress)}%
                  </span>
                </div>
                
                <div className="h-[3px] bg-[#1a1a1a]/[0.04] mx-5 rounded-full overflow-hidden mb-4">
                  <motion.div 
                    className="h-full bg-[#1a1a1a]/60 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${totalProgress}%` }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                  />
                </div>
                
                {/* Batch list — only for batch mode */}
                {desktopRecordingMode === 'batch' && batches.length > 0 && (
                  <div className="max-h-[180px] overflow-y-auto">
                    {batches.map((batch, idx) => (
                      <div key={idx} className="px-5 py-2.5 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold ${
                            batch.status === 'completed' 
                              ? 'bg-[#1a1a1a] text-white' 
                              : batch.status === 'processing'
                              ? 'bg-[#1a1a1a]/10 text-zinc-600 dark:text-zinc-300'
                              : 'bg-[#1a1a1a]/[0.04] text-zinc-500 dark:text-zinc-400'
                          }`}>
                            {idx + 1}
                          </div>
                          <span className="text-[12px] text-zinc-600 dark:text-zinc-400">Batch {idx + 1}</span>
                        </div>
                        {batch.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin text-zinc-500 dark:text-zinc-400" />}
                        {batch.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-green-500" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Start Processing — floating above bottom bar */}
      <AnimatePresence>
        {file && !isRecording && !isProcessing && !batches.length && viewState === 'collapsed' && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="absolute bottom-[72px] sm:bottom-[96px] left-1/2 -translate-x-1/2 z-40"
          >
            <button 
              onClick={startProcessing}
              className="flex items-center gap-2 sm:gap-2.5 px-5 sm:px-6 py-2.5 sm:py-3 bg-[#1a1a1a] hover:bg-[#333] text-white rounded-full shadow-lg shadow-black/10 transition-all hover:scale-[1.03] active:scale-[0.98]"
            >
              <Sparkles className="w-4 h-4" />
              <span className="text-[13px] font-semibold">Start Processing</span>
            </button>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Processing pill — floating */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="absolute bottom-[72px] sm:bottom-[96px] left-1/2 -translate-x-1/2 z-40"
          >
            <div className="bg-[#1a1a1a]/90 backdrop-blur-xl text-white/90 pl-3 sm:pl-4 pr-4 sm:pr-5 py-2 sm:py-2.5 flex items-center gap-2 sm:gap-3 rounded-full shadow-lg shadow-black/10">
              <Loader2 className="w-3.5 h-3.5 animate-spin" />
              <span className="text-[12px] font-medium max-w-[280px] truncate">{processingHeadline} · {Math.round(totalProgress)}%</span>
              <div className="w-20 h-1.5 bg-white/15 rounded-full overflow-hidden">
                <motion.div className="h-full bg-white/60 rounded-full" animate={{ width: `${totalProgress}%` }} />
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Backdrop (only when expanded) ── */}
      <AnimatePresence>
        {viewState === 'expanded' && (
          <motion.div
            key="panel-backdrop"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.2 }}
            onClick={() => setViewState('collapsed')}
            className="absolute inset-0 bg-black/[0.04] z-30"
          />
        )}
      </AnimatePresence>

      {/* ── Collapsed bottom bar ── */}
      <AnimatePresence>
        {!isProcessing && viewState === 'collapsed' && (
          <motion.div
            key="collapsed-bar"
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: 8 }}
            transition={{ type: 'spring', damping: 28, stiffness: 380 }}
            className="absolute bottom-3 sm:bottom-6 left-1/2 -translate-x-1/2 z-40 w-[calc(100%-24px)] sm:w-auto max-w-[580px]"
          >
            <div className="flex items-center gap-3" style={{ height: 52 }}>
              {/* Left icon pill */}
              <button 
                onClick={() => setViewState('expanded')}
                className={`h-[52px] flex-shrink-0 flex items-center justify-center rounded-full transition-all duration-300 group border border-white/60 ${
                  isRecording
                    ? 'gap-2.5 px-5 bg-gradient-to-br from-red-50 via-orange-50 to-amber-50 border-red-200/40 shadow-[0_0_20px_rgba(239,68,68,0.08)]'
                    : 'w-[52px] bg-gradient-to-br from-[#f0ece7] to-[#e8e2db] hover:from-[#ebe6e0] hover:to-[#e0d9d1] shadow-[0_2px_12px_rgba(0,0,0,0.04)]'
                }`}
              >
                {isRecording ? (
                  <>
                    <div className="flex items-center gap-[3px]">
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          className={`w-[2.5px] rounded-full ${isPaused ? 'bg-[#1a1a1a]/15' : 'bg-red-400'}`}
                          style={{ height: `${barHeights[i]}px` }}
                        />
                      ))}
                    </div>
                    <span className="text-[12px] font-semibold text-red-500 tabular-nums font-mono tracking-wide">
                      {formatTime(recordingTime)}
                    </span>
                  </>
                ) : (
                  <div className="flex items-center gap-1">
                    <div className="flex items-center gap-[3px]">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="w-[2.5px] rounded-full bg-[#4a4038] dark:bg-zinc-500 group-hover:bg-[#2a2420] dark:group-hover:bg-zinc-400 transition-all duration-300"
                          style={{ height: `${6 + i * 3}px`, transitionDelay: `${i * 40}ms` }}
                        />
                      ))}
                    </div>
                    <ChevronUp className="w-3.5 h-3.5 text-[#4a4038] dark:text-zinc-400 group-hover:text-[#2a2420] dark:group-hover:text-zinc-200 group-hover:-translate-y-[1px] transition-all duration-300" />
                  </div>
                )}
              </button>

              {/* Right long bar */}
              <div className="flex-1 sm:flex-none flex items-center h-[52px] bg-gradient-to-r from-[#f0ece7] to-[#ece7e1] rounded-full pl-5 pr-1.5 border border-white/60 shadow-[0_2px_12px_rgba(0,0,0,0.04)]">
                <div 
                  onClick={() => setViewState('expanded')}
                  className="flex-1 flex items-center py-1.5 cursor-pointer sm:min-w-[280px] overflow-hidden"
                >
                  <span className="text-[14px] text-zinc-500 dark:text-zinc-400 truncate tracking-[-0.01em]">
                    {file ? file.name : 'Drop audio or record...'}
                  </span>
                </div>

                <button 
                  onClick={() => setInputMode(inputMode === 'upload' ? 'record' : 'upload')}
                  className="flex-shrink-0 flex items-center gap-2 bg-white/90 dark:bg-app-chip/95 hover:bg-white dark:hover:bg-app-chip rounded-full px-4 py-2.5 text-[13px] font-medium text-zinc-600 dark:text-app-fg-muted hover:text-zinc-900 dark:hover:text-app-fg shadow-[0_1px_4px_rgba(0,0,0,0.04)] dark:shadow-[0_4px_20px_rgba(0,0,0,0.35)] border border-white/80 dark:border-app-border transition-all duration-200"
                >
                  {inputMode === 'upload' ? (
                    <><Mic className="w-4 h-4 text-zinc-500 dark:text-zinc-400" /><span>Record</span></>
                  ) : (
                    <><Upload className="w-4 h-4 text-zinc-500 dark:text-zinc-400" /><span>Upload</span></>
                  )}
                </button>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Expanded panel ── */}
      <AnimatePresence>
        {!isProcessing && viewState === 'expanded' && (
          <motion.div
            key="expanded-panel"
            initial={{ opacity: 0, scale: 0.92, y: 12 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: 8 }}
            transition={{ type: 'spring', damping: 28, stiffness: 350 }}
            style={{ transformOrigin: 'bottom center' }}
            className="absolute bottom-2 sm:bottom-6 left-1/2 -translate-x-1/2 w-[calc(100%-16px)] sm:w-[600px] h-[380px] sm:h-[420px] max-h-[55vh] sm:max-h-[60vh] bg-white dark:bg-app-raised rounded-2xl sm:rounded-3xl shadow-[0_4px_40px_rgba(0,0,0,0.12)] dark:shadow-[0_8px_48px_rgba(0,0,0,0.5)] border border-[#1a1a1a]/[0.06] dark:border-app-border text-zinc-900 dark:text-app-fg flex flex-col z-40 overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drag handle */}
            <div className="flex justify-center pt-3 pb-1">
              <div className="w-8 h-1 rounded-full bg-zinc-300/80 dark:bg-white/20" />
            </div>

              {/* Header */}
              <div className="flex items-center justify-between px-5 py-2.5">
                <div className="flex gap-0.5 bg-[#1a1a1a]/[0.04] dark:bg-app-panel rounded-lg p-0.5 ring-1 ring-transparent dark:ring-white/[0.06]">
                  <button
                    onClick={() => setInputMode('record')}
                    className={`flex items-center gap-1.5 px-3 py-[6px] text-[12px] font-medium rounded-md transition-all ${
                      inputMode === 'record'
                        ? 'bg-white dark:bg-app-chip shadow-sm shadow-black/[0.04] dark:shadow-black/40 text-zinc-900 dark:text-app-fg'
                        : 'text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-800 dark:hover:text-app-fg-muted'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" /> Record
                  </button>
                  <button
                    onClick={() => setInputMode('upload')}
                    className={`flex items-center gap-1.5 px-3 py-[6px] text-[12px] font-medium rounded-md transition-all ${
                      inputMode === 'upload'
                        ? 'bg-white dark:bg-app-chip shadow-sm shadow-black/[0.04] dark:shadow-black/40 text-zinc-900 dark:text-app-fg'
                        : 'text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-800 dark:hover:text-app-fg-muted'
                    }`}
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload
                  </button>
                </div>
                <button 
                  onClick={() => setViewState('collapsed')}
                  className="text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-700 dark:hover:text-app-fg p-1.5 hover:bg-zinc-100 dark:hover:bg-app-chip rounded-lg transition-colors"
                >
                  <ChevronDown className="w-5 h-5" />
                </button>
              </div>

              {/* Content */}
              <div className={`flex-1 px-5 pb-5 ${isRecording && desktopRecordingMode === 'realtime' && inputMode === 'record' ? 'overflow-y-auto' : 'overflow-hidden'}`}>
                {inputMode === 'upload' ? (
                  /* Upload Mode */
                  <motion.div 
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    transition={{ delay: 0.1 }}
                    onClick={() => fileInputRef.current?.click()}
                    onDrop={handleDrop}
                    onDragOver={handleDragOver}
                    onDragLeave={handleDragLeave}
                    className={`h-full rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${
                      isDragOver 
                        ? 'bg-[#1a1a1a]/[0.06] border-2 border-[#1a1a1a]/20' 
                        : file 
                          ? 'bg-green-50/60 border-2 border-green-200/40' 
                          : 'bg-zinc-50 dark:bg-app-panel border-2 border-dashed border-zinc-300/80 dark:border-white/15 hover:border-zinc-400 dark:hover:border-white/25 hover:bg-zinc-100 dark:hover:bg-app-chip/60'
                    }`}
                  >
                    <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="audio/*" />
                    
                    {file ? (
                      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-3">
                        <div className="w-14 h-14 rounded-2xl bg-green-100/80 flex items-center justify-center">
                          <FileAudio className="w-7 h-7 text-green-600/70" />
                        </div>
                        <div className="text-center">
                          <p className="text-[14px] font-medium text-zinc-800 dark:text-zinc-200 mb-0.5">{file.name}</p>
                          <p className="text-[12px] text-zinc-500 dark:text-zinc-500">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                        </div>
                        <button 
                          onClick={(e) => { e.stopPropagation(); setFile(null); }}
                          className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 dark:text-zinc-300 transition-colors"
                        >
                          Remove
                        </button>
                      </motion.div>
                    ) : (
                      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-3">
                        <div className="w-14 h-14 rounded-2xl bg-[#1a1a1a]/[0.04] flex items-center justify-center">
                          <Upload className="w-7 h-7 text-zinc-400 dark:text-zinc-500" />
                        </div>
                        <div className="text-center">
                          <p className="text-[14px] font-medium text-zinc-600 dark:text-zinc-300">Drop audio file here</p>
                          <p className="text-[12px] text-zinc-400 dark:text-zinc-500 mt-0.5">or click to browse</p>
                        </div>
                      </motion.div>
                    )}
                  </motion.div>
                ) : (
                  /* Record Mode */
                  <div className="h-full flex flex-col">
                    {isRecording ? (
                      desktopRecordingMode === 'realtime' ? (
                      /* Real-time Recording */
                      <div className="flex flex-col h-full">
                        <div className="flex items-center justify-between py-2 flex-shrink-0">
                          <div className="flex items-center gap-2">
                            <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                            <span className="text-[13px] font-mono font-semibold text-zinc-900 dark:text-app-fg tabular-nums">{formatTime(recordingTime)}</span>
                            <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-50 text-red-500/80 font-medium">Live</span>
                            {currentInputDevice && (
                              <span className="text-[10px] px-2 py-0.5 rounded-full bg-[#1a1a1a]/[0.04] text-zinc-500 dark:text-zinc-400 font-medium truncate max-w-[120px]" title={currentInputDevice}>
                                {currentInputDevice}
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-2">
                            <div className="flex items-end gap-[3px] h-3.5">
                              {[...Array(6)].map((_, i) => (
                                <motion.div
                                  key={i}
                                  animate={{ height: isPaused ? '30%' : ['30%', '100%', '30%'] }}
                                  transition={isPaused ? { duration: 0.3 } : { duration: 0.6, repeat: Infinity, delay: i * 0.07, ease: "easeInOut" }}
                                  className={`w-[3px] rounded-full ${isPaused ? 'bg-[#1a1a1a]/10' : 'bg-red-400/70'}`}
                                />
                              ))}
                            </div>
                            {isPaused ? (
                              <button
                                onClick={resumeRecording}
                                disabled={isControlBusy}
                                className="w-8 h-8 bg-[#1a1a1a] text-white rounded-full flex items-center justify-center hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Resume recording"
                              >
                                <PlayCircle className="w-4 h-4" />
                              </button>
                            ) : (
                              <button
                                onClick={pauseRecording}
                                disabled={isControlBusy}
                                className="w-8 h-8 bg-[#1a1a1a]/[0.06] text-zinc-600 dark:text-zinc-400 rounded-full flex items-center justify-center hover:bg-[#1a1a1a]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                                title="Pause recording"
                              >
                                <PauseCircle className="w-4 h-4" />
                              </button>
                            )}
                            <button onClick={stopRecording} className="ml-1 px-3 py-1.5 bg-red-500 text-white text-[11px] font-medium rounded-full hover:bg-red-600 transition-colors flex items-center gap-1.5">
                              <StopCircle className="w-3 h-3" /> Stop
                            </button>
                          </div>
                        </div>

                        <div className="flex-1 overflow-y-auto mt-2 -mx-5 px-5 border-t border-zinc-200/80 dark:border-app-border pt-3">
                          <div className="flex items-center gap-2 mb-3">
                            <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                            <span className="text-[10px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wider">Live Transcript</span>
                          </div>
                          {realtimeTranscript.length === 0 && !interimTranscript ? (
                            <div className="flex flex-col items-center justify-center py-12">
                              <p className="text-[13px] text-zinc-400 dark:text-zinc-500">Waiting for speech…</p>
                            </div>
                          ) : (
                            <div className="space-y-1">
                              <CommittedTranscript lines={realtimeTranscript} />
                              {interimTranscript && <p className="text-[13px] text-zinc-400 dark:text-zinc-500 italic leading-relaxed py-1">{interimTranscript}</p>}
                              <div ref={transcriptEndRef} />
                            </div>
                          )}
                        </div>
                      </div>
                      ) : (
                      /* Batch Recording */
                      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex flex-col items-center justify-center h-full gap-5">
                        <div className="text-[40px] font-mono font-bold text-zinc-900 dark:text-app-fg tracking-wider tabular-nums">
                          {formatTime(recordingTime)}
                        </div>
                        
                        <div className="flex items-end justify-center gap-[3px] h-7 w-full max-w-[160px]">
                          {[...Array(18)].map((_, i) => (
                            <motion.div
                              key={i}
                              animate={{ height: isPaused ? '20%' : ['20%', '100%', '20%'] }}
                              transition={isPaused ? { duration: 0.3 } : { duration: 0.8, repeat: Infinity, delay: i * 0.04, ease: "easeInOut" }}
                              className={`w-[3px] rounded-full ${isPaused ? 'bg-[#1a1a1a]/15' : 'bg-red-400/70'}`}
                            />
                          ))}
                        </div>

                        <div className="flex items-center gap-3">
                          {isPaused ? (
                            <button onClick={resumeRecording} disabled={isControlBusy} className="w-10 h-10 bg-[#1a1a1a] text-white rounded-full flex items-center justify-center hover:bg-[#333] transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                              <PlayCircle className="w-5 h-5" />
                            </button>
                          ) : (
                            <button onClick={pauseRecording} disabled={isControlBusy} className="w-10 h-10 bg-[#1a1a1a]/[0.06] text-zinc-600 dark:text-zinc-400 rounded-full flex items-center justify-center hover:bg-[#1a1a1a]/10 transition-colors disabled:opacity-40 disabled:cursor-not-allowed">
                              <PauseCircle className="w-5 h-5" />
                            </button>
                          )}
                          <button onClick={stopRecording} className="w-11 h-11 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors shadow-sm shadow-red-500/20">
                            <StopCircle className="w-5 h-5" />
                          </button>
                        </div>
                        
                        <span className={`text-[10px] font-medium uppercase tracking-widest ${isPaused ? 'text-zinc-500 dark:text-zinc-400' : 'text-red-400/80'}`}>
                          {isPaused ? 'Paused' : 'Recording'}
                        </span>

                        {currentInputDevice && (
                          <div className="flex items-center gap-2 mt-1">
                            <span className="text-[10px] px-2.5 py-1 rounded-full bg-[#1a1a1a]/[0.04] text-zinc-500 dark:text-zinc-500 font-medium">
                              {currentInputDevice}
                            </span>
                            {deviceRestartNotice && (
                              <span className="text-[10px] px-2.5 py-1 rounded-full bg-amber-50 text-amber-600/70 font-medium animate-pulse">
                                Switching…
                              </span>
                            )}
                          </div>
                        )}
                      </motion.div>
                      )
                    ) : file ? (
                      <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center justify-center h-full gap-3">
                        <div className="w-12 h-12 rounded-2xl bg-green-50 flex items-center justify-center">
                          <CheckCircle2 className="w-6 h-6 text-green-500" />
                        </div>
                        <p className="text-[14px] font-medium text-zinc-700 dark:text-zinc-300">Recording saved</p>
                        <p className="text-[11px] text-zinc-500 dark:text-zinc-400 tabular-nums">{formatTime(recordingTime)}</p>
                        <button onClick={() => { setFile(null); startRecording(); }} className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 dark:text-zinc-300 transition-colors mt-1">
                          Record again
                        </button>
                      </motion.div>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-full">
                        {nativeServerAvailable && !permissionsGranted ? (
                          <PermissionsGate onAllGranted={onPermissionsGranted} />
                        ) : (
                          <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex flex-col items-center gap-5">
                            {nativeServerAvailable && (
                              <div className="flex flex-col items-center gap-2">
                                <div className="flex gap-0.5 bg-[#1a1a1a]/[0.04] dark:bg-app-panel rounded-lg p-0.5 ring-1 ring-transparent dark:ring-white/[0.06]">
                                  <button
                                    onClick={() => setDesktopRecordingMode('batch')}
                                    className={`flex items-center gap-1.5 px-3.5 py-[6px] rounded-md text-[12px] font-medium transition-all ${
                                      desktopRecordingMode === 'batch' ? 'bg-white dark:bg-app-chip text-zinc-900 dark:text-app-fg shadow-sm shadow-black/[0.04] dark:shadow-black/35' : 'text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-800 dark:hover:text-app-fg-muted'
                                    }`}
                                  >
                                    <Layers className="w-3 h-3" /> Batch
                                  </button>
                                  <button
                                    onClick={() => setDesktopRecordingMode('realtime')}
                                    className={`flex items-center gap-1.5 px-3.5 py-[6px] rounded-md text-[12px] font-medium transition-all ${
                                      desktopRecordingMode === 'realtime' ? 'bg-white dark:bg-app-chip text-zinc-900 dark:text-app-fg shadow-sm shadow-black/[0.04] dark:shadow-black/35' : 'text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-800 dark:hover:text-app-fg-muted'
                                    }`}
                                  >
                                    <Radio className="w-3 h-3" /> Real-time
                                  </button>
                                </div>
                                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-center max-w-[240px]">
                                  {desktopRecordingMode === 'batch' ? 'Mic + system audio · transcribed after stop' : 'Live transcription via Deepgram'}
                                </p>
                              </div>
                            )}

                            <button 
                              onClick={startRecording}
                              className="group flex items-center gap-2.5 px-6 py-3 bg-[#1a1a1a] text-white text-[13px] font-medium rounded-full hover:bg-[#333] transition-all hover:scale-[1.02] active:scale-[0.98]"
                            >
                              <span className="w-2 h-2 rounded-full bg-red-500 group-hover:animate-pulse" />
                              Start Recording
                            </button>

                            {!nativeServerAvailable && (
                              <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-center">Browser mic only — run as desktop app for system audio</p>
                            )}
                          </motion.div>
                        )}
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Panel bottom bar */}
              <div className="px-5 py-3 bg-zinc-50 dark:bg-app-panel border-t border-zinc-200/80 dark:border-app-border flex items-center justify-between">
                <button 
                  onClick={() => setViewState('collapsed')}
                  className="flex items-center gap-1.5 text-zinc-500 dark:text-zinc-400 hover:text-zinc-600 dark:text-zinc-300 transition-colors"
                >
                  <div className="flex items-center gap-[2px] h-[14px]">
                    {[0, 1, 2].map((i) => (
                      <div key={i} className={`w-[2px] rounded-sm ${isRecording && !isPaused ? 'bg-red-400' : 'bg-[#1a1a1a]/20'}`} style={{ height: `${isRecording && !isPaused ? barHeights[i] * 0.6 : 4 + i * 2}px` }} />
                    ))}
                  </div>
                  <ChevronDown className="w-3.5 h-3.5" />
                </button>
                
                {file && !isRecording && (
                  <button 
                    onClick={() => { setViewState('collapsed'); startProcessing(); }}
                    className="flex items-center gap-2 px-4 py-2 bg-[#1a1a1a] text-white text-[12px] font-medium rounded-full hover:bg-[#333] transition-all"
                  >
                    <Sparkles className="w-3.5 h-3.5" />
                    Process Audio
                  </button>
                )}
              </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
