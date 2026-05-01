import React, { useEffect, useState } from 'react';
import { supabase } from '../services/supabaseService';
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
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | null>(null);
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
        const { error } = await supabase.auth.exchangeCodeForSession(code);
        if (error) throw error;
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
        const { data, error } = await supabase.auth.signInWithOAuth({
          provider: 'google',
          options: {
            redirectTo: desktopOAuthRedirect,
            skipBrowserRedirect: true,
            queryParams: {
              prompt: 'select_account',
            },
          },
        });
        if (error) throw error;
        if (!data?.url) throw new Error('OAuth URL not returned');

        await open(data.url);
        setMessage('Google sign-in opened in your browser. After selecting account, you will be returned to the app automatically.');
        return;
      }

      const { error } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo: window.location.origin,
          queryParams: {
            prompt: 'select_account',
          },
        },
      });
      if (error) throw error;
    } catch (err: any) {
      setError(err.message || 'Unable to continue with Google');
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
        const { error } = await supabase.auth.signUp({
          email,
          password,
        });
        if (error) throw error;
        setMessage('Check your email for the confirmation link!');
      } else {
        const { error } = await supabase.auth.signInWithPassword({
          email,
          password,
        });
        if (error) throw error;
      }
    } catch (err: any) {
      setError(err.message || 'An error occurred during authentication');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen bg-[#e5ddd4] flex items-center justify-center p-6 font-[system-ui]">
      <motion.div 
        initial={{ opacity: 0, y: 16 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.6, ease: [0.22, 1, 0.36, 1] }}
        className="w-full max-w-[400px]"
      >
        {/* Logo + Title */}
        <motion.div 
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.1, ease: [0.22, 1, 0.36, 1] }}
          className="text-center mb-10"
        >
          <div className="inline-flex items-center justify-center w-12 h-12 rounded-2xl bg-white shadow-[0_2px_16px_rgba(0,0,0,0.06)] border border-[#1a1a1a]/[0.04] mb-5">
            <img src="/logo.png" alt="Logo" className="w-7 h-7 rounded-lg object-cover" />
          </div>
          <h1 className="text-[32px] font-serif italic text-[#141414]/25 leading-tight mb-2">
            Wisprnote
          </h1>
          <p className="text-[13px] text-[#141414]/30">
            {isSignUp ? 'Create your account to get started' : 'Welcome back'}
          </p>
        </motion.div>

        {/* Card */}
        <motion.div 
          initial={{ opacity: 0, y: 12 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5, delay: 0.2, ease: [0.22, 1, 0.36, 1] }}
          className="bg-white rounded-[20px] shadow-[0_2px_24px_rgba(0,0,0,0.06)] border border-[#1a1a1a]/[0.04] p-7"
        >
          <form onSubmit={handleAuth} className="space-y-5">
            {/* Error */}
            <AnimatePresence>
              {error && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginBottom: 4 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden"
                >
                  <div className="bg-red-50/80 border border-red-200/50 rounded-xl px-4 py-3 flex items-start gap-2.5">
                    <AlertCircle className="w-4 h-4 text-red-400 mt-0.5 flex-shrink-0" />
                    <p className="text-[12px] text-red-500/80 leading-relaxed">{error}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            {/* Success */}
            <AnimatePresence>
              {message && (
                <motion.div 
                  initial={{ opacity: 0, height: 0, marginBottom: 0 }}
                  animate={{ opacity: 1, height: 'auto', marginBottom: 4 }}
                  exit={{ opacity: 0, height: 0, marginBottom: 0 }}
                  className="overflow-hidden"
                >
                  <div className="bg-green-50/80 border border-green-200/50 rounded-xl px-4 py-3 flex items-start gap-2.5">
                    <CheckCircle2 className="w-4 h-4 text-green-500 mt-0.5 flex-shrink-0" />
                    <p className="text-[12px] text-green-600/80 leading-relaxed">{message}</p>
                  </div>
                </motion.div>
              )}
            </AnimatePresence>

            <div className="space-y-3.5">
              {/* Email */}
              <div>
                <label className="text-[11px] font-medium text-[#1a1a1a]/35 ml-0.5 mb-1.5 block">
                  Email
                </label>
                <div className={`relative rounded-xl border transition-all duration-200 ${
                  focusedField === 'email' 
                    ? 'border-[#1a1a1a]/15 shadow-[0_0_0_3px_rgba(26,26,26,0.04)]' 
                    : 'border-[#1a1a1a]/[0.07] hover:border-[#1a1a1a]/12'
                }`}>
                  <Mail className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-[#1a1a1a]/20" />
                  <input 
                    type="email" 
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    onFocus={() => setFocusedField('email')}
                    onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent rounded-xl py-3 pl-10 pr-4 text-[14px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/20 focus:outline-none"
                    placeholder="name@company.com"
                  />
                </div>
              </div>

              {/* Password */}
              <div>
                <label className="text-[11px] font-medium text-[#1a1a1a]/35 ml-0.5 mb-1.5 block">
                  Password
                </label>
                <div className={`relative rounded-xl border transition-all duration-200 ${
                  focusedField === 'password' 
                    ? 'border-[#1a1a1a]/15 shadow-[0_0_0_3px_rgba(26,26,26,0.04)]' 
                    : 'border-[#1a1a1a]/[0.07] hover:border-[#1a1a1a]/12'
                }`}>
                  <Lock className="absolute left-3.5 top-1/2 -translate-y-1/2 w-[15px] h-[15px] text-[#1a1a1a]/20" />
                  <input 
                    type="password" 
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    onFocus={() => setFocusedField('password')}
                    onBlur={() => setFocusedField(null)}
                    className="w-full bg-transparent rounded-xl py-3 pl-10 pr-4 text-[14px] text-[#1a1a1a] placeholder:text-[#1a1a1a]/20 focus:outline-none"
                    placeholder="Enter your password"
                  />
                </div>
              </div>
            </div>

            {/* Google OAuth */}
            <button
              type="button"
              onClick={handleGoogleAuth}
              disabled={loading}
              className="w-full bg-white text-[#1a1a1a] py-3 rounded-xl text-[13px] font-semibold border border-[#1a1a1a]/10 hover:bg-[#fafafa] active:scale-[0.98] transition-all flex items-center justify-center gap-2 disabled:opacity-50"
            >
              <svg className="w-4 h-4" viewBox="0 0 24 24" aria-hidden="true">
                <path fill="#EA4335" d="M12 10.2v3.9h5.5c-.2 1.3-1.5 3.9-5.5 3.9-3.3 0-6-2.7-6-6s2.7-6 6-6c1.9 0 3.2.8 3.9 1.5l2.7-2.6C17 3.4 14.7 2.4 12 2.4 6.9 2.4 2.7 6.6 2.7 11.7S6.9 21 12 21c6.9 0 8.6-4.8 8.6-7.3 0-.5 0-.9-.1-1.3H12z"/>
              </svg>
              Continue with Google
            </button>

            <div className="relative">
              <div className="absolute inset-0 flex items-center">
                <div className="w-full border-t border-[#1a1a1a]/10" />
              </div>
              <div className="relative flex justify-center text-[11px]">
                <span className="bg-white px-2 text-[#1a1a1a]/30">or</span>
              </div>
            </div>

            {/* Submit */}
            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-[#1a1a1a] text-white py-3 rounded-xl text-[13px] font-semibold hover:bg-[#333] active:scale-[0.98] transition-all flex items-center justify-center gap-2 shadow-sm disabled:opacity-50"
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

          {/* Toggle */}
          <div className="mt-6 pt-5 border-t border-[#1a1a1a]/[0.05] text-center">
            <button 
              onClick={() => { setIsSignUp(!isSignUp); setError(null); setMessage(null); }}
              className="text-[12px] text-[#1a1a1a]/30 hover:text-[#1a1a1a]/60 transition-colors"
            >
              {isSignUp ? (
                <>Already have an account? <span className="font-medium text-[#1a1a1a]/50">Sign In</span></>
              ) : (
                <>Don't have an account? <span className="font-medium text-[#1a1a1a]/50">Sign Up</span></>
              )}
            </button>
          </div>
        </motion.div>

        {/* Footer */}
        <motion.div 
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.5, delay: 0.4 }}
          className="mt-8 flex justify-between items-center px-1"
        >
          <p className="text-[11px] text-[#1a1a1a]/15">© 2025 Wisprnote</p>
          <div className="flex gap-4">
            <a href="#" className="text-[11px] text-[#1a1a1a]/15 hover:text-[#1a1a1a]/40 transition-colors">Privacy</a>
            <a href="#" className="text-[11px] text-[#1a1a1a]/15 hover:text-[#1a1a1a]/40 transition-colors">Terms</a>
          </div>
        </motion.div>
      </motion.div>
    </div>
  );
}
