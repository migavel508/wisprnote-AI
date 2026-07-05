import { getSecrets } from '../secrets';
import { MODELS } from '../models/registry';
import { mcpListTools, mcpCallTool } from './client';
import { connectedConnectors, resolveMcpConnection } from './connection';

// NOTE: we no longer gate agent tools to a hard-coded connector allowlist. Like the reference
// (Claude Code), EVERY connected MCP server's tools are exposed to the agent — resolveMcpConnection
// returns null for anything not actually connectable (local/unconfigured), so it self-filters.

/**
 * Generic, provider-agnostic MCP tool-use agent — the Claude-Code architecture for
 * handling connectors. We DISCOVER each connected MCP server's tools (tools/list),
 * expose the READ-ONLY subset (plus any local tools like meeting search) to the model
 * as native tools, and run a real agentic loop: the model chooses + chains tools, we
 * execute (MCP or local), feed results back, and iterate until it answers.
 *
 * Works with BOTH Claude (Anthropic tool use) and Gemini (function calling) so it honors
 * the user's model selector. Writes are never exposed here — they stay behind the HITL
 * approval card. Per-workspace tokens only; cloudId injected for the model.
 */

const MAX_STEPS = 5;
const MAX_TOOL_CALLS = 6;   // hard backstop on fan-out so we never approach the gateway timeout
// MUST stay under the API Gateway integration timeout (~29s). Shared across the model
// providers + all tool round-trips so a multi-step loop (and any fallback) still returns.
const AGENT_BUDGET_MS = 18_000;
const MAX_TOOL_OUTPUT = 12_000;

// We expose the FULL toolset of every connected MCP server to the loop (Jira + Confluence
// + Compass + Teamwork Graph + search + metadata…) via a verb classifier — matching how
// Claude exposes an MCP's whole toolset. READS auto-execute. WRITES are INTERCEPTED: the
// model "calls" them, but instead of executing we capture an editable HITL proposal — so
// every write still requires the user's approval. DELETES are never offered.
// Classification is annotation-FIRST: the MCP standard `annotations.readOnlyHint` is the
// server's own declaration. We fall back to verb heuristics that handle BOTH naming styles
// — Atlassian's prefix verbs (getJiraIssue / createJiraIssue) and GitHub's suffix verbs
// (issue_read / pull_request_write) plus consolidated tools.
const WRITE_VERB = /^(create|update|edit|add|transition|publish|merge|put|post|upload|assign|move|set|comment|close|reopen|fork|push|dispatch|rerun|cancel|request)/i;
const DELETE_VERB = /^(delete|remove|archive|purge|trash)|_(delete|remove)$/i;
const READ_VERB = /^(get|search|list|lookup|fetch|read|retrieve|find|describe|count)/i;
const READ_SUFFIX = /_(read|get|list|search|view|status)$/i;
const WRITE_SUFFIX = /_(write|create|update|add|edit|merge|delete|comment)$/i;
// cloudId plumbing is hidden (we inject it). Jira ISSUE writes are handled by the dedicated
// structured card (with assignee resolution), so they're excluded from the generic intercept.
const EXCLUDE_TOOLS = new Set(['getAccessibleAtlassianResources']);
const STRUCTURED_JIRA_WRITES = new Set(['createJiraIssue', 'editJiraIssue', 'transitionJiraIssue', 'addCommentToJiraIssue']);

const readOnlyHint = (t: any): boolean | undefined => t?.annotations?.readOnlyHint;
function isReadTool(t: any): boolean {
  if (EXCLUDE_TOOLS.has(t.name)) return false;
  const h = readOnlyHint(t);
  if (h === true) return true;
  if (h === false) return false;
  const n = t.name as string;
  if (DELETE_VERB.test(n) || WRITE_VERB.test(n) || WRITE_SUFFIX.test(n)) return false;
  return READ_VERB.test(n) || READ_SUFFIX.test(n) || n === 'atlassianUserInfo';
}
/** A write we expose for INTERCEPTION (→ HITL card), never auto-execution. */
function isInterceptableWrite(t: any): boolean {
  if (STRUCTURED_JIRA_WRITES.has(t.name)) return false;   // handled by the structured Jira card
  if (DELETE_VERB.test(t.name)) return false;              // deletes never offered
  const h = readOnlyHint(t);
  if (h === true) return false;
  if (h === false) return true;
  return WRITE_VERB.test(t.name) || WRITE_SUFFIX.test(t.name);
}

/** A write the agent proposed (captured, not executed) → surfaced as an approval card. */
export interface McpWriteProposal { connector: string; tool: string; args: Record<string, unknown>; summary: string }

/** A tool the agent can call — MCP-backed or local. `exec` returns text fed to the model. */
export interface AgentTool {
  def: { name: string; description: string; input_schema: any };
  exec: (args: any) => Promise<string>;
}

interface AgentArgs {
  userId: string;
  workspaceId: string;
  query: string;
  history?: Array<{ role: 'user' | 'model'; text: string }>;
  model?: 'gemini' | 'claude';
  localTools?: AgentTool[];        // e.g. search_meetings, injected by the caller
}

const SYSTEM = (today: string) => `Today is ${today}. You are WisprNote's workspace assistant — a brain over the user's meetings and connected tools (Jira, GitHub, Confluence, …). Use your tools to fetch EXACT, LIVE data and answer; plan and chain calls as needed.
- search_meetings: search this workspace's meeting notes/decisions/action items — use it for anything about meetings, decisions, who-said-what, or to connect a tool item to what was discussed.
- Jira: searchJiraIssuesUsingJql (JQL MUST be bounded, e.g. \`updated >= "2000-01-01" ORDER BY updated DESC\`). getJiraIssue with expand:"changelog" returns description, comments, and change history. cloudId is injected for you. Cite Jira keys as markdown links to the browse page — never an api.atlassian.com URL.
- GitHub: use the github tools (search/list/get issues, pull requests, repos, commits, files, actions). For "my repos / my PRs / how many repos" do NOT ask the user for their username — first call the tool that returns the AUTHENTICATED user (e.g. get_me / current user), then list/search their repos or PRs (or use a search query like "is:pr is:open author:@me"). Only ask the user for owner/repo if they literally typed a placeholder like "owner/repo". To inspect a specific PR/issue you need owner, repo, and number — get them from search/list first. Cite using the html_url the tools return (e.g. [#42](https://github.com/owner/repo/pull/42)).
- Reproduce real data faithfully; if a field is empty, say so. Never invent issues, PRs, commits, or values.
- WRITES (create/update issues & PRs, comments, worklogs, links, Confluence pages, labels, Compass, etc.): you MAY call the write tool with your best arguments — it does NOT execute; it's captured as an editable approval card for the user. Call it once, then say it's ready for approval. Never call the same write twice. (Jira ISSUE create/update/comment/transition is handled by a dedicated card — for those, just tell the user.)
- EFFICIENCY: when you need details for several items, request them in ONE turn (parallel tool calls). Find the set with one search, then batch the detail calls. Don't re-search.
Keep answers tight and well-formatted.`;

// ── Tool registry: discover MCP tools + merge local tools ────────────────────
// `proposals` collects any WRITE the model attempts — those are intercepted (captured,
// not executed) so they can be surfaced as HITL approval cards.
async function buildRegistry(userId: string, workspaceId: string, localTools: AgentTool[], proposals: McpWriteProposal[]): Promise<{ reg: Record<string, AgentTool>; jiraSiteUrl?: string }> {
  const reg: Record<string, AgentTool> = {};
  for (const t of localTools) reg[t.def.name] = t;

  let jiraSiteUrl: string | undefined;
  // Discover tools across EVERY connected connector in the workspace (Jira, GitHub, …).
  const connectors = await connectedConnectors(userId, workspaceId);
  for (const connector of connectors) {
    const conn = await resolveMcpConnection(userId, workspaceId, connector).catch(() => null);
    if (!conn) continue;
    if (connector === 'jira') jiraSiteUrl = conn.siteUrl || undefined;
    const tools = await mcpListTools(conn.server, conn.token).catch(() => []);
    for (const t of tools || []) {
      if (reg[t.name]) continue;   // local tools + first-connector-wins on the rare name clash
      const schema = t.inputSchema || { type: 'object', properties: {} };
      const needsCloudId = !!schema?.properties?.cloudId && !!conn.cloudId;
      if (isReadTool(t)) {
        reg[t.name] = {
          def: { name: t.name, description: t.description || '', input_schema: schema },
          exec: async (args: any) => {
            const r = await mcpCallTool(conn.server, conn.token, t.name, { ...(args || {}), ...(needsCloudId ? { cloudId: conn.cloudId } : {}) });
            const text = (r?.content?.[0]?.text ?? JSON.stringify(r ?? {})).toString().slice(0, MAX_TOOL_OUTPUT);
            return r?.isError ? `Error: ${text}` : text;
          },
        };
      } else if (isInterceptableWrite(t)) {
        // INTERCEPT: don't execute — capture an approval proposal and tell the model.
        reg[t.name] = {
          def: { name: t.name, description: `${t.description || ''} (proposes a change for the user's approval — does not execute immediately)`, input_schema: schema },
          exec: async (args: any) => {
            const a = { ...(args || {}) }; delete (a as any).cloudId;
            proposals.push({ connector, tool: t.name, args: a, summary: t.name });
            return `Prepared "${t.name}" as an approval card for the user. Do NOT call it again — tell the user it is ready for their review and approval.`;
          },
        };
      }
    }
  }
  return { reg, jiraSiteUrl };
}

export async function runWorkspaceMcpAgent(args: AgentArgs): Promise<{ answer: string; usedTools: string[]; proposals?: McpWriteProposal[] } | null> {
  const secrets = await getSecrets();
  const proposals: McpWriteProposal[] = [];
  const { reg: registry, jiraSiteUrl } = await buildRegistry(args.userId, args.workspaceId, args.localTools ?? [], proposals);
  const toolDefs = Object.values(registry).map((t) => t.def);
  if (!toolDefs.length) return null;

  const today = new Date().toISOString().slice(0, 10);
  const system = SYSTEM(today) + (jiraSiteUrl ? `\nJira issue links MUST use this exact base: ${jiraSiteUrl}/browse/<ISSUE-KEY>.` : '');
  // ONE shared deadline across providers + steps so we always return before API Gateway's
  // ~29s timeout. Honor the model selector, but fall back to the OTHER provider only if
  // there's still meaningful time left (e.g. preferred provider 503'd fast).
  const deadline = Date.now() + AGENT_BUDGET_MS;
  const order: Array<'claude' | 'gemini'> = args.model === 'gemini' ? ['gemini', 'claude'] : ['claude', 'gemini'];
  for (const p of order) {
    if (Date.now() > deadline - 5000) break;   // not enough time for a meaningful attempt
    let r: { answer: string; usedTools: string[] } | null = null;
    if (p === 'claude' && secrets.ANTHROPIC_API_KEY) r = await runClaudeLoop(system, args, toolDefs, registry, secrets.ANTHROPIC_API_KEY, deadline);
    else if (p === 'gemini' && secrets.GEMINI_API_KEY) r = await runGeminiLoop(system, args, toolDefs, registry, secrets.GEMINI_API_KEY, deadline);
    if (r) return { ...r, proposals: proposals.length ? proposals : undefined };
    if (proposals.length) return { answer: r ? (r as any).answer : 'I’ve prepared the change for your approval below.', usedTools: [], proposals };
  }
  if (proposals.length) return { answer: 'I’ve prepared the change for your approval below.', usedTools: [], proposals };
  return null;
}

// ── Claude (Anthropic) tool-use loop ─────────────────────────────────────────
async function runClaudeLoop(system: string, args: AgentArgs, toolDefs: any[], registry: Record<string, AgentTool>, key: string, deadline: number) {
  const tools = toolDefs.map((d) => ({ name: d.name, description: d.description, input_schema: d.input_schema }));
  const history = (args.history ?? []).slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text }));
  const messages: any[] = [...history, { role: 'user', content: args.query }];
  const usedTools: string[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const forceFinal = Date.now() > deadline || usedTools.length >= MAX_TOOL_CALLS;
    const resp = await postWithRetry('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model: MODELS.chatClaude.primary, max_tokens: 2000, system, messages, ...(forceFinal ? {} : { tools }) }),
    });
    if (!resp.ok) { console.error('mcp_agent_claude', resp.status, (await resp.text()).slice(0, 300)); return null; }
    const data: any = await resp.json();
    const blocks: any[] = Array.isArray(data.content) ? data.content : [];
    if (data.stop_reason === 'tool_use' && !forceFinal) {
      messages.push({ role: 'assistant', content: blocks });
      const uses = blocks.filter((b) => b.type === 'tool_use');
      // Execute this turn's tool calls in PARALLEL (independent reads) to cut latency.
      const results = await Promise.all(uses.map(async (b) => {
        usedTools.push(b.name);
        return { type: 'tool_result', tool_use_id: b.id, content: await runTool(registry, b.name, b.input) };
      }));
      messages.push({ role: 'user', content: results });
      continue;
    }
    const text = blocks.filter((b) => b.type === 'text').map((b) => b.text).join('').trim();
    return text ? { answer: text, usedTools } : null;
  }
  return null;
}

// ── Gemini (function calling) loop ───────────────────────────────────────────
async function runGeminiLoop(system: string, args: AgentArgs, toolDefs: any[], registry: Record<string, AgentTool>, key: string, deadline: number) {
  const functionDeclarations = toolDefs.map((d) => ({ name: d.name, description: d.description, parameters: sanitizeForGemini(d.input_schema) }));
  const contents: any[] = [
    ...(args.history ?? []).slice(-6).map((m) => ({ role: m.role === 'user' ? 'user' : 'model', parts: [{ text: m.text }] })),
    { role: 'user', parts: [{ text: args.query }] },
  ];
  const usedTools: string[] = [];
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${MODELS.chatGemini.primary}:generateContent?key=${key}`;

  for (let step = 0; step < MAX_STEPS; step++) {
    const forceFinal = Date.now() > deadline || usedTools.length >= MAX_TOOL_CALLS;
    const resp = await postWithRetry(url, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents,
        ...(forceFinal ? {} : { tools: [{ functionDeclarations }] }),
        generationConfig: { temperature: 0.2, maxOutputTokens: 2000 },
      }),
    });
    if (!resp.ok) { console.error('mcp_agent_gemini', resp.status, (await resp.text()).slice(0, 300)); return null; }
    const data: any = await resp.json();
    const parts: any[] = data.candidates?.[0]?.content?.parts ?? [];
    const calls = parts.filter((p) => p.functionCall);
    if (calls.length && !forceFinal) {
      contents.push({ role: 'model', parts });
      const responses = await Promise.all(calls.map(async (c) => {
        usedTools.push(c.functionCall.name);
        const out = await runTool(registry, c.functionCall.name, c.functionCall.args || {});
        return { functionResponse: { name: c.functionCall.name, response: { result: out } } };
      }));
      contents.push({ role: 'user', parts: responses });
      continue;
    }
    const text = parts.filter((p) => typeof p.text === 'string').map((p) => p.text).join('').trim();
    return text ? { answer: text, usedTools } : null;
  }
  return null;
}

/** POST to a model API with small backoff on transient overload (429/5xx). */
async function postWithRetry(url: string, init: RequestInit, retries = 1): Promise<Response> {
  let last: Response | null = null;
  for (let i = 0; i <= retries; i++) {
    const r = await fetch(url, init);
    if (r.ok || ![429, 500, 502, 503, 529].includes(r.status)) return r;
    last = r;
    if (i < retries) await new Promise((res) => setTimeout(res, 500));
  }
  return last as Response;
}

async function runTool(registry: Record<string, AgentTool>, name: string, input: any): Promise<string> {
  const t = registry[name];
  if (!t) return `Tool ${name} is not available.`;
  try { return await t.exec(input || {}); }
  catch (e: any) { return `Error calling ${name}: ${e?.message || 'failed'}`; }
}

/** Reduce a JSON-Schema to the OpenAPI subset Gemini accepts (drops $schema,
 *  additionalProperties, and other unsupported keywords; recurses). */
function sanitizeForGemini(schema: any): any {
  if (!schema || typeof schema !== 'object') return { type: 'object' };
  const keep = ['type', 'description', 'enum', 'nullable'];
  const out: any = {};
  for (const k of keep) if (schema[k] !== undefined) out[k] = schema[k];
  if (schema.type === 'object' || schema.properties) {
    out.type = 'object';
    out.properties = {};
    for (const [k, v] of Object.entries(schema.properties || {})) out.properties[k] = sanitizeForGemini(v);
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
    if (!Object.keys(out.properties).length) out.properties = { _noop: { type: 'string', description: 'unused' } };
  }
  if (schema.type === 'array' && schema.items) { out.type = 'array'; out.items = sanitizeForGemini(schema.items); }
  if (!out.type) out.type = 'string';
  return out;
}
