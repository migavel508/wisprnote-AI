import { query } from '../db';
import { ensureToolPlaneSchema, type ToolClass, type Behavior } from '../mcp/toolPlane';
import type { AgentToolDef } from './agentTurn';

/**
 * AGENT TOOLSET — assembles the tool list the agentic loop exposes to the model (Phase 1).
 *
 * Mirrors Claude Code's tool exposure (studied in /Users/migavelaishwin/Downloads/src):
 *   • MCP connector tools are namespaced `mcp__<connector>__<tool>` (buildMcpToolName) so a
 *     returned tool call routes unambiguously back to (connector, toolName) — no registry needed
 *     at exec time, the name is self-describing.
 *   • Built-in (app-native) tools and MCP tools coexist in ONE list; built-ins go first for
 *     prompt-cache stability (the reference does the same).
 *   • TWO-STAGE permission: tools whose RESOLVED behaviour is `deny` are filtered OUT here, before
 *     the model ever sees them (the reference's pre-API deny filter, `filterToolsByDenyRules`).
 *     `allow`/`ask` tools ARE exposed; `ask` is gated at EXECUTION (the HITL card) in Phase 4 —
 *     not by hiding the tool. This matches the reference exactly.
 *   • Descriptions capped at 2048 chars (MAX_MCP_DESCRIPTION_LENGTH).
 *
 * The toolset + its routing metadata are built server-side per turn, where the catalog
 * (connector_tool) and the permission rules (tool_permission) live. The client never sees the
 * raw catalog — it just drives the loop.
 */

const MAX_DESC = 2048;

export type ToolMeta =
  | { kind: 'builtin'; name: string; behavior: Behavior; klass: ToolClass }
  | { kind: 'mcp'; name: string; connector: string; toolName: string; behavior: Behavior; klass: ToolClass };

export interface AgentToolset { tools: AgentToolDef[]; registry: Map<string, ToolMeta> }

/** `mcp__<connector>__<tool>` — the reference's namespacing scheme. */
export function buildMcpToolName(connector: string, tool: string): string { return `mcp__${connector}__${tool}`; }

/** Inverse of buildMcpToolName: `mcp__<connector>__<tool>` → { connector, toolName }. */
export function parseMcpToolName(name: string): { connector: string; toolName: string } | null {
  if (!name || !name.startsWith('mcp__')) return null;
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  if (i < 0) return null;
  return { connector: rest.slice(0, i), toolName: rest.slice(i + 2) };
}

// ── Built-in, app-native tools (NOT MCP). Read-only / allow. Executors wired in Phase 2. ──
export const BRAIN_SEARCH: AgentToolDef = {
  name: 'brain_search',
  description:
    "Search the user's connected brain — meetings, Jira issues, GitHub activity, local code sessions, " +
    'and the decisions/action-items extracted from them — for context relevant to a query. Returns ranked ' +
    'snippets with citations. Call this to ground an answer or an action in the user\'s actual work before responding. ' +
    'NOTE: for questions about work STATUS — what is off-track / slipping / stalled / open / untracked — use ' +
    'brain_threads instead: status is DERIVED STATE held by the brain, not text, so searching for it finds nothing.',
  inputSchema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Natural-language search query.' },
      limit: { type: 'number', description: 'Max results to return (default 8).' },
    },
    required: ['query'],
  },
};

// The brain's WORK-STATE ledger (thread ledger, Brain P3). This is how the agent answers
// "what's off-track?" — that state is DERIVED (status + linked code + recency), not text,
// so brain_search can never find it.
export const BRAIN_THREADS: AgentToolDef = {
  name: 'brain_threads',
  description:
    "The brain's work-state LEDGER: every piece of work as an open loop with a derived state — " +
    "'stale' (OFF-TRACK/slipping: no movement in over a week, or a meeting whose commitments were never " +
    "ticketed), 'open' (not started), 'advancing' (moving / has commits), 'resolved' (done). Each thread " +
    'carries its evidence (Jira status, linked commits, source meetings). USE THIS for any question about ' +
    "work status: what's off-track, slipping, stalled, stuck, open, untracked, or how the project is going.",
  inputSchema: {
    type: 'object',
    properties: {
      state: { type: 'string', enum: ['stale', 'open', 'advancing', 'resolved', 'all'], description: "Filter by state. 'stale' = off-track/slipping (default 'all', ordered most-attention-first)." },
      limit: { type: 'number', description: 'Max threads to return (default 25).' },
    },
  },
};

// The CHIEF-OF-STAFF brief (Brain D-1). A standing, pre-computed executive digest per project —
// what moved, what's slipping, what's untracked, the PM + engineering picture — grounded ONLY in
// confirmed evidence. This is the RIGHT tool for the big open-ended questions ("what's going on?",
// "catch me up", "status of the project") — it returns the whole narrative at once instead of making
// the model reassemble it from raw search hits.
export const BRAIN_BRIEF: AgentToolDef = {
  name: 'brain_brief',
  description:
    "The brain's standing CHIEF-OF-STAFF brief for the user's project(s): a grounded executive digest — " +
    "what happened lately, what MOVED, what's open and SLIPPING, what's untracked, and the PM + engineering " +
    'picture — refreshed continuously from confirmed evidence. USE THIS for open-ended catch-up questions: ' +
    '"what\'s going on", "catch me up", "give me a status", "what needs attention". Returns one brief per ' +
    'project (most-attention-first). Numbers are CONFIRMED facts; state them as-is and do not inflate them.',
  inputSchema: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Optional: narrow to one project/space by name (case-insensitive substring). Omit for all projects.' },
    },
  },
};

// The STORY of one work item (Brain D-6). Traces a ticket/meeting/commit through the brain's edges —
// what spawned it, what implements it (with the alignment verdict), what it's connected to — grounded
// in CONFIRMED lineage, with possible links clearly separated.
export const BRAIN_LINEAGE: AgentToolDef = {
  name: 'brain_lineage',
  description:
    "The full STORY of one work item — trace a ticket, meeting, or commit through the brain: the meeting " +
    'that spawned it, the commits that implement it (with the alignment verdict), what it connects to, and ' +
    "its current work-state. USE THIS for 'what's the story/history/context of X', 'how did X come about', " +
    "'what's connected to X', 'trace X'. Confirmed lineage is fact; 'possibly related' is unverified — never " +
    'state it as fact. Give a ticket key (e.g. SCRUM-14), a meeting title, or an item name.',
  inputSchema: {
    type: 'object',
    properties: {
      anchor: { type: 'string', description: 'A ticket key (e.g. SCRUM-14), meeting title, or item name to trace.' },
    },
    required: ['anchor'],
  },
};

// Plan tool — mirrors Claude Code's TodoWriteTool (content imperative + activeForm present-continuous
// + status; replace the WHOLE list each call; exactly one in_progress). Makes the agent's multi-step
// work legible in chat before it acts. No external effect; never gated.
export const TODO_WRITE: AgentToolDef = {
  name: 'todo_write',
  description:
    'Update the todo list for the current task. Use it proactively and often to plan and track ' +
    'multi-step work — especially before taking actions that change a connected tool. Replace the ' +
    'WHOLE list each call. Keep exactly ONE task in_progress at a time, and mark a task completed ' +
    'immediately when it is done. Always provide both content (imperative, e.g. "Create the Jira ' +
    'ticket") and activeForm (present continuous, e.g. "Creating the Jira ticket").',
  inputSchema: {
    type: 'object',
    properties: {
      todos: {
        type: 'array',
        description: 'The full updated todo list (replaces the previous list).',
        items: {
          type: 'object',
          properties: {
            content: { type: 'string', description: 'Imperative form of the task.' },
            activeForm: { type: 'string', description: 'Present-continuous form shown while the task is in_progress.' },
            status: { type: 'string', enum: ['pending', 'in_progress', 'completed'] },
          },
          required: ['content', 'status'],
        },
      },
    },
    required: ['todos'],
  },
};

export const BUILTIN_TOOLS: AgentToolDef[] = [BRAIN_SEARCH, BRAIN_THREADS, BRAIN_BRIEF, BRAIN_LINEAGE, TODO_WRITE];

/**
 * Assemble the full toolset for (user, workspace): built-ins first, then every connected
 * connector's discovered tools whose resolved behaviour ≠ deny, namespaced + capped.
 * Returns the model-facing defs AND a name→metadata registry for routing/gating.
 */
export async function buildAgentToolset(
  userId: string,
  workspaceId: string,
  opts?: { connectorTools?: boolean },
): Promise<AgentToolset> {
  await ensureToolPlaneSchema();
  const registry = new Map<string, ToolMeta>();
  const tools: AgentToolDef[] = [];

  // Built-ins first (stable ordering for prompt caching, per the reference).
  for (const t of BUILTIN_TOOLS) {
    tools.push(t);
    registry.set(t.name, { kind: 'builtin', name: t.name, behavior: 'allow', klass: 'read' });
  }

  if (opts?.connectorTools !== false && workspaceId) {
    // Resolve behaviour the same way listConnectorTools/resolvePermission do:
    // exact per-tool rule → connector-wide '*' rule → safe default by class.
    const rows = await query<{ connector: string; tool_name: string; description: string | null; input_schema: any; klass: ToolClass; behavior: Behavior }>(
      `SELECT t.connector, t.tool_name, t.description, t.input_schema, t.klass,
              COALESCE(p.behavior, pw.behavior,
                       CASE t.klass WHEN 'read' THEN 'allow' WHEN 'destructive' THEN 'deny' ELSE 'ask' END) AS behavior
         FROM connector_tool t
         LEFT JOIN tool_permission p  ON p.user_id=t.user_id AND p.workspace_id=t.workspace_id AND p.connector=t.connector AND p.tool_name=t.tool_name
         LEFT JOIN tool_permission pw ON pw.user_id=t.user_id AND pw.workspace_id=t.workspace_id AND pw.connector=t.connector AND pw.tool_name='*'
        WHERE t.user_id=$1 AND t.workspace_id=$2
        ORDER BY t.connector, t.klass, t.tool_name`,
      [userId, workspaceId],
    ).catch(() => [] as any[]);

    for (const r of rows) {
      if (r.behavior === 'deny') continue;                 // PRE-API deny filter — model never sees it
      const name = buildMcpToolName(r.connector, r.tool_name);
      const schema = r.input_schema && typeof r.input_schema === 'object' ? r.input_schema : { type: 'object', properties: {} };
      let desc = r.description || `${r.tool_name} — ${r.connector} tool`;
      if (desc.length > MAX_DESC) desc = desc.slice(0, MAX_DESC) + '… [truncated]';
      tools.push({ name, description: desc, inputSchema: schema });
      registry.set(name, { kind: 'mcp', name, connector: r.connector, toolName: r.tool_name, behavior: r.behavior, klass: r.klass });
    }
  }

  return { tools, registry };
}
