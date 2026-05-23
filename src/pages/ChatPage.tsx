import React, { useRef, useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  MessageSquare,
  Send,
  Sparkles,
  Plus,
  FileText,
  CheckCircle2,
  Network,
  Mail,
  Image as ImageIcon,
  BookOpen,
  Download,
  Loader2,
  X,
  ChevronDown,
  ChevronRight,
  Search,
  Clock,
  History,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatPageSkeleton } from '../components/Skeleton';
import { formatDisplayName } from '../lib/displayName';

// Custom markdown components — matches anarlog's clean per-element approach
// instead of relying on the @tailwindcss/typography prose plugin
const assistantMarkdownComponents = {
  h1: ({ children }: { children?: React.ReactNode }) => (
    <h1 className="mt-4 mb-2 text-[16px] font-semibold text-zinc-900 dark:text-zinc-100 first:mt-0">{children}</h1>
  ),
  h2: ({ children }: { children?: React.ReactNode }) => (
    <h2 className="mt-3 mb-1.5 text-[14px] font-semibold text-zinc-900 dark:text-zinc-100 first:mt-0">{children}</h2>
  ),
  h3: ({ children }: { children?: React.ReactNode }) => (
    <h3 className="mt-2.5 mb-1 text-[13px] font-semibold text-zinc-800 dark:text-zinc-200 first:mt-0">{children}</h3>
  ),
  ul: ({ children }: { children?: React.ReactNode }) => (
    <ul className="my-2 list-disc pl-5 space-y-0.5">{children}</ul>
  ),
  ol: ({ children }: { children?: React.ReactNode }) => (
    <ol className="my-2 list-decimal pl-5 space-y-0.5">{children}</ol>
  ),
  li: ({ children }: { children?: React.ReactNode }) => (
    <li className="text-[13px] leading-[1.7] text-zinc-700 dark:text-zinc-300">{children}</li>
  ),
  p: ({ children }: { children?: React.ReactNode }) => (
    <p className="mb-2 last:mb-0 text-[13px] leading-[1.75] text-zinc-700 dark:text-zinc-300">{children}</p>
  ),
  strong: ({ children }: { children?: React.ReactNode }) => (
    <strong className="font-semibold text-zinc-900 dark:text-zinc-100">{children}</strong>
  ),
  em: ({ children }: { children?: React.ReactNode }) => (
    <em className="italic text-zinc-600 dark:text-zinc-400">{children}</em>
  ),
  blockquote: ({ children }: { children?: React.ReactNode }) => (
    <blockquote className="my-2 border-l-2 border-zinc-300 dark:border-zinc-600 pl-3 text-zinc-500 dark:text-zinc-400 text-[13px]">{children}</blockquote>
  ),
  code: ({ children, className }: { children?: React.ReactNode; className?: string }) => {
    const isBlock = className?.includes('language-');
    return isBlock
      ? <pre className="my-2 rounded-lg bg-zinc-100 dark:bg-zinc-800 p-3 overflow-x-auto"><code className="text-[12px] text-zinc-800 dark:text-zinc-200">{children}</code></pre>
      : <code className="rounded bg-zinc-100 dark:bg-zinc-800 px-1 py-0.5 text-[12px] text-zinc-800 dark:text-zinc-200">{children}</code>;
  },
  hr: () => <hr className="my-3 border-zinc-200 dark:border-zinc-700" />,
};

interface AgentStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
  type?: 'search-tool';
  searchQuery?: string;
  searchResults?: Array<{ meetingId: string; meetingTitle: string; score: number }>;
}

// ─── Step icon ────────────────────────────────────────────────────────────────
function StepIcon({ status, type }: { status: AgentStep['status']; type?: string }) {
  if (status === 'running') {
    return (
      <span className="relative flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center">
        <Clock className="w-[14px] h-[14px] text-zinc-500 dark:text-zinc-400 animate-pulse" />
      </span>
    );
  }
  if (status === 'done') {
    if (type === 'search-tool') {
      return (
        <span className="flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center">
          <Search className="w-[13px] h-[13px] text-zinc-500 dark:text-zinc-400" />
        </span>
      );
    }
    return (
      <span className="flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center">
        <CheckCircle2 className="w-[14px] h-[14px] text-zinc-500 dark:text-zinc-400" />
      </span>
    );
  }
  if (status === 'error') {
    return (
      <span className="flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center">
        <X className="w-[13px] h-[13px] text-red-400" />
      </span>
    );
  }
  // pending
  return (
    <span className="flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center">
      <Clock className="w-[13px] h-[13px] text-zinc-300 dark:text-zinc-600" />
    </span>
  );
}

// ─── Thought process timeline ──────────────────────────────────────────────────
function ThoughtProcess({ steps, isLive }: { steps: AgentStep[]; isLive: boolean }) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className="mb-3">
      {/* Header */}
      <button
        onClick={() => setCollapsed(c => !c)}
        className="flex items-center gap-1.5 text-[12px] text-zinc-500 dark:text-zinc-400 hover:text-zinc-700 dark:hover:text-zinc-200 transition-colors group mb-1"
      >
        {isLive
          ? <Loader2 className="w-3.5 h-3.5 animate-spin text-zinc-400" />
          : <Clock className="w-3.5 h-3.5 text-zinc-400" />
        }
        <span className="font-medium">Thought process</span>
        <motion.span
          animate={{ rotate: collapsed ? -90 : 0 }}
          transition={{ duration: 0.18 }}
          className="inline-flex"
        >
          <ChevronDown className="w-3.5 h-3.5 text-zinc-400" />
        </motion.span>
      </button>

      {/* Steps chain */}
      <AnimatePresence initial={false}>
        {!collapsed && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.2, ease: 'easeInOut' }}
            className="overflow-hidden"
          >
            <div className="pl-1 pt-0.5">
              {steps.map((step, idx) => {
                const isLast = idx === steps.length - 1;
                const hasResults = (step.searchResults?.length ?? 0) > 0;
                return (
                  <motion.div
                    key={step.id}
                    initial={{ opacity: 0, x: -4 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.18, delay: idx * 0.04 }}
                    className="flex gap-2.5 relative"
                  >
                    {/* Vertical connector line */}
                    {!isLast && (
                      <div className="absolute left-[8px] top-[18px] bottom-0 w-px bg-zinc-200 dark:bg-zinc-700/60" />
                    )}

                    {/* Icon */}
                    <div className="mt-[3px]">
                      <StepIcon status={step.status} type={step.type} />
                    </div>

                    {/* Content */}
                    <div className="flex-1 min-w-0 pb-3">
                      <span className={`text-[13px] leading-snug ${
                        step.status === 'running'
                          ? 'text-zinc-800 dark:text-zinc-200 font-medium'
                          : 'text-zinc-500 dark:text-zinc-400'
                      }`}>
                        {step.type === 'search-tool'
                          ? (step.status === 'running' ? 'Searching notes' : 'Searched notes')
                          : step.label}
                        {step.type === 'search-tool' && step.searchQuery && (
                          <span className="ml-1.5 text-zinc-400 dark:text-zinc-500 font-normal">
                            for &ldquo;{step.searchQuery.length > 45 ? step.searchQuery.slice(0, 45) + '…' : step.searchQuery}&rdquo;
                          </span>
                        )}
                      </span>

                      {/* Result sub-row */}
                      {step.status === 'done' && step.detail && (
                        <motion.div
                          initial={{ opacity: 0, y: -2 }}
                          animate={{ opacity: 1, y: 0 }}
                          transition={{ duration: 0.14 }}
                          className="mt-1 flex items-start gap-2"
                        >
                          <div className="w-px h-4 bg-zinc-200 dark:bg-zinc-700/60 ml-[1px] mt-1 flex-shrink-0" />
                          <div className="rounded-md bg-zinc-100 dark:bg-zinc-800/60 border border-zinc-200/70 dark:border-zinc-700/50 px-2.5 py-1 text-[11px] text-zinc-500 dark:text-zinc-400 leading-snug">
                            <span className="font-medium text-zinc-400 dark:text-zinc-500 mr-1.5">Result</span>
                            {step.detail}
                          </div>
                        </motion.div>
                      )}

                      {/* Search results expandable */}
                      {step.status === 'done' && hasResults && (
                        <ExpandableResults results={step.searchResults!} />
                      )}
                    </div>
                  </motion.div>
                );
              })}

              {/* Done row */}
              {!isLive && steps.length > 0 && (
                <motion.div
                  initial={{ opacity: 0, x: -4 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ duration: 0.18, delay: steps.length * 0.04 }}
                  className="flex gap-2.5"
                >
                  <div className="mt-[3px]">
                    <span className="flex-shrink-0 w-[18px] h-[18px] flex items-center justify-center">
                      <CheckCircle2 className="w-[14px] h-[14px] text-zinc-400 dark:text-zinc-500" />
                    </span>
                  </div>
                  <span className="text-[13px] text-zinc-400 dark:text-zinc-500 pb-2">Done</span>
                </motion.div>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

function ExpandableResults({ results }: { results: Array<{ meetingId: string; meetingTitle: string; score: number }> }) {
  const [open, setOpen] = useState(false);
  const maxScore = Math.max(...results.map(r => r.score), 0.001);
  return (
    <div className="mt-1">
      <button
        onClick={() => setOpen(o => !o)}
        className="flex items-center gap-1 text-[11px] text-zinc-400 dark:text-zinc-500 hover:text-zinc-600 dark:hover:text-zinc-300 transition-colors"
      >
        <ChevronRight className={`w-3 h-3 transition-transform ${open ? 'rotate-90' : ''}`} />
        {results.length} meeting{results.length !== 1 ? 's' : ''} found
      </button>
      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.16 }}
            className="overflow-hidden mt-1.5 ml-4 space-y-1"
          >
            {results.map(r => {
              const pct = Math.min(Math.round((r.score / maxScore) * 100), 100);
              return (
                <div key={r.meetingId} className="flex items-center justify-between gap-3">
                  <span className="text-[11px] text-zinc-600 dark:text-zinc-300 truncate">{r.meetingTitle}</span>
                  <span className="text-[10px] text-zinc-400 tabular-nums flex-shrink-0">{pct}%</span>
                </div>
              );
            })}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

interface Message {
  role: 'user' | 'model';
  text: string;
  image?: string;
  agentStatus?: 'thinking' | 'planning' | 'executing' | 'done';
  agentPlan?: AgentStep[];
  citations?: Array<{
    meetingId: string;
    meetingTitle: string;
    chunkId: string;
    score: number;
  }>;
  retrievalMeta?: {
    scope?: 'single' | 'many';
    confidence?: number;
    selectedMeetingIds?: string[];
    tokenUsageTotal?: number;
    coveredMeetingsCount?: number;
    totalMeetingsCount?: number;
  };
}

interface TaskHistory {
  id?: string;
  filename: string;
  transcription?: string;
  summary?: string;
  notes?: string;
  created_at?: string;
}

interface GeneratedAsset {
  id?: string;
  task_id: string;
  type: 'email' | 'wiki';
  filename: string;
  content: any;
  created_at?: string;
}

const SLASH_COMMANDS = [
  {
    id: 'email',
    label: '/email',
    description: 'Generate a professional follow-up email with tasks & next steps',
    icon: Mail,
    color: 'bg-blue-50 text-blue-500',
    accent: 'border-blue-100 bg-blue-50/50',
  },
  {
    id: 'wiki',
    label: '/wiki',
    description: 'Generate a structured wiki / knowledge doc from the meeting',
    icon: BookOpen,
    color: 'bg-violet-50 text-violet-500',
    accent: 'border-violet-100 bg-violet-50/50',
  },
];

interface ChatThread {
  id: string;
  title: string;
  taskId: string | null;
  taskTitle?: string;
  createdAt: string;
  updatedAt: string;
  preview: string;
}

interface ChatPageProps {
  selectedTask: TaskHistory | null;
  chatMessages: Message[];
  chatInput: string;
  setChatInput: (value: string) => void;
  isChatting: boolean;
  isGeneratingImage: boolean;
  handleSendMessage: () => void;
  handleVisualize: (text: string) => void;
  isLoading?: boolean;
  isGeneratingAsset?: boolean;
  handleAgentAction?: (type: 'email' | 'wiki') => void;
  wikiStyle?: 'MECE' | 'PRD';
  setWikiStyle?: (s: 'MECE' | 'PRD') => void;
  agentAssetHistory?: GeneratedAsset[];
  selectedAgentAsset?: GeneratedAsset | null;
  setSelectedAgentAsset?: (a: GeneratedAsset | null) => void;
  downloadExistingAsset?: (a: GeneratedAsset) => void | Promise<void>;
  history?: TaskHistory[];
  onSelectTask?: (task: TaskHistory | null) => void;
  chatThreads?: ChatThread[];
  activeChatThreadId?: string | null;
  onNewThread?: () => void;
  onSwitchThread?: (thread: ChatThread) => void;
  session?: { user: { id: string; email: string; name?: string } } | null;
}

function groupThreadsByTime(threads: ChatThread[], taskId?: string | null): { label: string; items: ChatThread[] }[] {
  const filtered = taskId !== undefined
    ? threads.filter(t => t.taskId === taskId)
    : threads;
  const now = Date.now();
  const groups: { label: string; items: ChatThread[] }[] = [];
  const addGroup = (label: string, items: ChatThread[]) => { if (items.length) groups.push({ label, items }); };
  const msDay = 86400000;
  addGroup('Today', filtered.filter(t => now - new Date(t.updatedAt).getTime() < msDay));
  addGroup('Yesterday', filtered.filter(t => {
    const age = now - new Date(t.updatedAt).getTime();
    return age >= msDay && age < 2 * msDay;
  }));
  addGroup('Last 3 days', filtered.filter(t => {
    const age = now - new Date(t.updatedAt).getTime();
    return age >= 2 * msDay && age < 3 * msDay;
  }));
  addGroup('Last week', filtered.filter(t => {
    const age = now - new Date(t.updatedAt).getTime();
    return age >= 3 * msDay && age < 7 * msDay;
  }));
  addGroup('Last month', filtered.filter(t => {
    const age = now - new Date(t.updatedAt).getTime();
    return age >= 7 * msDay && age < 30 * msDay;
  }));
  addGroup('Older', filtered.filter(t => now - new Date(t.updatedAt).getTime() >= 30 * msDay));
  return groups;
}

export default function ChatPage({
  selectedTask,
  chatMessages,
  chatInput,
  setChatInput,
  isChatting,
  isGeneratingImage,
  handleSendMessage,
  handleVisualize,
  isLoading = false,
  isGeneratingAsset = false,
  handleAgentAction,
  wikiStyle = 'MECE',
  setWikiStyle,
  agentAssetHistory = [],
  selectedAgentAsset: _selectedAgentAsset = null,
  setSelectedAgentAsset: _setSelectedAgentAsset,
  downloadExistingAsset,
  history = [],
  onSelectTask,
  chatThreads,
  activeChatThreadId,
  onNewThread,
  onSwitchThread,
  session,
}: ChatPageProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const historyDropdownRef = useRef<HTMLDivElement>(null);

  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [pendingSlashCmd, setPendingSlashCmd] = useState<'email' | 'wiki' | null>(null);
  const [showThreadHistory, setShowThreadHistory] = useState(false);
  const [showAllRecents, setShowAllRecents] = useState(false);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isChatting, agentAssetHistory]);

  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (historyDropdownRef.current && !historyDropdownRef.current.contains(e.target as Node)) {
        setShowThreadHistory(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, []);

  const handleInputChange = (value: string) => {
    setChatInput(value);
    if (value.startsWith('/') && !value.includes(' ')) {
      setSlashFilter(value.slice(1));
      setShowSlashMenu(true);
    } else {
      setShowSlashMenu(false);
    }
  };

  const filteredCommands = SLASH_COMMANDS.filter(c =>
    slashFilter === '' ||
    c.id.startsWith(slashFilter.toLowerCase()) ||
    c.label.slice(1).startsWith(slashFilter.toLowerCase())
  );

  const selectSlashCommand = (cmd: typeof SLASH_COMMANDS[0]) => {
    setShowSlashMenu(false);
    setChatInput('');
    setPendingSlashCmd(cmd.id as 'email' | 'wiki');
  };

  const runSlashCommand = (type: 'email' | 'wiki') => {
    setPendingSlashCmd(null);
    if (handleAgentAction) handleAgentAction(type);
  };

  if (isLoading) {
    return <ChatPageSkeleton />;
  }

  const isEmpty = chatMessages.length === 0 && agentAssetHistory.length === 0 && !pendingSlashCmd && !isGeneratingAsset;
  const currentTaskLabel = selectedTask ? selectedTask.filename : 'All Meetings';
  const taskOptions = selectedTask && selectedTask.id && !history.some(t => t.id === selectedTask.id)
    ? [selectedTask, ...history]
    : history;

  return (
    <div className="h-full w-full bg-app-panel text-app-fg flex flex-col overflow-hidden font-[system-ui]">
      {/* Header */}
      <div className="flex-none flex items-center gap-2 sm:gap-2.5 px-3 sm:px-6 md:px-8 py-3 sm:py-4 z-20 border-b border-zinc-200/70 dark:border-app-border">
        <MessageSquare className="w-4 h-4 flex-shrink-0 text-zinc-400 dark:text-zinc-500" />

        {onSelectTask ? (
          <select
            value={selectedTask?.id || 'all'}
            onChange={(e) => {
              if (e.target.value === 'all') onSelectTask(null);
              else {
                const task = taskOptions.find(t => t.id === e.target.value);
                if (task) onSelectTask(task);
              }
            }}
            className="bg-transparent text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 outline-none cursor-pointer hover:bg-black/5 rounded px-1 transition-colors"
          >
            <option value="all">All Meetings</option>
            {taskOptions.map(t => (
              <option key={t.id} value={t.id}>{t.filename}</option>
            ))}
          </select>
        ) : (
          <span className="text-[13px] text-zinc-500 dark:text-zinc-400 truncate">{currentTaskLabel}</span>
        )}

        <span className="text-zinc-400 dark:text-zinc-600">/</span>
        <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300 flex-1">AI Chat</span>

        {/* Thread history dropdown */}
        <div className="relative flex-shrink-0" ref={historyDropdownRef}>
          <button
            onClick={() => setShowThreadHistory(v => !v)}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-app-raised transition-colors"
            title="Chat history"
          >
            <History className="w-3.5 h-3.5" />
            <ChevronDown className={`w-3 h-3 transition-transform ${showThreadHistory ? 'rotate-180' : ''}`} />
          </button>
          <AnimatePresence>
            {showThreadHistory && (() => {
              const taskFilter = selectedTask?.id ?? null;
              const groups = groupThreadsByTime(chatThreads ?? [], taskFilter);
              return (
                <motion.div
                  initial={{ opacity: 0, y: -4, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -4, scale: 0.97 }}
                  transition={{ duration: 0.15 }}
                  className="absolute top-full right-0 mt-1 w-72 bg-white dark:bg-app-raised border border-zinc-200/80 dark:border-app-border rounded-2xl shadow-xl z-50 overflow-hidden"
                >
                  <div className="px-3 pt-3 pb-1 flex items-center justify-between">
                    <span className="text-[12px] font-semibold text-zinc-700 dark:text-zinc-300">Chat history</span>
                    {onNewThread && (
                      <button
                        onClick={() => { onNewThread(); setShowThreadHistory(false); }}
                        className="flex items-center gap-1 text-[11px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 transition-colors"
                      >
                        <Plus className="w-3 h-3" /> New chat
                      </button>
                    )}
                  </div>
                  <div className="max-h-80 overflow-y-auto py-1">
                    {groups.length === 0 ? (
                      <p className="px-4 py-3 text-[12px] text-zinc-400 dark:text-zinc-500">No past chats yet</p>
                    ) : groups.map(g => (
                      <div key={g.label}>
                        <p className="px-3 pt-2 pb-1 text-[10.5px] font-semibold text-zinc-400 dark:text-zinc-500 uppercase tracking-wide">{g.label}</p>
                        {g.items.map(thread => (
                          <button
                            key={thread.id}
                            onClick={() => { onSwitchThread?.(thread); setShowThreadHistory(false); }}
                            className={`w-full flex items-start gap-2.5 px-3 py-2 hover:bg-zinc-50 dark:hover:bg-app-chip transition-colors text-left ${activeChatThreadId === thread.id ? 'bg-zinc-50 dark:bg-app-chip' : ''}`}
                          >
                            <MessageSquare className="w-3.5 h-3.5 text-zinc-400 mt-0.5 flex-shrink-0" />
                            <div className="flex-1 min-w-0">
                              <p className="text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300 truncate">{thread.title}</p>
                              {thread.taskTitle && (
                                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{thread.taskTitle}</p>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    ))}
                  </div>
                </motion.div>
              );
            })()}
          </AnimatePresence>
        </div>

        {/* New chat button — only show when there's an active conversation */}
        {!isEmpty && onNewThread && (
          <button
            onClick={onNewThread}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] text-zinc-500 dark:text-zinc-400 hover:bg-zinc-100 dark:hover:bg-app-raised transition-colors flex-shrink-0"
            title="New chat"
          >
            <Plus className="w-3.5 h-3.5" />
            <span className="hidden sm:inline">New</span>
          </button>
        )}
      </div>

      {/* Scrollable messages area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto px-3 sm:px-6 md:px-8 py-4 sm:py-6 space-y-4 sm:space-y-6">

          {/* Empty state */}
          {isEmpty && (
            <div className="flex flex-col items-center px-4 pt-6 pb-4 w-full max-w-2xl mx-auto">
              {/* Greeting */}
              <div className="w-full mb-8">
                <h1 className="text-[28px] sm:text-[34px] font-serif italic text-zinc-900 dark:text-zinc-100 leading-tight mb-1">
                  Hi {formatDisplayName(session?.user?.email, session?.user?.name, 'there')}, ask anything
                </h1>
              </div>

              {/* Recents */}
              {(chatThreads ?? []).length > 0 && (
                <div className="w-full mb-6">
                  <div className="flex items-center justify-between mb-2.5">
                    <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">Recents</span>
                    {(chatThreads ?? []).length > 5 && (
                      <button
                        onClick={() => setShowAllRecents(v => !v)}
                        className="text-[12px] text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-300 flex items-center gap-1"
                      >
                        {showAllRecents ? 'Show less' : 'See all +'}
                      </button>
                    )}
                  </div>
                  <div className="space-y-0.5">
                    {groupThreadsByTime(chatThreads ?? [], selectedTask ? selectedTask.id : null)
                      .flatMap(g => g.items)
                      .slice(0, showAllRecents ? 50 : 5)
                      .map(thread => {
                        const age = Date.now() - new Date(thread.updatedAt).getTime();
                        const msDay = 86400000;
                        const ageLabel = age < msDay ? `${Math.round(age / 3600000)}h` :
                          age < 7 * msDay ? `${Math.round(age / msDay)}d` :
                          age < 30 * msDay ? `${Math.round(age / (7 * msDay))}w` :
                          `${Math.round(age / (30 * msDay))}mo`;
                        return (
                          <button
                            key={thread.id}
                            onClick={() => onSwitchThread?.(thread)}
                            className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-zinc-100 dark:hover:bg-app-raised transition-colors text-left group"
                          >
                            <div className="w-7 h-7 rounded-lg bg-zinc-100 dark:bg-app-raised group-hover:bg-zinc-200 dark:group-hover:bg-app-chip flex items-center justify-center flex-shrink-0 transition-colors">
                              <MessageSquare className="w-3.5 h-3.5 text-zinc-500 dark:text-zinc-400" />
                            </div>
                            <div className="flex-1 min-w-0">
                              <p className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200 truncate">{thread.title}</p>
                              {thread.taskTitle && (
                                <p className="text-[11px] text-zinc-400 dark:text-zinc-500 truncate">{thread.taskTitle}</p>
                              )}
                            </div>
                            <span className="text-[11.5px] text-zinc-400 dark:text-zinc-500 flex-shrink-0">{ageLabel}</span>
                          </button>
                        );
                      })}
                  </div>
                </div>
              )}

              {/* Recipes */}
              <div className="w-full mb-6">
                <div className="flex items-center justify-between mb-2.5">
                  <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">Recipes</span>
                </div>
                <div className="flex flex-wrap gap-2">
                  {[
                    { label: 'List recent todos', prompt: 'What are my action items from recent meetings?' },
                    { label: 'Who did I meet with?', prompt: 'Who did I meet with this week?' },
                    { label: 'Write weekly recap', prompt: 'Write a summary of my week based on all meetings.' },
                    { label: 'What was decided?', prompt: 'What key decisions were made in recent meetings?' },
                    { label: 'Draft follow-up email', slash: SLASH_COMMANDS[0] },
                  ].map((recipe, i) => (
                    <button
                      key={i}
                      onClick={() => 'slash' in recipe && recipe.slash ? selectSlashCommand(recipe.slash) : setChatInput((recipe as any).prompt)}
                      className="flex items-center gap-2 px-3.5 py-2 bg-zinc-100 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip rounded-full text-[12.5px] font-medium text-zinc-700 dark:text-zinc-300 transition-colors border border-zinc-200/70 dark:border-app-border"
                    >
                      <FileText className="w-3 h-3 text-zinc-400 dark:text-zinc-500 flex-shrink-0" />
                      {recipe.label}
                    </button>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Regular chat messages — skip in-progress agent placeholders */}
          {chatMessages.filter(msg => !(msg.role === 'model' && msg.agentStatus && msg.agentStatus !== 'done')).map((msg, i) => (
            <motion.div key={`msg-${i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] sm:max-w-[80%] ${msg.role === 'user' ? 'bg-[#f5f2ef] dark:bg-app-chip text-zinc-900 dark:text-app-fg px-5 py-3.5 rounded-3xl rounded-tr-md' : 'bg-transparent text-zinc-900 dark:text-app-fg'}`}>
                {msg.role === 'model' && (
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className="w-7 h-7 rounded-full bg-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                      <Sparkles className="w-3.5 h-3.5 text-white" />
                    </div>
                    <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">WisprNote AI</span>
                  </div>
                )}
                {msg.role === 'model' && msg.agentStatus === 'done' && msg.agentPlan && msg.agentPlan.length > 0 && (
                  <div className="pl-10 mb-2">
                    <ThoughtProcess steps={msg.agentPlan} isLive={false} />
                  </div>
                )}
                <div className={msg.role === 'model' ? 'pl-10 w-full min-w-0' : 'text-[13px] leading-relaxed text-zinc-700 dark:text-zinc-300'}>
                  {msg.role === 'model' ? (
                    <Markdown remarkPlugins={[remarkGfm]} components={assistantMarkdownComponents as any}>{msg.text}</Markdown>
                  ) : (
                    <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                  )}
                </div>
                {msg.image && (
                  <div className={`mt-4 rounded-2xl overflow-hidden border border-zinc-200/80 dark:border-white/10 ${msg.role === 'model' ? 'ml-10' : ''}`}>
                    <img src={msg.image} alt="Visualization" className="w-full h-auto" />
                  </div>
                )}
                {msg.role === 'model' && msg.retrievalMeta && (
                  <div className="mt-2 ml-10 text-[10px] text-zinc-500 dark:text-zinc-500">
                    Scope: {msg.retrievalMeta.scope === 'many' ? 'All meetings' : 'This meeting'}
                    {typeof msg.retrievalMeta.confidence === 'number'
                      ? ` • Confidence ${Math.round(msg.retrievalMeta.confidence * 100)}%`
                      : ''}
                    {typeof msg.retrievalMeta.tokenUsageTotal === 'number' && msg.retrievalMeta.tokenUsageTotal > 0
                      ? ` • Context ${msg.retrievalMeta.tokenUsageTotal} tok`
                      : ''}
                    {typeof msg.retrievalMeta.coveredMeetingsCount === 'number' &&
                    typeof msg.retrievalMeta.totalMeetingsCount === 'number'
                      ? ` • Coverage ${msg.retrievalMeta.coveredMeetingsCount}/${msg.retrievalMeta.totalMeetingsCount}`
                      : ''}
                  </div>
                )}
                {msg.role === 'model' && !msg.image && !isGeneratingImage && (
                  <div className="mt-3 ml-10">
                    <button onClick={() => handleVisualize(msg.text.substring(0, 100))}
                      className="flex items-center gap-1.5 text-[12px] text-zinc-600 dark:text-zinc-300 hover:text-zinc-900 dark:hover:text-white transition-colors bg-zinc-100 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip px-3 py-1.5 rounded-full">
                      <ImageIcon className="w-3 h-3" /> Visualize
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          ))}

          {/* Agentic execution status — live thought process */}
          {isChatting && (() => {
            const lastModel = [...chatMessages].reverse().find(m => m.role === 'model' && m.agentStatus);
            const agentMsg = lastModel?.agentStatus ? lastModel : null;
            if (agentMsg?.agentPlan?.length) {
              return (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-start">
                  <div className="max-w-[88%] sm:max-w-[80%] w-full">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className="w-7 h-7 rounded-full bg-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                        <Sparkles className="w-3.5 h-3.5 text-white" />
                      </div>
                      <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">WisprNote AI</span>
                    </div>
                    <div className="pl-10">
                      <ThoughtProcess steps={agentMsg.agentPlan} isLive={true} />
                    </div>
                  </div>
                </motion.div>
              );
            }
            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start py-2">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                    <Sparkles className="w-3.5 h-3.5 text-white" />
                  </div>
                  <div className="flex items-center gap-1.5 text-[13px] text-zinc-500 dark:text-zinc-400">
                    <Loader2 className="w-3.5 h-3.5 animate-spin" />
                    <span>Thinking…</span>
                  </div>
                </div>
              </motion.div>
            );
          })()}

          {/* Agent asset cards — inline in chat stream */}
          {agentAssetHistory.map((asset, i) => {
            const cmd = SLASH_COMMANDS.find(c => c.id === asset.type);
            const Icon = cmd?.icon ?? Sparkles;
            return (
              <motion.div key={`asset-${asset.id ?? i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                className="flex justify-start">
                <div className="w-full max-w-[88%] sm:max-w-[80%]">
                  {/* Agent label */}
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className={`w-7 h-7 rounded-xl flex items-center justify-center flex-shrink-0 ${cmd?.color ?? 'bg-gray-100 text-gray-600'}`}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">
                      {asset.type === 'email' ? 'Follow-up Email' : `Wiki (${asset.content?.style ?? 'MECE'})`}
                    </span>
                    {downloadExistingAsset && (
                      <button onClick={() => downloadExistingAsset(asset)}
                        className="ml-auto flex items-center gap-1.5 px-3 py-1.5 text-[11px] font-medium bg-[#1a1a1a] text-white rounded-full hover:bg-[#333] transition-colors">
                        <Download className="w-3 h-3" /> Download
                      </button>
                    )}
                  </div>

                  {/* Email card */}
                  {asset.type === 'email' && (
                    <div className="border border-blue-100 dark:border-blue-900/40 bg-blue-50/40 dark:bg-blue-950/25 rounded-2xl p-5 space-y-4">
                      <div className="space-y-1">
                        <p className="text-[11px] font-medium text-blue-400">Subject</p>
                        <h3 className="text-[15px] font-semibold text-zinc-800 dark:text-zinc-200 leading-snug">{asset.content.subject || 'Follow-up Email'}</h3>
                      </div>
                      {asset.content.greeting && <p className="text-[13px] text-zinc-600 dark:text-zinc-300">{asset.content.greeting}</p>}
                      {asset.content.meetingObjective && (
                        <div className="p-3 bg-white/80 dark:bg-app-raised border-l-4 border-blue-300 dark:border-blue-500/60 rounded-r-xl text-sm text-[#1a1a1a] dark:text-app-fg">
                          <span className="text-[11px] font-medium text-blue-500 block mb-1">Objective</span>
                          {asset.content.meetingObjective}
                        </div>
                      )}
                      {asset.content.keyDecisions?.length > 0 && (
                        <div>
                          <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-500 mb-2">Key Decisions</p>
                          <ul className="space-y-1.5">
                            {asset.content.keyDecisions.map((d: string, j: number) => (
                              <li key={j} className="flex gap-2 text-sm"><span className="text-blue-400 mt-0.5">•</span>{d}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {asset.content.tasks?.length > 0 && (
                        <div>
                          <p className="text-[11px] font-medium text-zinc-500 dark:text-zinc-500 mb-2">Action Items</p>
                          <div className="space-y-2">
                            {asset.content.tasks.map((t: any, j: number) => (
                              <div key={j} className="flex items-start gap-2 p-2.5 bg-white/80 dark:bg-app-raised rounded-xl text-sm border border-blue-100 dark:border-blue-900/40 text-[#1a1a1a] dark:text-app-fg">
                                <CheckCircle2 className="w-4 h-4 mt-0.5 text-blue-400 flex-shrink-0" />
                                <div>
                                  <span className="font-medium">{t.task}</span>
                                  {t.owner && <span className="text-xs text-zinc-500 dark:text-zinc-400 ml-2">→ {t.owner}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {asset.content.closing && (
                        <p className="text-[13px] text-zinc-600 dark:text-zinc-300 border-t border-blue-100 dark:border-blue-900/30 pt-3 italic">{asset.content.closing}</p>
                      )}
                    </div>
                  )}

                  {/* Wiki card */}
                  {asset.type === 'wiki' && (
                    <div className="border border-purple-100 dark:border-purple-900/35 bg-purple-50/30 dark:bg-purple-950/20 rounded-2xl p-5 space-y-4">
                      <div>
                        <p className="text-[11px] font-medium text-purple-400 mb-1">Wiki Document</p>
                        <h3 className="text-[16px] font-semibold text-zinc-800 dark:text-zinc-200 leading-snug">{asset.content.title || 'Wiki'}</h3>
                        {asset.content.subtitle && <p className="text-[13px] text-zinc-500 dark:text-zinc-400 italic mt-1">{asset.content.subtitle}</p>}
                      </div>
                      {(asset.content.sections || []).map((section: any, j: number) => (
                        <div key={j} className="space-y-2">
                          <h4 className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-200 border-b border-purple-100 dark:border-purple-900/30 pb-1">{section.heading}</h4>
                          {section.content && <p className="text-[13px] text-zinc-600 dark:text-zinc-300 leading-relaxed">{section.content}</p>}
                          {section.bullets?.length > 0 && (
                            <ul className="space-y-1 pl-1">
                              {section.bullets.map((b: string, k: number) => (
                                <li key={k} className="flex gap-2 text-sm text-zinc-700 dark:text-zinc-300">
                                  <span className="text-purple-400 mt-0.5 flex-shrink-0">•</span>{b}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                      {asset.content.conclusion && (
                        <div className="border-t border-purple-100 dark:border-purple-900/30 pt-4">
                          <p className="text-[11px] font-medium text-purple-400 mb-2">Conclusion</p>
                          <p className="text-[13px] text-zinc-600 dark:text-zinc-300 leading-relaxed italic">{asset.content.conclusion}</p>
                        </div>
                      )}
                    </div>
                  )}
                </div>
              </motion.div>
            );
          })}

          {/* Generating spinner inline */}
          {isGeneratingAsset && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="flex items-center gap-3 px-5 py-4 bg-[#f5f2ef] dark:bg-app-chip rounded-2xl">
                <Loader2 className="w-4 h-4 animate-spin text-zinc-600 dark:text-zinc-400" />
                <span className="text-[13px] text-zinc-600 dark:text-zinc-300 font-medium">Generating…</span>
              </div>
            </motion.div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Input area — fixed at bottom */}
      <div className="flex-none px-2 sm:px-6 md:px-8 py-2 sm:py-4">
        <div className="max-w-3xl mx-auto relative">

          {/* Slash command dropdown */}
          <AnimatePresence>
            {showSlashMenu && filteredCommands.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full mb-2 left-0 right-0 bg-white dark:bg-app-raised border border-[#1a1a1a]/[0.06] dark:border-app-border rounded-2xl shadow-[0_4px_24px_rgba(0,0,0,0.08)] dark:shadow-[0_8px_40px_rgba(0,0,0,0.45)] overflow-hidden z-30 text-app-fg">
                <div className="px-4 py-2.5 border-b border-zinc-200/80 dark:border-app-border">
                  <span className="text-[11px] font-medium text-zinc-500 dark:text-zinc-400">Commands</span>
                </div>
                {filteredCommands.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-zinc-50 dark:hover:bg-app-chip/80 transition-colors text-left">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${cmd.color}`}>
                      <cmd.icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">{cmd.label}</p>
                      <p className="text-[12px] text-zinc-500 dark:text-zinc-500 truncate mt-0.5">{cmd.description}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 text-zinc-400 dark:text-zinc-600 flex-shrink-0" />
                  </button>
                ))}
              </motion.div>
            )}
          </AnimatePresence>

          {/* Pending command confirmation — pops up above input */}
          <AnimatePresence>
            {pendingSlashCmd && (() => {
              const cmd = SLASH_COMMANDS.find(c => c.id === pendingSlashCmd)!;
              return (
                <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                  className="absolute bottom-full mb-2 left-0 right-0 bg-white dark:bg-app-raised border border-[#1a1a1a]/[0.08] dark:border-app-border rounded-2xl shadow-[0_4px_32px_rgba(0,0,0,0.1)] dark:shadow-[0_8px_40px_rgba(0,0,0,0.5)] z-30 text-app-fg">
                  <div className="p-5">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${cmd.color}`}>
                          <cmd.icon className="w-4.5 h-4.5" />
                        </div>
                        <div>
                          <p className="text-[14px] font-semibold text-zinc-800 dark:text-zinc-200">{cmd.label}</p>
                          <p className="text-[12px] text-zinc-500 dark:text-zinc-500 mt-0.5">{cmd.description}</p>
                        </div>
                      </div>
                      <button onClick={() => setPendingSlashCmd(null)}
                        className="p-1.5 hover:bg-zinc-100 dark:hover:bg-app-chip rounded-lg transition-colors">
                        <X className="w-4 h-4 text-zinc-500 dark:text-zinc-400" />
                      </button>
                    </div>

                    {pendingSlashCmd === 'wiki' && setWikiStyle && (
                      <div className="flex gap-1.5 p-1 bg-zinc-100 dark:bg-app-panel rounded-xl mb-4 ring-1 ring-zinc-200/50 dark:ring-white/[0.06]">
                        {(['MECE', 'PRD'] as const).map(s => (
                          <button key={s} onClick={() => setWikiStyle(s)}
                            className={`flex-1 py-2 text-[12px] font-medium rounded-lg transition-all ${wikiStyle === s ? 'bg-white dark:bg-app-chip shadow-sm text-zinc-800 dark:text-zinc-200 dark:text-app-fg' : 'text-zinc-500 dark:text-zinc-500 dark:text-app-fg-subtle hover:text-zinc-600 dark:text-zinc-300 dark:hover:text-app-fg-muted'}`}>
                            {s}
                          </button>
                        ))}
                      </div>
                    )}

                    <button onClick={() => runSlashCommand(pendingSlashCmd)}
                      disabled={isGeneratingAsset}
                      className="w-full py-3 bg-[#1a1a1a] text-white text-[13px] font-semibold rounded-xl hover:bg-[#333] active:scale-[0.98] disabled:opacity-30 flex items-center justify-center gap-2 transition-all">
                      {isGeneratingAsset
                        ? <><Loader2 className="w-4 h-4 animate-spin" /> Generating…</>
                        : <><cmd.icon className="w-4 h-4" /> Generate {pendingSlashCmd === 'email' ? 'Email' : 'Wiki'}</>
                      }
                    </button>
                  </div>
                </motion.div>
              );
            })()}
          </AnimatePresence>

          {/* Textarea */}
          <div className="bg-[#f5f2ef] dark:bg-app-raised rounded-xl sm:rounded-2xl focus-within:bg-white dark:focus-within:bg-app-chip focus-within:ring-1 focus-within:ring-[#1a1a1a]/12 dark:focus-within:ring-white/10 focus-within:shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:focus-within:shadow-[0_8px_32px_rgba(0,0,0,0.35)] transition-all overflow-hidden flex flex-col border border-transparent dark:border-app-border">
            <textarea
              ref={textareaRef}
              value={chatInput}
              onChange={(e) => handleInputChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setShowSlashMenu(false); setPendingSlashCmd(null); return; }
                if (showSlashMenu && (e.key === 'Enter' || e.key === 'Tab')) {
                  e.preventDefault();
                  if (filteredCommands.length > 0) selectSlashCommand(filteredCommands[0]);
                  return;
                }
                if (e.key === 'Enter' && !e.shiftKey && !showSlashMenu) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="Ask anything… or type / for commands"
              className="w-full bg-transparent border-none outline-none px-3 sm:px-5 py-3 sm:py-4 text-[14px] text-zinc-900 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-zinc-500 resize-none max-h-40 min-h-[44px] sm:min-h-[52px]"
              rows={1}
            />
            <div className="px-2 sm:px-3 pb-2 sm:pb-3 pt-0.5 sm:pt-1 flex items-center justify-between">
              <div className="hidden sm:flex items-center gap-1">
                {SLASH_COMMANDS.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-[12px] font-medium text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-black/25 hover:text-zinc-800 dark:hover:text-zinc-100 transition-colors">
                    <cmd.icon className="w-3 h-3" />{cmd.label}
                  </button>
                ))}
              </div>
              <div className="flex sm:hidden items-center gap-1">
                {SLASH_COMMANDS.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="p-1.5 rounded-lg text-zinc-500 dark:text-zinc-400 hover:bg-zinc-200/60 dark:hover:bg-black/25 hover:text-zinc-800 dark:hover:text-zinc-200 transition-colors">
                    <cmd.icon className="w-4 h-4" />
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] text-zinc-400 dark:text-zinc-500 hidden sm:block">{chatInput.length}/4000</span>
                <button onClick={handleSendMessage} disabled={!chatInput.trim() || isChatting}
                  className="w-8 h-8 bg-[#1a1a1a] text-white flex items-center justify-center rounded-xl hover:bg-[#333] active:scale-95 disabled:opacity-20 transition-all">
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
          <p className="text-center mt-2 text-[10px] text-zinc-400 dark:text-zinc-500">
            WisprNote AI can make mistakes. Verify important information.
          </p>
        </div>
      </div>
    </div>
  );
}
