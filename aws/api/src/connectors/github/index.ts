import { registerConnector, type KnowledgeItemInput } from '../registry';
import { getToken } from '../../trust/broker';
import { getMcpServer } from '../../mcp/registry';
import { mcpCallTool } from '../../mcp/client';
import { getGithubRepos } from '../routing';

/**
 * GitHub connector — adapter over the official GitHub remote MCP. Each `sync` pulls the
 * issues + PRs the user is INVOLVED in (authored / assigned / mentioned / review), most
 * recently updated first, and maps them to knowledge_item. This keeps the brain current
 * on active work (the relevant slice) without deep-backfilling 100+ repos. Authed by the
 * broker token; bounded (2 search calls × perPage per tick). The cross-source association
 * engine (brain_edge) later links these to meetings + Jira.
 */

const PER_PAGE = 30;

function parseText(r: any): any {
  const t = r?.content?.[0]?.text;
  if (typeof t !== 'string') return null;
  try { return JSON.parse(t); } catch { return null; }
}

/** Pull owner/repo/number/kind from a GitHub issue/PR html_url. */
function locFromUrl(htmlUrl: unknown): { owner: string; repo: string; number: number; isPr: boolean } | null {
  const m = String(htmlUrl || '').match(/github\.com\/([^/]+)\/([^/]+)\/(issues|pull)\/(\d+)/);
  return m ? { owner: m[1], repo: m[2], isPr: m[3] === 'pull', number: Number(m[4]) } : null;
}

registerConnector({
  id: 'github',
  async sync(userId, scope, cursor) {
    const server = getMcpServer('github');
    const cred = await getToken(userId, 'github', scope);   // scope = workspace_id
    const token = (cred?.token as any)?.access_token;
    if (!server?.url || !token) return { items: [], nextCursor: null };

    const items: KnowledgeItemInput[] = [];
    let maxUpdated = cursor || '';
    // PROJECT MAPPING: if the workspace is mapped to specific repos, scope the search to
    // THOSE repos only (so the workspace's brain holds just its project). Otherwise fall
    // back to everything the user is involved in.
    const repos = await getGithubRepos(userId, scope).catch(() => []);
    const repoQual = repos.length ? repos.map((r) => `repo:${r}`).join(' ') + ' ' : '';
    // search_issues / search_pull_requests share the GitHub search shape; involves:@me
    // covers authored + assigned + mentioned + review-requested.
    for (const [tool, isPrTool] of [['search_issues', false], ['search_pull_requests', true]] as const) {
      try {
        const r = await mcpCallTool(server, token, tool, {
          query: `${repoQual}involves:@me`, sort: 'updated', order: 'desc', perPage: PER_PAGE,
        });
        const parsed = parseText(r);
        const arr: any[] = Array.isArray(parsed?.items) ? parsed.items : Array.isArray(parsed) ? parsed : [];
        for (const it of arr) {
          const loc = locFromUrl(it.html_url);
          const owner = loc?.owner; const repo = loc?.repo; const number = it.number ?? loc?.number;
          if (!owner || !repo || !number) continue;
          const type = (isPrTool || it.pull_request) ? 'pull_request' : 'issue';
          const labels = Array.isArray(it.labels) ? it.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
          const body = [
            it.body, it.state ? `State: ${it.state}` : '',
            labels.length ? `Labels: ${labels.join(', ')}` : '',
          ].filter(Boolean).join('\n');
          items.push({
            source: 'github',
            source_id: `${owner}/${repo}#${number}`,
            type,
            title: `${repo}#${number}: ${it.title || ''}`.trim(),
            body,
            people: { author: it.user?.login ?? null, assignees: (it.assignees || []).map((a: any) => a?.login).filter(Boolean) },
            links: { url: it.html_url },
            raw: it,
            occurred_at: it.updated_at || it.created_at || null,
          });
          if (it.updated_at && it.updated_at > maxUpdated) maxUpdated = it.updated_at;
        }
      } catch (e: any) {
        console.error('github_sync_failed', JSON.stringify({ tool, message: e?.message }));
      }
    }
    console.log('github_sync', JSON.stringify({ count: items.length, nextCursor: maxUpdated || null }));
    return { items, nextCursor: maxUpdated || cursor || null };
  },
});
