import { query, queryOne } from '../db';
import { resolveMcpConnection } from './connection';
import { mcpListTools } from './client';

/**
 * TOOL PLANE — the connector-agnostic governance layer (the "trust plane" done generally,
 * modelled on how Claude Code handles MCP connectors).
 *
 * Two decoupled concerns, mirroring the reference architecture:
 *   1. CATALOG  — DYNAMICALLY discover every tool an MCP server exposes (`tools/list`) and
 *                 CLASSIFY each from its MCP annotations (readOnlyHint / destructiveHint /
 *                 openWorldHint). "What tools exist" — per (workspace, connector). No hardcoding.
 *   2. POLICY   — a per-tool permission rule (allow | ask | deny). "What's allowed." Decoupled
 *                 from the catalog so adding a connector instantly exposes its tools under one
 *                 uniform governance, zero bespoke code.
 *
 * Every action the orchestration agent wants to take resolves through `resolvePermission()`:
 *   allow → execute now · ask → human-in-the-loop card · deny → blocked.
 * Default behaviour by class: read → allow, write → ask, destructive → deny (safe-by-default;
 * the user overrides per-tool in the connector UI).
 */

export type ToolClass = 'read' | 'write' | 'destructive';
export type Behavior = 'allow' | 'ask' | 'deny';

let schemaP: Promise<void> | null = null;
export function ensureToolPlaneSchema(): Promise<void> {
  if (!schemaP) schemaP = (async () => {
    await query(`
      CREATE TABLE IF NOT EXISTS connector_tool (
        user_id      UUID NOT NULL,
        workspace_id UUID NOT NULL,
        connector    TEXT NOT NULL,
        tool_name    TEXT NOT NULL,
        description  TEXT,
        input_schema JSONB,
        read_only    BOOLEAN NOT NULL DEFAULT FALSE,
        destructive  BOOLEAN NOT NULL DEFAULT FALSE,
        open_world   BOOLEAN NOT NULL DEFAULT FALSE,
        klass        TEXT NOT NULL DEFAULT 'write',
        annotations  JSONB,
        discovered_at TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, workspace_id, connector, tool_name)
      )`);
    await query(`CREATE INDEX IF NOT EXISTS connector_tool_ws_idx ON connector_tool (user_id, workspace_id, connector)`);
    await query(`
      CREATE TABLE IF NOT EXISTS tool_permission (
        user_id      UUID NOT NULL,
        workspace_id UUID NOT NULL,
        connector    TEXT NOT NULL,
        tool_name    TEXT NOT NULL,          -- '*' = connector-wide default
        behavior     TEXT NOT NULL,          -- allow | ask | deny
        source       TEXT NOT NULL DEFAULT 'user',
        updated_at   TIMESTAMPTZ DEFAULT NOW(),
        PRIMARY KEY (user_id, workspace_id, connector, tool_name)
      )`);
  })().then(() => {}).catch((e) => { schemaP = null; throw e; });
  return schemaP;
}

/** Classify a raw MCP tool from its annotations (the same hints Claude reads). */
export function classifyTool(t: any): { klass: ToolClass; readOnly: boolean; destructive: boolean; openWorld: boolean } {
  const a = t?.annotations || {};
  const readOnly = a.readOnlyHint === true;
  const destructive = a.destructiveHint === true;
  const openWorld = a.openWorldHint === true;
  // destructive dominates; else read-only → read; else it writes.
  const klass: ToolClass = destructive ? 'destructive' : readOnly ? 'read' : 'write';
  return { klass, readOnly, destructive, openWorld };
}

/** The safe default behaviour for a class (before any user rule). */
export function defaultBehavior(klass: ToolClass): Behavior {
  return klass === 'read' ? 'allow' : klass === 'destructive' ? 'deny' : 'ask';
}

export interface DiscoverResult { connector: string; discovered: number; error?: string }

/** Discover + classify + upsert one connector's tools for a workspace. Idempotent. */
export async function discoverConnectorTools(userId: string, workspaceId: string, connector: string): Promise<DiscoverResult> {
  await ensureToolPlaneSchema();
  // DIRECT-REST connectors (Google) have no MCP `tools/list` — populate their STATIC catalog so the
  // Tools/Permissions UI shows them the moment the user connects (and the agent can call them).
  try {
    const { isGoogleConnector, GOOGLE_TOOLS } = await import('../connectors/google/tools');
    if (isGoogleConnector(connector)) {
      const catalog = GOOGLE_TOOLS[connector] || [];
      const names = catalog.map((t) => t.name);
      // Prune tools no longer in the catalog (e.g. an older/renamed Google tool) so the UI stays clean.
      if (names.length) {
        await query(`DELETE FROM connector_tool WHERE user_id=$1 AND workspace_id=$2 AND connector=$3 AND tool_name <> ALL($4::text[])`,
          [userId, workspaceId, connector, names]).catch(() => {});
      }
      let n = 0;
      for (const t of catalog) {
        const readOnly = t.klass === 'read';
        const destructive = t.klass === 'destructive';
        await query(
          `INSERT INTO connector_tool (user_id, workspace_id, connector, tool_name, description, input_schema, read_only, destructive, open_world, klass, annotations, discovered_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,FALSE,$9,NULL, NOW())
           ON CONFLICT (user_id, workspace_id, connector, tool_name) DO UPDATE SET
             description=EXCLUDED.description, input_schema=EXCLUDED.input_schema, read_only=EXCLUDED.read_only,
             destructive=EXCLUDED.destructive, klass=EXCLUDED.klass, discovered_at=NOW()`,
          [userId, workspaceId, connector, t.name, t.description, JSON.stringify(t.inputSchema), readOnly, destructive, t.klass],
        ).catch(() => {});
        n++;
      }
      return { connector, discovered: n };
    }
  } catch { /* fall through to the MCP path */ }
  const conn = await resolveMcpConnection(userId, workspaceId, connector).catch(() => null);
  if (!conn?.server?.url || !conn.token) {
    console.error('tool_discover_no_conn', JSON.stringify({ connector, hasServer: !!conn?.server?.url, hasToken: !!conn?.token }));
    return { connector, discovered: 0, error: 'not connected' };
  }
  let tools: any[];
  try { tools = await mcpListTools(conn.server, conn.token); }
  catch (e: any) {
    console.error('tool_discover_list_failed', JSON.stringify({ connector, url: conn.server.url, message: String(e?.message || e).slice(0, 300) }));
    return { connector, discovered: 0, error: String(e?.message || e).slice(0, 160) };
  }

  let n = 0;
  for (const t of tools || []) {
    const name = String(t?.name || '').trim();
    if (!name) continue;
    const c = classifyTool(t);
    await query(
      `INSERT INTO connector_tool (user_id, workspace_id, connector, tool_name, description, input_schema, read_only, destructive, open_world, klass, annotations, discovered_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, NOW())
       ON CONFLICT (user_id, workspace_id, connector, tool_name) DO UPDATE SET
         description=EXCLUDED.description, input_schema=EXCLUDED.input_schema, read_only=EXCLUDED.read_only,
         destructive=EXCLUDED.destructive, open_world=EXCLUDED.open_world, klass=EXCLUDED.klass,
         annotations=EXCLUDED.annotations, discovered_at=NOW()`,
      [userId, workspaceId, connector, name, t?.description ?? null, JSON.stringify(t?.inputSchema ?? null),
       c.readOnly, c.destructive, c.openWorld, c.klass, JSON.stringify(t?.annotations ?? null)],
    ).catch(() => {});
    n++;
  }
  return { connector, discovered: n };
}

/** Sweep: discover tools for every connected (workspace, connector). Bounded. */
export async function discoverAllConnectorTools(cap = 25): Promise<{ pairs: number; tools: number }> {
  await ensureToolPlaneSchema();
  const creds = await query<{ user_id: string; workspace_id: string; source: string }>(
    `SELECT user_id, workspace_id, source FROM connector_credentials ORDER BY updated_at DESC LIMIT $1`, [cap],
  ).catch(() => []);
  let tools = 0;
  for (const c of creds) {
    const r = await discoverConnectorTools(c.user_id, c.workspace_id, c.source).catch(() => null);
    if (r) tools += r.discovered;
  }
  return { pairs: creds.length, tools };
}

export interface ToolRow {
  connector: string; tool_name: string; description: string | null;
  klass: ToolClass; read_only: boolean; destructive: boolean; behavior: Behavior;
}

/** The catalog for a connector, each tool's RESOLVED behaviour (rule → default). For the UI. */
export async function listConnectorTools(userId: string, workspaceId: string, connector: string): Promise<ToolRow[]> {
  await ensureToolPlaneSchema();
  return await query<ToolRow>(
    `SELECT t.connector, t.tool_name, t.description, t.klass, t.read_only, t.destructive,
            COALESCE(p.behavior, pw.behavior,
                     CASE t.klass WHEN 'read' THEN 'allow' WHEN 'destructive' THEN 'deny' ELSE 'ask' END) AS behavior
       FROM connector_tool t
       LEFT JOIN tool_permission p  ON p.user_id=t.user_id AND p.workspace_id=t.workspace_id AND p.connector=t.connector AND p.tool_name=t.tool_name
       LEFT JOIN tool_permission pw ON pw.user_id=t.user_id AND pw.workspace_id=t.workspace_id AND pw.connector=t.connector AND pw.tool_name='*'
      WHERE t.user_id=$1 AND t.workspace_id=$2 AND t.connector=$3
      ORDER BY t.klass, t.tool_name`,
    [userId, workspaceId, connector],
  ).catch(() => []);
}

/**
 * Resolve the behaviour for one tool call: exact per-tool rule → connector-wide default rule
 * ('*') → safe default by class. (Single rule per scope; a deny rule always wins by being the
 * most-specific the user set. This is the one chokepoint every agent action crosses.)
 */
export async function resolvePermission(userId: string, workspaceId: string, connector: string, toolName: string): Promise<{ behavior: Behavior; klass: ToolClass | null; source: 'tool' | 'connector' | 'default' }> {
  await ensureToolPlaneSchema();
  const row = await queryOne<{ exact: string | null; wild: string | null; klass: ToolClass | null }>(
    `SELECT
       (SELECT behavior FROM tool_permission WHERE user_id=$1 AND workspace_id=$2 AND connector=$3 AND tool_name=$4) AS exact,
       (SELECT behavior FROM tool_permission WHERE user_id=$1 AND workspace_id=$2 AND connector=$3 AND tool_name='*') AS wild,
       (SELECT klass    FROM connector_tool  WHERE user_id=$1 AND workspace_id=$2 AND connector=$3 AND tool_name=$4) AS klass`,
    [userId, workspaceId, connector, toolName],
  ).catch(() => null);
  if (row?.exact) return { behavior: row.exact as Behavior, klass: row.klass, source: 'tool' };
  if (row?.wild) return { behavior: row.wild as Behavior, klass: row.klass, source: 'connector' };
  const klass = (row?.klass as ToolClass) || 'write';   // unknown tool → treat as write (ask)
  return { behavior: defaultBehavior(klass), klass: row?.klass ?? null, source: 'default' };
}

/** Set (or clear, with behavior=null) a per-tool or connector-wide ('*') permission rule. */
export async function setToolPermission(userId: string, workspaceId: string, connector: string, toolName: string, behavior: Behavior | null): Promise<void> {
  await ensureToolPlaneSchema();
  if (!behavior) {
    await query(`DELETE FROM tool_permission WHERE user_id=$1 AND workspace_id=$2 AND connector=$3 AND tool_name=$4`,
      [userId, workspaceId, connector, toolName]).catch(() => {});
    return;
  }
  await query(
    `INSERT INTO tool_permission (user_id, workspace_id, connector, tool_name, behavior, source, updated_at)
     VALUES ($1,$2,$3,$4,$5,'user',NOW())
     ON CONFLICT (user_id, workspace_id, connector, tool_name) DO UPDATE SET behavior=EXCLUDED.behavior, updated_at=NOW()`,
    [userId, workspaceId, connector, toolName, behavior],
  ).catch(() => {});
}
