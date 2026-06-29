import { query } from '../db';

/**
 * Brain events — the "who did what, when" timeline. Every state mutation the brain
 * OBSERVES in a backend (a Jira status transition, a new GitHub commit, a PR merge) is
 * recorded here as an immutable event with an actor + timestamp. This is what powers the
 * leader-facing Pulse feed ("who's doing what") and lets the brain mirror, not just snapshot.
 *
 *   kind: 'status_change' | 'commit' | 'pr' | 'created'
 */

export type BrainEventKind = 'status_change' | 'commit' | 'pr' | 'created';

let ready: Promise<void> | null = null;
export function ensureBrainEventSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS brain_event (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          item_id BIGINT,                 -- knowledge_item.id (nullable for safety)
          source TEXT NOT NULL,           -- jira | github
          source_id TEXT,                 -- 'SCRUM-6', 'owner/repo@sha'
          kind TEXT NOT NULL,
          actor TEXT,                     -- who did it (assignee / commit author)
          from_state TEXT,                -- prior status (status_change)
          to_state TEXT,                  -- new status
          title TEXT,                     -- the item title / commit subject
          occurred_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, workspace_id, source_id, kind, to_state, occurred_at)
        )
      `);
      // Space-scoped activity: which SPACE this event belongs to (its item's space).
      await query(`ALTER TABLE brain_event ADD COLUMN IF NOT EXISTS space_id UUID`);
      await query(`CREATE INDEX IF NOT EXISTS brain_event_ws_idx ON brain_event (user_id, workspace_id, occurred_at DESC)`);
      await query(`CREATE INDEX IF NOT EXISTS brain_event_space_idx ON brain_event (user_id, workspace_id, space_id, occurred_at DESC)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export interface BrainEventInput {
  userId: string; workspaceId: string; spaceId?: string | null; itemId?: string | null; source: string; sourceId?: string | null;
  kind: BrainEventKind; actor?: string | null; fromState?: string | null; toState?: string | null;
  title?: string | null; occurredAt?: string | null;
}

/** Record an observed state mutation. Idempotent (re-syncing the same change is a no-op). */
export async function insertEvent(e: BrainEventInput): Promise<void> {
  await ensureBrainEventSchema();
  await query(
    `INSERT INTO brain_event (user_id, workspace_id, space_id, item_id, source, source_id, kind, actor, from_state, to_state, title, occurred_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, workspace_id, source_id, kind, to_state, occurred_at) DO UPDATE SET
       space_id = COALESCE(EXCLUDED.space_id, brain_event.space_id)`,
    [e.userId, e.workspaceId, e.spaceId ?? null, e.itemId ?? null, e.source, e.sourceId ?? null, e.kind, e.actor ?? null, e.fromState ?? null, e.toState ?? null, e.title ?? null, e.occurredAt ?? null],
  ).catch((err) => { console.error('brain_event_insert_failed', JSON.stringify({ message: err?.message })); });
}

export interface BrainEventRow {
  kind: string; source: string; source_id: string | null; actor: string | null;
  from_state: string | null; to_state: string | null; title: string | null; occurred_at: string | null;
}

/** Recent events for the Pulse feed (most recent first). STRICTLY scoped to (workspace +
 *  space): an event carries its own space_id (set from its item's space on write/backfill),
 *  so a space's Activity shows ONLY that space's connector + meeting activity. `folderId`
 *  further narrows to one project via the item's folder. */
export async function getEvents(userId: string, workspaceId: string, limit = 40, folderId?: string | null, spaceId?: string | null): Promise<BrainEventRow[]> {
  await ensureBrainEventSchema();
  // SCOPE BY THE STABLE space_id. A space's events are pinned to its (globally-unique) space_id,
  // but the workspace_id has historically DRIFTED (connector re-connected under a new master id) —
  // so filtering by workspace_id silently dropped events. When a real space is given, scope by
  // space_id alone (user-filtered, so still tenant-safe); at the workspace root (no space, or
  // space==workspace) scope by workspace_id. DEDUP collapses the same transition that was ingested
  // under multiple spaces/workspace_ids so each change shows ONCE.
  const bySpace = !!spaceId && spaceId !== workspaceId;
  const scopeClause = bySpace ? 'e.space_id=$2' : 'e.workspace_id=$2';
  const scopeVal = bySpace ? spaceId : workspaceId;
  return query<BrainEventRow>(
    `SELECT d.kind, d.source, d.source_id, d.actor, d.from_state, d.to_state, d.title, d.occurred_at FROM (
       SELECT DISTINCT ON (e.source, e.source_id, e.kind, e.to_state, e.occurred_at)
              e.kind, e.source, e.source_id, e.actor, e.from_state, e.to_state, e.title, e.occurred_at, e.created_at
         FROM brain_event e
         LEFT JOIN knowledge_item ki ON ki.id = e.item_id
        WHERE e.user_id=$1 AND ${scopeClause}
          AND ($3::uuid IS NULL OR ki.folder_id=$3)
        ORDER BY e.source, e.source_id, e.kind, e.to_state, e.occurred_at, e.created_at DESC
     ) d
     ORDER BY d.occurred_at DESC NULLS LAST, d.created_at DESC LIMIT ${limit}`,
    [userId, scopeVal, folderId ?? null],
  ).catch(() => []);
}
