import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken, getUserId } from './awsAuthService';
import { getSelection } from './workspaceSelection';
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
  requireAuth = true,
  timeoutMs = 20000
): Promise<T> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };

  if (requireAuth) {
    const token = await getIdToken();
    headers['Authorization'] = token;
  }

  // W1: tell the server which workspace (vault) this request is scoped to. Absent on
  // the very first load → the server falls back to the user's default workspace.
  const activeWorkspaceId = getSelection().workspaceId;
  if (activeWorkspaceId) headers['X-Workspace-Id'] = activeWorkspaceId;

  const url = `${API_BASE}${path}`;
  // Abort the request if it stalls — a hung fetch (cold start, flaky network)
  // otherwise leaves the UI spinning forever. The caller can retry.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await httpFetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err: any) {
    if (err?.name === 'AbortError') {
      throw Object.assign(new Error(`Request timed out after ${timeoutMs}ms`), {
        isTimeout: true,
        status: 0,
        statusCode: 0,
      });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

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
  transcription?: string;
  summary?: string;
  notes?: string;
  audio_url?: string;
  status: 'completed' | 'error';
  duration: number;
  prompt?: string;
  personal_note?: string;
  visualization_image?: string;
  attendees?: string[];
  /** Where the note lives: the space (and optional folder within it). Notes never
      live directly under a workspace — workspace → space → folder → note. */
  space_id?: string | null;
  folder_id?: string | null;
  /** 'batch' for uploaded recordings (counts toward batch-hour limits) or
      'realtime' for live transcription. Defaults to realtime server-side. */
  source?: 'batch' | 'realtime';
}

export interface TaskMetadata {
  id: string;
  created_at: string;
  filename: string;
  summary?: string;
  status: 'completed' | 'error';
  duration: number;
  // Returned by the lightweight list so the People chip can render immediately,
  // before the full per-task detail fetch completes.
  attendees?: string[];
  // Where the meeting lives (space + optional folder within it) so every list can
  // show which space a meeting belongs to without a second fetch.
  space_id?: string | null;
  folder_id?: string | null;
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

export async function updateTaskAttendees(taskId: string, attendees: string[]): Promise<void> {
  await apiRequest('PUT', `/tasks/${taskId}`, { attendees });
}

export async function getTasksLightweight(
  page: number = 0,
  pageSize: number = 20
): Promise<{ data: TaskMetadata[]; hasMore: boolean; total: number }> {
  return apiRequest('GET', `/tasks?page=${page}&pageSize=${pageSize}`);
}

/**
 * One-shot launch payload: first page of history + workspace membership index +
 * chat threads + ledger, in a SINGLE request. Used to prime caches on login so
 * the app paints instantly with one round-trip instead of ~6.
 */
export interface BootstrapPayload {
  history: { data: TaskMetadata[]; hasMore: boolean; total: number };
  workspaceIndex: {
    workspaces: any[];
    folders: any[];
    taskWorkspaces: { task_id: string; workspace_id: string }[];
    taskFolders: { task_id: string; folder_id: string }[];
  };
  chatThreads: Array<{
    thread_id: string; task_id: string | null; title: string | null;
    preview: string | null; created_at: string; updated_at: string; task_title: string | null;
  }>;
  ledger: any | null;
  entitlements?: Entitlements;
}

/** Plan + quota info used to gate plan limits and show usage. */
export interface Entitlements {
  plan: string;
  planLabel: string;
  unlimited: boolean;
  meetingCount: number;
  meetingLimit: number | null;             // null when unlimited
  meetingsPeriod: 'total' | 'month';
  meetingsRemaining: number | null;        // null when unlimited
  batchHours: { usedHours: number; limitHours: number | null; remainingHours: number | null };
}

export interface ModelTokenUsage {
  provider: string;
  model: string | null;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  /** Seconds of audio processed (transcription/Deepgram); 0 for LLM models. */
  audio_seconds?: number;
  calls: number;
}

/** Per-product-function usage (this calendar month) — drives the Analytics breakdown. */
export interface FeatureTokenUsage {
  feature: string;
  input_tokens: number;
  output_tokens: number;
  total_tokens: number;
  audio_seconds: number;
  calls: number;
}

/** Detailed usage for the billing screen (this calendar month). */
export interface UsageSummary {
  plan: string;
  planLabel: string;
  tokens: { totalTokens: number; totalAudioSeconds?: number; calls: number; byModel: ModelTokenUsage[]; byFeature?: FeatureTokenUsage[] };
  meetings: { used: number; limit: number | null; period: 'total' | 'month'; remaining: number | null };
  batchHours: { usedHours: number; limitHours: number | null; remainingHours: number | null };
}

export async function getUsage(): Promise<UsageSummary> {
  return apiRequest('GET', '/billing/usage');
}

export async function getBootstrap(): Promise<BootstrapPayload> {
  return apiRequest('GET', '/bootstrap');
}

export async function getTaskById(taskId: string): Promise<TaskHistory | null> {
  try {
    // Larger timeout: a task row carries the full transcription/notes, which can
    // be sizable for long meetings and slow to transfer over a cold connection.
    // NOTE: this no longer includes visualization_image — fetch that lazily via
    // getTaskVisualization() only when the Notes tab actually needs it.
    return await apiRequest<TaskHistory>('GET', `/tasks/${taskId}`, undefined, true, 30000);
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

/**
 * Fetches just the (heavy, base64) visualization image for a task. Kept separate
 * from getTaskById so the image is only transferred when the user views it,
 * instead of bloating every note open.
 */
export async function getTaskVisualization(taskId: string): Promise<string | null> {
  try {
    const res = await apiRequest<{ visualization_image: string | null }>(
      'GET', `/tasks/${taskId}/visualization`, undefined, true, 30000
    );
    return res?.visualization_image ?? null;
  } catch (e: any) {
    if (e.status === 404) return null;
    throw e;
  }
}

export async function getTasks(): Promise<TaskHistory[]> {
  const result = await apiRequest<{ data: TaskHistory[] }>('GET', '/tasks?full=true&pageSize=10000');
  return result.data;
}

export async function getAllTaskIds(): Promise<TaskMetadata[]> {
  const result = await apiRequest<{ data: TaskMetadata[]; total: number }>('GET', '/tasks?pageSize=10000');
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

export interface ServerKgEdge {
  from_task: string;
  to_task: string;
  similarity?: number | null;
  relationship_type?: string | null;
  shared_thread?: string | null;
  confidence?: string | null;
}

export interface ServerKgEdgesResponse {
  edges: ServerKgEdge[];
  /** task_ids of meetings whose server-side KG pipeline hasn't finished yet. */
  processing: string[];
}

/**
 * Precomputed cross-meeting edges (server Stage C output) + processing status.
 * Lets the client render the graph instantly without running its own embedding /
 * relationship pipeline. Returns null on any failure so callers fall back.
 */
export async function getKnowledgeGraphEdges(): Promise<ServerKgEdgesResponse | null> {
  try {
    return await apiRequest<ServerKgEdgesResponse>('GET', '/knowledge-graph/edges');
  } catch {
    return null;
  }
}

export async function getKnowledgeGraph(): Promise<KnowledgeGraphEntry[]> {
  return apiRequest<KnowledgeGraphEntry[]>('GET', '/knowledge-graph');
}

/**
 * Workspace-scoped knowledge graph: the same per-meeting KG entries, filtered to
 * the meetings that belong to the given workspace. Used to render a graph for one
 * workspace, mirroring how meeting notes are scoped per workspace.
 */
export async function getWorkspaceKnowledgeGraph(workspaceId: string): Promise<KnowledgeGraphEntry[]> {
  return apiRequest<KnowledgeGraphEntry[]>('GET', `/workspaces/${workspaceId}/knowledge-graph`);
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
  agent_status?: 'thinking' | 'planning' | 'executing' | 'done';
  agent_plan?: Array<{
    id: string;
    label: string;
    status: 'pending' | 'running' | 'done' | 'error';
    detail?: string;
    type?: 'search-tool' | 'plan';
    search_kind?: 'notes' | 'people' | 'analyze' | 'read';
    search_query?: string;
    search_results?: Array<{
      meeting_id: string;
      meeting_title: string;
      score: number;
    }>;
    plan_steps?: string[];
  }>;
  /** Set for workspace-scoped chat so its threads are kept separate from the
   *  global AI Chat (and from other workspaces). */
  workspace_id?: string;
  /** Agentic-loop thought-process timeline (tool calls + plan), persisted so it
   *  survives a reload. Shape = TraceItem[] from the agent UI; kept loose here to
   *  avoid coupling the service layer to a component type. */
  trace?: unknown;
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
  return apiRequest<ChatMessage[]>('GET', `/chat?threadId=${encodeURIComponent(threadId)}`);
}

export interface ChatThreadRow {
  thread_id: string;
  task_id: string | null;
  created_at: string;
  updated_at: string;
  title: string | null;
  preview: string | null;
  task_title: string | null;
}

/** Durable thread index derived server-side from chat_history (global chat —
 *  excludes workspace-scoped threads). */
export async function getChatThreads(): Promise<ChatThreadRow[]> {
  return apiRequest<ChatThreadRow[]>('GET', `/chat?threads=1`);
}

/** Durable thread index for a single workspace's scoped chat. */
export async function getWorkspaceChatThreads(workspaceId: string): Promise<ChatThreadRow[]> {
  return apiRequest<ChatThreadRow[]>('GET', `/chat?threads=1&workspaceId=${encodeURIComponent(workspaceId)}`);
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
  /** Owner of this offline-queued task — so it's only ever flushed into the
      account that created it, never whoever happens to be signed in later. */
  userId?: string;
}

// The signed-in user, used to scope the offline queue per account.
let _pendingUser: string | null = null;
export function setPendingTaskUser(userId: string | null): void {
  _pendingUser = userId;
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
    userId: _pendingUser ?? undefined,
  });
  await trimPendingTaskQueueIfNeeded();
  return localId;
}

/** Records belonging to the signed-in user. Legacy records (no userId) are
    treated as the current user's only when no user is set — never cross-account. */
function ownPendingRecords(records: PendingTaskRecord[]): PendingTaskRecord[] {
  return records.filter(r => (r.userId ?? null) === (_pendingUser ?? null));
}

export async function getPendingTaskCount(): Promise<number> {
  const records = await getPendingTaskRecords();
  return ownPendingRecords(records).length;
}

export async function flushPendingTasks(): Promise<TaskHistory[]> {
  const all = await getPendingTaskRecords();
  const records = ownPendingRecords(all); // only flush THIS user's queued tasks
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
