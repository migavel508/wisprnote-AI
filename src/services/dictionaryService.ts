import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';
import { getSelection } from './workspaceSelection';
import { emitVaultEvent } from '../lib/vaultEvents';

/**
 * Dictionary — the user's custom vocabulary that fixes transcription of names, emails, jargon.
 * Per-USER (account-level): loaded once and cached; fed into realtime (Deepgram keyterms) and
 * batch (Gemini prompt), and applied as a misspelling→correction find/replace on new transcripts.
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = !!(window as any).__TAURI_INTERNALS__;
const httpFetch = isTauri ? (tauriFetch as unknown as typeof globalThis.fetch) : globalThis.fetch;

async function apiRequest<T = any>(method: string, path: string, body?: any): Promise<T> {
  const token = await getIdToken();
  const headers: Record<string, string> = { 'Content-Type': 'application/json', Authorization: token };
  const activeWs = getSelection().workspaceId;
  if (activeWs) headers['X-Workspace-Id'] = activeWs;
  const resp = await httpFetch(`${API_BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!resp.ok) {
    const text = await resp.text();
    let msg: string;
    try { msg = JSON.parse(text).message; } catch { msg = text; }
    throw Object.assign(new Error(msg || `API ${resp.status}`), { status: resp.status });
  }
  if (resp.status === 204) return undefined as unknown as T;
  return resp.json();
}

export interface DictionaryEntry {
  id: string;
  user_id: string;
  workspace_id: string | null;
  term: string;                 // the correct spelling / name / jargon
  misspelling: string | null;   // set → this is a "correct a misspelling" entry
  shared: boolean;
  created_at: string;
}

export const getDictionary = (): Promise<DictionaryEntry[]> => apiRequest('GET', '/dictionary');

export const createDictionaryEntry = async (
  term: string,
  opts?: { misspelling?: string | null; shared?: boolean },
): Promise<DictionaryEntry> => {
  const entry = await apiRequest<DictionaryEntry>('POST', '/dictionary', {
    term, misspelling: opts?.misspelling ?? null, shared: opts?.shared ?? false,
  });
  emitVaultEvent('dictionary:changed', {});
  return entry;
};

export const updateDictionaryEntry = async (
  id: string,
  data: { term?: string; misspelling?: string | null; shared?: boolean },
): Promise<DictionaryEntry> => {
  const entry = await apiRequest<DictionaryEntry>('PUT', `/dictionary/${id}`, data);
  emitVaultEvent('dictionary:changed', {});
  return entry;
};

export const deleteDictionaryEntry = async (id: string): Promise<void> => {
  await apiRequest('DELETE', `/dictionary/${id}`);
  emitVaultEvent('dictionary:changed', {});
};

// ── Cache + transcription helpers ────────────────────────────────────────────
// Loaded once per session; refreshed on 'dictionary:changed'. Used by the recorder + Gemini.
let _cache: DictionaryEntry[] | null = null;

/** Load (and cache) the user's dictionary. Force to bypass the cache after an edit. */
export async function loadDictionary(force = false): Promise<DictionaryEntry[]> {
  if (_cache && !force) return _cache;
  try { _cache = await getDictionary(); } catch { _cache = _cache ?? []; }
  return _cache;
}

export function cachedDictionary(): DictionaryEntry[] { return _cache ?? []; }
export function invalidateDictionaryCache(): void { _cache = null; }

/** Terms to bias STT toward (names/jargon + the correct spelling of each correction), deduped. */
export function dictionaryKeyterms(entries: DictionaryEntry[] = cachedDictionary()): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const e of entries) {
    const t = (e.term || '').trim();
    if (t.length < 2) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k); out.push(t);
  }
  return out;
}

/** Misspelling → correct-spelling map (only entries that are corrections). */
export function dictionaryCorrections(entries: DictionaryEntry[] = cachedDictionary()): Array<{ from: string; to: string }> {
  const out: Array<{ from: string; to: string }> = [];
  for (const e of entries) {
    const from = (e.misspelling || '').trim();
    const to = (e.term || '').trim();
    if (from && to && from.toLowerCase() !== to.toLowerCase()) out.push({ from, to });
  }
  return out;
}

/** The full dictionary as a correction context: all terms + known corrections. Scales with
 *  the dictionary (no keyterm cap) — fed to the LLM correction pass on finalize. */
export function dictionaryContext(entries: DictionaryEntry[] = cachedDictionary()): {
  terms: string[];
  corrections: Array<{ from: string; to: string }>;
} {
  return { terms: dictionaryKeyterms(entries), corrections: dictionaryCorrections(entries) };
}
