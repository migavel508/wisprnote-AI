import { useState, useEffect, useRef } from 'react';
import { useLocation } from 'react-router-dom';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Sparkles, Send, Loader2, Lock, AlertCircle, Clock, X, Mic,
  Paperclip, Calendar, User,
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

const BRAND_FONT = '"Etna Sans Serif", "Inter", system-ui, sans-serif';

/*
 * Force-reset ALL theme CSS vars to light-mode values so system/app dark
 * mode never leaks into this public shared page.
 */
const FORCE_LIGHT: React.CSSProperties = {
  colorScheme: 'light',
  // @ts-expect-error -- custom CSS properties
  '--color-app-canvas': '#e5ddd4',
  '--color-app-panel': '#ffffff',
  '--color-app-raised': '#fafaf9',
  '--color-app-chip': '#ffffff',
  '--color-app-border': 'rgb(216 206 195 / 0.65)',
  '--color-app-border-strong': '#d5cbc0',
  '--color-app-card-border': 'rgb(26 26 26 / 0.06)',
  '--color-app-fg': '#1a1a1a',
  '--color-app-fg-muted': '#7a726a',
  '--color-app-fg-subtle': '#9a918a',
  '--color-app-fg-label': '#a09890',
  '--color-app-divider': 'rgb(206 196 184 / 0.55)',
  color: '#1a1a1a',
  backgroundColor: '#faf8f5',
};

function BrandMark({ size = 'md' }: { size?: 'sm' | 'md' }) {
  const imgSize = size === 'sm' ? 'w-5 h-5' : 'w-7 h-7';
  const textSize = size === 'sm' ? 'text-[14px]' : 'text-[17px]';
  return (
    <div className="flex items-center gap-2">
      <img src="/logo_status.png" alt="Wisprnote AI" className={`${imgSize} rounded-lg object-cover`} />
      <span className={`${textSize} font-bold tracking-[0.02em] text-[#1c1917]`} style={{ fontFamily: BRAND_FONT }}>
        Wisprnote AI
      </span>
    </div>
  );
}

function PoweredBy({ className = '' }: { className?: string }) {
  return (
    <div className={`flex items-center justify-center gap-1.5 ${className}`}>
      <span className="text-[11px] text-[#b5a99a]">Powered by</span>
      <span className="text-[11px] font-bold text-[#2c2520]" style={{ fontFamily: BRAND_FONT }}>Wisprnote AI</span>
      <span className="text-rose-400 text-[11px]">♥</span>
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

  useEffect(() => { if (shareToken) verifyAccess(); }, [shareToken]);

  async function verifyAccess() {
    setState({ status: 'loading' });
    try {
      const session = await getSession();
      const viewerEmail = session?.user?.email ?? null;
      const result = await verifyShareAccess(shareToken, viewerEmail);
      if ('denied' in result) {
        setState(result.reason === 'sign_in_required' ? { status: 'sign_in' } : { status: 'denied', denyReason: result.reason });
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
      if ('error' in result) { setSignInError(String(result.error)); return; }
      await verifyAccess();
    } catch { setSignInError('Sign in failed. Please try again.'); }
    finally { setSignInLoading(false); }
  }

  async function handleSendChat() {
    if (!chatInput.trim() || isSending || !state.meeting || remaining <= 0) return;
    const msg = chatInput.trim();
    setChatInput('');
    setChatMessages(prev => [...prev, { role: 'user', text: msg }]);
    setIsSending(true);
    try {
      const { reply, remaining: rem } = await sendSharedChatMessage(shareToken, msg, {
        notes: state.meeting.notes, summary: state.meeting.summary, filename: state.meeting.filename,
      });
      setChatMessages(prev => [...prev, { role: 'model', text: reply }]);
      setRemaining(rem);
    } catch (err: any) {
      const text = err?.message === 'RATE_LIMITED'
        ? 'You have reached the message limit for this shared session.'
        : 'Sorry, something went wrong. Please try again.';
      setChatMessages(prev => [...prev, { role: 'model', text }]);
      if (err?.message === 'RATE_LIMITED') setRemaining(0);
    } finally { setIsSending(false); }
  }

  useEffect(() => { chatEndRef.current?.scrollIntoView({ behavior: 'smooth' }); }, [chatMessages]);

  const canChat = state.meeting?.permissions?.includes('chat');

  // ── Loading ──
  if (state.status === 'loading') {
    return (
      <div className="min-h-screen flex items-center justify-center" style={FORCE_LIGHT}>
        <div className="text-center">
          <Loader2 className="w-6 h-6 animate-spin text-[#d0c8bf] mx-auto mb-3" />
          <p className="text-[13px] text-[#b5a99a]">Loading shared meeting…</p>
        </div>
      </div>
    );
  }

  // ── Sign-in ──
  if (state.status === 'sign_in') {
    return (
      <div className="min-h-screen flex flex-col" style={FORCE_LIGHT}>
        <header className="px-6 py-4 border-b border-[#ece6de]/60"><BrandMark /></header>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-sm p-8 w-full max-w-sm border border-[#ece6de]/80">
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
              <input type="email" placeholder="Email address" value={signInEmail} onChange={e => setSignInEmail(e.target.value)} required
                className="w-full px-4 py-2.5 text-[13px] bg-[#f7f4f1] rounded-xl border-none outline-none text-[#1c1917] placeholder:text-[#c4bab0] focus:ring-2 focus:ring-[#d0c8bf]/50" />
              <input type="password" placeholder="Password" value={signInPassword} onChange={e => setSignInPassword(e.target.value)} required
                className="w-full px-4 py-2.5 text-[13px] bg-[#f7f4f1] rounded-xl border-none outline-none text-[#1c1917] placeholder:text-[#c4bab0] focus:ring-2 focus:ring-[#d0c8bf]/50" />
              {signInError && <p className="text-[11px] text-red-500 font-medium">{signInError}</p>}
              <button type="submit" disabled={signInLoading}
                className="w-full py-2.5 bg-[#1c1917] text-white text-[13px] font-semibold rounded-xl hover:bg-[#2c2520] disabled:opacity-50 transition-all flex items-center justify-center gap-2">
                {signInLoading && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Sign in
              </button>
            </form>
            <PoweredBy className="mt-6 pt-4 border-t border-[#ece6de]/60" />
          </div>
        </div>
      </div>
    );
  }

  // ── Denied ──
  if (state.status === 'denied') {
    return (
      <div className="min-h-screen flex flex-col" style={FORCE_LIGHT}>
        <header className="px-6 py-4 border-b border-[#ece6de]/60"><BrandMark /></header>
        <div className="flex-1 flex items-center justify-center px-4">
          <div className="bg-white rounded-2xl shadow-sm p-8 w-full max-w-sm border border-[#ece6de]/80 text-center">
            <div className="w-12 h-12 rounded-xl bg-red-50 flex items-center justify-center mx-auto mb-4">
              <AlertCircle className="w-6 h-6 text-red-400" />
            </div>
            <h1 className="text-[16px] font-semibold text-[#1c1917] mb-2">Access Denied</h1>
            <p className="text-[13px] text-[#a89888] leading-relaxed">{state.denyReason}</p>
            <PoweredBy className="mt-6 pt-4 border-t border-[#ece6de]/60" />
          </div>
        </div>
      </div>
    );
  }

  // ── Ready ──
  const { meeting } = state;
  if (!meeting) return null;

  const fmtDuration = (s: number) => { if (!s) return ''; const m = Math.floor(s / 60); return m > 0 ? `${m} min` : `${s}s`; };
  const fmtDate = meeting.created_at ? new Date(meeting.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric' }) : null;

  const prose = `prose prose-sm max-w-none
    prose-headings:text-[#1c1917] prose-headings:tracking-tight prose-headings:font-semibold
    prose-h2:text-[15px] prose-h3:text-[14px]
    prose-p:text-[14px] prose-p:leading-[1.8] prose-p:text-[#2c2520]
    prose-li:text-[14px] prose-li:text-[#2c2520] prose-li:leading-[1.7]
    prose-strong:text-[#1c1917] prose-strong:font-semibold
    prose-blockquote:border-l-[#e8e2da] prose-blockquote:text-[#7a6d62]
    prose-td:text-[#2c2520] prose-th:text-[#1c1917]
    markdown-body`;

  return (
    <div className="min-h-screen flex flex-col" style={FORCE_LIGHT}>

      {/* ── Navbar — light, brand-colored ── */}
      <header className="bg-white border-b border-[#ece6de]/80 sticky top-0 z-20 flex-none">
        <div className="max-w-screen-xl mx-auto px-5 sm:px-8 py-3 flex items-center justify-between">
          <BrandMark />
          <div className="flex items-center gap-3">
            <a href="https://wisprnote.com" target="_blank" rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-4 py-1.5 bg-[#1c1917] text-white text-[12px] font-semibold rounded-full hover:bg-[#2c2520] transition-colors">
              <img src="/logo_status.png" alt="" className="w-3.5 h-3.5 rounded-sm" />
              <span className="hidden sm:inline">Open in Wisprnote</span>
              <span className="sm:hidden">Download</span>
            </a>
            <span className="hidden sm:inline text-[13px] text-[#9a8d7f] hover:text-[#1c1917] cursor-pointer transition-colors">Sign in</span>
          </div>
        </div>
      </header>

      {/* ── Two-column body ── */}
      <div className="flex-1 flex max-w-screen-xl mx-auto w-full">

        {/* ── Left: content ── */}
        <main className="flex-1 min-w-0 overflow-y-auto">
          <div className="max-w-2xl mx-auto px-5 sm:px-10 pt-12 sm:pt-16 pb-28">

            {/* Title */}
            <h1 className="text-[30px] sm:text-[40px] font-bold tracking-[-0.025em] text-[#1c1917] leading-[1.12] mb-5"
              style={{ fontFamily: '"Cormorant Garamond", Georgia, serif', fontStyle: 'italic' }}>
              {meeting.filename}
            </h1>

            {/* Meta pills */}
            <div className="flex items-center gap-3 mb-10 flex-wrap">
              <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f0ece7] rounded-full">
                <User className="w-3 h-3 text-[#9a8d7f]" />
                <span className="text-[11px] text-[#5c5147] font-medium">Shared</span>
              </div>
              {fmtDate && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f0ece7] rounded-full">
                  <Calendar className="w-3 h-3 text-[#9a8d7f]" />
                  <span className="text-[11px] text-[#5c5147]">{fmtDate}</span>
                </div>
              )}
              {meeting.duration > 0 && (
                <div className="flex items-center gap-1.5 px-2.5 py-1 bg-[#f0ece7] rounded-full">
                  <Clock className="w-3 h-3 text-[#9a8d7f]" />
                  <span className="text-[11px] text-[#5c5147]">{fmtDuration(meeting.duration)}</span>
                </div>
              )}
            </div>

            {/* Content */}
            <AnimatePresence mode="wait">
              <motion.div key={tab} initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} transition={{ duration: 0.18 }}>
                <div className={prose} style={{ color: '#2c2520' }}>
                  <Markdown remarkPlugins={[remarkGfm]}>
                    {tab === 'summary' ? (meeting.summary || 'No summary available.') : (meeting.notes || 'No notes available.')}
                  </Markdown>
                </div>
              </motion.div>
            </AnimatePresence>

            {/* Tab pills */}
            <div className="flex gap-1.5 mt-12">
              {(['summary', 'notes'] as SharedTab[]).map(t => (
                <button key={t} onClick={() => setTab(t)}
                  className={`px-4 py-1.5 rounded-full text-[12px] font-medium transition-all border ${
                    tab === t
                      ? 'bg-[#1c1917] text-white border-transparent shadow-sm'
                      : 'text-[#9a8d7f] border-[#e8e2da] hover:text-[#5c5147] hover:border-[#d0c8bf]'
                  }`}>
                  {t.charAt(0).toUpperCase() + t.slice(1)}
                </button>
              ))}
            </div>

            <PoweredBy className="md:hidden mt-14 mb-2" />
          </div>
        </main>

        {/* ── Right: chat sidebar (desktop) ── */}
        {canChat && (
          <aside className="hidden md:flex flex-col w-[280px] lg:w-[320px] flex-none border-l border-[#ece6de] bg-white sticky top-[49px] h-[calc(100vh-49px)]">

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-0">
              {chatMessages.length === 0 && <div className="h-full" />}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[90%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
                    msg.role === 'user'
                      ? 'bg-[#1c1917] text-white rounded-tr-sm'
                      : 'bg-[#f5f0eb] text-[#2c2520] rounded-tl-sm'
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
                  <div className="px-3.5 py-2.5 bg-[#f5f0eb] rounded-2xl rounded-tl-sm">
                    <div className="flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#c4bab0] animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#c4bab0] animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#c4bab0] animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="flex-none px-4 pb-4 pt-2">
              <div className="flex items-center gap-2 border border-[#e8e2da] rounded-xl px-3.5 py-2.5 bg-white hover:border-[#d0c8bf] focus-within:border-[#c4bab0] focus-within:ring-1 focus-within:ring-[#e8e2da] transition-all">
                <input ref={inputRef} type="text"
                  placeholder={remaining > 0 ? 'Ask anything' : 'Limit reached'}
                  value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                  disabled={remaining <= 0}
                  className="flex-1 bg-transparent border-none outline-none text-[13px] text-[#1c1917] placeholder:text-[#c4bab0] disabled:opacity-50" />
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button className="p-1.5 text-[#c4bab0] hover:text-[#9a8d7f] rounded-lg hover:bg-[#f7f4f1] transition-all" title="Attach">
                    <Paperclip className="w-[15px] h-[15px]" />
                  </button>
                  <button className="p-1.5 text-[#c4bab0] hover:text-[#9a8d7f] rounded-lg hover:bg-[#f7f4f1] transition-all" title="Voice">
                    <Mic className="w-[15px] h-[15px]" />
                  </button>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* ── Floating "Chat with AI" pill (mobile) ── */}
      {canChat && !mobileChatOpen && (
        <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-30 md:hidden">
          <button onClick={() => { setMobileChatOpen(true); setTimeout(() => inputRef.current?.focus(), 150); }}
            className="flex items-center gap-2 px-5 py-2.5 bg-white text-[#1c1917] rounded-full shadow-lg border border-[#ece6de] hover:shadow-xl hover:border-[#d0c8bf] transition-all text-[13px] font-medium">
            <Sparkles className="w-3.5 h-3.5 text-[#1c1917]" />
            Chat with AI about this meeting…
          </button>
        </div>
      )}

      {/* ── Mobile chat drawer ── */}
      <AnimatePresence>
        {mobileChatOpen && (
          <motion.div
            initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }}
            transition={{ type: 'spring', stiffness: 320, damping: 32 }}
            className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white border-t border-[#ece6de] shadow-2xl rounded-t-2xl flex flex-col"
            style={{ maxHeight: '65vh', ...FORCE_LIGHT, backgroundColor: '#ffffff' }}>

            {/* Handle + header */}
            <div className="flex-none pt-2 pb-0">
              <div className="w-8 h-1 rounded-full bg-[#e8e2da] mx-auto mb-2" />
              <div className="flex items-center justify-between px-5 py-2 border-b border-[#ece6de]">
                <BrandMark size="sm" />
                <div className="flex items-center gap-2.5">
                  <span className="text-[10px] text-[#b5a99a]">{remaining} left</span>
                  <button onClick={() => setMobileChatOpen(false)}
                    className="w-6 h-6 rounded-full bg-[#f5f0eb] flex items-center justify-center text-[#9a8d7f] hover:bg-[#ede8e3] transition-colors">
                    <X className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            </div>

            {/* Messages */}
            <div className="flex-1 overflow-y-auto px-4 py-4 space-y-3 min-h-[80px]">
              {chatMessages.length === 0 && (
                <p className="text-[13px] text-[#b5a99a] text-center py-6">Ask anything about this meeting…</p>
              )}
              {chatMessages.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-3.5 py-2.5 rounded-2xl text-[13px] leading-relaxed ${
                    msg.role === 'user' ? 'bg-[#1c1917] text-white rounded-tr-sm' : 'bg-[#f5f0eb] text-[#2c2520] rounded-tl-sm'
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
                  <div className="px-3.5 py-2.5 bg-[#f5f0eb] rounded-2xl rounded-tl-sm">
                    <div className="flex gap-1 items-center">
                      <span className="w-1.5 h-1.5 rounded-full bg-[#c4bab0] animate-bounce [animation-delay:0ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#c4bab0] animate-bounce [animation-delay:150ms]" />
                      <span className="w-1.5 h-1.5 rounded-full bg-[#c4bab0] animate-bounce [animation-delay:300ms]" />
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            {/* Input */}
            <div className="flex-none px-4 py-3 border-t border-[#ece6de]">
              <div className="flex items-center gap-2 border border-[#e8e2da] rounded-xl px-3.5 py-2.5">
                <input type="text" placeholder={remaining > 0 ? 'Ask anything' : 'Limit reached'}
                  value={chatInput} onChange={e => setChatInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSendChat(); } }}
                  disabled={remaining <= 0}
                  className="flex-1 bg-transparent border-none outline-none text-[13px] text-[#1c1917] placeholder:text-[#c4bab0] disabled:opacity-50" />
                <div className="flex items-center gap-0.5 flex-shrink-0">
                  <button className="p-1.5 text-[#c4bab0] hover:text-[#9a8d7f] rounded-lg hover:bg-[#f7f4f1] transition-all">
                    <Paperclip className="w-[15px] h-[15px]" />
                  </button>
                  <button className="p-1.5 text-[#c4bab0] hover:text-[#9a8d7f] rounded-lg hover:bg-[#f7f4f1] transition-all">
                    <Mic className="w-[15px] h-[15px]" />
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Footer ── */}
      <footer className="border-t border-[#ece6de]/60 bg-white py-5">
        <div className="max-w-screen-xl mx-auto px-5 sm:px-8 flex items-center justify-between">
          <PoweredBy />
          <a href="https://wisprnote.com" target="_blank" rel="noopener noreferrer"
            className="px-4 py-2 bg-[#1c1917] text-white text-[12px] font-semibold rounded-full hover:bg-[#2c2520] transition-colors">
            Try Wisprnote
          </a>
        </div>
      </footer>
    </div>
  );
}
