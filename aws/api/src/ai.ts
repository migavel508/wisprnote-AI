import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { badRequest, serverError, notFound } from './response';
import { getSecrets } from './secrets';

/**
 * Authenticated AI proxy. Every route sits BEHIND verifyToken (see the router in
 * index.ts), so only signed-in users reach it. Provider API keys live ONLY in
 * Secrets Manager and are injected here, server-side — they never ship in the
 * client bundle.
 *
 * Routes (segments[1]):
 *   POST /ai/proxy          → host-whitelisted passthrough: client sends
 *                             { url, method, body }; we inject the right
 *                             provider auth header and forward verbatim. Handles
 *                             Gemini, OpenRouter, Turbopuffer uniformly (any
 *                             endpoint/shape) with no per-shape code.
 *   POST /ai/deepgram-token → mint a short-lived Deepgram streaming token.
 */
export async function handleAI(
  method: string,
  segments: string[],
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
    const r = await fetch('https://api.deepgram.com/v1/auth/grant', {
      method: 'POST',
      headers: { Authorization: `Token ${secrets.DEEPGRAM_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ ttl_seconds: ttl }),
    });
    const text = await r.text();
    return { statusCode: r.ok ? 200 : r.status, headers: jsonHeaders(), body: text };
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

    const r = await fetch(parsed.toString(), { method: fwdMethod, headers, body: fwdBody });
    const text = await r.text();
    return { statusCode: r.ok ? 200 : r.status, headers: jsonHeaders(), body: text };
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
