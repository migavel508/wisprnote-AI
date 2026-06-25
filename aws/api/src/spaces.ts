import { query, queryOne } from './db';

/**
 * SPACES LAYER — the membership-scoped grouping inside a workspace.
 *
 *   Workspace (master vault)  →  Space (has members + folders)  →  Folder  →  note
 *
 * A space is shareable: a private space has no members ("Just you"); a shared space
 * has space_members (or is open to everyone in the workspace). Folders belong to a
 * space (folders.space_id); meetings carry space_id (+ optional folder_id) for fast,
 * partitioned reads. This replaces the earlier "space = top-level folder" hack.
 */

let _ready: Promise<void> | null = null;
export function ensureSpacesSchema(): Promise<void> {
  if (!_ready) {
    _ready = query(`CREATE TABLE IF NOT EXISTS spaces (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        workspace_id UUID NOT NULL,
        user_id      UUID NOT NULL,
        name         TEXT NOT NULL,
        emoji        TEXT,
        color        TEXT,
        is_default   BOOLEAN NOT NULL DEFAULT false,
        shared_all   BOOLEAN NOT NULL DEFAULT false,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      .then(() => query('CREATE INDEX IF NOT EXISTS idx_spaces_workspace ON spaces(workspace_id)'))
      .then(() => query(`CREATE TABLE IF NOT EXISTS space_members (
        space_id   UUID NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
        email      TEXT NOT NULL,
        role       TEXT NOT NULL DEFAULT 'viewer',
        invited_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        PRIMARY KEY (space_id, email)
      )`))
      // Folders now belong to a SPACE (not a workspace directly).
      .then(() => query('ALTER TABLE folders ADD COLUMN IF NOT EXISTS space_id UUID'))
      // Meetings carry their space + folder for partitioned reads.
      .then(() => query('ALTER TABLE task_history ADD COLUMN IF NOT EXISTS space_id UUID'))
      .then(() => query('ALTER TABLE task_history ADD COLUMN IF NOT EXISTS folder_id UUID'))
      // One-time per-user migration marker for "top-level folders → spaces".
      .then(() => query('CREATE TABLE IF NOT EXISTS user_spaces_migration (user_id UUID PRIMARY KEY, migrated_at TIMESTAMPTZ NOT NULL DEFAULT now())'))
      .then(() => undefined)
      .catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}

/**
 * ONE-TIME: turn the user's existing top-level "folders" (which the prior phase made
 * from their old workspaces) into real SPACES, carrying any child folders + meetings.
 * Also guarantees a default private "My notes" space. Idempotent via the marker.
 */
export async function migrateFoldersToSpacesOnce(userId: string, defaultWorkspaceId: string): Promise<void> {
  await ensureSpacesSchema();
  const done = await queryOne<{ one: number }>('SELECT 1 AS one FROM user_spaces_migration WHERE user_id=$1', [userId]);
  if (done) return;

  // Top-level folders (no parent) across the user's workspaces become spaces.
  const tops = await query<{ id: string; name: string; emoji: string | null; color: string | null; workspace_id: string }>(
    'SELECT id, name, emoji, color, workspace_id FROM folders WHERE user_id=$1 AND parent_id IS NULL',
    [userId],
  );
  for (const f of tops) {
    const space = await queryOne<{ id: string }>(
      'INSERT INTO spaces (workspace_id, user_id, name, emoji, color) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [f.workspace_id, userId, f.name, f.emoji, f.color],
    );
    const spaceId = space!.id;
    // child folders of this top-level folder → folders inside the new space
    await query('UPDATE folders SET space_id=$2, parent_id=NULL WHERE parent_id=$1', [f.id, spaceId]);
    // meetings filed under this top-level folder → the new space
    await query(
      `UPDATE task_history SET space_id=$2
        WHERE user_id=$3 AND id IN (SELECT task_id FROM task_folders WHERE folder_id=$1)`,
      [f.id, spaceId, userId],
    );
    // remove the old top-level folder (its task_folders cascade)
    await query('DELETE FROM folders WHERE id=$1', [f.id]);
  }

  // Every workspace gets a default "My notes" space, and every LOOSE note (one not
  // already filed into a space) moves into its workspace's default space — so no note
  // is ever left directly under a workspace.
  const workspaces = await query<{ id: string }>('SELECT id FROM workspaces WHERE user_id=$1', [userId]);
  const wsIds = workspaces.map(w => w.id);
  if (!wsIds.includes(defaultWorkspaceId)) wsIds.push(defaultWorkspaceId);
  for (const wsId of wsIds) {
    const spaceId = await resolveDefaultSpaceId(userId, wsId);
    await query(
      'UPDATE task_history SET space_id=$1 WHERE user_id=$2 AND workspace_id=$3 AND space_id IS NULL',
      [spaceId, userId, wsId],
    );
  }

  await query('INSERT INTO user_spaces_migration (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING', [userId]);
}

/** Member-count label for a space ("Just you" / "N members" / "Everyone in workspace"). */
export async function spaceMemberCount(spaceId: string): Promise<number> {
  const rows = await query<{ email: string }>('SELECT email FROM space_members WHERE space_id=$1', [spaceId]);
  return rows.length;
}

/**
 * The default ("My notes") space for a workspace — every note must live in a space,
 * never directly under a workspace. Promotes an existing "My notes" space, else
 * creates one. Each workspace gets its own default space on demand.
 */
export async function resolveDefaultSpaceId(userId: string, workspaceId: string): Promise<string> {
  await ensureSpacesSchema();
  const existing = await queryOne<{ id: string }>(
    'SELECT id FROM spaces WHERE workspace_id=$1 AND user_id=$2 AND is_default=true ORDER BY created_at ASC LIMIT 1',
    [workspaceId, userId],
  );
  if (existing) return existing.id;
  const myNotes = await queryOne<{ id: string }>(
    `SELECT id FROM spaces WHERE workspace_id=$1 AND user_id=$2 AND lower(name)='my notes' ORDER BY created_at ASC LIMIT 1`,
    [workspaceId, userId],
  );
  if (myNotes) {
    await query(`UPDATE spaces SET is_default=true, emoji=COALESCE(emoji,'🔒') WHERE id=$1`, [myNotes.id]);
    return myNotes.id;
  }
  const created = await queryOne<{ id: string }>(
    `INSERT INTO spaces (workspace_id, user_id, name, emoji, is_default) VALUES ($1,$2,'My notes','🔒',true) RETURNING id`,
    [workspaceId, userId],
  );
  return created!.id;
}

/**
 * Self-healing (runs every bootstrap, idempotent): guarantee each of the user's
 * workspaces has a default space, and that no note is left directly under a workspace.
 * Catches users whose one-time migration already ran before loose-note filing existed,
 * plus any note that later slipped through. Cheap: the UPDATE matches nothing once
 * every note is filed.
 */
export async function reconcileSpaces(userId: string, defaultWorkspaceId: string): Promise<void> {
  await ensureSpacesSchema();
  const workspaces = await query<{ id: string }>('SELECT id FROM workspaces WHERE user_id=$1', [userId]);
  const wsIds = workspaces.map(w => w.id);
  if (!wsIds.includes(defaultWorkspaceId)) wsIds.push(defaultWorkspaceId);
  for (const wsId of wsIds) {
    const spaceId = await resolveDefaultSpaceId(userId, wsId);
    await query(
      'UPDATE task_history SET space_id=$1 WHERE user_id=$2 AND workspace_id=$3 AND space_id IS NULL',
      [spaceId, userId, wsId],
    );
  }
}

/** Returns the candidate space id only if it belongs to this user AND workspace, else null. */
export async function validateOwnedSpaceId(userId: string, workspaceId: string, candidate?: string | null): Promise<string | null> {
  if (!candidate) return null;
  const s = await queryOne<{ id: string }>(
    'SELECT id FROM spaces WHERE id=$1 AND user_id=$2 AND workspace_id=$3',
    [candidate, userId, workspaceId],
  );
  return s ? candidate : null;
}
