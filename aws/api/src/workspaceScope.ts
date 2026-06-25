import { query, queryOne } from './db';

/**
 * WORKSPACE PARTITION (W0) — makes `workspace_id` the master scope of app data.
 *
 * A workspace is the user's "second primary id" / vault: every recording, note, and
 * knowledge-graph entry belongs to exactly one workspace, and switching workspace
 * re-partitions the whole app. This module owns the schema + the per-user default
 * workspace + the backfill that gives every existing row a home. Reads/writes start
 * honoring it in W1/W2; this phase is additive and non-breaking.
 */

// Lazy, idempotent schema (runs once per warm container — mirrors ensureChatSchema).
let _schemaReady: Promise<void> | null = null;
export function ensureWorkspacePartitionSchema(): Promise<void> {
  if (!_schemaReady) {
    _schemaReady = query('ALTER TABLE task_history ADD COLUMN IF NOT EXISTS workspace_id UUID')
      .then(() => query('ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false'))
      .then(() => query('CREATE INDEX IF NOT EXISTS idx_task_history_user_ws ON task_history(user_id, workspace_id, created_at DESC)'))
      // One-time per-user consolidation marker (see consolidateToDefaultOnce).
      .then(() => query('CREATE TABLE IF NOT EXISTS user_workspace_migration (user_id UUID PRIMARY KEY, consolidated_at TIMESTAMPTZ NOT NULL DEFAULT now())'))
      // One-time per-user "non-default workspaces → spaces (folders)" marker.
      .then(() => query('CREATE TABLE IF NOT EXISTS user_space_migration (user_id UUID PRIMARY KEY, migrated_at TIMESTAMPTZ NOT NULL DEFAULT now())'))
      // Space→Folder nesting: a folder with parent_id NULL is a SPACE; with parent_id
      // set it's a FOLDER inside that space. Self-ref FK cascades folders when a space
      // is deleted.
      .then(() => query('ALTER TABLE folders ADD COLUMN IF NOT EXISTS parent_id UUID REFERENCES folders(id) ON DELETE CASCADE'))
      .then(() => undefined)
      .catch((e) => { _schemaReady = null; throw e; }); // don't cache a failed migration
  }
  return _schemaReady;
}

/**
 * Resolve the user's DEFAULT (home) workspace id, creating one if they have none.
 * Preference: existing `is_default` → else the oldest workspace (promoted to default)
 * → else create one. The proper "user's name + profile photo" naming is applied by
 * the client; the server only guarantees a default exists so data can be partitioned.
 */
export async function resolveDefaultWorkspaceId(userId: string, email: string | null): Promise<string> {
  await ensureWorkspacePartitionSchema();

  // Guarantee EXACTLY ONE default per user. If several are flagged (a past race or a
  // legacy "My notes" alongside a promoted one), keep the oldest and demote the rest —
  // otherwise multiple workspaces render as "you" and look like duplicate vaults.
  const flagged = await query<{ id: string }>(
    'SELECT id FROM workspaces WHERE user_id=$1 AND is_default=true ORDER BY created_at ASC',
    [userId],
  );
  if (flagged.length === 1) return flagged[0].id;
  if (flagged.length > 1) {
    const keep = flagged[0].id;
    await query('UPDATE workspaces SET is_default=false WHERE user_id=$1 AND is_default=true AND id<>$2', [userId, keep]);
    return keep;
  }

  // None flagged: promote the legacy "My notes" if present, else the oldest workspace.
  const chosen = await queryOne<{ id: string }>(
    `SELECT id FROM workspaces WHERE user_id=$1
       ORDER BY (name = 'My notes') DESC, created_at ASC LIMIT 1`,
    [userId],
  );
  if (chosen) {
    await query('UPDATE workspaces SET is_default=true WHERE id=$1', [chosen.id]);
    return chosen.id;
  }

  const name = (email?.split('@')[0]?.trim()) || 'My Workspace';
  const created = await queryOne<{ id: string }>(
    `INSERT INTO workspaces (user_id, name, emoji, color, is_default)
     VALUES ($1,$2,'🗂️','#71717a',true) RETURNING id`,
    [userId, name],
  );
  return created!.id;
}

/**
 * ONE-TIME consolidation: move ALL of the user's recordings + chat into their single
 * default workspace, then record a marker so it never runs again. This undoes the
 * accidental fragmentation from the initial backfill (which homed some meetings into
 * other workspaces via task_workspaces) and matches the pre-partition reality where
 * all of an account's data was always shown together. After this runs once, new
 * recordings still go to whatever workspace is active (W2).
 */
export async function consolidateToDefaultOnce(userId: string, defaultWorkspaceId: string): Promise<void> {
  const done = await queryOne<{ one: number }>(
    'SELECT 1 AS one FROM user_workspace_migration WHERE user_id=$1',
    [userId],
  );
  if (done) return;
  await query(
    'UPDATE task_history SET workspace_id=$2 WHERE user_id=$1 AND (workspace_id IS NULL OR workspace_id<>$2)',
    [userId, defaultWorkspaceId],
  );
  await query(
    'UPDATE chat_history SET workspace_id=$2 WHERE user_id=$1 AND (workspace_id IS NULL OR workspace_id<>$2)',
    [userId, defaultWorkspaceId],
  );
  await query(
    'INSERT INTO user_workspace_migration (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING',
    [userId],
  );
}

/**
 * Validate a client-supplied workspace id belongs to the user (vault trust boundary).
 * Returns the id if owned, else null (caller falls back to the default).
 */
export async function validateOwnedWorkspaceId(userId: string, workspaceId: unknown): Promise<string | null> {
  if (typeof workspaceId !== 'string' || !workspaceId) return null;
  await ensureWorkspacePartitionSchema();
  const own = await queryOne<{ id: string }>(
    'SELECT id FROM workspaces WHERE id=$1 AND user_id=$2',
    [workspaceId, userId],
  );
  return own ? own.id : null;
}

/**
 * W0 backfill: ensure every one of the user's task_history rows has a workspace_id.
 * A task already associated to a workspace (task_workspaces) keeps that as its home;
 * the rest go to the user's default workspace. Idempotent + guarded — only runs (and
 * only touches NULL rows) when there is anything to backfill, so repeat bootstraps
 * are a cheap existence check, not a table scan.
 */
export async function backfillUserWorkspacePartition(userId: string, defaultWorkspaceId: string): Promise<void> {
  const hasNull = await queryOne<{ one: number }>(
    'SELECT 1 AS one FROM task_history WHERE user_id=$1 AND workspace_id IS NULL LIMIT 1',
    [userId],
  );
  if (!hasNull) return;
  await query(
    `UPDATE task_history th
        SET workspace_id = COALESCE(
          (SELECT tw.workspace_id FROM task_workspaces tw WHERE tw.task_id = th.id ORDER BY tw.added_at ASC LIMIT 1),
          $2)
      WHERE th.user_id = $1 AND th.workspace_id IS NULL`,
    [userId, defaultWorkspaceId],
  );
}

/**
 * W2 backfill: existing all-meetings chat (workspace_id NULL) → the default workspace,
 * so prior chat history shows up in the user's home vault. Idempotent + guarded.
 * (chat_history.workspace_id is TEXT; the workspace id is stored as text.)
 */
export async function backfillUserChatPartition(userId: string, defaultWorkspaceId: string): Promise<void> {
  const hasNull = await queryOne<{ one: number }>(
    'SELECT 1 AS one FROM chat_history WHERE user_id=$1 AND workspace_id IS NULL LIMIT 1',
    [userId],
  );
  if (!hasNull) return;
  await query(
    'UPDATE chat_history SET workspace_id=$2 WHERE user_id=$1 AND workspace_id IS NULL',
    [userId, defaultWorkspaceId],
  );
}

/**
 * ONE-TIME architectural correction: the user's NON-default workspaces are really
 * SPACES, not separate vaults. Convert each into a space (folder) inside the single
 * default workspace — carrying its name/icon and re-grouping its meetings into that
 * space — then remove the now-redundant workspace. Result: one workspace per account
 * (shown in the switcher) with the former "workspaces" as spaces in the sidebar.
 * Idempotent via the user_space_migration marker; meetings are preserved (already in
 * the default workspace after consolidation) and merely tagged into their space.
 */
export async function convertWorkspacesToSpacesOnce(userId: string, defaultWorkspaceId: string): Promise<void> {
  const done = await queryOne<{ one: number }>('SELECT 1 AS one FROM user_space_migration WHERE user_id=$1', [userId]);
  if (done) return;

  const others = await query<{ id: string; name: string; emoji: string | null; color: string | null }>(
    'SELECT id, name, emoji, color FROM workspaces WHERE user_id=$1 AND id<>$2 ORDER BY created_at ASC',
    [userId, defaultWorkspaceId],
  );

  for (const w of others) {
    // SAFETY: never demote a genuinely SHARED workspace (one with invited members) —
    // that's a real team vault, not a personal space. Only solo workspaces convert.
    const shared = await queryOne<{ one: number }>(
      'SELECT 1 AS one FROM workspace_members WHERE workspace_id=$1 LIMIT 1',
      [w.id],
    );
    if (shared) continue;

    // Find-or-create a space (folder) of the same name in the default workspace
    // (dedups e.g. two legacy "My notes" into a single space).
    let folder = await queryOne<{ id: string }>(
      'SELECT id FROM folders WHERE workspace_id=$1 AND user_id=$2 AND name=$3 ORDER BY created_at ASC LIMIT 1',
      [defaultWorkspaceId, userId, w.name],
    );
    if (!folder) {
      folder = await queryOne<{ id: string }>(
        'INSERT INTO folders (workspace_id, user_id, name, emoji, color) VALUES ($1,$2,$3,$4,$5) RETURNING id',
        [defaultWorkspaceId, userId, w.name, w.emoji, w.color],
      );
    }
    const folderId = folder!.id;
    // Re-group this workspace's meetings into the new space.
    await query(
      `INSERT INTO task_folders (task_id, folder_id)
         SELECT tw.task_id, $2 FROM task_workspaces tw WHERE tw.workspace_id=$1
       ON CONFLICT DO NOTHING`,
      [w.id, folderId],
    );
    // Keep any sub-folders the old workspace had — reparent them into the default vault.
    await query('UPDATE folders SET workspace_id=$2 WHERE workspace_id=$1', [w.id, defaultWorkspaceId]);
    // Remove the redundant workspace (cascades its task_workspaces + members).
    await query('DELETE FROM workspaces WHERE id=$1', [w.id]);
    console.log('workspace_converted_to_space', JSON.stringify({ user: userId, workspace: w.id, name: w.name, folder: folderId }));
  }

  await query('INSERT INTO user_space_migration (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

/** Ensure a default workspace exists for the user AND backfill their data. Returns the default id. */
export async function ensureWorkspacePartition(userId: string, email: string | null): Promise<string> {
  const defaultId = await resolveDefaultWorkspaceId(userId, email); // exactly one default
  await consolidateToDefaultOnce(userId, defaultId);                // one-time: all data → default vault
  await convertWorkspacesToSpacesOnce(userId, defaultId);           // one-time: other workspaces → spaces
  await backfillUserWorkspacePartition(userId, defaultId);          // ongoing safety for NULLs
  await backfillUserChatPartition(userId, defaultId);
  return defaultId;
}

/** Case-insensitive header lookup (API Gateway may preserve or lowercase header keys). */
function headerValue(event: { headers?: Record<string, string | undefined> | null }, name: string): string | undefined {
  const h = event.headers || {};
  const lname = name.toLowerCase();
  for (const k of Object.keys(h)) if (k.toLowerCase() === lname) return h[k] ?? undefined;
  return undefined;
}

/**
 * The active workspace for THIS request (W1 read scope). Reads the `X-Workspace-Id`
 * header the client sends, validates it belongs to the user (vault boundary), and
 * falls back to the user's default workspace when absent/invalid — so a request is
 * always scoped to exactly one owned workspace, never unscoped.
 */
export async function activeWorkspaceId(
  event: { headers?: Record<string, string | undefined> | null },
  userId: string,
  email: string | null,
): Promise<string> {
  const owned = await validateOwnedWorkspaceId(userId, headerValue(event, 'x-workspace-id'));
  return owned || resolveDefaultWorkspaceId(userId, email);
}
