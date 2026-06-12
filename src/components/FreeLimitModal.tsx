import { useState } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence } from 'framer-motion';
import { X, Sparkles, Check, Loader2 } from 'lucide-react';
import { openCheckout } from '../services/paddleService';
import type { AuthSession } from '../services/awsAuthService';

interface FreeLimitModalProps {
  open: boolean;
  onClose: () => void;
  limit: number;
  used: number;
  planLabel?: string;
  /** Optional server-provided message (e.g. batch-hour cap) — overrides the
      default "used all N meetings" copy. */
  message?: string | null;
  session?: AuthSession | null;
}

/**
 * Shown when a free-plan user hits the meeting cap (either proactively before
 * recording/uploading, or when the backend rejects a save with 402). Drives an
 * upgrade via the existing Paddle checkout.
 */
export default function FreeLimitModal({ open, onClose, limit, used, planLabel = 'Free', message, session }: FreeLimitModalProps) {
  const [loading, setLoading] = useState(false);
  const heading = message ? 'Upgrade to continue' : `You've used all ${limit} ${planLabel} meetings`;
  const body = message
    ? message
    : `You're on the ${planLabel} plan (${used}/${limit} meetings used). Upgrade to Pro to keep recording and unlock everything.`;

  const upgrade = async () => {
    setLoading(true);
    try {
      await openCheckout({ plan: 'pro', cycle: 'monthly', session });
    } finally {
      setLoading(false);
    }
  };

  const perks = [
    'Unlimited meetings & recordings',
    'Full AI chat across all meetings',
    'Knowledge graph & advanced models',
  ];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          className="fixed inset-0 z-[200] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
        >
          <div className="absolute inset-0 bg-black/40 backdrop-blur-sm" onClick={onClose} />
          <motion.div
            initial={{ opacity: 0, y: 14, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 14, scale: 0.97 }}
            transition={{ duration: 0.18, ease: 'easeOut' }}
            className="relative w-full max-w-[420px] rounded-3xl bg-white dark:bg-app-raised border border-zinc-200/80 dark:border-app-border shadow-[0_24px_70px_-12px_rgba(0,0,0,0.4)] p-6"
          >
            <button
              onClick={onClose}
              className="absolute top-4 right-4 p-1.5 rounded-lg text-zinc-400 hover:text-zinc-700 dark:hover:text-app-fg hover:bg-zinc-100 dark:hover:bg-black/25 transition-colors"
              aria-label="Close"
            >
              <X className="w-4 h-4" strokeWidth={2.2} />
            </button>

            <div className="w-11 h-11 rounded-2xl bg-[#6a7c3d]/12 flex items-center justify-center mb-4">
              <Sparkles className="w-5 h-5 text-[#6a7c3d]" strokeWidth={1.9} />
            </div>

            <h2 className="text-[19px] font-semibold text-zinc-900 dark:text-app-fg tracking-tight">
              {heading}
            </h2>
            <p className="mt-1.5 text-[14px] leading-relaxed text-zinc-500 dark:text-app-fg-muted">
              {body}
            </p>

            <ul className="mt-4 space-y-2">
              {perks.map((p) => (
                <li key={p} className="flex items-center gap-2.5 text-[13.5px] text-zinc-700 dark:text-app-fg">
                  <span className="w-4 h-4 rounded-full bg-[#6a7c3d]/15 flex items-center justify-center flex-shrink-0">
                    <Check className="w-2.5 h-2.5 text-[#6a7c3d]" strokeWidth={3} />
                  </span>
                  {p}
                </li>
              ))}
            </ul>

            <button
              onClick={upgrade}
              disabled={loading}
              className="mt-5 w-full h-11 rounded-xl bg-[#1a1a1a] text-white text-[14px] font-semibold flex items-center justify-center gap-2 hover:bg-[#333] active:scale-[0.99] disabled:opacity-60 transition-all"
            >
              {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Upgrade to Pro'}
            </button>
            <button
              onClick={onClose}
              className="mt-2 w-full h-9 rounded-xl text-[13px] text-zinc-500 dark:text-app-fg-muted hover:bg-zinc-100 dark:hover:bg-black/20 transition-colors"
            >
              Maybe later
            </button>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
}
