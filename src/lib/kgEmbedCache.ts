// ─── KG Embedding Cache (IndexedDB L2) ───────────────────────────────────────
//
// Durable embedding store that replaces the fragile localStorage cache
// (2000-entry cap, lost on cache clear) with IndexedDB (effectively unlimited).
//
// Cache tiers:
//   L1 — in-memory Map (instant, lost on tab close)
//   L2 — IndexedDB   (durable, survives cache clears, ~hundreds of MB)
//   L3 — Gemini API  (only for genuinely new items)
//
// ──────────────────────────────────────────────────────────────────────────────

import { logger } from './logger';

const log = logger.scope('KGEmbedCache');

const DB_NAME = 'kg_embed_cache';
const DB_VERSION = 1;
const STORE_NAME = 'embeddings';

function openDB(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // Key: the embed text hash; Value: { text, vector }
        db.createObjectStore(STORE_NAME, { keyPath: 'text' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

/**
 * Load all cached embeddings from IndexedDB.
 * Returns a Map<text, vector> matching the existing localStorage cache shape.
 */
export async function loadEmbedCacheFromIDB(): Promise<Map<string, number[]>> {
  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();
      req.onsuccess = () => {
        const entries = req.result as Array<{ text: string; vector: number[] }>;
        const map = new Map<string, number[]>();
        for (const e of entries) {
          map.set(e.text, e.vector);
        }
        log.info('idb_embed_cache_loaded', { count: map.size });
        resolve(map);
      };
      req.onerror = () => resolve(new Map());
    });
  } catch (err) {
    log.warn('idb_embed_cache_load_failed', { error: err instanceof Error ? err : undefined });
    return new Map();
  }
}

/**
 * Persist new embeddings to IndexedDB (append/upsert, never overwrites existing).
 */
export async function saveEmbedCacheToIDB(
  newEntries: Map<string, number[]>
): Promise<void> {
  if (newEntries.size === 0) return;

  try {
    const db = await openDB();
    return new Promise((resolve) => {
      const tx = db.transaction(STORE_NAME, 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      for (const [text, vector] of newEntries) {
        store.put({ text, vector });
      }
      tx.oncomplete = () => {
        log.info('idb_embed_cache_saved', { count: newEntries.size });
        resolve();
      };
      tx.onerror = () => resolve(); // non-critical
    });
  } catch (err) {
    log.warn('idb_embed_cache_save_failed', { error: err instanceof Error ? err : undefined });
  }
}

/** Clear the IndexedDB embedding cache. */
export async function clearEmbedCacheIDB(): Promise<void> {
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
