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

export async function getProjectMapping(workspaceId: string): Promise<ProjectMapping> {
  try {
    const r = await authed(`/connectors/routing?workspace=${encodeURIComponent(workspaceId)}`, { method: 'GET' });
    if (!r.ok) return { jiraProject: null, githubRepos: [] };
    return await r.json();
  } catch { return { jiraProject: null, githubRepos: [] }; }
}

/** Set the Jira project or the GitHub repos a workspace maps to. */
export async function setProjectMapping(workspaceId: string, m: { source: 'jira' | 'github'; projectKey?: string; repos?: string[] }): Promise<void> {
  await authed(`/connectors/routing?workspace=${encodeURIComponent(workspaceId)}`, { method: 'POST', body: JSON.stringify(m) }).catch(() => {});
}

/** Connect a PAT-based connector (e.g. GitHub) by storing a validated token server-side. */
export async function setConnectorToken(id: string, token: string, workspaceId?: string): Promise<{ connected: boolean; error?: string }> {
  const qs = workspaceId ? `?workspace=${encodeURIComponent(workspaceId)}` : '';
  const r = await authed(`/connectors/${id}/pat${qs}`, { method: 'POST', body: JSON.stringify({ token }) });
  if (!r.ok) return { connected: false, error: `Could not connect ${id} (${r.status}).` };
  return await r.json();
}
