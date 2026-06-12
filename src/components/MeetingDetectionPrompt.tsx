import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ChevronDown, BellOff, X } from 'lucide-react';
import {
  listenForMicDetected,
  listenForMicStopped,
  getPendingMeeting,
  emitMeetingPromptStart,
  focusMainWindow,
  hideMeetingPromptWindow,
  type MicDetectedPayload,
} from '../services/micDetectionService';

// Auto-dismiss if the user doesn't act.
const AUTO_DISMISS_MS = 15_000;

// Per-app "don't ask again" list (bundle ids the user muted from the dropdown).
const MUTE_KEY = 'lumina:meetingMutedApps';
const getMutedApps = (): string[] => {
  try { return JSON.parse(localStorage.getItem(MUTE_KEY) || '[]'); } catch { return []; }
};
const muteApp = (bundleId: string) => {
  try {
    const set = new Set(getMutedApps());
    set.add(bundleId);
    localStorage.setItem(MUTE_KEY, JSON.stringify([...set]));
  } catch { /* ignore */ }
};

/**
 * Always-on-top "Meeting detected" overlay window.
 *
 * Rendered standalone by main.tsx with `?window=meeting-prompt`. The Rust
 * detector shows this window the instant a real meeting app (Teams, Zoom, Meet,
 * …) grabs the mic. A clean notification card offers one primary action —
 * "Take Notes" — plus a dropdown to dismiss or mute that app.
 */
export default function MeetingDetectionPrompt() {
  const [detected, setDetected] = useState<MicDetectedPayload | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const armDismissTimer = () => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => void close(), AUTO_DISMISS_MS);
  };

  const close = async () => {
    if (dismissTimerRef.current) {
      clearTimeout(dismissTimerRef.current);
      dismissTimerRef.current = null;
    }
    setMenuOpen(false);
    setDetected(null);
    await hideMeetingPromptWindow();
  };

  // Show a detection unless the user muted that app.
  const onDetected = (payload: MicDetectedPayload) => {
    if (getMutedApps().includes(payload.bundle_id)) {
      void close();
      return;
    }
    setMenuOpen(false);
    setDetected(payload);
    armDismissTimer();
  };

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.overflow = 'hidden';

    let unlistenDetected: (() => void) | undefined;
    let unlistenStopped: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      const pending = await getPendingMeeting();
      if (!cancelled && pending) onDetected(pending);

      const ud = await listenForMicDetected(onDetected);
      const us = await listenForMicStopped(() => void close());
      if (cancelled) { ud(); us(); }
      else { unlistenDetected = ud; unlistenStopped = us; }
    })();

    return () => {
      cancelled = true;
      if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
      unlistenDetected?.();
      unlistenStopped?.();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleTakeNotes = async () => {
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
    // Foreground the main window first (un-throttle its JS), then deliver the
    // start event BEFORE hiding this window so the IPC isn't dropped.
    await focusMainWindow();
    await emitMeetingPromptStart(null);
    await close();
  };

  const handleMute = () => {
    if (detected) muteApp(detected.bundle_id);
    void close();
  };

  return (
    <div className="w-screen h-screen flex items-start justify-center p-2 font-[system-ui] overflow-hidden">
      <AnimatePresence>
        {detected && (
          <motion.div
            key="card"
            initial={{ y: -14, opacity: 0, scale: 0.97 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -14, opacity: 0, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 420, damping: 32 }}
            data-tauri-drag-region
            className="relative w-full rounded-[20px] bg-white shadow-[0_16px_44px_-10px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.06] overflow-visible"
          >
            <div className="flex items-center gap-3 pl-4 pr-2.5 py-2.5" data-tauri-drag-region>
              {/* subtle left accent */}
              <div className="w-[3px] self-stretch my-0.5 rounded-full bg-[#6a7c3d]/35 flex-shrink-0" />

              <div className="flex-1 min-w-0">
                <p className="text-[15px] font-semibold text-zinc-900 tracking-[-0.01em] leading-tight">
                  Meeting detected
                </p>
                <p className="text-[13px] text-zinc-500 leading-tight mt-0.5 truncate">
                  {detected.app_name}
                </p>
              </div>

              {/* Take Notes split button */}
              <div className="flex items-stretch rounded-xl bg-zinc-100 overflow-hidden flex-shrink-0 ring-1 ring-black/[0.04]">
                <button
                  onClick={handleTakeNotes}
                  className="flex items-center gap-2 pl-2 pr-3 py-2 hover:bg-zinc-200/70 transition-colors active:scale-[0.98]"
                >
                  <img src="/logo.png" alt="" className="w-6 h-6 rounded-md object-cover flex-shrink-0" />
                  <span className="text-[14px] font-semibold text-zinc-900 whitespace-nowrap">Take Notes</span>
                </button>
                <button
                  onClick={() => setMenuOpen(o => !o)}
                  className="px-2 border-l border-black/[0.06] hover:bg-zinc-200/70 transition-colors flex items-center"
                  aria-label="More options"
                >
                  <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform ${menuOpen ? 'rotate-180' : ''}`} strokeWidth={2.2} />
                </button>
              </div>
            </div>

            {/* dropdown */}
            <AnimatePresence>
              {menuOpen && (
                <motion.div
                  initial={{ opacity: 0, y: -6, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, y: -6, scale: 0.97 }}
                  transition={{ duration: 0.14 }}
                  className="absolute right-2.5 top-full mt-1.5 w-[210px] rounded-xl bg-white shadow-[0_12px_36px_-8px_rgba(0,0,0,0.3)] ring-1 ring-black/[0.06] p-1.5 z-10"
                >
                  <button
                    onClick={handleMute}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-zinc-100 transition-colors"
                  >
                    <BellOff className="w-4 h-4 text-zinc-500 flex-shrink-0" strokeWidth={1.9} />
                    <span className="text-[13px] text-zinc-700 truncate">Don't ask for {detected.app_name}</span>
                  </button>
                  <button
                    onClick={() => void close()}
                    className="w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left hover:bg-zinc-100 transition-colors"
                  >
                    <X className="w-4 h-4 text-zinc-500 flex-shrink-0" strokeWidth={2} />
                    <span className="text-[13px] text-zinc-700">Dismiss</span>
                  </button>
                </motion.div>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
