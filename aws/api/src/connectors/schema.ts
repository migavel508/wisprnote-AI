import { query } from '../db';

/**
 * Connector foundation schema (additive — never touches existing tables destructively).
 *  - knowledge_item: the canonical normalized record for every source (L3 unifier).
 *  - sync_state:     per-connector incremental cursor (scope = workspace_id).
 *  - connector_credentials: per-user/per-workspace OAuth tokens, read only by the broker.
 *
 * Created lazily (the `ensure*Schema` pattern). bigserial ids avoid any pgcrypto
 * dependency. Scoping is by user_id AND workspace_id — a user can run two companies
 * in two workspaces and connect a *different* Jira in each, fully isolated.
 *
 * Backward compatibility: pre-existing rows (connected before workspace scoping) are
 * backfilled to the user's default (earliest) workspace, so the live connection keeps
 * working and shows up in that workspace. Users with no workspace fall back to the
 * ACCOUNT_SCOPE sentinel (an "account-level / unscoped" bucket).
 */

/** Sentinel workspace for account-level / unscoped connections (and the NOT NULL default). */
export const ACCOUNT_SCOPE = '00000000-0000-0000-0000-000000000000';

let ready: Promise<void> | null = null;

export function ensureConnectorSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      // ── Fresh-install shape (already workspace-scoped) ──────────────────────
      await query(`
        CREATE TABLE IF NOT EXISTS knowledge_item (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL DEFAULT '${ACCOUNT_SCOPE}',
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
          UNIQUE (user_id, workspace_id, source, source_id, type)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS knowledge_item_user_src_idx ON knowledge_item (user_id, source)`);
      await query(`CREATE INDEX IF NOT EXISTS knowledge_item_ws_src_idx ON knowledge_item (user_id, workspace_id, source)`);
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
          workspace_id UUID NOT NULL DEFAULT '${ACCOUNT_SCOPE}',
          source TEXT NOT NULL,
          token JSONB NOT NULL,            -- TODO: encrypt at rest via KMS before production
          account TEXT,
          scopes TEXT[],
          connected_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, workspace_id, source)
        )
      `);
      // In-flight OAuth (PKCE verifier + dynamically-registered client) between the
      // oauth-url and exchange calls. Short-lived; keyed by the CSRF `state`. The
      // target workspace travels here so `exchange` stores the token in the right one.
      await query(`
        CREATE TABLE IF NOT EXISTS oauth_state (
          state TEXT PRIMARY KEY,
          user_id UUID NOT NULL,
          source TEXT NOT NULL,
          workspace_id UUID NOT NULL DEFAULT '${ACCOUNT_SCOPE}',
          inflight JSONB NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // ── Migration for installs created before workspace scoping ─────────────
      await migrateExisting();
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/**
 * Idempotent migration that adds workspace_id to pre-existing connector tables and
 * re-keys them. Each step is guarded so it's safe to run on every warm container and
 * on fresh installs (where the columns/constraints already match and the steps no-op).
 */
async function migrateExisting(): Promise<void> {
  // 1) Add the column where missing.
  await query(`ALTER TABLE connector_credentials ADD COLUMN IF NOT EXISTS workspace_id UUID`);
  await query(`ALTER TABLE knowledge_item        ADD COLUMN IF NOT EXISTS workspace_id UUID`);
  await query(`ALTER TABLE oauth_state           ADD COLUMN IF NOT EXISTS workspace_id UUID`);
  // Brain content columns (kept apart from `body` so a re-sync can't clobber them): the
  // deterministic Tier-1 fingerprint and the lazy Tier-2 diff summary. Ensured centrally so
  // every read path (embed, brain-link) has them regardless of which job runs first.
  await query(`ALTER TABLE knowledge_item        ADD COLUMN IF NOT EXISTS fingerprint TEXT`);
  await query(`ALTER TABLE knowledge_item        ADD COLUMN IF NOT EXISTS enriched_summary TEXT`);
  // Live state of the item, mirrored from the backend (Jira status name / GitHub PR state).
  // First-class so the brain map can SHOW status and emit status-change events.
  await query(`ALTER TABLE knowledge_item        ADD COLUMN IF NOT EXISTS status TEXT`);
  // Co-architect advisory (Phase 2): the brain's read on a commit's code — assessment
  // (sound | concern | risk) + a one-line architectural suggestion. Produced from the REAL
  // diff during the alignment-verdict pass (no extra LLM call).
  await query(`ALTER TABLE knowledge_item        ADD COLUMN IF NOT EXISTS advisory_assessment TEXT`);
  await query(`ALTER TABLE knowledge_item        ADD COLUMN IF NOT EXISTS advisory_note TEXT`);

  // 2) Backfill NULLs: attach legacy connections/items to the user's default
  //    (earliest) workspace so they keep working in-place; sentinel if none.
  for (const tbl of ['connector_credentials', 'knowledge_item']) {
    await query(`
      UPDATE ${tbl} t
         SET workspace_id = COALESCE(
           (SELECT w.id FROM workspaces w WHERE w.user_id = t.user_id ORDER BY w.created_at ASC LIMIT 1),
           '${ACCOUNT_SCOPE}'::uuid)
       WHERE t.workspace_id IS NULL`);
  }
  await query(`UPDATE oauth_state SET workspace_id='${ACCOUNT_SCOPE}'::uuid WHERE workspace_id IS NULL`);

  // 3) Lock down: default + NOT NULL.
  for (const tbl of ['connector_credentials', 'knowledge_item', 'oauth_state']) {
    await query(`ALTER TABLE ${tbl} ALTER COLUMN workspace_id SET DEFAULT '${ACCOUNT_SCOPE}'`);
    await query(`ALTER TABLE ${tbl} ALTER COLUMN workspace_id SET NOT NULL`);
  }

  // 4) Re-key connector_credentials PK → (user_id, workspace_id, source). Look the
  //    old 2-col PK up by definition (name-agnostic), drop it, add the 3-col PK.
  await query(`
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'connector_credentials'::regclass AND contype = 'p'
           AND array_length(conkey, 1) = 2
      LOOP
        EXECUTE 'ALTER TABLE connector_credentials DROP CONSTRAINT ' || quote_ident(c);
      END LOOP;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'connector_credentials'::regclass AND contype = 'p'
           AND array_length(conkey, 1) = 3
      ) THEN
        ALTER TABLE connector_credentials ADD PRIMARY KEY (user_id, workspace_id, source);
      END IF;
    END $$;
  `);

  // 5) Re-key knowledge_item UNIQUE → (user_id, workspace_id, source, source_id, type).
  //    Drop ANY pre-workspace 4-col UNIQUE (by definition), add the 5-col one once.
  await query(`
    DO $$
    DECLARE c text;
    BEGIN
      FOR c IN
        SELECT conname FROM pg_constraint
         WHERE conrelid = 'knowledge_item'::regclass AND contype = 'u'
           AND array_length(conkey, 1) = 4
      LOOP
        EXECUTE 'ALTER TABLE knowledge_item DROP CONSTRAINT ' || quote_ident(c);
      END LOOP;
      IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
         WHERE conrelid = 'knowledge_item'::regclass AND contype = 'u'
           AND array_length(conkey, 1) = 5
      ) THEN
        ALTER TABLE knowledge_item
          ADD CONSTRAINT knowledge_item_ws_uk UNIQUE (user_id, workspace_id, source, source_id, type);
      END IF;
    END $$;
  `);
}
