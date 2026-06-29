import { query, queryOne } from '../db';
import { ACCOUNT_SCOPE } from './schema';
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
      // Space-scoped suggestions: which SPACE this proposal belongs to (its source meeting's
      // space). Re-key the dedup UNIQUE to include space so the same action item can be a
      // pending suggestion in two spaces, and listing is strictly (workspace + space)-scoped.
      await query(`ALTER TABLE action_proposal ADD COLUMN IF NOT EXISTS space_id UUID`);
      await query(`UPDATE action_proposal SET space_id='${ACCOUNT_SCOPE}'::uuid WHERE space_id IS NULL`);
      await query(`ALTER TABLE action_proposal ALTER COLUMN space_id SET DEFAULT '${ACCOUNT_SCOPE}'`);
      await query(`ALTER TABLE action_proposal ALTER COLUMN space_id SET NOT NULL`);
      await query(`
        DO $$
        DECLARE c text;
        BEGIN
          FOR c IN
            SELECT conname FROM pg_constraint
             WHERE conrelid = 'action_proposal'::regclass AND contype = 'u'
               AND array_length(conkey, 1) <> 4
          LOOP
            EXECUTE 'ALTER TABLE action_proposal DROP CONSTRAINT ' || quote_ident(c);
          END LOOP;
          IF NOT EXISTS (
            SELECT 1 FROM pg_constraint
             WHERE conrelid = 'action_proposal'::regclass AND contype = 'u'
               AND array_length(conkey, 1) = 4
          ) THEN
            ALTER TABLE action_proposal
              ADD CONSTRAINT action_proposal_ws_space_uk UNIQUE (user_id, workspace_id, space_id, dedup_key);
          END IF;
        END $$;
      `);
      await query(`CREATE INDEX IF NOT EXISTS action_proposal_ws_status_idx ON action_proposal (user_id, workspace_id, status)`);
      await query(`CREATE INDEX IF NOT EXISTS action_proposal_space_status_idx ON action_proposal (user_id, workspace_id, space_id, status)`);
      // P4 — verify/rank: confidence (critic), score (impact×confidence×urgency for ordering), expiry.
      await query(`ALTER TABLE action_proposal ADD COLUMN IF NOT EXISTS confidence REAL`);
      await query(`ALTER TABLE action_proposal ADD COLUMN IF NOT EXISTS score REAL`);
      await query(`ALTER TABLE action_proposal ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export interface ProposalRow {
  id: string;
  workspace_id: string;
  space_id: string;
  kind: string;
  origin: string;
  source_meeting_id: string | null;
  source_title: string | null;
  rationale: string | null;
  proposal: JiraActionProposal;
  status: string;
  created_at: string;
  confidence: number | null;   // critic's confidence (P4)
  score: number | null;        // ranking score = impact×confidence×urgency (P4)
}

/** Insert a pending proposal; idempotent on (user, workspace, space, dedup_key). Returns true if newly inserted.
 *  `spaceId` is the source meeting's space — suggestions are strictly (workspace + space)-scoped. */
export async function insertProposal(args: {
  userId: string; workspaceId: string; spaceId?: string | null; dedupKey: string; proposal: unknown;
  kind?: string;   // target connector ('jira' default | 'github' | 'slack' | … | a custom-connector id)
  sourceMeetingId?: string | null; sourceTitle?: string | null; rationale?: string | null; origin?: string;
  confidence?: number | null; score?: number | null; expiresInDays?: number | null;   // P4 verify/rank
}): Promise<boolean> {
  await ensureProposalSchema();
  const expiresAt = args.expiresInDays ? new Date(Date.now() + args.expiresInDays * 86_400_000).toISOString() : null;
  const r = await queryOne<{ id: string }>(
    `INSERT INTO action_proposal (user_id, workspace_id, space_id, kind, origin, source_meeting_id, source_title, rationale, proposal, dedup_key, confidence, score, expires_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, workspace_id, space_id, dedup_key) DO NOTHING
     RETURNING id`,
    [args.userId, args.workspaceId, args.spaceId ?? ACCOUNT_SCOPE, args.kind ?? 'jira', args.origin ?? 'agent', args.sourceMeetingId ?? null, args.sourceTitle ?? null,
     args.rationale ?? null, JSON.stringify(args.proposal), args.dedupKey, args.confidence ?? null, args.score ?? null, expiresAt],
  );
  return !!r;
}

export async function listPendingProposals(userId: string, workspaceId: string, spaceId?: string | null): Promise<ProposalRow[]> {
  await ensureProposalSchema();
  return query<ProposalRow>(
    `SELECT id, workspace_id, space_id, kind, origin, source_meeting_id, source_title, rationale, proposal, status, created_at, confidence, score
       FROM action_proposal
      WHERE user_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR space_id=$3) AND status='pending'
        AND (expires_at IS NULL OR expires_at > NOW())
      ORDER BY score DESC NULLS LAST, created_at DESC LIMIT 100`,
    [userId, workspaceId, spaceId ?? null],
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
