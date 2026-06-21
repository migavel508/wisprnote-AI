import { query } from '../db';
import { getMcpServer, type McpServer } from './registry';
import { getToken } from '../trust/broker';
import { context as jiraContext } from '../connectors/jira/actions';

/**
 * Connector-agnostic MCP connection resolver. Returns the server + per-workspace token
 * (+ any connector-specific context like Jira's cloudId) for ANY connected MCP connector.
 * This is what lets the agent + the write executor treat Jira, GitHub, … uniformly —
 * add a connector by registering it in the MCP registry and (if it needs extra context
 * like cloudId) special-casing it here; everything downstream is generic.
 */

export interface McpConn {
  connector: string;
  server: McpServer;
  token: string;
  cloudId?: string;   // Jira (Atlassian) only — injected into tools whose schema needs it
  siteUrl?: string;   // for building human links
}

export async function resolveMcpConnection(userId: string, workspaceId: string, connector: string): Promise<McpConn | null> {
  if (connector === 'jira') {
    const ctx = await jiraContext(userId, workspaceId).catch(() => null);
    return ctx ? { connector: 'jira', server: ctx.server, token: ctx.at, cloudId: ctx.cloudId, siteUrl: ctx.siteUrl } : null;
  }
  // Generic remote MCP: server from the registry OR a user-added custom connector, + the
  // workspace's OAuth token. (Custom connectors are looked up by slug; no-auth ones need no token.)
  let server = getMcpServer(connector);
  if (!server && connector.startsWith('custom-')) {
    const { getCustomConnectorServer } = await import('./customConnectors');
    server = await getCustomConnectorServer(userId, workspaceId, connector).catch(() => null) || undefined as any;
  }
  if (!server?.url) return null;
  const cred = await getToken(userId, connector, workspaceId).catch(() => null);
  const token = ((cred?.token as any)?.access_token) ?? '';
  // OAuth connectors need a token; no-auth custom servers connect with an empty token.
  if (!token && server.auth !== 'none') return null;
  return { connector, server, token };
}

/** Which connectors are connected in this workspace (from connector_credentials). */
export async function connectedConnectors(userId: string, workspaceId: string): Promise<string[]> {
  const rows = await query<{ source: string }>(
    `SELECT DISTINCT source FROM connector_credentials WHERE user_id=$1 AND workspace_id=$2`,
    [userId, workspaceId],
  ).catch(() => []);
  return rows.map((r) => r.source);
}
