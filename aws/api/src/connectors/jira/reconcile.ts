import { query } from '../../db';
import { ensureConnectorSchema } from '../schema';
import { ensureProposalSchema, insertProposal } from '../proposals';
import type { JiraActionProposal } from './actions';

/**
 * RECONCILIATION SWEEP — the orchestration plane's first closed loop:
 * **decision → ticket → code → commit**. It does the one thing no single tool can:
 * reason across the brain's cross-tool lineage (`brain_edge` + verdicts) and emit
 * **proposed Jira actions for the gaps** — then hands them to the EXISTING HITL rails
 * (`action_proposal` → approval cards → `executeJiraAction` → audit). Propose-only;
 * never writes to Jira. DB-only to propose (no live Jira call needed here).
 *
 * Two situations, both inherently cross-tool:
 *   A. TRANSITION GAP — aligned/partial code landed for a ticket that's still open →
 *      propose moving the ticket forward.
 *   B. DIVERGENCE FLAG — work linked to a ticket was judged `divergent` →
 *      propose a heads-up comment on the ticket.
 */

const WORKSPACE_CAP = 25;
const PER_DETECTOR_CAP = 8;     // bound proposals/workspace/sweep — no floods
const STALE_DAYS = 7;           // an open, meeting-linked ticket idle this long → nudge
const DONEISH = 'done|closed|resolved|complete|shipped|merged|cancel';
const REVIEWISH = /review|qa|verify|staging|testing/i;

export interface ReconcileResult { workspaces: number; proposed: number }

export async function runReconcileSweep(): Promise<ReconcileResult> {
  await ensureConnectorSchema();
  await ensureProposalSchema();
  const result: ReconcileResult = { workspaces: 0, proposed: 0 };

  // Every (workspace, SPACE) with a connected Jira credential. STRICT per-space: a space only gets
  // reconciliation for connectors it authorized — detectors below filter by ji.space_id=$3.
  const creds = await query<{ user_id: string; workspace_id: string; space_id: string }>(
    `SELECT DISTINCT user_id, workspace_id, space_id FROM connector_credentials WHERE source='jira' LIMIT ${WORKSPACE_CAP}`,
  ).catch(() => []);

  for (const c of creds) {
    result.workspaces++;

    // ── Detector A — transition gap ────────────────────────────────────────────────
    // A Jira ticket that is NOT done, but has aligned/partial code (a GitHub commit/PR)
    // linked to it → the work shipped, the ticket didn't move. Propose moving it forward.
    const gaps = await query<any>(
      `SELECT ji.source_id AS issue_key, ji.title AS issue_title, ji.status AS status, ji.space_id AS space_id,
              impl.title AS impl_title, e.verdict AS verdict
         FROM knowledge_item ji
         JOIN brain_edge e ON e.user_id=ji.user_id AND e.workspace_id=ji.workspace_id
           AND (e.src_id = ji.id::text OR e.dst_id = ji.id::text)
         JOIN knowledge_item impl ON impl.id::text = (CASE WHEN e.src_id=ji.id::text THEN e.dst_id ELSE e.src_id END)
        WHERE ji.user_id=$1 AND ji.workspace_id=$2 AND ji.space_id=$3 AND ji.source='jira'
          AND ji.status IS NOT NULL AND ji.status !~* '${DONEISH}'
          AND impl.source='github' AND e.verdict IN ('aligned','partial')
        ORDER BY (e.verdict='aligned') DESC, ji.synced_at DESC
        LIMIT 60`,
      [c.user_id, c.workspace_id, c.space_id],
    ).catch(() => []);

    let madeA = 0;
    const seenA = new Set<string>();
    for (const g of gaps) {
      if (madeA >= PER_DETECTOR_CAP) break;
      if (!g.issue_key || seenA.has(g.issue_key)) continue;   // one transition proposal per ticket
      const status = String(g.status || '');
      const aligned = g.verdict === 'aligned';
      // Conservative forward step: a reviewed-stage ticket with ALIGNED code → "Done";
      // an earlier-stage ticket with landed code → "In Review". (The human edits/approves.)
      const target = REVIEWISH.test(status) ? (aligned ? 'Done' : null) : 'In Review';
      if (!target) continue;
      const proposal: JiraActionProposal = { operation: 'transition', issueKey: g.issue_key, status: target };
      const ok = await insertProposal({
        userId: c.user_id, workspaceId: c.workspace_id, spaceId: c.space_id, origin: 'reconcile',
        dedupKey: `reconcile:transition:${g.issue_key}:${target}`,
        sourceTitle: g.issue_title,
        rationale: `Code implementing this ticket has landed (${g.verdict}): “${String(g.impl_title || '').slice(0, 90)}”, but the ticket is still “${status}”. Move it to ${target}?`,
        proposal,
      });
      if (ok) { seenA.add(g.issue_key); madeA++; result.proposed++; }
    }

    // ── Detector B — divergence flag ───────────────────────────────────────────────
    // Work (commit / dev session) linked to a ticket was judged `divergent` from its
    // intent → propose a heads-up comment on the ticket so a human can course-correct.
    const divs = await query<any>(
      `SELECT ji.source_id AS issue_key, ji.title AS issue_title, ji.space_id AS space_id,
              impl.source_id AS impl_id, impl.title AS impl_title, e.rationale AS rationale
         FROM brain_edge e
         JOIN knowledge_item ji ON ji.id::text IN (e.src_id, e.dst_id) AND ji.source='jira'
           AND ji.user_id=e.user_id AND ji.workspace_id=e.workspace_id
         JOIN knowledge_item impl ON impl.id::text = (CASE WHEN e.src_id=ji.id::text THEN e.dst_id ELSE e.src_id END)
        WHERE e.user_id=$1 AND e.workspace_id=$2 AND e.space_id=$3 AND e.verdict='divergent'
          AND impl.source IN ('github','claude-code','codex')
        ORDER BY e.created_at DESC LIMIT 60`,
      [c.user_id, c.workspace_id, c.space_id],
    ).catch(() => []);

    let madeB = 0;
    const seenB = new Set<string>();
    for (const d of divs) {
      if (madeB >= PER_DETECTOR_CAP) break;
      const dk = `${d.issue_key}:${d.impl_id}`;
      if (!d.issue_key || seenB.has(dk)) continue;
      const note = `⚠️ Wisprnote flagged a possible divergence: the linked work “${String(d.impl_title || '').slice(0, 100)}” appears to differ from this ticket's intent.${d.rationale ? ` ${String(d.rationale).slice(0, 320)}` : ''}`;
      const proposal: JiraActionProposal = { operation: 'comment', issueKey: d.issue_key, comment: note };
      const ok = await insertProposal({
        userId: c.user_id, workspaceId: c.workspace_id, spaceId: c.space_id, origin: 'reconcile',
        dedupKey: `reconcile:flag:${dk}`,
        sourceTitle: d.issue_title,
        rationale: 'The linked work was judged to diverge from this ticket — post a heads-up comment?',
        proposal,
      });
      if (ok) { seenB.add(dk); madeB++; result.proposed++; }
    }

    // ── Detector C — stale decided-work nudge ──────────────────────────────────────
    // An open Jira ticket that traces to a MEETING decision but hasn't moved in STALE_DAYS →
    // propose a nudge comment that references the meeting. (Jira can flag "old ticket"; only
    // the brain can say "the thing you DECIDED in <meeting> is stalling.")
    const stale = await query<any>(
      `SELECT ji.source_id AS issue_key, ji.title AS issue_title, ji.status AS status, ji.space_id AS space_id,
              (NOW()::date - ji.occurred_at::date) AS days_stale, mt.title AS meeting_title
         FROM knowledge_item ji
         JOIN brain_edge e ON e.user_id=ji.user_id AND e.workspace_id=ji.workspace_id
           AND (e.src_id=ji.id::text OR e.dst_id=ji.id::text)
         JOIN knowledge_item mt ON mt.id::text=(CASE WHEN e.src_id=ji.id::text THEN e.dst_id ELSE e.src_id END)
           AND mt.source='meeting'
        WHERE ji.user_id=$1 AND ji.workspace_id=$2 AND ji.space_id=$3 AND ji.source='jira'
          AND ji.status IS NOT NULL AND ji.status !~* '${DONEISH}'
          AND ji.occurred_at IS NOT NULL AND ji.occurred_at < NOW() - INTERVAL '${STALE_DAYS} days'
        ORDER BY ji.occurred_at ASC LIMIT 60`,
      [c.user_id, c.workspace_id, c.space_id],
    ).catch(() => []);

    let madeC = 0;
    const seenC = new Set<string>();
    for (const s of stale) {
      if (madeC >= PER_DETECTOR_CAP) break;
      if (!s.issue_key || seenC.has(s.issue_key)) continue;   // one nudge per ticket (dedup is permanent → no spam)
      const note = `🔔 Nudge from Wisprnote: this ticket traces to the decision in “${String(s.meeting_title || 'a meeting').slice(0, 80)}” and hasn't moved in ${s.days_stale} days (still “${s.status}”). Still on track, or is it blocked?`;
      const proposal: JiraActionProposal = { operation: 'comment', issueKey: s.issue_key, comment: note };
      const ok = await insertProposal({
        userId: c.user_id, workspaceId: c.workspace_id, spaceId: c.space_id, origin: 'reconcile',
        dedupKey: `reconcile:nudge:${s.issue_key}`,
        sourceTitle: s.issue_title,
        rationale: `Decided work has stalled ${s.days_stale} days with no ticket movement — post a nudge?`,
        proposal,
      });
      if (ok) { seenC.add(s.issue_key); madeC++; result.proposed++; }
    }
  }

  return result;
}
