import { query, queryOne } from '../../db';
import type { JiraActionProposal, JiraOp } from './actions';

/**
 * Audit ledger for executed Jira writes (L6). Every successful write is recorded with
 * the proposal, the result, and a best-effort `rollback` proposal (the inverse action),
 * so an action is attributable and — where the MCP allows — reversible. Jira has no
 * delete, so a created issue's rollback is a close transition; comments aren't reversible.
 */

let ready: Promise<void> | null = null;

export function ensureAuditSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS action_audit (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          source TEXT NOT NULL DEFAULT 'jira',
          operation TEXT NOT NULL,
          issue_key TEXT,
          summary TEXT,
          proposal JSONB NOT NULL,
          result JSONB,
          rollback JSONB,                          -- inverse JiraActionProposal, or null
          status TEXT NOT NULL DEFAULT 'executed', -- executed | rolled_back
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          rolled_back_at TIMESTAMPTZ
        )
      `);
      await query(`CREATE INDEX IF NOT EXISTS action_audit_ws_idx ON action_audit (user_id, workspace_id, created_at DESC)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export interface AuditRow {
  id: string;
  workspace_id: string;
  operation: JiraOp;
  issue_key: string | null;
  summary: string | null;
  proposal: JiraActionProposal;
  result: unknown;
  rollback: JiraActionProposal | null;
  status: string;
  created_at: string;
}

export async function recordAudit(args: {
  userId: string; workspaceId: string; operation: JiraOp; issueKey?: string | null;
  summary?: string | null; proposal: JiraActionProposal; result: unknown; rollback: JiraActionProposal | null;
}): Promise<string | null> {
  await ensureAuditSchema();
  const r = await queryOne<{ id: string }>(
    `INSERT INTO action_audit (user_id, workspace_id, operation, issue_key, summary, proposal, result, rollback)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id`,
    [args.userId, args.workspaceId, args.operation, args.issueKey ?? null, args.summary ?? null,
     JSON.stringify(args.proposal), JSON.stringify(args.result ?? null),
     args.rollback ? JSON.stringify(args.rollback) : null],
  );
  return r?.id ?? null;
}

export async function listAudit(userId: string, workspaceId: string, limit = 50): Promise<AuditRow[]> {
  await ensureAuditSchema();
  return query<AuditRow>(
    `SELECT id, workspace_id, operation, issue_key, summary, proposal, result, rollback, status, created_at
       FROM action_audit WHERE user_id=$1 AND workspace_id=$2
      ORDER BY created_at DESC LIMIT ${limit}`,
    [userId, workspaceId],
  );
}

export async function getAudit(userId: string, id: string): Promise<(AuditRow & { workspace_id: string }) | null> {
  await ensureAuditSchema();
  return queryOne<AuditRow & { workspace_id: string }>(
    `SELECT id, workspace_id, operation, issue_key, summary, proposal, result, rollback, status, created_at
       FROM action_audit WHERE user_id=$1 AND id=$2`,
    [userId, id],
  );
}

export async function markRolledBack(userId: string, id: string, result: unknown): Promise<void> {
  await ensureAuditSchema();
  await query(
    `UPDATE action_audit SET status='rolled_back', rolled_back_at=NOW(), result=$3 WHERE user_id=$1 AND id=$2`,
    [userId, id, JSON.stringify(result ?? null)],
  );
}
