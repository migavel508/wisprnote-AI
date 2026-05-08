import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken, getSession } from './awsAuthService';
import { logger } from '../lib/logger';
import type { KGBuildArtifact } from '../lib/knowledgeGraph.utils';

const log = logger.scope('AWSLedger');

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = !!(window as any).__TAURI_INTERNALS__;
const httpFetch = isTauri ? (tauriFetch as unknown as typeof globalThis.fetch) : globalThis.fetch;

const LEGACY_TPUF_KEY = 'tpuf_indexed_meetings';
const LEGACY_KG_KEY = 'kg_extracted_meetings';
const PERSIST_DEBOUNCE_MS = 450;
const MAX_ARTIFACT_JSON_BYTES = 4_500_000;

let currentUserId: string | null = null;
let hydrated = false;
let tpufSet = new Set<string>();
let kgSet = new Set<string>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

async function apiRequest<T = any>(method: string, path: string, body?: any): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  headers['Authorization'] = await getIdToken();

  const resp = await httpFetch(`${API_BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!resp.ok) {
    const errText = await resp.text();
    throw new Error(`Ledger API ${resp.status}: ${errText}`);
  }

  if (resp.status === 204) return undefined as T;
  const text = await resp.text();
  if (!text) return undefined as T;
  return JSON.parse(text);
}

function readLegacyTpuF(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_TPUF_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

function readLegacyKg(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_KG_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch { return []; }
}

function clearLegacyLocalKeys(): void {
  try { localStorage.removeItem(LEGACY_TPUF_KEY); } catch { /* ok */ }
  try { localStorage.removeItem(LEGACY_KG_KEY); } catch { /* ok */ }
}

function schedulePersistLedgers(): void {
  if (!currentUserId) return;
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    void flushPersistLedgers();
  }, PERSIST_DEBOUNCE_MS);
}

async function flushPersistLedgers(): Promise<void> {
  if (!currentUserId) return;
  const session = await getSession();
  if (!session || session.user.id !== currentUserId) return;

  try {
    await apiRequest('POST', '/ledger', {
      turbopuffer_indexed_ids: Array.from(tpufSet),
      kg_extracted_ids: Array.from(kgSet),
    });
  } catch (e) {
    log.warn('ledger_persist_failed', { error: e instanceof Error ? e : undefined });
  }
}

export async function loadUserLedgerState(userId: string): Promise<void> {
  if (currentUserId === userId && hydrated) return;

  currentUserId = userId;
  hydrated = true;

  try {
    const data = await apiRequest<any>('GET', '/ledger');

    const fromDbTpuf: string[] = data?.turbopuffer_indexed_ids ?? [];
    const fromDbKg: string[] = data?.kg_extracted_ids ?? [];
    const legacyT = readLegacyTpuF();
    const legacyK = readLegacyKg();

    tpufSet = new Set([...fromDbTpuf, ...legacyT]);
    kgSet = new Set([...fromDbKg, ...legacyK]);

    const hadLegacy = legacyT.length > 0 || legacyK.length > 0;
    if (hadLegacy) {
      clearLegacyLocalKeys();
      await flushPersistLedgers();
      log.info('ledger_migrated_from_localstorage', { tpu: legacyT.length, kg: legacyK.length });
    } else if (!data) {
      await flushPersistLedgers();
    }
  } catch (e) {
    log.warn('ledger_load_failed', { error: e instanceof Error ? e : undefined });
    tpufSet = new Set();
    kgSet = new Set();
  }
}

export function resetUserLedgers(): void {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  currentUserId = null;
  hydrated = false;
  tpufSet = new Set();
  kgSet = new Set();
}

// ─── Turbopuffer ledger ──────────────────────────────────────────────────

export function getTurbopufferIndexedSet(): Set<string> {
  return new Set(tpufSet);
}

export function markTurbopufferIndexed(meetingId: string): void {
  tpufSet.add(meetingId);
  schedulePersistLedgers();
}

export function isTurbopufferIndexed(meetingId: string): boolean {
  return tpufSet.has(meetingId);
}

export function clearTurbopufferLedgerState(): void {
  tpufSet = new Set();
  schedulePersistLedgers();
}

// ─── KG extraction ledger ────────────────────────────────────────────────

export function readKGLedger(): Set<string> {
  return new Set(kgSet);
}

export function markKGExtracted(meetingId: string): void {
  kgSet.add(meetingId);
  schedulePersistLedgers();
}

export function markKGExtractedBatch(meetingIds: string[]): void {
  for (const id of meetingIds) kgSet.add(id);
  schedulePersistLedgers();
}

export function isKGExtracted(meetingId: string): boolean {
  return kgSet.has(meetingId);
}

export function clearKGLedger(): void {
  kgSet = new Set();
  schedulePersistLedgers();
}

export function reconcileKGLedger(supabaseKGIds: Set<string>): void {
  let changed = false;
  for (const id of kgSet) {
    if (!supabaseKGIds.has(id)) {
      kgSet.delete(id);
      changed = true;
    }
  }
  if (changed) schedulePersistLedgers();
}

// ─── KG artifact (JSON via API) ──────────────────────────────────────────

interface SerializedArtifactRow {
  fingerprint: string;
  nodes: any[];
  links: any[];
  relationships: any[];
  meetingEdgeMatrix: Array<[string, any[]]>;
  embeddings: Array<[string, { id: string; text: string; vector: number[] }]>;
  savedAt: number;
}

function serializeArtifact(fingerprint: string, artifact: KGBuildArtifact): SerializedArtifactRow {
  return {
    fingerprint,
    nodes: artifact.nodes,
    links: artifact.links,
    relationships: artifact.relationships,
    meetingEdgeMatrix: Array.from(artifact.meetingEdgeMatrix.entries()),
    embeddings: Array.from(artifact.embeddings.entries()),
    savedAt: Date.now(),
  };
}

function deserializeArtifact(data: SerializedArtifactRow): KGBuildArtifact {
  return {
    nodes: data.nodes,
    links: data.links,
    relationships: data.relationships,
    meetingEdgeMatrix: new Map(data.meetingEdgeMatrix),
    embeddings: new Map(data.embeddings),
  };
}

export async function loadKgArtifactFromSupabase(fingerprint: string): Promise<KGBuildArtifact | null> {
  const session = await getSession();
  if (!session) return null;

  try {
    const data = await apiRequest<any>('GET', '/ledger');
    if (!data || data.kg_artifact_fingerprint !== fingerprint || !data.kg_artifact_data) return null;
    return deserializeArtifact(data.kg_artifact_data as SerializedArtifactRow);
  } catch (e) {
    log.warn('kg_artifact_load_failed', { error: e instanceof Error ? e : undefined });
    return null;
  }
}

export async function saveKgArtifactToSupabase(fingerprint: string, artifact: KGBuildArtifact): Promise<void> {
  const session = await getSession();
  if (!session) return;

  const row = serializeArtifact(fingerprint, artifact);
  const json = JSON.stringify(row);
  if (json.length > MAX_ARTIFACT_JSON_BYTES) {
    log.info('kg_artifact_skipped_too_large', { bytes: json.length, max: MAX_ARTIFACT_JSON_BYTES });
    return;
  }

  try {
    await apiRequest('POST', '/ledger', {
      turbopuffer_indexed_ids: Array.from(tpufSet),
      kg_extracted_ids: Array.from(kgSet),
      kg_artifact_fingerprint: fingerprint,
      kg_artifact_data: row,
    });
  } catch (e) {
    log.warn('kg_artifact_upsert_failed', { error: e instanceof Error ? e : undefined });
  }
}

export async function clearKgArtifactInSupabase(): Promise<void> {
  const session = await getSession();
  if (!session) return;

  try {
    await apiRequest('PUT', '/ledger/clear-artifact', {});
  } catch (e) {
    log.warn('kg_artifact_clear_failed', { error: e instanceof Error ? e : undefined });
  }
}
