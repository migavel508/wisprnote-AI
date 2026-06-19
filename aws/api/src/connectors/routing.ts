import { query, queryOne } from '../db';

/**
 * Adaptive routing map: (user, workspace, FOLDER, source) → target Jira project / GitHub
 * repos. The brain doesn't impose a shape — it learns how a company organizes itself:
 *  - auto-SUGGEST a project by fuzzy-matching the workspace name to visible Jira projects,
 *  - REMEMBER the choice once a human approves a create against a project (confirmed),
 *  - reuse the confirmed mapping thereafter.
 *
 * FOLDER-LEVEL scoping (folder = a project inside a workspace; see
 * docs/FOLDER_SCOPED_CONNECTORS.md): each folder maps to its OWN Jira project + repos.
 * `folder_id = WS_DEFAULT` is the workspace-wide default / "unfiled" bucket. Reads resolve
 * folder → workspace-default fallback, so callers that don't pass a folder behave exactly
 * as before (everything lives under WS_DEFAULT until folders are mapped).
 */

/** Sentinel folder_id meaning "no specific folder — the workspace-wide default mapping". */
export const WS_DEFAULT = '00000000-0000-0000-0000-000000000000';

let ready: Promise<void> | null = null;

export function ensureRoutingSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS connector_routing (
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          folder_id UUID NOT NULL DEFAULT '${WS_DEFAULT}',
          source TEXT NOT NULL DEFAULT 'jira',
          project_key TEXT,                 -- jira: project key; null for repo-mapped sources
          repos TEXT[],                     -- github: mapped repos (owner/name)
          confirmed BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, workspace_id, folder_id, source)
        )
      `);
      // Migrate older installs (project_key NOT NULL + no repos column).
      await query(`ALTER TABLE connector_routing ALTER COLUMN project_key DROP NOT NULL`).catch(() => {});
      await query(`ALTER TABLE connector_routing ADD COLUMN IF NOT EXISTS repos TEXT[]`).catch(() => {});
      // Add folder_id (existing rows backfill to WS_DEFAULT = workspace-wide mapping).
      await query(`ALTER TABLE connector_routing ADD COLUMN IF NOT EXISTS folder_id UUID NOT NULL DEFAULT '${WS_DEFAULT}'`).catch(() => {});
      // Re-key the PK to include folder_id if it's still the old 3-column key.
      await query(`DO $$
        DECLARE c text;
        BEGIN
          IF NOT EXISTS (
            SELECT 1 FROM information_schema.key_column_usage
             WHERE table_name='connector_routing' AND column_name='folder_id' AND constraint_name LIKE '%pkey%'
          ) THEN
            FOR c IN SELECT conname FROM pg_constraint WHERE conrelid='connector_routing'::regclass AND contype='p' LOOP
              EXECUTE 'ALTER TABLE connector_routing DROP CONSTRAINT ' || quote_ident(c);
            END LOOP;
            ALTER TABLE connector_routing ADD PRIMARY KEY (user_id, workspace_id, folder_id, source);
          END IF;
        END $$;`).catch((e) => { console.error('connector_routing_rekey_failed', JSON.stringify({ message: (e as any)?.message })); });
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Read the routing row for a source, resolving folder → workspace-default fallback.
 *  A folder mapping (if it exists) wins; otherwise the workspace-wide default applies. */
async function readRoute(userId: string, workspaceId: string, source: string, folderId?: string | null): Promise<{ project_key: string | null; repos: string[] | null } | null> {
  await ensureRoutingSchema();
  const fid = folderId && folderId !== WS_DEFAULT ? folderId : null;
  if (fid) {
    const f = await queryOne<{ project_key: string | null; repos: string[] | null }>(
      `SELECT project_key, repos FROM connector_routing WHERE user_id=$1 AND workspace_id=$2 AND folder_id=$3 AND source=$4`,
      [userId, workspaceId, fid, source],
    );
    if (f) return f;   // folder has an explicit mapping → use it
  }
  return queryOne<{ project_key: string | null; repos: string[] | null }>(
    `SELECT project_key, repos FROM connector_routing WHERE user_id=$1 AND workspace_id=$2 AND folder_id=$3 AND source=$4`,
    [userId, workspaceId, WS_DEFAULT, source],
  );
}

/** The confirmed/remembered Jira project for this folder (→ workspace-default fallback). */
export async function getRoute(userId: string, workspaceId: string, source = 'jira', folderId?: string | null): Promise<string | null> {
  const r = await readRoute(userId, workspaceId, source, folderId);
  return r?.project_key ?? null;
}

/** The full project mapping for a folder (→ workspace-default fallback): Jira project + repos. */
export async function getMapping(userId: string, workspaceId: string, folderId?: string | null): Promise<{ jiraProject: string | null; githubRepos: string[] }> {
  const jira = await readRoute(userId, workspaceId, 'jira', folderId);
  const gh = await readRoute(userId, workspaceId, 'github', folderId);
  return { jiraProject: jira?.project_key ?? null, githubRepos: gh?.repos ?? [] };
}

/** The GitHub repos this folder is scoped to (→ workspace-default fallback; empty = all). */
export async function getGithubRepos(userId: string, workspaceId: string, folderId?: string | null): Promise<string[]> {
  const r = await readRoute(userId, workspaceId, 'github', folderId);
  return r?.repos ?? [];
}

/** Set the GitHub repo mapping (owner/name list) for a folder (or the workspace default). */
export async function setGithubRepos(userId: string, workspaceId: string, repos: string[], folderId?: string | null): Promise<void> {
  await ensureRoutingSchema();
  const fid = folderId || WS_DEFAULT;
  await query(
    `INSERT INTO connector_routing (user_id, workspace_id, folder_id, source, repos, confirmed)
     VALUES ($1,$2,$3,'github',$4,TRUE)
     ON CONFLICT (user_id, workspace_id, folder_id, source) DO UPDATE SET repos=EXCLUDED.repos, confirmed=TRUE, updated_at=NOW()`,
    [userId, workspaceId, fid, repos],
  );
}

/** Remember a Jira project for a folder (learned when the user approves a create). */
export async function rememberRoute(userId: string, workspaceId: string, projectKey: string, source = 'jira', confirmed = true, folderId?: string | null): Promise<void> {
  if (!projectKey) return;
  await ensureRoutingSchema();
  const fid = folderId || WS_DEFAULT;
  await query(
    `INSERT INTO connector_routing (user_id, workspace_id, folder_id, source, project_key, confirmed)
     VALUES ($1,$2,$3,$4,$5,$6)
     ON CONFLICT (user_id, workspace_id, folder_id, source) DO UPDATE SET
       project_key=EXCLUDED.project_key, confirmed=connector_routing.confirmed OR EXCLUDED.confirmed, updated_at=NOW()`,
    [userId, workspaceId, fid, source, projectKey, confirmed],
  );
}

/** All explicit folder mappings for a workspace (for the aggregate view + sync iteration). */
export async function listFolderMappings(userId: string, workspaceId: string): Promise<Array<{ folderId: string; source: string; projectKey: string | null; repos: string[] }>> {
  await ensureRoutingSchema();
  const rows = await query<{ folder_id: string; source: string; project_key: string | null; repos: string[] | null }>(
    `SELECT folder_id, source, project_key, repos FROM connector_routing WHERE user_id=$1 AND workspace_id=$2`,
    [userId, workspaceId],
  ).catch(() => []);
  return rows.map((r) => ({ folderId: r.folder_id, source: r.source, projectKey: r.project_key ?? null, repos: r.repos ?? [] }));
}

/** Every GitHub repo mapped anywhere in the workspace (all folders + the default), deduped —
 *  so the sync pulls each project's repos, not just the workspace-default ones. */
export async function getAllMappedRepos(userId: string, workspaceId: string): Promise<string[]> {
  const maps = await listFolderMappings(userId, workspaceId);
  const set = new Set<string>();
  for (const m of maps) if (m.source === 'github') for (const r of m.repos) if (r) set.add(r);
  return [...set];
}

/** Build a resolver: given an item's (source, source_id), return the FOLDER it belongs to — a
 *  Jira issue's project key → the folder that maps it; a GitHub repo → the folder that maps it.
 *  null = not mapped to any specific folder (unfiled / workspace-wide). The mapping is
 *  deterministic, so this is the single source of truth for both live tagging and backfill. */
export async function folderResolverFor(userId: string, workspaceId: string): Promise<(source: string, sourceId: string) => string | null> {
  const maps = await listFolderMappings(userId, workspaceId);
  const projToFolder = new Map<string, string>();
  const repoToFolder = new Map<string, string>();
  for (const m of maps) {
    if (m.folderId === WS_DEFAULT) continue; // only REAL folders tag items; default = unfiled
    if (m.source === 'jira' && m.projectKey) projToFolder.set(m.projectKey.toUpperCase(), m.folderId);
    if (m.source === 'github') for (const r of m.repos) if (r) repoToFolder.set(r.toLowerCase(), m.folderId);
  }
  return (source: string, sourceId: string): string | null => {
    const id = String(sourceId || '');
    if (source === 'jira') {
      const mm = id.match(/^([A-Za-z][A-Za-z0-9]+)-\d+/);   // "SCRUM-12" → "SCRUM"
      return mm ? projToFolder.get(mm[1].toUpperCase()) ?? null : null;
    }
    if (source === 'github') {
      const mm = id.match(/^([^/]+\/[^@#]+)[@#]/);            // "owner/repo#1" | "owner/repo@sha" → "owner/repo"
      return mm ? repoToFolder.get(mm[1].toLowerCase()) ?? null : null;
    }
    return null;
  };
}

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Best-effort project suggestion: fuzzy-match a workspace name to visible projects. */
export function suggestProject(
  projects: Array<{ key: string; name: string }>,
  workspaceName: string | null | undefined,
): string | null {
  if (!projects.length) return null;
  if (projects.length === 1) return projects[0].key;
  const w = norm(workspaceName || '');
  if (w) {
    const tokens = w.split(' ').filter(Boolean);
    let best: { key: string; score: number } | null = null;
    for (const p of projects) {
      const hay = `${norm(p.name)} ${norm(p.key)}`;
      let score = 0;
      if (norm(p.name) === w || norm(p.key) === w) score += 100;
      for (const t of tokens) if (t.length > 2 && hay.includes(t)) score += 10;
      if (hay.includes(w)) score += 20;
      if (!best || score > best.score) best = { key: p.key, score };
    }
    if (best && best.score > 0) return best.key;
  }
  return projects[0].key; // deterministic fallback
}

/** Resolve the project for a workspace: confirmed route → suggestion → first project. */
export async function resolveProjectKey(
  userId: string, workspaceId: string,
  projects: Array<{ key: string; name: string }>,
  workspaceName?: string | null,
  folderId?: string | null,
): Promise<string | null> {
  const saved = await getRoute(userId, workspaceId, 'jira', folderId);
  if (saved && projects.some((p) => p.key === saved)) return saved;
  return suggestProject(projects, workspaceName);
}
