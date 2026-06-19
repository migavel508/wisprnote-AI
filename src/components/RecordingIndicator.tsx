import { useEffect, useRef, useState } from 'react';
import { WisprnoteLogo } from './WisprnoteLogo';
import {
  listenForRecordingIndicatorState,
  emitStopRecording,
  focusMainWindow,
  type RecordingIndicatorState,
} from '../services/micDetectionService';

// anarlog's accent (the red waveform / stop square): RGB(255, 115, 122).
const ACCENT = 'rgb(255,115,122)';

// Top button → open the main window (anarlog's "a" mark).
const handleOpenMain = () => { void focusMainWindow(); };
// Bottom button → foreground main, then stop (anarlog's waveform/stop).
const handleStop = async () => { await focusMainWindow(); await emitStopRecording(); };

/**
 * Floating recording indicator — a faithful port of anarlog/Hyprnote's native
 * floating bar: a vertical olive-gray capsule with the app mark on top and an
 * animated 3-bar red waveform (→ a stop square on hover) on the bottom, plus
 * drag-handle dots that appear on hover. Rendered as a transparent overlay
 * (`?window=recording-indicator`); state is pushed live from the main app.
 *
 * Dimensions/colors mirror anarlog's FloatingBarView.swift exactly (pill 32×60,
 * 28×28 circular click areas, accent RGB 255/115/122, pill RGB 110/112/102 @78%).
 */
export default function RecordingIndicator() {
  const [state, setState] = useState<RecordingIndicatorState>({ recording: true, paused: false, seconds: 0, label: null });
  const [hovered, setHovered] = useState(false);
  const [stopHover, setStopHover] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rafRef = useRef<number | null>(null);
  // Read live by the (persistent) draw loop so it never has to restart when
  // pause/resume toggles — restarting is what used to blank the waveform.
  const amplitudeRef = useRef(0.6);

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

  // Keep the live amplitude in a ref (bars dance while recording, rest when
  // paused) so the draw loop reads it without ever needing to restart.
  useEffect(() => { amplitudeRef.current = state.paused ? 0 : 0.6; }, [state.paused]);

  // Animated 3-bar waveform — anarlog's DancingBars formula, ported 1:1.
  // ONE persistent loop for the component's whole life: the canvas element is
  // never unmounted and the loop never restarts on state changes, so the red
  // waves stay visible. It also re-kicks itself on visibility/focus changes to
  // recover if macOS throttled rAF while the overlay was hidden or being dragged.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = 18, H = 13;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const barCount = 3, barWidth = 4, barSpacing = 2, minH = 2, maxH = 13;
    const center = (barCount - 1) / 2;
    let running = true;
    const draw = (tms: number) => {
      if (!running) return;
      const t = tms / 1000;
      const amplitude = amplitudeRef.current;
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = ACCENT;
      for (let i = 0; i < barCount; i++) {
        const distance = Math.abs(i - center) / Math.max(center, 1);
        const envelope = 1 - distance * 0.42;
        const phase = t * 8.5 + i * 0.68;
        const wave = Math.sin(phase) * 0.5 + 0.5;
        const drive = 0.4 + amplitude * 0.9;
        let h = maxH * (drive * envelope * (0.4 + wave * 0.6));
        h = Math.max(minH, Math.min(maxH, h));
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
  }, []);

  return (
    <div
      data-tauri-drag-region
      className="w-screen h-screen flex flex-col items-center justify-start pt-[4px] font-[system-ui] cursor-grab active:cursor-grabbing"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      {/* vertical capsule pill */}
      <div
        data-tauri-drag-region
        className="relative flex flex-col items-center justify-center cursor-grab active:cursor-grabbing"
        style={{
          width: 32,
          height: 60,
          borderRadius: 9999,
          background: 'rgba(110,112,102,0.78)',
          border: '0.5px solid rgba(255,255,255,0.14)',
          backdropFilter: 'blur(8px)',
          WebkitBackdropFilter: 'blur(8px)',
        }}
      >
        {/* inner hairline ring (anarlog's second stroke) */}
        <div className="pointer-events-none absolute inset-[1.5px] rounded-full" style={{ border: '0.5px solid rgba(255,255,255,0.28)' }} />

        {/* top: app mark → open main window */}
        <button
          onClick={handleOpenMain}
          title="Open Wisprnote"
          className="w-7 h-7 rounded-full flex items-center justify-center hover:bg-white/[0.08] transition-colors"
        >
          <WisprnoteLogo className="w-[18px] h-[18px]" />
        </button>

        {/* bottom: animated waveform → stop square on hover. The canvas stays
            mounted at all times (only fades on hover) so its rAF loop never
            breaks and the red waves never blank out. */}
        <button
          onClick={() => void handleStop()}
          onMouseEnter={() => setStopHover(true)}
          onMouseLeave={() => setStopHover(false)}
          title="Stop recording"
          className="relative w-7 h-7 rounded-full flex items-center justify-center transition-colors"
          style={{ background: stopHover ? 'rgba(255,115,122,0.16)' : 'transparent' }}
        >
          <canvas
            ref={canvasRef}
            style={{ width: 18, height: 13, opacity: stopHover ? 0 : 1, transition: 'opacity 0.1s' }}
          />
          {stopHover && (
            <span className="absolute inset-0 flex items-center justify-center">
              <span style={{ width: 9, height: 9, background: ACCENT, borderRadius: 1.5 }} />
            </span>
          )}
        </button>
      </div>

      {/* drag-handle dots — appear on hover (anarlog's FloatingBarHoverHandle).
          Also a drag region: the dot spans are pointer-events-none so a mousedown
          lands on this div, giving a clear grab handle to move the indicator. */}
      <div
        data-tauri-drag-region
        className="grid grid-cols-3 mt-[3px] px-1 py-[3px] transition-opacity duration-100 cursor-grab active:cursor-grabbing"
        style={{ gap: '2.4px', opacity: hovered ? 1 : 0 }}
        aria-hidden
      >
        {Array.from({ length: 6 }).map((_, i) => (
          <span key={i} className="pointer-events-none rounded-full" style={{ width: 1.6, height: 1.6, background: 'rgba(255,255,255,0.66)' }} />
        ))}
      </div>
    </div>
  );
}
