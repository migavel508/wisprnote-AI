import { query, queryOne } from '../db';
import { ensureConnectorSchema, ACCOUNT_SCOPE } from '../connectors/schema';

/**
 * Credential broker (L6). Connectors act THROUGH this — it holds per-user/per-workspace
 * OAuth tokens and never returns raw credentials to the client. The Lambda's MCP client
 * fetches a token here at call time; the browser only ever sees connection status.
 *
 * Connections are workspace-scoped: the same user can connect a *different* account of
 * the same tool in two workspaces. `workspaceId` defaults to ACCOUNT_SCOPE (the
 * account-level / legacy bucket) so older call-sites keep compiling.
 *
 * TODO (before production): encrypt `token` at rest with KMS.
 */

export interface TokenRecord {
  token: unknown;
  account: string | null;
  scopes: string[] | null;
}

export async function storeToken(
  userId: string, source: string, token: unknown,
  account: string | null = null, scopes: string[] | null = null,
  workspaceId: string = ACCOUNT_SCOPE,
): Promise<void> {
  await ensureConnectorSchema();
  await query(
    `INSERT INTO connector_credentials (user_id, workspace_id, source, token, account, scopes)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, workspace_id, source) DO UPDATE SET
       token=EXCLUDED.token, account=EXCLUDED.account, scopes=EXCLUDED.scopes, updated_at=NOW()`,
    [userId, workspaceId, source, JSON.stringify(token), account, scopes],
  );
}

export async function getToken(
  userId: string, source: string, workspaceId: string = ACCOUNT_SCOPE,
): Promise<TokenRecord | null> {
  await ensureConnectorSchema();
  const r = await queryOne<{ token: unknown; account: string | null; scopes: string[] | null }>(
    `SELECT token, account, scopes FROM connector_credentials
      WHERE user_id=$1 AND workspace_id=$2 AND source=$3`,
    [userId, workspaceId, source],
  );
  if (!r) return null;

  // Auto-refresh expired OAuth tokens (transparent to every caller). Only fires when the
  // refresh metadata was stored at connect (oauth_meta) — PAT connectors (github) skip this.
  let token: any = r.token;
  const m = token?.oauth_meta;
  if (m?.client_id && token?.refresh_token && token?.expires_at && Date.now() > token.expires_at) {
    try {
      const { refreshMcpOAuth } = await import('../mcp/oauth');
      const fresh = await refreshMcpOAuth(
        { tokenEndpoint: m.token_endpoint, clientId: m.client_id, clientSecret: m.client_secret ?? null },
        token.refresh_token,
      );
      token = {
        ...fresh.raw,
        refresh_token: fresh.refresh_token,                 // rotated — keep the new one
        oauth_meta: m,
        expires_at: fresh.expires_in ? Date.now() + (fresh.expires_in - 60) * 1000 : null,
      };
      await storeToken(userId, source, token, r.account, r.scopes, workspaceId);
      console.log('oauth_refreshed', JSON.stringify({ source, workspaceId }));
    } catch (e: any) {
      console.error('oauth_refresh_failed', JSON.stringify({ source, message: e?.message }));
      // fall through with the stale token; the caller fails gracefully + user can reconnect
    }
  }
  return { token, account: r.account, scopes: r.scopes };
}

export async function deleteToken(
  userId: string, source: string, workspaceId: string = ACCOUNT_SCOPE,
): Promise<void> {
  await ensureConnectorSchema();
  await query(
    `DELETE FROM connector_credentials WHERE user_id=$1 AND workspace_id=$2 AND source=$3`,
    [userId, workspaceId, source],
  );
}
