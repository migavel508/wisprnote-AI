import { query, queryOne } from './db';
import { ACCOUNT_SCOPE } from './connectors/schema';

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

/**
 * Reclaim ORPHANED connector data into the canonical (default) workspace. The workspace→space
 * migration moved MEETINGS to the default workspace and DELETED the original workspaces, but never
 * moved connector data — so `knowledge_item` (jira/github), `brain_edge`, `brain_event`,
 * `action_proposal`, and `connector_credentials` were left under a now-deleted workspace_id (or the
 * ACCOUNT_SCOPE sentinel). The strict (workspace+space) reads then exclude them entirely, and
 * brainLink (which groups by workspace_id) can never link them to the meetings. This moves every row
 * whose workspace_id is NOT a current workspace of the user → the default workspace, so they sit
 * alongside the meetings; brainLink then forms the links and `backfillSpaceScoping` files them into
 * the right space. Idempotent + guarded against unique/PK clashes (a canonical copy already there
 * wins; the orphan is left in place). MUST run before backfillSpaceScoping.
 */
export async function reclaimOrphanConnectorData(userId: string, defaultWorkspaceId: string): Promise<void> {
  if (!defaultWorkspaceId) return;
  const orphan = `t.workspace_id NOT IN (SELECT id FROM workspaces WHERE user_id=$1)`;
  await query(
    `UPDATE knowledge_item t SET workspace_id=$2
      WHERE t.user_id=$1 AND ${orphan}
        AND NOT EXISTS (SELECT 1 FROM knowledge_item k2 WHERE k2.user_id=$1 AND k2.workspace_id=$2
          AND k2.space_id=t.space_id AND k2.source=t.source AND k2.source_id=t.source_id AND k2.type=t.type)`,
    [userId, defaultWorkspaceId],
  ).catch(() => {});
  await query(
    `UPDATE brain_edge t SET workspace_id=$2
      WHERE t.user_id=$1 AND ${orphan}
        AND NOT EXISTS (SELECT 1 FROM brain_edge e2 WHERE e2.user_id=$1 AND e2.workspace_id=$2
          AND e2.src_kind=t.src_kind AND e2.src_id=t.src_id AND e2.dst_kind=t.dst_kind AND e2.dst_id=t.dst_id AND e2.relation=t.relation)`,
    [userId, defaultWorkspaceId],
  ).catch(() => {});
  await query(
    `UPDATE brain_event t SET workspace_id=$2
      WHERE t.user_id=$1 AND ${orphan}
        AND NOT EXISTS (SELECT 1 FROM brain_event e2 WHERE e2.user_id=$1 AND e2.workspace_id=$2
          AND e2.source_id IS NOT DISTINCT FROM t.source_id AND e2.kind=t.kind
          AND e2.to_state IS NOT DISTINCT FROM t.to_state AND e2.occurred_at IS NOT DISTINCT FROM t.occurred_at)`,
    [userId, defaultWorkspaceId],
  ).catch(() => {});
  await query(
    `UPDATE action_proposal t SET workspace_id=$2
      WHERE t.user_id=$1 AND ${orphan}
        AND NOT EXISTS (SELECT 1 FROM action_proposal a2 WHERE a2.user_id=$1 AND a2.workspace_id=$2
          AND a2.space_id=t.space_id AND a2.dedup_key=t.dedup_key)`,
    [userId, defaultWorkspaceId],
  ).catch(() => {});
  await query(
    `UPDATE connector_credentials t SET workspace_id=$2
      WHERE t.user_id=$1 AND ${orphan}
        AND NOT EXISTS (SELECT 1 FROM connector_credentials c2 WHERE c2.user_id=$1 AND c2.workspace_id=$2
          AND c2.space_id=t.space_id AND c2.source=t.source)`,
    [userId, defaultWorkspaceId],
  ).catch(() => {});
}

/**
 * CORRECTIVE, idempotent "follow the linked meeting" backfill: assign a SPACE to legacy/mis-placed
 * connector data so the strictly (workspace+space)-scoped brain, suggestions and activity show it.
 * It RE-DERIVES from canonical sources (meetings from task_history; connector items/edges/events/
 * proposals from the meeting they link to) and OVERWRITES wrong values — not just NULL/sentinel —
 * so it repairs data the earlier fill-only pass stranded at the default space. A connector item is
 * only re-homed if it's at the sentinel OR the workspace's default space (never clobbers an item
 * already filed in a real per-space connection). Safe to re-run; runs at bootstrap AND on brain sync.
 */
export async function backfillSpaceScoping(userId: string): Promise<void> {
  const SENT = `'${ACCOUNT_SCOPE}'::uuid`;
  const defaultSpaceExpr = `(SELECT s.id FROM spaces s WHERE s.user_id=ki.user_id AND s.workspace_id=ki.workspace_id AND s.is_default=true LIMIT 1)`;
  // 0) Meetings → their CANONICAL space (task_history.space_id). Corrective + first, so every
  //    downstream "follow the meeting" step sees the right space.
  await query(
    `UPDATE knowledge_item ki SET space_id = th.space_id
       FROM task_history th
      WHERE ki.user_id=$1 AND ki.source='meeting' AND ki.type='meeting'
        AND ki.source_id = th.id::text AND th.space_id IS NOT NULL
        AND ki.space_id IS DISTINCT FROM th.space_id
        AND NOT EXISTS (SELECT 1 FROM knowledge_item k2 WHERE k2.user_id=ki.user_id
          AND k2.workspace_id=ki.workspace_id AND k2.space_id=th.space_id
          AND k2.source='meeting' AND k2.type='meeting' AND k2.source_id=ki.source_id AND k2.id<>ki.id)`,
    [userId],
  ).catch(() => {});
  // 1) REMOVED (P0, strict space isolation): we no longer re-home a connector item into the space of
  //    a meeting it links to. That "follow the linked meeting" move pulled Jira/GitHub items into
  //    spaces that never authorized the integration (the cross-space leak). A connector item's space
  //    is owned SOLELY by the credential that synced it (sync.ts sets it from connector_credentials).
  // 2) REMOVED (P0, strict space isolation): we no longer auto-file still-sentinel connector items
  //    into the workspace's DEFAULT space. That silently put Jira/GitHub data into a space the user
  //    never connected the integration in (a re-leak vector). A connector item is filed into a real
  //    space ONLY by its authorizing credential (sync.ts); legacy sentinel items stay invisible until
  //    re-synced under a real connection, never auto-homed.
  // 3) Edges → the space of their MEETING endpoint (corrective), else src, else dst item.
  await query(
    `UPDATE brain_edge e SET space_id = m.space_id
       FROM knowledge_item m
      WHERE e.user_id=$1 AND m.user_id=$1 AND m.source='meeting'
        AND m.id::text IN (e.src_id, e.dst_id) AND m.space_id <> ${SENT}
        AND e.space_id IS DISTINCT FROM m.space_id`,
    [userId],
  ).catch(() => {});
  await query(
    `UPDATE brain_edge e SET space_id = si.space_id
       FROM knowledge_item si
      WHERE e.user_id=$1 AND e.space_id IS NULL AND si.id::text=e.src_id AND si.space_id <> ${SENT}`,
    [userId],
  ).catch(() => {});
  await query(
    `UPDATE brain_edge e SET space_id = di.space_id
       FROM knowledge_item di
      WHERE e.user_id=$1 AND e.space_id IS NULL AND di.id::text=e.dst_id AND di.space_id <> ${SENT}`,
    [userId],
  ).catch(() => {});
  // 4) Events → space of their item (corrective).
  await query(
    `UPDATE brain_event ev SET space_id = ki.space_id
       FROM knowledge_item ki
      WHERE ev.user_id=$1 AND ki.id=ev.item_id AND ki.space_id <> ${SENT}
        AND ev.space_id IS DISTINCT FROM ki.space_id`,
    [userId],
  ).catch(() => {});
  // 5) Suggestions → source meeting's space (corrective), then default for any still at sentinel.
  await query(
    `UPDATE action_proposal ap SET space_id = th.space_id
       FROM task_history th
      WHERE ap.user_id=$1 AND ap.source_meeting_id = th.id::text AND th.space_id IS NOT NULL
        AND ap.space_id IS DISTINCT FROM th.space_id
        AND NOT EXISTS (SELECT 1 FROM action_proposal a2 WHERE a2.user_id=ap.user_id
          AND a2.workspace_id=ap.workspace_id AND a2.space_id=th.space_id AND a2.dedup_key=ap.dedup_key AND a2.id<>ap.id)`,
    [userId],
  ).catch(() => {});
  await query(
    `UPDATE action_proposal ap SET space_id = (SELECT s.id FROM spaces s WHERE s.user_id=ap.user_id AND s.workspace_id=ap.workspace_id AND s.is_default=true LIMIT 1)
      WHERE ap.user_id=$1 AND ap.space_id=${SENT}
        AND NOT EXISTS (SELECT 1 FROM action_proposal a2 WHERE a2.user_id=ap.user_id
          AND a2.workspace_id=ap.workspace_id
          AND a2.space_id=(SELECT s.id FROM spaces s WHERE s.user_id=ap.user_id AND s.workspace_id=ap.workspace_id AND s.is_default=true LIMIT 1)
          AND a2.dedup_key=ap.dedup_key AND a2.id<>ap.id)`,
    [userId],
  ).catch(() => {});
  // 6) Move a legacy sentinel-space connection to the space its items predominantly belong to,
  //    so ongoing sync lands in the right space (the user may also re-connect inside a space).
  await query(
    `UPDATE connector_credentials cc SET space_id = sub.space_id
       FROM (
         SELECT workspace_id, source, space_id,
                ROW_NUMBER() OVER (PARTITION BY workspace_id, source ORDER BY COUNT(*) DESC) rn
           FROM knowledge_item WHERE user_id=$1 AND space_id <> ${SENT}
          GROUP BY workspace_id, source, space_id
       ) sub
      WHERE cc.user_id=$1 AND cc.space_id=${SENT}
        AND cc.workspace_id=sub.workspace_id AND cc.source=sub.source AND sub.rn=1
        AND NOT EXISTS (SELECT 1 FROM connector_credentials c2 WHERE c2.user_id=cc.user_id
          AND c2.workspace_id=cc.workspace_id AND c2.space_id=sub.space_id AND c2.source=cc.source)`,
    [userId],
  ).catch(() => {});
}
