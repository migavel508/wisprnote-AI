import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText, Sparkles, Send, Loader2, Lock, AlertCircle, Clock, X, Mic,
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

// ── Brand footer / branding mark ──────────────────────────────────────────────
function WisprBranding({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-1.5 ${className}`}>
      <span className="text-[11px] text-[#b5a99a]">Powered by</span>
      <span className="text-[11px] font-semibold text-[#2c2520]">Wisprnote AI</span>
      <span className="text-[11px] text-rose-400">♥</span>
    </div>
  );
}

// ── Wisprnote wordmark ─────────────────────────────────────────────────────────
function WisprLogo() {
  return (
    <div className="flex items-center gap-2">
      <div className="w-7 h-7 rounded-lg bg-[#1c1917] flex items-center justify-center shadow-sm">
        <Sparkles className="w-3.5 h-3.5 text-amber-300" />
      </div>
      <span
        className="text-[15px] font-semibold tracking-[-0.02em] text-[#1c1917]"
        style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
      >
        wisprnote
      </span>
    </div>
  );
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
  // mobile: bottom drawer toggle
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

  // Sign-in form
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
        setState(result.reason === 'sign_in_required'
          ? { status: 'sign_in' }
          : { status: 'denied', denyReason: result.reason });
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
      if ('error' in result) { setSignInError(result.error); return; }
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
      const text = err?.message === 'RATE_LIMITED'
        ? 'You have reached the message limit for this shared session.'
        : 'Sorry, something went wrong. Please try again.';
      setChatMessages(prev => [...prev, { role: 'model', text }]);
      if (err?.message === 'RATE_LIMITED') setRemaining(0);
    } finally {
      setIsSending(false);
    }
  }

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const canChat = state.meeting?.permissions?.includes('chat');

  // ── Loading ──────────────────────────────────────────────────────────────────
  if (state.status === 'loading') {
    return (
      <div className="min-h-screen bg-[#f7f4f1] flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-7 h-7 animate-spin text-[#c4bab0] mx-auto mb-3" />
          <p className="text-[13px] text-[#a89888]">Loading shared meeting…</p>
        </div>
      </div>
    );
  }

  // ── Sign-in required ─────────────────────────────────────────────────────────
  if (state.status === 'sign_in') {
    return (
      <div className="min-h-screen bg-[#f7f4f1] flex flex-col">
        <header className="px-6 py-4 flex items-center">
          <WisprLogo />
        </header>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-sm p-8 w-full max-w-sm border border-[#e8e2da]/60">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
                <Lock className="w-5 h-5 text-amber-500" />
              </div>
              <div>
                <h1 className="text-[15px] font-semibold text-[#1c1917]">Sign in to view</h1>
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
                className="w-full px-4 py-2.5 text-[13px] bg-[#f5f0eb] rounded-xl border-none outline-none placeholder:text-[#c4bab0] focus:ring-2 focus:ring-[#c4bab0]/40"
              />
              <input
                type="password"
                placeholder="Password"
                value={signInPassword}
                onChange={e => setSignInPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 text-[13px] bg-[#f5f0eb] rounded-xl border-none outline-none placeholder:text-[#c4bab0] focus:ring-2 focus:ring-[#c4bab0]/40"
              />
              {signInError && <p className="text-[11px] text-red-500 font-medium">{signInError}</p>}
              <button
                type="submit"
                disabled={signInLoading}
                className="w-full py-2.5 bg-[#1c1917] text-white text-[13px] font-semibold rounded-xl hover:bg-[#2c2520] disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {signInLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Sign in
              </button>
            </form>
            <WisprBranding className="mt-6 pt-4 border-t border-[#e8e2da]/50" />
          </div>
        </div>
      </div>
    );
  }

  // ── Access denied ────────────────────────────────────────────────────────────
  if (state.status === 'denied') {
    return (
      <div className="min-h-screen bg-[#f7f4f1] flex flex-col">
        <header className="px-6 py-4 flex items-center">
          <WisprLogo />
        </header>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-sm p-8 w-full max-w-sm border border-[#e8e2da]/60 text-center">
            <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6 text-red-400" />
            </div>
            <h1 className="text-[16px] font-semibold text-[#1c1917] mb-2">Access Denied</h1>
            <p className="text-[13px] text-[#a89888] leading-relaxed">{state.denyReason}</p>
            <WisprBranding className="mt-6 pt-4 border-t border-[#e8e2da]/50" />
          </div>
        </div>
      </div>
    );
  }

  // ── Ready ────────────────────────────────────────────────────────────────────
  const { meeting } = state;
  if (!meeting) return null;

  const formatDuration = (seconds: number) => {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    return m > 0 ? `${m} min` : `${seconds}s`;
  };

  const formattedDate = meeting.created_at
    ? new Date(meeting.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
    : null;

  // Shared chat input bar (used in both sidebar + mobile drawer)
  const ChatInput = (
    <div className="px-4 py-3 border-t border-[#ede8e3]">
      <div className="flex items-center gap-2 bg-[#f7f4f1] rounded-full px-4 py-2.5 border border-[#e8e2da]">
        <input
          ref={inputRef}
          type="text"
          placeholder={remaining > 0 ? 'Ask anything…' : 'Message limit reached'}
          value={chatInput}
          onChange={e => setChatInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
          disabled={remaining <= 0}
          className="flex-1 bg-transparent border-none outline-none text-[13px] text-[#1c1917] placeholder:text-[#c4bab0] disabled:opacity-50"
        />
        <div className="flex items-center gap-1.5 flex-shrink-0">
          <button className="p-1 text-[#c4bab0] hover:text-[#9a8d7f] transition-colors" title="Voice input">
            <Mic className="w-4 h-4" />
          </button>
          <button
            onClick={handleSendChat}
            disabled={!chatInput.trim() || isSending || remaining <= 0}
            className="w-7 h-7 rounded-full bg-[#1c1917] text-white flex items-center justify-center hover:bg-[#2c2520] disabled:opacity-30 transition-all"
          >
            {isSending ? <Loader2 className="w-3 h-3 animate-spin" /> : <Send className="w-3 h-3" />}
          </button>
        </div>
      </div>
    </div>
  );

  // Shared messages area
  const ChatMessages = (
    <div className="flex-1 overflow-y-auto px-4 py-4 space-y-4 min-h-0">
      {chatMessages.length === 0 && (
        <div className="flex flex-col items-center justify-center h-full py-10 text-center">
          <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center mb-3">
            <Sparkles className="w-5 h-5 text-amber-400" />
          </div>
          <p className="text-[13px] text-[#b5a99a] leading-relaxed max-w-[160px]">
            Ask anything about this meeting…
          </p>
        </div>
      )}
      {chatMessages.map((msg, i) => (
        <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
          {msg.role === 'model' && (
            <div className="w-5 h-5 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0 mr-2 mt-0.5">
              <Sparkles className="w-2.5 h-2.5 text-amber-400" />
            </div>
          )}
          <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
            msg.role === 'user'
              ? 'bg-[#1c1917] text-white rounded-tr-sm'
              : 'bg-[#f0ece7] text-[#2c2520] rounded-tl-sm'
          }`}>
            {msg.role === 'model' ? (
              <div className="prose prose-sm max-w-none prose-p:text-[13px] prose-p:leading-relaxed prose-p:text-[#2c2520] prose-strong:text-[#1c1917] prose-li:text-[#2c2520] markdown-body" style={{ color: '#2c2520' }}>
                <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
              </div>
            ) : msg.text}
          </div>
        </div>
      ))}
      {isSending && (
        <div className="flex justify-start">
          <div className="w-5 h-5 rounded-full bg-amber-50 flex items-center justify-center flex-shrink-0 mr-2 mt-0.5">
            <Sparkles className="w-2.5 h-2.5 text-amber-400" />
          </div>
          <div className="px-3.5 py-2.5 bg-[#f0ece7] rounded-2xl rounded-tl-sm">
            <div className="flex gap-1 items-center">
              <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] animate-bounce [animation-delay:0ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] animate-bounce [animation-delay:150ms]" />
              <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] animate-bounce [animation-delay:300ms]" />
            </div>
          </div>
        </div>
      )}
      <div ref={chatEndRef} />
    </div>
  );

  return (
    <div className="min-h-screen bg-[#f7f4f1] flex flex-col">

      {/* ── Top navigation bar ── */}
      <header className="bg-[#1c1917] sticky top-0 z-20 flex-none">
        <div className="max-w-screen-xl mx-auto px-5 py-3 flex items-center justify-between">
          {/* Logo */}
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-md bg-amber-300/20 flex items-center justify-center">
              <Sparkles className="w-3.5 h-3.5 text-amber-300" />
            </div>
            <span
              className="text-[15px] font-semibold tracking-[-0.01em] text-white/90"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
            >
              wisprnote
            </span>
          </div>

          {/* Right actions */}
          <div className="flex items-center gap-3">
            <a
              href="https://wisprnote.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-[#1c1917] text-[12px] font-semibold rounded-full hover:bg-amber-50 transition-colors"
            >
              <Sparkles className="w-3 h-3 text-amber-500" />
              Open in Wisprnote
            </a>
            <WisprBranding className="hidden sm:flex !gap-1" />
          </div>
        </div>
      </header>

      {/* ── Two-column body ── */}
      <div className="flex-1 flex max-w-screen-xl mx-auto w-full min-h-0">

        {/* ── Left: meeting content ── */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 sm:px-10 py-10">

            {/* Meta breadcrumb */}
            <div className="flex items-center gap-1.5 text-[11px] text-[#b5a99a] mb-3 flex-wrap">
              <FileText className="w-3 h-3 flex-shrink-0" />
              <span>Shared Meeting</span>
              {formattedDate && (
                <>
                  <span className="text-[#d8cec3]">·</span>
                  <span>{formattedDate}</span>
                </>
              )}
              {meeting.duration > 0 && (
                <>
                  <span className="text-[#d8cec3]">·</span>
                  <Clock className="w-3 h-3 flex-shrink-0" />
                  <span>{formatDuration(meeting.duration)}</span>
                </>
              )}
            </div>

            {/* Meeting title */}
            <h1
              className="text-[26px] sm:text-[36px] font-bold tracking-[-0.025em] text-[#1c1917] leading-tight mb-8"
              style={{ fontFamily: 'Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
            >
              {meeting.filename}
            </h1>

            {/* Tab bar */}
            <div className="flex gap-[3px] bg-[#e8e2da]/70 rounded-lg p-[3px] w-fit mb-7">
              {(['summary', 'notes'] as SharedTab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-5 py-1.5 rounded-md text-[12px] font-semibold transition-all ${
                    tab === t
                      ? 'bg-white text-[#1c1917] shadow-sm shadow-[#c4bab0]/20'
                      : 'text-[#9a8d7f] hover:text-[#5c5147]'
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            {/* Content */}
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
              >
                {tab === 'summary' && (
                  <div className="prose prose-sm max-w-none
                    prose-headings:text-[#1c1917] prose-headings:tracking-tight prose-headings:font-semibold
                    prose-h2:text-[15px] prose-h3:text-[14px]
                    prose-p:text-[14px] prose-p:leading-[1.8] prose-p:text-[#2c2520]
                    prose-li:text-[14px] prose-li:text-[#2c2520] prose-li:leading-[1.7]
                    prose-strong:text-[#1c1917] prose-strong:font-semibold
                    prose-blockquote:border-l-[#e8e2da] prose-blockquote:text-[#7a6d62]
                    prose-td:text-[#2c2520] prose-th:text-[#1c1917]
                    markdown-body">
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {meeting.summary || 'No summary available.'}
                    </Markdown>
                  </div>
                )}
                {tab === 'notes' && (
                  <div className="prose prose-sm max-w-none
                    prose-headings:text-[#1c1917] prose-headings:tracking-tight prose-headings:font-semibold
                    prose-h2:text-[15px] prose-h3:text-[14px]
                    prose-p:text-[14px] prose-p:leading-[1.8] prose-p:text-[#2c2520]
                    prose-li:text-[14px] prose-li:text-[#2c2520] prose-li:leading-[1.7]
                    prose-strong:text-[#1c1917] prose-strong:font-semibold
                    prose-blockquote:border-l-[#e8e2da] prose-blockquote:text-[#7a6d62]
                    prose-td:text-[#2c2520] prose-th:text-[#1c1917]
                    markdown-body">
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {meeting.notes || 'No notes available.'}
                    </Markdown>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Mobile branding */}
            <WisprBranding className="sm:hidden mt-14 mb-4" />
          </div>
        </main>

        {/* ── Right: AI chat sidebar (desktop only) ── */}
        {canChat && (
          <aside className="hidden md:flex flex-col w-[320px] xl:w-[360px] flex-none border-l border-[#e8e2da] bg-white sticky top-[49px] h-[calc(100vh-49px)]">
            {/* Sidebar header */}
            <div className="flex-none px-5 py-4 border-b border-[#ede8e3]">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <div className="w-6 h-6 rounded-md bg-amber-50 flex items-center justify-center">
                    <Sparkles className="w-3.5 h-3.5 text-amber-400" />
                  </div>
                  <span className="text-[13px] font-semibold text-[#1c1917]">Wisprnote AI</span>
                </div>
                {remaining < 20 && (
                  <span className="text-[10px] text-[#b5a99a] bg-[#f7f4f1] px-2 py-0.5 rounded-full">
                    {remaining} left
                  </span>
                )}
              </div>
              <p className="text-[11px] text-[#b5a99a] mt-1">Ask anything about this meeting</p>
            </div>

            {/* Messages */}
            {ChatMessages}

            {/* Input */}
            {ChatInput}

            {/* Sidebar branding */}
            <WisprBranding className="py-2.5 border-t border-[#ede8e3]" />
          </aside>
        )}
      </div>

      {/* ── Mobile chat FAB + drawer ── */}
      {canChat && (
        <>
          {/* FAB */}
          {!mobileChatOpen && (
            <button
              onClick={() => { setMobileChatOpen(true); setTimeout(() => inputRef.current?.focus(), 150); }}
              className="md:hidden fixed bottom-6 right-6 z-30 flex items-center gap-2 px-4 py-3 rounded-full bg-[#1c1917] text-white shadow-xl hover:bg-[#2c2520] transition-all text-[13px] font-medium"
            >
              <Sparkles className="w-4 h-4 text-amber-300" />
              Ask AI
            </button>
          )}

          {/* Bottom drawer */}
          <AnimatePresence>
            {mobileChatOpen && (
              <motion.div
                initial={{ y: '100%' }}
                animate={{ y: 0 }}
                exit={{ y: '100%' }}
                transition={{ type: 'spring', stiffness: 320, damping: 32 }}
                className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-[#e8e2da] shadow-2xl rounded-t-2xl flex flex-col"
                style={{ maxHeight: '65vh' }}
              >
                {/* Drawer header */}
                <div className="flex-none flex items-center justify-between px-5 py-3 border-b border-[#ede8e3]">
                  <div className="flex items-center gap-2">
                    <div className="w-5 h-5 rounded-md bg-amber-50 flex items-center justify-center">
                      <Sparkles className="w-3 h-3 text-amber-400" />
                    </div>
                    <span className="text-[13px] font-semibold text-[#1c1917]">Wisprnote AI</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-[10px] text-[#b5a99a]">{remaining} messages left</span>
                    <button
                      onClick={() => setMobileChatOpen(false)}
                      className="w-6 h-6 rounded-full bg-[#f5f0eb] flex items-center justify-center text-[#9a8d7f] hover:bg-[#ede8e3] transition-colors"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                </div>

                {/* Messages */}
                {ChatMessages}

                {/* Input */}
                {ChatInput}
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
