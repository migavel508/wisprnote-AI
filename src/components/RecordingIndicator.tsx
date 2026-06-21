import { useEffect, useRef, useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { WisprnoteLogo } from './WisprnoteLogo';
import {
  listenForRecordingIndicatorState,
  listenForAudioLevel,
  emitStopRecording,
  emitOpenChatFromIndicator,
  focusMainWindow,
  setOverlayHitBounds,
  type RecordingIndicatorState,
} from '../services/micDetectionService';

const ACCENT = '#819C1F';            // brand green — waveform / stop
const ACCENT_SOFT = 'rgba(129,156,31,0.18)';
const PILL_BG = 'rgba(22,22,24,0.96)'; // near-black capsule
const PANEL_BG = 'rgba(20,20,22,0.97)';
const INDICATOR_LABEL = 'recording-indicator';
const HOVER_DELAY_MS = 450;          // deliberate hover before the panel opens

const handleOpenMain = () => { void focusMainWindow(); };
const handleStop = async () => { await focusMainWindow(); await emitStopRecording(); };

const fmtTime = (s: number) => {
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return `${m}:${sec.toString().padStart(2, '0')}`;
};

/**
 * Floating recording indicator. A near-black capsule (brand mark + a LIVE,
 * mic-driven green waveform) pinned to the right edge. The whole capsule is
 * draggable. A DELIBERATE hover (rests ~450ms, no press) expands a panel to the
 * left with the live transcript and a chat action; pressing to drag never opens
 * it. The capsule/canvas stay mounted for the window's whole life so the
 * waveform loop never breaks.
 */
export default function RecordingIndicator() {
  const [state, setState] = useState<RecordingIndicatorState>({ recording: true, paused: false, seconds: 0, label: null });
  const [panelOpen, setPanelOpen] = useState(false);
  const [stopHover, setStopHover] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  const amplitudeRef = useRef(0);          // 0..1, eased toward the live level
  const targetRef = useRef(0);             // latest mic level pushed from the capture pipeline
  const wrapRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const winRef = useRef<{ startDragging: () => Promise<void> } | null>(null);
  const dragRef = useRef<{ x: number; y: number } | null>(null);
  const pressingRef = useRef(false);       // mouse button is down (drag intent)
  const hoverTimerRef = useRef<number | null>(null);
  const recordingRef = useRef(true);
  recordingRef.current = state.recording;

  // Pre-resolve the window handle so startDragging() is called SYNCHRONOUSLY in
  // the mousemove handler — an async import breaks the native macOS drag gesture.
  useEffect(() => {
    let mounted = true;
    import('@tauri-apps/api/window')
      .then((m) => { if (mounted) winRef.current = m.getCurrentWindow() as any; })
      .catch(() => {});
    return () => { mounted = false; };
  }, []);

  useEffect(() => {
    document.documentElement.style.background = 'transparent';
    document.body.style.background = 'transparent';
    document.body.style.overflow = 'hidden';
    document.body.style.userSelect = 'none';
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenForRecordingIndicatorState((next) => setState(next)).then((fn) => {
      if (cancelled) fn(); else unlisten = fn;
    });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // ── Hover intent: open the panel only after a deliberate rest, never while a
  // press/drag is in progress. ────────────────────────────────────────────────
  const clearHoverTimer = () => {
    if (hoverTimerRef.current) { window.clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
  };
  const onEnter = () => {
    clearHoverTimer();
    if (pressingRef.current) return;
    hoverTimerRef.current = window.setTimeout(() => {
      if (!pressingRef.current && recordingRef.current) setPanelOpen(true);
    }, HOVER_DELAY_MS);
  };
  const onLeave = () => { clearHoverTimer(); setPanelOpen(false); };

  // ── Whole-capsule drag (threshold). Pressing also cancels/closes the panel. ──
  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      if (Math.abs(e.clientX - d.x) + Math.abs(e.clientY - d.y) > 3) {
        dragRef.current = null;
        try { void winRef.current?.startDragging(); } catch { /* non-fatal */ }
      }
    };
    const onUp = () => { dragRef.current = null; pressingRef.current = false; };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, []);

  const onDragMouseDown = (e: React.MouseEvent) => {
    if (e.button !== 0) return;
    // Don't hijack interactive controls (chat button) for dragging.
    if ((e.target as HTMLElement).closest('[data-no-drag]')) return;
    pressingRef.current = true;
    clearHoverTimer();
    setPanelOpen(false);                 // grabbing to drag must never open the panel
    dragRef.current = { x: e.clientX, y: e.clientY };
  };

  // ── Report the interactive hit-rect so the rest of the (large, transparent)
  // window stays click-through. Expands when the hover panel is open. ──────────
  useEffect(() => {
    const report = () => {
      const el = wrapRef.current;
      if (!el) return;
      const r = el.getBoundingClientRect();
      void setOverlayHitBounds(INDICATOR_LABEL, { x: r.left, y: r.top, width: r.width, height: r.height });
    };
    const id = requestAnimationFrame(report);
    const t = window.setInterval(report, 500);
    return () => { cancelAnimationFrame(id); window.clearInterval(t); };
  }, [panelOpen, state.transcript]);

  // ── Live mic level pushed from the Rust capture pipeline (~25 fps). Reliable
  // regardless of the overlay window's own mic access. ────────────────────────
  useEffect(() => {
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenForAudioLevel((level) => { targetRef.current = Math.max(0, Math.min(1, level)); })
      .then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // Drop the level to silence on pause/stop (no events arrive while paused).
  useEffect(() => {
    if (!state.recording || state.paused) { targetRef.current = 0; amplitudeRef.current = 0; }
  }, [state.recording, state.paused]);

  // ── Waveform draw loop. Always-mounted canvas + ONE persistent loop, so it
  // never blanks. A visible idle baseline keeps the bars alive even with no mic
  // feed; the real mic level adds height on top (soft → low, loud → tall). ─────
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 18, H = 14;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const barCount = 3, barWidth = 4, barSpacing = 3, minH = 2, maxH = 14;
    const env = [0.7, 1.0, 0.7];
    let running = true;
    const draw = (tms: number) => {
      if (!running) return;
      const t = tms / 1000;
      // Ease toward the latest pushed level: fast attack (catch loud bursts),
      // slower release (smooth fall on silence) — a VU-meter feel.
      const target = state.paused ? 0 : targetRef.current;
      const a = amplitudeRef.current;
      amplitudeRef.current = a + (target - a) * (target > a ? 0.5 : 0.14);
      const level = amplitudeRef.current;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = state.paused ? 'rgba(150,150,150,0.7)' : ACCENT;
      for (let i = 0; i < barCount; i++) {
        const wiggle = Math.sin(t * 7 + i * 0.8) * 0.5 + 0.5;     // 0..1
        const idle = 0.2 + wiggle * 0.12;                         // 0.20..0.32 — always visible
        const frac = Math.min(1, idle + level * env[i] * 0.95);
        const h = Math.max(minH, Math.min(maxH, maxH * frac));
        const x = i * (barWidth + barSpacing);
        const y = (H - h) / 2;
        ctx.beginPath();
        if ((ctx as any).roundRect) (ctx as any).roundRect(x, y, barWidth, h, barWidth / 2);
        else ctx.rect(x, y, barWidth, h);
        ctx.fill();
      }
      rafRef.current = requestAnimationFrame(draw);
    };
    const kick = () => {
      if (!running) return;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      rafRef.current = requestAnimationFrame(draw);
    };
    kick();
    document.addEventListener('visibilitychange', kick);
    window.addEventListener('focus', kick);
    return () => {
      running = false;
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      document.removeEventListener('visibilitychange', kick);
      window.removeEventListener('focus', kick);
    };
  }, [state.paused]);

  useEffect(() => {
    const el = transcriptRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [state.transcript, panelOpen]);

  const showPanel = panelOpen && state.recording;
  const lines = (state.transcript || '').split('\n').filter(Boolean);

  return (
    <div className="w-screen h-screen relative font-[system-ui]">
      <div
        ref={wrapRef}
        onMouseEnter={onEnter}
        onMouseLeave={onLeave}
        onMouseDown={onDragMouseDown}
        className="absolute right-[8px] top-1/2 -translate-y-1/2 flex items-stretch gap-2 cursor-grab active:cursor-grabbing"
      >
        {/* Hover panel — transcript + chat (left of the capsule) */}
        {showPanel && (
          <div
            className="w-[264px] flex flex-col rounded-2xl overflow-hidden"
            style={{ background: PANEL_BG, border: '0.5px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(10px)', WebkitBackdropFilter: 'blur(10px)' }}
          >
            <div className="flex items-center gap-1.5 px-3 pt-2.5 pb-1.5">
              <span className="w-1.5 h-1.5 rounded-full" style={{ background: state.paused ? '#9a9a9a' : ACCENT }} />
              <span className="text-[11px] font-medium text-white/85">{state.paused ? 'Paused' : 'Recording'}</span>
              <span className="text-[11px] text-white/40 tabular-nums">{fmtTime(state.seconds)}</span>
              {state.label && <span className="ml-auto text-[11px] text-white/45 truncate max-w-[120px]">{state.label}</span>}
            </div>

            <div ref={transcriptRef} className="px-3 py-1.5 h-[112px] overflow-y-auto">
              {lines.length === 0 ? (
                <div className="text-[12px] text-white/35 italic">Listening…</div>
              ) : (
                lines.map((ln, i) => (
                  <div key={i} className={`text-[12px] leading-snug mb-1 ${i === lines.length - 1 ? 'text-white/45 italic' : 'text-white/85'}`}>
                    {ln}
                  </div>
                ))
              )}
            </div>

            <button
              data-no-drag
              onClick={() => void emitOpenChatFromIndicator()}
              className="m-2 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[12.5px] font-medium text-white transition-colors hover:opacity-90"
              style={{ background: ACCENT }}
            >
              <MessageSquare size={13} strokeWidth={2} />
              Chat with this meeting
            </button>
          </div>
        )}

        {/* Capsule — always mounted */}
        <div
          className="relative flex flex-col items-center justify-center flex-shrink-0"
          style={{ width: 32, height: 60, borderRadius: 9999, background: PILL_BG, border: '0.5px solid rgba(255,255,255,0.12)', backdropFilter: 'blur(8px)', WebkitBackdropFilter: 'blur(8px)' }}
        >
          <div className="pointer-events-none absolute inset-[1.5px] rounded-full" style={{ border: '0.5px solid rgba(255,255,255,0.08)' }} />

          <button
            onClick={handleOpenMain}
            title="Open Wisprnote"
            className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-colors"
          >
            <WisprnoteLogo className="w-[18px] h-[18px]" />
          </button>

          <button
            onClick={() => void handleStop()}
            onMouseEnter={() => setStopHover(true)}
            onMouseLeave={() => setStopHover(false)}
            title="Stop recording"
            className="relative w-7 h-7 rounded-full flex items-center justify-center transition-colors"
            style={{ background: stopHover ? ACCENT_SOFT : 'transparent' }}
          >
            <canvas ref={canvasRef} style={{ width: 18, height: 14, opacity: stopHover ? 0 : 1, transition: 'opacity 0.1s' }} />
            {stopHover && (
              <span className="absolute inset-0 flex items-center justify-center">
                <span style={{ width: 9, height: 9, background: ACCENT, borderRadius: 1.5 }} />
              </span>
            )}
          </button>
        </div>
      </div>
    </div>
  );
}
