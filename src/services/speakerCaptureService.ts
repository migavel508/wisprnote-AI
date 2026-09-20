// ─── Speaker-name capture: the client half ─────────────────────────────────────
//
// Starts/stops the native accessibility poller that reads the meeting app's own
// participant tiles, and streams its observations into a `SpeakerObservationLog`.
//
// This is the ONLY source of real names. Diarisation separates voices; it cannot
// know a voice belongs to Ada. See `speakerObservations.ts` for how a name is
// joined to a transcript turn.

import { logger } from '../lib/logger';
import type { SpeakerObservation, AttributionState } from './speakerObservations';

const log = logger.scope('SpeakerCapture');

const isTauri = (): boolean => !!(window as any).__TAURI_INTERNALS__;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

/** Which capture strategy the native side bound to. */
export type CapturePlatform = 'zoom' | 'google_meet' | 'teams' | 'slack' | 'unsupported';

/** Raw event payload from Rust. */
interface SpeakerChangePayload {
  speaker_name: string | null;
  visible_names: string[];
  attribution_state: AttributionState;
  platform: CapturePlatform;
  timestamp_ms: number;
}

export async function isAccessibilityTrusted(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke<boolean>('accessibility_is_trusted');
  } catch {
    return false;
  }
}

/**
 * Show the system Accessibility prompt.
 *
 * macOS shows this dialog only ONCE per app. A false return after a previous
 * denial means the user must be sent to System Settings — calling again would do
 * nothing visible and look like a broken button.
 */
export async function requestAccessibilityTrust(): Promise<boolean> {
  if (!isTauri()) return false;
  try {
    return await tauriInvoke<boolean>('accessibility_request_trust');
  } catch {
    return false;
  }
}

export async function openAccessibilitySettings(): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('open_accessibility_settings');
  } catch {
    /* opening settings is best-effort */
  }
}

/**
 * Begin capturing active-speaker names.
 *
 * The native side finds the meeting app itself: the microphone-holder signal that
 * drives the meeting prompt is unset when the user records by hand, so depending on
 * it made capture silently do nothing.
 *
 * Resolves to the bound platform. `'unsupported'` means the meeting is recorded
 * and transcribed normally but the app publishes no readable participant grid
 * (FaceTime, Webex, Discord) — speakers stay "Speaker N" until renamed. That is a
 * limitation of those apps, not a failure here, so it is NOT surfaced as an error.
 */
export async function startSpeakerCapture(
  overrides?: { markerClasses?: string[]; tileRootClasses?: string[] }
): Promise<CapturePlatform> {
  if (!isTauri()) return 'unsupported';
  try {
    const platform = await tauriInvoke<string>('start_speaker_capture', {
      markerClasses: overrides?.markerClasses ?? null,
      tileRootClasses: overrides?.tileRootClasses ?? null,
    });
    log.info('speaker_capture_started', { platform });
    return platform as CapturePlatform;
  } catch (e) {
    const reason = String((e as any)?.message ?? e);
    if (reason.includes('accessibility_permission_required')) {
      log.warn('speaker_capture_needs_permission', {});
    } else {
      log.warn('speaker_capture_start_failed', { reason });
    }
    return 'unsupported';
  }
}

/** What the accessibility read sees right now — for diagnosing a live meeting. */
export interface CaptureProbe {
  accessibility_trusted: boolean;
  platform: CapturePlatform;
  pid?: number | null;
  reading?: {
    speaker_name: string | null;
    visible_names: string[];
    attribution_state: AttributionState;
  } | null;
}

export async function probeSpeakerCapture(): Promise<CaptureProbe | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<CaptureProbe>('speaker_capture_probe');
  } catch {
    return null;
  }
}

export async function stopSpeakerCapture(): Promise<void> {
  if (!isTauri()) return;
  try {
    await tauriInvoke<void>('stop_speaker_capture');
  } catch {
    /* stopping is best-effort — the poller also exits with the session */
  }
}

/**
 * Subscribe to speaker-change events. Returns an unlisten function.
 *
 * Rust emits only on CHANGE, not every poll tick, so each event is a genuine
 * transition and the observation log stays proportional to the conversation
 * rather than to the clock.
 */
export async function listenForSpeakerChanges(
  onChange: (obs: SpeakerObservation) => void
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');
  const unlisten = await listen<SpeakerChangePayload>('meeting-speaker-change', (event) => {
    const p = event.payload;
    onChange({
      speakerName: p.speaker_name,
      visibleNames: p.visible_names ?? [],
      attributionState: p.attribution_state,
      timestampMs: p.timestamp_ms,
    });
  });
  return unlisten;
}
