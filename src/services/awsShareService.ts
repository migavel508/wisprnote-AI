import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';
import { logger } from '../lib/logger';

const log = logger.scope('AWSShare');

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = !!(window as any).__TAURI_INTERNALS__;
const httpFetch = isTauri ? (tauriFetch as unknown as typeof globalThis.fetch) : globalThis.fetch;

// ---------------------------------------------------------------------------
// Types (same as original shareService)
// ---------------------------------------------------------------------------

export interface SharedMeeting {
  id: string;
  task_id: string;
  owner_id: string;
  share_token: string;
  access_type: 'public' | 'restricted';
  permissions: string[];
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SharedMeetingAccess {
  id: string;
  share_id: string;
  email: string;
  accessed_at: string | null;
  created_at: string;
}

export interface SharedMeetingData {
  filename: string;
  summary: string | null;
  notes: string | null;
  created_at: string | null;
  duration: number;
  permissions: string[];
  owner_name?: string;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function apiRequest<T = any>(method: string, path: string, body?: any, requireAuth = true): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (requireAuth) {
    headers['Authorization'] = await getIdToken();
  }

  const resp = await httpFetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    let errorObj: any;
    try { errorObj = JSON.parse(errorText); } catch { errorObj = { message: errorText }; }
    throw Object.assign(new Error(errorObj.message || `API ${resp.status}`), { status: resp.status });
  }

  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Owner Operations
// ---------------------------------------------------------------------------

export async function createShare(
  taskId: string,
  accessType: 'public' | 'restricted' = 'public',
  emails: string[] = [],
): Promise<SharedMeeting> {
  const data = await apiRequest<SharedMeeting>('POST', '/shares', {
    task_id: taskId,
    access_type: accessType,
    emails,
  });
  log.info('share_created', { shareId: data.id, accessType });
  return data;
}

export async function getShareByTaskId(taskId: string): Promise<SharedMeeting | null> {
  try {
    return await apiRequest<SharedMeeting>('GET', `/shares?taskId=${taskId}`);
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function updateShareAccess(
  shareId: string,
  accessType: 'public' | 'restricted',
): Promise<SharedMeeting> {
  const data = await apiRequest<SharedMeeting>('PUT', `/shares/${shareId}`, { access_type: accessType });
  log.info('share_updated', { shareId, accessType });
  return data;
}

export async function revokeShare(shareId: string): Promise<void> {
  await apiRequest('PUT', `/shares/${shareId}`, { is_active: false });
  log.info('share_revoked', { shareId });
}

export async function reactivateShare(shareId: string): Promise<void> {
  await apiRequest('PUT', `/shares/${shareId}`, { is_active: true });
  log.info('share_reactivated', { shareId });
}

export async function deleteShare(shareId: string): Promise<void> {
  await apiRequest('DELETE', `/shares/${shareId}`);
  log.info('share_deleted', { shareId });
}

// ---------------------------------------------------------------------------
// Email Access Management
// ---------------------------------------------------------------------------

export async function addShareEmails(shareId: string, emails: string[]): Promise<void> {
  await apiRequest('POST', `/shares/${shareId}/emails`, { emails });
}

export async function removeShareEmail(shareId: string, email: string): Promise<void> {
  await apiRequest('DELETE', `/shares/${shareId}/emails/${encodeURIComponent(email)}`);
}

export async function getShareEmails(shareId: string): Promise<SharedMeetingAccess[]> {
  return apiRequest<SharedMeetingAccess[]>('GET', `/shares/${shareId}/emails`);
}

// ---------------------------------------------------------------------------
// Viewer Operations (NO AUTH REQUIRED for public shares)
// ---------------------------------------------------------------------------

export async function verifyShareAccess(
  shareToken: string,
  viewerEmail?: string | null,
): Promise<{ meeting: SharedMeetingData; share: SharedMeeting } | { denied: true; reason: string }> {
  const emailParam = viewerEmail ? `&email=${encodeURIComponent(viewerEmail)}` : '';
  return apiRequest(`GET`, `/shares/verify/${shareToken}?_=1${emailParam}`, undefined, false);
}

// ---------------------------------------------------------------------------
// URL Helpers
// ---------------------------------------------------------------------------

export function getShareUrl(shareToken: string): string {
  return `https://wisprnote.com/shared/${shareToken}`;
}

export function copyShareUrl(shareToken: string): void {
  const url = getShareUrl(shareToken);
  navigator.clipboard.writeText(url).catch(() => {
    const textarea = document.createElement('textarea');
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}
