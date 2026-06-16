import { query, queryOne } from '../db';

/**
 * Adaptive routing map: (user, workspace, source) → target project key. The brain
 * must not impose a shape — it learns how a company organizes itself:
 *  - auto-SUGGEST a project by fuzzy-matching the workspace name to visible Jira
 *    projects (so the very first proposal is usually right),
 *  - REMEMBER the choice once a human approves a create against a project (confirmed),
 *  - reuse the confirmed mapping thereafter.
 * Workspace-scoped; folder-level routing can extend this later (folder_id column).
 */

let ready: Promise<void> | null = null;

export function ensureRoutingSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS connector_routing (
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          source TEXT NOT NULL DEFAULT 'jira',
          project_key TEXT NOT NULL,
          confirmed BOOLEAN NOT NULL DEFAULT FALSE,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, workspace_id, source)
        )
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** The confirmed/remembered project for this workspace, if any. */
export async function getRoute(userId: string, workspaceId: string, source = 'jira'): Promise<string | null> {
  await ensureRoutingSchema();
  const r = await queryOne<{ project_key: string }>(
    `SELECT project_key FROM connector_routing WHERE user_id=$1 AND workspace_id=$2 AND source=$3`,
    [userId, workspaceId, source],
  );
  return r?.project_key ?? null;
}

/** Remember a project for a workspace (learned when the user approves a create). */
export async function rememberRoute(userId: string, workspaceId: string, projectKey: string, source = 'jira', confirmed = true): Promise<void> {
  if (!projectKey) return;
  await ensureRoutingSchema();
  await query(
    `INSERT INTO connector_routing (user_id, workspace_id, source, project_key, confirmed)
     VALUES ($1,$2,$3,$4,$5)
     ON CONFLICT (user_id, workspace_id, source) DO UPDATE SET
       project_key=EXCLUDED.project_key, confirmed=connector_routing.confirmed OR EXCLUDED.confirmed, updated_at=NOW()`,
    [userId, workspaceId, source, projectKey, confirmed],
  );
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
): Promise<string | null> {
  const saved = await getRoute(userId, workspaceId);
  if (saved && projects.some((p) => p.key === saved)) return saved;
  return suggestProject(projects, workspaceName);
}
