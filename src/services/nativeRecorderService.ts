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

/**
 * Stop the native batch recording. Rust now writes the WAV to a temp file on
 * disk and returns its PATH (instead of base64-ing the whole file across the
 * IPC bridge). We read the bytes from that path and wrap them in a File so the
 * downstream merge/compress/split pipeline is unchanged.
 *
 * Returns a File with a friendly display name; the on-disk path is attached as
 * `.diskPath` so cleanup (`deleteRecordingFile`) can remove the temp file once
 * the batch completes — WITHOUT exposing the raw path in the UI title.
 */
export async function stopSystemAudioRecording(): Promise<File> {
  const path = await tauriInvoke<string>('stop_system_audio');

  // Read the file from disk via the fs plugin (streamed by Rust, no base64).
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const bytes = await readFile(path);

  const blob = new Blob([bytes], { type: 'audio/wav' });
  // Friendly display name (used as the default meeting title); the actual disk
  // path is kept on `.diskPath` for cleanup only.
  const friendlyName = `Recording_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`;
  const file = new File([blob], friendlyName, { type: 'audio/wav' });
  (file as any).diskPath = path;
  return file;
}

/**
 * Delete a recording temp file written by stopSystemAudioRecording. Best-effort
 * — safe to call with a missing path. Pass the File's `diskPath`/`.name`.
 */
export async function deleteRecordingFile(path: string): Promise<void> {
  if (!isTauri() || !path) return;
  try {
    await tauriInvoke<void>('delete_recording_file', { path });
  } catch {
    /* non-fatal — startup sweep / OS temp cleanup will catch it */
  }
}

/**
 * Startup safety-net: purge recording temp files left orphaned by a crash.
 * Returns the count removed. No-op outside Tauri.
 */
export async function sweepOldRecordings(maxAgeSecs = 24 * 60 * 60): Promise<number> {
  if (!isTauri()) return 0;
  try {
    return await tauriInvoke<number>('sweep_old_recordings', { maxAgeSecs });
  } catch {
    return 0;
  }
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

/** `language`: Deepgram model language — 'en' (default, best for English) or 'multi'
 *  (multilingual code-switching) or any supported code. Persisted via the transcription
 *  language preference; falls back to English. */
export async function startRealtimeRecording(apiKey: string, keyterms: string[] = [], language?: string): Promise<void> {
  const lang = (language && language.trim()) || (typeof localStorage !== 'undefined' && localStorage.getItem('transcriptionLanguage')) || 'en';
  await tauriInvoke<void>('start_realtime_audio', { apiKey, keyterms, language: lang });
}

export async function stopRealtimeRecording(): Promise<string> {
  return await tauriInvoke<string>('stop_realtime_audio');
}

/** Pause realtime recording: releases the mic but keeps the Deepgram socket warm.
 *  Near-instant — no pipeline teardown/rebuild. Throws on an older binary that lacks
 *  the command, so callers can fall back to stop/start emulation. */
export async function pauseRealtimeRecording(): Promise<void> {
  await tauriInvoke<void>('pause_realtime_audio');
}

/** Resume realtime recording: rebuilds only the mic capture; the warm socket continues. */
export async function resumeRealtimeRecording(): Promise<void> {
  await tauriInvoke<void>('resume_realtime_audio');
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
    // Protocol: "[FINAL|Label] text" or "[INTERIM|Label] text". Label is already resolved by
    // the native side: "You" (your mic) or "Speaker N" (a remote participant).
    const match = raw.match(/^\[(FINAL|INTERIM)\|([^\]]*)\]\s*(.*)/s);
    if (!match) return;
    const isFinal = match[1] === 'FINAL';
    const label = (match[2] || '').trim();
    const clean = match[3].trim();
    if (!clean) return;

    if (label) {
      const alreadyLabeled = new RegExp(`^${label}\\s*:`, 'i').test(clean);
      const displayText = alreadyLabeled ? clean : `${label}: ${clean}`;
      onTranscript(displayText, isFinal, label);
      return;
    }
    onTranscript(clean, isFinal, undefined);
  });

  return unlisten;
}
