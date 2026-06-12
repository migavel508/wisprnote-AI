import { useEffect, useRef, useState } from 'react';
import { motion, AnimatePresence, useAnimationControls } from 'motion/react';
import { ChevronDown, X } from 'lucide-react';
import {
  listenForMicDetected,
  listenForMicStopped,
  getPendingMeeting,
  emitMeetingPromptStart,
  focusMainWindow,
  hideMeetingPromptWindow,
  setOverlayHitBounds,
  clearOverlayHitBounds,
  type MicDetectedPayload,
} from '../services/micDetectionService';

const PROMPT_LABEL = 'meeting-prompt';

// How long the prompt stays before auto-dismissing — kept brief. The bottom
// duration bar depletes over exactly this window.
const DURATION_MS = 8_000;

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
 * …) grabs the mic. A 1:1 match of anarlog/Granola's notification: it slides in
 * from the right at the top-right corner, has a protruding ✕ close button, a
 * "Take Notes" button (logo + divider + chevron), a chevron dropdown, and a
 * subtle duration bar at the bottom that depletes over the auto-dismiss window.
 *
 * The window is larger than the card (so the dropdown isn't clipped); we report
 * the card's real rectangle via `setOverlayHitBounds` so only that rect captures
 * the cursor and the transparent area stays click-through.
 */
export default function MeetingDetectionPrompt() {
  const [detected, setDetected] = useState<MicDetectedPayload | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const dismissTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const closeRef = useRef<HTMLButtonElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  const barControls = useAnimationControls();

  // ── Auto-dismiss + duration bar ────────────────────────────────────────────
  const startBar = () => {
    barControls.set({ scaleX: 1 });
    void barControls.start({ scaleX: 0, transition: { duration: DURATION_MS / 1000, ease: 'linear' } });
  };
  const armDismissTimer = () => {
    if (dismissTimerRef.current) clearTimeout(dismissTimerRef.current);
    dismissTimerRef.current = setTimeout(() => void close(), DURATION_MS);
  };
  const cancelDismiss = () => {
    if (dismissTimerRef.current) { clearTimeout(dismissTimerRef.current); dismissTimerRef.current = null; }
  };

  const close = async () => {
    cancelDismiss();
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

  // (Re)start the depleting duration bar whenever a new detection appears.
  useEffect(() => {
    if (detected) startBar();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [detected]);

  // Report the card's real rectangle (union of ✕ + card [+ dropdown when open])
  // so only it captures the cursor — the rest of the window stays click-through.
  //
  // CRITICAL: this runs every animation frame while the prompt is visible. The
  // card slides in (transform x:40→0) and the dropdown animates, so a one-shot
  // measure would leave the hit-region offset from where the card actually is —
  // which is exactly why the first click on "Take Notes" used to land in the
  // click-through gap and get lost. Tracking it per-frame keeps the interactive
  // region locked onto the card. We only send IPC when the rounded rect changes,
  // so once it settles there's no ongoing chatter.
  useEffect(() => {
    if (!detected) { void clearOverlayHitBounds(PROMPT_LABEL); return; }
    let raf = 0;
    let last = '';
    const tick = () => {
      const els = [closeRef.current, cardRef.current, menuOpen ? menuRef.current : null];
      const rects = els.filter(Boolean).map((el) => (el as HTMLElement).getBoundingClientRect());
      if (rects.length) {
        const PAD = 4; // a little breathing room around the edges
        const left = Math.min(...rects.map((r) => r.left)) - PAD;
        const top = Math.min(...rects.map((r) => r.top)) - PAD;
        const right = Math.max(...rects.map((r) => r.right)) + PAD;
        const bottom = Math.max(...rects.map((r) => r.bottom)) + PAD;
        const key = `${Math.round(left)},${Math.round(top)},${Math.round(right)},${Math.round(bottom)}`;
        if (key !== last) {
          last = key;
          void setOverlayHitBounds(PROMPT_LABEL, { x: left, y: top, width: right - left, height: bottom - top });
        }
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [detected, menuOpen]);

  // ── Actions ────────────────────────────────────────────────────────────────
  const handleTakeNotes = async () => {
    cancelDismiss();
    // Foreground the main window first (un-throttle its JS), then deliver the
    // start event BEFORE hiding this window so the IPC isn't dropped.
    await focusMainWindow();
    await emitMeetingPromptStart(null);
    await close();
  };

  const handleOpenApp = async () => {
    cancelDismiss();
    await focusMainWindow();
    await close();
  };

  const handleMute = () => {
    if (detected) muteApp(detected.bundle_id);
    void close();
  };

  // Hovering pauses the countdown (and freezes the bar); leaving re-arms it.
  const onCardEnter = () => { cancelDismiss(); void barControls.stop(); };
  const onCardLeave = () => { if (!menuOpen) { armDismissTimer(); startBar(); } };

  return (
    <div className="w-screen h-screen flex items-start justify-end pt-2.5 px-3 font-[system-ui]">
      <AnimatePresence>
        {detected && (
          <motion.div
            key="card"
            initial={{ x: 40, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 40, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 380, damping: 32 }}
            className="relative w-full max-w-[332px]"
          >
            {/* Protruding ✕ close button (top-left, half outside the card). */}
            <button
              ref={closeRef}
              onClick={() => void close()}
              aria-label="Dismiss"
              className="absolute -left-2 -top-2 z-30 w-7 h-7 rounded-full bg-white shadow-[0_3px_12px_-2px_rgba(0,0,0,0.28)] ring-1 ring-black/[0.06] flex items-center justify-center hover:bg-zinc-50 active:scale-95 transition"
            >
              <X className="w-[15px] h-[15px] text-zinc-700" strokeWidth={2.4} />
            </button>

            {/* Notification card */}
            <div
              ref={cardRef}
              data-tauri-drag-region
              onMouseEnter={onCardEnter}
              onMouseLeave={onCardLeave}
              className="relative overflow-hidden rounded-[16px] bg-white shadow-[0_14px_38px_-12px_rgba(0,0,0,0.32)] ring-1 ring-black/[0.06]"
            >
              <div className="flex items-center gap-2.5 pl-4 pr-2.5 py-2.5" data-tauri-drag-region>
                {/* left accent pill */}
                <div className="w-[3px] h-7 rounded-full bg-zinc-200 flex-shrink-0" />

                <div className="flex-1 min-w-0" data-tauri-drag-region>
                  <p className="text-[14px] font-semibold text-zinc-900 tracking-[-0.01em] leading-tight">
                    Meeting detected
                  </p>
                  <p className="text-[12px] text-zinc-500 leading-tight mt-0.5 truncate">
                    {detected.app_name}
                  </p>
                </div>

                {/* Take Notes button: logo + label + divider + chevron */}
                <div className="flex items-stretch rounded-[11px] bg-white ring-1 ring-black/[0.08] shadow-[0_1px_2px_rgba(0,0,0,0.04)] overflow-hidden flex-shrink-0">
                  <button
                    onClick={handleTakeNotes}
                    className="flex items-center gap-2 pl-2 pr-2.5 py-1.5 hover:bg-zinc-50 transition-colors active:scale-[0.98]"
                  >
                    <img src="/logo.png" alt="" className="w-[22px] h-[22px] rounded-[6px] object-cover flex-shrink-0" />
                    <span className="text-[13px] font-medium text-zinc-900 whitespace-nowrap tracking-[-0.01em]">Take Notes</span>
                  </button>
                  <button
                    onClick={() => setMenuOpen((o) => { if (!o) cancelDismiss(); return !o; })}
                    className="px-1.5 border-l border-black/[0.08] hover:bg-zinc-50 transition-colors flex items-center"
                    aria-label="More options"
                  >
                    <ChevronDown className={`w-4 h-4 text-zinc-500 transition-transform ${menuOpen ? 'rotate-180' : ''}`} strokeWidth={2.2} />
                  </button>
                </div>
              </div>

              {/* Duration bar — subtle line at the bottom that depletes over the
                  auto-dismiss window (frozen while the card is hovered). */}
              <div className="absolute inset-x-0 bottom-0 h-[2.5px] overflow-hidden">
                <motion.div
                  className="h-full bg-[#6a7c3d]/45"
                  style={{ transformOrigin: 'left center' }}
                  initial={{ scaleX: 1 }}
                  animate={barControls}
                />
              </div>
            </div>

            {/* dropdown — matches the reference's three actions */}
            <AnimatePresence>
              {menuOpen && (
                <>
                  {/* click-away catcher (within the window) */}
                  <div className="fixed inset-0 z-10" onClick={() => setMenuOpen(false)} />
                  <motion.div
                    ref={menuRef}
                    initial={{ opacity: 0, y: -6, scale: 0.98 }}
                    animate={{ opacity: 1, y: 0, scale: 1 }}
                    exit={{ opacity: 0, y: -6, scale: 0.98 }}
                    transition={{ duration: 0.14 }}
                    className="absolute right-0 top-full mt-1.5 w-[270px] rounded-[14px] bg-white shadow-[0_16px_40px_-10px_rgba(0,0,0,0.32)] ring-1 ring-black/[0.06] py-1 z-20"
                  >
                    <button
                      onClick={handleOpenApp}
                      className="w-full text-left px-4 py-2 text-[13px] text-zinc-900 hover:bg-zinc-100 transition-colors"
                    >
                      Open Wisprnote
                    </button>
                    <div className="my-0.5 h-px bg-black/[0.07]" />
                    <button
                      onClick={handleMute}
                      className="w-full text-left px-4 py-2 text-[13px] text-zinc-900 hover:bg-zinc-100 transition-colors truncate"
                    >
                      Turn off notifications for {detected.app_name}
                    </button>
                    <button
                      onClick={handleOpenApp}
                      className="w-full text-left px-4 py-2 text-[13px] text-zinc-900 hover:bg-zinc-100 transition-colors"
                    >
                      Change Notification Settings
                    </button>
                  </motion.div>
                </>
              )}
            </AnimatePresence>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
