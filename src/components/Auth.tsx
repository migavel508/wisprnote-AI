import React, { useState } from 'react';
import { supabase } from '../services/supabaseService';
import { motion } from 'motion/react';
import { Layers, Mail, Lock, Loader2, ArrowRight, AlertCircle } from 'lucide-react';

export default function Auth() {
  const [loading, setLoading] = useState(false);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

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
    <div className="min-h-screen bg-[#E4E3E0] flex items-center justify-center p-4 font-sans">
      <motion.div 
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        className="w-full max-w-md"
      >
        <div className="bg-white border-2 border-[#141414] shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] p-8">
          <div className="flex flex-col items-center mb-10">
            <div className="bg-[#141414] p-3 rounded-xl mb-4">
              <Layers className="w-8 h-8 text-[#E4E3E0]" />
            </div>
            <h1 className="text-3xl font-bold tracking-tighter uppercase">Wisprnote AI</h1>
            <p className="text-[10px] font-mono uppercase opacity-50 mt-2 tracking-widest">Intelligent Audio Intelligence</p>
          </div>

          <form onSubmit={handleAuth} className="space-y-6">
            {error && (
              <div className="bg-red-50 border border-red-200 p-3 flex items-center gap-3 text-red-600 text-xs">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <p>{error}</p>
              </div>
            )}

            {message && (
              <div className="bg-green-50 border border-green-200 p-3 flex items-center gap-3 text-green-600 text-xs">
                <AlertCircle className="w-4 h-4 flex-shrink-0" />
                <p>{message}</p>
              </div>
            )}

            <div className="space-y-4">
              <div className="space-y-1">
                <label className="text-[10px] font-mono uppercase opacity-50 ml-1">Email Address</label>
                <div className="relative">
                  <Mail className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30" />
                  <input 
                    type="email" 
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="w-full border-2 border-[#141414] p-3 pl-10 text-sm focus:outline-none focus:bg-[#F5F5F5] transition-colors"
                    placeholder="name@company.com"
                  />
                </div>
              </div>

              <div className="space-y-1">
                <label className="text-[10px] font-mono uppercase opacity-50 ml-1">Password</label>
                <div className="relative">
                  <Lock className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 opacity-30" />
                  <input 
                    type="password" 
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="w-full border-2 border-[#141414] p-3 pl-10 text-sm focus:outline-none focus:bg-[#F5F5F5] transition-colors"
                    placeholder="••••••••"
                  />
                </div>
              </div>
            </div>

            <button 
              type="submit"
              disabled={loading}
              className="w-full bg-[#141414] text-[#E4E3E0] py-4 font-bold uppercase tracking-widest text-xs hover:bg-[#333] transition-all flex items-center justify-center gap-2"
            >
              {loading ? (
                <Loader2 className="w-4 h-4 animate-spin" />
              ) : (
                <>
                  {isSignUp ? 'Create Account' : 'Sign In'}
                  <ArrowRight className="w-4 h-4" />
                </>
              )}
            </button>
          </form>

          <div className="mt-8 pt-6 border-t border-[#141414]/10 text-center">
            <button 
              onClick={() => setIsSignUp(!isSignUp)}
              className="text-xs font-mono uppercase tracking-widest hover:underline opacity-60 hover:opacity-100 transition-opacity"
            >
              {isSignUp ? 'Already have an account? Sign In' : "Don't have an account? Sign Up"}
            </button>
          </div>
        </div>

        <div className="mt-8 flex justify-between items-center px-2">
          <p className="text-[10px] font-mono uppercase opacity-30">© 2024 Wisprnote AI</p>
          <div className="flex gap-4">
            <a href="#" className="text-[10px] font-mono uppercase opacity-30 hover:opacity-100">Privacy</a>
            <a href="#" className="text-[10px] font-mono uppercase opacity-30 hover:opacity-100">Terms</a>
          </div>
        </div>
      </motion.div>
    </div>
  );
}
