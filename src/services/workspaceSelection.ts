import { useEffect, useState } from 'react';

// Minimal pub/sub for the currently selected workspace + folder.
// Persisted to localStorage so refreshes keep context.

const KEY = 'wn.workspaceSelection.v1';

export interface Selection {
  workspaceId: string | null;
  folderId: string | null;
}

let current: Selection = (() => {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return { workspaceId: null, folderId: null };
})();

const listeners = new Set<(s: Selection) => void>();

function emit() {
  try { localStorage.setItem(KEY, JSON.stringify(current)); } catch {}
  for (const l of listeners) l(current);
}

export function getSelection(): Selection { return current; }

export function setWorkspaceSelection(workspaceId: string | null, folderId: string | null = null) {
  current = { workspaceId, folderId };
  emit();
}

export function setFolderSelection(folderId: string | null) {
  current = { ...current, folderId };
  emit();
}

export function useWorkspaceSelection(): Selection {
  const [s, setS] = useState(current);
  useEffect(() => {
    const fn = (next: Selection) => setS(next);
    listeners.add(fn);
    return () => { listeners.delete(fn); };
  }, []);
  return s;
}
