import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken, getUserId } from './awsAuthService';
import { logger } from '../lib/logger';

const log = logger.scope('AWSService');

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const S3_BUCKET = import.meta.env.VITE_S3_BUCKET || '';
const AWS_REGION = import.meta.env.VITE_AWS_REGION || 'us-east-1';
const isTauri = !!(window as any).__TAURI_INTERNALS__;

const httpFetch = isTauri ? (tauriFetch as unknown as typeof globalThis.fetch) : globalThis.fetch;

async function apiRequest<T = any>(
  method: string,
  path: string,
  body?: any,
  requireAuth = true
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requireAuth) {
    const token = await getIdToken();
    headers['Authorization'] = token;
  }

  const url = `${API_BASE}${path}`;
  const resp = await httpFetch(url, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const errorText = await resp.text();
    let errorObj: any;
    try { errorObj = JSON.parse(errorText); } catch { errorObj = { message: errorText }; }
    log.error('api_request_failed', { method, path, status: resp.status, error: errorObj });
    throw Object.assign(new Error(errorObj.message || `API ${resp.status}`), {
      status: resp.status,
      statusCode: resp.status,
    });
  }

  if (resp.status === 204) return undefined as T;

  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

// =====================================================
// TASK HISTORY
// =====================================================

export interface TaskHistory {
  id?: string;
  created_at?: string;
  user_id?: string;
  filename: string;
  transcription: string;
  summary?: string;
  notes?: string;
  audio_url?: string;
  status: 'completed' | 'error';
  duration: number;
  prompt?: string;
  personal_note?: string;
  visualization_image?: string;
}

export interface TaskMetadata {
  id: string;
  created_at: string;
  filename: string;
  summary?: string;
  status: 'completed' | 'error';
  duration: number;
}

export async function saveTask(task: TaskHistory): Promise<TaskHistory> {
  return apiRequest<TaskHistory>('POST', '/tasks', task);
}

export async function updatePersonalNote(taskId: string, content: string): Promise<void> {
  await apiRequest('PUT', `/tasks/${taskId}`, { personal_note: content });
}

export async function updateTaskTitle(taskId: string, newTitle: string): Promise<TaskHistory> {
  return apiRequest<TaskHistory>('PUT', `/tasks/${taskId}`, { filename: newTitle });
}

export async function updateTaskSummary(taskId: string, newSummary: string): Promise<TaskHistory> {
  return apiRequest<TaskHistory>('PUT', `/tasks/${taskId}`, { summary: newSummary });
}

export async function updateTaskNotes(taskId: string, newNotes: string): Promise<TaskHistory> {
  return apiRequest<TaskHistory>('PUT', `/tasks/${taskId}`, { notes: newNotes });
}

export async function updateTaskVisualization(taskId: string, imageBase64: string): Promise<TaskHistory> {
  return apiRequest<TaskHistory>('PUT', `/tasks/${taskId}`, { visualization_image: imageBase64 });
}

export async function getTasksLightweight(
  page: number = 0,
  pageSize: number = 20
): Promise<{ data: TaskMetadata[]; hasMore: boolean; total: number }> {
  return apiRequest('GET', `/tasks?page=${page}&pageSize=${pageSize}`);
}

export async function getTaskById(taskId: string): Promise<TaskHistory | null> {
  try {
    return await apiRequest<TaskHistory>('GET', `/tasks/${taskId}`);
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function getTasks(): Promise<TaskHistory[]> {
  const result = await apiRequest<{ data: TaskHistory[] }>('GET', '/tasks?full=true&pageSize=10000');
  return result.data;
}

// =====================================================
// GENERATED ASSETS
// =====================================================

export interface GeneratedAsset {
  id?: string;
  created_at?: string;
  user_id?: string;
  task_id: string;
  type: 'email' | 'wiki';
  filename: string;
  content: any;
}

export async function saveAsset(asset: GeneratedAsset): Promise<GeneratedAsset> {
  return apiRequest<GeneratedAsset>('POST', '/assets', asset);
}

export async function getAssets(taskId: string): Promise<GeneratedAsset[]> {
  return apiRequest<GeneratedAsset[]>('GET', `/assets?taskId=${taskId}`);
}

// =====================================================
// MANUAL NOTES
// =====================================================

export interface ManualNote {
  id?: string;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  title: string;
  content: string;
}

export async function saveManualNote(note: ManualNote): Promise<ManualNote> {
  return apiRequest<ManualNote>('POST', '/notes', note);
}

export async function getManualNotes(): Promise<ManualNote[]> {
  return apiRequest<ManualNote[]>('GET', '/notes');
}

export async function deleteManualNote(noteId: string): Promise<void> {
  await apiRequest('DELETE', `/notes/${noteId}`);
}

// =====================================================
// IMAGE UPLOAD (S3 presigned URL)
// =====================================================

export async function uploadNoteImage(file: File): Promise<string> {
  const { uploadUrl, publicUrl } = await apiRequest<{ uploadUrl: string; publicUrl: string }>(
    'POST',
    '/storage/presign',
    { filename: file.name, contentType: file.type }
  );

  const uploadResp = await httpFetch(uploadUrl, {
    method: 'PUT',
    headers: { 'Content-Type': file.type },
    body: file,
  });

  if (!uploadResp.ok) {
    throw new Error(`S3 upload failed: ${uploadResp.status}`);
  }

  return publicUrl;
}

// =====================================================
// KNOWLEDGE GRAPH
// =====================================================

export interface KnowledgeGraphEntry {
  id?: string;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  task_id: string;
  meeting_title: string;
  topics: Array<{ name: string; summary: string; status: string }>;
  decisions: Array<{ decision: string; relatedTopic: string }>;
  people: string[];
  action_items: Array<{ task: string; owner: string; relatedTopic: string }>;
  refs: string[];
}

export async function saveKnowledgeGraph(entry: KnowledgeGraphEntry): Promise<KnowledgeGraphEntry> {
  return apiRequest<KnowledgeGraphEntry>('POST', '/knowledge-graph', entry);
}

export async function saveKnowledgeGraphBatch(entries: KnowledgeGraphEntry[]): Promise<KnowledgeGraphEntry[]> {
  return apiRequest<KnowledgeGraphEntry[]>('POST', '/knowledge-graph', entries);
}

export async function getKnowledgeGraph(): Promise<KnowledgeGraphEntry[]> {
  return apiRequest<KnowledgeGraphEntry[]>('GET', '/knowledge-graph');
}

export async function getKnowledgeGraphForTask(taskId: string): Promise<KnowledgeGraphEntry | null> {
  try {
    return await apiRequest<KnowledgeGraphEntry>('GET', `/knowledge-graph/${taskId}`);
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function deleteKnowledgeGraph(taskId: string): Promise<void> {
  await apiRequest('DELETE', `/knowledge-graph/${taskId}`);
}

// =====================================================
// CHAT HISTORY
// =====================================================

export interface ChatMessage {
  id?: string;
  created_at?: string;
  user_id?: string;
  task_id?: string;
  role: 'user' | 'model';
  text: string;
  image?: string;
  thread_id?: string;
  citations?: Array<{
    meeting_id: string;
    meeting_title: string;
    chunk_id: string;
    score: number;
  }>;
  retrieval_meta?: {
    scope?: 'single' | 'many';
    confidence?: number;
    selected_meeting_ids?: string[];
    token_usage_total?: number;
    covered_meetings_count?: number;
    total_meetings_count?: number;
  };
}

export async function saveChatMessage(message: ChatMessage): Promise<ChatMessage> {
  return apiRequest<ChatMessage>('POST', '/chat', message);
}

export async function saveChatMessages(messages: ChatMessage[]): Promise<ChatMessage[]> {
  return apiRequest<ChatMessage[]>('POST', '/chat', messages);
}

export async function getChatHistory(taskId: string): Promise<ChatMessage[]> {
  return apiRequest<ChatMessage[]>('GET', `/chat?taskId=${taskId}`);
}

export async function getChatHistoryByThread(threadId: string): Promise<ChatMessage[]> {
  return apiRequest<ChatMessage[]>('GET', `/chat?threadId=${threadId}`);
}

export async function deleteChatHistory(taskId: string): Promise<void> {
  await apiRequest('DELETE', `/chat?taskId=${taskId}`);
}

// =====================================================
// PENDING TASK QUEUE (IndexedDB - unchanged from original)
// =====================================================

interface PendingTaskRecord {
  local_id: string;
  created_at: string;
  task: TaskHistory;
}

const PENDING_TASK_DB = 'WisprnotePendingTaskDB';
const PENDING_TASK_DB_VERSION = 1;
const PENDING_TASK_STORE = 'pendingTaskHistory';
const MAX_PENDING_TASKS = 50;

async function openPendingTaskDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(PENDING_TASK_DB, PENDING_TASK_DB_VERSION);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve(request.result);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PENDING_TASK_STORE)) {
        const store = db.createObjectStore(PENDING_TASK_STORE, { keyPath: 'local_id' });
        store.createIndex('created_at', 'created_at', { unique: false });
      }
    };
  });
}

async function getPendingTaskRecords(): Promise<PendingTaskRecord[]> {
  const db = await openPendingTaskDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PENDING_TASK_STORE], 'readonly');
    const store = tx.objectStore(PENDING_TASK_STORE);
    const request = store.getAll();
    request.onerror = () => reject(request.error);
    request.onsuccess = () => {
      const records = (request.result || []) as PendingTaskRecord[];
      records.sort((a, b) => a.created_at.localeCompare(b.created_at));
      resolve(records);
    };
  });
}

async function putPendingTaskRecord(record: PendingTaskRecord): Promise<void> {
  const db = await openPendingTaskDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PENDING_TASK_STORE], 'readwrite');
    const store = tx.objectStore(PENDING_TASK_STORE);
    const request = store.put(record);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function deletePendingTaskRecord(localId: string): Promise<void> {
  const db = await openPendingTaskDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction([PENDING_TASK_STORE], 'readwrite');
    const store = tx.objectStore(PENDING_TASK_STORE);
    const request = store.delete(localId);
    request.onerror = () => reject(request.error);
    request.onsuccess = () => resolve();
  });
}

async function trimPendingTaskQueueIfNeeded(): Promise<void> {
  const records = await getPendingTaskRecords();
  const overflow = records.length - MAX_PENDING_TASKS;
  if (overflow <= 0) return;
  const toDelete = records.slice(0, overflow).map(r => r.local_id);
  await Promise.all(toDelete.map(deletePendingTaskRecord));
}

export async function queuePendingTask(task: TaskHistory): Promise<string> {
  const localId = `pending_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  await putPendingTaskRecord({
    local_id: localId,
    created_at: new Date().toISOString(),
    task,
  });
  await trimPendingTaskQueueIfNeeded();
  return localId;
}

export async function getPendingTaskCount(): Promise<number> {
  const records = await getPendingTaskRecords();
  return records.length;
}

export async function flushPendingTasks(): Promise<TaskHistory[]> {
  const records = await getPendingTaskRecords();
  if (!records.length) return [];

  const syncedTasks: TaskHistory[] = [];

  for (const record of records) {
    try {
      const saved = await saveTask(record.task);
      syncedTasks.push(saved);
      await deletePendingTaskRecord(record.local_id);
    } catch (error: any) {
      const status = error?.status ?? error?.statusCode ?? 0;
      const message = String(error?.message ?? error).toLowerCase();
      const isNetworkIssue =
        !navigator.onLine ||
        status === 0 ||
        status === 502 ||
        status === 503 ||
        status === 504 ||
        message.includes('network') ||
        message.includes('failed to fetch') ||
        message.includes('timed out') ||
        message.includes('timeout');

      if (isNetworkIssue) {
        continue;
      }
    }
  }
  return syncedTasks;
}
