import { registerConnector, type KnowledgeItemInput } from '../registry';
import { getToken } from '../../trust/broker';
import { getMcpServer } from '../../mcp/registry';
import { mcpCallTool } from '../../mcp/client';
import { getAllMappedRepos } from '../routing';

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
    // `scope` is the compound "<workspace>:<space>" — the token is per (workspace, space);
    // repo mappings are per workspace. Tolerate a bare workspace (legacy).
    const [workspaceId, spaceId = '00000000-0000-0000-0000-000000000000'] = scope.split(':');
    const cred = await getToken(userId, 'github', workspaceId, spaceId);
    const token = (cred?.token as any)?.access_token;
    if (!server?.url || !token) return { items: [], nextCursor: null };

    const items: KnowledgeItemInput[] = [];
    let maxUpdated = cursor || '';
    // Pull repos mapped across ALL the workspace's folders (each item is folder-tagged at
    // upsert by its repo), so every project's code is ingested — not just the default folder's.
    const repos = await getAllMappedRepos(userId, workspaceId).catch(() => []);

    const pushIssue = (it: any, isPrTool: boolean) => {
      const loc = locFromUrl(it.html_url);
      const owner = loc?.owner; const repo = loc?.repo; const number = it.number ?? loc?.number;
      if (!owner || !repo || !number) return;
      const type = (isPrTool || it.pull_request) ? 'pull_request' : 'issue';
      const labels = Array.isArray(it.labels) ? it.labels.map((l: any) => (typeof l === 'string' ? l : l?.name)).filter(Boolean) : [];
      const body = [it.body, it.state ? `State: ${it.state}` : '', labels.length ? `Labels: ${labels.join(', ')}` : ''].filter(Boolean).join('\n');
      const prState = it.merged_at ? 'merged' : (it.state || null);   // merged | open | closed
      items.push({
        source: 'github', source_id: `${owner}/${repo}#${number}`, type,
        title: `${repo}#${number}: ${it.title || ''}`.trim(), body,
        status: type === 'pull_request' ? prState : (it.state || null),
        actor: it.user?.login ?? null,
        people: { author: it.user?.login ?? null, assignees: (it.assignees || []).map((a: any) => a?.login).filter(Boolean) },
        links: { url: it.html_url }, raw: it, occurred_at: it.updated_at || it.created_at || null,
      });
      if (it.updated_at && it.updated_at > maxUpdated) maxUpdated = it.updated_at;
    };

    if (repos.length) {
      // MAPPED MODE: this workspace IS these repos → ingest each repo's full activity:
      // issues + PRs + recent COMMITS (so code-only repos with no issues still populate).
      for (const full of repos.slice(0, 5)) {
        const [owner, repo] = full.split('/');
        if (!owner || !repo) continue;
        for (const [tool, isPr] of [['search_issues', false], ['search_pull_requests', true]] as const) {
          try {
            const r = await mcpCallTool(server, token, tool, { query: `repo:${full}`, sort: 'updated', order: 'desc', perPage: PER_PAGE });
            const parsed = parseText(r);
            for (const it of (Array.isArray(parsed?.items) ? parsed.items : [])) pushIssue(it, isPr);
          } catch (e: any) { console.error('github_sync_failed', JSON.stringify({ tool, full, message: e?.message })); }
        }
        // COMMITS — from EVERY branch, not just the default. `list_commits` defaults to the default
        // branch, so feature-branch work was invisible. List branches, pull each (bounded), dedup by
        // sha (a commit on multiple branches ingests once).
        let branches: string[] = [''];   // '' → default branch (list_commits with no sha)
        try {
          const rb = await mcpCallTool(server, token, 'list_branches', { owner, repo, perPage: 50 });
          const pb = parseText(rb);
          const names = (Array.isArray(pb) ? pb : Array.isArray(pb?.branches) ? pb.branches : Array.isArray(pb?.items) ? pb.items : [])
            .map((b: any) => b?.name).filter(Boolean);
          if (names.length) branches = names.slice(0, 6);
        } catch { /* list_branches unsupported → default branch only */ }
        const seenSha = new Set<string>();
        for (const branch of branches) {
          try {
            const r = await mcpCallTool(server, token, 'list_commits', { owner, repo, perPage: 30, ...(branch ? { sha: branch } : {}) });
            const parsed = parseText(r);
            const commits: any[] = Array.isArray(parsed) ? parsed : Array.isArray(parsed?.commits) ? parsed.commits : Array.isArray(parsed?.items) ? parsed.items : [];
            for (const c of commits) {
              const sha = (c.sha || c.oid || '').toString().slice(0, 7);
              const msg = (c.commit?.message || c.message || '').toString();
              if (!sha || !msg || seenSha.has(sha)) continue;
              // Tier-0 filter: skip MERGE commits (>1 parent) — they carry no own diff, just noise.
              if (Array.isArray(c.parents) && c.parents.length > 1) continue;
              seenSha.add(sha);
              const when = c.commit?.author?.date || c.commit?.committer?.date || null;
              const author = c.author?.login || c.commit?.author?.name || null;
              items.push({
                source: 'github', source_id: `${full}@${sha}`, type: 'commit',
                title: `${repo}@${sha}: ${msg.split('\n')[0].slice(0, 120)}`,
                body: msg, actor: author, people: { author },
                links: { url: c.html_url || `https://github.com/${full}/commit/${c.sha || sha}` }, raw: c,
                occurred_at: when,
              });
              if (when && when > maxUpdated) maxUpdated = when;
            }
          } catch (e: any) { console.error('github_sync_failed', JSON.stringify({ tool: 'list_commits', full, branch, message: e?.message })); }
        }
      }
    } else {
      // UNMAPPED MODE: everything the user is involved in across all repos (issues + PRs).
      for (const [tool, isPr] of [['search_issues', false], ['search_pull_requests', true]] as const) {
        try {
          const r = await mcpCallTool(server, token, tool, { query: 'involves:@me', sort: 'updated', order: 'desc', perPage: PER_PAGE });
          const parsed = parseText(r);
          for (const it of (Array.isArray(parsed?.items) ? parsed.items : [])) pushIssue(it, isPr);
        } catch (e: any) { console.error('github_sync_failed', JSON.stringify({ tool, message: e?.message })); }
      }
    }
    console.log('github_sync', JSON.stringify({ count: items.length, mapped: repos.length, nextCursor: maxUpdated || null }));
    return { items, nextCursor: maxUpdated || cursor || null };
  },
});
