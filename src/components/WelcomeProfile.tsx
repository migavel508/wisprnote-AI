import { motion } from 'framer-motion';
import { Loader2, Check } from 'lucide-react';
import { formatDisplayName, formatDisplayInitials } from '../lib/displayName';
import type { AuthSession } from '../services/awsAuthService';

/**
 * Post-login welcome screen. Shown briefly after a Google sign-in to confirm the
 * captured profile (photo + name + email) before entering the app — mirrors the
 * Google consent layout the user expects to land on.
 */
export default function WelcomeProfile({
  session,
  onContinue,
}: {
  session: AuthSession;
  onContinue: () => void;
}) {
  const email = session.user.email || '';
  const name = formatDisplayName(email, session.user.name);
  const initials = formatDisplayInitials(email, session.user.name);
  const picture = session.user.picture;

  return (
    <div className="min-h-screen w-full flex flex-col items-center justify-center bg-app-canvas text-app-fg px-4">
      <motion.div
        initial={{ opacity: 0, y: 12, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ type: 'spring', stiffness: 280, damping: 26 }}
        className="w-full max-w-sm rounded-3xl bg-app-panel border border-app-border shadow-[0_24px_70px_-16px_rgba(0,0,0,0.25)] p-8 text-center"
      >
        {/* Avatar */}
        <div className="relative w-20 h-20 mx-auto mb-5">
          <div className="w-20 h-20 rounded-full overflow-hidden bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center">
            {picture ? (
              <img
                src={picture}
                alt={name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <span className="text-[22px] font-mono font-medium tracking-wider">{initials}</span>
            )}
          </div>
          <div className="absolute -bottom-1 -right-1 w-7 h-7 rounded-full bg-emerald-500 border-[3px] border-app-panel flex items-center justify-center">
            <Check className="w-3.5 h-3.5 text-white" strokeWidth={3} />
          </div>
        </div>

        <h1 className="text-[20px] font-semibold tracking-[-0.01em]">Welcome, {name.split(' ')[0]} 👋</h1>
        <p className="text-[13px] text-app-fg-subtle mt-1">You're signed in to Wisprnote AI</p>

        {/* Identity card */}
        <div className="mt-6 rounded-2xl bg-app-raised border border-app-border/60 p-4 text-left space-y-3">
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-app-fg-label">Name</div>
            <div className="text-[14px] font-medium text-app-fg truncate">{name}</div>
          </div>
          <div className="h-px bg-app-divider" />
          <div>
            <div className="text-[10px] font-medium uppercase tracking-wider text-app-fg-label">Email</div>
            <div className="text-[13px] text-app-fg-muted truncate">{email}</div>
          </div>
        </div>

        <button
          onClick={onContinue}
          className="mt-6 w-full py-3 rounded-xl bg-app-fg text-app-canvas text-[14px] font-semibold hover:opacity-90 transition-opacity flex items-center justify-center gap-2"
        >
          Continue
        </button>
      </motion.div>

      <p className="mt-5 text-[11px] text-app-fg-subtle flex items-center gap-1.5">
        <Loader2 className="w-3 h-3 animate-spin opacity-0" aria-hidden />
        Tap Continue to enter your workspace
      </p>
    </div>
  );
}
