import { query, queryOne } from '../db';
import { getMcpServer, type McpServer } from './registry';
import { getSecrets } from '../secrets';

// Connectors whose remote endpoint isn't a fixed public URL (Google Workspace, Slack). Following
// the reference's `mcp add` model, the endpoint is BRING-YOUR-OWN: the user supplies the MCP server
// URL (+ optional OAuth client) per the named card, stored in custom_connector keyed by the
// connector's OWN id. An operator-wide fallback (Secrets Manager) is also honored. Either way it
// then rides the exact same generic flow as Jira/GitHub. Google's Gmail/Calendar/Drive share one URL.
const GOOGLE_FAMILY = new Set(['gmail', 'gcal', 'gdrive']);

/** A user-configured BYO endpoint for a catalog connector (custom_connector row keyed by its id). */
async function storedEndpoint(userId: string, workspaceId: string, id: string): Promise<{ url: string; auth: string; clientId: string | null; clientSecret: string | null } | null> {
  await ensureCustomConnectorSchema();
  const row = await queryOne<{ url: string; auth: string; oauth_client_id: string | null; oauth_client_secret: string | null }>(
    `SELECT url, auth, oauth_client_id, oauth_client_secret FROM custom_connector WHERE user_id=$1 AND workspace_id=$2 AND slug=$3`,
    [userId, workspaceId, id],
  ).catch(() => null);
  return row?.url ? { url: row.url, auth: row.auth, clientId: row.oauth_client_id, clientSecret: row.oauth_client_secret } : null;
}

/** Fill a registry server's null url: user's BYO endpoint first, then operator secrets. */
async function withConfiguredEndpoint(server: McpServer, userId?: string, workspaceId?: string): Promise<McpServer> {
  if (server.url) return server;                       // already pinned (jira/github)
  if (userId && workspaceId) {
    const st = await storedEndpoint(userId, workspaceId, server.id);
    if (st) return { ...server, url: st.url, auth: st.auth === 'none' ? 'none' : server.auth };
  }
  const s = await getSecrets().catch(() => null);
  if (s && GOOGLE_FAMILY.has(server.id) && s.MCP_GOOGLE_URL) return { ...server, url: s.MCP_GOOGLE_URL };
  if (s && server.id === 'slack' && s.MCP_SLACK_URL) return { ...server, url: s.MCP_SLACK_URL };
  return server;                                       // not configured → stays null (not connectable)
}

/** The pre-registered OAuth client (Google/Slack can't auto-register): user's first, then secrets. */
export async function getRegistryOAuthClient(id: string, userId?: string, workspaceId?: string): Promise<{ clientId: string; clientSecret: string | null } | null> {
  if (userId && workspaceId) {
    const st = await storedEndpoint(userId, workspaceId, id);
    if (st?.clientId) return { clientId: st.clientId, clientSecret: st.clientSecret };
  }
  const s = await getSecrets().catch(() => null);
  if (s && GOOGLE_FAMILY.has(id) && s.GOOGLE_OAUTH_CLIENT_ID) return { clientId: s.GOOGLE_OAUTH_CLIENT_ID, clientSecret: s.GOOGLE_OAUTH_CLIENT_SECRET || null };
  if (s && id === 'slack' && s.SLACK_OAUTH_CLIENT_ID) return { clientId: s.SLACK_OAUTH_CLIENT_ID, clientSecret: s.SLACK_OAUTH_CLIENT_SECRET || null };
  return null;
}

/** True if this registry connector has a usable endpoint now (pinned, user-configured, or secret). */
export async function isConnectorAvailable(id: string, userId?: string, workspaceId?: string): Promise<boolean> {
  const base = getMcpServer(id);
  if (!base) return false;
  if (base.transport === 'local') return false;        // local connectors aren't MCP-connect
  return !!(await withConfiguredEndpoint(base, userId, workspaceId)).url;
}

/** Configure a catalog connector with a user-supplied MCP endpoint (+ optional OAuth client),
 *  stored under the connector's own id so the rest of the system resolves it like any server.
 *  Idempotent (upsert). This is the BYO-endpoint half of "Connect" on a named card. */
export async function configureCatalogConnector(userId: string, workspaceId: string, id: string, input: { url: string; oauthClientId?: string | null; oauthClientSecret?: string | null; auth?: string }): Promise<void> {
  await ensureCustomConnectorSchema();
  const base = getMcpServer(id);
  await query(
    `INSERT INTO custom_connector (user_id, workspace_id, slug, name, url, auth, oauth_client_id, oauth_client_secret, mode)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'individual')
     ON CONFLICT (user_id, workspace_id, slug) DO UPDATE SET
       url=EXCLUDED.url, auth=EXCLUDED.auth, oauth_client_id=EXCLUDED.oauth_client_id, oauth_client_secret=EXCLUDED.oauth_client_secret`,
    [userId, workspaceId, id, base?.label || id, input.url.trim(), input.auth === 'none' ? 'none' : 'oauth', input.oauthClientId || null, input.oauthClientSecret || null],
  );
}

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

/** Unified server resolver: static registry (with configured-endpoint overlay) first, then this
 *  user's custom connectors. */
export async function getServerConfig(userId: string, workspaceId: string, id: string): Promise<McpServer | null> {
  const reg = getMcpServer(id);
  if (reg) return await withConfiguredEndpoint(reg, userId, workspaceId);
  return await getCustomConnectorServer(userId, workspaceId, id);
}
