import { query } from '../db';
import { ensureConnectorSchema, ACCOUNT_SCOPE } from './schema';
import { ensureProposalSchema, insertProposal } from './proposals';
import { jiraMeta, type JiraActionProposal } from './jira/actions';
import { resolveProjectKey } from './routing';
import { runAgentTurn } from '../chat/agentTurn';

/**
 * SUGGESTION REASONER (Suggested Actions Engine — Phase 3).
 *
 * The rule-based sweep only proposes Jira tickets from owner-committed action items. This is the
 * INTELLIGENT half: per space, it reads the decisions + action items across ALL the space's meetings
 * AND all the existing Jira tasks, and reasons about the GAP — work the team clearly committed to
 * that isn't tracked anywhere yet. Existing tickets are treated as the work-in-progress; it proposes
 * only what's missing, never a duplicate. Propose-only (HITL) — writes into action_proposal, which
 * the human approves; execution goes through the gated executor.
 *
 * Uses the provider abstraction (runAgentTurn) with a forced structured tool call, on Gemini
 * (Anthropic-direct is the default once funded). Bounded per space + per tick for cost.
 */

const WORKSPACE_CAP = 12;          // spaces considered per tick (round-robin; deadline is the real bound)
const REASONER_BUDGET_MS = 200_000; // wall-clock budget per tick → must fit the Lambda timeout
const MEETINGS_PER_SPACE = 40;     // most-recent meetings whose KG we feed (token bound)
const MAX_DECISION_LINES = 120;
const MAX_EXISTING = 150;
const MAX_ACTIONS = 8;             // proposals accepted per space per tick
const MIN_CONFIDENCE = 0.5;        // P4: drop candidates the critic isn't at least this sure about
const EXPIRES_DAYS = 30;           // P4: a suggestion goes stale if not acted on

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
const slug = (s: string) => norm(s).replace(/\s+/g, '-').slice(0, 60);
const clamp01 = (x: any, d: number) => { const n = Number(x); return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : d; };

// P4 — adversarial critic: a SEPARATE strict reviewer (the generator is optimistic). For each
// candidate it returns keep + confidence/impact/urgency, defaulting to REJECT on uncertainty.
const REVIEW_SYSTEM =
  'You are a STRICT reviewer of proposed tasks. For each one, judge: (1) is it genuinely COMMITTED work ' +
  'from the meetings (not vague/speculative)? (2) is it NOT already covered by an existing task? ' +
  '(3) is it worth a busy team’s attention? Default to keep=false when uncertain. Score confidence, ' +
  'impact, and urgency each 0–1. Always call review_actions with one verdict per task, in the SAME ORDER.';
const REVIEW_TOOL = [{
  name: 'review_actions',
  description: 'One verdict per proposed task, in the same order given.',
  inputSchema: {
    type: 'object',
    properties: {
      verdicts: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            keep: { type: 'boolean', description: 'Surface this task?' },
            confidence: { type: 'number', description: '0–1: how sure it is real, committed, untracked.' },
            impact: { type: 'number', description: '0–1: how much it matters.' },
            urgency: { type: 'number', description: '0–1: how time-sensitive.' },
            reason: { type: 'string', description: 'One short clause.' },
          },
          required: ['keep', 'confidence'],
        },
      },
    },
    required: ['verdicts'],
  },
}];

async function reviewActions(context: string, actions: any[]): Promise<Array<{ keep: boolean; confidence: number; impact: number; urgency: number; reason: string }>> {
  const fallback = actions.map(() => ({ keep: true, confidence: 0.6, impact: 0.5, urgency: 0.5, reason: '' }));
  const list = actions.map((a, i) => `${i + 1}. ${String(a?.summary || '').slice(0, 180)} — ${String(a?.rationale || '').slice(0, 200)}`).join('\n');
  try {
    const turn = await runAgentTurn({
      provider: 'gemini', model: 'gemini-3-flash-preview', system: REVIEW_SYSTEM,
      messages: [{ role: 'user', content: [{ type: 'text', text: `${context}\n\nProposed tasks to review (one verdict each, SAME ORDER):\n${list}` }] }],
      tools: REVIEW_TOOL, maxOutputTokens: 1536,
    });
    const v: any[] = (turn.toolCalls.find((t) => t.name === 'review_actions')?.args?.verdicts) || [];
    if (!Array.isArray(v) || !v.length) return fallback;
    return actions.map((_, i) => {
      const r = v[i] || {};
      return { keep: r.keep !== false, confidence: clamp01(r.confidence, 0.6), impact: clamp01(r.impact, 0.5), urgency: clamp01(r.urgency, 0.5), reason: String(r.reason || '') };
    });
  } catch {
    return fallback;   // critic failed → don't block; the generator already deduped against existing tasks
  }
}

const SYSTEM =
  "You are Wisprnote's planning agent. You compare what a team DECIDED across their meetings against " +
  'what already EXISTS as tasks in their tools, and propose ONLY the gap — clearly-committed work that ' +
  "isn't tracked yet. Be conservative: never duplicate an existing task, never invent work that wasn't " +
  'committed, and skip vague mentions. If everything decided is already tracked, propose nothing. ' +
  'Always call propose_actions with your result.';

const TOOL = [{
  name: 'propose_actions',
  description: 'Propose the missing tasks (the gap between decided work and existing tasks). Empty if nothing is missing.',
  inputSchema: {
    type: 'object',
    properties: {
      actions: {
        type: 'array',
        description: 'The missing tasks to propose. Keep it tight — only genuinely-committed, untracked work.',
        items: {
          type: 'object',
          properties: {
            summary: { type: 'string', description: 'Short imperative task title.' },
            rationale: { type: 'string', description: 'Why this is needed + which meeting it came from.' },
            owner: { type: 'string', description: 'The person who committed to it, if named.' },
          },
          required: ['summary', 'rationale'],
        },
      },
    },
    required: ['actions'],
  },
}];

export interface ReasonerResult { spaces: number; proposed: number }

export async function runSuggestionReasoner(): Promise<ReasonerResult> {
  await ensureConnectorSchema();
  await ensureProposalSchema();
  const result: ReasonerResult = { spaces: 0, proposed: 0 };

  // Round-robin: spaces reasoned-over longest ago (or never) go first, so none starves under the
  // per-tick deadline. The deadline guarantees we fit the Lambda timeout even with many spaces.
  const creds = await query<{ user_id: string; workspace_id: string; space_id: string | null; ws_name: string | null }>(
    `SELECT cc.user_id, cc.workspace_id, cc.space_id, w.name AS ws_name,
            (SELECT MAX(ap.created_at) FROM action_proposal ap
              WHERE ap.user_id=cc.user_id AND ap.workspace_id=cc.workspace_id AND ap.space_id=cc.space_id
                AND ap.dedup_key LIKE 'reason:%') AS last_reasoned
       FROM (SELECT DISTINCT user_id, workspace_id, space_id FROM connector_credentials WHERE source='jira') cc
       LEFT JOIN workspaces w ON w.id = cc.workspace_id
      ORDER BY last_reasoned ASC NULLS FIRST
      LIMIT ${WORKSPACE_CAP}`,
  ).catch(() => []);

  const startedAt = Date.now();
  for (const c of creds) {
    if (Date.now() - startedAt > REASONER_BUDGET_MS) { console.log('suggestion_reasoner_deadline', JSON.stringify(result)); break; }
    let meta;
    try { meta = await jiraMeta(c.user_id, c.workspace_id); } catch { continue; }
    if (!meta?.connected || !meta.projects.length) continue;
    const projectKey = (await resolveProjectKey(c.user_id, c.workspace_id, meta.projects, c.ws_name)) || meta.projects[0].key;

    // Decisions + action items across ALL the space's meetings (canonical space_id membership).
    const bySpace = !!c.space_id && c.space_id !== ACCOUNT_SCOPE;
    const meetings = await query<{ filename: string; decisions: any; action_items: any }>(
      `SELECT th.filename, kg.decisions, kg.action_items
         FROM task_history th
         JOIN knowledge_graph kg ON kg.task_id = th.id AND kg.user_id = th.user_id
        WHERE th.user_id=$1 AND ${bySpace ? 'th.space_id=$2' : 'th.workspace_id=$2'}
        ORDER BY th.created_at DESC LIMIT ${MEETINGS_PER_SPACE}`,
      [c.user_id, bySpace ? c.space_id : c.workspace_id],
    ).catch(() => []);
    if (!meetings.length) continue;

    const decisionLines: string[] = [];
    for (const m of meetings) {
      for (const d of (Array.isArray(m.decisions) ? m.decisions : [])) {
        const t = String(d?.decision || '').trim(); if (t) decisionLines.push(`- [${m.filename}] DECIDED: ${t}`);
      }
      for (const a of (Array.isArray(m.action_items) ? m.action_items : [])) {
        const t = String(a?.task || '').trim(); if (t) decisionLines.push(`- [${m.filename}] ACTION (${a?.owner || 'unassigned'}): ${t}`);
      }
    }
    if (!decisionLines.length) continue;

    // Existing Jira tasks (the work already tracked) — treated as done; never re-proposed. STRICT
    // per-space: only THIS space's Jira (scoped by the same canonical space_id as the meetings), so
    // a space never diffs against another space's tickets.
    const existing = await query<{ title: string; status: string | null }>(
      `SELECT title, status FROM knowledge_item
        WHERE user_id=$1 AND ${bySpace ? 'space_id=$2' : 'workspace_id=$2'} AND source='jira' LIMIT 400`,
      [c.user_id, bySpace ? c.space_id : c.workspace_id],
    ).catch(() => []);
    const existingNorm = existing.map((e) => norm(e.title)).filter(Boolean);
    const existingLines = existing.map((e) => `- ${e.title}${e.status ? ` [${e.status}]` : ''}`);

    const context =
      `Decisions & action items across this team's meetings:\n${decisionLines.slice(0, MAX_DECISION_LINES).join('\n')}\n\n` +
      `Existing Jira tasks (already tracked — DO NOT recreate any of these):\n${existingLines.slice(0, MAX_EXISTING).join('\n') || '(none yet)'}\n\n` +
      `Propose ONLY the tasks that are genuinely missing — committed work not reflected in an existing Jira task. If it's already tracked, leave it out.`;

    result.spaces++;
    let turn;
    try {
      turn = await runAgentTurn({
        provider: 'gemini', model: 'gemini-3-flash-preview', system: SYSTEM,
        messages: [{ role: 'user', content: [{ type: 'text', text: context }] }],
        tools: TOOL, maxOutputTokens: 2048,
      });
    } catch (e: any) { console.error('reasoner_turn_failed', c.workspace_id, String(e?.message || e).slice(0, 160)); continue; }

    const call = turn.toolCalls.find((t) => t.name === 'propose_actions');
    const candidates: any[] = (Array.isArray(call?.args?.actions) ? call!.args.actions : [])
      .filter((a: any) => String(a?.summary || '').trim())
      .filter((a: any) => { const s = norm(a.summary); return !existingNorm.some((t) => t.includes(s) || s.includes(t)); });   // drop obvious dupes pre-critic
    if (!candidates.length) continue;

    // P4 — adversarial verify: a strict critic scores each; keep only confident, real, ranked ones.
    const verdicts = await reviewActions(context, candidates);
    const ranked = candidates
      .map((a, i) => ({ a, v: verdicts[i] }))
      .filter((x) => x.v.keep && x.v.confidence >= MIN_CONFIDENCE)
      .map((x) => ({ ...x, score: +(x.v.confidence * x.v.impact * x.v.urgency).toFixed(4) }))
      .sort((p, q) => q.score - p.score);

    let made = 0;
    for (const { a, v, score } of ranked) {
      if (made >= MAX_ACTIONS) break;
      const summary = String(a.summary).trim();
      const reason = String(a?.rationale || '').slice(0, 300);
      const proposal: JiraActionProposal = {
        operation: 'create', projectKey, issueType: 'Task',
        summary: summary.slice(0, 240),
        description: `${reason}\n\nProposed by Wisprnote's planning agent (gap between decided work and existing tasks). Confidence ${Math.round(v.confidence * 100)}%${v.reason ? ` — ${v.reason}` : ''}.`,
        assigneeName: a?.owner ? String(a.owner) : undefined,
      };
      const ok = await insertProposal({
        userId: c.user_id, workspaceId: c.workspace_id, spaceId: c.space_id ?? null, kind: 'jira', origin: 'agent',
        dedupKey: `reason:${slug(summary)}`, proposal, sourceTitle: 'Planning agent', rationale: reason,
        confidence: v.confidence, score, expiresInDays: EXPIRES_DAYS,
      }).catch(() => false);
      if (ok) { made++; result.proposed++; }
    }
  }

  console.log('suggestion_reasoner', JSON.stringify(result));
  return result;
}
