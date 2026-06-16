import { registerConnector, type KnowledgeItemInput } from '../registry';
import { getToken } from '../../trust/broker';
import { getMcpServer } from '../../mcp/registry';
import { mcpCallTool } from '../../mcp/client';

/**
 * Jira connector — adapter over the Atlassian Rovo MCP server. Each `sync` pulls a
 * bounded page of issues (incremental by `updated`) via `searchJiraIssuesUsingJql`
 * and maps them to knowledge_item. Authed by the broker token; cloudId resolved via
 * `getAccessibleAtlassianResources`. JQL must be bounded (Atlassian rejects
 * unbounded queries), so we always anchor on `updated >= <cursor>`.
 */

const PAGE = 50;
const FIELDS = ['summary', 'description', 'status', 'issuetype', 'priority', 'created', 'updated', 'assignee', 'reporter', 'labels'];

function textOf(v: unknown): string {
  if (!v) return '';
  if (typeof v === 'string') return v;
  try { return JSON.stringify(v); } catch { return ''; }
}

registerConnector({
  id: 'jira',
  async sync(userId, scope, cursor) {
    const server = getMcpServer('jira');
    // `scope` is the workspace_id — fetch the token connected in THIS workspace.
    const cred = await getToken(userId, 'jira', scope);
    const accessToken = (cred?.token as any)?.access_token;
    if (!server?.url || !accessToken) return { items: [], nextCursor: null };

    // Resolve cloudId + site URL (prefer the Jira-scoped resource).
    let cloudId = ''; let siteUrl = '';
    try {
      const r = await mcpCallTool(server, accessToken, 'getAccessibleAtlassianResources', {});
      const res = JSON.parse(r?.content?.[0]?.text ?? '[]');
      const site = (Array.isArray(res) ? res : []).find((x: any) => Array.isArray(x?.scopes) && x.scopes.some((s: string) => s.includes('jira'))) ?? res?.[0];
      cloudId = site?.id ?? ''; siteUrl = site?.url ?? '';
    } catch (e: any) {
      console.error('jira_resources_failed', JSON.stringify({ message: e?.message }));
      return { items: [], nextCursor: cursor };
    }
    if (!cloudId) return { items: [], nextCursor: cursor };

    const since = cursor || '2000-01-01 00:00';
    const jql = `updated >= "${since}" ORDER BY updated ASC`;
    let parsed: any = {};
    try {
      const s = await mcpCallTool(server, accessToken, 'searchJiraIssuesUsingJql', {
        cloudId, jql, maxResults: PAGE, fields: FIELDS, responseContentFormat: 'markdown',
      });
      const text = s?.content?.[0]?.text ?? '{}';
      parsed = JSON.parse(text);
      if (parsed?.error || s?.isError) {
        console.error('jira_search_error', String(text).slice(0, 200));
        return { items: [], nextCursor: cursor };
      }
    } catch (e: any) {
      console.error('jira_search_failed', JSON.stringify({ message: e?.message }));
      return { items: [], nextCursor: cursor };
    }

    const issues: any[] = Array.isArray(parsed?.issues) ? parsed.issues : [];
    const items: KnowledgeItemInput[] = issues.map((iss: any) => {
      const f = iss.fields || {};
      const people: Record<string, string> = {};
      if (f.assignee?.displayName) people.assignee = f.assignee.displayName;
      if (f.reporter?.displayName) people.reporter = f.reporter.displayName;
      const body = [
        f.summary,
        textOf(f.description),
        f.status?.name ? `Status: ${f.status.name}` : '',
        f.issuetype?.name ? `Type: ${f.issuetype.name}` : '',
        Array.isArray(f.labels) && f.labels.length ? `Labels: ${f.labels.join(', ')}` : '',
      ].filter(Boolean).join('\n');
      return {
        source: 'jira',
        source_id: iss.key,
        type: 'issue',
        title: `${iss.key}: ${f.summary || ''}`.trim(),
        body,
        people,
        links: siteUrl ? { url: `${siteUrl}/browse/${iss.key}` } : {},
        raw: iss,
        occurred_at: f.updated || f.created || null,
      };
    });

    // Advance the incremental watermark to the newest `updated` seen (idempotent
    // upsert tolerates the 1-issue boundary overlap on the next tick).
    let nextCursor = cursor ?? null;
    const lastUpdated = issues[issues.length - 1]?.fields?.updated;
    if (lastUpdated) nextCursor = lastUpdated;

    console.log('jira_sync', JSON.stringify({ count: items.length, nextCursor }));
    return { items, nextCursor };
  },
});
