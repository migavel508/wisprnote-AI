import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { badRequest, serverError, notFound } from './response';
import { getSecrets } from './secrets';
import {
  traceAI,
  flushBraintrust,
  providerFromHost,
  modelFromRequest,
  usageMetrics,
  audioMetrics,
} from './observability';
import { recordTokenUsage, recordAudioUsage, normalizeFeature } from './usage';
import { handleChatAgent } from './chatAgent';
import { MODELS } from './models/registry';
import { runAgentTurn, providerFor } from './chat/agentTurn';

/**
 * Authenticated AI proxy. Every route sits BEHIND verifyToken (see the router in
 * index.ts), so only signed-in users reach it. Provider API keys live ONLY in
 * Secrets Manager and are injected here, server-side — they never ship in the
 * client bundle.
 *
 * Every provider call here is traced to Braintrust (observability.ts) — model,
 * latency, token usage, status, and the signed-in user. Because ALL of the
 * app's AI traffic flows through this one handler, that single instrumentation
 * point gives whole-application coverage. Tracing is a no-op until a Braintrust
 * key is configured, and never affects the user-facing call.
 *
 * Routes (segments[1]):
 *   POST /ai/proxy          → host-whitelisted passthrough: client sends
 *                             { url, method, body }; we inject the right
 *                             provider auth header and forward verbatim. Handles
 *                             Gemini, Anthropic, OpenRouter, Turbopuffer
 *                             uniformly (any endpoint/shape) with no per-shape code.
 *   POST /ai/transcribe     → Deepgram prerecorded transcription (voice input).
 *   POST /ai/deepgram-token → mint a short-lived Deepgram streaming token.
 *   POST /ai/transcription-usage → client reports a finished realtime streaming
 *                             session's audio duration (the realtime stream goes
 *                             client→Deepgram directly, so this is how it gets
 *                             traced to Braintrust + metered).
 */
export async function handleAI(
  method: string,
  segments: string[],
  userId: string,
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  try {
    return await routeAI(method, segments, userId, event);
  } finally {
    // Upload queued spans before the Lambda execution environment freezes.
    await flushBraintrust();
  }
}

async function routeAI(
  method: string,
  segments: string[],
  userId: string,
  event: APIGatewayProxyEvent
): Promise<APIGatewayProxyResult> {
  const sub = segments[1];
  if (method !== 'POST') return notFound();

  let body: any = {};
  try { body = JSON.parse(event.body || '{}'); } catch { return badRequest('Invalid JSON body'); }

  // FEATURE tag for usage analytics: the client sets X-Usage-Feature (or a body.feature) so
  // every metered call is attributed to the product function that made it (meeting, chat, …).
  const h = event.headers || {};
  const feature = normalizeFeature(h['x-usage-feature'] || h['X-Usage-Feature'] || body.feature);

  const secrets = await getSecrets();

  if (sub === 'deepgram-token') {
    if (!secrets.DEEPGRAM_API_KEY) return serverError('Deepgram key not configured');
    const ttl = Math.min(Math.max(Number(body.ttl_seconds) || 60, 10), 3600);
    const out = await traceAI(
      { name: 'deepgram.token', kind: 'function', provider: 'deepgram', userId, metadata: { ttl } },
      async () => {
        const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
          method: 'POST',
          headers: { Authorization: `Token ${secrets.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ ttl_seconds: ttl }),
        });
        const text = await r.text();
        // Don't log the token itself.
        return { status: r.ok ? 200 : r.status, output: '[streaming token issued]', body: text };
      }
    );
    return { statusCode: out.status, headers: jsonHeaders(), body: out.body };
  }

  if (sub === 'transcribe') {
    // Transcribe a short voice clip (base64) → text, via Deepgram prerecorded.
    // Used by the chat box's voice input. Key stays server-side.
    if (!secrets.DEEPGRAM_API_KEY) return serverError('Deepgram key not configured');
    const audioB64 = String(body.audio || '');
    const mimetype = String(body.mimetype || 'audio/webm');
    if (!audioB64) return badRequest('audio required');
    const audioBuf = Buffer.from(audioB64, 'base64');
    const out = await traceAI(
      { name: 'deepgram.transcribe', kind: 'function', provider: 'deepgram', model: MODELS.transcription.primary, userId, input: `[audio ${audioBuf.length} bytes, ${mimetype}]`, metadata: { mimetype } },
      async () => {
        // English-only, max accuracy on Nova-3:
        //  - language=en pins the English-optimized path (no language detection /
        //    multilingual code-switching, which degrades English accuracy).
        //  - smart_format + punctuate clean up casing, punctuation, numbers.
        //  - filler_words=false drops "um/uh" for clean chat input.
        const dgParams = new URLSearchParams({
          model: MODELS.transcription.primary,
          language: 'en',
          smart_format: 'true',
          punctuate: 'true',
          filler_words: 'false',
        });
        const r = await fetch(`https://api.deepgram.com/v1/listen?${dgParams.toString()}`, {
          method: 'POST',
          headers: { Authorization: `Token ${secrets.DEEPGRAM_API_KEY}`, 'Content-Type': mimetype },
          body: audioBuf,
        });
        const data: any = await r.json().catch(() => ({}));
        const text = data?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
        // Deepgram bills by audio seconds → metadata.duration is the cost signal.
        const seconds = Number(data?.metadata?.duration) || 0;
        return {
          status: r.ok ? 200 : r.status,
          output: text,
          metrics: audioMetrics(seconds),
          body: JSON.stringify({ text }),
        };
      }
    );
    // Meter the audio processed (per user/model) for billing & analytics.
    await recordAudioUsage(userId, 'deepgram', MODELS.transcription.primary, Number(out.metrics?.audio_seconds) || 0, 'transcription');
    return { statusCode: out.status, headers: jsonHeaders(), body: out.body };
  }

  if (sub === 'transcription-usage') {
    // The realtime meeting transcription streams CLIENT → Deepgram directly (over
    // a WebSocket, using a short-lived token), so it can't be traced server-side
    // like the proxy. The client reports the finished session's audio duration
    // here so realtime transcription still shows up in Braintrust + usage metering
    // — giving the whole app (every model) complete observability.
    const mode = String(body.mode || 'realtime');
    const model = String(body.model || MODELS.transcription.primary);
    const seconds = Math.max(0, Number(body.duration_seconds) || 0);
    const words = Math.max(0, Number(body.words) || 0);
    if (seconds <= 0) return badRequest('duration_seconds required');
    await traceAI(
      {
        name: 'deepgram.streaming',
        kind: 'function',
        provider: 'deepgram',
        model,
        userId,
        input: `[realtime ${mode} session]`,
        metadata: { mode, language: String(body.language || 'multi'), streaming: true, reported_by: 'client' },
      },
      async () => ({ status: 200, output: `[${seconds.toFixed(1)}s transcribed]`, metrics: audioMetrics(seconds, words) }),
    );
    await recordAudioUsage(userId, 'deepgram', model, seconds, 'transcription');
    return { statusCode: 200, headers: jsonHeaders(), body: JSON.stringify({ ok: true }) };
  }

  if (sub === 'chat') {
    // Server-side chat agent: tenant-isolated retrieval + grounded synthesis,
    // entirely in the Lambda (the corpus never reaches the browser).
    return handleChatAgent(userId, body);
  }

  if (sub === 'agent-turn') {
    // AGENTIC CHAT loop — ONE tool-capable model turn, provider-abstracted.
    // The client orchestrates the loop (plan → tool → gated exec → repeat); this
    // endpoint just runs a single normalized turn for the chosen model so the
    // provider key never leaves the server. (Phase 0 + 1.)
    const model = String(body.model || MODELS.agentChat.primary);
    if (!Array.isArray(body.messages)) return badRequest('messages required');
    const provider = providerFor(model, body.provider);
    try {
      // Phase 1 — TOOL EXPOSURE. When a workspace is supplied, assemble the toolset
      // server-side from the tool plane (built-ins + connected-connector tools, deny-filtered,
      // namespaced mcp__connector__tool). The client never sees the raw catalog. Any tools the
      // client passes explicitly are appended (de-duplicated by name).
      let tools = Array.isArray(body.tools) ? [...body.tools] : [];
      if (body.workspaceId && body.exposeConnectorTools !== false) {
        const { buildAgentToolset } = await import('./chat/agentTools');
        const { tools: built } = await buildAgentToolset(userId, String(body.workspaceId), { connectorTools: body.connectorTools !== false });
        const seen = new Set(tools.map((t: any) => t?.name));
        for (const t of built) if (!seen.has(t.name)) { tools.push(t); seen.add(t.name); }
      }
      // TOOL-USE RESILIENCE + HONESTY — appended to EVERY agent turn's system prompt, connector-
      // agnostic. A single tool error must NOT end the task or produce a false "done": the model
      // must adapt (the error often names the correct tool / valid args) and report truthfully.
      const system = `${body.system ? body.system + '\n\n' : ''}${AGENT_RESILIENCE_DIRECTIVE}`;
      let turn: Awaited<ReturnType<typeof runAgentTurn>> | undefined;
      await traceAI(
        { name: `${provider}.${model}`, kind: 'llm', provider, model, userId, input: { system: body.system, messages: body.messages, tools: tools.map((t: any) => t?.name) } },
        async () => {
          turn = await runAgentTurn({
            model,
            provider: body.provider,
            system,
            messages: body.messages,
            tools,
            maxOutputTokens: body.maxOutputTokens,
            thinking: body.thinking,
          });
          const metrics: Record<string, number> = {};
          if (typeof turn.usage?.input === 'number') metrics.input_tokens = turn.usage.input;
          if (typeof turn.usage?.output === 'number') metrics.output_tokens = turn.usage.output;
          return { status: 200, output: turn.text || `[${turn.toolCalls.length} tool call(s)]`, metrics };
        }
      );
      void recordTokenUsage(userId, provider, model, { input_tokens: turn?.usage?.input, output_tokens: turn?.usage?.output } as any, feature !== 'other' ? feature : 'chat').catch(() => {});
      return { statusCode: 200, headers: jsonHeaders(), body: JSON.stringify(turn) };
    } catch (e: any) {
      return serverError(`agent-turn failed: ${String(e?.message || e).slice(0, 300)}`);
    }
  }

  if (sub === 'agent-exec') {
    // AGENTIC CHAT loop — execute ONE tool the model requested (Phase 2, read-only).
    // The client loop calls this between model turns; the gate lives here, server-side.
    const workspaceId = String(body.workspaceId || '');
    const toolName = String(body.toolName || body.name || '');
    if (!workspaceId) return badRequest('workspaceId required');
    if (!toolName) return badRequest('toolName required');
    const { executeAgentTool } = await import('./chat/agentExec');
    try {
      const r = await executeAgentTool(userId, workspaceId, toolName, (body.args || body.input || {}) as any, { approved: body.approved === true });
      return { statusCode: 200, headers: jsonHeaders(), body: JSON.stringify(r) };
    } catch (e: any) {
      return serverError(`agent-exec failed: ${String(e?.message || e).slice(0, 300)}`);
    }
  }

  if (sub === 'proxy') {
    const targetUrl = String(body.url || '');
    let parsed: URL;
    try { parsed = new URL(targetUrl); } catch { return badRequest('Invalid url'); }
    if (parsed.protocol !== 'https:') return badRequest('Only https targets allowed');

    const host = parsed.host;
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };

    // Host whitelist → inject the matching provider key. Anything not listed is
    // refused, so this proxy can never be used as an open SSRF relay.
    if (host === 'generativelanguage.googleapis.com') {
      if (!secrets.GEMINI_API_KEY) return serverError('Gemini key not configured');
      headers['x-goog-api-key'] = secrets.GEMINI_API_KEY;
      parsed.searchParams.delete('key'); // never trust a client-supplied key param
    } else if (host === 'api.anthropic.com') {
      // Claude (Anthropic Messages API) — powers the chat model selector.
      if (!secrets.ANTHROPIC_API_KEY) return serverError('Anthropic key not configured');
      headers['x-api-key'] = secrets.ANTHROPIC_API_KEY;
      headers['anthropic-version'] = '2023-06-01';
    } else if (host === 'openrouter.ai') {
      if (!secrets.OPENROUTER_API_KEY) return serverError('OpenRouter key not configured');
      headers['Authorization'] = `Bearer ${secrets.OPENROUTER_API_KEY}`;
      headers['HTTP-Referer'] = 'https://wisprnote.com';
      headers['X-Title'] = 'WisprNote AI';
    } else if (host === 'api.openai.com') {
      // OpenAI (GPT) — DIRECT API key for the agentic chat loop.
      if (!secrets.OPENAI_API_KEY) return serverError('OpenAI key not configured');
      headers['Authorization'] = `Bearer ${secrets.OPENAI_API_KEY}`;
    } else if (host.endsWith('.turbopuffer.com')) {
      if (!secrets.TURBOPUFFER_API_KEY) return serverError('Turbopuffer key not configured');
      headers['Authorization'] = `Bearer ${secrets.TURBOPUFFER_API_KEY}`;
    } else {
      return badRequest(`Host not allowed: ${host}`);
    }

    const fwdMethod = String(body.method || 'POST').toUpperCase();
    const hasBody = fwdMethod !== 'GET' && fwdMethod !== 'HEAD' && body.body !== undefined;
    let fwdBody = hasBody
      ? (typeof body.body === 'string' ? body.body : JSON.stringify(body.body))
      : undefined;

    // MULTI-TENANT ISOLATION (server-enforced; cannot be bypassed by the client):
    // every Turbopuffer write is stamped with the authenticated user_id, and —
    // once existing chunks are backfilled and TURBOPUFFER_ENFORCE_USER_ID=1 is
    // set — every query/delete is hard-filtered to that user_id. The write-tagging
    // is always on (safe, additive); the query filter is gated so it never drops
    // un-backfilled chunks before the backfill completes.
    if (host.endsWith('.turbopuffer.com')) {
      fwdBody = tenantScopeTurbopuffer(fwdBody, userId, process.env.TURBOPUFFER_ENFORCE_USER_ID === '1');
    }

    const provider = providerFromHost(host);
    const model = modelFromRequest(provider, parsed, fwdBody);
    let inputForTrace: unknown = fwdBody;
    if (fwdBody) { try { inputForTrace = JSON.parse(fwdBody); } catch { /* keep string */ } }

    const out = await traceAI(
      {
        name: `${provider}.${model ?? 'request'}`,
        kind: provider === 'turbopuffer' ? 'function' : 'llm',
        provider,
        model,
        userId,
        input: inputForTrace,
        metadata: { path: parsed.pathname, method: fwdMethod },
      },
      async () => {
        const r = await fetchWithRetry(parsed.toString(), { method: fwdMethod, headers, body: fwdBody });
        const text = await r.text();
        return {
          status: r.ok ? 200 : r.status,
          output: text,
          metrics: usageMetrics(provider, text),
          error: r.ok ? undefined : `upstream ${r.status}`,
          body: text,
        };
      }
    );
    // Persist token usage to our DB (per user/provider/model) for billing &
    // analytics. Fire-and-forget so it never adds latency to the response.
    void recordTokenUsage(userId, provider, model, out.metrics ?? {}, feature).catch(() => {});
    return { statusCode: out.status, headers: jsonHeaders(), body: out.body };
  }

  return notFound();
}

/**
 * Server-side multi-tenant isolation for Turbopuffer. The vector index is a
 * single shared namespace, so a user's data must be partitioned by `user_id`:
 *  - WRITES (`upsert_rows`): stamp every row with the caller's user_id and
 *    declare it in the schema (always on — additive, never breaks anything).
 *  - QUERIES / DELETES (`enforce`): AND a `['user_id','Eq',userId]` filter so a
 *    query can NEVER return another tenant's chunks. Gated behind an env flag
 *    because existing chunks have no user_id yet — enable only after backfill.
 */
function tenantScopeTurbopuffer(rawBody: string | undefined, userId: string, enforce: boolean): string | undefined {
  if (!rawBody || !userId) return rawBody;
  let obj: any;
  try { obj = JSON.parse(rawBody); } catch { return rawBody; }
  if (!obj || typeof obj !== 'object') return rawBody;

  if (Array.isArray(obj.upsert_rows)) {
    obj.upsert_rows = obj.upsert_rows.map((r: any) => ({ ...r, user_id: userId }));
    obj.schema = { ...(obj.schema || {}), user_id: { type: 'string' } };
  }

  if (enforce) {
    const withUser = (f: any) => (f ? ['And', [f, ['user_id', 'Eq', userId]]] : ['user_id', 'Eq', userId]);
    if (Array.isArray(obj.queries)) {
      obj.queries = obj.queries.map((q: any) => ({ ...q, filters: withUser(q.filters) }));
    } else if (obj.rank_by) {
      obj.filters = withUser(obj.filters);
    }
    if (obj.delete_by_filter) obj.delete_by_filter = withUser(obj.delete_by_filter);
  }

  return JSON.stringify(obj);
}

/**
 * Fetch with exponential backoff on transient provider errors (429 / 502 / 503 /
 * 504). At scale, provider rate limits (429) are routine; retrying with backoff
 * (honoring Retry-After) turns a user-facing failure into a brief delay. Caps
 * total added latency so it never hangs the request.
 */
/**
 * Appended to every agentic chat turn's system prompt. Makes the loop resilient + honest across ALL
 * connectors (no per-tool rules): recover from a tool error by adapting, and never claim success for
 * an action that failed or wasn't executed. Mirrors the reference agent's error-as-feedback loop.
 */
const AGENT_RESILIENCE_DIRECTIVE = [
  'TOOL USE — RESILIENCE & HONESTY (applies to every tool, every connector):',
  '• A tool error is NOT the end of the task — it is feedback. Read it: it usually names the correct tool or the valid arguments (e.g. "the server currently offers: …"). Immediately RETRY with the corrected tool name / arguments. If one tool cannot do it, try an alternative tool or a different approach before giving up.',
  '• NEVER say a task is "done", "completed", or "posted" if its tool call errored, was blocked, needed approval, or was never successfully executed. That is a false claim. Instead, state exactly what succeeded, what failed and why, and either retry or tell the user precisely what you need from them.',
  '• An action that changes a connected tool (send a message, create/edit a ticket, etc.) is only complete once its tool call actually returns success. A request for approval is not completion.',
  '• Keep working the task across as many tool calls as it takes; only stop when you have genuinely finished it or have a specific blocker to report.',
].join('\n');

const RETRYABLE = new Set([429, 502, 503, 504]);
async function fetchWithRetry(url: string, init: any, maxRetries = 2): Promise<Response> {
  let attempt = 0;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await fetch(url, init);
    if (!RETRYABLE.has(r.status) || attempt >= maxRetries) return r;
    const retryAfter = Number(r.headers.get('retry-after'));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
      ? Math.min(retryAfter * 1000, 8000)
      : Math.min(400 * 2 ** attempt, 4000); // 400ms, 800ms, …
    await new Promise((res) => setTimeout(res, waitMs));
    attempt++;
  }
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  };
}
