import React, { useState, useRef, useEffect } from 'react';
import { WisprnoteLogo } from '../components/WisprnoteLogo';
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
  Languages,
  Globe,
  Paperclip,
  History,
  LayoutGrid,
  ExternalLink,
  Maximize2,
  SquarePen,
  ChevronLeft,
  MessageSquare,
  ArrowUp,
  X,
  ChevronRight,
  Copy,
  Scan,
  ThumbsUp,
  ThumbsDown,
} from 'lucide-react';


import PermissionsGate from '../components/PermissionsGate';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import GemsModal from '../components/GemsModal';
import { gemPromptFor, type Gem } from '../services/gemsService';
import MessageActions from '../components/MessageActions';

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
  transcriptionLanguage: string;
  setTranscriptionLanguage: (lang: string) => void;
  realtimeTranscript: string[];
  interimTranscript: string;
  permissionsGranted: boolean;
  onPermissionsGranted: () => void;
  currentInputDevice?: string | null;
  deviceRestartNotice?: boolean;
  /** All-meetings chat wiring (Home command bar → existing chat logic). */
  chatInput?: string;
  setChatInput?: (v: string) => void;
  onAskAnything?: () => void;
  onOpenChatHistory?: () => void;
  /** The live all-meetings conversation, rendered inline in the home chat panel. */
  messages?: { role: string; text: string }[];
  isChatting?: boolean;
  /** Run a Gem's prompt against the all-meetings chat. */
  onRunGem?: (prompt: string, displayText?: string) => void;
  /** All-meetings chat history (threads), for the inline History dropdown. */
  chatThreads?: { id: string; title: string; taskId: string | null; updatedAt: string; preview: string }[];
  onNewChat?: () => void;
  onLoadThread?: (id: string) => void;
  onOpenFullChat?: () => void;
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

const getGreeting = (): string => {
  const h = new Date().getHours();
  if (h >= 5  && h < 8)  return "Early decisions shape the day";
  if (h >= 8  && h < 11) return "The best ideas deserve to be captured";
  if (h >= 11 && h < 13) return "Every decision, remembered";
  if (h >= 13 && h < 15) return "Your meetings are thinking for you";
  if (h >= 15 && h < 18) return "Golden hour thinking";
  if (h >= 18 && h < 21) return "Reflect on what was decided today";
  if (h >= 21 && h < 24) return "The brain never stops compounding";
  return "Even now, nothing is forgotten";
};

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
  transcriptionLanguage,
  setTranscriptionLanguage,
  realtimeTranscript,
  interimTranscript,
  permissionsGranted,
  onPermissionsGranted,
  currentInputDevice,
  deviceRestartNotice,
  chatInput = '',
  setChatInput,
  onAskAnything,
  onOpenChatHistory,
  messages = [],
  isChatting = false,
  onRunGem,
  chatThreads = [],
  onNewChat,
  onLoadThread,
  onOpenFullChat,
}: ProcessPageProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const transcriptEndRef = useRef<HTMLDivElement>(null);
  const commandBarRef = useRef<HTMLDivElement>(null);
  const [greeting] = useState(getGreeting);
  const [viewState, setViewState] = useState<ViewState>('collapsed');
  const [barHeights, setBarHeights] = useState([8, 14, 6]);
  const [showTooltip, setShowTooltip] = useState(false);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isCommandBarOpen, setIsCommandBarOpen] = useState(false);
  const [isHistoryOpen, setIsHistoryOpen] = useState(false);
  const [isChatOpen, setIsChatOpen] = useState(false);
  const [activeChip, setActiveChip] = useState<string | null>(null);
  const [gemsOpen, setGemsOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  // All-meetings chat threads (taskId === null), newest first, for the History dropdown.
  const homeThreads = [...chatThreads]
    .filter((t) => t.taskId === null)
    .sort((a, b) => (b.updatedAt || '').localeCompare(a.updatedAt || ''));
  const groupLabel = (iso: string) => {
    const d = new Date(iso); const now = new Date();
    const startOfDay = (x: Date) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const days = Math.round((startOfDay(now) - startOfDay(d)) / 86400000);
    if (days <= 0) return 'Today';
    if (days <= 3) return 'Last 3 days';
    return d.toLocaleDateString(undefined, d.getFullYear() === now.getFullYear() ? { month: 'long' } : { month: 'long', year: 'numeric' });
  };
  const [fullScreen, setFullScreen] = useState(false);
  const fsEndRef = useRef<HTMLDivElement>(null);

  // History thread list — shared by the inline dropdown and the full-screen view.
  const renderThreadGroups = () => {
    if (homeThreads.length === 0) return <div className="px-3 py-5 text-[13px] text-zinc-400 dark:text-zinc-500 text-center">No chats yet.</div>;
    const groups: { label: string; items: typeof homeThreads }[] = [];
    for (const t of homeThreads) {
      const label = groupLabel(t.updatedAt);
      const last = groups[groups.length - 1];
      if (last && last.label === label) last.items.push(t); else groups.push({ label, items: [t] });
    }
    return groups.map((g) => (
      <div key={g.label} className="mb-1 last:mb-0">
        <div className="px-3 pt-2 pb-1 text-[12.5px] text-zinc-400 dark:text-zinc-500">{g.label}</div>
        {g.items.map((t) => (
          <button
            key={t.id}
            onClick={() => { onLoadThread?.(t.id); setHistoryOpen(false); setIsChatOpen(true); setIsCommandBarOpen(true); }}
            className="w-full text-left px-3 py-2 rounded-lg text-[14px] text-zinc-800 dark:text-app-fg hover:bg-zinc-100 dark:hover:bg-app-chip truncate transition-colors"
          >
            {t.title || t.preview || 'Untitled chat'}
          </button>
        ))}
      </div>
    ));
  };

  // The conversation — shared by the inline panel and the full-screen view.
  const renderConversation = (endRef: React.RefObject<HTMLDivElement>) => (
    <>
      {messages.length === 0 && !isChatting && (
        <div className="flex-1 flex items-center justify-center text-[13px] text-zinc-400 dark:text-zinc-500">Ask anything about your meeting notes.</div>
      )}
      {messages.map((m, i) => (
        m.role === 'user' ? (
          <div key={i} className="flex justify-end"><div className="px-3.5 py-2 bg-zinc-100 dark:bg-app-chip rounded-2xl text-[13px] text-zinc-800 dark:text-zinc-100 max-w-[85%] whitespace-pre-wrap leading-relaxed">{m.text}</div></div>
        ) : (
          <div key={i}>
            <div className="text-[13.5px] text-zinc-800 dark:text-app-fg leading-relaxed [&_h1]:text-[15px] [&_h1]:font-semibold [&_h2]:text-[14px] [&_h2]:font-semibold [&_h3]:text-[13.5px] [&_h3]:font-semibold [&_h1]:mt-3 [&_h2]:mt-3 [&_h3]:mt-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1 [&_p]:my-1.5 [&_a]:text-[#6f871a] [&_a]:underline">{m.text ? <Markdown remarkPlugins={[remarkGfm]}>{m.text}</Markdown> : <span className="text-zinc-400">…</span>}</div>
            {!!m.text?.trim() && <MessageActions text={m.text} className="mt-1.5 -ml-1" />}
          </div>
        )
      ))}
      {isChatting && (<div className="flex items-center gap-1.5 text-[12.5px] text-zinc-400 dark:text-zinc-500"><Loader2 className="w-3 h-3 animate-spin" /> Thinking…</div>)}
      <div ref={endRef} />
    </>
  );

  // Run a Gem: open the inline chat panel and send its prompt to all-meetings chat.
  const runGem = (gem: Gem) => {
    setIsChatOpen(true);
    setIsCommandBarOpen(true);
    setIsHistoryOpen(false);
    onRunGem?.(gemPromptFor(gem), gem.name);   // engine gets the directive; bubble shows the Gem name
  };

  // Open the inline chat panel (stay on the home page) and send to all-meetings chat.
  const submitChat = () => {
    if (!chatInput.trim()) return;
    setIsChatOpen(true);
    setIsCommandBarOpen(true);
    setIsHistoryOpen(false);
    onAskAnything?.();
  };

  // Ask the LIVE meeting. The inline command-bar chat is hidden while recording
  // (the record panel takes its place), so route to the full-screen chat — it isn't
  // gated by `isRecording` and renders the conversation. handleSendMessage detects the
  // active recording and scopes the answer to the in-progress transcript only.
  const submitLiveChat = () => {
    if (!chatInput.trim()) return;
    setIsHistoryOpen(false);
    setFullScreen(true);
    onAskAnything?.();
  };

  // Keep both the inline and full-screen conversations pinned to the latest message.
  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
    fsEndRef.current?.scrollIntoView({ behavior: 'auto', block: 'end' });
  }, [messages, isChatting, fullScreen]);

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

  // Close command bar / history panel on outside click or Escape
  useEffect(() => {
    if (!isCommandBarOpen) return;
    const handleClick = (e: MouseEvent) => {
      if (commandBarRef.current && !commandBarRef.current.contains(e.target as Node)) {
        setIsCommandBarOpen(false);
        setIsHistoryOpen(false);
        setIsChatOpen(false);
        setActiveChip(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (isChatOpen) { setIsChatOpen(false); setActiveChip(null); }
        else if (isHistoryOpen) setIsHistoryOpen(false);
        else setIsCommandBarOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [isCommandBarOpen, isHistoryOpen, isChatOpen]);

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
      <main className="flex-1 overflow-y-auto w-full flex flex-col items-center justify-center px-4 sm:px-10 lg:px-16 gap-5">

        {/* Dynamic greeting — hidden when history or chat panel is open */}
        <AnimatePresence initial={false}>
          {!isHistoryOpen && !isChatOpen && (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
              className="flex flex-col items-start gap-2.5"
            >
              <div className="flex items-center gap-3 sm:gap-4">
                <WisprnoteLogo className="w-9 h-9 sm:w-[52px] sm:h-[52px] flex-shrink-0" />
                <h1
                  style={{ fontFamily: "'EB Garamond', Georgia, serif" }}
                  className="text-[30px] sm:text-[48px] text-black dark:text-white leading-none tracking-[-0.01em]"
                >
                  {greeting}
                </h1>
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* ── Inline action bar — hidden while the record panel is open, which
            takes its place in the same spot (a morph, not a second box). ── */}
        {!isProcessing && viewState !== 'expanded' && (
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.45, ease: [0.22, 1, 0.36, 1], delay: 0.12 }}
            className="w-full max-w-[600px]"
            ref={commandBarRef}
            onDrop={handleDrop}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
          >
            <AnimatePresence mode="wait" initial={false}>
              {isChatOpen && isCommandBarOpen && !isRecording && !file ? (

                /* ── Chat panel ── */
                <motion.div
                  key="chat-panel"
                  initial={{ opacity: 0, y: 12, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.97 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col rounded-[28px] border border-zinc-200 dark:border-app-border bg-white dark:bg-app-raised overflow-hidden"
                  style={{ maxHeight: '560px' }}
                >
                  {/* Header — History dropdown · New chat · Full screen */}
                  <div className="relative flex items-center px-4 pt-4 pb-2 flex-shrink-0">
                    <button
                      onClick={(e) => { e.stopPropagation(); setHistoryOpen((o) => !o); }}
                      className="flex items-center gap-1 px-1.5 py-1 rounded-md text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-app-chip transition-colors"
                      title="Chat history"
                    >
                      <History className="w-[15px] h-[15px]" />
                      <ChevronDown className={`w-3.5 h-3.5 transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
                    </button>

                    {historyOpen && (
                      <div onClick={(e) => e.stopPropagation()} className="absolute left-3 top-full mt-1.5 z-20 w-[340px] max-h-[320px] overflow-y-auto bg-white dark:bg-app-raised rounded-2xl border border-zinc-200 dark:border-app-border shadow-[0_16px_44px_-12px_rgba(0,0,0,0.28)] p-1.5">
                        {renderThreadGroups()}
                      </div>
                    )}

                    <div className="ml-auto flex items-center gap-0.5">
                      <button onClick={(e) => { e.stopPropagation(); setHistoryOpen(false); onNewChat?.(); }} className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors" title="New chat">
                        <SquarePen className="w-[15px] h-[15px]" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setHistoryOpen(false); setFullScreen(true); }} className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors" title="Open full screen">
                        <Maximize2 className="w-[15px] h-[15px]" />
                      </button>
                    </div>
                  </div>

                  {/* Chat area — the live all-meetings conversation, inline. */}
                  <div className="flex-1 overflow-y-auto px-4 pt-1 pb-2 min-h-0 flex flex-col gap-3">
                    {renderConversation(chatEndRef)}
                  </div>

                  {/* Bottom: chip row + input — same as command bar */}
                  <div className="border-t border-zinc-100 dark:border-app-border/60">
                    <div className="flex items-center pl-2 pr-[22px] py-1">
                      <button
                        onClick={(e) => { e.stopPropagation(); setGemsOpen(true); }}
                        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors whitespace-nowrap"
                      >
                        <LayoutGrid className="w-[13px] h-[13px] text-zinc-400 dark:text-zinc-500" />
                        Gems
                      </button>
                      {(['Make me sound smart', 'What did I miss'] as const).map((label) => (
                        <button
                          key={label}
                          onClick={() => setActiveChip(label)}
                          className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors whitespace-nowrap"
                        >
                          <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="flex-shrink-0 text-zinc-400">
                            <rect x="0.5" y="0.5" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1" />
                            <line x1="3" y1="8" x2="8" y2="3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                          </svg>
                          {label}
                        </button>
                      ))}
                      <button
                        onClick={(e) => { e.stopPropagation(); setHistoryOpen(prev => !prev); }}
                        className={`ml-auto self-end flex-shrink-0 p-[7px] transition-colors ${historyOpen ? 'text-zinc-900 dark:text-app-fg' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'}`}
                        title="History"
                      >
                        <History className="w-[19px] h-[19px]" />
                      </button>
                    </div>
                    <div className="m-1.5 flex items-center gap-2 px-4 py-[11px] rounded-full bg-white dark:bg-app-raised border border-[#819C1F]/65 shadow-[0_0_0_2.5px_rgba(129,156,31,0.12)]">
                      <input
                        value={chatInput}
                        onChange={(e) => setChatInput?.(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter' && chatInput.trim()) { e.preventDefault(); submitChat(); } }}
                        onClick={(e) => e.stopPropagation()}
                        placeholder="Ask anything"
                        autoFocus
                        className="flex-1 bg-transparent outline-none text-[14px] text-zinc-800 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-zinc-500 tracking-[-0.01em]"
                      />
                      <button onClick={(e) => e.stopPropagation()} className="flex-shrink-0 flex items-center gap-0.5 text-[13px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors">
                        Auto<ChevronDown className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }} className="flex-shrink-0 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors" title="Attach">
                        <Paperclip className="w-[15px] h-[15px] -rotate-45" />
                      </button>
                      <button onClick={(e) => { e.stopPropagation(); setIsChatOpen(false); setIsCommandBarOpen(false); setViewState('expanded'); }} className="flex-shrink-0 p-[7px] rounded-full bg-zinc-100 dark:bg-app-chip text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-app-chip/70 transition-colors" title="Record">
                        <Mic className="w-[15px] h-[15px]" />
                      </button>
                    </div>
                  </div>
                </motion.div>

              ) : isHistoryOpen && isCommandBarOpen && !isRecording && !file ? (

                /* ── History panel ── */
                <motion.div
                  key="history-panel"
                  initial={{ opacity: 0, y: 12, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 8, scale: 0.97 }}
                  transition={{ duration: 0.22, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col rounded-[28px] border border-zinc-200 dark:border-app-border bg-white dark:bg-app-raised overflow-hidden"
                  style={{ maxHeight: '520px' }}
                >
                  {/* Header */}
                  <div className="flex items-center gap-2.5 px-5 pt-5 pb-2 flex-shrink-0">
                    <History className="w-[17px] h-[17px] text-zinc-500 dark:text-zinc-400 flex-shrink-0" />
                    <span className="flex-1 text-[15px] font-semibold text-zinc-900 dark:text-app-fg">History</span>
                    <button
                      onClick={() => setIsHistoryOpen(false)}
                      className="p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                      title="Close"
                    >
                      <X className="w-[15px] h-[15px]" />
                    </button>
                  </div>

                  {/* Scrollable list — populated by real data */}
                  <div className="flex-1 overflow-y-auto px-5 pb-1 min-h-0 flex flex-col items-center justify-center">
                    <p className="text-[13px] text-zinc-400 dark:text-zinc-500 py-10">No history yet</p>
                  </div>

                  {/* Bottom input — same style as action bar input row */}
                  <div className="m-1.5 flex items-center gap-2 px-4 py-[11px] rounded-full bg-white dark:bg-app-raised border border-[#819C1F]/65 shadow-[0_0_0_2.5px_rgba(129,156,31,0.12)]">
                    <span className="flex-1 text-[14px] text-zinc-400 dark:text-zinc-500 tracking-[-0.01em]">
                      Ask anything
                    </span>
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="flex-shrink-0 flex items-center gap-0.5 text-[13px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                    >
                      Auto
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                      className="flex-shrink-0 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                      title="Attach audio file"
                    >
                      <Paperclip className="w-[15px] h-[15px] -rotate-45" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); setIsHistoryOpen(false); setIsCommandBarOpen(false); setViewState('expanded'); }}
                      className="flex-shrink-0 p-[7px] rounded-full bg-zinc-100 dark:bg-app-chip text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-app-chip/70 transition-colors"
                      title="Record audio"
                    >
                      <Mic className="w-[15px] h-[15px]" />
                    </button>
                  </div>
                </motion.div>

              ) : isCommandBarOpen && !isRecording && !file ? (

                /* ── Expanded command bar (single pill container) ── */
                <motion.div
                  key="command-bar"
                  initial={{ opacity: 0, y: 6, scale: 0.985 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: 4, scale: 0.985 }}
                  transition={{ duration: 0.17, ease: [0.22, 1, 0.36, 1] }}
                  className="flex flex-col rounded-[28px] border border-zinc-200 dark:border-app-border bg-[#ffffff] overflow-hidden"
                >
                  {/* Top chip row */}
                  <div className="flex items-center pl-2 pr-[22px] py-1">
                    <button
                      onClick={(e) => { e.stopPropagation(); setGemsOpen(true); }}
                      className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors whitespace-nowrap"
                    >
                      <LayoutGrid className="w-[13px] h-[13px] text-zinc-400 dark:text-zinc-500" />
                        Gems
                    </button>

                    {(['Make me sound smart', 'What did I miss'] as const).map((label) => (
                      <button
                        key={label}
                        onClick={() => { setActiveChip(label); setIsChatOpen(true); setIsHistoryOpen(false); }}
                        className="flex-shrink-0 flex items-center gap-1.5 px-2.5 py-1 text-[12.5px] text-zinc-600 dark:text-zinc-400 hover:text-zinc-900 dark:hover:text-zinc-100 transition-colors whitespace-nowrap"
                      >
                        <svg width="11" height="11" viewBox="0 0 11 11" fill="none" className="flex-shrink-0 text-zinc-400">
                          <rect x="0.5" y="0.5" width="10" height="10" rx="2.5" stroke="currentColor" strokeWidth="1" />
                          <line x1="3" y1="8" x2="8" y2="3" stroke="currentColor" strokeWidth="1.1" strokeLinecap="round" />
                        </svg>
                        {label}
                      </button>
                    ))}

                    <button
                      onClick={(e) => { e.stopPropagation(); setIsHistoryOpen(false); setIsChatOpen(true); setIsCommandBarOpen(true); setHistoryOpen(true); }}
                      className={`ml-auto self-end flex-shrink-0 p-[7px] transition-colors ${historyOpen ? 'text-zinc-900 dark:text-app-fg' : 'text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200'}`}
                      title="Chat history"
                    >
                      <History className="w-[19px] h-[19px]" />
                    </button>
                  </div>

                  {/* Bottom input row — keeps its own inner green stroke border */}
                  <div className="m-1.5 flex items-center gap-2 px-4 py-[11px] rounded-full bg-[#ffffff] border border-[#819C1F]/65 shadow-[0_0_0_2.5px_rgba(129,156,31,0.12)]">
                    <input
                      value={chatInput}
                      onChange={(e) => setChatInput?.(e.target.value)}
                      onKeyDown={(e) => { if (e.key === 'Enter' && chatInput.trim()) { e.preventDefault(); submitChat(); } }}
                      onClick={(e) => e.stopPropagation()}
                      placeholder="Ask anything"
                      autoFocus
                      className="flex-1 bg-transparent outline-none text-[14px] text-zinc-800 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-zinc-500 tracking-[-0.01em]"
                    />
                    <button
                      onClick={(e) => e.stopPropagation()}
                      className="flex-shrink-0 flex items-center gap-0.5 text-[13px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
                    >
                      Auto
                      <ChevronDown className="w-3.5 h-3.5" />
                    </button>
                    <button
                      onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                      className="flex-shrink-0 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                      title="Attach audio file"
                    >
                      <Paperclip className="w-[15px] h-[15px] -rotate-45" />
                    </button>
                    {/* Mic in subtle rounded button, matching reference */}
                    <button
                      onClick={(e) => { e.stopPropagation(); setIsCommandBarOpen(false); setViewState('expanded'); }}
                      className="flex-shrink-0 p-[7px] rounded-full bg-zinc-100 dark:bg-app-chip text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200 dark:hover:bg-app-chip/70 transition-colors"
                      title="Record audio"
                    >
                      <Mic className="w-[15px] h-[15px]" />
                    </button>
                  </div>
                </motion.div>

              ) : (

                /* ── Collapsed two-pill layout ── */
                <motion.div
                  key="pill-bar"
                  initial={{ opacity: 0 }}
                  animate={{ opacity: 1 }}
                  exit={{ opacity: 0 }}
                  transition={{ duration: 0.13 }}
                  className="flex items-center gap-2"
                >
                  {/* Left control pill */}
                  <div className={`h-[50px] flex-shrink-0 flex items-center gap-2 px-4 rounded-full border transition-all duration-300 ${
                    isRecording
                      ? 'bg-white dark:bg-app-raised border-red-200/70 dark:border-red-500/20 shadow-sm'
                      : 'bg-white dark:bg-app-raised border-zinc-200 dark:border-app-border shadow-sm'
                  }`}>
                    {isRecording ? (
                      /* Recording — live waveform + stop. Only shown while actually recording. */
                      <>
                        <button
                          onClick={() => setViewState('expanded')}
                          className="flex items-center gap-1 hover:opacity-75 transition-opacity"
                          title="Open recording"
                        >
                          <svg width="16" height="18" viewBox="0 0 16 18" fill="none">
                            {([6, 13, 8] as const).map((defaultH, i) => {
                              const h = !isPaused ? barHeights[i] : defaultH;
                              return (
                                <line key={i} x1={3 + i * 5} y1={(18 - h) / 2} x2={3 + i * 5} y2={(18 + h) / 2}
                                  stroke="#819C1F" strokeWidth="2.5" strokeLinecap="round" />
                              );
                            })}
                          </svg>
                          <ChevronUp className="w-3 h-3 text-[#4a4038]/55 dark:text-app-fg-subtle" />
                        </button>
                        <button
                          onClick={stopRecording}
                          className="flex items-center justify-center hover:opacity-75 transition-opacity"
                          title="Stop recording"
                        >
                          <div className="w-3.5 h-3.5 rounded-[2px] bg-red-500" />
                        </button>
                      </>
                    ) : (
                      /* Idle — a clean record affordance (no fake waveform/stop). */
                      <button
                        onClick={() => setViewState('expanded')}
                        className="flex items-center gap-1.5 hover:opacity-75 transition-opacity"
                        title="Record or upload audio"
                      >
                        <Mic className="w-[17px] h-[17px] text-zinc-600 dark:text-app-fg-subtle" />
                        <ChevronUp className="w-3 h-3 text-zinc-400 dark:text-app-fg-subtle/60" />
                      </button>
                    )}
                  </div>

                  {/* Center input pill */}
                  <div
                    onClick={() => { if (!isRecording && !file) setIsCommandBarOpen(true); }}
                    className={`flex-1 h-[50px] flex items-center px-4 rounded-full border transition-all duration-200 ${
                      isDragOver
                        ? 'bg-green-50 border-green-300/60 cursor-copy shadow-sm'
                        : 'bg-white dark:bg-app-raised border-zinc-200 dark:border-app-border shadow-sm cursor-pointer hover:bg-zinc-50 dark:hover:bg-app-chip'
                    }`}
                  >
                    {isRecording ? (
                      <div className="flex items-center gap-2.5 w-full overflow-hidden">
                        <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse flex-shrink-0" />
                        <span className="text-[13px] font-mono font-medium text-zinc-700 tabular-nums flex-shrink-0">
                          {formatTime(recordingTime)}
                        </span>
                        <span className="text-[12px] text-zinc-400 font-medium">
                          {isPaused ? '· Paused' : '· Recording'}
                        </span>
                      </div>
                    ) : file ? (
                      <div className="flex items-center gap-2.5 w-full overflow-hidden">
                        <FileAudio className="w-3.5 h-3.5 text-green-500 flex-shrink-0" />
                        <span className="text-[13px] text-zinc-600 dark:text-zinc-300 truncate flex-1">{file.name}</span>
                        <button
                          onClick={(e) => { e.stopPropagation(); startProcessing(); }}
                          className="flex-shrink-0 flex items-center gap-1.5 px-3.5 py-2 bg-[#1a1a1a] text-white text-[11px] font-semibold rounded-full hover:bg-[#333] transition-colors"
                        >
                          <Sparkles className="w-3 h-3" />
                          Process
                        </button>
                      </div>
                    ) : (
                      <div className="flex items-center w-full gap-1">
                        <span className="flex-1 text-[14px] text-zinc-400 dark:text-zinc-500 tracking-[-0.01em] truncate">
                          Ask anything
                        </span>
                        <button
                          onClick={(e) => { e.stopPropagation(); fileInputRef.current?.click(); }}
                          className="flex-shrink-0 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                          title="Attach audio file"
                        >
                          <Paperclip className="w-4 h-4 -rotate-45" />
                        </button>
                        <button
                          onClick={(e) => { e.stopPropagation(); setViewState('expanded'); }}
                          className="flex-shrink-0 p-1.5 text-zinc-400 hover:text-zinc-600 dark:hover:text-zinc-200 transition-colors"
                          title="Record audio"
                        >
                          <Mic className="w-4 h-4" />
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>

              )}
            </AnimatePresence>

            <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="audio/*" />
          </motion.div>
        )}

        {/* Status Pills */}
        <AnimatePresence>
          {(file || isRecording) && (
            <motion.div
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, scale: 0.95 }}
              className="flex items-center gap-2"
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
              className="w-full max-w-[560px] mx-auto"
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
                {batches.length > 0 && (
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

      {/* Processing pill — floating */}
      <AnimatePresence>
        {isProcessing && (
          <motion.div
            initial={{ opacity: 0, y: 16, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 16, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="absolute bottom-6 left-1/2 -translate-x-1/2 z-40"
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

      {/* ── Expanded record panel — inline, in the centered column (below the
          command bar). It can never overlap the title because it's in flow. ── */}
      <AnimatePresence>
        {!isProcessing && viewState === 'expanded' && (
          <motion.div
            key="expanded-panel"
            initial={{ opacity: 0, y: 8, scale: 0.985 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 6, scale: 0.985 }}
            transition={{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }}
            className="w-full max-w-[600px] h-[320px] sm:h-[360px] max-h-[58vh] bg-white dark:bg-app-raised rounded-[28px] border border-zinc-200 dark:border-app-border text-zinc-900 dark:text-app-fg flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
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
              <div className={`flex-1 px-5 pb-5 ${isRecording && inputMode === 'record' ? 'overflow-y-auto' : 'overflow-hidden'}`}>
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
                      nativeServerAvailable ? (
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

                        {/* Ask the LIVE meeting — opens the full chat, scoped to the in-progress transcript */}
                        <div className="flex-shrink-0 pt-2 -mx-5 px-5 border-t border-zinc-200/80 dark:border-app-border">
                          <div className="flex items-center gap-2 px-3 py-2 rounded-full bg-zinc-50 dark:bg-app-panel border border-zinc-200 dark:border-app-border">
                            <MessageSquare className="w-3.5 h-3.5 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                            <input
                              value={chatInput}
                              onChange={(e) => setChatInput?.(e.target.value)}
                              onKeyDown={(e) => { if (e.key === 'Enter' && chatInput.trim()) { e.preventDefault(); submitLiveChat(); } }}
                              placeholder="Ask about this meeting…"
                              className="flex-1 bg-transparent outline-none text-[13px] text-zinc-800 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-zinc-500"
                            />
                            <button
                              onClick={submitLiveChat}
                              disabled={!chatInput.trim()}
                              className="p-1.5 rounded-full bg-[#6f871a] text-white hover:opacity-90 disabled:opacity-40 transition-opacity flex-shrink-0"
                              title="Ask the live meeting"
                            >
                              <ArrowUp className="w-3.5 h-3.5" />
                            </button>
                          </div>
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
                            {/* Transcription language. English pins the English path;
                                Multilingual adapts to mixed / code-switched speech. */}
                            {nativeServerAvailable && (
                              <div className="flex flex-col items-center gap-2">
                                <div className="flex gap-0.5 bg-[#1a1a1a]/[0.04] dark:bg-app-panel rounded-lg p-0.5 ring-1 ring-transparent dark:ring-white/[0.06]">
                                  <button
                                    onClick={() => setTranscriptionLanguage('en')}
                                    className={`flex items-center gap-1.5 px-3.5 py-[6px] rounded-md text-[12px] font-medium transition-all ${
                                      transcriptionLanguage === 'en' ? 'bg-white dark:bg-app-chip text-zinc-900 dark:text-app-fg shadow-sm shadow-black/[0.04] dark:shadow-black/35' : 'text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-800 dark:hover:text-app-fg-muted'
                                    }`}
                                  >
                                    <Languages className="w-3 h-3" /> English
                                  </button>
                                  <button
                                    onClick={() => setTranscriptionLanguage('multi')}
                                    className={`flex items-center gap-1.5 px-3.5 py-[6px] rounded-md text-[12px] font-medium transition-all ${
                                      transcriptionLanguage === 'multi' ? 'bg-white dark:bg-app-chip text-zinc-900 dark:text-app-fg shadow-sm shadow-black/[0.04] dark:shadow-black/35' : 'text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-800 dark:hover:text-app-fg-muted'
                                    }`}
                                  >
                                    <Globe className="w-3 h-3" /> Multilingual
                                  </button>
                                </div>
                                <p className="text-[10px] text-zinc-400 dark:text-zinc-500 text-center max-w-[260px] leading-relaxed">
                                  {transcriptionLanguage === 'en'
                                    ? 'English — most accurate, with your Dictionary names & terms applied.'
                                    : 'Multilingual — adapts to mixed / non-English speech (code-switching).'}
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
      </main>

      {gemsOpen && <GemsModal onClose={() => setGemsOpen(false)} onRun={runGem} />}

      {/* Full-screen chat — the SAME inline conversation, expanded to fill the
          window (not the old chat route). History + New chat work here too. */}
      {fullScreen && (
        <div className="fixed inset-0 z-[100] bg-app-panel flex flex-col font-[system-ui]">
          <div data-tauri-drag-region className="relative flex items-center px-4 h-[52px] flex-shrink-0">
            <button onClick={() => { setFullScreen(false); setHistoryOpen(false); }} className="flex items-center gap-1 px-2 py-1.5 rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors" title="Collapse">
              <ChevronLeft className="w-4 h-4" /><MessageSquare className="w-4 h-4" />
            </button>
            <button onClick={() => setHistoryOpen((o) => !o)} className="ml-1 flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-app-fg hover:bg-app-nav-hover-bg transition-colors">
              <History className="w-4 h-4" /><span className="text-[13px] font-medium">History</span><ChevronDown className={`w-3.5 h-3.5 transition-transform ${historyOpen ? 'rotate-180' : ''}`} />
            </button>
            {isRecording && (
              <span className="ml-2 flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-red-50 dark:bg-red-500/10 text-red-600/90 dark:text-red-400 text-[11px] font-medium">
                <span className="w-1.5 h-1.5 rounded-full bg-red-500 animate-pulse" /> Talking to your live meeting
              </span>
            )}
            {historyOpen && (
              <div className="absolute left-12 top-full mt-1.5 z-20 w-[340px] max-h-[60vh] overflow-y-auto bg-white dark:bg-app-raised rounded-2xl border border-zinc-200 dark:border-app-border shadow-[0_16px_44px_-12px_rgba(0,0,0,0.28)] p-1.5">
                {renderThreadGroups()}
              </div>
            )}
            <button onClick={() => { setHistoryOpen(false); onNewChat?.(); }} className="ml-auto flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-app-divider text-[13px] font-medium text-app-fg hover:bg-app-nav-hover-bg transition-colors">
              <SquarePen className="w-3.5 h-3.5" /> New chat
            </button>
          </div>

          <div className="flex-1 overflow-y-auto">
            <div className="max-w-[760px] mx-auto px-6 py-6 flex flex-col gap-3 min-h-full">
              {renderConversation(fsEndRef)}
            </div>
          </div>

          <div className="flex-shrink-0 px-6 pb-6">
            <div className="max-w-[760px] mx-auto flex items-center gap-2 px-4 py-3 rounded-full bg-white dark:bg-app-raised border border-zinc-200 dark:border-app-border shadow-sm">
              <input
                value={chatInput}
                onChange={(e) => setChatInput?.(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && chatInput.trim()) { e.preventDefault(); submitChat(); } }}
                placeholder="Ask anything"
                autoFocus
                className="flex-1 bg-transparent outline-none text-[14px] text-app-fg placeholder:text-app-fg-subtle"
              />
              <button className="flex items-center gap-0.5 text-[13px] text-app-fg-subtle hover:text-app-fg transition-colors">Auto<ChevronDown className="w-3.5 h-3.5" /></button>
              <button onClick={() => fileInputRef.current?.click()} className="p-1.5 text-app-fg-subtle hover:text-app-fg transition-colors" title="Attach"><Paperclip className="w-[15px] h-[15px] -rotate-45" /></button>
              <button onClick={submitChat} disabled={!chatInput.trim()} className="p-2 rounded-full bg-[#6f871a] text-white hover:opacity-90 disabled:opacity-40 transition-opacity" title="Send"><ArrowUp className="w-[15px] h-[15px]" /></button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
