/**
 * IndexedDB-based progress storage for audio processing recovery
 * Persists batch progress to survive page reloads and network disconnections
 *
 * Audio blobs are stored in a SEPARATE IDB record (written once) so that
 * frequent per-batch metadata saves don't re-serialize 100 MB+ blobs and
 * trigger WebKit memory-pressure / blob-eviction errors.
 */

const DB_NAME = 'WisprnoteProgressDB';
const DB_VERSION = 1;
const STORE_NAME = 'processingProgress';

export interface ProcessingProgress {
  id: string;
  filename: string;
  prompt: string;
  mode?: 'batch' | 'realtime';
  stage?: 'batch-transcription' | 'realtime-postprocess';
  transcription?: string;
  duration?: number;
  totalBatches: number;
  completedBatches: number;
  batches: Array<{
    index: number;
    status: 'pending' | 'processing' | 'completed' | 'error';
    result?: string;
    error?: string;
    startTime: number;
    endTime: number;
  }>;
  audioBlob?: Blob;
  createdAt: number;
  updatedAt: number;
}

class ProgressStorage {
  private db: IDBDatabase | null = null;
  /** In-memory blob cache keyed by progress ID — avoids IDB reads during the active session */
  private blobCache = new Map<string, Blob>();
  /** Tracks which blobs have already been persisted to IDB */
  private persistedBlobIds = new Set<string>();

  async init(): Promise<void> {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);

      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        this.db = request.result;
        resolve();
      };

      request.onupgradeneeded = (event) => {
        const db = (event.target as IDBOpenDBRequest).result;
        if (!db.objectStoreNames.contains(STORE_NAME)) {
          const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
          store.createIndex('createdAt', 'createdAt', { unique: false });
        }
      };
    });
  }

  /**
   * Persist the audio blob exactly ONCE per progress session.
   * Stored under key `${id}__audioblob` in the same object store.
   */
  private async persistBlobOnce(id: string, blob: Blob): Promise<void> {
    if (this.persistedBlobIds.has(id)) return;
    if (!this.db) await this.init();

    return new Promise((resolve, reject) => {
      const tx = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);
      const request = store.put({
        id: `${id}__audioblob`,
        audioBlob: blob,
        updatedAt: Date.now(),
      });
      request.onsuccess = () => {
        this.persistedBlobIds.add(id);
        resolve();
      };
      request.onerror = () => reject(request.error);
    });
  }

  async saveProgress(progress: ProcessingProgress): Promise<void> {
    if (!this.db) await this.init();

    // Handle the blob separately to avoid re-serializing it on every save.
    if (progress.audioBlob) {
      this.blobCache.set(progress.id, progress.audioBlob);
      // Fire-and-forget the one-time IDB blob write so it doesn't block
      // the metadata save path (and therefore doesn't delay batch processing).
      this.persistBlobOnce(progress.id, progress.audioBlob).catch(() => {
        // Non-fatal: blob is still in the memory cache for the current session.
        // On a hard crash the blob won't be recoverable, but that's an edge case.
      });
    }

    // Strip the blob from the metadata record — it lives in its own record.
    const { audioBlob: _blob, ...metadata } = progress;

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ ...metadata, updatedAt: Date.now() });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getProgress(id: string): Promise<ProcessingProgress | null> {
    if (!this.db) await this.init();

    const metadata = await new Promise<ProcessingProgress | null>((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });

    if (!metadata) return null;

    // Re-attach the audio blob: prefer in-memory cache, fall back to IDB.
    let blob = this.blobCache.get(id);
    if (!blob) {
      try {
        const blobRecord = await new Promise<any>((resolve, reject) => {
          const transaction = this.db!.transaction([STORE_NAME], 'readonly');
          const store = transaction.objectStore(STORE_NAME);
          const request = store.get(`${id}__audioblob`);
          request.onsuccess = () => resolve(request.result || null);
          request.onerror = () => reject(request.error);
        });
        if (blobRecord?.audioBlob) {
          blob = blobRecord.audioBlob;
          this.blobCache.set(id, blob!);
          this.persistedBlobIds.add(id);
        }
      } catch {
        // Blob record may not exist (old schema) — that's fine.
      }
    }

    return { ...metadata, audioBlob: blob };
  }

  async getAllProgress(): Promise<ProcessingProgress[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => {
        // Filter out the __audioblob companion records
        const results = (request.result || []).filter(
          (r: any) => !String(r.id).endsWith('__audioblob')
        );
        resolve(results);
      };
      request.onerror = () => reject(request.error);
    });
  }

  async deleteProgress(id: string): Promise<void> {
    if (!this.db) await this.init();
    this.blobCache.delete(id);
    this.persistedBlobIds.delete(id);

    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      // Delete both the metadata and the companion blob record
      store.delete(id);
      const blobReq = store.delete(`${id}__audioblob`);
      blobReq.onsuccess = () => resolve();
      blobReq.onerror = () => reject(blobReq.error);
    });
  }

  async clearOldProgress(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<void> {
    if (!this.db) await this.init();
    const allProgress = await this.getAllProgress();
    const now = Date.now();
    const deletePromises = allProgress
      .filter(p => now - p.createdAt > maxAgeMs)
      .map(p => this.deleteProgress(p.id));
    await Promise.all(deletePromises);
  }
}

export const progressStorage = new ProgressStorage();

// Helper to generate unique ID for processing session
export function generateProgressId(filename: string): string {
  return `${filename}_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

// Helper to check if there's any incomplete progress
export async function hasIncompleteProgress(): Promise<boolean> {
  const allProgress = await progressStorage.getAllProgress();
  return allProgress.some(p => p.completedBatches < p.totalBatches);
}

// Helper to get the most recent incomplete progress
export async function getMostRecentIncompleteProgress(): Promise<ProcessingProgress | null> {
  const allProgress = await progressStorage.getAllProgress();
  const incomplete = allProgress
    .filter(p => p.completedBatches < p.totalBatches)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  return incomplete[0] || null;
}
