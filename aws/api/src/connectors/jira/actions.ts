import { getToken } from '../../trust/broker';
import { getMcpServer, type McpServer } from '../../mcp/registry';
import { mcpCallTool } from '../../mcp/client';
import { findPersonByName, upsertPerson } from '../../people';
import { recordAudit } from './audit';
import { rememberRoute } from '../routing';

/**
 * Jira WRITE actions over the Atlassian Rovo MCP — the only path that mutates Jira.
 * Always invoked AFTER explicit human approval (HITL): chat/agent produces a proposal,
 * the user confirms an editable card, then the client calls the action route which
 * lands here. Built against the real MCP tool input schemas (introspected live):
 *   createJiraIssue { cloudId, projectKey, issueTypeName, summary, description,
 *                     assignee_account_id?, additional_fields? (duedate/priority/labels) }
 *   editJiraIssue   { cloudId, issueIdOrKey, fields }            (assignee:{accountId}, duedate, …)
 *   addCommentToJiraIssue { cloudId, issueIdOrKey, commentBody }
 *   transitionJiraIssue   { cloudId, issueIdOrKey, transition:{id} }  (+ getTransitionsForJiraIssue)
 *   lookupJiraAccountId   { cloudId, searchString }                   (name/email → accountId)
 * Jira has no MCP delete — "delete" is implemented as a close transition (clearly labelled).
 */

export type JiraOp = 'create' | 'update' | 'comment' | 'transition' | 'assign' | 'close';

export interface JiraActionProposal {
  operation: JiraOp;
  projectKey?: string;
  issueType?: string;          // Task | Bug | Story | Epic
  issueKey?: string;           // for update/comment/transition/assign/close
  summary?: string;
  description?: string;
  assigneeName?: string;       // resolved → accountId via people_directory + lookupJiraAccountId
  assigneeAccountId?: string;
  dueDate?: string;            // YYYY-MM-DD
  priority?: string;           // High | Medium | Low
  status?: string;             // target status name for transition/close
  comment?: string;
  labels?: string[];
}

export interface JiraActionResult {
  ok: boolean;
  operation: JiraOp;
  issueKey?: string;
  url?: string;
  message: string;
  auditId?: string;     // present when recorded; enables Undo
  undoable?: boolean;   // true when a rollback inverse was stored
}

function parseText(r: any): any {
  const text = r?.content?.[0]?.text;
  if (typeof text !== 'string') return null;
  try { return JSON.parse(text); } catch { return text; }
}

export interface JiraCtx { server: McpServer; at: string; cloudId: string; siteUrl: string; userId: string; }

/** Resolve the MCP server + token + cloudId/siteUrl for a user's workspace connection. */
export async function context(userId: string, workspaceId: string): Promise<JiraCtx | null> {
  const server = getMcpServer('jira');
  const cred = await getToken(userId, 'jira', workspaceId);
  const at = (cred?.token as any)?.access_token;
  if (!server?.url || !at) return null;
  const r = await mcpCallTool(server, at, 'getAccessibleAtlassianResources', {});
  const res = parseText(r);
  const arr = Array.isArray(res) ? res : [];
  const site = arr.find((x: any) => Array.isArray(x?.scopes) && x.scopes.some((s: string) => s.includes('jira'))) ?? arr[0];
  if (!site?.id) return null;
  return { server, at, cloudId: site.id, siteUrl: site.url || '', userId };
}

/** Visible projects (+ issue types) for the action card dropdowns. */
export async function jiraMeta(userId: string, workspaceId: string): Promise<{ connected: boolean; cloudId?: string; siteUrl?: string; projects: Array<{ key: string; name: string; issueTypes: string[] }> }> {
  const ctx = await context(userId, workspaceId);
  if (!ctx) return { connected: false, projects: [] };
  const r = await mcpCallTool(ctx.server, ctx.at, 'getVisibleJiraProjects', { cloudId: ctx.cloudId, action: 'create', expandIssueTypes: true, maxResults: 50 });
  const parsed = parseText(r);
  const list: any[] = Array.isArray(parsed?.values) ? parsed.values : Array.isArray(parsed) ? parsed : [];
  const projects = list.map((p: any) => ({
    key: p.key,
    name: p.name,
    issueTypes: Array.isArray(p.issueTypes) ? p.issueTypes.map((t: any) => t.name).filter(Boolean) : [],
  })).filter((p) => p.key);
  return { connected: true, cloudId: ctx.cloudId, siteUrl: ctx.siteUrl, projects };
}

/** name → accountId, caching the result on the people_directory record. */
async function resolveAccountId(ctx: JiraCtx, name?: string, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  if (!name) return null;
  const person = await findPersonByName(ctx.userId, name).catch(() => null);
  if (person?.jira_account_id) return person.jira_account_id;
  const search = person?.email || name;
  const r = await mcpCallTool(ctx.server, ctx.at, 'lookupJiraAccountId', { cloudId: ctx.cloudId, searchString: search });
  const parsed = parseText(r);
  const cand = Array.isArray(parsed) ? parsed[0] : (parsed?.accountId ? parsed : (Array.isArray(parsed?.values) ? parsed.values[0] : null));
  const accountId = cand?.accountId || cand?.account_id || null;
  if (accountId) await upsertPerson(ctx.userId, name, person?.email ?? cand?.emailAddress ?? null, accountId).catch(() => {});
  return accountId;
}

export interface JiraChange { when?: string; author?: string; changes: Array<{ field: string; from?: string; to?: string }> }
export interface JiraIssueDetail {
  key: string; url?: string; summary: string; status?: string; type?: string;
  assignee?: string; reporter?: string; priority?: string; dueDate?: string;
  created?: string; updated?: string;
  labels?: string[]; description?: string; comments?: string[];
  history?: JiraChange[];           // changelog (transitions + field edits, newest first)
  transitions?: string[];           // available workflow transitions (target status names)
}

const DETAIL_CAP = 8;               // issues we fetch full detail for (bounds MCP calls)
const HISTORY_CAP = 8;              // changelog entries kept per issue
const DETAIL_FIELDS = ['summary', 'description', 'status', 'issuetype', 'assignee', 'reporter', 'priority', 'duedate', 'labels', 'comment', 'created', 'updated'];

/**
 * Live read of full issue content for chat — by explicit keys, or a bounded recent list.
 * Returns the ACTUAL current state PLUS change history (changelog: transitions + field
 * edits), comments, and (optionally) available transitions. One getJiraIssue call per
 * issue (expand=changelog) yields fields + comments + history together.
 */
export async function jiraReadForChat(
  userId: string, workspaceId: string, keys?: string[],
  opts: { wantTransitions?: boolean; limit?: number } = {},
): Promise<{ connected: boolean; issues: JiraIssueDetail[] }> {
  const ctx = await context(userId, workspaceId);
  if (!ctx) return { connected: false, issues: [] };
  const link = (key: string) => ctx.siteUrl ? `${ctx.siteUrl}/browse/${key}` : undefined;

  const mapDetail = (iss: any): JiraIssueDetail => {
    const f = iss.fields || {};
    const comments = Array.isArray(f.comment?.comments)
      ? f.comment.comments.slice(-6).map((c: any) => {
          const body = typeof c.body === 'string' ? c.body : '';
          const when = c.created ? new Date(c.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
          return `${c.author?.displayName || 'Someone'}${when ? ` (${when})` : ''}: ${body}`.trim();
        }).filter(Boolean)
      : undefined;
    const histories: any[] = Array.isArray(iss.changelog?.histories) ? iss.changelog.histories : [];
    const history: JiraChange[] = histories.slice(-HISTORY_CAP).reverse().map((h: any) => ({
      when: h.created ? new Date(h.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : undefined,
      author: h.author?.displayName,
      changes: (Array.isArray(h.items) ? h.items : []).map((it: any) => ({ field: it.field, from: it.fromString || undefined, to: it.toString || undefined })),
    })).filter((h) => h.changes.length);
    return {
      key: iss.key, url: link(iss.key), summary: f.summary || '',
      status: f.status?.name, type: f.issuetype?.name,
      assignee: f.assignee?.displayName, reporter: f.reporter?.displayName,
      priority: f.priority?.name, dueDate: f.duedate || undefined,
      created: f.created || undefined, updated: f.updated || undefined,
      labels: Array.isArray(f.labels) && f.labels.length ? f.labels : undefined,
      description: typeof f.description === 'string' ? f.description.trim() : undefined,
      comments: comments && comments.length ? comments : undefined,
      history: history.length ? history : undefined,
    };
  };

  try {
    // Resolve the target key set: explicit keys, or a bounded recent search.
    let targetKeys: string[] = (keys || []).slice(0, DETAIL_CAP);
    let searchBasic: any[] = [];
    if (!targetKeys.length) {
      const r = await mcpCallTool(ctx.server, ctx.at, 'searchJiraIssuesUsingJql', {
        cloudId: ctx.cloudId, jql: `updated >= "2000-01-01" ORDER BY updated DESC`,
        maxResults: opts.limit ?? 25, fields: DETAIL_FIELDS, responseContentFormat: 'markdown',
      });
      const parsed = parseText(r);
      searchBasic = Array.isArray(parsed?.issues) ? parsed.issues : [];
      targetKeys = searchBasic.slice(0, DETAIL_CAP).map((i: any) => i.key).filter(Boolean);
    }

    // Full detail (fields + comments + changelog) for the capped set.
    const detailed: JiraIssueDetail[] = [];
    for (const k of targetKeys) {
      const r = await mcpCallTool(ctx.server, ctx.at, 'getJiraIssue', {
        cloudId: ctx.cloudId, issueIdOrKey: k, expand: 'changelog', fields: DETAIL_FIELDS, responseContentFormat: 'markdown',
      });
      const parsed = parseText(r);
      if (parsed?.key || parsed?.fields) {
        const d = mapDetail(parsed);
        if (opts.wantTransitions) {
          const tr = await mcpCallTool(ctx.server, ctx.at, 'getTransitionsForJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: k }).catch(() => null);
          const tlist: any[] = Array.isArray(parseText(tr)?.transitions) ? parseText(tr).transitions : [];
          d.transitions = tlist.map((t: any) => t?.to?.name || t?.name).filter(Boolean);
        }
        detailed.push(d);
      }
    }

    // Any remaining search hits beyond the detail cap → current-state only (no extra calls).
    const have = new Set(detailed.map((d) => d.key));
    for (const iss of searchBasic) {
      if (have.has(iss.key)) continue;
      detailed.push(mapDetail(iss));
    }
    return { connected: true, issues: detailed };
  } catch (e: any) {
    console.error('jira_read_for_chat_failed', JSON.stringify({ message: e?.message }));
    return { connected: true, issues: [] };
  }
}

/**
 * Recent activity across the project in ONE shot — for "what changed / what moved /
 * transitions" questions. Finds recently-updated issues, fetches their changelogs IN
 * PARALLEL server-side, and returns a consolidated change report. This collapses what
 * would otherwise be N sequential model-driven getJiraIssue calls into a single fast
 * tool call (keeping the agent well under the gateway timeout).
 */
export async function jiraRecentActivity(userId: string, workspaceId: string, sinceDays = 1, max = 12): Promise<string> {
  const ctx = await context(userId, workspaceId);
  if (!ctx) return 'Jira is not connected in this workspace.';
  const sinceMs = Date.now() - sinceDays * 86_400_000;
  try {
    const s = await mcpCallTool(ctx.server, ctx.at, 'searchJiraIssuesUsingJql', {
      cloudId: ctx.cloudId, jql: `updated >= "2000-01-01" ORDER BY updated DESC`, maxResults: max,
      fields: ['summary', 'updated'], responseContentFormat: 'markdown',
    });
    const issues: any[] = parseText(s)?.issues ?? [];
    if (!issues.length) return 'No issues found.';
    const details = await Promise.all(issues.map((iss: any) =>
      mcpCallTool(ctx.server, ctx.at, 'getJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: iss.key, expand: 'changelog', fields: ['summary'], responseContentFormat: 'markdown' })
        .then((r) => ({ key: iss.key, parsed: parseText(r) })).catch(() => null),
    ));
    const lines: string[] = [`Change activity in the last ${sinceDays} day(s) (newest first):`];
    let any = false;
    for (const d of details) {
      if (!d?.parsed) continue;
      const summary = d.parsed.fields?.summary || '';
      const hist: any[] = Array.isArray(d.parsed.changelog?.histories) ? d.parsed.changelog.histories : [];
      const recent = hist.filter((h) => h.created && new Date(h.created).getTime() >= sinceMs);
      if (!recent.length) continue;
      any = true;
      const url = ctx.siteUrl ? `${ctx.siteUrl}/browse/${d.key}` : '';
      lines.push(`\n${d.key} — ${summary}${url ? ` (${url})` : ''}`);
      for (const h of recent.reverse()) {
        const when = h.created ? new Date(h.created).toLocaleString('en-US', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' }) : '';
        const who = h.author?.displayName || 'someone';
        for (const it of (h.items || [])) {
          lines.push(`  • ${it.field}: "${it.fromString ?? '∅'}" → "${it.toString ?? '∅'}" — ${when} by ${who}`);
        }
      }
    }
    if (!any) return `No changes in the last ${sinceDays} day(s).`;
    return lines.join('\n');
  } catch (e: any) {
    return `recent activity lookup failed: ${e?.message || 'error'}`;
  }
}

/** Read current fields of an issue (for building rollback proposals). */
async function snapshot(ctx: JiraCtx, issueKey: string): Promise<{ status?: string; summary?: string; description?: string; assigneeAccountId?: string; dueDate?: string; priority?: string }> {
  try {
    const r = await mcpCallTool(ctx.server, ctx.at, 'getJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: issueKey, responseContentFormat: 'markdown' });
    const f = parseText(r)?.fields ?? {};
    return {
      status: f.status?.name,
      summary: f.summary,
      description: typeof f.description === 'string' ? f.description : undefined,
      assigneeAccountId: f.assignee?.accountId,
      dueDate: f.duedate || undefined,
      priority: f.priority?.name,
    };
  } catch { return {}; }
}

/** Find a transition id whose target status matches `status` (fuzzy). */
async function findTransitionId(ctx: JiraCtx, issueKey: string, status: string | undefined, closeLike = false): Promise<string | null> {
  const r = await mcpCallTool(ctx.server, ctx.at, 'getTransitionsForJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: issueKey });
  const parsed = parseText(r);
  const transitions: any[] = Array.isArray(parsed?.transitions) ? parsed.transitions : Array.isArray(parsed) ? parsed : [];
  const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
  if (status) {
    const want = norm(status);
    const hit = transitions.find((t) => norm(t?.to?.name) === want || norm(t?.name) === want)
      ?? transitions.find((t) => norm(t?.to?.name).includes(want) || norm(t?.name).includes(want));
    if (hit?.id) return String(hit.id);
  }
  if (closeLike) {
    const closers = ['done', 'closed', 'cancelled', 'canceled', 'wontdo', 'resolved'];
    const hit = transitions.find((t) => closers.includes(norm(t?.to?.name)) || closers.includes(norm(t?.name)));
    if (hit?.id) return String(hit.id);
  }
  return null;
}

export async function executeJiraAction(userId: string, workspaceId: string, p: JiraActionProposal, opts: { audit?: boolean } = {}): Promise<JiraActionResult> {
  const doAudit = opts.audit !== false;
  const ctx = await context(userId, workspaceId);
  if (!ctx) return { ok: false, operation: p.operation, message: 'Jira is not connected in this workspace.' };
  const link = (key: string) => ctx.siteUrl ? `${ctx.siteUrl}/browse/${key}` : undefined;
  const fail = (message: string): JiraActionResult => ({ ok: false, operation: p.operation, message });
  const audit = async (res: JiraActionResult, rollback: JiraActionProposal | null) => {
    if (doAudit && res.ok) {
      const auditId = await recordAudit({ userId, workspaceId, operation: p.operation, issueKey: res.issueKey ?? p.issueKey ?? null, summary: p.summary ?? null, proposal: p, result: res, rollback }).catch(() => null);
      if (auditId) { res.auditId = auditId; res.undoable = !!rollback; }
    }
  };

  try {
    if (p.operation === 'create') {
      if (!p.projectKey) return fail('Pick a project before creating.');
      if (!p.summary) return fail('A summary is required.');
      const additional: Record<string, unknown> = {};
      if (p.dueDate) additional.duedate = p.dueDate;
      if (p.priority) additional.priority = { name: p.priority };
      if (p.labels?.length) additional.labels = p.labels;
      const accountId = await resolveAccountId(ctx, p.assigneeName, p.assigneeAccountId);
      const args: Record<string, unknown> = {
        cloudId: ctx.cloudId, projectKey: p.projectKey, issueTypeName: p.issueType || 'Task',
        summary: p.summary, contentFormat: 'markdown',
      };
      if (p.description) args.description = p.description;
      if (accountId) args.assignee_account_id = accountId;
      if (Object.keys(additional).length) args.additional_fields = additional;
      const r = await mcpCallTool(ctx.server, ctx.at, 'createJiraIssue', args);
      if (r?.isError) return fail(`Jira rejected the create: ${String(r?.content?.[0]?.text ?? '').slice(0, 200)}`);
      const out = parseText(r);
      const key = out?.key || out?.issueKey || out?.id;
      // Learn the routing: this workspace → this project (confirmed by the approval).
      await rememberRoute(userId, workspaceId, p.projectKey).catch(() => {});
      const res: JiraActionResult = { ok: true, operation: 'create', issueKey: key, url: key ? link(key) : undefined, message: key ? `Created ${key}.` : 'Issue created.' };
      await audit(res, key ? { operation: 'close', issueKey: key } : null);   // rollback = close (no MCP delete)
      return res;
    }

    if (!p.issueKey) return fail('No issue key specified.');

    if (p.operation === 'comment') {
      if (!p.comment) return fail('Comment body is empty.');
      const r = await mcpCallTool(ctx.server, ctx.at, 'addCommentToJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: p.issueKey, commentBody: p.comment, contentFormat: 'markdown' });
      if (r?.isError) return fail(`Jira rejected the comment: ${String(r?.content?.[0]?.text ?? '').slice(0, 200)}`);
      const res: JiraActionResult = { ok: true, operation: 'comment', issueKey: p.issueKey, url: link(p.issueKey), message: `Commented on ${p.issueKey}.` };
      await audit(res, null);   // comments aren't reversible via MCP
      return res;
    }

    if (p.operation === 'transition' || p.operation === 'close') {
      const prior = doAudit ? await snapshot(ctx, p.issueKey) : {};
      const tid = await findTransitionId(ctx, p.issueKey, p.status, p.operation === 'close');
      if (!tid) return fail(p.operation === 'close'
        ? `Couldn't find a close/done transition for ${p.issueKey}. (Jira has no delete via MCP — issues can only be closed.)`
        : `No transition to "${p.status}" is available for ${p.issueKey}.`);
      const r = await mcpCallTool(ctx.server, ctx.at, 'transitionJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: p.issueKey, transition: { id: tid } });
      if (r?.isError) return fail(`Jira rejected the transition: ${String(r?.content?.[0]?.text ?? '').slice(0, 200)}`);
      const res: JiraActionResult = { ok: true, operation: p.operation, issueKey: p.issueKey, url: link(p.issueKey), message: `Moved ${p.issueKey}${p.status ? ` to ${p.status}` : ' to done'}.` };
      await audit(res, prior.status ? { operation: 'transition', issueKey: p.issueKey, status: prior.status } : null);
      return res;
    }

    // update | assign → editJiraIssue
    const prior = doAudit ? await snapshot(ctx, p.issueKey) : {};
    const fields: Record<string, unknown> = {};
    if (p.summary) fields.summary = p.summary;
    if (p.description) fields.description = p.description;
    if (p.dueDate) fields.duedate = p.dueDate;
    if (p.priority) fields.priority = { name: p.priority };
    if (p.labels?.length) fields.labels = p.labels;
    if (p.issueType) fields.issuetype = { name: p.issueType };
    if (p.operation === 'assign' || p.assigneeName || p.assigneeAccountId) {
      const accountId = await resolveAccountId(ctx, p.assigneeName, p.assigneeAccountId);
      if (!accountId && p.operation === 'assign') return fail(`Couldn't resolve "${p.assigneeName}" to a Jira user. Add their email in People first.`);
      if (accountId) fields.assignee = { accountId };
    }
    if (!Object.keys(fields).length) return fail('Nothing to update.');
    const r = await mcpCallTool(ctx.server, ctx.at, 'editJiraIssue', { cloudId: ctx.cloudId, issueIdOrKey: p.issueKey, fields, contentFormat: 'markdown' });
    if (r?.isError) return fail(`Jira rejected the edit: ${String(r?.content?.[0]?.text ?? '').slice(0, 200)}`);
    // Build a rollback restoring only the fields we changed (best-effort).
    const rb: JiraActionProposal = { operation: 'update', issueKey: p.issueKey };
    if ('summary' in fields && prior.summary) rb.summary = prior.summary;
    if ('description' in fields && prior.description) rb.description = prior.description;
    if ('duedate' in fields) rb.dueDate = prior.dueDate;
    if ('priority' in fields && prior.priority) rb.priority = prior.priority;
    if ('assignee' in fields && prior.assigneeAccountId) rb.assigneeAccountId = prior.assigneeAccountId;
    const hasRollback = Object.keys(rb).length > 2;
    const res: JiraActionResult = { ok: true, operation: p.operation, issueKey: p.issueKey, url: link(p.issueKey), message: p.operation === 'assign' ? `Assigned ${p.issueKey}.` : `Updated ${p.issueKey}.` };
    await audit(res, hasRollback ? rb : null);
    return res;
  } catch (e: any) {
    console.error('jira_action_failed', JSON.stringify({ op: p.operation, message: e?.message }));
    return fail(`Action failed: ${e?.message || 'unknown error'}`);
  }
}
