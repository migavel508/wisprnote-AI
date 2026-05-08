import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText, Sparkles, Send, Loader2, Lock, AlertCircle, MessageSquare, Clock,
} from 'lucide-react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { verifyShareAccess, type SharedMeetingData, type SharedMeeting } from '../services/awsShareService';
import { getSession, signIn } from '../services/awsAuthService';
import {
  sendSharedChatMessage, getSharedChatHistory, getRemainingMessages,
  type SharedChatMessage,
} from '../services/sharedChatService';

type SharedTab = 'summary' | 'notes';

interface ViewerState {
  status: 'loading' | 'sign_in' | 'denied' | 'ready';
  meeting?: SharedMeetingData;
  share?: SharedMeeting;
  denyReason?: string;
}

export default function SharedMeetingPage() {
  const location = useLocation();
  const shareToken = location.pathname.replace('/shared/', '').replace(/\/$/, '');

  const [state, setState] = useState<ViewerState>({ status: 'loading' });
  const [tab, setTab] = useState<SharedTab>('summary');
  const [chatMessages, setChatMessages] = useState<SharedChatMessage[]>([]);
  const [chatInput, setChatInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [remaining, setRemaining] = useState(20);
  const [chatOpen, setChatOpen] = useState(false);

  // Sign-in form state
  const [signInEmail, setSignInEmail] = useState('');
  const [signInPassword, setSignInPassword] = useState('');
  const [signInLoading, setSignInLoading] = useState(false);
  const [signInError, setSignInError] = useState('');

  const chatEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!shareToken) return;
    verifyAccess();
  }, [shareToken]);

  async function verifyAccess() {
    setState({ status: 'loading' });
    try {
      const session = await getSession();
      const viewerEmail = session?.user?.email ?? null;

      const result = await verifyShareAccess(shareToken, viewerEmail);

      if ('denied' in result) {
        if (result.reason === 'sign_in_required') {
          setState({ status: 'sign_in' });
        } else {
          setState({ status: 'denied', denyReason: result.reason });
        }
        return;
      }

      setState({ status: 'ready', meeting: result.meeting, share: result.share });
      setChatMessages(getSharedChatHistory(shareToken));
      setRemaining(getRemainingMessages(shareToken));
    } catch {
      setState({ status: 'denied', denyReason: 'Something went wrong. Please try again later.' });
    }
  }

  async function handleSignIn(e: React.FormEvent) {
    e.preventDefault();
    setSignInLoading(true);
    setSignInError('');
    try {
      const result = await signIn(signInEmail, signInPassword);
      if ('error' in result) {
        setSignInError(result.error);
        return;
      }
      await verifyAccess();
    } catch {
      setSignInError('Sign in failed. Please try again.');
    } finally {
      setSignInLoading(false);
    }
  }

  async function handleSendChat() {
    if (!chatInput.trim() || isSending || !state.meeting || remaining <= 0) return;
    const msg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: msg }]);
    setIsSending(true);

    try {
      const { reply, remaining: rem } = await sendSharedChatMessage(
        shareToken, msg, {
          notes: state.meeting.notes,
          summary: state.meeting.summary,
          filename: state.meeting.filename,
        },
      );
      setChatMessages(prev => [...prev, { role: 'model', text: reply }]);
      setRemaining(rem);
    } catch (err: any) {
      if (err?.message === 'RATE_LIMITED') {
        setChatMessages(prev => [...prev, { role: 'model', text: 'You have reached the message limit for this shared session.' }]);
        setRemaining(0);
      } else {
        setChatMessages(prev => [...prev, { role: 'model', text: 'Sorry, something went wrong. Please try again.' }]);
      }
    } finally {
      setIsSending(false);
    }
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const canChat = state.meeting?.permissions?.includes('chat');

  // ── Loading ──
  if (state.status === 'loading') {
    return (
      <div className="min-h-screen bg-[#faf8f6] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-8 h-8 animate-spin text-[#c4bab0] mx-auto mb-3" />
          <p className="text-[13px] text-[#a89888]">Loading shared meeting...</p>
        </div>
      </div>
    );
  }

  // ── Sign-in required ──
  if (state.status === 'sign_in') {
    return (
      <div className="min-h-screen bg-[#faf8f6] flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-sm border border-[#e8e2da]/60">
          <div className="flex items-center gap-2.5 mb-6">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <Lock className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <h1 className="text-[16px] font-semibold text-[#1a1a1a]">Sign in to view</h1>
              <p className="text-[12px] text-[#a89888]">This meeting is shared with specific people</p>
            </div>
          </div>
          <form onSubmit={handleSignIn} className="space-y-3">
            <input
              type="email"
              placeholder="Email address"
              value={signInEmail}
              onChange={e => setSignInEmail(e.target.value)}
              required
              className="w-full px-4 py-2.5 text-[13px] bg-[#f5f0eb] rounded-lg border-none outline-none placeholder:text-[#b5a99a] focus:ring-2 focus:ring-[#c4bab0]/50"
            />
            <input
              type="password"
              placeholder="Password"
              value={signInPassword}
              onChange={e => setSignInPassword(e.target.value)}
              required
              className="w-full px-4 py-2.5 text-[13px] bg-[#f5f0eb] rounded-lg border-none outline-none placeholder:text-[#b5a99a] focus:ring-2 focus:ring-[#c4bab0]/50"
            />
            {signInError && (
              <p className="text-[11px] text-red-500 font-medium">{signInError}</p>
            )}
            <button
              type="submit"
              disabled={signInLoading}
              className="w-full py-2.5 bg-[#1a1a1a] text-white text-[13px] font-semibold rounded-lg hover:bg-[#333] disabled:opacity-50 transition-all flex items-center justify-center gap-2"
            >
              {signInLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Sign in
            </button>
          </form>
          <div className="mt-6 pt-4 border-t border-[#e8e2da]/60 text-center">
            <span className="text-[11px] text-[#b5a99a]">Powered by </span>
            <span className="text-[11px] font-semibold text-[#a89888]">Wisprnote</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Access denied ──
  if (state.status === 'denied') {
    return (
      <div className="min-h-screen bg-[#faf8f6] flex items-center justify-center px-4">
        <div className="bg-white rounded-2xl shadow-lg p-8 w-full max-w-sm border border-[#e8e2da]/60 text-center">
          <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mx-auto mb-4">
            <AlertCircle className="w-6 h-6 text-red-400" />
          </div>
          <h1 className="text-[16px] font-semibold text-[#1a1a1a] mb-2">Access Denied</h1>
          <p className="text-[13px] text-[#a89888] leading-relaxed">{state.denyReason}</p>
          <div className="mt-6 pt-4 border-t border-[#e8e2da]/60">
            <span className="text-[11px] text-[#b5a99a]">Powered by </span>
            <span className="text-[11px] font-semibold text-[#a89888]">Wisprnote</span>
          </div>
        </div>
      </div>
    );
  }

  // ── Ready — main content ──
  const { meeting } = state;
  if (!meeting) return null;

  const formatDuration = (seconds: number) => {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    return m > 0 ? `${m} min` : `${seconds}s`;
  };

  return (
    <div className="min-h-screen bg-[#faf8f6] flex flex-col">
      {/* Header */}
      <header className="bg-white border-b border-[#e8e2da]/60 sticky top-0 z-20">
        <div className="max-w-3xl mx-auto px-6 py-4">
          <div className="flex items-center gap-2 text-[11px] text-[#b5a99a] mb-1">
            <FileText className="w-3.5 h-3.5" />
            <span>Shared Meeting</span>
            {meeting.created_at && (
              <>
                <span className="text-[#d8cec3]">·</span>
                <span>{new Date(meeting.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}</span>
              </>
            )}
            {meeting.duration > 0 && (
              <>
                <span className="text-[#d8cec3]">·</span>
                <Clock className="w-3 h-3" />
                <span>{formatDuration(meeting.duration)}</span>
              </>
            )}
          </div>
          <h1
            className="text-[20px] sm:text-[24px] font-semibold tracking-[-0.02em] text-[#2c2520] leading-tight"
            style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
          >
            {meeting.filename}
          </h1>
        </div>
      </header>

      {/* Tab bar */}
      <div className="bg-white border-b border-[#e8e2da]/60 sticky top-[72px] z-10">
        <div className="max-w-3xl mx-auto px-6">
          <div className="flex gap-[3px] bg-[#e8e2da]/60 rounded-lg p-[3px] w-fit my-2">
            {(['summary', 'notes'] as SharedTab[]).map(t => (
              <button
                key={t}
                onClick={() => setTab(t)}
                className={`px-4 py-[5px] rounded-md text-[12px] font-semibold transition-all ${
                  tab === t
                    ? 'bg-white text-[#2c2520] shadow-sm shadow-[#c4bab0]/25'
                    : 'text-[#9a8d7f] hover:text-[#5c5147]'
                }`}
              >
                {t.charAt(0).toUpperCase() + t.slice(1)}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Content */}
      <main className="flex-1 max-w-3xl mx-auto w-full px-6 py-8">
        <AnimatePresence mode="wait">
          <motion.div
            key={tab}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
          >
            {tab === 'summary' && (
              <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#e8e2da]/60 shadow-sm">
                <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[#1a1a1a] mb-5">Key Summary</h3>
                <div className="prose prose-sm max-w-none text-[#2c2520] prose-p:text-[14px] prose-p:leading-[1.75] prose-p:text-[#2c2520]/85 prose-strong:text-[#1a1a1a] prose-headings:text-[#1a1a1a] prose-headings:tracking-tight prose-li:text-[14px] prose-li:text-[#2c2520]/85 prose-td:text-[#2c2520]/85 prose-th:text-[#1a1a1a] prose-blockquote:text-[#2c2520]/70 markdown-body" style={{ color: '#2c2520' }}>
                  <Markdown remarkPlugins={[remarkGfm]}>{meeting.summary || 'No summary available.'}</Markdown>
                </div>
              </div>
            )}

            {tab === 'notes' && (
              <div className="bg-white p-6 sm:p-8 rounded-2xl border border-[#e8e2da]/60 shadow-sm">
                <h3 className="text-[17px] font-semibold tracking-[-0.01em] text-[#1a1a1a] mb-5">Structured Notes</h3>
                <div className="prose prose-sm max-w-none text-[#2c2520] prose-p:text-[14px] prose-p:leading-[1.75] prose-p:text-[#2c2520]/85 prose-strong:text-[#1a1a1a] prose-headings:text-[#1a1a1a] prose-headings:tracking-tight prose-h2:text-[16px] prose-h2:font-semibold prose-h3:text-[14px] prose-h3:font-semibold prose-li:text-[14px] prose-li:text-[#2c2520]/85 prose-td:text-[#2c2520]/85 prose-th:text-[#1a1a1a] prose-blockquote:text-[#2c2520]/70 markdown-body" style={{ color: '#2c2520' }}>
                  <Markdown remarkPlugins={[remarkGfm]}>{meeting.notes || 'No notes available.'}</Markdown>
                </div>
              </div>
            )}
          </motion.div>
        </AnimatePresence>
      </main>

      {/* Chat panel */}
      {canChat && (
        <>
          {/* Chat toggle FAB */}
          {!chatOpen && (
            <button
              onClick={() => { setChatOpen(true); setTimeout(() => inputRef.current?.focus(), 100); }}
              className="fixed bottom-6 right-6 z-30 w-14 h-14 rounded-full bg-[#1a1a1a] text-white shadow-xl hover:bg-[#333] transition-all flex items-center justify-center"
            >
              <MessageSquare className="w-5 h-5" />
            </button>
          )}

          {/* Chat drawer */}
          <AnimatePresence>
            {chatOpen && (
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', stiffness: 300, damping: 30 }}
                className="fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-[#e8e2da] shadow-2xl rounded-t-2xl max-h-[60vh] flex flex-col"
              >
                {/* Chat header */}
                <div className="flex items-center justify-between px-5 py-3 border-b border-[#e8e2da]/60">
                  <div className="flex items-center gap-2">
                    <Sparkles className="w-4 h-4 text-amber-500" />
                    <span className="text-[13px] font-semibold text-[#1a1a1a]">Chat with this meeting</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-[#b5a99a]">{remaining} messages left</span>
                    <button onClick={() => setChatOpen(false)} className="text-[#a89888] hover:text-[#5c5147] transition-colors">
                      <span className="text-[20px] leading-none">&times;</span>
                    </button>
                  </div>
                </div>

                {/* Messages */}
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4 min-h-[120px]">
                  {chatMessages.length === 0 && (
                    <p className="text-[13px] text-[#b5a99a] text-center py-6">
                      Ask anything about this meeting...
                    </p>
                  )}
                  {chatMessages.map((msg, i) => (
                    <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                      <div className={`max-w-[85%] px-4 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
                        msg.role === 'user'
                          ? 'bg-[#1a1a1a] text-white rounded-br-md'
                          : 'bg-[#f5f0eb] text-[#1a1a1a]/80 rounded-bl-md'
                      }`}>
                        {msg.role === 'model' ? (
                          <div className="prose prose-sm max-w-none prose-p:text-[13px] prose-p:leading-relaxed prose-p:text-[#1a1a1a]/80 prose-strong:text-[#1a1a1a] prose-li:text-[#1a1a1a]/80 markdown-body" style={{ color: '#1a1a1a' }}>
                            <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                          </div>
                        ) : msg.text}
                      </div>
                    </div>
                  ))}
                  {isSending && (
                    <div className="flex justify-start">
                      <div className="px-4 py-2.5 bg-[#f5f0eb] rounded-2xl rounded-bl-md">
                        <Loader2 className="w-4 h-4 animate-spin text-[#a89888]" />
                      </div>
                    </div>
                  )}
                  <div ref={chatEndRef} />
                </div>

                {/* Input */}
                <div className="px-5 py-3 border-t border-[#e8e2da]/60">
                  <div className="flex items-center gap-2">
                    <input
                      ref={inputRef}
                      type="text"
                      placeholder={remaining > 0 ? 'Ask about this meeting...' : 'Message limit reached'}
                      value={chatInput}
                      onChange={e => setChatInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                      disabled={remaining <= 0}
                      className="flex-1 px-4 py-2.5 text-[13px] bg-[#f5f0eb] rounded-xl border-none outline-none placeholder:text-[#b5a99a] focus:ring-2 focus:ring-[#c4bab0]/50 disabled:opacity-50 transition-all"
                    />
                    <button
                      onClick={handleSendChat}
                      disabled={!chatInput.trim() || isSending || remaining <= 0}
                      className="p-2.5 bg-[#1a1a1a] text-white rounded-xl hover:bg-[#333] disabled:opacity-30 transition-all"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}

      {/* Footer */}
      <footer className="py-4 text-center border-t border-[#e8e2da]/40 bg-white/50">
        <span className="text-[11px] text-[#b5a99a]">Powered by </span>
        <span className="text-[11px] font-semibold text-[#a89888]">Wisprnote</span>
      </footer>
    </div>
  );
}
