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
  Sparkles,
  Radio,
  Layers,
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
  startProcessing,
  status,
  batches,
  totalProgress,
  processingHeadline = 'Working my magic ✨',
  processingSubtext = 'Tiny wait, big result 😄',
  setInputMode,
  nativeServerAvailable,
  desktopRecordingMode,
  setDesktopRecordingMode,
  realtimeTranscript,
  interimTranscript,
  permissionsGranted,
  onPermissionsGranted,
  currentInputDevice,
  deviceRestartNotice,
}: ProcessPageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const [isDragOver, setIsDragOver] = useState(false);

  useEffect(() => {
    transcriptEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [realtimeTranscript, interimTranscript]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files?.[0]) setFile(e.target.files[0]);
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setIsDragOver(false);
    const dropped = e.dataTransfer.files?.[0];
    if (dropped?.type.startsWith('audio/')) setFile(dropped);
  };

  const isProcessing = status === 'processing' || status === 'splitting' || status === 'finalizing';

  return (
    <div
      className="flex flex-col h-full bg-app-panel text-app-fg overflow-hidden"
      onDragOver={(e) => { e.preventDefault(); setIsDragOver(true); }}
      onDragLeave={() => setIsDragOver(false)}
      onDrop={handleDrop}
    >
      <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="audio/*" />

      <main className="flex-1 overflow-y-auto w-full flex flex-col items-center justify-center px-6 py-10">
        <AnimatePresence mode="wait">

          {/* ── Idle ── */}
          {!file && !isRecording && !isProcessing && (
            <motion.div
              key="idle"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6, transition: { duration: 0.15 } }}
              transition={{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center text-center gap-6 w-full max-w-xs"
            >
              {/* Mic circle */}
              <div className={`w-[88px] h-[88px] rounded-full flex items-center justify-center transition-all duration-200 ${
                isDragOver
                  ? 'bg-blue-100 dark:bg-blue-950/40 border-2 border-blue-300 dark:border-blue-700 scale-105'
                  : 'bg-blue-50 dark:bg-blue-950/20 border border-blue-100 dark:border-blue-900/30'
              }`}>
                <Mic size={34} strokeWidth={1.5} className="text-blue-500 dark:text-blue-400" />
              </div>

              <div className="space-y-1.5">
                <h1 className="text-[21px] font-semibold text-app-fg tracking-[-0.02em] leading-tight">
                  New Recording
                </h1>
                <p className="text-[13px] text-app-fg-muted leading-relaxed">
                  {isDragOver ? 'Drop your audio file here' : 'Record a meeting or upload an audio file'}
                </p>
              </div>

              {nativeServerAvailable && !permissionsGranted ? (
                <PermissionsGate onAllGranted={onPermissionsGranted} />
              ) : (
                <div className="flex flex-col items-center gap-4 w-full">
                  {/* Recording mode selector */}
                  {nativeServerAvailable && (
                    <div className="flex flex-col items-center gap-1.5">
                      <div className="flex items-center gap-0.5 bg-app-raised rounded-lg p-0.5">
                        <button
                          onClick={() => setDesktopRecordingMode('batch')}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-medium transition-all ${
                            desktopRecordingMode === 'batch'
                              ? 'bg-app-canvas shadow-sm text-app-fg'
                              : 'text-app-fg-subtle hover:text-app-fg-muted'
                          }`}
                        >
                          <Layers size={11} strokeWidth={1.8} /> Batch
                        </button>
                        <button
                          onClick={() => setDesktopRecordingMode('realtime')}
                          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-[11.5px] font-medium transition-all ${
                            desktopRecordingMode === 'realtime'
                              ? 'bg-app-canvas shadow-sm text-app-fg'
                              : 'text-app-fg-subtle hover:text-app-fg-muted'
                          }`}
                        >
                          <Radio size={11} strokeWidth={1.8} /> Real-time
                        </button>
                      </div>
                      <p className="text-[10.5px] text-app-fg-subtle">
                        {desktopRecordingMode === 'batch' ? 'Mic + system audio · transcribed after stop' : 'Live transcription via Deepgram'}
                      </p>
                    </div>
                  )}

                  {/* Action buttons */}
                  <div className="flex items-center gap-2.5">
                    <button
                      onClick={() => { setInputMode('record'); startRecording(); }}
                      className="flex items-center gap-2 px-5 py-2.5 bg-app-canvas border border-app-border rounded-lg text-[13px] font-medium text-app-fg hover:bg-app-raised transition-colors shadow-sm"
                    >
                      <Mic size={14} strokeWidth={1.8} className="text-app-fg-muted" />
                      Record
                    </button>
                    <button
                      onClick={() => { setInputMode('upload'); fileInputRef.current?.click(); }}
                      className="flex items-center gap-2 px-5 py-2.5 bg-app-canvas border border-app-border rounded-lg text-[13px] font-medium text-app-fg hover:bg-app-raised transition-colors shadow-sm"
                    >
                      <Upload size={14} strokeWidth={1.8} className="text-app-fg-muted" />
                      Upload
                    </button>
                  </div>

                  {!nativeServerAvailable && (
                    <p className="text-[10.5px] text-app-fg-subtle text-center">
                      Browser mic only — run as desktop app for system audio
                    </p>
                  )}
                </div>
              )}
            </motion.div>
          )}

          {/* ── File loaded ── */}
          {file && !isRecording && !isProcessing && (
            <motion.div
              key="file"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center text-center gap-5"
            >
              <div className="w-[72px] h-[72px] rounded-xl bg-green-50 dark:bg-green-950/25 border border-green-200/60 dark:border-green-800/30 flex items-center justify-center">
                <FileAudio size={28} strokeWidth={1.4} className="text-green-600/70 dark:text-green-400/70" />
              </div>
              <div>
                <p className="text-[15px] font-medium text-app-fg tracking-[-0.01em] max-w-[280px] truncate">
                  {file.name.replace(/\.[^/.]+$/, '')}
                </p>
                <p className="text-[12px] text-app-fg-muted mt-1">
                  {(file.size / (1024 * 1024)).toFixed(1)} MB · Ready to process
                </p>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  onClick={startProcessing}
                  className="flex items-center gap-2 px-5 py-2.5 bg-app-fg text-app-canvas rounded-lg text-[13px] font-medium hover:opacity-90 transition-all shadow-sm"
                >
                  <Sparkles size={14} />
                  Process Audio
                </button>
                <button
                  onClick={() => setFile(null)}
                  className="px-4 py-2.5 border border-app-border rounded-lg text-[13px] font-medium text-app-fg-muted hover:text-app-fg hover:bg-app-raised transition-colors"
                >
                  Remove
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Recording: batch ── */}
          {isRecording && !isProcessing && desktopRecordingMode !== 'realtime' && (
            <motion.div
              key="recording-batch"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-center text-center gap-6"
            >
              {/* Pulsing indicator */}
              <div className="relative flex items-center justify-center">
                {!isPaused && (
                  <>
                    <motion.div
                      className="absolute w-[140px] h-[140px] rounded-full border border-red-400/20"
                      animate={{ scale: [1, 1.14, 1], opacity: [0.5, 0, 0.5] }}
                      transition={{ duration: 2.5, repeat: Infinity, ease: 'easeInOut' }}
                    />
                    <motion.div
                      className="absolute w-[105px] h-[105px] rounded-full border border-red-400/25"
                      animate={{ scale: [1, 1.12, 1], opacity: [0.6, 0, 0.6] }}
                      transition={{ duration: 2.5, delay: 0.5, repeat: Infinity, ease: 'easeInOut' }}
                    />
                  </>
                )}
                <div className={`w-[72px] h-[72px] rounded-full border flex items-center justify-center transition-colors duration-500 ${
                  isPaused ? 'bg-app-raised border-app-border' : 'bg-red-50 dark:bg-red-950/20 border-red-200/50 dark:border-red-800/30'
                }`}>
                  <div className={`w-3 h-3 rounded-full transition-colors duration-500 ${isPaused ? 'bg-app-fg-muted' : 'bg-red-500 animate-pulse'}`} />
                </div>
              </div>

              <div className="text-[56px] font-mono font-semibold tabular-nums leading-none tracking-tight text-app-fg">
                {formatTime(recordingTime)}
              </div>

              <div className="flex flex-col items-center gap-2">
                <span className={`text-[11px] font-medium uppercase tracking-[0.1em] ${isPaused ? 'text-app-fg-subtle' : 'text-red-500/80'}`}>
                  {isPaused ? 'Paused' : 'Recording'}
                </span>
                {currentInputDevice && (
                  <div className="flex items-center gap-2">
                    <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-app-raised text-app-fg-subtle">
                      {currentInputDevice}
                    </span>
                    {deviceRestartNotice && (
                      <span className="text-[10px] px-2.5 py-0.5 rounded-full bg-amber-50 dark:bg-amber-950/30 text-amber-600/70 font-medium animate-pulse">
                        Switching…
                      </span>
                    )}
                  </div>
                )}
              </div>

              {/* Waveform */}
              <div className="flex items-end justify-center gap-[3px] h-6 w-full max-w-[140px]">
                {[...Array(18)].map((_, i) => (
                  <motion.div
                    key={i}
                    animate={{ height: isPaused ? '20%' : ['20%', '100%', '20%'] }}
                    transition={isPaused ? { duration: 0.3 } : { duration: 0.8, repeat: Infinity, delay: i * 0.04, ease: 'easeInOut' }}
                    className={`w-[3px] rounded-full ${isPaused ? 'bg-app-border' : 'bg-red-400/70'}`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-3">
                {isPaused ? (
                  <button onClick={resumeRecording} className="w-10 h-10 bg-app-fg text-app-canvas rounded-full flex items-center justify-center hover:opacity-80 transition-colors">
                    <PlayCircle size={18} />
                  </button>
                ) : (
                  <button onClick={pauseRecording} className="w-10 h-10 bg-app-raised border border-app-border text-app-fg-muted rounded-full flex items-center justify-center hover:bg-app-chip transition-colors">
                    <PauseCircle size={18} />
                  </button>
                )}
                <button onClick={stopRecording} className="w-11 h-11 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 transition-colors shadow-sm shadow-red-500/20">
                  <StopCircle size={18} />
                </button>
              </div>
            </motion.div>
          )}

          {/* ── Recording: realtime ── */}
          {isRecording && !isProcessing && desktopRecordingMode === 'realtime' && (
            <motion.div
              key="recording-realtime"
              initial={{ opacity: 0, scale: 0.96 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.96, transition: { duration: 0.15 } }}
              transition={{ duration: 0.35, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col w-full max-w-[520px] h-[360px] bg-app-canvas border border-app-border rounded-xl shadow-sm overflow-hidden"
            >
              {/* Header bar */}
              <div className="flex items-center justify-between px-4 py-3 border-b border-app-border flex-shrink-0">
                <div className="flex items-center gap-2.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" />
                  <span className="text-[13px] font-mono font-semibold text-app-fg tabular-nums">{formatTime(recordingTime)}</span>
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-red-50 dark:bg-red-950/30 text-red-500/80 font-medium">Live</span>
                  {currentInputDevice && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-app-raised text-app-fg-subtle font-medium truncate max-w-[120px]">
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
                        transition={isPaused ? { duration: 0.3 } : { duration: 0.6, repeat: Infinity, delay: i * 0.07, ease: 'easeInOut' }}
                        className={`w-[3px] rounded-full ${isPaused ? 'bg-app-border' : 'bg-red-400/70'}`}
                      />
                    ))}
                  </div>
                  {isPaused ? (
                    <button onClick={resumeRecording} className="w-7 h-7 bg-app-fg text-app-canvas rounded-lg flex items-center justify-center hover:opacity-80 transition-colors" title="Resume">
                      <PlayCircle size={14} />
                    </button>
                  ) : (
                    <button onClick={pauseRecording} className="w-7 h-7 bg-app-raised text-app-fg-muted rounded-lg flex items-center justify-center hover:bg-app-chip transition-colors" title="Pause">
                      <PauseCircle size={14} />
                    </button>
                  )}
                  <button onClick={stopRecording} className="flex items-center gap-1.5 px-3 py-1.5 bg-red-500 text-white text-[11.5px] font-medium rounded-lg hover:bg-red-600 transition-colors">
                    <StopCircle size={12} /> Stop
                  </button>
                </div>
              </div>

              {/* Live transcript */}
              <div className="flex-1 overflow-y-auto px-4 py-3">
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                  <span className="text-[10px] font-semibold text-app-fg-subtle uppercase tracking-wider">Live Transcript</span>
                </div>
                {realtimeTranscript.length === 0 && !interimTranscript ? (
                  <div className="flex items-center justify-center h-[200px]">
                    <p className="text-[13px] text-app-fg-subtle">Waiting for speech…</p>
                  </div>
                ) : (
                  <div className="space-y-1">
                    {realtimeTranscript.map((line, i) => (
                      <p key={i} className="text-[13px] text-app-fg leading-relaxed py-0.5">{line}</p>
                    ))}
                    {interimTranscript && (
                      <p className="text-[13px] text-app-fg-muted italic leading-relaxed py-0.5">{interimTranscript}</p>
                    )}
                    <div ref={transcriptEndRef} />
                  </div>
                )}
              </div>
            </motion.div>
          )}

          {/* ── Processing ── */}
          {isProcessing && (
            <motion.div
              key="processing"
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="w-full max-w-[480px]"
            >
              <div className="bg-app-canvas border border-app-border rounded-xl overflow-hidden shadow-sm">
                <div className="px-5 py-4 flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-lg bg-app-raised flex items-center justify-center">
                      <Loader2 size={14} className="text-app-fg-muted animate-spin" />
                    </div>
                    <div className="flex flex-col">
                      <span className="text-[13px] font-medium text-app-fg">{processingHeadline}</span>
                      <span className="text-[11px] text-app-fg-muted mt-0.5">{processingSubtext}</span>
                    </div>
                  </div>
                  <span className="text-[12px] font-medium text-app-fg-muted tabular-nums">{Math.round(totalProgress)}%</span>
                </div>

                <div className="h-[3px] bg-app-border mx-5 rounded-full overflow-hidden mb-4">
                  <motion.div
                    className="h-full bg-app-fg/60 rounded-full"
                    initial={{ width: 0 }}
                    animate={{ width: `${totalProgress}%` }}
                    transition={{ duration: 0.4, ease: 'easeOut' }}
                  />
                </div>

                {batches.length > 0 && (
                  <div className="max-h-[160px] overflow-y-auto border-t border-app-border">
                    {batches.map((batch, idx) => (
                      <div key={idx} className="px-5 py-2.5 flex items-center justify-between">
                        <div className="flex items-center gap-2.5">
                          <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[9px] font-semibold ${
                            batch.status === 'completed' ? 'bg-app-fg text-app-canvas' : 'bg-app-raised text-app-fg-muted'
                          }`}>
                            {idx + 1}
                          </div>
                          <span className="text-[12px] text-app-fg-muted">Batch {idx + 1}</span>
                        </div>
                        {batch.status === 'processing' && <Loader2 size={12} className="animate-spin text-app-fg-subtle" />}
                        {batch.status === 'completed' && <CheckCircle2 size={12} className="text-green-500" />}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </motion.div>
          )}

        </AnimatePresence>
      </main>
    </div>
  );
}
