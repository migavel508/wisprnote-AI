import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = !!(window as any).__TAURI_INTERNALS__;
const httpFetch = isTauri ? (tauriFetch as unknown as typeof globalThis.fetch) : globalThis.fetch;

export interface Workspace {
  id: string;
  user_id: string;
  name: string;
  emoji: string;
  color: string;
  created_at: string;
  updated_at: string;
}

export interface Folder {
  id: string;
  workspace_id: string;
  user_id: string;
  name: string;
  created_at: string;
}

export interface WorkspaceMember {
  id: string;
  workspace_id: string;
  email: string;
  role: 'viewer' | 'editor' | 'admin';
  invited_at: string;
}

export interface WorkspaceMeeting {
  id: string;
  filename: string;
  created_at: string;
  duration: number;
  status: string;
  summary: string | null;
}

export interface Contact {
  name: string;
  role: string | null;
  email: string | null;
  company: string | null;
  meeting_count: number;
  last_seen: string;
  task_ids: string[];
}

async function apiRequest<T = any>(method: string, path: string, body?: any): Promise<T> {
  const token = await getIdToken();
  const resp = await httpFetch(`${API_BASE}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!resp.ok) {
    const text = await resp.text();
    let msg: string;
    try { msg = JSON.parse(text).message; } catch { msg = text; }
    throw Object.assign(new Error(msg || `API ${resp.status}`), { status: resp.status });
  }
  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// ── Workspaces ────────────────────────────────────────────────────────────────

export const getWorkspaces = (): Promise<Workspace[]> =>
  apiRequest('GET', '/workspaces');

export const getWorkspacesForTask = (taskId: string): Promise<(Workspace & { has_task: boolean })[]> =>
  apiRequest('GET', `/workspaces?task_id=${encodeURIComponent(taskId)}`);

export const createWorkspace = (name: string, emoji = '🗂️', color = '#f06060'): Promise<Workspace> =>
  apiRequest('POST', '/workspaces', { name, emoji, color });

export const updateWorkspace = (id: string, data: Partial<Pick<Workspace, 'name' | 'emoji' | 'color'>>): Promise<Workspace> =>
  apiRequest('PUT', `/workspaces/${id}`, data);

export const deleteWorkspace = (id: string): Promise<void> =>
  apiRequest('DELETE', `/workspaces/${id}`);

// ── Folders ───────────────────────────────────────────────────────────────────

export const getFolders = (workspaceId: string): Promise<Folder[]> =>
  apiRequest('GET', `/workspaces/${workspaceId}/folders`);

export const createFolder = (workspaceId: string, name: string): Promise<Folder> =>
  apiRequest('POST', `/workspaces/${workspaceId}/folders`, { name });

export const renameFolder = (folderId: string, name: string): Promise<Folder> =>
  apiRequest('PUT', `/folders/${folderId}`, { name });

export const deleteFolder = (folderId: string): Promise<void> =>
  apiRequest('DELETE', `/folders/${folderId}`);

// ── Workspace meetings ────────────────────────────────────────────────────────

export const getWorkspaceMeetings = (workspaceId: string): Promise<WorkspaceMeeting[]> =>
  apiRequest('GET', `/workspaces/${workspaceId}/meetings`);

export const addMeetingToWorkspace = (workspaceId: string, taskId: string): Promise<void> =>
  apiRequest('POST', `/workspaces/${workspaceId}/meetings`, { task_id: taskId });

export const removeMeetingFromWorkspace = (workspaceId: string, taskId: string): Promise<void> =>
  apiRequest('DELETE', `/workspaces/${workspaceId}/meetings/${taskId}`);

// ── Folder meetings ───────────────────────────────────────────────────────────

export const getFolderMeetings = (folderId: string): Promise<WorkspaceMeeting[]> =>
  apiRequest('GET', `/folders/${folderId}/meetings`);

export const addMeetingToFolder = (folderId: string, taskId: string): Promise<void> =>
  apiRequest('POST', `/folders/${folderId}/meetings`, { task_id: taskId });

export const removeMeetingFromFolder = (folderId: string, taskId: string): Promise<void> =>
  apiRequest('DELETE', `/folders/${folderId}/meetings/${taskId}`);

// ── Members ───────────────────────────────────────────────────────────────────

export const getWorkspaceMembers = (workspaceId: string): Promise<WorkspaceMember[]> =>
  apiRequest('GET', `/workspaces/${workspaceId}/members`);

export const addWorkspaceMember = (workspaceId: string, email: string, role: WorkspaceMember['role'] = 'viewer'): Promise<WorkspaceMember> =>
  apiRequest('POST', `/workspaces/${workspaceId}/members`, { email, role });

export const removeWorkspaceMember = (workspaceId: string, email: string): Promise<void> =>
  apiRequest('DELETE', `/workspaces/${workspaceId}/members/${encodeURIComponent(email)}`);

// ── Contacts ──────────────────────────────────────────────────────────────────

export const getContacts = (): Promise<Contact[]> =>
  apiRequest('GET', '/contacts');
