import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';

/**
 * Client for the `/connectors/*` API. Connections are OAuth-via-MCP: the server
 * runs the DCR+PKCE flow; the client just opens the authorize URL and forwards the
 * callback code. Tokens never reach the client — only connection status does.
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const baseFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

/** Connectors are off by default — opt in with VITE_CONNECTORS=1. */
export function isConnectorsEnabled(): boolean {
  return import.meta.env.VITE_CONNECTORS === '1';
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken();
  return baseFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: token, ...(init.headers || {}) },
  });
}

export interface ConnectorStatus {
  id: string;
  connected: boolean;
  account: string | null;
  status: string;
}

/**
 * Connections are workspace-scoped — pass the active workspace id so a user can connect
 * a different account of the same tool per workspace (multi-company isolation). When
 * omitted, the server uses the account-level sentinel.
 */
export async function listConnectors(workspaceId?: string): Promise<{ enabled: boolean; connectors: ConnectorStatus[] }> {
  try {
    const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
    const r = await authed(`/connectors${qs}`, { method: 'GET' });
    if (!r.ok) return { enabled: false, connectors: [] };
    return await r.json();
  } catch {
    return { enabled: false, connectors: [] };
  }
}

/** Get the provider authorize URL (server does discovery + DCR + PKCE). */
export async function getConnectorOAuthUrl(id: string, workspaceId?: string): Promise<string> {
  const r = await authed(`/connectors/${id}/oauth-url`, {
    method: 'POST',
    body: JSON.stringify(workspaceId ? { workspace: workspaceId } : {}),
  });
  if (!r.ok) throw new Error(`Could not start ${id} connection (${r.status})`);
  const data = await r.json();
  if (!data.url) throw new Error('No authorize URL returned');
  return data.url as string;
}

/** Exchange the OAuth callback code for a stored token (server-side). The target
 *  workspace was recorded server-side at oauth-url time, so it isn't needed here. */
export async function exchangeConnector(id: string, code: string, state: string): Promise<void> {
  const r = await authed(`/connectors/${id}/exchange`, { method: 'POST', body: JSON.stringify({ code, state }) });
  if (!r.ok) throw new Error(`Could not finish ${id} connection (${r.status})`);
}

export async function disconnectConnector(id: string, workspaceId?: string): Promise<void> {
  const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
  await authed(`/connectors/${id}${qs}`, { method: 'DELETE' });
}

// ── Project mapping: scope a workspace's brain to its exact Jira project + GitHub repos ──
export interface ProjectMapping { jiraProject: string | null; githubRepos: string[] }

const folderQs = (folderId?: string | null) => (folderId ? `&folder=${encodeURIComponent(folderId)}` : '');

/** Mapping for a FOLDER (project) — or, with no folderId, the workspace default. */
export async function getProjectMapping(workspaceId: string, folderId?: string | null): Promise<ProjectMapping> {
  try {
    const r = await authed(`/connectors/routing?workspace=${encodeURIComponent(workspaceId)}${folderQs(folderId)}`, { method: 'GET' });
    if (!r.ok) return { jiraProject: null, githubRepos: [] };
    return await r.json();
  } catch { return { jiraProject: null, githubRepos: [] }; }
}

/** Set the Jira project or GitHub repos a FOLDER (project) maps to — or the workspace default. */
export async function setProjectMapping(workspaceId: string, m: { source: 'jira' | 'github'; projectKey?: string; repos?: string[] }, folderId?: string | null): Promise<void> {
  await authed(`/connectors/routing?workspace=${encodeURIComponent(workspaceId)}${folderQs(folderId)}`, { method: 'POST', body: JSON.stringify(m) }).catch(() => {});
}

/** Upload compact, redacted local dev-session digests (Claude Code / Codex) to the brain.
 *  The desktop reads + redacts them locally; only the digest crosses the wire. */
export async function ingestLocalSessions(workspaceId: string, sessions: unknown[]): Promise<{ upserted: number; skipped: number }> {
  if (!sessions.length) return { upserted: 0, skipped: 0 };
  const r = await authed(`/connectors/local/ingest?workspace=${encodeURIComponent(workspaceId)}`, {
    method: 'POST', body: JSON.stringify({ sessions }),
  });
  if (!r.ok) throw new Error(`Local session ingest failed (${r.status})`);
  return await r.json();
}

/** Connect a PAT-based connector (e.g. GitHub) by storing a validated token server-side. */
export async function setConnectorToken(id: string, token: string, workspaceId?: string): Promise<{ connected: boolean; error?: string }> {
  const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
  const r = await authed(`/connectors/${id}/pat${qs}`, { method: 'POST', body: JSON.stringify({ token }) });
  if (!r.ok) return { connected: false, error: `Could not connect ${id} (${r.status}).` };
  return await r.json();
}

// ── Custom connectors (user-added remote MCP servers) ──────────────────────────────────────
export interface CustomConnector { slug: string; name: string; url: string; auth: string; mode: string }

export async function listCustomConnectors(workspaceId: string): Promise<CustomConnector[]> {
  try {
    const r = await authed(`/connectors/custom?workspace=${encodeURIComponent(workspaceId)}`, { method: 'GET' });
    if (!r.ok) return [];
    return (await r.json()).connectors || [];
  } catch { return []; }
}

/** Create a custom connector. Returns its slug + whether it needs an OAuth sign-in next. */
export async function createCustomConnector(workspaceId: string, input: { name: string; url: string; oauthClientId?: string; oauthClientSecret?: string; mode?: string }): Promise<{ slug: string; name: string; needsAuth: boolean }> {
  const r = await authed(`/connectors/custom?workspace=${encodeURIComponent(workspaceId)}`, { method: 'POST', body: JSON.stringify(input) });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || `Could not add connector (${r.status}).`); }
  return await r.json();
}

export async function deleteCustomConnector(workspaceId: string, slug: string): Promise<void> {
  await authed(`/connectors/custom/${encodeURIComponent(slug)}?workspace=${encodeURIComponent(workspaceId)}`, { method: 'DELETE' }).catch(() => {});
}

// ── Tool permissions (the per-tool trust plane — the connector's discovered tools + policy) ──
export type ToolBehavior = 'allow' | 'ask' | 'deny';
export type ToolKlass = 'read' | 'write' | 'destructive';
export interface ConnectorTool {
  connector: string; tool_name: string; description: string | null;
  klass: ToolKlass; read_only: boolean; destructive: boolean; behavior: ToolBehavior;
}

/** The connector's discovered tool catalog, each with its RESOLVED behaviour (rule → class default). */
export async function getConnectorTools(connectorId: string, workspaceId: string): Promise<ConnectorTool[]> {
  try {
    const r = await authed(`/connectors/${connectorId}/tools?workspace=${encodeURIComponent(workspaceId)}`, { method: 'GET' });
    if (!r.ok) return [];
    return (await r.json()).tools || [];
  } catch { return []; }
}

/** Set (behavior) or clear (null = back to class default) a per-tool rule. tool='*' = connector-wide. */
export async function setConnectorToolPermission(connectorId: string, workspaceId: string, tool: string, behavior: ToolBehavior | null): Promise<void> {
  await authed(`/connectors/${connectorId}/tool-permission?workspace=${encodeURIComponent(workspaceId)}`, {
    method: 'POST', body: JSON.stringify({ tool, behavior }),
  }).catch(() => {});
}
