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
  ChevronRight,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChatPageSkeleton } from '../components/Skeleton';
import { ShiningText } from '../components/ui/shining-text';

interface AgentStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
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
  selectedAgentAsset = null,
  setSelectedAgentAsset,
  downloadExistingAsset,
  history = [],
  onSelectTask,
}: ChatPageProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [showSlashMenu, setShowSlashMenu] = useState(false);
  const [slashFilter, setSlashFilter] = useState('');
  const [pendingSlashCmd, setPendingSlashCmd] = useState<'email' | 'wiki' | null>(null);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages, isChatting, agentAssetHistory]);

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
      <div className="flex-none flex items-center gap-2 sm:gap-2.5 px-3 sm:px-6 md:px-8 py-3 sm:py-4 overflow-x-auto no-scrollbar whitespace-nowrap z-10 border-b border-transparent dark:border-app-border">
        <MessageSquare className="w-4 h-4 flex-shrink-0 text-zinc-400 dark:text-zinc-500" />
        
        {onSelectTask ? (
          <select 
            value={selectedTask?.id || 'all'}
            onChange={(e) => {
              if (e.target.value === 'all') {
                onSelectTask(null);
              } else {
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
        <span className="text-[13px] font-semibold text-zinc-700 dark:text-zinc-300">AI Chat</span>
      </div>

      {/* Scrollable messages area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto px-3 sm:px-6 md:px-8 py-4 sm:py-6 space-y-4 sm:space-y-6">

          {/* Empty state */}
          {isEmpty && (
            <div className="flex flex-col items-center justify-center text-center py-8 sm:py-14">
              <h1 className="text-[22px] sm:text-[32px] font-serif italic text-zinc-700 dark:text-zinc-300 leading-tight mb-2">Chat</h1>
              <p className="text-[13px] sm:text-[14px] text-zinc-600 dark:text-zinc-400 max-w-xl mb-6 sm:mb-10 px-2">
                Ask anything about <span className="font-semibold text-zinc-800 dark:text-zinc-200">{currentTaskLabel}</span>.
                Type <kbd className="px-1.5 py-0.5 bg-zinc-200/80 dark:bg-app-chip border border-zinc-300/80 dark:border-app-border rounded-md text-[12px] font-medium text-zinc-800 dark:text-app-fg">/</kbd> for AI commands.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 sm:gap-3 w-full max-w-2xl mb-6 sm:mb-8">
                {[
                  { label: 'Summarize decisions', prompt: 'Summarize the key decisions made in this meeting.', icon: FileText, bg: 'bg-amber-50 text-amber-500' },
                  { label: 'List action items', prompt: 'What are my action items from this discussion?', icon: CheckCircle2, bg: 'bg-blue-50 text-blue-500' },
                  { label: 'Map key concepts', prompt: 'Extract all the main topics discussed.', icon: Network, bg: 'bg-violet-50 text-violet-500' },
                  { label: 'Draft follow-up email', prompt: '', slash: SLASH_COMMANDS[0], icon: Mail, bg: 'bg-emerald-50 text-emerald-500' },
                ].map((item, i) => (
                  <button key={i}
                    onClick={() => item.slash ? selectSlashCommand(item.slash) : setChatInput(item.prompt)}
                    className="flex items-center justify-between p-3 sm:p-4 bg-[#f5f2ef] dark:bg-app-chip hover:bg-[#eeebe7] dark:hover:bg-app-raised rounded-xl sm:rounded-2xl transition-all group text-left">
                    <div className="flex items-center gap-3">
                      <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${item.bg}`}>
                        <item.icon className="w-4 h-4" />
                      </div>
                      <span className="text-[13px] font-medium text-zinc-800 dark:text-zinc-200">{item.label}</span>
                    </div>
                    <Plus className="w-4 h-4 text-zinc-400 dark:text-zinc-600 group-hover:text-zinc-500 dark:text-zinc-400 transition-colors" />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                {SLASH_COMMANDS.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="flex items-center gap-2 px-4 py-2 bg-zinc-200/60 dark:bg-app-raised hover:bg-zinc-300/50 dark:hover:bg-app-chip rounded-full text-[12px] font-medium text-zinc-700 dark:text-zinc-200 transition-all">
                    <cmd.icon className="w-3.5 h-3.5" />{cmd.label}
                  </button>
                ))}
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
                    <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">Lumina AI</span>
                  </div>
                )}
                <div className={`prose prose-sm sm:prose-base max-w-none w-full ${msg.role === 'model' ? 'pl-10 prose-p:leading-[1.8] prose-p:mb-4 prose-headings:font-semibold prose-headings:mt-6 prose-headings:mb-3 prose-ul:my-4 prose-li:my-1.5 prose-strong:text-zinc-900 dark:prose-strong:text-zinc-100 prose-p:text-zinc-700 dark:prose-p:text-zinc-300 prose-headings:text-zinc-900 dark:prose-headings:text-zinc-100 prose-li:text-zinc-700 dark:prose-li:text-zinc-300 text-zinc-800 dark:text-zinc-200' : 'prose-p:leading-relaxed prose-p:text-zinc-700 dark:prose-p:text-zinc-300 text-zinc-800 dark:text-zinc-200'}`}>
                  <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                </div>
                {msg.image && (
                  <div className={`mt-4 rounded-2xl overflow-hidden border border-zinc-200/80 dark:border-white/10 ${msg.role === 'model' ? 'ml-10' : ''}`}>
                    <img src={msg.image} alt="Visualization" className="w-full h-auto" />
                  </div>
                )}
                {msg.role === 'model' && !!msg.citations?.length && (
                  <div className="mt-3 ml-10">
                    <p className="text-[10px] font-medium text-zinc-500 dark:text-zinc-500 mb-1.5">Sources</p>
                    <div className="flex flex-wrap gap-2">
                    {msg.citations.slice(0, 4).map((citation, citationIdx) => (
                      <span
                        key={`${citation.meetingId}-${citation.chunkId}-${citationIdx}`}
                        className="px-2.5 py-1 rounded-full text-[11px] bg-zinc-100 dark:bg-app-panel text-zinc-700 dark:text-zinc-200 border border-zinc-200/80 dark:border-white/10"
                        title={`${citation.meetingTitle} • ${citation.chunkId} • score ${citation.score.toFixed(2)}`}
                      >
                        {citation.meetingTitle} • {citation.chunkId}
                      </span>
                    ))}
                    </div>
                  </div>
                )}
                {msg.role === 'model' && msg.retrievalMeta && (
                  <div className="mt-2 ml-10 text-[10px] text-zinc-500 dark:text-zinc-500">
                    Scope: {msg.retrievalMeta.scope === 'many' ? 'All meetings' : 'This meeting'}
                    {typeof msg.retrievalMeta.confidence === 'number'
                      ? ` • Confidence ${Math.round(msg.retrievalMeta.confidence * 100)}%`
                      : ''}
                    {typeof msg.retrievalMeta.tokenUsageTotal === 'number'
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

          {/* Agentic execution status — shows plan steps in real time */}
          {isChatting && (() => {
            const lastModel = [...chatMessages].reverse().find(m => m.role === 'model' && m.agentStatus);
            const agentMsg = lastModel?.agentStatus ? lastModel : null;
            if (agentMsg?.agentPlan?.length) {
              return (
                <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} className="flex justify-start">
                  <div className="max-w-[88%] sm:max-w-[80%]">
                    <div className="flex items-center gap-2.5 mb-3">
                      <div className="w-7 h-7 rounded-full bg-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                        <Sparkles className="w-3.5 h-3.5 text-white" />
                      </div>
                      <span className="text-[13px] font-semibold text-zinc-800 dark:text-zinc-200">
                        {agentMsg.agentStatus === 'thinking' ? 'Understanding your request...' :
                         agentMsg.agentStatus === 'planning' ? 'Planning approach...' :
                         agentMsg.agentStatus === 'executing' ? 'Working on it...' :
                         'Finishing up...'}
                      </span>
                    </div>
                    <div className="pl-10 space-y-2">
                      {agentMsg.agentPlan.map((step) => (
                        <div key={step.id} className="flex items-start gap-2.5">
                          {step.status === 'done' ? (
                            <CheckCircle2 className="w-4 h-4 text-emerald-500 mt-0.5 flex-shrink-0" />
                          ) : step.status === 'running' ? (
                            <Loader2 className="w-4 h-4 text-blue-500 animate-spin mt-0.5 flex-shrink-0" />
                          ) : step.status === 'error' ? (
                            <X className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                          ) : (
                            <div className="w-4 h-4 rounded-full border-2 border-zinc-300 dark:border-zinc-600 mt-0.5 flex-shrink-0" />
                          )}
                          <div className="min-w-0">
                            <span className={`text-[13px] ${step.status === 'done' ? 'text-zinc-600 dark:text-zinc-300' : step.status === 'running' ? 'text-zinc-800 dark:text-zinc-200 font-medium' : 'text-zinc-500 dark:text-zinc-500'}`}>
                              {step.label}
                            </span>
                            {step.detail && (step.status === 'done' || step.status === 'running') && (
                              <span className={`text-[11px] ml-2 ${step.status === 'running' ? 'text-blue-400' : 'text-zinc-500 dark:text-zinc-400'}`}>{step.detail}</span>
                            )}
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </motion.div>
              );
            }
            return (
              <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
                <div className="flex items-center gap-2.5">
                  <div className="w-7 h-7 rounded-full bg-[#1a1a1a] flex items-center justify-center">
                    <Sparkles className="w-3.5 h-3.5 text-white" />
                  </div>
                  <ShiningText text="Lumina is thinking..." />
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
            Lumina AI can make mistakes. Verify important information.
          </p>
        </div>
      </div>
    </div>
  );
}
