import { query } from '../../db';
import { ensureConnectorSchema } from '../schema';
import { insertProposal, ensureProposalSchema } from '../proposals';
import { jiraMeta, type JiraActionProposal } from './actions';
import { resolveProjectKey } from '../routing';
import { evaluateSettledThreads } from './conviction';
import { ensureCoverageSchema, markReasoned } from '../suggestionCoverage';
import { ACCOUNT_SCOPE } from '../schema';

/**
 * Autonomous Jira agent (PROPOSE-ONLY, HITL). Driven by an EventBridge sweep, the
 * connector-side twin of kgSweep. For each workspace with Jira connected, it scans
 * recent meetings' committed action items and writes editable PROPOSALS into the
 * action_proposal ledger — it NEVER writes to Jira. A human approves each in the UI.
 *
 * Conviction (v1, conservative): only propose for action items that have an explicit
 * OWNER (a committed task, not a vague mention), deduped against existing Jira issues and prior
 * proposals. This is the "don't act prematurely" gate.
 *
 * COVERAGE (Phase 1): no recency window. Each tick processes a bounded batch of NOT-YET-reasoned
 * meetings (newest first) and marks them reasoned, so over successive ticks the WHOLE corpus is
 * covered — every meeting, not just the recent 20. Coverage is surfaced as "reasoned over N of N".
 */

const WORKSPACE_CAP = 20;        // workspaces processed per tick
const MEETINGS_PER_TICK = 30;    // un-reasoned meetings examined per workspace per tick (backfill batch)
const PROPOSALS_PER_WS = 12;     // bound the suggestions we surface per workspace per tick

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s: string) => norm(s).replace(/\s+/g, '-').slice(0, 60);

export interface AgentSweepResult { workspaces: number; proposed: number }

export async function runJiraAgentSweep(): Promise<AgentSweepResult> {
  await ensureConnectorSchema();
  await ensureProposalSchema();
  await ensureCoverageSchema();
  const result: AgentSweepResult = { workspaces: 0, proposed: 0 };

  const creds = await query<{ user_id: string; workspace_id: string; space_id: string | null; ws_name: string | null }>(
    `SELECT DISTINCT cc.user_id, cc.workspace_id, cc.space_id, w.name AS ws_name
       FROM connector_credentials cc
       LEFT JOIN workspaces w ON w.id = cc.workspace_id
      WHERE cc.source='jira' LIMIT ${WORKSPACE_CAP}`,
  );

  for (const c of creds) {
    let meta;
    try { meta = await jiraMeta(c.user_id, c.workspace_id); } catch { continue; }
    if (!meta?.connected || !meta.projects.length) continue;
    result.workspaces++;
    // Adaptive routing: confirmed mapping → name-match suggestion → first project.
    const projectKey = (await resolveProjectKey(c.user_id, c.workspace_id, meta.projects, c.ws_name)) || meta.projects[0].key;

    // Meetings in this scope, NOT YET reasoned over — newest first. Use the CANONICAL membership
    // the UI uses (`task_history.space_id` for a space-scoped connection, else `workspace_id`) — NOT
    // the sparse legacy task_workspaces tables, which miss meetings filed straight into a space.
    // No recency window: successive ticks drain the backlog until the whole corpus is covered.
    const bySpace = !!c.space_id && c.space_id !== ACCOUNT_SCOPE;
    const membership = bySpace ? 'th.space_id = $2' : 'th.workspace_id = $2';   // controlled set
    const scopeId = bySpace ? c.space_id : c.workspace_id;
    const meetings = await query<{ id: string; filename: string; created_at: string; action_items: any; space_id: string | null }>(
      `SELECT th.id, th.filename, th.created_at, th.space_id, kg.action_items
         FROM task_history th
         LEFT JOIN knowledge_graph kg ON kg.task_id = th.id AND kg.user_id = th.user_id
        WHERE th.user_id = $1 AND ${membership}
          AND th.id::text NOT IN (SELECT meeting_id FROM suggestion_reasoned WHERE user_id = $1 AND workspace_id = $3)
        ORDER BY th.created_at DESC LIMIT ${MEETINGS_PER_TICK}`,
      [c.user_id, scopeId, c.workspace_id],
    ).catch(() => []);
    if (!meetings.length) continue;

    // Existing Jira issue titles in this workspace — to skip obvious duplicates.
    const existing = await query<{ title: string }>(
      `SELECT title FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source='jira' LIMIT 500`,
      [c.user_id, c.workspace_id],
    ).catch(() => []);
    const existingNorm = existing.map((e) => norm(e.title)).filter(Boolean);

    let made = 0;
    const examinedIds: string[] = [];   // every meeting we looked at this tick → mark reasoned (advance coverage)
    for (const m of meetings) {
      examinedIds.push(String(m.id));
      const items: any[] = Array.isArray(m.action_items) ? m.action_items : [];
      for (const ai of items) {
        if (made >= PROPOSALS_PER_WS) break;   // stop PROPOSING past the cap, but keep examining to advance coverage
        const task = String(ai?.task || '').trim();
        const owner = String(ai?.owner || '').trim();
        if (!task || !owner) continue;                          // conviction gate: needs a committed owner
        const taskNorm = norm(task);
        if (existingNorm.some((t) => t.includes(taskNorm) || taskNorm.includes(t))) continue; // already a Jira issue

        const when = m.created_at ? new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
        const proposal: JiraActionProposal = {
          operation: 'create',
          projectKey,
          issueType: 'Task',
          summary: task.slice(0, 240),
          description: `Auto-suggested by WisprNote from the meeting "${m.filename || 'Untitled'}"${when ? ` (${when})` : ''}.\n\nOwner discussed: ${owner}.`,
          assigneeName: owner,
        };
        const ok = await insertProposal({
          userId: c.user_id, workspaceId: c.workspace_id, spaceId: m.space_id ?? null,
          dedupKey: `m:${m.id}:${slug(task)}`,
          proposal,
          sourceMeetingId: m.id, sourceTitle: m.filename || null,
          rationale: `Committed action item owned by ${owner}.`,
          origin: 'agent',
        }).catch(() => false);
        if (ok) { made++; result.proposed++; }
      }
    }
    // Coverage: every meeting examined this tick is now reasoned-over (so the backfill advances and
    // the UI can show "N of N") — independent of how many proposals we surfaced.
    await markReasoned(c.user_id, c.workspace_id, examinedIds).catch(() => {});

    // Conviction layer: turn SETTLED cross-meeting decisions into proposals. The engine
    // only returns high-conviction, non-oscillating threads (patience before action).
    try {
      const settled = await evaluateSettledThreads(c.user_id, c.workspace_id);
      for (const t of settled) {
        const proposal: JiraActionProposal = {
          operation: 'create',
          projectKey,
          issueType: t.issueType,
          summary: t.recommendedSummary,
          description: `Settled decision (high conviction): ${t.finalDecision}\n\nWhy now: ${t.reason}\n\nAuto-suggested by WisprNote's conviction engine from this workspace's meetings.`,
        };
        const ok = await insertProposal({
          userId: c.user_id, workspaceId: c.workspace_id,
          dedupKey: `thread:${slug(t.topic)}`,
          proposal,
          sourceTitle: t.topic,
          rationale: `Settled across meetings — ${t.reason}`,
          origin: 'agent',
        }).catch(() => false);
        if (ok) result.proposed++;
      }
    } catch { /* conviction is best-effort; never blocks the sweep */ }
  }

  console.log('jira_agent_sweep', JSON.stringify(result));
  return result;
}
