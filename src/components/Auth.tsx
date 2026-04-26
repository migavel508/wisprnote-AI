import React, { useState } from 'react';
import { supabase } from '../services/supabaseService';
import { motion, AnimatePresence } from 'motion/react';
import { Mail, Lock, Loader2, ArrowRight, AlertCircle, CheckCircle2 } from 'lucide-react';

export default function Auth() {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [focusedField, setFocusedField] = useState<'email' | 'password' | null>(null);

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
