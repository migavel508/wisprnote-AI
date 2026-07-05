import { resolveMcpConnection } from '../mcp/connection';
import { mcpListTools, mcpCallTool, resolveLiveTool } from '../mcp/client';
import { resolvePermission } from '../mcp/toolPlane';
import { semanticSearchItems, expandWithNeighbours } from '../connectors/embed';
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
    let rows = await semanticSearchItems(userId, workspaceId, q, limit).catch(() => []);
    if (!rows.length) return { ok: true, content: `No matching items found in the brain for "${q}".` };
    // Graph-aware: pull each hit's cross-tool neighbours (the meeting→ticket→commit lineage) so the
    // answer sees the connected chain, not isolated snippets (Memory-OS: graph-aware retrieval).
    rows = await expandWithNeighbours(userId, workspaceId, rows).catch(() => rows);
    // Surface the exact ATOM that matched (a specific decision/action/topic) — a far tighter ground
    // than the whole-meeting body (Memory-OS Phase 3 derived units).
    const { query } = await import('../db');
    const unitIds = rows.map((r: any) => r._matchedUnitId).filter(Boolean);
    const unitText = new Map<string, string>();
    if (unitIds.length) {
      const us = await query<any>(`SELECT id, text FROM mem_unit WHERE id = ANY($1)`, [unitIds]).catch(() => []);
      for (const u of us) unitText.set(String(u.id), u.text);
    }
    const seeds = rows.filter((r: any) => !r._linkedVia);
    const lines = seeds.map((r: any, i: number) => {
      const matched = r._matchedUnitId && unitText.get(String(r._matchedUnitId));
      const snippet = matched ? matched.slice(0, 320) : String(r.body || '').replace(/\s+/g, ' ').slice(0, 320);
      const when = r.occurred_at ? new Date(r.occurred_at).toISOString().slice(0, 10) : '';
      const via = r._matched ? ` · matched ${r._matched}` : '';
      const linked = Array.isArray(r._linked) && r._linked.length
        ? `\n    ↳ linked: ${r._linked.slice(0, 4).map((l: any) => `${l.title} (${l.relation})`).join('; ')}`
        : '';
      return `[${i + 1}] (${r.source}/${r.type}${when ? `, ${when}` : ''}${via}) ${r.title || '(untitled)'}\n${snippet}${linked}`;
    });
    return { ok: true, content: lines.join('\n\n') };
  }

  if (toolName === 'brain_threads') {
    // The WORK-STATE ledger (Brain P3) — answers "what's off-track / slipping / open / untracked".
    const stateArg = String((args as any)?.state || 'all');
    const limit = Math.min(Math.max(Number((args as any)?.limit) || 25, 1), 100);
    const { query } = await import('../db');
    // CF-1: DEDUP by anchor across spaces — a leftover cross-space duplicate must not surface a ticket
    // twice. Keep the best-evidenced row per (kind, anchor). CF-5: the counts shown are CONFIRMED
    // evidence only (evidence.commits/meetings are already claim/verdict-derived); semantic guesses are
    // reported separately as "possibly related", never blended into the confirmed count.
    const rows = await query<any>(
      `SELECT * FROM (
         SELECT DISTINCT ON (kind, anchor_source, anchor_source_id)
                kind, anchor_source, anchor_source_id, title, state, last_advanced_at, evidence
           FROM brain_thread WHERE workspace_id=$1 ${stateArg !== 'all' ? 'AND state=$2' : ''}
          ORDER BY kind, anchor_source, anchor_source_id,
                   (COALESCE(jsonb_array_length(evidence->'commits'),0) + COALESCE(jsonb_array_length(evidence->'meetings'),0)) DESC
       ) d
        ORDER BY CASE state WHEN 'stale' THEN 0 WHEN 'open' THEN 1 WHEN 'advancing' THEN 2 ELSE 3 END,
                 last_advanced_at DESC NULLS LAST LIMIT ${limit}`,
      stateArg !== 'all' ? [workspaceId, stateArg] : [workspaceId],
    ).catch(() => []);
    if (!rows.length) return { ok: true, content: stateArg === 'all' ? 'The thread ledger is empty for this workspace (no tracked work yet).' : `No threads in state "${stateArg}".` };
    const label = (s: string, k: string) => (s === 'stale'
      ? (k === 'gap' ? 'OFF-TRACK · UNTRACKED' : k === 'topic' ? 'OPEN LOOP · UNRESOLVED' : 'OFF-TRACK · STALLED')
      : s.toUpperCase());
    const lines = rows.map((t: any) => {
      const ev = t.evidence || {};
      const related = Number(ev.relatedCommits) || 0;
      const maybe = related > 0 ? ` (+${related} possibly-related commit(s), unconfirmed)` : '';
      const detail = t.kind === 'gap'
        ? `${ev.actionCount || 0} action item(s) / ${ev.decisionCount || 0} decision(s) from this meeting were never ticketed`
        : t.kind === 'topic'
        ? `discussed across ${ev.meetingCount || 0} meeting(s) — latest status "${ev.latestStatus || '?'}"${ev.summary ? ` — ${String(ev.summary).slice(0, 120)}` : ''}`
        : `status "${ev.status || '?'}" · ${(ev.commits || []).length} confirmed commit(s)${maybe} · ${(ev.meetings || []).length} source meeting(s)`;
      const idle = t.last_advanced_at ? ` · last movement ${new Date(t.last_advanced_at).toISOString().slice(0, 10)}` : '';
      return `[${label(t.state, t.kind)}] ${t.anchor_source_id.length < 20 ? t.anchor_source_id + ' — ' : ''}${(t.title || '').slice(0, 90)}\n    ${detail}${idle}`;
    });
    return { ok: true, content: `Work-state ledger (${rows.length} thread(s), most-attention-first). Counts are CONFIRMED evidence; "possibly-related" are unverified similarity — do not state them as fact:\n\n${lines.join('\n')}` };
  }

  if (toolName === 'brain_lineage') {
    // The STORY of one work item (Brain D-6) — trace it through brain_edge: what spawned it, what
    // implements it (with verdict), what it connects to. Confirmed lineage = fact; semantic = possible.
    const anchor = String((args as any)?.anchor || (args as any)?.id || '').trim();
    if (!anchor) return { ok: false, isError: true, content: 'brain_lineage requires an "anchor" (a ticket key, meeting title, or item name).' };
    const { query } = await import('../db');
    const item = await query<any>(
      `SELECT id, source, source_id, title, status FROM knowledge_item
        WHERE workspace_id=$1 AND (upper(source_id)=upper($2) OR title ILIKE $3)
        ORDER BY (upper(source_id)=upper($2)) DESC, length(COALESCE(title,'')) ASC LIMIT 1`,
      [workspaceId, anchor, `%${anchor}%`],
    ).then((r) => r[0]).catch(() => null);
    if (!item) return { ok: true, content: `No item in the brain matches "${anchor}". Try a ticket key (e.g. PROJ-14) or a meeting title.` };
    const { neighboursOf } = await import('../connectors/brainEdges');
    const edges = await neighboursOf(userId, workspaceId, 'item', String(item.id), 40).catch(() => []);
    const other = (e: any) => (e.src_id === String(item.id) ? e.dst_id : e.src_id);
    const ids = [...new Set(edges.map(other))].map(Number).filter(Number.isFinite);
    const neigh = ids.length ? await query<any>(`SELECT id, source, source_id, title FROM knowledge_item WHERE id = ANY($1)`, [ids]).catch(() => []) : [];
    const byId = new Map(neigh.map((n: any) => [String(n.id), n]));
    const CONFIRMED = new Set(['provenance', 'reference', 'entity', 'llm']);
    const confirmed: string[] = []; const possible: string[] = [];
    for (const e of edges) {
      const n = byId.get(other(e)); if (!n) continue;
      const label = `${n.source}${n.source_id ? `:${n.source_id}` : ''} — ${(n.title || '').slice(0, 70)}`;
      const detail = e.origin === 'llm' && e.verdict
        ? `${e.relation}, verdict ${e.verdict}${e.rationale ? `: ${String(e.rationale).slice(0, 110)}` : ''}`
        : `${e.relation}${e.evidence ? ` (${String(e.evidence).slice(0, 50)})` : ''}`;
      (CONFIRMED.has(e.origin) ? confirmed : possible).push(`${label} — ${detail}`);
    }
    const th = await query<any>(
      `SELECT state, evidence FROM brain_thread WHERE workspace_id=$1 AND anchor_source_id=$2 ORDER BY updated_at DESC LIMIT 1`,
      [workspaceId, item.source_id],
    ).then((r) => r[0]).catch(() => null);
    const head = `${item.source}${item.source_id ? `:${item.source_id}` : ''} — ${item.title || '(untitled)'}${item.status ? ` [${item.status}]` : ''}${th ? ` · work-state: ${th.state}` : ''}`;
    const cBlock = confirmed.length ? `Confirmed lineage (fact):\n  ${confirmed.slice(0, 12).join('\n  ')}` : 'No confirmed lineage yet — nothing verified links to this item.';
    const pBlock = possible.length ? `\n\nPossibly related (UNVERIFIED — do not state as fact):\n  ${possible.slice(0, 6).join('\n  ')}` : '';
    return { ok: true, content: `Lineage of ${head}\n\n${cBlock}${pBlock}` };
  }

  if (toolName === 'brain_brief') {
    // The CHIEF-OF-STAFF brief (Brain D-1) — a grounded, pre-computed digest per project. Returns
    // every project's brief in the workspace (most-attention-first), or one project by name. Grounded
    // ONLY in confirmed evidence; the narrative is deterministic (no LLM invention).
    const projArg = String((args as any)?.project || '').trim().toLowerCase();
    const { query } = await import('../db');
    const rows = await query<any>(
      `SELECT b.space_id, b.generated_at, b.sections, b.narrative,
              COALESCE(jsonb_array_length(b.sections->'attention'),0) AS attention
         FROM space_brief b WHERE b.workspace_id=$1
        ORDER BY attention DESC, b.generated_at DESC LIMIT 25`, [workspaceId],
    ).catch(() => []);
    const filtered = projArg
      ? rows.filter((r: any) => String(r.sections?.space?.name || '').toLowerCase().includes(projArg))
      : rows;
    if (!filtered.length) {
      return { ok: true, content: rows.length
        ? `No project matches "${projArg}". Known projects: ${rows.map((r: any) => r.sections?.space?.name).filter(Boolean).join(', ')}.`
        : 'No project brief has been built yet (the brief is generated from tracked work — connect a tool or run a sync, then ask again).' };
    }
    const blocks = filtered.map((r: any) => {
      const s = r.sections || {};
      const age = r.generated_at ? ` (as of ${new Date(r.generated_at).toISOString().slice(0, 16).replace('T', ' ')}Z)` : '';
      const attn = (s.attention || []).slice(0, 6).map((a: any) => `  • ${a.label || a.title} — ${a.why}`).join('\n');
      return `## ${s.space?.name || 'Project'}${age}\n${r.narrative}${attn ? `\n\nNeeds attention:\n${attn}` : ''}`;
    });
    return { ok: true, content: `Chief-of-staff brief${filtered.length > 1 ? `s (${filtered.length} projects, most-attention-first)` : ''}. All figures are CONFIRMED evidence — report them as-is, do not inflate:\n\n${blocks.join('\n\n')}` };
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

  // DIRECT-REST Google connectors (gmail/gcal/gdrive) have no MCP server — they execute against Google's
  // REST APIs, NOT the MCP write path. Cross the SAME trust gate: read runs now; write/destructive needs
  // approval first, then runs through executeGoogleTool (never executeMcpWrite, which would find no server).
  const { isGoogleConnector, executeGoogleTool } = await import('../connectors/google/tools');
  if (isGoogleConnector(connector)) {
    const needsApproval = perm?.klass !== 'read' || perm?.behavior !== 'allow';
    if (needsApproval && !opts.approved) {
      return { ok: false, requiresApproval: true, behavior: perm?.behavior, klass: perm?.klass ?? undefined,
        content: `“${tool}” can change data in ${connector}, so it needs your approval before it runs.` };
    }
    const r = await executeGoogleTool(userId, workspaceId, connector, tool, args || {});
    return { ok: r.ok, isError: r.isError, content: r.content, behavior: perm?.behavior ?? 'allow', klass: perm?.klass ?? 'read' };
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
  // Resolve against the LIVE server list via the shared, connector-agnostic resolver — a stale
  // catalog / name variant must not dead-end the loop. On a true miss, return the server's ACTUAL
  // tool names so the model self-corrects next step, and refresh the catalog in the background.
  const def = resolveLiveTool(tools, tool, connector);
  if (!def) {
    try { const { discoverConnectorTools } = await import('../mcp/toolPlane'); void discoverConnectorTools(userId, workspaceId, connector); } catch { /* refresh is best-effort */ }
    const avail = (tools || []).map((t: any) => t.name).slice(0, 40).join(', ');
    return { ok: false, isError: true, content: `Unknown tool “${tool}” on ${connector}.${avail ? ` The server currently offers: ${avail}. Retry with one of those exact names.` : ''}` };
  }
  const liveName = String(def.name);   // call by the LIVE name (may differ from the stale catalog name)
  const needsCloudId = !!def.inputSchema?.properties?.cloudId && !!conn.cloudId;

  try {
    const r = await mcpCallTool(conn.server, conn.token, liveName, { ...(args || {}), ...(needsCloudId ? { cloudId: conn.cloudId } : {}) });
    const text = ((r?.content || []).map((c: any) => c?.text ?? '').join('\n').trim()) || JSON.stringify(r ?? {}).slice(0, 2000);
    if (r?.isError) return { ok: false, isError: true, content: `${connector} returned an error: ${text.slice(0, 500)}`, behavior: 'allow', klass: 'read' };
    return { ok: true, content: text.slice(0, 6000), behavior: 'allow', klass: 'read' };
  } catch (e: any) {
    return { ok: false, isError: true, content: `Failed to run ${tool}: ${String(e?.message || e).slice(0, 300)}` };
  }
}
