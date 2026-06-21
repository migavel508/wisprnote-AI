import { resolveMcpConnection } from '../mcp/connection';
import { mcpListTools, mcpCallTool } from '../mcp/client';
import { resolvePermission } from '../mcp/toolPlane';
import { semanticSearchItems } from '../connectors/embed';
import { parseMcpToolName } from './agentTools';

/**
 * AGENT EXEC — runs ONE tool the model requested, for the agentic loop (Phase 2).
 *
 * Two kinds of tool:
 *   • built-in (app-native, e.g. brain_search) — executed directly here.
 *   • MCP connector tool (`mcp__<connector>__<tool>`) — routed by parsing the name, gated by the
 *     SAME trust plane every action crosses (resolvePermission), then called via mcpCallTool. The
 *     gate + connection + cloudId handling mirror executeMcpWrite exactly.
 *
 * PHASE 2 IS READ-ONLY: only read-class tools the user has set to `allow` auto-execute. Anything
 * that can change data (write/destructive, or any tool set to `ask`) is NOT executed — it returns
 * `requiresApproval` so the loop can surface a HITL card. Wiring that card to a real write is Phase 4.
 * `deny` is always blocked. This is the one chokepoint, identical to the rest of the orchestration plane.
 */

export interface AgentExecResult {
  ok: boolean;
  content: string;             // text fed back to the model as the tool_result
  isError?: boolean;
  requiresApproval?: boolean;  // write/ask/destructive — deferred to the Phase 4 HITL card
  behavior?: string;
  klass?: string;
}

export async function executeAgentTool(
  userId: string,
  workspaceId: string,
  toolName: string,
  args: Record<string, unknown>,
  opts: { approved?: boolean } = {},
): Promise<AgentExecResult> {
  // ── Built-in tools ──
  if (toolName === 'todo_write') {
    // Plan tool: validate + echo the list back so the model sees its own plan reflected. The plan
    // STATE for the UI is captured client-side from the tool-call args; here we just confirm + nudge.
    const raw = Array.isArray((args as any)?.todos) ? (args as any).todos : [];
    if (!raw.length) return { ok: false, isError: true, content: 'todo_write requires a non-empty "todos" array.' };
    const norm = raw.map((t: any) => ({
      content: String(t?.content || '').trim(),
      activeForm: t?.activeForm ? String(t.activeForm) : undefined,
      status: ['pending', 'in_progress', 'completed'].includes(t?.status) ? t.status : 'pending',
    })).filter((t: any) => t.content);
    const inProg = norm.filter((t: any) => t.status === 'in_progress');
    const done = norm.filter((t: any) => t.status === 'completed').length;
    const mark = (s: string) => (s === 'completed' ? '[x]' : s === 'in_progress' ? '[~]' : '[ ]');
    const lines = norm.map((t: any) => `${mark(t.status)} ${t.content}`).join('\n');
    const note = inProg.length > 1 ? `\n(Note: ${inProg.length} tasks are in_progress — keep exactly one in_progress.)` : '';
    const now = inProg[0] ? ` Now: ${inProg[0].activeForm || inProg[0].content}.` : '';
    return { ok: true, content: `Plan updated — ${norm.length} task(s), ${done} completed.${now}\n${lines}${note}` };
  }

  if (toolName === 'brain_search') {
    const q = String((args as any)?.query || '').trim();
    const limit = Math.min(Math.max(Number((args as any)?.limit) || 8, 1), 20);
    if (!q) return { ok: false, isError: true, content: 'brain_search requires a non-empty "query".' };
    const rows = await semanticSearchItems(userId, workspaceId, q, limit).catch(() => []);
    if (!rows.length) return { ok: true, content: `No matching items found in the brain for "${q}".` };
    const lines = rows.map((r: any, i: number) => {
      const body = String(r.body || '').replace(/\s+/g, ' ').slice(0, 320);
      const when = r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 10) : '';
      return `[${i + 1}] (${r.source}/${r.type}${when ? `, ${when}` : ''}) ${r.title || '(untitled)'}\n${body}`;
    });
    return { ok: true, content: lines.join('\n\n') };
  }

  // ── MCP connector tools ──
  const parsed = parseMcpToolName(toolName);
  if (!parsed) return { ok: false, isError: true, content: `Unknown tool "${toolName}".` };
  const { connector, toolName: tool } = parsed;

  // TRUST GATE — the one chokepoint. deny → blocked; non-read or non-allow → needs approval (P4).
  const perm = await resolvePermission(userId, workspaceId, connector, tool).catch(() => null);
  if (perm?.behavior === 'deny') {
    return { ok: false, isError: true, content: `Blocked by policy — “${tool}” is set to never run for ${connector}.`, behavior: 'deny', klass: perm?.klass ?? undefined };
  }
  if (perm?.klass !== 'read' || perm?.behavior !== 'allow') {
    if (!opts.approved) {
      // Not yet approved — surface a HITL card. The loop pauses here (Phase 4).
      return { ok: false, requiresApproval: true, behavior: perm?.behavior, klass: perm?.klass ?? undefined,
        content: `“${tool}” can change data in ${connector}, so it needs your approval before it runs.` };
    }
    // Approved via the HITL card → execute through the gated, audited, reversible write executor.
    // executeMcpWrite RE-checks the gate (deny blocks) and refuses deletes/destructive verbs, so
    // even an approved destructive call cannot get through this path.
    const { executeMcpWrite } = await import('../mcp/write');
    const w = await executeMcpWrite(userId, workspaceId, connector, tool, args || {});
    return { ok: w.ok, isError: !w.ok, behavior: perm?.behavior, klass: perm?.klass ?? undefined,
      content: w.ok ? `${w.message}${w.url ? ` (${w.url})` : ''}` : w.message };
  }

  const conn = await resolveMcpConnection(userId, workspaceId, connector);
  if (!conn) return { ok: false, isError: true, content: `${connector} is not connected in this workspace.` };
  const tools = await mcpListTools(conn.server, conn.token).catch(() => []);
  const def = (tools || []).find((t: any) => t.name === tool);
  if (!def) return { ok: false, isError: true, content: `Unknown tool “${tool}” on ${connector}.` };
  const needsCloudId = !!def.inputSchema?.properties?.cloudId && !!conn.cloudId;

  try {
    const r = await mcpCallTool(conn.server, conn.token, tool, { ...(args || {}), ...(needsCloudId ? { cloudId: conn.cloudId } : {}) });
    const text = ((r?.content || []).map((c: any) => c?.text ?? '').join('\n').trim()) || JSON.stringify(r ?? {}).slice(0, 2000);
    if (r?.isError) return { ok: false, isError: true, content: `${connector} returned an error: ${text.slice(0, 500)}`, behavior: 'allow', klass: 'read' };
    return { ok: true, content: text.slice(0, 6000), behavior: 'allow', klass: 'read' };
  } catch (e: any) {
    return { ok: false, isError: true, content: `Failed to run ${tool}: ${String(e?.message || e).slice(0, 300)}` };
  }
}
