import { useRef, useEffect, useState } from 'react';
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

interface Message {
  role: 'user' | 'model';
  text: string;
  image?: string;
}

interface TaskHistory {
  id?: string;
  filename: string;
  transcription: string;
  summary?: string;
  notes?: string;
  created_at?: string;
}

interface GeneratedAsset {
  id?: string;
  task_id: string;
  type: string;
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
    color: 'bg-blue-100 text-blue-600',
    accent: 'border-blue-200 bg-blue-50',
  },
  {
    id: 'wiki',
    label: '/wiki',
    description: 'Generate a structured wiki / knowledge doc from the meeting',
    icon: BookOpen,
    color: 'bg-purple-100 text-purple-600',
    accent: 'border-purple-200 bg-purple-50',
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
  downloadExistingAsset?: (a: GeneratedAsset) => void;
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

  if (isLoading || !selectedTask) {
    return <ChatPageSkeleton />;
  }

  const isEmpty = chatMessages.length === 0 && agentAssetHistory.length === 0 && !pendingSlashCmd && !isGeneratingAsset;

  return (
    <div className="h-full w-full bg-[#faf9f7] flex flex-col overflow-hidden">
      {/* Header */}
      <div className="flex-none flex items-center gap-3 px-6 py-4 text-xs font-mono uppercase tracking-widest overflow-x-auto no-scrollbar whitespace-nowrap border-b border-[#141414]/10 bg-[#faf9f7] z-10">
        <MessageSquare className="w-4 h-4 flex-shrink-0 opacity-40" />
        <span className="truncate opacity-40">{selectedTask.filename}</span>
        <span className="opacity-40">/</span>
        <span className="font-bold text-[#141414]">AI Chat</span>
      </div>

      {/* Scrollable messages area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl w-full mx-auto px-4 sm:px-8 py-6 space-y-6">

          {/* Empty state */}
          {isEmpty && (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <h1 className="text-3xl sm:text-4xl font-bold tracking-tight mb-3">Welcome to Chat</h1>
              <p className="text-base text-[#141414]/50 max-w-xl mb-10">
                Ask anything about <span className="font-semibold text-[#141414]">{selectedTask.filename}</span>.
                Type <kbd className="px-1.5 py-0.5 bg-[#F5F5F5] border border-[#141414]/10 rounded font-mono">/</kbd> for AI commands.
              </p>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 w-full max-w-2xl mb-8">
                {[
                  { label: 'Summarize decisions', prompt: 'Summarize the key decisions made in this meeting.', icon: FileText, bg: 'bg-yellow-100 text-yellow-600' },
                  { label: 'List action items', prompt: 'What are my action items from this discussion?', icon: CheckCircle2, bg: 'bg-blue-100 text-blue-600' },
                  { label: 'Map key concepts', prompt: 'Extract all the main topics discussed.', icon: Network, bg: 'bg-purple-100 text-purple-600' },
                  { label: 'Draft follow-up email', prompt: '', slash: SLASH_COMMANDS[0], icon: Mail, bg: 'bg-green-100 text-green-600' },
                ].map((item, i) => (
                  <button key={i}
                    onClick={() => item.slash ? selectSlashCommand(item.slash) : setChatInput(item.prompt)}
                    className="flex items-center justify-between p-4 border border-[#141414]/10 rounded-2xl hover:border-[#141414] hover:shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] transition-all bg-white group text-left">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-full flex items-center justify-center ${item.bg}`}>
                        <item.icon className="w-5 h-5" />
                      </div>
                      <span className="font-medium text-sm">{item.label}</span>
                    </div>
                    <Plus className="w-4 h-4 opacity-20 group-hover:opacity-100 transition-opacity" />
                  </button>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 justify-center">
                {SLASH_COMMANDS.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="flex items-center gap-2 px-4 py-2 border border-[#141414]/10 rounded-full text-xs font-mono hover:border-[#141414] hover:bg-[#F5F5F5] transition-all">
                    <cmd.icon className="w-3.5 h-3.5" />{cmd.label}
                  </button>
                ))}
              </div>
            </div>
          )}

          {/* Regular chat messages */}
          {chatMessages.map((msg, i) => (
            <motion.div key={`msg-${i}`} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
              className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[88%] sm:max-w-[80%] ${msg.role === 'user' ? 'bg-[#F5F5F5] text-[#141414] px-5 py-3.5 rounded-3xl rounded-tr-sm' : 'bg-transparent text-[#141414]'}`}>
                {msg.role === 'model' && (
                  <div className="flex items-center gap-2.5 mb-3">
                    <div className="w-7 h-7 rounded-full bg-[#141414] flex items-center justify-center shadow-sm flex-shrink-0">
                      <Sparkles className="w-3.5 h-3.5 text-white" />
                    </div>
                    <span className="font-bold text-sm">Lumina AI</span>
                  </div>
                )}
                <div className={`prose prose-sm sm:prose-base max-w-none w-full ${msg.role === 'model' ? 'pl-10 prose-p:leading-loose prose-p:mb-4 prose-headings:font-bold prose-headings:mt-6 prose-headings:mb-3 prose-ul:my-4 prose-li:my-1.5 prose-strong:text-[#141414] text-[#141414]/90' : 'prose-p:leading-relaxed'}`}>
                  <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                </div>
                {msg.image && (
                  <div className={`mt-4 rounded-2xl overflow-hidden border border-[#141414]/10 shadow-sm ${msg.role === 'model' ? 'ml-10' : ''}`}>
                    <img src={msg.image} alt="Visualization" className="w-full h-auto" />
                  </div>
                )}
                {msg.role === 'model' && !msg.image && !isGeneratingImage && (
                  <div className="mt-3 ml-10">
                    <button onClick={() => handleVisualize(msg.text.substring(0, 100))}
                      className="flex items-center gap-1.5 text-xs text-[#141414]/50 hover:text-[#141414] transition-colors bg-[#F5F5F5] hover:bg-[#EAEAEA] px-3 py-1.5 rounded-full">
                      <ImageIcon className="w-3 h-3" /> Visualize
                    </button>
                  </div>
                )}
              </div>
            </motion.div>
          ))}

          {/* Chat thinking indicator */}
          {isChatting && (
            <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} className="flex justify-start">
              <div className="flex items-center gap-2.5">
                <div className="w-7 h-7 rounded-full bg-[#141414] flex items-center justify-center shadow-sm">
                  <Sparkles className="w-3.5 h-3.5 text-white" />
                </div>
                <div className="flex items-center gap-1.5 px-4 py-3 bg-[#F5F5F5] rounded-3xl rounded-tl-sm">
                  {[0, 0.15, 0.3].map((delay, i) => (
                    <motion.div key={i} className="w-1.5 h-1.5 bg-[#141414] rounded-full"
                      animate={{ y: [0, -4, 0] }} transition={{ duration: 0.5, repeat: Infinity, delay }} />
                  ))}
                </div>
              </div>
            </motion.div>
          )}

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
                    <div className={`w-7 h-7 rounded-full flex items-center justify-center flex-shrink-0 ${cmd?.color ?? 'bg-gray-100 text-gray-600'}`}>
                      <Icon className="w-3.5 h-3.5" />
                    </div>
                    <span className="font-bold text-sm">
                      {asset.type === 'email' ? 'Follow-up Email' : `Wiki (${asset.content?.style ?? 'MECE'})`}
                    </span>
                    {downloadExistingAsset && (
                      <button onClick={() => downloadExistingAsset(asset)}
                        className="ml-auto flex items-center gap-1.5 px-3 py-1 text-[10px] font-mono uppercase tracking-widest bg-[#141414] text-white rounded-lg hover:bg-[#333] transition-colors">
                        <Download className="w-3 h-3" /> Download
                      </button>
                    )}
                  </div>

                  {/* Email card */}
                  {asset.type === 'email' && (
                    <div className="border border-blue-100 bg-blue-50/40 rounded-2xl p-5 space-y-4">
                      <div className="space-y-1">
                        <p className="text-[10px] font-mono uppercase tracking-widest text-blue-400">Subject</p>
                        <h3 className="font-bold text-base leading-snug">{asset.content.subject || 'Follow-up Email'}</h3>
                      </div>
                      {asset.content.greeting && <p className="text-sm text-[#141414]/70">{asset.content.greeting}</p>}
                      {asset.content.meetingObjective && (
                        <div className="p-3 bg-white/80 border-l-4 border-blue-300 rounded-r-xl text-sm">
                          <span className="font-bold text-[10px] uppercase tracking-widest text-blue-500 block mb-1">Objective</span>
                          {asset.content.meetingObjective}
                        </div>
                      )}
                      {asset.content.keyDecisions?.length > 0 && (
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-widest text-[#141414]/40 mb-2">Key Decisions</p>
                          <ul className="space-y-1.5">
                            {asset.content.keyDecisions.map((d: string, j: number) => (
                              <li key={j} className="flex gap-2 text-sm"><span className="text-blue-400 mt-0.5">•</span>{d}</li>
                            ))}
                          </ul>
                        </div>
                      )}
                      {asset.content.tasks?.length > 0 && (
                        <div>
                          <p className="text-[10px] font-mono uppercase tracking-widest text-[#141414]/40 mb-2">Action Items</p>
                          <div className="space-y-2">
                            {asset.content.tasks.map((t: any, j: number) => (
                              <div key={j} className="flex items-start gap-2 p-2.5 bg-white/80 rounded-xl text-sm border border-blue-100">
                                <CheckCircle2 className="w-4 h-4 mt-0.5 text-blue-400 flex-shrink-0" />
                                <div>
                                  <span className="font-medium">{t.task}</span>
                                  {t.owner && <span className="text-xs text-[#141414]/40 ml-2">→ {t.owner}</span>}
                                </div>
                              </div>
                            ))}
                          </div>
                        </div>
                      )}
                      {asset.content.closing && (
                        <p className="text-sm text-[#141414]/60 border-t border-blue-100 pt-3 italic">{asset.content.closing}</p>
                      )}
                    </div>
                  )}

                  {/* Wiki card */}
                  {asset.type === 'wiki' && (
                    <div className="border border-purple-100 bg-purple-50/30 rounded-2xl p-5 space-y-4">
                      <div>
                        <p className="text-[10px] font-mono uppercase tracking-widest text-purple-400 mb-1">Wiki Document</p>
                        <h3 className="font-bold text-lg leading-snug">{asset.content.title || 'Wiki'}</h3>
                        {asset.content.subtitle && <p className="text-sm text-[#141414]/50 italic mt-1">{asset.content.subtitle}</p>}
                      </div>
                      {(asset.content.sections || []).map((section: any, j: number) => (
                        <div key={j} className="space-y-2">
                          <h4 className="font-bold text-sm text-[#141414] border-b border-purple-100 pb-1">{section.heading}</h4>
                          {section.content && <p className="text-sm text-[#141414]/80 leading-relaxed">{section.content}</p>}
                          {section.bullets?.length > 0 && (
                            <ul className="space-y-1 pl-1">
                              {section.bullets.map((b: string, k: number) => (
                                <li key={k} className="flex gap-2 text-sm text-[#141414]/70">
                                  <span className="text-purple-400 mt-0.5 flex-shrink-0">•</span>{b}
                                </li>
                              ))}
                            </ul>
                          )}
                        </div>
                      ))}
                      {asset.content.conclusion && (
                        <div className="border-t border-purple-100 pt-4">
                          <p className="text-[10px] font-mono uppercase tracking-widest text-purple-400 mb-2">Conclusion</p>
                          <p className="text-sm text-[#141414]/80 leading-relaxed italic">{asset.content.conclusion}</p>
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
              <div className="flex items-center gap-3 px-5 py-4 border border-[#141414]/10 rounded-2xl bg-[#F9F9F9]">
                <Loader2 className="w-4 h-4 animate-spin text-[#141414]/40" />
                <span className="text-sm text-[#141414]/50 font-medium">Generating…</span>
              </div>
            </motion.div>
          )}

          <div ref={chatEndRef} />
        </div>
      </div>

      {/* Input area — fixed at bottom */}
      <div className="flex-none bg-[#faf9f7] border-t border-[#141414]/10 px-4 sm:px-8 py-4">
        <div className="max-w-3xl mx-auto relative">

          {/* Slash command dropdown */}
          <AnimatePresence>
            {showSlashMenu && filteredCommands.length > 0 && (
              <motion.div initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                className="absolute bottom-full mb-2 left-0 right-0 bg-white border border-[#141414]/15 rounded-2xl shadow-2xl overflow-hidden z-30">
                <div className="px-4 py-2 border-b border-[#141414]/5">
                  <span className="text-[10px] font-mono uppercase tracking-widest text-[#141414]/30">Commands</span>
                </div>
                {filteredCommands.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="w-full flex items-center gap-3 px-4 py-3.5 hover:bg-[#F5F5F5] transition-colors text-left">
                    <div className={`w-8 h-8 rounded-xl flex items-center justify-center flex-shrink-0 ${cmd.color}`}>
                      <cmd.icon className="w-4 h-4" />
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="font-mono font-bold text-sm">{cmd.label}</p>
                      <p className="text-xs text-[#141414]/40 truncate mt-0.5">{cmd.description}</p>
                    </div>
                    <ChevronRight className="w-4 h-4 opacity-20 flex-shrink-0" />
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
                  className="absolute bottom-full mb-2 left-0 right-0 bg-white border-2 border-[#141414] rounded-2xl shadow-2xl z-30">
                  <div className="p-4">
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3">
                        <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${cmd.color}`}>
                          <cmd.icon className="w-4.5 h-4.5" />
                        </div>
                        <div>
                          <p className="font-bold text-sm">{cmd.label}</p>
                          <p className="text-xs text-[#141414]/40 mt-0.5">{cmd.description}</p>
                        </div>
                      </div>
                      <button onClick={() => setPendingSlashCmd(null)}
                        className="p-1.5 hover:bg-[#F5F5F5] rounded-lg transition-colors">
                        <X className="w-4 h-4 opacity-40" />
                      </button>
                    </div>

                    {pendingSlashCmd === 'wiki' && setWikiStyle && (
                      <div className="flex gap-2 p-1 bg-[#F5F5F5] rounded-xl mb-4">
                        {(['MECE', 'PRD'] as const).map(s => (
                          <button key={s} onClick={() => setWikiStyle(s)}
                            className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest rounded-lg transition-all ${wikiStyle === s ? 'bg-white shadow text-[#141414] font-bold' : 'text-[#141414]/40 hover:text-[#141414]'}`}>
                            {s}
                          </button>
                        ))}
                      </div>
                    )}

                    <button onClick={() => runSlashCommand(pendingSlashCmd)}
                      disabled={isGeneratingAsset}
                      className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs rounded-xl hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2 transition-colors">
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
          <div className="bg-white border border-[#141414]/20 rounded-2xl shadow-sm focus-within:border-[#141414] transition-all overflow-hidden flex flex-col">
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
              className="w-full bg-transparent border-none outline-none px-5 py-4 text-sm font-sans resize-none max-h-40 min-h-[52px]"
              rows={1}
            />
            <div className="px-3 pb-3 pt-1 flex items-center justify-between border-t border-[#141414]/5">
              <div className="flex items-center gap-1">
                {SLASH_COMMANDS.map(cmd => (
                  <button key={cmd.id} onClick={() => selectSlashCommand(cmd)}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-xs font-mono text-[#141414]/50 hover:bg-[#F5F5F5] hover:text-[#141414] transition-colors">
                    <cmd.icon className="w-3 h-3" />{cmd.label}
                  </button>
                ))}
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] font-mono text-[#141414]/30 hidden sm:block">{chatInput.length}/4000</span>
                <button onClick={handleSendMessage} disabled={!chatInput.trim() || isChatting}
                  className="w-8 h-8 bg-[#141414] text-white flex items-center justify-center rounded-xl hover:bg-[#333] disabled:opacity-30 transition-all">
                  <Send className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          </div>
          <p className="text-center mt-2 text-[10px] text-[#141414]/30">
            Lumina AI can make mistakes. Verify important information.
          </p>
        </div>
      </div>
    </div>
  );
}
