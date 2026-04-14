const REALTIME_WS_URL = 'ws://localhost:3030/ws';

export type RecordingMode = 'batch' | 'realtime';

// ─── Tauri Detection ─────────────────────────────────────────────────────────

const isTauri = (): boolean => !!(window as any).__TAURI_INTERNALS__;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ─── System Audio (Batch) — via Tauri commands ───────────────────────────────

export async function checkSystemAudioAvailable(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke<boolean>('is_system_audio_available');
  } catch {
    return false;
  }
}

export async function startSystemAudioRecording(): Promise<void> {
  await tauriInvoke<void>('start_system_audio');
}

export async function stopSystemAudioRecording(): Promise<File> {
  const base64Wav = await tauriInvoke<string>('stop_system_audio');

  // Decode base64 to WAV File
  const binaryStr = atob(base64Wav);
  const bytes = new Uint8Array(binaryStr.length);
  for (let i = 0; i < binaryStr.length; i++) {
    bytes[i] = binaryStr.charCodeAt(i);
  }
  const blob = new Blob([bytes], { type: 'audio/wav' });
  const filename = `Recording_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  return new File([blob], filename, { type: 'audio/wav' });
}

export async function isSystemAudioRecording(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke<boolean>('is_system_audio_recording');
  } catch {
    return false;
  }
}

// ─── Real-time Transcription — via web_transcribe WS ─────────────────────────
// User runs separately: cd record_system_audio && export DEEPGRAM_API_KEY="..." && cargo run --release --bin web_transcribe

export async function checkRealtimeServerAvailable(): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      const ws = new WebSocket(REALTIME_WS_URL);
      const timeout = setTimeout(() => { ws.close(); resolve(false); }, 2000);
      ws.onopen = () => { clearTimeout(timeout); ws.close(); resolve(true); };
      ws.onerror = () => { clearTimeout(timeout); resolve(false); };
    } catch {
      resolve(false);
    }
  });
}

export function connectTranscriptStream(
  onTranscript: (text: string, isFinal: boolean) => void,
  onError?: (err: Event) => void,
  onClose?: () => void,
): WebSocket {
  const ws = new WebSocket(REALTIME_WS_URL);

  ws.onopen = () => {
    console.log('[RealtimeWS] Connected to web_transcribe');
  };

  ws.onmessage = (event) => {
    const raw = event.data as string;
    // Format from web_transcribe: [FINAL:speaker] text  or  [INTERIM:speaker] text
    // speaker can be: 0, 1, mic:0, mic:1, U, etc.
    const match = raw.match(/^\[(FINAL|INTERIM)[:\w]*\]\s*(.*)/);
    if (!match) return;
    const isFinal = match[1] === 'FINAL';
    const clean = match[2].trim();
    if (clean) onTranscript(clean, isFinal);
  };

  if (onError) ws.onerror = onError;
  if (onClose) ws.onclose = () => onClose();

  return ws;
}
