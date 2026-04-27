import { supabase } from './supabaseService';
import { logger } from '../lib/logger';
import type { KGBuildArtifact } from '../lib/knowledgeGraph.utils';

const log = logger.scope('UserLedger');

const LEGACY_TPUF_KEY = 'tpuf_indexed_meetings';
const LEGACY_KG_KEY = 'kg_extracted_meetings';

const PERSIST_DEBOUNCE_MS = 450;
const MAX_ARTIFACT_JSON_BYTES = 4_500_000; // stay under common PostgREST / proxy limits

let currentUserId: string | null = null;
let hydrated = false;
let tpufSet = new Set<string>();
let kgSet = new Set<string>();
let persistTimer: ReturnType<typeof setTimeout> | null = null;

function readLegacyTpuF(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_TPUF_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

function readLegacyKg(): string[] {
  try {
    const raw = localStorage.getItem(LEGACY_KG_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
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
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.user || session.user.id !== currentUserId) return;

  const { error } = await supabase.from('user_ledger_state').upsert(
    {
      user_id: currentUserId,
      turbopuffer_indexed_ids: Array.from(tpufSet),
      kg_extracted_ids: Array.from(kgSet),
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) {
    log.warn('ledger_persist_failed', { error: error as Error });
  }
}

/**
 * Load ledgers for this user from Supabase. Merges legacy localStorage on first run, then clears legacy keys.
 * Safe to call multiple times; idempotent for the same userId after hydration.
 */
export async function loadUserLedgerState(userId: string): Promise<void> {
  if (currentUserId === userId && hydrated) return;

  currentUserId = userId;
  hydrated = true;

  const { data, error } = await supabase
    .from('user_ledger_state')
    .select('turbopuffer_indexed_ids, kg_extracted_ids')
    .eq('user_id', userId)
    .maybeSingle();

  if (error) {
    log.warn('ledger_load_failed', { error: error as Error });
    tpufSet = new Set();
    kgSet = new Set();
    return;
  }

  const fromDbTpuf: string[] = (data as any)?.turbopuffer_indexed_ids ?? [];
  const fromDbKg: string[] = (data as any)?.kg_extracted_ids ?? [];
  const legacyT = readLegacyTpuF();
  const legacyK = readLegacyKg();

  tpufSet = new Set([...fromDbTpuf, ...legacyT]);
  kgSet = new Set([...fromDbKg, ...legacyK]);

  const hadLegacy = legacyT.length > 0 || legacyK.length > 0;
  if (hadLegacy) {
    clearLegacyLocalKeys();
    await flushPersistLedgers();
    log.info('ledger_migrated_from_localstorage', { tpu: legacyT.length, kg: legacyK.length });
  } else if (!data && (tpufSet.size > 0 || kgSet.size > 0)) {
    // no row yet but should not happen without legacy
  } else if (!data) {
    await flushPersistLedgers();
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

// ─── Turbopuffer (was turbopufferService localStorage) ─────────────────────

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

// ─── KG extraction ledger (was kgLedger localStorage) ───────────────────────

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

// ─── KG artifact (JSON in Supabase, mirrors IndexedDB) ─────────────────────

interface SerializedArtifactRow {
  fingerprint: string;
  nodes: any[];
  links: any[];
  relationships: any[];
  meetingEdgeMatrix: Array<[string, any[]]>;
  embeddings: Array<[string, { id: string; text: string; vector: number[] }]>;
  savedAt: number;
}

function serializeArtifact(
  fingerprint: string,
  artifact: KGBuildArtifact
): SerializedArtifactRow {
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

export async function loadKgArtifactFromSupabase(
  fingerprint: string
): Promise<KGBuildArtifact | null> {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return null;

  const { data, error } = await supabase
    .from('user_ledger_state')
    .select('kg_artifact_fingerprint, kg_artifact_data')
    .eq('user_id', uid)
    .maybeSingle();

  if (error || !data) return null;
  if (data.kg_artifact_fingerprint !== fingerprint || !data.kg_artifact_data) return null;

  try {
    return deserializeArtifact(data.kg_artifact_data as unknown as SerializedArtifactRow);
  } catch (e) {
    log.warn('kg_artifact_deserialize_failed', { error: e instanceof Error ? e : undefined });
    return null;
  }
}

export async function saveKgArtifactToSupabase(
  fingerprint: string,
  artifact: KGBuildArtifact
): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return;

  const row = serializeArtifact(fingerprint, artifact);
  const json = JSON.stringify(row);
  if (json.length > MAX_ARTIFACT_JSON_BYTES) {
    log.info('kg_artifact_supabase_skipped_too_large', { bytes: json.length, max: MAX_ARTIFACT_JSON_BYTES });
    return;
  }

  const { error } = await supabase.from('user_ledger_state').upsert(
    {
      user_id: uid,
      turbopuffer_indexed_ids: Array.from(tpufSet),
      kg_extracted_ids: Array.from(kgSet),
      kg_artifact_fingerprint: fingerprint,
      kg_artifact_data: row as unknown as Record<string, unknown>,
      updated_at: new Date().toISOString(),
    },
    { onConflict: 'user_id' }
  );
  if (error) log.warn('kg_artifact_upsert_failed', { error: error as Error });
}

export async function clearKgArtifactInSupabase(): Promise<void> {
  const { data: { session } } = await supabase.auth.getSession();
  const uid = session?.user?.id;
  if (!uid) return;

  await supabase
    .from('user_ledger_state')
    .update({
      kg_artifact_fingerprint: null,
      kg_artifact_data: null,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', uid);
}
