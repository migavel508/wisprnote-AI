import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { badRequest, serverError, notFound } from './response';
import { getSecrets } from './secrets';
import {
  traceAI,
  flushBraintrust,
  providerFromHost,
  modelFromRequest,
  usageMetrics,
} from './observability';
import { recordTokenUsage } from './usage';

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
      { name: 'deepgram.transcribe', kind: 'function', provider: 'deepgram', model: 'nova-3', userId, input: `[audio ${audioBuf.length} bytes, ${mimetype}]`, metadata: { mimetype } },
      async () => {
        // English-only, max accuracy on Nova-3:
        //  - language=en pins the English-optimized path (no language detection /
        //    multilingual code-switching, which degrades English accuracy).
        //  - smart_format + punctuate clean up casing, punctuation, numbers.
        //  - filler_words=false drops "um/uh" for clean chat input.
        const dgParams = new URLSearchParams({
          model: 'nova-3',
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
        return { status: r.ok ? 200 : r.status, output: text, body: JSON.stringify({ text }) };
      }
    );
    return { statusCode: out.status, headers: jsonHeaders(), body: out.body };
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
    } else if (host.endsWith('.turbopuffer.com')) {
      if (!secrets.TURBOPUFFER_API_KEY) return serverError('Turbopuffer key not configured');
      headers['Authorization'] = `Bearer ${secrets.TURBOPUFFER_API_KEY}`;
    } else {
      return badRequest(`Host not allowed: ${host}`);
    }

    const fwdMethod = String(body.method || 'POST').toUpperCase();
    const hasBody = fwdMethod !== 'GET' && fwdMethod !== 'HEAD' && body.body !== undefined;
    const fwdBody = hasBody
      ? (typeof body.body === 'string' ? body.body : JSON.stringify(body.body))
      : undefined;

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
        const r = await fetch(parsed.toString(), { method: fwdMethod, headers, body: fwdBody });
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
    // analytics — separate from the Braintrust trace. Never blocks the response.
    await recordTokenUsage(userId, provider, model, out.metrics ?? {});
    return { statusCode: out.status, headers: jsonHeaders(), body: out.body };
  }

  return notFound();
}

function jsonHeaders() {
  return {
    'Content-Type': 'application/json',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
  };
}
