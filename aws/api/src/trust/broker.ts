import { query, queryOne } from '../db';
import { ensureConnectorSchema } from '../connectors/schema';

/**
 * Credential broker (L6). Connectors act THROUGH this — it holds per-user OAuth
 * tokens and never returns raw credentials to the client. The Lambda's MCP client
 * fetches a token here at call time; the browser only ever sees connection status.
 *
 * TODO (before production): encrypt `token` at rest with KMS. Stored as JSONB for
 * now; no real tokens flow until the OAuth exchange is wired (UI-1 / Phase 1).
 */

export interface TokenRecord {
  token: unknown;
  account: string | null;
  scopes: string[] | null;
}

export async function storeToken(
  userId: string, source: string, token: unknown,
  account: string | null = null, scopes: string[] | null = null,
): Promise<void> {
  await ensureConnectorSchema();
  await query(
    `INSERT INTO connector_credentials (user_id, source, token, account, scopes)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, source) DO UPDATE SET
       token=EXCLUDED.token, account=EXCLUDED.account, scopes=EXCLUDED.scopes, updated_at=NOW()`,
    [userId, source, JSON.stringify(token), account, scopes],
  );
}

export async function getToken(userId: string, source: string): Promise<TokenRecord | null> {
  await ensureConnectorSchema();
  const r = await queryOne<{ token: unknown; account: string | null; scopes: string[] | null }>(
    `SELECT token, account, scopes FROM connector_credentials WHERE user_id=$1 AND source=$2`,
    [userId, source],
  );
  return r ? { token: r.token, account: r.account, scopes: r.scopes } : null;
}

export async function deleteToken(userId: string, source: string): Promise<void> {
  await ensureConnectorSchema();
  await query(`DELETE FROM connector_credentials WHERE user_id=$1 AND source=$2`, [userId, source]);
}
