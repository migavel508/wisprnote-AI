import { invoke } from '@tauri-apps/api/core';
import { ingestLocalSessions } from './connectorService';
import { logger } from '../lib/logger';

const log = logger.scope('localSessions');

/**
 * Local dev-session connector (client side) — Claude Code + Codex.
 *
 * The Rust side (`dev_sessions.rs`) reads + REDACTS the on-disk transcripts and returns compact
 * digests; this service maps each session's `cwd` to a connected workspace folder, keeps an
 * incremental cursor, and uploads only sessions in connected projects (the user's chosen scope).
 *
 * The cwd→folder mapping is **machine-specific** (those paths only exist on this device), so it
 * lives in localStorage rather than the server.
 */

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

// ── Types (mirror the Rust structs; serde emits camelCase) ─────────────────────────────────
export interface SessionDigest {
  source: 'claude-code' | 'codex';
  sessionId: string;
  cwd: string;
  folderId?: string | null;
  gitBranch?: string | null;
  model?: string | null;
  startedAt?: string | null;
  endedAt?: string | null;
  turnCount?: number;
  userPrompts?: string[];
  assistantText?: string[];
  files?: string[];
  commands?: string[];
  mtimeMs?: number;
  bytes?: number;
}
export interface DevProject {
  cwd: string;
  source: 'claude-code' | 'codex';
  sessionCount: number;
  lastActiveMs: number;
}
export interface ScanResult {
  sessions: SessionDigest[];
  skippedCompressed: number;
  skippedLarge: number;
  errors: number;
}

// ── Rust command wrappers ───────────────────────────────────────────────────────────────────
/** Detected local projects (grouped by cwd), for the mapping UI. */
export async function listDevProjects(): Promise<DevProject[]> {
  if (!isTauri) return [];
  try { return (await invoke<DevProject[]>('list_dev_projects')) || []; }
  catch (e) { log.warn('list_dev_projects_failed', { e: String(e) }); return []; }
}

async function scanDevSessions(filterPaths: string[] | null, sinceMs: number): Promise<ScanResult> {
  const empty: ScanResult = { sessions: [], skippedCompressed: 0, skippedLarge: 0, errors: 0 };
  if (!isTauri) return empty;
  try {
    return (await invoke<ScanResult>('scan_dev_sessions', { filterPaths, sinceMs })) || empty;
  } catch (e) { log.warn('scan_dev_sessions_failed', { e: String(e) }); return empty; }
}

// ── Machine-local mapping + cursor (localStorage) ────────────────────────────────────────────
type PathMap = Record<string, string>;   // local cwd path → workspace folderId

const mapKey = (ws: string) => `localDevPaths:${ws}`;
const cursorKey = (ws: string) => `localDevCursor:${ws}`;

export function getPathMappings(workspaceId: string): PathMap {
  try { return JSON.parse(localStorage.getItem(mapKey(workspaceId)) || '{}') || {}; }
  catch { return {}; }
}
export function setPathMapping(workspaceId: string, path: string, folderId: string | null): void {
  const m = getPathMappings(workspaceId);
  if (folderId) m[path] = folderId; else delete m[path];
  localStorage.setItem(mapKey(workspaceId), JSON.stringify(m));
}

function getCursor(workspaceId: string): number {
  const n = Number(localStorage.getItem(cursorKey(workspaceId)) || '0');
  return Number.isFinite(n) ? n : 0;
}
function setCursor(workspaceId: string, ms: number): void {
  localStorage.setItem(cursorKey(workspaceId), String(ms));
}

/** Longest-prefix match: a session's cwd belongs to the mapped path that most specifically
 *  contains it (so nested mappings resolve to the deepest folder). */
function resolveFolder(cwd: string, paths: string[], map: PathMap): string | null {
  let best: string | null = null;
  for (const p of paths) {
    const norm = p.replace(/\/+$/, '');
    if (cwd === norm || cwd.startsWith(`${norm}/`)) {
      if (!best || norm.length > best.length) best = norm;
    }
  }
  return best ? map[best] || map[`${best}/`] || null : null;
}

export interface SyncSummary {
  upserted: number; skipped: number; scanned: number;
  skippedCompressed: number; skippedLarge: number; mappedProjects: number;
}

/** Read → filter to connected projects → attach folderId → upload. Incremental via mtime cursor. */
export async function syncLocalSessions(workspaceId: string): Promise<SyncSummary> {
  const base: SyncSummary = { upserted: 0, skipped: 0, scanned: 0, skippedCompressed: 0, skippedLarge: 0, mappedProjects: 0 };
  if (!isTauri || !workspaceId) return base;

  const map = getPathMappings(workspaceId);
  const paths = Object.keys(map).map((p) => p.replace(/\/+$/, ''));
  base.mappedProjects = paths.length;
  if (!paths.length) return base;   // only connected projects are ingested — nothing mapped yet

  const since = getCursor(workspaceId);
  const scan = await scanDevSessions(paths, since);
  base.scanned = scan.sessions.length;
  base.skippedCompressed = scan.skippedCompressed;
  base.skippedLarge = scan.skippedLarge;
  if (!scan.sessions.length) return base;

  let maxMtime = since;
  const sessions = scan.sessions.map((s) => {
    if (typeof s.mtimeMs === 'number' && s.mtimeMs > maxMtime) maxMtime = s.mtimeMs;
    return { ...s, folderId: resolveFolder(s.cwd, paths, map) };
  });

  try {
    const r = await ingestLocalSessions(workspaceId, sessions);
    base.upserted = r.upserted; base.skipped = r.skipped;
    // Advance the cursor only after a successful upload so a failure re-tries next time.
    if (maxMtime > since) setCursor(workspaceId, maxMtime);
  } catch (e) {
    log.warn('local_ingest_failed', { e: String(e) });
  }
  return base;
}
