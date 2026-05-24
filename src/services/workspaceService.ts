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
  // Client-side overlay (stored in localStorage):
  emoji?: string;
  color?: string;
  description?: string;
  iconType?: 'icon' | 'emoji';
  iconName?: string;
}

export const DEFAULT_WORKSPACE_NAME = 'My notes';
export const DEFAULT_WORKSPACE_EMOJI = '🔒';

export function isDefaultWorkspace(ws: Workspace | null | undefined): boolean {
  return !!ws && ws.name === DEFAULT_WORKSPACE_NAME;
}

// ── Client-side metadata overlay (folders + workspace description) ────────────
// The backend doesn't store these — we keep them in localStorage so the UI can
// match the design (folder icon/color/description, workspace description).

interface FolderMeta {
  emoji?: string;
  color?: string;
  description?: string;
  iconType?: 'icon' | 'emoji';
  iconName?: string;
  favorite?: boolean;
}

const FOLDER_META_KEY = 'wn.folderMeta.v1';
const WORKSPACE_META_KEY = 'wn.workspaceMeta.v1';

function readMap<T>(key: string): Record<string, T> {
  try { return JSON.parse(localStorage.getItem(key) || '{}'); } catch { return {}; }
}
function writeMap<T>(key: string, map: Record<string, T>) {
  try { localStorage.setItem(key, JSON.stringify(map)); } catch {}
}

export function getFolderMeta(folderId: string): FolderMeta {
  return readMap<FolderMeta>(FOLDER_META_KEY)[folderId] || {};
}
export function setFolderMeta(folderId: string, meta: Partial<FolderMeta>) {
  const all = readMap<FolderMeta>(FOLDER_META_KEY);
  all[folderId] = { ...(all[folderId] || {}), ...meta };
  writeMap(FOLDER_META_KEY, all);
}
export function deleteFolderMeta(folderId: string) {
  const all = readMap<FolderMeta>(FOLDER_META_KEY);
  delete all[folderId];
  writeMap(FOLDER_META_KEY, all);
}

export function getWorkspaceDescription(workspaceId: string): string {
  return readMap<string>(WORKSPACE_META_KEY)[workspaceId] || '';
}
export function setWorkspaceDescription(workspaceId: string, description: string) {
  const all = readMap<string>(WORKSPACE_META_KEY);
  all[workspaceId] = description;
  writeMap(WORKSPACE_META_KEY, all);
}

// Workspace avatar image (data URL or remote URL). Stored separately so
// description text and image don't collide.
const WORKSPACE_IMAGE_KEY = 'wn.workspaceImage.v1';

export function getWorkspaceImage(workspaceId: string): string | null {
  return readMap<string>(WORKSPACE_IMAGE_KEY)[workspaceId] || null;
}
export function setWorkspaceImage(workspaceId: string, dataUrl: string | null) {
  const all = readMap<string>(WORKSPACE_IMAGE_KEY);
  if (dataUrl) all[workspaceId] = dataUrl;
  else delete all[workspaceId];
  writeMap(WORKSPACE_IMAGE_KEY, all);
}

// Deterministic gradient from a string (used for letter-avatar fallbacks).
const GRADIENT_PAIRS: [string, string, string][] = [
  ['#6366f1', '#3b82f6', '#f59e0b'], // indigo → blue → amber (Granola default)
  ['#8b5cf6', '#ec4899', '#f97316'], // purple → pink → orange
  ['#10b981', '#06b6d4', '#3b82f6'], // emerald → cyan → blue
  ['#ef4444', '#f59e0b', '#fbbf24'], // red → amber → yellow
  ['#0ea5e9', '#8b5cf6', '#ec4899'], // sky → purple → pink
  ['#84cc16', '#10b981', '#06b6d4'], // lime → emerald → cyan
];
export function getAvatarGradient(seed: string): [string, string, string] {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = ((hash << 5) - hash + seed.charCodeAt(i)) | 0;
  const idx = Math.abs(hash) % GRADIENT_PAIRS.length;
  return GRADIENT_PAIRS[idx];
}

// Prefer fields the server sent; fall back to the localStorage overlay so the
// UI still works while the backend migration is in flight.
function hydrateFolder(f: Folder): Folder {
  const meta = getFolderMeta(f.id);
  return {
    ...meta,
    ...f,
    iconType: (f as any).icon_type ?? f.iconType ?? meta.iconType,
    iconName: (f as any).icon_name ?? f.iconName ?? meta.iconName,
    emoji: f.emoji ?? meta.emoji,
    color: f.color ?? meta.color,
    description: f.description ?? meta.description,
  };
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

export const createWorkspace = (
  name: string,
  emoji = '🗂️',
  color = '#f06060',
  extras: { description?: string; image_url?: string } = {}
): Promise<Workspace> =>
  apiRequest('POST', '/workspaces', { name, emoji, color, ...extras });

export const updateWorkspace = (
  id: string,
  data: Partial<Pick<Workspace, 'name' | 'emoji' | 'color'>> & { description?: string; image_url?: string | null }
): Promise<Workspace> =>
  apiRequest('PUT', `/workspaces/${id}`, data);

export const deleteWorkspace = (id: string): Promise<void> =>
  apiRequest('DELETE', `/workspaces/${id}`);

// ── Folders ───────────────────────────────────────────────────────────────────

export const getFolders = async (workspaceId: string): Promise<Folder[]> => {
  const folders = await apiRequest<Folder[]>('GET', `/workspaces/${workspaceId}/folders`);
  return folders.map(hydrateFolder);
};

export const createFolder = async (
  workspaceId: string,
  name: string,
  meta?: { emoji?: string; color?: string; description?: string; iconType?: 'icon' | 'emoji'; iconName?: string }
): Promise<Folder> => {
  const f = await apiRequest<Folder>('POST', `/workspaces/${workspaceId}/folders`, {
    name,
    emoji: meta?.emoji ?? null,
    color: meta?.color ?? null,
    description: meta?.description ?? '',
    icon_type: meta?.iconType ?? 'icon',
    icon_name: meta?.iconName ?? null,
  });
  // Keep localStorage in sync so the UI keeps working even on older backends.
  if (meta) setFolderMeta(f.id, meta);
  return hydrateFolder(f);
};

export const renameFolder = (folderId: string, name: string): Promise<Folder> =>
  apiRequest('PUT', `/folders/${folderId}`, { name });

export const updateFolderMeta = (
  folderId: string,
  meta: { emoji?: string; color?: string; description?: string; iconType?: 'icon' | 'emoji'; iconName?: string; favorite?: boolean }
) => setFolderMeta(folderId, meta);

export const deleteFolder = async (folderId: string): Promise<void> => {
  await apiRequest('DELETE', `/folders/${folderId}`);
  deleteFolderMeta(folderId);
};

// ── Ensure default "My notes" workspace exists for the user ───────────────────
export async function ensureDefaultWorkspace(): Promise<Workspace[]> {
  let workspaces = await getWorkspaces();
  const hasDefault = workspaces.some(w => w.name === DEFAULT_WORKSPACE_NAME);
  if (!hasDefault) {
    try {
      const ws = await createWorkspace(DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_EMOJI, '#71717a');
      workspaces = [ws, ...workspaces];
    } catch { /* ignore — user may be offline */ }
  }
  // Sort so default is always first.
  return workspaces.sort((a, b) => {
    if (a.name === DEFAULT_WORKSPACE_NAME) return -1;
    if (b.name === DEFAULT_WORKSPACE_NAME) return 1;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });
}

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
