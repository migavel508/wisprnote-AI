// Meeting / microphone detection bridge.
//
// The Rust backend polls CoreAudio for apps actively using the mic and emits
// `mic-detected` / `mic-stopped` events. This module wraps those events plus the
// commands that pause detection and drive the floating recording indicator
// overlay window. All functions are safe no-ops outside Tauri (e.g. web build).

const isTauri = (): boolean => !!(window as any).__TAURI_INTERNALS__;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export interface MicDetectedPayload {
  bundle_id: string;
  app_name: string;
}

/** State pushed to the floating recording indicator overlay window. */
export interface RecordingIndicatorState {
  recording: boolean;
  paused: boolean;
  seconds: number;
  label: string | null;
  /** Recent transcript text (newline-joined) for the hover panel. */
  transcript?: string;
}

/** Listen for "an app started using the mic past the threshold" events. */
export async function listenForMicDetected(
  cb: (payload: MicDetectedPayload) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<MicDetectedPayload>('mic-detected', (e) => cb(e.payload));
}

/** Listen for "all mic-using apps released the mic" events. */
export async function listenForMicStopped(cb: () => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen('mic-stopped', () => cb());
}

/** Fetch the most recent detection (used by the prompt window on open). */
export async function getPendingMeeting(): Promise<MicDetectedPayload | null> {
  if (!isTauri()) return null;
  try {
    return (await tauriInvoke<MicDetectedPayload | null>('get_pending_meeting')) ?? null;
  } catch {
    return null;
  }
}

/** Show or hide the always-on-top "Are you in a meeting?" prompt overlay window. */
export async function setMeetingPrompt(visible: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('set_meeting_prompt', { visible });
  } catch {
    /* non-fatal */
  }
}

/** (Prompt window) Tell the main app to start a meeting recording with a label. */
export async function emitMeetingPromptStart(label: string | null): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('meeting-prompt-start', { label });
  } catch {
    /* non-fatal */
  }
}

/** (Main app) Listen for the prompt window's "start recording" action. */
export async function listenForMeetingPromptStart(
  cb: (label: string | null) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ label: string | null }>('meeting-prompt-start', (e) => cb(e.payload?.label ?? null));
}

/**
 * Bring the main window to the front. Overlay windows call this right before
 * asking the main app to start/stop recording: macOS throttles a backgrounded
 * WebView's timers, so foregrounding it first makes the action fire immediately
 * instead of lagging by seconds (the cause of "I had to click many times").
 */
export async function focusMainWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('focus_main_window');
  } catch {
    /* non-fatal */
  }
}

/** (Prompt window) Hide this overlay window. */
export async function hideMeetingPromptWindow(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().hide();
  } catch {
    /* non-fatal */
  }
}

/** Pause detection while we record (so our own capture doesn't self-trigger). */
export async function setDetectionPaused(paused: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('set_detection_paused', { paused });
  } catch {
    /* non-fatal */
  }
}

/** Enable/disable detection (enabled once signed in; off on the auth screen). */
export async function setDetectionEnabled(enabled: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('set_detection_enabled', { enabled });
  } catch {
    /* non-fatal */
  }
}

/**
 * Hold/release a macOS App Nap-disabling activity for the recording duration.
 * Called true on record start and false on stop, so the OS keeps the main
 * window's WebView responsive even when it's backgrounded behind a meeting.
 */
export async function setRecordingActive(active: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('set_recording_active', { active });
  } catch {
    /* non-fatal */
  }
}

/** Show or hide the always-on-top floating recording indicator window. */
export async function setRecordingIndicator(visible: boolean): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('set_recording_indicator', { visible });
  } catch {
    /* non-fatal — indicator is best-effort cosmetic UI */
  }
}

/**
 * Report the interactive content rectangle of an overlay window (window-logical
 * px, relative to the window's top-left). The Rust passthrough then makes the
 * window interactive ONLY over this rect, leaving the transparent area around it
 * click-through so it never blocks the screen beneath. anarlog's exact trick.
 */
export async function setOverlayHitBounds(
  label: string,
  bounds: { x: number; y: number; width: number; height: number },
): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('set_overlay_hit_bounds', { label, ...bounds });
  } catch {
    /* non-fatal */
  }
}

/** Clear an overlay's reported bounds (falls back to whole-window hit-testing). */
export async function clearOverlayHitBounds(label: string): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('clear_overlay_hit_bounds', { label });
  } catch {
    /* non-fatal */
  }
}

/** Broadcast the live recording state to the indicator window. */
export async function emitRecordingIndicatorState(state: RecordingIndicatorState): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('recording-indicator-state', state);
  } catch {
    /* non-fatal */
  }
}

/** (Indicator window) Listen for live recording-state pushes from the main app. */
export async function listenForRecordingIndicatorState(
  cb: (state: RecordingIndicatorState) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<RecordingIndicatorState>('recording-indicator-state', (e) => cb(e.payload));
}

/** (Indicator window) Ask the main app to stop recording — reuses the tray channel. */
export async function emitStopRecording(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('tray-record', 'stop');
  } catch {
    /* non-fatal */
  }
}

/** (Indicator window) Listen for the live mic level (0..1) from the capture
 * pipeline, pushed at ~25 fps while recording. Drives the waveform reliably
 * regardless of the overlay window's own microphone access. */
export async function listenForAudioLevel(cb: (level: number) => void): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<number>('audio-level', (e) => cb(typeof e.payload === 'number' ? e.payload : 0));
}

/** (Indicator window) Ask the main app to open chat (optionally pre-filled). */
export async function emitOpenChatFromIndicator(prompt?: string): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('recording-indicator-open-chat', { prompt: prompt ?? '' });
  } catch { /* non-fatal */ }
}

/** (Main app) Listen for the indicator's "open chat" request. */
export async function listenForOpenChatFromIndicator(
  cb: (prompt: string) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  return listen<{ prompt: string }>('recording-indicator-open-chat', (e) => cb(e.payload?.prompt ?? ''));
}

/** (Indicator window) Pause/resume the main app's recording via the tray channel. */
export async function emitPauseRecording(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('tray-record', 'pause');
  } catch { /* non-fatal */ }
}

export async function emitResumeRecording(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { emit } = await import('@tauri-apps/api/event');
    await emit('tray-record', 'resume');
  } catch { /* non-fatal */ }
}
