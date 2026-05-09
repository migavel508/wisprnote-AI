import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  FileText, Sparkles, Send, Loader2, Lock, AlertCircle, Clock, X, Mic,
  Paperclip, LayoutGrid, Calendar, User,
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

const LOGO_FONT = '"Etna Sans Serif", "Inter", system-ui, sans-serif';

function WisprBranding({ className = '', variant = 'light' }: { className?: string; variant?: 'light' | 'dark' | 'nav' }) {
  const textCls = variant === 'nav'
    ? 'text-white/50'
    : 'text-[#b5a99a] dark:text-white/40';
  const brandCls = variant === 'nav'
    ? 'text-white/80'
    : 'text-[#2c2520] dark:text-white/70';
  return (
    <div className={`flex items-center justify-center gap-1.5 ${className}`}>
      <span className={`text-[11px] ${textCls}`}>Powered by</span>
      <span className={`text-[11px] font-semibold ${brandCls}`}>Wisprnote AI</span>
      <span className="text-[11px] text-rose-400">♥</span>
    </div>
  );
}

function WisprLogo({ variant = 'light' }: { variant?: 'light' | 'dark' }) {
  const textCls = variant === 'dark'
    ? 'text-white/90'
    : 'text-[#1c1917] dark:text-white/90';
  return (
    <div className="flex items-center gap-2.5">
      <img
        src="/logo_status.png"
        alt="Wisprnote"
        className="w-7 h-7 rounded-lg object-cover"
      />
      <span
        className={`text-[16px] font-semibold tracking-[-0.01em] ${textCls}`}
        style={{ fontFamily: LOGO_FONT }}
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
  const [mobileChatOpen, setMobileChatOpen] = useState(false);

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
      <div className="min-h-screen bg-[#f7f4f1] dark:bg-app-canvas flex items-center justify-center">
        <div className="text-center">
          <Loader2 className="w-7 h-7 animate-spin text-[#c4bab0] dark:text-white/20 mx-auto mb-3" />
          <p className="text-[13px] text-[#a89888] dark:text-white/40">Loading shared meeting…</p>
        </div>
      </div>
    );
  }

  // ── Sign-in required ─────────────────────────────────────────────────────────
  if (state.status === 'sign_in') {
    return (
      <div className="min-h-screen bg-[#f7f4f1] dark:bg-app-canvas flex flex-col">
        <header className="px-6 py-4 flex items-center">
          <WisprLogo />
        </header>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white dark:bg-app-panel rounded-2xl shadow-sm dark:shadow-none p-8 w-full max-w-sm border border-[#e8e2da]/60 dark:border-app-border">
            <div className="flex items-center gap-3 mb-6">
              <div className="w-10 h-10 rounded-xl bg-amber-50 dark:bg-amber-900/20 flex items-center justify-center">
                <Lock className="w-5 h-5 text-amber-500 dark:text-amber-400" />
              </div>
              <div>
                <h1 className="text-[15px] font-semibold text-[#1c1917] dark:text-app-fg">Sign in to view</h1>
                <p className="text-[12px] text-[#a89888] dark:text-app-fg-muted">This meeting is shared with specific people</p>
              </div>
            </div>
            <form onSubmit={handleSignIn} className="space-y-3">
              <input
                type="email"
                placeholder="Email address"
                value={signInEmail}
                onChange={e => setSignInEmail(e.target.value)}
                required
                className="w-full px-4 py-2.5 text-[13px] bg-[#f5f0eb] dark:bg-app-raised rounded-xl border-none outline-none text-[#1c1917] dark:text-app-fg placeholder:text-[#c4bab0] dark:placeholder:text-app-fg-subtle focus:ring-2 focus:ring-[#c4bab0]/40 dark:focus:ring-white/10"
              />
              <input
                type="password"
                placeholder="Password"
                value={signInPassword}
                onChange={e => setSignInPassword(e.target.value)}
                required
                className="w-full px-4 py-2.5 text-[13px] bg-[#f5f0eb] dark:bg-app-raised rounded-xl border-none outline-none text-[#1c1917] dark:text-app-fg placeholder:text-[#c4bab0] dark:placeholder:text-app-fg-subtle focus:ring-2 focus:ring-[#c4bab0]/40 dark:focus:ring-white/10"
              />
              {signInError && <p className="text-[11px] text-red-500 font-medium">{signInError}</p>}
              <button
                type="submit"
                disabled={signInLoading}
                className="w-full py-2.5 bg-[#1c1917] dark:bg-white text-white dark:text-[#1c1917] text-[13px] font-semibold rounded-xl hover:bg-[#2c2520] dark:hover:bg-white/90 disabled:opacity-50 transition-all flex items-center justify-center gap-2"
              >
                {signInLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
                Sign in
              </button>
            </form>
            <WisprBranding className="mt-6 pt-4 border-t border-[#e8e2da]/50 dark:border-app-border" />
          </div>
        </div>
      </div>
    );
  }

  // ── Access denied ────────────────────────────────────────────────────────────
  if (state.status === 'denied') {
    return (
      <div className="min-h-screen bg-[#f7f4f1] dark:bg-app-canvas flex flex-col">
        <header className="px-6 py-4 flex items-center">
          <WisprLogo />
        </header>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white dark:bg-app-panel rounded-2xl shadow-sm dark:shadow-none p-8 w-full max-w-sm border border-[#e8e2da]/60 dark:border-app-border text-center">
            <div className="w-12 h-12 rounded-xl bg-red-50 dark:bg-red-900/20 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6 text-red-400" />
            </div>
            <h1 className="text-[16px] font-semibold text-[#1c1917] dark:text-app-fg mb-2">Access Denied</h1>
            <p className="text-[13px] text-[#a89888] dark:text-app-fg-muted leading-relaxed">{state.denyReason}</p>
            <WisprBranding className="mt-6 pt-4 border-t border-[#e8e2da]/50 dark:border-app-border" />
          </div>
        </div>
      </div>
    );
  }

  // ── Ready — main view ────────────────────────────────────────────────────────
  const { meeting } = state;
  if (!meeting) return null;

  const formatDuration = (seconds: number) => {
    if (!seconds) return '';
    const m = Math.floor(seconds / 60);
    return m > 0 ? `${m} min` : `${seconds}s`;
  };

  const formattedDate = meeting.created_at
    ? new Date(meeting.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })
    : null;

  const hasMessages = chatMessages.length > 0;

  const proseClasses = `prose prose-sm max-w-none
    prose-headings:text-[#1c1917] dark:prose-headings:text-app-fg prose-headings:tracking-tight prose-headings:font-semibold
    prose-h2:text-[15px] prose-h3:text-[14px]
    prose-p:text-[14px] prose-p:leading-[1.8] prose-p:text-[#2c2520] dark:prose-p:text-app-fg/85
    prose-li:text-[14px] prose-li:text-[#2c2520] dark:prose-li:text-app-fg/85 prose-li:leading-[1.7]
    prose-strong:text-[#1c1917] dark:prose-strong:text-app-fg prose-strong:font-semibold
    prose-blockquote:border-l-[#e8e2da] dark:prose-blockquote:border-l-app-border prose-blockquote:text-[#7a6d62] dark:prose-blockquote:text-app-fg-muted
    prose-td:text-[#2c2520] dark:prose-td:text-app-fg/85 prose-th:text-[#1c1917] dark:prose-th:text-app-fg
    markdown-body`;

  return (
    <div className="min-h-screen bg-[#f7f4f1] dark:bg-app-canvas flex flex-col">

      {/* ── Top navbar — stays dark in both modes ── */}
      <header className="bg-[#1c1917] sticky top-0 z-20 flex-none">
        <div className="max-w-screen-xl mx-auto px-5 py-3 flex items-center justify-between">
          <WisprLogo variant="dark" />
          <div className="flex items-center gap-3">
            <a
              href="https://wisprnote.com"
              target="_blank"
              rel="noopener noreferrer"
              className="hidden sm:flex items-center gap-1.5 px-3.5 py-1.5 bg-white text-[#1c1917] text-[12px] font-semibold rounded-full hover:bg-gray-100 transition-colors"
            >
              <img src="/logo_status.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
              Open in Wisprnote
            </a>
            <span className="hidden md:inline text-[13px] text-white/60 hover:text-white cursor-pointer transition-colors">
              Sign in
            </span>
          </div>
        </div>
      </header>

      {/* ── Two-column body ── */}
      <div className="flex-1 flex max-w-screen-xl mx-auto w-full min-h-0">

        {/* ── Left: meeting content ── */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 sm:px-10 py-10 sm:py-14">

            {/* Meeting title */}
            <h1
              className="text-[28px] sm:text-[38px] font-bold tracking-[-0.025em] text-[#1c1917] dark:text-app-fg leading-[1.15] mb-4"
              style={{ fontFamily: '"Cormorant Garamond", Georgia, "Times New Roman", serif', fontStyle: 'italic' }}
            >
              {meeting.filename}
            </h1>

            {/* Meta: author + date (like Granola) */}
            <div className="flex items-center gap-4 mb-8 flex-wrap">
              <div className="flex items-center gap-1.5">
                <User className="w-3.5 h-3.5 text-[#b5a99a] dark:text-app-fg-subtle" />
                <span className="text-[12px] text-[#7a6d62] dark:text-app-fg-muted font-medium">Shared</span>
              </div>
              {formattedDate && (
                <div className="flex items-center gap-1.5">
                  <Calendar className="w-3.5 h-3.5 text-[#b5a99a] dark:text-app-fg-subtle" />
                  <span className="text-[12px] text-[#7a6d62] dark:text-app-fg-muted">{formattedDate}</span>
                </div>
              )}
              {meeting.duration > 0 && (
                <div className="flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-[#b5a99a] dark:text-app-fg-subtle" />
                  <span className="text-[12px] text-[#7a6d62] dark:text-app-fg-muted">{formatDuration(meeting.duration)}</span>
                </div>
              )}
            </div>

            {/* Content — rendered directly (no tab bar, Granola-style) */}
            {/* Section markers with colored dots like Granola */}
            <AnimatePresence mode="wait">
              <motion.div
                key={tab}
                initial={{ opacity: 0, y: 4 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -4 }}
                transition={{ duration: 0.18 }}
              >
                {tab === 'summary' && (
                  <div className={proseClasses}>
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {meeting.summary || 'No summary available.'}
                    </Markdown>
                  </div>
                )}
                {tab === 'notes' && (
                  <div className={proseClasses}>
                    <Markdown remarkPlugins={[remarkGfm]}>
                      {meeting.notes || 'No notes available.'}
                    </Markdown>
                  </div>
                )}
              </motion.div>
            </AnimatePresence>

            {/* Tab toggle (small, below content so it doesn't dominate) */}
            <div className="flex gap-1 mt-10 mb-6">
              {(['summary', 'notes'] as SharedTab[]).map(t => (
                <button
                  key={t}
                  onClick={() => setTab(t)}
                  className={`px-4 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
                    tab === t
                      ? 'bg-[#1c1917] dark:bg-white text-white dark:text-[#1c1917] border-transparent'
                      : 'text-[#9a8d7f] dark:text-app-fg-muted border-[#e8e2da] dark:border-app-border hover:text-[#5c5147] dark:hover:text-app-fg'
                  }`}
                >
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            <WisprBranding className="md:hidden mt-10 mb-4" />
          </div>
        </main>

        {/* ── Right: chat sidebar (Granola-style, desktop only) ── */}
        {canChat && (
          <aside className="hidden md:flex flex-col w-[300px] xl:w-[340px] flex-none border-l border-[#e8e2da]/60 dark:border-app-border bg-white dark:bg-app-panel sticky top-[49px] h-[calc(100vh-49px)]">

            {/* Top spacer + "All recipes"-style header area */}
            <div className="flex-none px-4 pt-5 pb-3 flex items-center justify-end">
              <button className="flex items-center gap-1.5 text-[12px] text-[#7a6d62] dark:text-app-fg-muted hover:text-[#1c1917] dark:hover:text-app-fg transition-colors font-medium">
                <LayoutGrid className="w-3.5 h-3.5" />
                All recipes
              </button>
            </div>

            {/* Messages area */}
            <div className="flex-1 overflow-y-auto px-4 py-2 space-y-3 min-h-0">
              {!hasMessages && (
                <div className="flex flex-col items-center justify-center h-full text-center">
                  {/* intentionally empty — clean like Granola */}
                </div>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#1c1917] dark:bg-white text-white dark:text-[#1c1917] rounded-tr-sm'
                      : 'bg-[#f5f0eb] dark:bg-app-raised text-[#2c2520] dark:text-app-fg rounded-tl-sm'
                  }`}>
                    {msg.role === 'model' ? (
                      <div className="prose prose-sm max-w-none prose-p:text-[13px] prose-p:leading-relaxed prose-p:text-[#2c2520] dark:prose-p:text-app-fg/85 prose-strong:text-[#1c1917] dark:prose-strong:text-app-fg prose-li:text-[#2c2520] dark:prose-li:text-app-fg/85 markdown-body">
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                      </div>
                    ) : msg.text}
                  </div>
                </div>
              ))}
              {isSending && (
                <div className="flex justify-start">
                  <div className="px-3.5 py-2.5 bg-[#f5f0eb] dark:bg-app-raised rounded-2xl rounded-tl-sm">
                    <div className="flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] dark:bg-app-fg-subtle animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] dark:bg-app-fg-subtle animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] dark:bg-app-fg-subtle animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Chat input — Granola-style: bordered pill at bottom */}
            <div className="flex-none px-4 py-4">
              <div className="flex items-center gap-2 border border-[#e8e2da] dark:border-app-border rounded-xl px-3.5 py-2.5 bg-white dark:bg-app-raised hover:border-[#d0c8bf] dark:hover:border-app-border-strong transition-colors">
                <input
                  ref={inputRef}
                  type="text"
                  placeholder={remaining > 0 ? 'Ask anything' : 'Message limit reached'}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                  disabled={remaining <= 0}
                  className="flex-1 bg-transparent border-none outline-none text-[13px] text-[#1c1917] dark:text-app-fg placeholder:text-[#c4bab0] dark:placeholder:text-app-fg-subtle disabled:opacity-50"
                />
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button className="p-1 text-[#c4bab0] dark:text-app-fg-subtle hover:text-[#7a6d62] dark:hover:text-app-fg-muted transition-colors" title="Attach">
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <button className="p-1 text-[#c4bab0] dark:text-app-fg-subtle hover:text-[#7a6d62] dark:hover:text-app-fg-muted transition-colors" title="Voice input">
                    <Mic className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* ── Floating "Chat with AI" pill — bottom-center (like Granola) ── */}
      {canChat && !mobileChatOpen && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30">
          <button
            onClick={() => {
              setMobileChatOpen(true);
              setTimeout(() => inputRef.current?.focus(), 150);
            }}
            className="flex items-center gap-2 px-5 py-2.5 bg-white dark:bg-app-panel text-[#1c1917] dark:text-app-fg rounded-full shadow-lg dark:shadow-[0_4px_24px_rgba(0,0,0,0.5)] border border-[#e8e2da]/80 dark:border-app-border hover:shadow-xl hover:border-[#d0c8bf] dark:hover:border-app-border-strong transition-all text-[13px] font-medium md:hidden"
          >
            <Sparkles className="w-3.5 h-3.5 text-amber-500 dark:text-amber-400" />
            Chat with AI about this meeting…
          </button>
        </div>
      )}

      {/* ── Mobile chat drawer ── */}
      <AnimatePresence>
        {mobileChatOpen && (
          <motion.div
            initial={{ y: '100%' }}
            animate={{ y: 0 }}
            exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white dark:bg-app-panel border-t border-[#e8e2da] dark:border-app-border shadow-2xl dark:shadow-[0_-8px_40px_rgba(0,0,0,0.5)] rounded-t-2xl flex flex-col"
            style={{ maxHeight: '65vh' }}
          >
            {/* Drawer header */}
            <div className="flex-none flex items-center justify-between px-5 py-3 border-b border-[#ede8e3] dark:border-app-border">
              <div className="flex items-center gap-2">
                <img src="/logo_status.png" alt="" className="w-4 h-4 rounded-sm" />
                <span className="text-[13px] font-semibold text-[#1c1917] dark:text-app-fg" style={{ fontFamily: LOGO_FONT }}>
                  Wisprnote AI
                </span>
              </div>
              <div className="flex items-center gap-3">
                <span className="text-[10px] text-[#b5a99a] dark:text-app-fg-subtle">{remaining} left</span>
                <button
                  onClick={() => setMobileChatOpen(false)}
                  className="w-6 h-6 rounded-full bg-[#f5f0eb] dark:bg-app-raised flex items-center justify-center text-[#9a8d7f] dark:text-app-fg-muted hover:bg-[#ede8e3] dark:hover:bg-app-chip transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-[100px]">
              {chatMessages.length === 0 && (
                <p className="text-[13px] text-[#b5a99a] dark:text-app-fg-subtle text-center py-6">
                  Ask anything about this meeting…
                </p>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#1c1917] dark:bg-white text-white dark:text-[#1c1917] rounded-tr-sm'
                      : 'bg-[#f5f0eb] dark:bg-app-raised text-[#2c2520] dark:text-app-fg rounded-tl-sm'
                  }`}>
                    {msg.role === 'model' ? (
                      <div className="prose prose-sm max-w-none prose-p:text-[13px] prose-p:leading-relaxed prose-p:text-[#2c2520] dark:prose-p:text-app-fg/85 prose-strong:text-[#1c1917] dark:prose-strong:text-app-fg prose-li:text-[#2c2520] dark:prose-li:text-app-fg/85 markdown-body">
                        <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                      </div>
                    ) : msg.text}
                  </div>
                </div>
              ))}
              {isSending && (
                <div className="flex justify-start">
                  <div className="px-3.5 py-2.5 bg-[#f5f0eb] dark:bg-app-raised rounded-2xl rounded-tl-sm">
                    <div className="flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] dark:bg-app-fg-subtle animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] dark:bg-app-fg-subtle animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#b5a99a] dark:bg-app-fg-subtle animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="flex-none px-4 py-3 border-t border-[#ede8e3] dark:border-app-border">
              <div className="flex items-center gap-2 border border-[#e8e2da] dark:border-app-border rounded-xl px-3.5 py-2.5 bg-white dark:bg-app-raised">
                <input
                  type="text"
                  placeholder={remaining > 0 ? 'Ask anything' : 'Limit reached'}
                  value={chatInput}
                  onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                  disabled={remaining <= 0}
                  className="flex-1 bg-transparent border-none outline-none text-[13px] text-[#1c1917] dark:text-app-fg placeholder:text-[#c4bab0] dark:placeholder:text-app-fg-subtle disabled:opacity-50"
                />
                <div className="flex items-center gap-1 flex-shrink-0">
                  <button className="p-1 text-[#c4bab0] dark:text-app-fg-subtle hover:text-[#7a6d62] dark:hover:text-app-fg-muted transition-colors">
                    <Paperclip className="w-4 h-4" />
                  </button>
                  <button className="p-1 text-[#c4bab0] dark:text-app-fg-subtle hover:text-[#7a6d62] dark:hover:text-app-fg-muted transition-colors">
                    <Mic className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Footer ── */}
      <footer className="border-t border-[#e8e2da]/40 dark:border-app-border bg-white/50 dark:bg-app-panel/50 py-6 hidden md:block">
        <div className="max-w-screen-xl mx-auto px-5 flex items-center justify-between">
          <WisprBranding />
          <a
            href="https://wisprnote.com"
            target="_blank"
            rel="noopener noreferrer"
            className="px-4 py-2 bg-[#1c1917] dark:bg-white text-white dark:text-[#1c1917] text-[12px] font-semibold rounded-full hover:bg-[#2c2520] dark:hover:bg-white/90 transition-colors"
          >
            Try Wisprnote
          </a>
        </div>
      </footer>
    </div>
  );
}
