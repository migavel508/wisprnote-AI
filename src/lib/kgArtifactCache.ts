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
import { loadKgArtifactFromSupabase, saveKgArtifactToSupabase, clearKgArtifactInSupabase } from '../services/userLedgerService';

const log = logger.scope('KGArtifactCache');

const DB_NAME = 'kg_artifact_cache';
const DB_VERSION = 1;
const STORE_NAME = 'artifacts';

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

/** Try to load a cached artifact: Supabase (same user, any device) then IndexedDB. */
export async function loadCachedArtifact(fingerprint: string): Promise<KGBuildArtifact | null> {
  const fromCloud = await loadKgArtifactFromSupabase(fingerprint);
  if (fromCloud) {
    log.info('artifact_cache_hit', { source: 'supabase', meetings: fromCloud.meetingEdgeMatrix.size, embeddings: fromCloud.embeddings.size });
    return fromCloud;
  }

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(fingerprint);
      req.onsuccess = () => {
        const data = req.result as SerializedArtifact | undefined;
        if (!data) { resolve(null); return; }
        const artifact = fromSerialized(data);
        log.info('artifact_cache_hit', {
          source: 'indexeddb',
          meetings: data.meetingEdgeMatrix.length,
          embeddings: data.embeddings.length,
          ageMs: Date.now() - data.savedAt,
        });
        resolve(artifact);
      };
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    log.warn('artifact_cache_load_failed', { error: err instanceof Error ? err : undefined });
    return null;
  }
}

/** Persist a build artifact to IndexedDB. */
export async function saveCachedArtifact(fingerprint: string, artifact: KGBuildArtifact): Promise<void> {
  try {
    const serialized: SerializedArtifact = {
      fingerprint,
      nodes: artifact.nodes,
      links: artifact.links,
      relationships: artifact.relationships,
      meetingEdgeMatrix: Array.from(artifact.meetingEdgeMatrix.entries()),
      embeddings: Array.from(artifact.embeddings.entries()),
      savedAt: Date.now(),
    };

    const db = await openDB();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      // Clear old entries — only keep the latest artifact
      store.clear();
      store.put(serialized);
      tx.oncomplete = () => {
        log.info('artifact_cache_saved', {
          source: 'indexeddb',
          meetings: serialized.meetingEdgeMatrix.length,
          embeddings: serialized.embeddings.length,
        });
        resolve();
      };
      tx.onerror = () => reject(tx.error);
    });
    void saveKgArtifactToSupabase(fingerprint, artifact);
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
