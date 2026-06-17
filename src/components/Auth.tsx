import React, { useEffect, useState } from 'react';
import {
  signUp,
  signIn,
  confirmSignUp,
  getGoogleOAuthUrl,
  getMicrosoftOAuthUrl,
  exchangeCodeForSession,
  getWebOAuthRedirectUri,
  OAuthError,
  OAuthStaleCodeError,
} from '../services/awsAuthService';
import { motion, AnimatePresence } from 'motion/react';
import { User, Mail, Lock, Eye, EyeOff, Loader2, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';

/** Prevents duplicate /oauth2/token calls — codes are single-use; survives remounts (sign-out → sign-in cycle). */
const consumedOAuthCodes = new Set<string>();

export default function Auth() {
  const isTauri = typeof window !== 'undefined' && (
    !!(window as any).__TAURI_INTERNALS__ ||
    !!(window as any).__TAURI__ ||
    /tauri/i.test(navigator.userAgent)
  );
  const [loading, setLoading] = useState(false);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [isSignUp, setIsSignUp] = useState(false);
  const [needsConfirmation, setNeedsConfirmation] = useState(false);
  const [confirmationCode, setConfirmationCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<'name' | 'email' | 'password' | 'code' | null>(null);

  const desktopOAuthRedirect = 'https://www.wisprnote.com/auth/callback';

  // Web: exchange ?code= from Cognito redirect
  useEffect(() => {
    if (isTauri) return;
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    const oauthErr = params.get('error_description') || params.get('error');
    if (oauthErr) {
      setError(decodeURIComponent(oauthErr.replace(/\+/g, ' ')));
      window.history.replaceState({}, document.title, window.location.pathname);
      return;
    }
    if (!code || consumedOAuthCodes.has(code)) return;
    consumedOAuthCodes.add(code);
    let cancelled = false;
    setLoading(true);
    setError(null);
    setMessage(null);
    const redirectUri = getWebOAuthRedirectUri();
    (async () => {
      try {
        await exchangeCodeForSession(code, redirectUri);
        setMessage(null);
      } catch (e: any) {
        consumedOAuthCodes.delete(code);
        if (!cancelled && !(e instanceof OAuthStaleCodeError)) {
          setError(e instanceof OAuthError ? e.message : "Couldn't complete sign-in. Please try again.");
        }
      } finally {
        if (!cancelled) {
          setLoading(false);
          window.history.replaceState({}, document.title, window.location.pathname);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [isTauri]);

  // Desktop: deep-link OAuth callback
  useEffect(() => {
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    const consumeDeepLink = async (url: string) => {
      try {
        if (!url.startsWith('wisprnote://auth-callback')) return;
        const parsed = new URL(url);
        const code = parsed.searchParams.get('code');
        const err = parsed.searchParams.get('error_description') || parsed.searchParams.get('error');
        if (err) { setError(decodeURIComponent(err)); return; }
        if (!code || consumedOAuthCodes.has(code)) return;
        consumedOAuthCodes.add(code);
        setLoading(true);
        await exchangeCodeForSession(code, desktopOAuthRedirect);
        setMessage(null);
      } catch (e: any) {
        if (!(e instanceof OAuthStaleCodeError)) {
          setError(e instanceof OAuthError ? e.message : "Couldn't complete sign-in. Please try again.");
        }
      } finally {
        setLoading(false);
      }
    };
    (async () => {
      const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
      const current = await getCurrent();
      if (current?.length) for (const u of current) await consumeDeepLink(u);
      unlisten = await onOpenUrl(async (urls) => { for (const u of urls) await consumeDeepLink(u); });
    })().catch((e) => { setError((e as Error)?.message || 'Unable to initialize deep link listener'); });
    return () => { if (unlisten) unlisten(); };
  }, [isTauri]);

  const handleGoogleAuth = async () => {
    setLoading(true); setError(null); setMessage(null);
    try {
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(await getGoogleOAuthUrl(desktopOAuthRedirect));
        setMessage('Google sign-in opened in your browser. You will be returned automatically.');
        return;
      }
      window.location.href = await getGoogleOAuthUrl(getWebOAuthRedirectUri());
    } catch (err: any) {
      setError(err.message || 'Unable to continue with Google');
    } finally {
      setLoading(false);
    }
  };

  const handleMicrosoftAuth = async () => {
    setLoading(true); setError(null); setMessage(null);
    try {
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(await getMicrosoftOAuthUrl(desktopOAuthRedirect));
        setMessage('Microsoft sign-in opened in your browser. You will be returned automatically.');
        return;
      }
      window.location.href = await getMicrosoftOAuthUrl(getWebOAuthRedirectUri());
    } catch (err: any) {
      setError(err.message || 'Unable to continue with Microsoft');
    } finally {
      setLoading(false);
    }
  };

  const handleConfirmation = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true); setError(null);
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
    setLoading(true); setError(null); setMessage(null);
    try {
      if (isSignUp) {
        const result = await signUp(email, password, name.trim() || undefined);
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

  const switchMode = () => {
    setIsSignUp(v => !v);
    setError(null);
    setMessage(null);
    setName('');
    setPassword('');
    setShowPassword(false);
  };

  const inputBase = (field: typeof focusedField) =>
    `relative rounded-lg border transition-all duration-150 ${
      focusedField === field
        ? 'border-zinc-400 dark:border-zinc-500'
        : 'border-zinc-200 dark:border-zinc-700 hover:border-zinc-300 dark:hover:border-zinc-600'
    }`;

  // ── Email verification screen ──────────────────────────────────────────────
  if (needsConfirmation) {
    return (
      <div className="min-h-screen bg-[#f8f8f8] dark:bg-app-canvas flex items-center justify-center p-6">
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
          className="w-full max-w-[400px]"
        >
          <div className="bg-white dark:bg-app-panel rounded-2xl shadow-sm border border-zinc-200/80 dark:border-app-card-border p-8">
            <div className="mb-7">
              <h1 className="text-[22px] font-bold text-zinc-900 dark:text-app-fg mb-1.5">Verify your email</h1>
              <p className="text-[13.5px] text-zinc-500 dark:text-app-fg-muted">
                Enter the 6-digit code sent to <span className="font-medium text-zinc-700 dark:text-app-fg-muted">{email}</span>
              </p>
            </div>

            <form onSubmit={handleConfirmation} className="space-y-4">
              <AnimatePresence>
                {error && <AlertBanner message={error} />}
                {message && <SuccessBanner message={message} />}
              </AnimatePresence>

              <div>
                <label className="block text-[12.5px] font-semibold text-zinc-700 dark:text-app-fg mb-1">Verification Code</label>
                <div className={inputBase('code')}>
                  <input
                    type="text"
                    required
                    value={confirmationCode}
                    onChange={(e) => setConfirmationCode(e.target.value)}
                    onFocus={() => setFocusedField('code')}
                    onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent rounded-lg py-3 px-4 text-[16px] text-app-fg placeholder:text-zinc-400 focus:outline-none text-center tracking-[0.3em] font-mono"
                    placeholder="000000"
                    maxLength={6}
                  />
                </div>
              </div>

              <button
                type="submit"
                disabled={loading}
                className="w-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 py-3.5 rounded-lg text-[14px] font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 mt-2"
              >
                {loading ? <Loader2 size={16} className="animate-spin" /> : <><span>Verify & Sign In</span><ArrowRight size={15} /></>}
              </button>
            </form>
          </div>
        </motion.div>
      </div>
    );
  }

  // ── Main auth screen ───────────────────────────────────────────────────────
  return (
    <div className="min-h-screen bg-[#f8f8f8] dark:bg-app-canvas flex items-center justify-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[400px]"
      >
        {/* Logo + brand — outside the card */}
        <div className="flex items-center gap-2.5 mb-4 px-1">
          <img src="/logo.png" alt="Wisprnote" className="w-7 h-7 rounded-lg object-cover" />
          <span className="text-[15px] font-semibold text-zinc-800 dark:text-app-fg tracking-[-0.01em]">Wisprnote</span>
        </div>

        <div className="bg-white dark:bg-app-panel rounded-2xl shadow-sm border border-zinc-200/80 dark:border-app-card-border p-6">

          {/* Header */}
          <div className="mb-4">
            <h1 className="text-[19px] font-bold text-zinc-900 dark:text-app-fg mb-0.5">
              {isSignUp ? 'Create your account' : 'Welcome back'}
            </h1>
            <p className="text-[13.5px] text-zinc-500 dark:text-app-fg-muted">
              {isSignUp ? 'Start capturing and acting on every meeting.' : 'Sign in to continue to Wisprnote.'}
            </p>
          </div>

          <form onSubmit={handleAuth} className="space-y-3">
            <AnimatePresence>
              {error && <AlertBanner message={error} />}
              {message && <SuccessBanner message={message} />}
            </AnimatePresence>

            {/* Full Name — sign up only */}
            <AnimatePresence>
              {isSignUp && (
                <motion.div
                  key="name-field"
                  initial={{ opacity: 0, height: 0 }}
                  animate={{ opacity: 1, height: 'auto' }}
                  exit={{ opacity: 0, height: 0 }}
                  transition={{ duration: 0.2 }}
                  className="overflow-hidden"
                >
                  <div className="pb-0.5">
                    <label className="block text-[12.5px] font-semibold text-zinc-700 dark:text-app-fg mb-1">Full Name</label>
                    <div className={inputBase('name')}>
                      <User size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-app-fg-subtle" />
                      <input
                        type="text"
                        value={name}
                        onChange={(e) => setName(e.target.value)}
                        onFocus={() => setFocusedField('name')}
                        onBlur={() => setFocusedField(null)}
                        className="w-full bg-transparent rounded-lg py-2 pl-10 pr-4 text-[13.5px] text-zinc-900 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-app-fg-subtle focus:outline-none"
                        placeholder="Enter your full name"
                      />
                    </div>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Email */}
            <div>
              <label className="block text-[12.5px] font-semibold text-zinc-700 dark:text-app-fg mb-1">Email Address</label>
              <div className={inputBase('email')}>
                <Mail size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-app-fg-subtle" />
                <input
                  type="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  onFocus={() => setFocusedField('email')}
                  onBlur={() => setFocusedField(null)}
                  className="w-full bg-transparent rounded-lg py-2 pl-10 pr-4 text-[13.5px] text-zinc-900 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-app-fg-subtle focus:outline-none"
                  placeholder="Enter your email address"
                />
              </div>
            </div>

            {/* Password */}
            <div>
              <label className="block text-[12.5px] font-semibold text-zinc-700 dark:text-app-fg mb-1">Password</label>
              <div className={inputBase('password')}>
                <Lock size={15} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-zinc-400 dark:text-app-fg-subtle" />
                <input
                  type={showPassword ? 'text' : 'password'}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  onFocus={() => setFocusedField('password')}
                  onBlur={() => setFocusedField(null)}
                  className="w-full bg-transparent rounded-lg py-2 pl-10 pr-10 text-[13.5px] text-zinc-900 dark:text-app-fg placeholder:text-zinc-400 dark:placeholder:text-app-fg-subtle focus:outline-none"
                  placeholder={isSignUp ? 'Create a password' : 'Enter your password'}
                />
                <button
                  type="button"
                  tabIndex={-1}
                  onClick={() => setShowPassword(v => !v)}
                  className="absolute right-3.5 top-1/2 -translate-y-1/2 text-zinc-400 hover:text-zinc-600 dark:text-app-fg-subtle dark:hover:text-app-fg-muted transition-colors"
                >
                  {showPassword ? <EyeOff size={15} /> : <Eye size={15} />}
                </button>
              </div>
              {isSignUp && (
                <p className="text-[11.5px] text-zinc-400 dark:text-app-fg-subtle mt-1.5">
                  Use at least 8 characters with a mix of letters, numbers &amp; symbols
                </p>
              )}
            </div>

            {/* Primary CTA */}
            <button
              type="submit"
              disabled={loading}
              className="w-full bg-zinc-900 dark:bg-zinc-100 text-white dark:text-zinc-900 py-2.5 rounded-lg text-[13.5px] font-semibold hover:bg-zinc-800 dark:hover:bg-zinc-200 active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50 mt-0.5"
            >
              {loading
                ? <Loader2 size={16} className="animate-spin" />
                : <span>{isSignUp ? 'Create Account' : 'Sign In'}</span>
              }
            </button>
          </form>

          {/* Divider */}
          <div className="relative my-3">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-zinc-200 dark:border-zinc-700" />
            </div>
            <div className="relative flex justify-center">
              <span className="bg-white dark:bg-app-panel px-3 text-[12px] text-zinc-400 dark:text-app-fg-subtle">or</span>
            </div>
          </div>

          {/* Social buttons */}
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={handleGoogleAuth}
              disabled={loading}
              className="bg-white dark:bg-app-raised text-zinc-800 dark:text-app-fg py-2 rounded-lg text-[13px] font-medium border border-zinc-200 dark:border-app-border hover:bg-zinc-50 dark:hover:bg-app-chip active:scale-[0.98] transition-all flex items-center justify-center gap-2.5 disabled:opacity-50 shadow-sm"
            >
              <svg className="w-[17px] h-[17px] flex-shrink-0" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#4285F4" d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z"/>
                <path fill="#34A853" d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z"/>
                <path fill="#FBBC05" d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l3.66-2.84z"/>
                <path fill="#EA4335" d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z"/>
              </svg>
              Google
            </button>

            <button
              type="button"
              onClick={handleMicrosoftAuth}
              disabled={loading}
              className="bg-white dark:bg-app-raised text-zinc-800 dark:text-app-fg py-2 rounded-lg text-[13px] font-medium border border-zinc-200 dark:border-app-border hover:bg-zinc-50 dark:hover:bg-app-chip active:scale-[0.98] transition-all flex items-center justify-center gap-2.5 disabled:opacity-50 shadow-sm"
            >
              <svg className="w-[17px] h-[17px] flex-shrink-0" viewBox="0 0 21 21" aria-hidden="true">
                <rect x="1" y="1" width="9" height="9" fill="#F25022"/>
                <rect x="11" y="1" width="9" height="9" fill="#7FBA00"/>
                <rect x="1" y="11" width="9" height="9" fill="#00A4EF"/>
                <rect x="11" y="11" width="9" height="9" fill="#FFB900"/>
              </svg>
              Microsoft
            </button>
          </div>

          {/* Switch mode */}
          <p className="text-center text-[12.5px] text-zinc-500 dark:text-app-fg-subtle mt-3">
            {isSignUp ? (
              <>Already have an account?{' '}
                <button onClick={switchMode} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline">Sign In</button>
              </>
            ) : (
              <>Don&apos;t have an account?{' '}
                <button onClick={switchMode} className="font-semibold text-blue-600 dark:text-blue-400 hover:underline">Sign Up</button>
              </>
            )}
          </p>
        </div>

        <p className="text-center text-[11px] text-zinc-400 dark:text-app-fg-subtle/60 mt-6">
          © 2026 Wisprnote ·{' '}
          <a href="#" className="hover:text-zinc-600 dark:hover:text-app-fg-subtle transition-colors">Privacy</a>
          {' · '}
          <a href="#" className="hover:text-zinc-600 dark:hover:text-app-fg-subtle transition-colors">Terms</a>
        </p>
      </motion.div>
    </div>
  );
}

function AlertBanner({ message }: { message: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="bg-red-50 dark:bg-red-950/30 border border-red-200/60 dark:border-red-900/50 rounded-lg px-3.5 py-3 flex items-start gap-2.5">
        <AlertCircle size={14} className="text-red-400 mt-0.5 flex-shrink-0" />
        <p className="text-[12.5px] text-red-600 dark:text-red-400/90 leading-relaxed">{message}</p>
      </div>
    </motion.div>
  );
}

function SuccessBanner({ message }: { message: string }) {
  return (
    <motion.div
      initial={{ opacity: 0, height: 0 }}
      animate={{ opacity: 1, height: 'auto' }}
      exit={{ opacity: 0, height: 0 }}
      className="overflow-hidden"
    >
      <div className="bg-green-50 dark:bg-emerald-950/25 border border-green-200/60 dark:border-emerald-900/40 rounded-lg px-3.5 py-3 flex items-start gap-2.5">
        <CheckCircle2 size={14} className="text-green-600 dark:text-emerald-400 mt-0.5 flex-shrink-0" />
        <p className="text-[12.5px] text-green-700 dark:text-emerald-400/90 leading-relaxed">{message}</p>
      </div>
    </motion.div>
  );
}
