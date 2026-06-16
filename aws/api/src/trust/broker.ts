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
  return r ? { token: r.token, account: r.account, scopes: r.scopes } : null;
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
