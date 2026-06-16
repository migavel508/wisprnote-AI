import { query, queryOne } from '../db';
import type { JiraActionProposal } from './jira/actions';

/**
 * Action-proposal ledger (HITL). The autonomous agent NEVER writes to Jira — it writes
 * PROPOSALS here, which a human reviews and approves in the UI. This is the "patience
 * before action" guarantee in storage form: surfacing a suggestion is reversible (the
 * user dismisses it); only an explicit approval triggers the real write.
 *
 * Workspace-scoped. `dedup_key` makes the sweep idempotent — the same meeting action
 * item never produces two pending proposals.
 */

let ready: Promise<void> | null = null;

export function ensureProposalSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS action_proposal (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          kind TEXT NOT NULL DEFAULT 'jira',     -- target connector
          origin TEXT NOT NULL DEFAULT 'agent',  -- 'agent' | 'chat'
          source_meeting_id UUID,                -- provenance: the meeting it came from
          source_title TEXT,
          rationale TEXT,                        -- why the agent proposed this
          proposal JSONB NOT NULL,               -- the editable JiraActionProposal
          status TEXT NOT NULL DEFAULT 'pending',-- pending | executed | dismissed
          dedup_key TEXT NOT NULL,
          result JSONB,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          decided_at TIMESTAMPTZ,
          UNIQUE (user_id, workspace_id, dedup_key)
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS action_proposal_ws_status_idx ON action_proposal (user_id, workspace_id, status)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export interface ProposalRow {
  id: string;
  workspace_id: string;
  kind: string;
  origin: string;
  source_meeting_id: string | null;
  source_title: string | null;
  rationale: string | null;
  proposal: JiraActionProposal;
  status: string;
  created_at: string;
}

/** Insert a pending proposal; idempotent on (user, workspace, dedup_key). Returns true if newly inserted. */
export async function insertProposal(args: {
  userId: string; workspaceId: string; dedupKey: string; proposal: JiraActionProposal;
  sourceMeetingId?: string | null; sourceTitle?: string | null; rationale?: string | null; origin?: string;
}): Promise<boolean> {
  await ensureProposalSchema();
  const r = await queryOne<{ id: string }>(
    `INSERT INTO action_proposal (user_id, workspace_id, origin, source_meeting_id, source_title, rationale, proposal, dedup_key)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
     ON CONFLICT (user_id, workspace_id, dedup_key) DO NOTHING
     RETURNING id`,
    [args.userId, args.workspaceId, args.origin ?? 'agent', args.sourceMeetingId ?? null, args.sourceTitle ?? null,
     args.rationale ?? null, JSON.stringify(args.proposal), args.dedupKey],
  );
  return !!r;
}

export async function listPendingProposals(userId: string, workspaceId: string): Promise<ProposalRow[]> {
  await ensureProposalSchema();
  return query<ProposalRow>(
    `SELECT id, workspace_id, kind, origin, source_meeting_id, source_title, rationale, proposal, status, created_at
       FROM action_proposal
      WHERE user_id=$1 AND workspace_id=$2 AND status='pending'
      ORDER BY created_at DESC LIMIT 100`,
    [userId, workspaceId],
  );
}

export async function countPendingProposals(userId: string, workspaceId: string): Promise<number> {
  await ensureProposalSchema();
  const r = await queryOne<{ n: string }>(
    `SELECT COUNT(*)::int AS n FROM action_proposal WHERE user_id=$1 AND workspace_id=$2 AND status='pending'`,
    [userId, workspaceId],
  );
  return r ? Number(r.n) : 0;
}

export async function resolveProposal(userId: string, id: string, status: 'executed' | 'dismissed', result?: unknown): Promise<void> {
  await ensureProposalSchema();
  await query(
    `UPDATE action_proposal SET status=$3, result=$4, decided_at=NOW() WHERE id=$1 AND user_id=$2 AND status='pending'`,
    [id, userId, status, result != null ? JSON.stringify(result) : null],
  );
}
