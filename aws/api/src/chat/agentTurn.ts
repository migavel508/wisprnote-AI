import { getSecrets } from '../secrets';

/**
 * AGENT TURN — the provider abstraction for the agentic chat loop (Phase 0).
 *
 * ONE normalized, tool-capable model turn across every provider, each via its OWN direct key
 * (raw fetch, matching the codebase convention in connectors/brainLink.ts):
 *   • anthropic   — Claude, DIRECT Anthropic API (default tool-use model)   [ANTHROPIC_API_KEY]
 *   • openai      — GPT, DIRECT OpenAI API                                  [OPENAI_API_KEY]
 *   • gemini      — Gemini, DIRECT Google API                               [GEMINI_API_KEY]
 *   • openrouter  — Gemini/other models via OpenRouter (OpenAI-compatible)  [OPENROUTER_API_KEY]
 *
 * Messages are normalized in ANTHROPIC block shape (text | tool_use | tool_result); each adapter
 * translates to its provider's request and parses the response back to a single normalized result.
 * The loop (client) is therefore identical regardless of which model the user picks. Keys NEVER
 * leave the server.
 */

export type AgentBlock =
  // `signature` carries a provider-specific opaque token that MUST round-trip with the tool call
  // (Gemini 3 thinking models require their `thoughtSignature` echoed back, or the next turn 400s).
  // Other providers ignore it; it's threaded through the normalized layer transparently.
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any; signature?: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };

export interface AgentMessage { role: 'user' | 'assistant'; content: AgentBlock[] }
export interface AgentToolDef { name: string; description: string; inputSchema: any }   // JSON Schema

export type AgentProvider = 'anthropic' | 'openai' | 'gemini' | 'openrouter';

export interface AgentTurnRequest {
  model: string;
  provider?: AgentProvider;             // optional override; otherwise inferred from the model id
  system?: string;
  messages: AgentMessage[];
  tools?: AgentToolDef[];
  maxOutputTokens?: number;
  thinking?: 'adaptive' | 'off';        // anthropic only; default off (keeps multi-turn simple)
}

export interface AgentToolCall { id: string; name: string; args: any; signature?: string }
export interface AgentTurnResult {
  text: string;
  toolCalls: AgentToolCall[];           // empty = final turn
  stopReason: string;
  usage?: { input?: number; output?: number };
  model: string;
  provider: AgentProvider;
}

/** Infer the provider from the model id (overridable). */
export function providerFor(model: string, explicit?: AgentProvider): AgentProvider {
  if (explicit) return explicit;
  const m = (model || '').toLowerCase();
  if (m.startsWith('claude') || m.startsWith('anthropic/')) return 'anthropic';
  if (m.includes('/')) return 'openrouter';                       // e.g. "google/gemini-3-pro"
  if (m.startsWith('gpt') || m.startsWith('o1') || m.startsWith('o3') || m.startsWith('o4') || m.startsWith('chatgpt')) return 'openai';
  if (m.startsWith('gemini')) return 'gemini';
  return 'anthropic';
}

function safeParse(s: any): any { if (typeof s !== 'string') return s ?? {}; try { return JSON.parse(s); } catch { return {}; } }
function blockText(b: AgentBlock): string { return b.type === 'text' ? b.text : ''; }
function resultStr(c: any): string { return typeof c === 'string' ? c : JSON.stringify(c); }

/**
 * Gemini's function-declaration Schema proto accepts only a narrow OpenAPI subset and rejects
 * anything else with "Unknown name X" 400s — far stricter than Anthropic/OpenAI, which take JSON
 * Schema as-is. Real MCP tool schemas (GitHub's especially) carry type-arrays (`["string","null"]`),
 * `anyOf`/`oneOf`/`allOf`, `$ref`, `format`, `additionalProperties`, etc. that Gemini won't parse.
 *
 * So we WHITELIST only the keys Gemini supports (a blacklist can't keep up), collapse type-arrays
 * to a concrete type + `nullable`, collapse union schemas to their first concrete option, and
 * guarantee every node has a `type` (Gemini rejects type-less schemas). The model still gets enough
 * structure to call tools correctly; dropped constraints (min/max/pattern/format) are only advisory.
 */
const GEMINI_SCHEMA_KEYS = new Set(['type', 'description', 'enum', 'items', 'properties', 'required', 'nullable']);
function geminiSchema(s: any): any {
  if (!s || typeof s !== 'object') return s;
  if (Array.isArray(s)) return s.map(geminiSchema);
  // Collapse union schemas (anyOf/oneOf/allOf) → first concrete (non-null) option merged over siblings.
  const union = s.anyOf || s.oneOf || s.allOf;
  const src = Array.isArray(union) && union.length
    ? { ...s, ...(union.find((u: any) => u && u.type !== 'null') || union[0] || {}) }
    : s;
  const out: any = {};
  for (const [k, v] of Object.entries(src)) {
    if (!GEMINI_SCHEMA_KEYS.has(k)) continue;                       // whitelist — drop everything else
    if (k === 'type') {
      if (Array.isArray(v)) {                                       // ["string","null"] → string + nullable
        const nonNull = (v as any[]).filter((t) => t !== 'null');
        out.type = nonNull[0] || 'string';
        if ((v as any[]).includes('null')) out.nullable = true;
      } else out.type = v;
    } else if (k === 'properties' && v && typeof v === 'object') {
      out.properties = Object.fromEntries(Object.entries(v).map(([pk, pv]) => [pk, geminiSchema(pv)]));
    } else if (k === 'items') {
      out.items = geminiSchema(v);
    } else if (k === 'enum') {
      // Gemini supports enum ONLY for string type with string values — drop otherwise.
      if (Array.isArray(v) && v.length && v.every((e) => typeof e === 'string')) out.enum = v;
    } else {
      out[k] = v;
    }
  }
  // Every node must declare a supported type; infer when missing (incl. from a dropped enum's values).
  if (!out.type) {
    if (out.properties) out.type = 'object';
    else if (out.items) out.type = 'array';
    else if (Array.isArray(src.enum) && src.enum.length) {
      const t = typeof src.enum[0];
      out.type = t === 'boolean' ? 'boolean' : t === 'number' ? 'number' : 'string';
    } else out.type = 'string';
  }
  if (out.enum && out.type !== 'string') out.type = 'string';       // enum ⇒ string type
  if (out.type === 'array' && !out.items) out.items = { type: 'string' }; // arrays must declare items
  if (out.required && out.properties) {                              // required must reference real props
    out.required = (Array.isArray(out.required) ? out.required : []).filter((r: any) => r in out.properties);
    if (!out.required.length) delete out.required;
  } else if (out.required && !out.properties) {
    delete out.required;
  }
  return out;
}

export async function runAgentTurn(req: AgentTurnRequest): Promise<AgentTurnResult> {
  const provider = providerFor(req.model, req.provider);
  const s = await getSecrets();
  switch (provider) {
    case 'anthropic':  return anthropicTurn(req, s.ANTHROPIC_API_KEY);
    case 'openai':     return openaiStyleTurn(req, s.OPENAI_API_KEY, 'https://api.openai.com/v1/chat/completions', 'openai');
    case 'openrouter': return openaiStyleTurn(req, s.OPENROUTER_API_KEY, 'https://openrouter.ai/api/v1/chat/completions', 'openrouter');
    case 'gemini':     return geminiTurn(req, s.GEMINI_API_KEY);
  }
}

// ── Anthropic (Claude) — DIRECT. Our normalized blocks ARE Anthropic's shape (near-identity). ──
async function anthropicTurn(req: AgentTurnRequest, key: string): Promise<AgentTurnResult> {
  if (!key) throw new Error('ANTHROPIC_API_KEY is not configured.');
  const body: any = {
    model: req.model,
    max_tokens: req.maxOutputTokens ?? 4096,
    // Emit only Anthropic-native block fields — our internal `signature` (a Gemini token) would
    // be rejected as an unknown field on a tool_use block.
    messages: req.messages.map((m) => ({
      role: m.role,
      content: m.content.map((b) =>
        b.type === 'tool_use' ? { type: 'tool_use', id: b.id, name: b.name, input: b.input }
        : b.type === 'tool_result' ? { type: 'tool_result', tool_use_id: b.tool_use_id, content: b.content, is_error: b.is_error }
        : { type: 'text', text: b.text }),
    })),
  };
  if (req.system) body.system = req.system;
  if (req.tools?.length) body.tools = req.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));
  if (req.thinking === 'adaptive') body.thinking = { type: 'adaptive' };
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`anthropic ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  let text = ''; const toolCalls: AgentToolCall[] = [];
  for (const b of d.content || []) {
    if (b.type === 'text') text += b.text;
    else if (b.type === 'tool_use') toolCalls.push({ id: b.id, name: b.name, args: b.input ?? {} });
  }
  return { text, toolCalls, stopReason: d.stop_reason || 'end_turn', usage: { input: d.usage?.input_tokens, output: d.usage?.output_tokens }, model: req.model, provider: 'anthropic' };
}

// ── OpenAI + OpenRouter (OpenAI-compatible) ──
async function openaiStyleTurn(req: AgentTurnRequest, key: string, url: string, provider: AgentProvider): Promise<AgentTurnResult> {
  if (!key) throw new Error(`${provider === 'openrouter' ? 'OPENROUTER' : 'OPENAI'}_API_KEY is not configured.`);
  const messages: any[] = [];
  if (req.system) messages.push({ role: 'system', content: req.system });
  for (const m of req.messages) {
    const text = m.content.map(blockText).join('');
    const toolUses = m.content.filter((b) => b.type === 'tool_use') as Extract<AgentBlock, { type: 'tool_use' }>[];
    const toolResults = m.content.filter((b) => b.type === 'tool_result') as Extract<AgentBlock, { type: 'tool_result' }>[];
    if (m.role === 'assistant') {
      const msg: any = { role: 'assistant', content: text || '' };
      if (toolUses.length) msg.tool_calls = toolUses.map((b) => ({ id: b.id, type: 'function', function: { name: b.name, arguments: JSON.stringify(b.input ?? {}) } }));
      messages.push(msg);
    } else {
      // tool results become their own role:'tool' messages (must follow the assistant tool_calls)
      for (const tr of toolResults) messages.push({ role: 'tool', tool_call_id: tr.tool_use_id, content: resultStr(tr.content) });
      if (text || toolResults.length === 0) messages.push({ role: 'user', content: text });
    }
  }
  const body: any = { model: req.model, messages, max_tokens: req.maxOutputTokens ?? 4096 };
  if (req.tools?.length) { body.tools = req.tools.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } })); body.tool_choice = 'auto'; }
  const headers: any = { 'content-type': 'application/json', Authorization: `Bearer ${key}` };
  if (provider === 'openrouter') { headers['HTTP-Referer'] = 'https://wisprnote.com'; headers['X-Title'] = 'Wisprnote'; }
  const r = await fetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${provider} ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const msg = d.choices?.[0]?.message || {};
  const toolCalls: AgentToolCall[] = (msg.tool_calls || []).map((tc: any) => ({ id: tc.id, name: tc.function?.name, args: safeParse(tc.function?.arguments) }));
  return { text: msg.content || '', toolCalls, stopReason: d.choices?.[0]?.finish_reason || 'stop', usage: { input: d.usage?.prompt_tokens, output: d.usage?.completion_tokens }, model: req.model, provider };
}

// ── Gemini — DIRECT ──
async function geminiTurn(req: AgentTurnRequest, key: string): Promise<AgentTurnResult> {
  if (!key) throw new Error('GEMINI_API_KEY is not configured.');
  // Gemini matches tool results by function NAME, not id → map our tool_use ids back to names.
  const idToName = new Map<string, string>();
  for (const m of req.messages) for (const b of m.content) if (b.type === 'tool_use') idToName.set(b.id, b.name);
  const contents = req.messages.map((m) => ({
    role: m.role === 'assistant' ? 'model' : 'user',
    parts: m.content.map((b) => {
      if (b.type === 'text') return { text: b.text };
      if (b.type === 'tool_use') {
        const part: any = { functionCall: { name: b.name, args: b.input ?? {} } };
        if (b.signature) part.thoughtSignature = b.signature;   // Gemini 3 requires this echoed back
        return part;
      }
      return { functionResponse: { name: idToName.get(b.tool_use_id) || b.tool_use_id, response: { content: resultStr(b.content) } } };
    }),
  }));
  const body: any = { contents, generationConfig: { maxOutputTokens: req.maxOutputTokens ?? 4096 } };
  if (req.system) body.systemInstruction = { parts: [{ text: req.system }] };
  if (req.tools?.length) body.tools = [{ functionDeclarations: req.tools.map((t) => ({ name: t.name, description: t.description, parameters: geminiSchema(t.inputSchema) })) }];
  const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${req.model}:generateContent?key=${key}`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`gemini ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const d: any = await r.json();
  const parts = d.candidates?.[0]?.content?.parts || [];
  let text = ''; const toolCalls: AgentToolCall[] = []; let i = 0;
  for (const p of parts) {
    if (p.text) text += p.text;
    else if (p.functionCall) toolCalls.push({ id: `gemini-${p.functionCall.name}-${i++}`, name: p.functionCall.name, args: p.functionCall.args || {}, signature: p.thoughtSignature });
  }
  return { text, toolCalls, stopReason: d.candidates?.[0]?.finishReason || 'STOP', usage: { input: d.usageMetadata?.promptTokenCount, output: d.usageMetadata?.candidatesTokenCount }, model: req.model, provider: 'gemini' };
}
