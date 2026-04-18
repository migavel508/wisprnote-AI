/**
 * Audio Device Service — frontend interface for the Rust audio device backend.
 * Provides device enumeration, default device queries, and device change monitoring.
 * Mirrors functionality from the char application's audio-priority plugin.
 */

export type TransportType =
  | 'BuiltIn'
  | 'Usb'
  | 'Bluetooth'
  | 'Hdmi'
  | 'Virtual'
  | 'Unknown';

export type AudioDirection = 'Input' | 'Output';

export interface AudioDevice {
  id: string;
  name: string;
  direction: AudioDirection;
  transport_type: TransportType;
  is_default: boolean;
  is_headphone: boolean;
}

export type DeviceChangeType =
  | 'input-changed'
  | 'output-changed'
  | 'device-list-changed';

// ─── Tauri Detection ─────────────────────────────────────────────────────────

const isTauri = (): boolean => !!(window as any).__TAURI_INTERNALS__;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

// ─── Device Queries ──────────────────────────────────────────────────────────

export async function listAudioDevices(): Promise<AudioDevice[]> {
  if (!isTauri()) return [];
  try {
    return await tauriInvoke<AudioDevice[]>('list_audio_devices');
  } catch {
    return [];
  }
}

export async function listInputDevices(): Promise<AudioDevice[]> {
  const all = await listAudioDevices();
  return all.filter((d) => d.direction === 'Input');
}

export async function listOutputDevices(): Promise<AudioDevice[]> {
  const all = await listAudioDevices();
  return all.filter((d) => d.direction === 'Output');
}

export async function getDefaultInput(): Promise<AudioDevice | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<AudioDevice | null>('get_default_input');
  } catch {
    return null;
  }
}

export async function getDefaultOutput(): Promise<AudioDevice | null> {
  if (!isTauri()) return null;
  try {
    return await tauriInvoke<AudioDevice | null>('get_default_output');
  } catch {
    return null;
  }
}

// ─── Device Change Listener ──────────────────────────────────────────────────

export async function listenForDeviceChanges(
  onDeviceChange: (changeType: DeviceChangeType) => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');

  const unlisten = await listen<string>('audio-device-change', (event) => {
    onDeviceChange(event.payload as DeviceChangeType);
  });

  return unlisten;
}

export async function listenForDeviceRestart(
  onRestart: () => void,
): Promise<() => void> {
  if (!isTauri()) return () => {};
  const { listen } = await import('@tauri-apps/api/event');

  const unlisten = await listen<string>('audio-device-restart', () => {
    onRestart();
  });

  return unlisten;
}
