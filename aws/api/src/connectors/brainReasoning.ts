import { query, queryOne } from '../db';

/**
 * Reasoning layer (Living-Brain). A reasoning record sits BETWEEN a meeting and the work
 * item (commit / PR / issue) it relates to, carrying a VERDICT on whether what shipped
 * matches what was discussed/decided — so a CEO can see at a glance "this push doesn't
 * match what we agreed". Rendered as a colour-coded node in the brain map.
 *
 *   verdict: aligned ✓ | partial ◐ | divergent ⚠ | unrelated ✕
 */

export type Verdict = 'aligned' | 'partial' | 'divergent' | 'unrelated';

let ready: Promise<void> | null = null;
export function ensureReasoningSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS brain_reasoning (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          meeting_id BIGINT NOT NULL,       -- knowledge_item id (source='meeting')
          impl_id BIGINT NOT NULL,          -- knowledge_item id (jira/github)
          verdict TEXT NOT NULL,
          rationale TEXT,
          tags TEXT[],
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, workspace_id, meeting_id, impl_id)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS brain_reasoning_ws_idx ON brain_reasoning (user_id, workspace_id)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export async function insertReasoning(args: {
  userId: string; workspaceId: string; meetingId: string; implId: string;
  verdict: Verdict; rationale: string; tags?: string[];
}): Promise<void> {
  await ensureReasoningSchema();
  await query(
    `INSERT INTO brain_reasoning (user_id, workspace_id, meeting_id, impl_id, verdict, rationale, tags)
     VALUES ($1,$2,$3,$4,$5,$6,$7)
     ON CONFLICT (user_id, workspace_id, meeting_id, impl_id) DO UPDATE SET
       verdict=EXCLUDED.verdict, rationale=EXCLUDED.rationale, tags=EXCLUDED.tags, created_at=NOW()`,
    [args.userId, args.workspaceId, args.meetingId, args.implId, args.verdict, args.rationale, args.tags ?? null],
  );
}

export interface ReasoningRow { id: string; meeting_id: string; impl_id: string; verdict: Verdict; rationale: string | null; tags: string[] | null }

export async function getReasoning(userId: string, workspaceId: string, limit = 500): Promise<ReasoningRow[]> {
  await ensureReasoningSchema();
  return query<ReasoningRow>(
    `SELECT id, meeting_id, impl_id, verdict, rationale, tags FROM brain_reasoning
      WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT ${limit}`,
    [userId, workspaceId],
  );
}
