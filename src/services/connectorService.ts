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

export async function listConnectors(): Promise<{ enabled: boolean; connectors: ConnectorStatus[] }> {
  try {
    const r = await authed('/connectors', { method: 'GET' });
    if (!r.ok) return { enabled: false, connectors: [] };
    return await r.json();
  } catch {
    return { enabled: false, connectors: [] };
  }
}

/** Get the provider authorize URL (server does discovery + DCR + PKCE). */
export async function getConnectorOAuthUrl(id: string): Promise<string> {
  const r = await authed(`/connectors/${id}/oauth-url`, { method: 'POST', body: '{}' });
  if (!r.ok) throw new Error(`Could not start ${id} connection (${r.status})`);
  const data = await r.json();
  if (!data.url) throw new Error('No authorize URL returned');
  return data.url as string;
}

/** Exchange the OAuth callback code for a stored token (server-side). */
export async function exchangeConnector(id: string, code: string, state: string): Promise<void> {
  const r = await authed(`/connectors/${id}/exchange`, { method: 'POST', body: JSON.stringify({ code, state }) });
  if (!r.ok) throw new Error(`Could not finish ${id} connection (${r.status})`);
}

export async function disconnectConnector(id: string): Promise<void> {
  await authed(`/connectors/${id}`, { method: 'DELETE' });
}
