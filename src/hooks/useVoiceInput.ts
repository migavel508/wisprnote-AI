import { useEffect, useRef, useState } from 'react';
import { transcribeAudioBlob } from '../services/aiProxyService';

/**
 * Voice input for chat boxes — record → live scrolling waveform → transcribe →
 * deliver text. Ported verbatim from ChatPage so the global AI Chat and the
 * workspace chat share the exact same capture pipeline (raw PCM → clean 16 kHz
 * WAV, which Deepgram Nova-3 transcribes most reliably in WKWebView/Tauri).
 *
 * Usage: const v = useVoiceInput(t => setInput(prev => prev ? `${prev} ${t}` : t));
 * then render <canvas ref={v.canvasRef} /> while v.isRecording, and wire
 * v.startVoice / v.confirmVoice / v.cancelVoice to the mic / ✕ / ✓ buttons.
 */
export function useVoiceInput(onTranscript: (text: string) => void, disabled?: boolean) {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [recSeconds, setRecSeconds] = useState(0);

  const recStreamRef = useRef<MediaStream | null>(null);
  const recAudioCtxRef = useRef<AudioContext | null>(null);
  const recAnalyserRef = useRef<AnalyserNode | null>(null);
  const recProcessorRef = useRef<ScriptProcessorNode | null>(null);
  const recSinkRef = useRef<GainNode | null>(null);
  const recPcmRef = useRef<Float32Array[]>([]);
  const recSampleRateRef = useRef<number>(48000);
  const recRafRef = useRef<number | null>(null);
  const recTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const recCancelledRef = useRef(false);
  const recBarsRef = useRef<number[]>([]);
  const recLastSampleRef = useRef<number>(0);

  const teardownVoice = () => {
    if (recRafRef.current) cancelAnimationFrame(recRafRef.current);
    recRafRef.current = null;
    if (recTimerRef.current) clearInterval(recTimerRef.current);
    recTimerRef.current = null;
    recStreamRef.current?.getTracks().forEach(t => t.stop());
    recStreamRef.current = null;
    recAnalyserRef.current = null;
    recBarsRef.current = [];
    recLastSampleRef.current = 0;
    if (recProcessorRef.current) { recProcessorRef.current.onaudioprocess = null; try { recProcessorRef.current.disconnect(); } catch { /* ignore */ } }
    recProcessorRef.current = null;
    if (recSinkRef.current) { try { recSinkRef.current.disconnect(); } catch { /* ignore */ } }
    recSinkRef.current = null;
    recAudioCtxRef.current?.close().catch(() => {});
    recAudioCtxRef.current = null;
  };

  const floatChunksToWav = (chunks: Float32Array[], inRate: number, outRate = 16000): Blob => {
    let total = 0;
    for (const c of chunks) total += c.length;
    const merged = new Float32Array(total);
    let off = 0;
    for (const c of chunks) { merged.set(c, off); off += c.length; }
    let samples = merged;
    if (outRate < inRate && total > 0) {
      const ratio = inRate / outRate;
      const outLen = Math.floor(total / ratio);
      const out = new Float32Array(outLen);
      for (let i = 0; i < outLen; i++) {
        const start = Math.floor(i * ratio);
        const end = Math.min(total, Math.floor((i + 1) * ratio));
        let sum = 0, n = 0;
        for (let j = start; j < end; j++) { sum += merged[j]; n++; }
        out[i] = n ? sum / n : merged[start] || 0;
      }
      samples = out;
    } else {
      outRate = inRate;
    }
    const buffer = new ArrayBuffer(44 + samples.length * 2);
    const view = new DataView(buffer);
    const writeStr = (o: number, s: string) => { for (let i = 0; i < s.length; i++) view.setUint8(o + i, s.charCodeAt(i)); };
    writeStr(0, 'RIFF'); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, 'WAVE');
    writeStr(12, 'fmt '); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, outRate, true); view.setUint32(28, outRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, 'data'); view.setUint32(40, samples.length * 2, true);
    let p = 44;
    for (let i = 0; i < samples.length; i++) {
      const s = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(p, s < 0 ? s * 0x8000 : s * 0x7fff, true);
      p += 2;
    }
    return new Blob([view], { type: 'audio/wav' });
  };

  const finishVoice = async () => {
    const pcm = recPcmRef.current;
    const rate = recSampleRateRef.current || 48000;
    const cancelled = recCancelledRef.current;
    teardownVoice();
    setIsRecording(false);
    setRecSeconds(0);
    recPcmRef.current = [];
    if (cancelled || !pcm.length) return;
    const wav = floatChunksToWav(pcm, rate);
    if (wav.size < 1600) return;
    setIsTranscribing(true);
    try {
      const text = await transcribeAudioBlob(wav);
      if (text) onTranscript(text);
    } catch { /* non-fatal */ }
    finally { setIsTranscribing(false); }
  };

  const drawWaveform = () => {
    const canvas = canvasRef.current;
    const analyser = recAnalyserRef.current;
    if (!canvas || !analyser) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    const W = canvas.clientWidth || 320, H = canvas.clientHeight || 36;
    canvas.width = W * dpr; canvas.height = H * dpr;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const STEP = 6;
    const BAR_W = 3;
    const SAMPLE_MS = 55;
    const COL = '106,124,61';
    const maxBars = Math.max(8, Math.floor(W / STEP));
    const data = new Uint8Array(analyser.fftSize);

    recBarsRef.current = [];
    recLastSampleRef.current = 0;

    const dot = (x: number, mid: number, alpha: number, h = BAR_W) => {
      ctx.fillStyle = `rgba(${COL},${alpha})`;
      const y = mid - h / 2;
      if ((ctx as any).roundRect) { ctx.beginPath(); (ctx as any).roundRect(x, y, BAR_W, h, BAR_W / 2); ctx.fill(); }
      else ctx.fillRect(x, y, BAR_W, h);
    };

    const render = (t: number) => {
      if (!recAnalyserRef.current) return;
      analyser.getByteTimeDomainData(data);
      let peak = 0;
      for (let i = 0; i < data.length; i++) {
        const d = Math.abs(data[i] - 128);
        if (d > peak) peak = d;
      }
      const amp = Math.min(1, (peak / 128) * 1.6);
      if (!recLastSampleRef.current || t - recLastSampleRef.current >= SAMPLE_MS) {
        recLastSampleRef.current = t;
        recBarsRef.current.push(amp);
        if (recBarsRef.current.length > maxBars) recBarsRef.current.shift();
      }
      const bars = recBarsRef.current;
      const mid = H / 2;
      ctx.clearRect(0, 0, W, H);
      for (let i = 0; i < bars.length; i++) {
        const v = bars[i];
        const barH = Math.max(BAR_W, v * (H - 4));
        dot(i * STEP + 1, mid, 0.4 + v * 0.6, barH);
      }
      for (let i = bars.length; i < maxBars; i++) dot(i * STEP + 1, mid, 0.16);
      recRafRef.current = requestAnimationFrame(render);
    };
    recRafRef.current = requestAnimationFrame(render);
  };

  useEffect(() => {
    if (isRecording) drawWaveform();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isRecording]);

  useEffect(() => () => teardownVoice(), []);

  const startVoice = async () => {
    if (isRecording || disabled || isTranscribing) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      recStreamRef.current = stream;
      recCancelledRef.current = false;
      recPcmRef.current = [];

      const Ctx = window.AudioContext || (window as any).webkitAudioContext;
      const audioCtx = new Ctx();
      await audioCtx.resume().catch(() => {});
      recAudioCtxRef.current = audioCtx;
      recSampleRateRef.current = audioCtx.sampleRate;

      const source = audioCtx.createMediaStreamSource(stream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      recAnalyserRef.current = analyser;

      const processor = audioCtx.createScriptProcessor(4096, 1, 1);
      processor.onaudioprocess = (e) => {
        if (recCancelledRef.current) return;
        recPcmRef.current.push(new Float32Array(e.inputBuffer.getChannelData(0)));
      };
      const sink = audioCtx.createGain();
      sink.gain.value = 0;
      source.connect(processor);
      processor.connect(sink);
      sink.connect(audioCtx.destination);
      recProcessorRef.current = processor;
      recSinkRef.current = sink;

      setRecSeconds(0);
      setIsRecording(true);
      recTimerRef.current = setInterval(() => setRecSeconds(s => s + 1), 1000);
    } catch {
      teardownVoice();
      setIsRecording(false);
    }
  };

  const confirmVoice = () => { recCancelledRef.current = false; void finishVoice(); };
  const cancelVoice = () => { recCancelledRef.current = true; void finishVoice(); };
  const fmtRec = (s: number) => `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;

  return { isRecording, isTranscribing, recSeconds, canvasRef, startVoice, confirmVoice, cancelVoice, fmtRec };
}
