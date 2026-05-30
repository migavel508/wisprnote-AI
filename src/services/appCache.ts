/**
 * IndexedDB cache for app data (tasks, chat, assets, manual notes, KG).
 * Per-user keys; use cacheClearUser on sign-out / account switch.
 */

import type { TaskHistory } from './awsService';

const DB_NAME = 'WisprnoteAppCache';
const DB_VERSION = 1;
const STORE = 'cache';

export interface CachedHistoryPayload {
  list: TaskHistory[];
  hasMore: boolean;
  total: number;
  pageLoaded: number;
}

interface CacheRecord {
  key: string;
  data: unknown;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'key' });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

export async function cacheGet<T>(key: string): Promise<T | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const store = tx.objectStore(STORE);
      const r = store.get(key);
      r.onsuccess = () => {
        const row = r.result as CacheRecord | undefined;
        if (!row) {
          resolve(null);
          return;
        }
        resolve(row.data as T);
      };
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

/**
 * Returns cached data ONLY if it was written within `maxAgeMs`; otherwise null.
 * This is the cautious primitive for "skip the network if the cache is still
 * fresh" — it never serves indefinitely stale data, so callers can avoid a
 * redundant cloud request without risking a perpetually outdated UI.
 */
export async function cacheGetFresh<T>(key: string, maxAgeMs: number): Promise<T | null> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readonly');
      const r = tx.objectStore(STORE).get(key);
      r.onsuccess = () => {
        const row = r.result as CacheRecord | undefined;
        if (!row || Date.now() - row.updatedAt > maxAgeMs) {
          resolve(null);
          return;
        }
        resolve(row.data as T);
      };
      r.onerror = () => reject(r.error);
    });
  } catch {
    return null;
  }
}

export async function cacheSet(key: string, data: unknown): Promise<void> {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const record: CacheRecord = { key, data, updatedAt: Date.now() };
    const r = store.put(record);
    r.onsuccess = () => resolve();
    r.onerror = () => reject(r.error);
  });
}

export async function cacheDelete(key: string): Promise<void> {
  try {
    const db = await openDb();
    return new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, 'readwrite');
      const store = tx.objectStore(STORE);
      const r = store.delete(key);
      r.onsuccess = () => resolve();
      r.onerror = () => reject(r.error);
    });
  } catch {
    /* non-fatal */
  }
}

/** Remove all cached data for a user (tasks list, notes, kg, task/chat/assets children). */
export async function cacheClearUser(userId: string): Promise<void> {
  if (!userId) return;

  const payload = await cacheGet<CachedHistoryPayload>(`tasks:${userId}`);
  const taskIds = (payload?.list?.map(t => t.id).filter(Boolean) as string[]) ?? [];

  const keysToDelete = new Set<string>([
    `tasks:${userId}`,
    `notes:${userId}`,
    `kg:${userId}`,
    `meta:${userId}`,
    `contacts:${userId}`,
    'chat:all-meetings',
  ]);
  for (const id of taskIds) {
    keysToDelete.add(`task:${id}`);
    keysToDelete.add(`chat:${id}`);
    keysToDelete.add(`assets:${id}`);
  }

  try {
    const db = await openDb();
    await Promise.all(
      [...keysToDelete].map(
        (key) =>
          new Promise<void>((resolve) => {
            const tx = db.transaction(STORE, 'readwrite');
            tx.objectStore(STORE).delete(key);
            tx.oncomplete = () => resolve();
            tx.onerror = () => resolve();
          })
      )
    );
  } catch {
    /* non-fatal */
  }
}
