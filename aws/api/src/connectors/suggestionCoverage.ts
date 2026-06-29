import { query, queryOne } from '../db';
import { ACCOUNT_SCOPE } from './schema';

/**
 * SUGGESTION COVERAGE (Suggested Actions Engine — Phase 1).
 *
 * The autonomous sweep used to scan only the last 30 days / 20 most-recent meetings, so older
 * meetings were never reconsidered and the user had no idea what was covered. This replaces that
 * recency window with a CURSOR BACKFILL: a per-meeting "reasoned" marker. Each sweep tick processes
 * a bounded batch of NOT-YET-reasoned meetings (newest first) and marks them — so over successive
 * ticks the WHOLE corpus is covered (new meetings included), with no silent recency cap. Coverage
 * ("reasoned over N of N") is surfaced in the UI so gaps are visible, not hidden.
 */

let schemaP: Promise<void> | null = null;
export function ensureCoverageSchema(): Promise<void> {
  if (!schemaP) schemaP = query(`
    CREATE TABLE IF NOT EXISTS suggestion_reasoned (
      user_id      UUID NOT NULL,
      workspace_id TEXT NOT NULL,
      meeting_id   TEXT NOT NULL,
      reasoned_at  TIMESTAMPTZ DEFAULT NOW(),
      PRIMARY KEY (user_id, workspace_id, meeting_id)
    )`).then(() => {}).catch((e) => { schemaP = null; throw e; });
  return schemaP;
}

/** Mark a batch of meetings as reasoned-over for this (user, workspace). Idempotent. */
export async function markReasoned(userId: string, workspaceId: string, meetingIds: string[]): Promise<void> {
  if (!meetingIds.length) return;
  await ensureCoverageSchema();
  const values = meetingIds.map((_, i) => `($1,$2,$${i + 3})`).join(',');
  await query(
    `INSERT INTO suggestion_reasoned (user_id, workspace_id, meeting_id) VALUES ${values}
     ON CONFLICT (user_id, workspace_id, meeting_id) DO NOTHING`,
    [userId, workspaceId, ...meetingIds],
  ).catch(() => {});
}

/**
 * Coverage for the UI: how many of this scope's meetings have been reasoned over. Counts via the
 * CANONICAL membership the UI uses — `task_history.space_id` for a space, falling back to
 * `workspace_id` for an account/workspace-level view — NOT the sparse legacy task_workspaces tables.
 */
export async function getSuggestionCoverage(userId: string, workspaceId: string, spaceId?: string | null): Promise<{ reasoned: number; total: number }> {
  await ensureCoverageSchema();
  const bySpace = !!spaceId && spaceId !== ACCOUNT_SCOPE;
  const col = bySpace ? 'space_id' : 'workspace_id';   // controlled set — safe to interpolate
  const scopeId = bySpace ? spaceId : workspaceId;
  const row = await queryOne<{ total: number; reasoned: number }>(
    `SELECT
       (SELECT COUNT(*)::int FROM task_history th WHERE th.user_id=$1 AND th.${col}=$2) AS total,
       (SELECT COUNT(*)::int FROM task_history th
          JOIN suggestion_reasoned sr ON sr.meeting_id = th.id::text AND sr.user_id = th.user_id
         WHERE th.user_id=$3 AND th.${col}=$4) AS reasoned`,
    [userId, scopeId, userId, scopeId],
  ).catch(() => null);
  return { reasoned: row?.reasoned ?? 0, total: row?.total ?? 0 };
}
