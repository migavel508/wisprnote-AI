import { useRef, useEffect } from 'react';
import { motion } from 'framer-motion';
import { 
  MessageSquare, 
  Send, 
  Sparkles, 
  Plus, 
  FileText, 
  CheckCircle2, 
  Network, 
  Mail,
  Image as ImageIcon
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
}: ChatPageProps) {
  const chatEndRef = useRef<HTMLDivElement>(null);
  const messagesContainerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new messages arrive
  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, isChatting]);

  // Calculate input area height for proper padding
  const INPUT_AREA_HEIGHT = 180; // Approximate height of input area + disclaimer

  // Show skeleton while loading
  if (isLoading || !selectedTask) {
    return <ChatPageSkeleton />;
  }

  return (
    <div className="h-full w-full bg-white relative overflow-hidden">
      {/* Header breadcrumb - Fixed at top */}
      <div className="absolute top-0 left-0 right-0 flex items-center gap-3 px-6 py-4 opacity-50 text-xs font-mono uppercase tracking-widest overflow-x-auto no-scrollbar whitespace-nowrap border-b border-[#141414]/10 bg-white z-20">
        <MessageSquare className="w-4 h-4 flex-shrink-0" />
        <span className="truncate">{selectedTask.filename}</span>
        <span>/</span>
        <span className="font-bold text-[#141414]">AI Chat</span>
      </div>

      {/* Messages Container - Scrollable area between header and input */}
      <div 
        ref={messagesContainerRef}
        className="absolute top-[57px] left-0 right-0 overflow-y-auto bg-white"
        style={{ bottom: `${INPUT_AREA_HEIGHT}px` }}
      >
        <div className="max-w-3xl w-full mx-auto p-4 sm:p-8">
          {chatMessages.length === 0 ? (
            <div className="flex flex-col items-center justify-center text-center py-16">
              <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">Welcome to Chat</h1>
              <p className="text-base sm:text-lg text-[#141414]/60 max-w-xl mb-12">
                Ask anything about <span className="font-semibold text-[#141414]">{selectedTask.filename}</span>. Not sure where to start?
              </p>
              
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 w-full max-w-2xl">
                <button 
                  onClick={() => { setChatInput('Summarize the key decisions made in this meeting.'); }}
                  className="flex items-center justify-between p-4 border border-[#141414]/10 rounded-2xl hover:border-[#141414] hover:shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] transition-all bg-white group text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-yellow-100 flex items-center justify-center text-yellow-600">
                      <FileText className="w-5 h-5" />
                    </div>
                    <span className="font-medium text-sm">Summarize decisions</span>
                  </div>
                  <Plus className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-opacity" />
                </button>

                <button 
                  onClick={() => { setChatInput('What are my action items from this discussion?'); }}
                  className="flex items-center justify-between p-4 border border-[#141414]/10 rounded-2xl hover:border-[#141414] hover:shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] transition-all bg-white group text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center text-blue-600">
                      <CheckCircle2 className="w-5 h-5" />
                    </div>
                    <span className="font-medium text-sm">List action items</span>
                  </div>
                  <Plus className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-opacity" />
                </button>

                <button 
                  onClick={() => { setChatInput('Extract all the main topics discussed and generate a concept flowchart.'); }}
                  className="flex items-center justify-between p-4 border border-[#141414]/10 rounded-2xl hover:border-[#141414] hover:shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] transition-all bg-white group text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-purple-100 flex items-center justify-center text-purple-600">
                      <Network className="w-5 h-5" />
                    </div>
                    <span className="font-medium text-sm">Map concepts</span>
                  </div>
                  <Plus className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-opacity" />
                </button>

                <button 
                  onClick={() => { setChatInput('Generate a professional follow-up email to send to the team.'); }}
                  className="flex items-center justify-between p-4 border border-[#141414]/10 rounded-2xl hover:border-[#141414] hover:shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] transition-all bg-white group text-left"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-10 h-10 rounded-full bg-green-100 flex items-center justify-center text-green-600">
                      <Mail className="w-5 h-5" />
                    </div>
                    <span className="font-medium text-sm">Draft follow-up email</span>
                  </div>
                  <Plus className="w-4 h-4 opacity-30 group-hover:opacity-100 transition-opacity" />
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-8">
              {chatMessages.map((msg, i) => (
                <motion.div 
                  key={i}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                >
                  <div className={`max-w-[90%] sm:max-w-[85%] ${
                    msg.role === 'user' 
                      ? 'bg-[#F5F5F5] text-[#141414] px-6 py-4 rounded-3xl rounded-tr-sm' 
                      : 'bg-transparent text-[#141414]'
                  }`}>
                    {msg.role === 'model' && (
                      <div className="flex items-center gap-3 mb-3">
                        <div className="w-8 h-8 rounded-full bg-[#141414] flex items-center justify-center shadow-sm">
                          <Sparkles className="w-4 h-4 text-white" />
                        </div>
                        <span className="font-bold text-sm">Lumina AI</span>
                      </div>
                    )}
                    
                    <div className={`prose prose-sm sm:prose-base max-w-none w-full ${
                      msg.role === 'model' 
                        ? 'pl-11 prose-p:leading-loose prose-p:mb-6 prose-headings:font-bold prose-headings:mt-8 prose-headings:mb-4 prose-ul:my-6 prose-li:my-2 prose-li:leading-loose prose-strong:text-[#141414] text-[#141414]/90' 
                        : 'prose-p:leading-loose'
                    }`}>
                      <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                    </div>
                    
                    {msg.image && (
                      <div className={`mt-6 rounded-2xl overflow-hidden border border-[#141414]/10 shadow-sm ${msg.role === 'model' ? 'ml-11' : ''}`}>
                        <img src={msg.image} alt="Concept Visualization" className="w-full h-auto" />
                      </div>
                    )}
                    
                    {msg.role === 'model' && !msg.image && !isGeneratingImage && (
                      <div className="mt-4 ml-11">
                        <button 
                          onClick={() => handleVisualize(msg.text.substring(0, 100))}
                          className="flex items-center gap-2 text-xs font-medium text-[#141414]/60 hover:text-[#141414] transition-colors bg-[#F5F5F5] hover:bg-[#EAEAEA] px-3 py-1.5 rounded-full"
                        >
                          <ImageIcon className="w-3 h-3" /> Visualize Response
                        </button>
                      </div>
                    )}
                  </div>
                </motion.div>
              ))}
              
              {isChatting && (
                <motion.div 
                  initial={{ opacity: 0 }} 
                  animate={{ opacity: 1 }} 
                  className="flex justify-start"
                >
                  <div className="flex items-center gap-3">
                    <div className="w-8 h-8 rounded-full bg-[#141414] flex items-center justify-center shadow-sm">
                      <Sparkles className="w-4 h-4 text-white" />
                    </div>
                    <div className="flex items-center gap-1.5 px-4 py-3 bg-[#F5F5F5] rounded-3xl rounded-tl-sm">
                      <motion.div className="w-1.5 h-1.5 bg-[#141414] rounded-full" animate={{ y: [0, -3, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0 }} />
                      <motion.div className="w-1.5 h-1.5 bg-[#141414] rounded-full" animate={{ y: [0, -3, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0.2 }} />
                      <motion.div className="w-1.5 h-1.5 bg-[#141414] rounded-full" animate={{ y: [0, -3, 0] }} transition={{ duration: 0.6, repeat: Infinity, delay: 0.4 }} />
                    </div>
                  </div>
                </motion.div>
              )}
              <div ref={chatEndRef} />
            </div>
          )}
        </div>
      </div>
      
      {/* Chat Input Area - Absolutely fixed at bottom, never scrolls */}
      <div className="absolute bottom-0 left-0 right-0 bg-white border-t border-[#141414]/10 px-4 sm:px-8 py-4 z-20">
        <div className="max-w-3xl mx-auto">
          <div className="bg-white border border-[#141414]/20 rounded-2xl shadow-[0_8px_30px_rgb(0,0,0,0.04)] focus-within:border-[#141414] focus-within:shadow-[0_8px_30px_rgb(0,0,0,0.08)] transition-all overflow-hidden flex flex-col">
            <textarea 
              value={chatInput}
              onChange={(e) => setChatInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSendMessage();
                }
              }}
              placeholder="Ask a question about the meeting..."
              className="w-full bg-transparent border-none outline-none px-5 py-4 text-base font-sans resize-none max-h-40 min-h-[56px]"
              rows={1}
            />
            
            <div className="px-3 pb-3 pt-1 flex items-center justify-between border-t border-[#141414]/5">
              <div className="flex items-center gap-1">
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#141414]/60 hover:bg-[#F5F5F5] hover:text-[#141414] transition-colors">
                  <ImageIcon className="w-3.5 h-3.5" /> Visualize
                </button>
                <button className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-[#141414]/60 hover:bg-[#F5F5F5] hover:text-[#141414] transition-colors">
                  <Sparkles className="w-3.5 h-3.5" /> Prompts
                </button>
              </div>
              
              <div className="flex items-center gap-3">
                <span className="text-[10px] font-mono text-[#141414]/40 hidden sm:block">
                  {chatInput.length} / 4000
                </span>
                <button 
                  onClick={handleSendMessage}
                  disabled={!chatInput.trim() || isChatting}
                  className="w-8 h-8 bg-[#141414] text-white flex items-center justify-center rounded-lg hover:bg-[#333] disabled:opacity-30 disabled:bg-[#141414]/50 transition-all"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
          
          <div className="text-center mt-3 text-[10px] text-[#141414]/40 font-medium">
            Lumina AI can make mistakes. Consider verifying important information.
          </div>
        </div>
      </div>
    </div>
  );
}
