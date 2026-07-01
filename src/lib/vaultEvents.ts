/**
 * Tiny in-app event bus for VAULT changes (notes moved between spaces/folders,
 * spaces/folders created/renamed/deleted). It lets one change on any page reflect
 * everywhere without prop-drilling or a full reload: the central service functions
 * (`workspaceService`) emit, and every page subscribes and refreshes its own slice.
 *
 * Two events:
 *   - 'notes:changed'  — a note's location changed. payload: { taskId, spaceId, folderId }
 *   - 'spaces:changed' — spaces or their folders changed (create/rename/delete). payload: {}
 */

export type VaultEvent = 'notes:changed' | 'spaces:changed' | 'dictionary:changed';

export interface NotesChangedPayload {
  taskId: string;
  spaceId: string | null;
  folderId: string | null;
}

type Payloads = {
  'notes:changed': NotesChangedPayload;
  'spaces:changed': Record<string, never>;
  'dictionary:changed': Record<string, never>;
};

const listeners: { [K in VaultEvent]: Set<(p: Payloads[K]) => void> } = {
  'notes:changed': new Set(),
  'spaces:changed': new Set(),
  'dictionary:changed': new Set(),
};

/** Subscribe to a vault event. Returns an unsubscribe function. */
export function onVaultEvent<K extends VaultEvent>(event: K, cb: (p: Payloads[K]) => void): () => void {
  listeners[event].add(cb);
  return () => { listeners[event].delete(cb); };
}

/** Emit a vault event to all current subscribers (errors in one listener never break others). */
export function emitVaultEvent<K extends VaultEvent>(event: K, payload: Payloads[K]): void {
  for (const cb of listeners[event]) {
    try { cb(payload); } catch { /* a listener throwing must not break the others */ }
  }
}
