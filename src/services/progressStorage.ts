/**
 * IndexedDB-based progress storage for audio processing recovery
 * Persists batch progress to survive page reloads and network disconnections
 */

const DB_NAME = 'WisprnoteProgressDB';
const DB_VERSION = 1;
const STORE_NAME = 'processingProgress';

export interface ProcessingProgress {
  id: string;
  filename: string;
  prompt: string;
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

  async saveProgress(progress: ProcessingProgress): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.put({ ...progress, updatedAt: Date.now() });

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
    });
  }

  async getProgress(id: string): Promise<ProcessingProgress | null> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.get(id);

      request.onsuccess = () => resolve(request.result || null);
      request.onerror = () => reject(request.error);
    });
  }

  async getAllProgress(): Promise<ProcessingProgress[]> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();

      request.onsuccess = () => resolve(request.result || []);
      request.onerror = () => reject(request.error);
    });
  }

  async deleteProgress(id: string): Promise<void> {
    if (!this.db) await this.init();
    return new Promise((resolve, reject) => {
      const transaction = this.db!.transaction([STORE_NAME], 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.delete(id);

      request.onsuccess = () => resolve();
      request.onerror = () => reject(request.error);
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
