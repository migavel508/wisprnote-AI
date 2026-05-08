import React, { useEffect, useState } from 'react';
import {
  signUp,
  signIn,
  confirmSignUp,
  getGoogleOAuthUrl,
  exchangeCodeForSession,
} from '../services/awsAuthService';
import { motion, AnimatePresence } from 'motion/react';
import { Mail, Lock, Loader2, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function Auth() {
  const isTauri = typeof window !== 'undefined' && (
    !!(window as any).__TAURI_INTERNALS__ ||
    !!(window as any).__TAURI__ ||
    /tauri/i.test(navigator.userAgent)
  );
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | 'code' | null>(null);
  const desktopOAuthRedirect = 'wisprnote://auth-callback/';

  useEffect(() => {
    if (!isTauri) return;

    let unlisten: (() => void) | undefined;

    const consumeDeepLink = async (url: string) => {
      try {
        if (!url.startsWith('wisprnote://auth-callback')) return;
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const err = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');

        if (err) {
          setError(decodeURIComponent(err));
          return;
        }

        if (!code) return;
        setLoading(true);
        await exchangeCodeForSession(code, desktopOAuthRedirect);
        setMessage(null);
      } catch (e: any) {
        setError(e?.message || 'Google sign-in callback failed');
      } finally {
        setLoading(false);
      }
    };

    (async () => {
      const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
      const current = await getCurrent();
      if (current?.length) {
        for (const u of current) await consumeDeepLink(u);
      }
      unlisten = await onOpenUrl(async (urls) => {
        for (const u of urls) await consumeDeepLink(u);
      });
    })().catch((e) => {
      setError((e as Error)?.message || 'Unable to initialize deep link listener');
    });

    return () => {
      if (unlisten) unlisten();
    };
  }, [isTauri]);

  const handleGoogleAuth = async () => {
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-shell');
        const oauthUrl = getGoogleOAuthUrl(desktopOAuthRedirect);
        await open(oauthUrl);
        setMessage('Google sign-in opened in your browser. After selecting account, you will be returned to the app automatically.');
        return;
      }

      const oauthUrl = getGoogleOAuthUrl(window.location.origin);
      window.location.href = oauthUrl;
    } catch (err: any) {
      setError(err.message || 'Unable to continue with Google');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmation = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);

    try {
      await confirmSignUp(email, confirmationCode);
      setMessage('Email confirmed! Signing you in...');
      setNeedsConfirmation(false);
      await signIn(email, password);
    } catch (err: any) {
      setError(err.message || 'Confirmation failed');
    } finally {
      setLoading(false);
    }
  };

  const handleAuth = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setMessage(null);

    try {
      if (isSignUp) {
        const result = await signUp(email, password);
        if (result.confirmationRequired) {
          setNeedsConfirmation(true);
          setMessage('Check your email for the verification code!');
        }
      } else {
        await signIn(email, password);
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during authentication');
    } finally {
      setLoading(false);
    }
  };

  if (needsConfirmation) {
    return (
      <div className="min-h-screen bg-app-canvas text-app-fg flex items-center justify-center p-6 font-[system-ui]">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[400px]"
        >
          <div className="text-center mb-10">
            <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-app-panel shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.35)] border border-app-card-border mb-5">
              <img src="/logo.png" alt="Logo" className="w-7 h-7 rounded-lg object-cover" />
            </div>
            <h1 className="text-[32px] font-serif italic text-app-fg/25 dark:text-app-fg/40 leading-tight mb-2">
              Verify Email
            </h1>
            <p className="text-[13px] text-app-fg/35 dark:text-app-fg/45">
              Enter the code sent to {email}
            </p>
          </div>

          <motion.div className="bg-app-panel rounded-2xl shadow-[0_2px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_24px_rgba(0,0,0,0.4)] border border-app-card-border p-7">
            <form onSubmit={handleConfirmation} className="space-y-5">
              <AnimatePresence>
                {error && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="bg-red-50/80 dark:bg-red-950/30 border border-red-200/50 dark:border-red-900/50 rounded-xl px-4 py-3 flex items-start gap-2.5">
                      <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                      <p className="text-[12px] text-red-600 dark:text-red-400/90 leading-relaxed">{error}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <AnimatePresence>
                {message && (
                  <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }} className="overflow-hidden">
                    <div className="bg-green-50/80 dark:bg-emerald-950/25 border border-green-200/50 dark:border-emerald-900/40 rounded-xl px-4 py-3 flex items-start gap-2.5">
                      <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
                      <p className="text-[12px] text-green-700 dark:text-emerald-400/90 leading-relaxed">{message}</p>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              <div>
                <label className="text-[11px] font-medium text-app-fg-muted ml-0.5 mb-1.5 block">Verification Code</label>
                <div className={`relative rounded-xl border transition-all duration-200 ${
                  focusedField === 'code'
                    ? 'border-zinc-400 dark:border-zinc-500 shadow-[0_0_0_3px_rgba(26,26,26,0.04)] dark:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]'
                    : 'border-zinc-200/90 dark:border-zinc-600/80 hover:border-zinc-300 dark:hover:border-zinc-500'
                }`}>
                  <input
                    type="text"
                    required
                    value={confirmationCode}
                    onChange={(e) => setConfirmationCode(e.target.value)}
                    onFocus={() => setFocusedField('code')}
                    onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent rounded-xl py-3 px-4 text-[14px] text-app-fg placeholder:text-app-fg-subtle focus:outline-none text-center tracking-widest"
                    placeholder="000000"
                    maxLength={6}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 py-3 rounded-xl text-[13px] font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
              >
                {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <>Verify & Sign In<ArrowRight className="w-3.5 h-3.5" /></>}
              </button>
            </form>
          </motion.div>
        </motion.div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-app-canvas text-app-fg flex items-center justify-center p-6 font-[system-ui]">
      <motion.div 
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[400px]"
      >
        <motion.div 
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-app-panel shadow-[0_2px_16px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_16px_rgba(0,0,0,0.35)] border border-app-card-border mb-5">
            <img src="/logo.png" alt="Logo" className="w-7 h-7 rounded-lg object-cover" />
          </div>
          <h1 className="text-[32px] font-serif italic text-app-fg/25 dark:text-app-fg/40 leading-tight mb-2">
            Wisprnote
          </h1>
          <p className="text-[13px] text-app-fg/35 dark:text-app-fg/45">
            {isSignUp ? 'Create your account to get started' : 'Welcome back'}
          </p>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="bg-app-panel rounded-2xl shadow-[0_2px_24px_rgba(0,0,0,0.06)] dark:shadow-[0_2px_24px_rgba(0,0,0,0.4)] border border-app-card-border p-7"
        >
          <form onSubmit={handleAuth} className="space-y-5">
            <AnimatePresence>
              {error && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginBottom: 4 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden"
                >
                  <div className="bg-red-50/80 dark:bg-red-950/30 border border-red-200/50 dark:border-red-900/50 rounded-xl px-4 py-3 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 dark:text-red-400 mt-0.5 flex-shrink-0" />
                    <p className="text-[12px] text-red-600 dark:text-red-400/90 leading-relaxed">{error}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <AnimatePresence>
              {message && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginBottom: 4 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden"
                >
                  <div className="bg-green-50/80 dark:bg-emerald-950/25 border border-green-200/50 dark:border-emerald-900/40 rounded-xl px-4 py-3 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-green-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
                    <p className="text-[12px] text-green-700 dark:text-emerald-400/90 leading-relaxed">{message}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-3.5">
              <div>
                <label className="text-[11px] font-medium text-app-fg-muted ml-0.5 mb-1.5 block">
                  Email
                </label>
                <div className={`relative rounded-xl border transition-all duration-200 ${
                  focusedField === 'email' 
                    ? 'border-zinc-400 dark:border-zinc-500 shadow-[0_0_0_3px_rgba(26,26,26,0.04)] dark:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]' 
                    : 'border-zinc-200/90 dark:border-zinc-600/80 hover:border-zinc-300 dark:hover:border-zinc-500'
                }`}>
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-app-fg-subtle" />
                  <input 
                    type="email" 
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setFocusedField('email')}
                    onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent rounded-xl py-3 pl-10 pr-4 text-[14px] text-app-fg placeholder:text-app-fg-subtle focus:outline-none"
                    placeholder="name@company.com"
                  />
                </div>
              </div>

              <div>
                <label className="text-[11px] font-medium text-app-fg-muted ml-0.5 mb-1.5 block">
                  Password
                </label>
                <div className={`relative rounded-xl border transition-all duration-200 ${
                  focusedField === 'password' 
                    ? 'border-zinc-400 dark:border-zinc-500 shadow-[0_0_0_3px_rgba(26,26,26,0.04)] dark:shadow-[0_0_0_3px_rgba(255,255,255,0.06)]' 
                    : 'border-zinc-200/90 dark:border-zinc-600/80 hover:border-zinc-300 dark:hover:border-zinc-500'
                }`}>
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-app-fg-subtle" />
                  <input 
                    type="password" 
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField('password')}
                    onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent rounded-xl py-3 pl-10 pr-4 text-[14px] text-app-fg placeholder:text-app-fg-subtle focus:outline-none"
                    placeholder="Enter your password"
                  />
                </div>
              </div>
            </div>

            <button
              type="button"
              onClick={handleGoogleAuth}
              disabled={loading}
              className="w-full bg-zinc-50 dark:bg-app-raised text-app-fg py-3 rounded-xl text-[13px] font-semibold border border-zinc-200/80 dark:border-app-border hover:bg-zinc-100 dark:hover:bg-app-chip active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.2.8 3.9 1.5l2.7-2.6C17 3.4 14.7 2.4 12 2.4 6.9 2.4 2.7 6.6 2.7 11.7S6.9 21 12 21c6.9 0 8.6-4.8 8.6-7.3 0-.5 0-.9-.1-1.3H12z"/>
              </svg>
              Continue with Google
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-zinc-200/80 dark:border-zinc-600/60" />
              </div>
              <div className="relative flex justify-center text-[11px]">
                <span className="bg-app-panel px-2 text-app-fg-subtle">or</span>
              </div>
            </div>

            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 py-3 rounded-xl text-[13px] font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  {isSignUp ? 'Create Account' : 'Sign In'}
                  <ArrowRight className="w-3.5 h-3.5" />
                </>
              )}
            </button>
          </form>

          <div className="mt-6 pt-5 border-t border-app-card-border text-center">
            <button 
              onClick={() => { setIsSignUp(!isSignUp); setError(null); setMessage(null); }}
              className="text-[12px] text-app-fg-subtle hover:text-app-fg-muted transition-colors"
            >
              {isSignUp ? (
                <>Already have an account? <span className="font-medium text-app-fg-muted">Sign In</span></>
              ) : (
                <>Don't have an account? <span className="font-medium text-app-fg-muted">Sign Up</span></>
              )}
            </button>
          </div>
        </motion.div>

        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="mt-8 flex justify-between items-center px-1"
        >
          <p className="text-[11px] text-app-fg-subtle/60">© 2026 Wisprnote</p>
          <div className="flex gap-4">
            <a href="#" className="text-[11px] text-app-fg-subtle/60 hover:text-app-fg-muted transition-colors">Privacy</a>
            <a href="#" className="text-[11px] text-app-fg-subtle/60 hover:text-app-fg-muted transition-colors">Terms</a>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
