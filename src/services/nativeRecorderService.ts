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

// ─── Real-time Transcription — Integrated via Tauri commands + events ────────
// No separate server needed! Audio capture + Deepgram streaming runs inside the Tauri app.

export async function startRealtimeRecording(apiKey: string, keyterms: string[] = []): Promise<void> {
  await tauriInvoke<void>('start_realtime_audio', { apiKey, keyterms });
}

export async function stopRealtimeRecording(): Promise<string> {
  return await tauriInvoke<string>('stop_realtime_audio');
}

export async function isRealtimeRecording(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke<boolean>('is_realtime_recording');
  } catch {
    return false;
  }
}

export async function listenForTranscripts(
  onTranscript: (text: string, isFinal: boolean, speaker?: string) => void,
): Promise<() => void> {
  const { listen } = await import('@tauri-apps/api/event');

  const unlisten = await listen<string>('realtime-transcript', (event) => {
    const raw = event.payload;
    // Format: [FINAL:speaker] text  or  [INTERIM:speaker] text
    const match = raw.match(/^\[(FINAL|INTERIM):([^\]]+)\]\s*(.*)/);
    if (!match) return;
    const isFinal = match[1] === 'FINAL';
    const speakerRaw = match[2]?.trim();
    const clean = match[3].trim();
    if (!clean) return;

    const speaker = speakerRaw && speakerRaw !== 'U' ? speakerRaw : undefined;
    if (speaker) {
      // User-facing speaker labels (Deepgram starts speakers at 0).
      const speakerNum = Number(speaker);
      const safeSpeaker = Number.isFinite(speakerNum) ? `Speaker ${speakerNum + 1}` : `Speaker ${speaker}`;
      const alreadyLabeled = /^speaker\s+\d+:/i.test(clean);
      const displayText = alreadyLabeled ? clean : `${safeSpeaker}: ${clean}`;
      onTranscript(displayText, isFinal, speaker);
      return;
    }

    onTranscript(clean, isFinal, undefined);
  });

  return unlisten;
}
