export interface PermissionStatus {
  microphone: 'authorized' | 'denied' | 'not_determined' | 'unknown';
  screen_recording: 'authorized' | 'denied' | 'not_determined' | 'unknown';
}

const isTauri = (): boolean => !!(window as any).__TAURI_INTERNALS__;

async function tauriInvoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<T>(cmd, args);
}

export async function checkPermissions(): Promise<PermissionStatus> {
  if (!isTauri()) {
    return { microphone: 'authorized', screen_recording: 'authorized' };
  }
  try {
    return await tauriInvoke<PermissionStatus>('check_permissions');
  } catch {
    return { microphone: 'unknown', screen_recording: 'unknown' };
  }
}

export async function requestMicrophonePermission(): Promise<boolean> {
  if (!isTauri()) return true;
  try {
    return await tauriInvoke<boolean>('request_microphone_permission');
  } catch {
    return false;
  }
}

export async function openScreenRecordingSettings(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('open_screen_recording_settings');
}

export async function openMicrophoneSettings(): Promise<void> {
  if (!isTauri()) return;
  await tauriInvoke<void>('open_microphone_settings');
}
