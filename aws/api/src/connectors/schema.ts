import { query } from '../db';

/**
 * Connector foundation schema (additive — never touches existing tables).
 *  - knowledge_item: the canonical normalized record for every source (L3 unifier).
 *  - sync_state:     per-connector incremental cursor.
 *  - connector_credentials: per-user OAuth tokens, read only by the broker.
 *
 * Created lazily (the `ensure*Schema` pattern). bigserial ids avoid any pgcrypto
 * dependency. All scoping is by user_id, enforced in the Lambda like every other table.
 */

let ready: Promise<void> | null = null;

export function ensureConnectorSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS knowledge_item (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID,
          source TEXT NOT NULL,
          source_id TEXT NOT NULL,
          type TEXT NOT NULL,
          title TEXT,
          body TEXT,
          people JSONB,
          links JSONB,
          raw JSONB NOT NULL DEFAULT '{}'::jsonb,
          occurred_at TIMESTAMPTZ,
          synced_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, source, source_id, type)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS knowledge_item_user_src_idx ON knowledge_item (user_id, source)`);
      await query(`
        CREATE TABLE IF NOT EXISTS sync_state (
          user_id UUID NOT NULL,
          source TEXT NOT NULL,
          scope TEXT NOT NULL DEFAULT 'default',
          cursor TEXT,
          last_synced_at TIMESTAMPTZ,
          PRIMARY KEY (user_id, source, scope)
        )
      `);
      await query(`
        CREATE TABLE IF NOT EXISTS connector_credentials (
          user_id UUID NOT NULL,
          source TEXT NOT NULL,
          token JSONB NOT NULL,            -- TODO: encrypt at rest via KMS before production
          account TEXT,
          scopes TEXT[],
          connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, source)
        )
      `);
      // In-flight OAuth (PKCE verifier + dynamically-registered client) between the
      // oauth-url and exchange calls. Short-lived; keyed by the CSRF `state`.
      await query(`
        CREATE TABLE IF NOT EXISTS oauth_state (
          state TEXT PRIMARY KEY,
          user_id UUID NOT NULL,
          source TEXT NOT NULL,
          inflight JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}
