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
  Play,
  X,
  Sparkles,
  Settings,
  Copy,
  Minus,
  Search,
  RotateCcw,
  Radio,
  WifiOff
} from 'lucide-react';

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
  prompt: string;
  setPrompt: (prompt: string) => void;
  startProcessing: () => void;
  status: string;
  batches: Array<{ status: string }>;
  totalProgress: number;
  inputMode: 'upload' | 'record';
  setInputMode: (mode: 'upload' | 'record') => void;
}

type ViewState = 'collapsed' | 'expanded' | 'processing';

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
  prompt,
  setPrompt,
  startProcessing,
  status,
  batches,
  totalProgress,
  inputMode,
  setInputMode
}: ProcessPageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [viewState, setViewState] = useState<ViewState>('collapsed');
  const [barHeights, setBarHeights] = useState([8, 14, 6]);
  const [showTooltip, setShowTooltip] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);

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

  // Update view state based on processing status
  useEffect(() => {
    if (status === 'processing' || status === 'splitting') {
      setViewState('processing');
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

  const isProcessing = status === 'processing' || status === 'splitting';

  return (
    <div className="flex flex-col h-full bg-white font-[system-ui] overflow-hidden relative">
      {/* Main Content Area */}
      <main className="flex-1 overflow-y-auto w-full flex justify-center pt-8 sm:pt-12 pb-32 sm:pb-48">
        <div className="w-full max-w-[760px] px-4 sm:px-8">
          {/* Title */}
          <h1 className="text-[24px] sm:text-[32px] font-serif text-[#141414]/30 mb-4 sm:mb-6">
            {file ? file.name.replace(/\.[^/.]+$/, '') : 'New Recording'}
          </h1>
          
          {/* Tags/Status */}
          <div className="flex flex-wrap items-center gap-2 mb-6 sm:mb-10">
            <button className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-[#141414] bg-white border border-[#141414]/10 hover:bg-[#F5F5F5] rounded-lg transition-colors shadow-sm">
              <Mic className="w-3.5 h-3.5 text-[#141414]/50" />
              <span>{inputMode === 'upload' ? 'Upload' : 'Record'}</span>
            </button>
            {file && (
              <button className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-[#141414] bg-white border border-[#141414]/10 hover:bg-[#F5F5F5] rounded-lg transition-colors shadow-sm">
                <FileAudio className="w-3.5 h-3.5 text-[#141414]/50" />
                <span>{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
              </button>
            )}
            {isRecording && (
              <span className="flex items-center gap-1.5 px-3 py-1.5 text-[13px] font-medium text-red-600 bg-red-50 border border-red-200 rounded-lg">
                <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse"></span>
                Recording
              </span>
            )}
          </div>

          {/* Content Area */}
          <div className="min-h-[50vh]">
            {/* Instructions textarea - always visible */}
            <div className="mb-8">
              <label className="text-[11px] font-mono uppercase text-[#141414]/40 mb-2 block tracking-wider">
                Instructions (optional)
              </label>
              <textarea 
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full bg-white border border-[#141414]/10 rounded-xl p-4 text-[15px] text-[#141414] placeholder:text-[#141414]/30 focus:outline-none focus:border-[#141414]/30 resize-none shadow-sm transition-colors"
                placeholder="Optional: Add context about the meeting (e.g., topic, participants)..."
                rows={3}
              />
            </div>

            {/* Processing Progress */}
            {batches.length > 0 && (
              <div className="bg-white rounded-2xl border border-[#141414]/10 shadow-sm overflow-hidden mb-8">
                <div className="px-5 py-4 border-b border-[#141414]/5 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    {isProcessing ? (
                      <Loader2 className="w-4 h-4 text-[#141414] animate-spin" />
                    ) : (
                      <CheckCircle2 className="w-4 h-4 text-green-600" />
                    )}
                    <span className="text-[14px] font-medium text-[#141414]">
                      {isProcessing ? 'Processing audio...' : 'Processing complete'}
                    </span>
                  </div>
                  <span className="text-[13px] font-mono text-[#141414]/50">
                    {Math.round(totalProgress)}%
                  </span>
                </div>
                
                {/* Progress bar */}
                <div className="h-1 bg-[#141414]/5">
                  <motion.div 
                    className="h-full bg-[#141414]"
                    initial={{ width: 0 }}
                    animate={{ width: `${totalProgress}%` }}
                    transition={{ duration: 0.3 }}
                  />
                </div>
                
                {/* Batch list */}
                <div className="max-h-[200px] overflow-y-auto">
                  {batches.map((batch, idx) => (
                    <div key={idx} className="px-5 py-3 border-b border-[#141414]/5 last:border-0 flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-mono ${
                          batch.status === 'completed' 
                            ? 'bg-[#141414] text-white' 
                            : batch.status === 'processing'
                            ? 'bg-[#141414]/10 text-[#141414]'
                            : 'bg-[#141414]/5 text-[#141414]/50'
                        }`}>
                          {idx + 1}
                        </div>
                        <span className="text-[13px] text-[#141414]/70">Batch {idx + 1}</span>
                      </div>
                      {batch.status === 'processing' && <Loader2 className="w-3.5 h-3.5 animate-spin text-[#141414]/50" />}
                      {batch.status === 'completed' && <CheckCircle2 className="w-3.5 h-3.5 text-green-600" />}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* Start Processing Button - Shows above collapsed bar when file is ready */}
      {file && !isRecording && !isProcessing && viewState === 'collapsed' && (
        <div className="absolute bottom-[90px] sm:bottom-[100px] left-1/2 transform -translate-x-1/2 z-40 px-4 w-full sm:w-auto flex justify-center">
          <motion.button 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            onClick={startProcessing}
            className="flex items-center gap-2.5 px-5 sm:px-6 py-3 sm:py-3.5 bg-[#141414] hover:bg-[#333] text-white rounded-full shadow-lg transition-all hover:scale-105"
          >
            <Play className="w-4 h-4 fill-current" />
            <span className="text-[13px] sm:text-[14px] font-semibold tracking-wide">Start Processing</span>
          </motion.button>
        </div>
      )}

      {/* Processing Progress Bar - Shows during processing */}
      {isProcessing && (
        <div className="absolute bottom-[90px] sm:bottom-[100px] left-1/2 transform -translate-x-1/2 z-40 w-[calc(100%-32px)] sm:w-[600px] max-w-[600px]">
          <motion.div 
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            className="bg-white rounded-full shadow-[0_4px_20px_rgba(0,0,0,0.12)] border border-[#141414]/10 px-4 sm:px-5 py-3 flex items-center justify-between"
          >
            <div className="flex items-center gap-3">
              <Loader2 className="w-4 h-4 text-[#141414] animate-spin" />
              <span className="text-[14px] font-medium text-[#141414]">
                Processing • {Math.round(totalProgress)}%
              </span>
            </div>
            <div className="flex items-center gap-2">
              <div className="w-32 h-1.5 bg-[#141414]/10 rounded-full overflow-hidden">
                <motion.div 
                  className="h-full bg-[#141414] rounded-full"
                  animate={{ width: `${totalProgress}%` }}
                />
              </div>
            </div>
          </motion.div>
        </div>
      )}

      {/* Bottom Bar - Collapsed State */}
      {viewState === 'collapsed' && (
        <div className="absolute bottom-4 sm:bottom-6 left-1/2 transform -translate-x-1/2 z-40 w-[calc(100%-32px)] sm:w-auto max-w-[600px]">
          <div className="flex items-center gap-2 w-full sm:w-auto">
            {/* Wave Animation Button */}
            <div 
              className="relative flex items-center bg-white rounded-full shadow-[0_2px_16px_rgba(0,0,0,0.1)] border border-[#141414]/10"
              onMouseEnter={() => setShowTooltip(true)}
              onMouseLeave={() => setShowTooltip(false)}
            >
              {/* Tooltip */}
              <AnimatePresence>
                {showTooltip && (
                  <motion.div 
                    initial={{ opacity: 0, y: 5 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 5 }}
                    className="absolute -top-10 left-1/2 transform -translate-x-1/2 px-3 py-1.5 bg-[#141414] text-white text-[12px] rounded-lg whitespace-nowrap shadow-lg"
                  >
                    {isRecording ? 'Recording controls' : 'Upload or record'}
                  </motion.div>
                )}
              </AnimatePresence>
              
              <button 
                onClick={() => setViewState('expanded')}
                className="flex items-center gap-2 hover:bg-[#F5F5F5] pl-4 pr-3 py-3 rounded-full transition-colors"
              >
                {isRecording ? (
                  <>
                    <div className="flex items-center gap-[3px] h-[18px]">
                      {[0, 1, 2].map((i) => (
                        <motion.div
                          key={i}
                          className={`w-[3px] rounded-full transition-all duration-100 ${isPaused ? 'bg-[#141414]/40' : 'bg-red-500'}`}
                          style={{ height: `${barHeights[i]}px` }}
                        />
                      ))}
                    </div>
                    <span className="text-[14px] font-medium text-red-500 ml-1">
                      {formatTime(recordingTime)}
                    </span>
                  </>
                ) : (
                  <>
                    <div className="flex items-center gap-[3px] h-[18px]">
                      {[0, 1, 2].map((i) => (
                        <div
                          key={i}
                          className="w-[3px] rounded-full bg-[#141414]/30"
                          style={{ height: `${6 + i * 3}px` }}
                        />
                      ))}
                    </div>
                    <ChevronUp className="w-3.5 h-3.5 text-[#141414]/50" />
                  </>
                )}
              </button>
            </div>

            {/* Main Action Bar */}
            <div className="flex-1 sm:flex-none flex items-center bg-white rounded-full shadow-[0_2px_16px_rgba(0,0,0,0.1)] border border-[#141414]/10">
              <div 
                onClick={() => setViewState('expanded')}
                className="flex-1 flex items-center px-4 sm:px-5 py-3 cursor-pointer sm:min-w-[280px] overflow-hidden"
              >
                <span className="text-[13px] sm:text-[14px] text-[#141414]/40 truncate">
                  {file ? file.name : 'Drop audio or record...'}
                </span>
              </div>

              {/* Mode toggle button */}
              <button 
                onClick={() => setInputMode(inputMode === 'upload' ? 'record' : 'upload')}
                className="flex-shrink-0 flex items-center gap-1.5 sm:gap-2 px-3 sm:px-4 py-2 mr-2 text-[12px] sm:text-[13px] font-medium text-[#141414] bg-white border border-[#141414]/10 hover:bg-[#F5F5F5] rounded-full transition-colors whitespace-nowrap shadow-sm"
              >
                {inputMode === 'upload' ? (
                  <>
                    <Mic className="w-3.5 sm:w-4 h-3.5 sm:h-4 text-[#141414]/50" />
                    <span className="hidden sm:inline">Record</span>
                  </>
                ) : (
                  <>
                    <Upload className="w-3.5 sm:w-4 h-3.5 sm:h-4 text-[#141414]/50" />
                    <span className="hidden sm:inline">Upload</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Expanded Panel */}
      <AnimatePresence>
        {viewState === 'expanded' && (
          <motion.div 
            initial={{ y: '100%', opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: '100%', opacity: 0 }}
            transition={{ type: 'spring', damping: 25, stiffness: 300 }}
            className="absolute bottom-0 left-0 right-0 sm:left-1/2 sm:right-auto sm:transform sm:-translate-x-1/2 w-full sm:w-[720px] bg-white rounded-t-[20px] sm:rounded-t-[24px] shadow-[0_-4px_40px_rgba(0,0,0,0.12)] border border-[#141414]/10 border-b-0 flex flex-col z-40 overflow-hidden"
            style={{ height: '70vh', maxHeight: '420px' }}
          >
            {/* Header */}
            <div className="flex items-center justify-between px-5 py-3 border-b border-[#141414]/5">
              <div className="flex items-center gap-3">
                {/* Mode Toggle */}
                <div className="flex bg-[#F5F5F5] rounded-lg p-1">
                  <button
                    onClick={() => setInputMode('upload')}
                    className={`flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium rounded-md transition-all ${
                      inputMode === 'upload' 
                        ? 'bg-white shadow-sm text-[#141414]' 
                        : 'text-[#141414]/50 hover:text-[#141414]'
                    }`}
                  >
                    <Upload className="w-3.5 h-3.5" /> Upload
                  </button>
                  <button
                    onClick={() => setInputMode('record')}
                    className={`flex items-center gap-2 px-3 py-1.5 text-[12px] font-medium rounded-md transition-all ${
                      inputMode === 'record' 
                        ? 'bg-white shadow-sm text-[#141414]' 
                        : 'text-[#141414]/50 hover:text-[#141414]'
                    }`}
                  >
                    <Mic className="w-3.5 h-3.5" /> Record
                  </button>
                </div>
              </div>
              <button 
                onClick={() => setViewState('collapsed')}
                className="text-[#141414]/50 hover:text-[#141414] p-1.5 hover:bg-[#F5F5F5] rounded-lg transition-colors"
              >
                <Minus className="w-5 h-5" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-4 sm:p-6">
              {inputMode === 'upload' ? (
                /* Upload Mode */
                <div 
                  onClick={() => fileInputRef.current?.click()}
                  onDrop={handleDrop}
                  onDragOver={handleDragOver}
                  onDragLeave={handleDragLeave}
                  className={`h-full border-2 border-dashed rounded-2xl flex flex-col items-center justify-center cursor-pointer transition-all ${
                    isDragOver 
                      ? 'border-[#141414] bg-[#141414]/5' 
                      : file 
                        ? 'border-green-300 bg-green-50/50' 
                        : 'border-[#141414]/20 hover:border-[#141414]/40 hover:bg-[#F5F5F5]'
                  }`}
                >
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    onChange={handleFileChange} 
                    className="hidden" 
                    accept="audio/*" 
                  />
                  
                  {file ? (
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-16 h-16 rounded-2xl bg-green-100 flex items-center justify-center">
                        <FileAudio className="w-8 h-8 text-green-600" />
                      </div>
                      <div className="text-center">
                        <p className="text-[15px] font-medium text-[#141414] mb-1">{file.name}</p>
                        <p className="text-[13px] text-[#141414]/50">{(file.size / (1024 * 1024)).toFixed(2)} MB</p>
                      </div>
                      <button 
                        onClick={(e) => { e.stopPropagation(); setFile(null); }}
                        className="text-[13px] text-[#141414]/50 hover:text-[#141414] underline"
                      >
                        Remove file
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-4">
                      <div className="w-16 h-16 rounded-2xl bg-[#141414]/5 flex items-center justify-center">
                        <Upload className="w-8 h-8 text-[#141414]/30" />
                      </div>
                      <div className="text-center">
                        <p className="text-[15px] font-medium text-[#141414] mb-1">Drop audio file here</p>
                        <p className="text-[13px] text-[#141414]/50">or click to browse</p>
                      </div>
                    </div>
                  )}
                </div>
              ) : (
                /* Record Mode */
                <div className="h-full flex flex-col items-center justify-center">
                  {isRecording ? (
                    <div className="flex flex-col items-center gap-8">
                      {/* Timer */}
                      <div className="text-[48px] font-mono font-bold text-[#141414] tracking-wider">
                        {formatTime(recordingTime)}
                      </div>
                      
                      {/* Wave Animation */}
                      <div className="flex items-end justify-center gap-1 h-12 w-full max-w-[240px]">
                        {[...Array(24)].map((_, i) => (
                          <motion.div
                            key={i}
                            animate={{ 
                              height: isPaused ? '20%' : ['20%', '100%', '20%'] 
                            }}
                            transition={isPaused ? { duration: 0.3 } : {
                              duration: 0.8,
                              repeat: Infinity,
                              delay: i * 0.04,
                              ease: "easeInOut"
                            }}
                            className={`w-1.5 rounded-full ${isPaused ? 'bg-[#141414]/30' : 'bg-red-500'}`}
                          />
                        ))}
                      </div>

                      {/* Controls */}
                      <div className="flex items-center gap-4">
                        {isPaused ? (
                          <button 
                            onClick={resumeRecording}
                            className="w-14 h-14 bg-[#141414] text-white rounded-full flex items-center justify-center hover:bg-[#333] hover:scale-105 transition-all shadow-lg"
                          >
                            <PlayCircle className="w-7 h-7" />
                          </button>
                        ) : (
                          <button 
                            onClick={pauseRecording}
                            className="w-14 h-14 bg-[#141414]/10 text-[#141414] rounded-full flex items-center justify-center hover:bg-[#141414]/20 hover:scale-105 transition-all"
                          >
                            <PauseCircle className="w-7 h-7" />
                          </button>
                        )}
                        
                        <button 
                          onClick={stopRecording}
                          className="w-16 h-16 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 hover:scale-105 transition-all shadow-lg"
                        >
                          <StopCircle className="w-8 h-8" />
                        </button>
                      </div>
                      
                      <span className={`text-[12px] font-mono uppercase tracking-widest ${
                        isPaused ? 'text-[#141414]/50' : 'text-red-500 animate-pulse'
                      }`}>
                        {isPaused ? 'Paused' : 'Recording...'}
                      </span>
                    </div>
                  ) : file ? (
                    <div className="flex flex-col items-center gap-6">
                      <div className="w-20 h-20 rounded-2xl bg-green-100 flex items-center justify-center">
                        <CheckCircle2 className="w-10 h-10 text-green-600" />
                      </div>
                      <div className="text-center">
                        <p className="text-[16px] font-medium text-green-700 mb-1">Recording Saved</p>
                        <p className="text-[14px] text-[#141414]/50">{formatTime(recordingTime)}</p>
                      </div>
                      <button 
                        onClick={() => { setFile(null); startRecording(); }}
                        className="text-[13px] text-[#141414]/50 hover:text-[#141414] underline"
                      >
                        Record again
                      </button>
                    </div>
                  ) : (
                    <div className="flex flex-col items-center gap-6">
                      <div className="w-24 h-24 rounded-full bg-[#141414]/5 flex items-center justify-center">
                        <Mic className="w-12 h-12 text-[#141414]/30" />
                      </div>
                      <button 
                        onClick={startRecording}
                        className="px-8 py-4 bg-[#141414] text-white font-semibold text-[14px] rounded-full hover:bg-[#333] hover:scale-105 transition-all shadow-lg flex items-center gap-3"
                      >
                        <span className="w-2.5 h-2.5 rounded-full bg-red-500"></span>
                        Start Recording
                      </button>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Bottom Bar */}
            <div className="px-5 py-3 bg-[#FAFAFA] border-t border-[#141414]/5 flex items-center justify-between">
              <button 
                onClick={() => setViewState('collapsed')}
                className="flex items-center gap-1.5 text-[#141414]/50 hover:text-[#141414] transition-colors"
              >
                <div className="flex items-center gap-[2px] h-[14px]">
                  {[0, 1, 2].map((i) => (
                    <div
                      key={i}
                      className={`w-[2px] rounded-sm ${isRecording && !isPaused ? 'bg-red-500' : 'bg-[#141414]/30'}`}
                      style={{ height: `${isRecording && !isPaused ? barHeights[i] * 0.6 : 4 + i * 2}px` }}
                    />
                  ))}
                </div>
                <ChevronDown className="w-3.5 h-3.5" />
              </button>
              
              {file && !isRecording && (
                <button 
                  onClick={() => { setViewState('collapsed'); startProcessing(); }}
                  className="flex items-center gap-2 px-4 py-2 bg-[#141414] text-white text-[13px] font-medium rounded-full hover:bg-[#333] transition-colors"
                >
                  <Play className="w-3.5 h-3.5 fill-current" />
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
