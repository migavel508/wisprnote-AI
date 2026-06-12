// ─── KG Artifact Cache ───────────────────────────────────────────────────────
//
// Persists the KGBuildArtifact (nodes, links, relationships, embedding vectors)
// to IndexedDB so the Knowledge Graph page can render instantly on reload
// without re-running the embedding pipeline or calling any Gemini APIs.
//
// Keyed by a fingerprint of the meeting IDs in kgData. If the fingerprint
// matches, the cached artifact is returned; otherwise the pipeline runs and
// the new artifact is cached.
//
// IndexedDB is used instead of localStorage because serialised artifacts with
// embeddings can easily exceed the 5 MB localStorage quota.
//
// ──────────────────────────────────────────────────────────────────────────────

import type { KGBuildArtifact, ExtractedRelationship } from './knowledgeGraph.utils';
import { logger } from './logger';
import { loadKgArtifactFromSupabase, saveKgArtifactToSupabase, clearKgArtifactInSupabase } from '../services/awsLedgerService';

const log = logger.scope('KGArtifactCache');

const DB_NAME = 'kg_artifact_cache';
const DB_VERSION = 1;
const STORE_NAME = 'artifacts';

// Keep the N most-recently-used artifacts so each workspace (and the global
// "All meetings" view) retains its own cached graph and switching between them
// never re-runs the embedding pipeline. Older ones are pruned by savedAt.
const MAX_CACHED_ARTIFACTS = 16;

// ─── Serialisable mirror of KGBuildArtifact ─────────────────────────────────
// Maps aren't JSON-serialisable, so we convert to/from plain arrays.

interface SerializedArtifact {
  fingerprint: string;
  nodes: any[];
  links: any[];
  relationships: ExtractedRelationship[];
  // Map<string, MeetingEdge[]> → Array<[string, MeetingEdge[]]>
  meetingEdgeMatrix: Array<[string, any[]]>;
  // Map<string, EmbeddingVector> → Array<[string, EmbeddingVector]>
  embeddings: Array<[string, { id: string; text: string; vector: number[] }]>;
  savedAt: number; // Date.now()
}

// ─── IndexedDB helpers ──────────────────────────────────────────────────────

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        db.createObjectStore(STORE_NAME, { keyPath: 'fingerprint' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

// ─── Public API ─────────────────────────────────────────────────────────────

/** Build a stable fingerprint from meeting IDs. */
export function buildFingerprint(meetingIds: string[]): string {
  return [...meetingIds].sort().join(',');
}

function fromSerialized(data: SerializedArtifact): KGBuildArtifact {
  return {
    nodes: data.nodes,
    links: data.links,
    relationships: data.relationships,
    meetingEdgeMatrix: new Map(data.meetingEdgeMatrix),
    embeddings: new Map(data.embeddings),
  };
}

/**
 * Try to load a cached artifact. Checks the LOCAL IndexedDB cache first (instant,
 * no network, holds every recently-viewed scope), then falls back to the cloud
 * ledger (cross-device). A hit on either avoids re-running the embedding /
 * Turbopuffer pipeline entirely.
 */
export async function loadCachedArtifact(fingerprint: string): Promise<KGBuildArtifact | null> {
  // 1) Local IndexedDB — keyed by fingerprint, keeps multiple scopes.
  try {
    const db = await openDB();
    const local = await new Promise<KGBuildArtifact | null>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).get(fingerprint);
      req.onsuccess = () => {
        const data = req.result as SerializedArtifact | undefined;
        if (!data) { resolve(null); return; }
        log.info('artifact_cache_hit', {
          source: 'indexeddb',
          meetings: data.meetingEdgeMatrix.length,
          embeddings: data.embeddings.length,
          ageMs: Date.now() - data.savedAt,
        });
        resolve(fromSerialized(data));
      };
      req.onerror = () => resolve(null);
    });
    if (local) return local;
  } catch (err) {
    log.warn('artifact_cache_load_failed', { error: err instanceof Error ? err : undefined });
  }

  // 2) Cloud ledger (cross-device persistence).
  const fromCloud = await loadKgArtifactFromSupabase(fingerprint);
  if (fromCloud) {
    log.info('artifact_cache_hit', { source: 'supabase', meetings: fromCloud.meetingEdgeMatrix.size, embeddings: fromCloud.embeddings.size });
    // Mirror it back into local so the next switch is instant & offline.
    void saveToIndexedDB(fingerprint, fromCloud);
    return fromCloud;
  }
  return null;
}

function serialize(fingerprint: string, artifact: KGBuildArtifact): SerializedArtifact {
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

/** Write one artifact to IndexedDB WITHOUT clearing the others, then prune to cap. */
async function saveToIndexedDB(fingerprint: string, artifact: KGBuildArtifact): Promise<void> {
  const serialized = serialize(fingerprint, artifact);
  const db = await openDB();
  await new Promise<void>((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, 'readwrite');
    tx.objectStore(STORE_NAME).put(serialized); // keyPath: fingerprint → upsert, keeps other scopes
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
  await pruneArtifacts(MAX_CACHED_ARTIFACTS);
}

/** Keep only the `max` most-recently-saved artifacts (LRU by savedAt). */
async function pruneArtifacts(max: number): Promise<void> {
  try {
    const db = await openDB();
    const all = await new Promise<SerializedArtifact[]>((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const req = tx.objectStore(STORE_NAME).getAll();
      req.onsuccess = () => resolve((req.result as SerializedArtifact[]) || []);
      req.onerror = () => resolve([]);
    });
    if (all.length <= max) return;
    const toDelete = all.sort((a, b) => b.savedAt - a.savedAt).slice(max);
    const tx = db.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    toDelete.forEach((a) => store.delete(a.fingerprint));
  } catch { /* non-critical */ }
}

/**
 * Persist a build artifact: to LOCAL IndexedDB (durable, multi-scope) and, best
 * effort, to the cloud ledger for cross-device reuse. Switching workspaces or
 * returning to "All meetings" now hits this cache instead of reprocessing.
 */
export async function saveCachedArtifact(fingerprint: string, artifact: KGBuildArtifact): Promise<void> {
  // Cloud mirror (fire-and-forget; size-guarded inside).
  void saveKgArtifactToSupabase(fingerprint, artifact);
  try {
    await saveToIndexedDB(fingerprint, artifact);
    log.info('artifact_cache_saved', {
      source: 'indexeddb',
      meetings: artifact.meetingEdgeMatrix.size,
      embeddings: artifact.embeddings.size,
    });
  } catch (err) {
    log.warn('artifact_cache_save_failed', { error: err instanceof Error ? err : undefined });
  }
}

/** Clear the artifact cache (used when rebuild is forced). */
export async function clearArtifactCache(): Promise<void> {
  void clearKgArtifactInSupabase();
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      tx.objectStore(STORE_NAME).clear();
      tx.oncomplete = () => resolve();
      tx.onerror = () => resolve();
    });
  } catch {
    // non-critical
  }
}
