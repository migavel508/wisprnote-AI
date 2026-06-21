import { query, queryOne } from '../db';
import { getMcpServer, type McpServer } from './registry';

/**
 * CUSTOM CONNECTORS — user-added remote MCP servers (the "Add custom connector" flow). The static
 * `registry.ts` is the curated bootstrap list; this lets a user point the app at ANY remote MCP
 * server by URL. Once stored + connected, EVERYTHING downstream is generic: the tool plane
 * discovers/classifies its tools, the permission engine governs them, and the gate enforces — no
 * per-connector code. A custom connector's `slug` IS its connector id everywhere (routes,
 * connector_credentials.source, connector_tool, tool_permission).
 *
 * NOTE: `oauth_client_secret` is stored here for now (same posture as broker tokens) — TODO KMS-encrypt.
 */

let schemaP: Promise<void> | null = null;
export function ensureCustomConnectorSchema(): Promise<void> {
  if (!schemaP) schemaP = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS custom_connector (
        user_id      UUID NOT NULL,
        workspace_id UUID NOT NULL,
        slug         TEXT NOT NULL,
        name         TEXT NOT NULL,
        url          TEXT NOT NULL,
        auth         TEXT NOT NULL DEFAULT 'oauth',   -- 'oauth' | 'none'
        oauth_client_id     TEXT,
        oauth_client_secret TEXT,
        mode         TEXT NOT NULL DEFAULT 'individual',
        created_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, workspace_id, slug)
      )`);
  })().then(() => {}).catch((e) => { schemaP = null; throw e; });
  return schemaP;
}

function slugify(name: string): string {
  const base = String(name || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '').slice(0, 24) || 'connector';
  const rand = Math.random().toString(36).slice(2, 8);
  return `custom-${base}-${rand}`;
}

export interface CustomConnectorRow { slug: string; name: string; url: string; auth: string; mode: string }

export async function createCustomConnector(userId: string, workspaceId: string, input: {
  name: string; url: string; oauthClientId?: string | null; oauthClientSecret?: string | null; mode?: string; auth?: string;
}): Promise<CustomConnectorRow> {
  await ensureCustomConnectorSchema();
  const slug = slugify(input.name);
  const row: CustomConnectorRow = {
    slug, name: input.name.trim(), url: input.url.trim(),
    auth: input.auth === 'none' ? 'none' : 'oauth', mode: input.mode || 'individual',
  };
  await query(
    `INSERT INTO custom_connector (user_id, workspace_id, slug, name, url, auth, oauth_client_id, oauth_client_secret, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
    [userId, workspaceId, slug, row.name, row.url, row.auth, input.oauthClientId || null, input.oauthClientSecret || null, row.mode],
  );
  return row;
}

export async function listCustomConnectors(userId: string, workspaceId: string): Promise<CustomConnectorRow[]> {
  await ensureCustomConnectorSchema();
  return await query<CustomConnectorRow>(
    `SELECT slug, name, url, auth, mode FROM custom_connector WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC`,
    [userId, workspaceId],
  ).catch(() => []);
}

export async function deleteCustomConnector(userId: string, workspaceId: string, slug: string): Promise<void> {
  await ensureCustomConnectorSchema();
  await query(`DELETE FROM custom_connector WHERE user_id=$1 AND workspace_id=$2 AND slug=$3`, [userId, workspaceId, slug]).catch(() => {});
}

/** Build an McpServer config from a stored custom connector, so the rest of the system treats it
 *  exactly like a registry server. null if not found. */
export async function getCustomConnectorServer(userId: string, workspaceId: string, slug: string): Promise<McpServer | null> {
  if (!slug || !slug.startsWith('custom-')) return null;
  await ensureCustomConnectorSchema();
  const row = await queryOne<{ name: string; url: string; auth: string }>(
    `SELECT name, url, auth FROM custom_connector WHERE user_id=$1 AND workspace_id=$2 AND slug=$3`,
    [userId, workspaceId, slug],
  ).catch(() => null);
  if (!row) return null;
  return {
    id: slug, label: row.name, transport: 'streamable-http', url: row.url,
    auth: row.auth === 'none' ? 'none' : 'oauth2.1', official: false, scopes: [],
    docs: '', status: 'community', connect: 'oauth',
  };
}

/** The custom connector's pre-registered OAuth client (Advanced settings), if any. */
export async function getCustomConnectorOAuthClient(userId: string, workspaceId: string, slug: string): Promise<{ clientId: string; clientSecret: string | null } | null> {
  await ensureCustomConnectorSchema();
  const row = await queryOne<{ oauth_client_id: string | null; oauth_client_secret: string | null }>(
    `SELECT oauth_client_id, oauth_client_secret FROM custom_connector WHERE user_id=$1 AND workspace_id=$2 AND slug=$3`,
    [userId, workspaceId, slug],
  ).catch(() => null);
  return row?.oauth_client_id ? { clientId: row.oauth_client_id, clientSecret: row.oauth_client_secret } : null;
}

/** Unified server resolver: static registry first, then this user's custom connectors. */
export async function getServerConfig(userId: string, workspaceId: string, id: string): Promise<McpServer | null> {
  return getMcpServer(id) || await getCustomConnectorServer(userId, workspaceId, id);
}
