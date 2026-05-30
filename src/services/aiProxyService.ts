import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';

/**
 * Client-side AI proxy wrapper.
 *
 * A `fetch`-shaped function that transparently routes calls to AI providers
 * (Gemini, OpenRouter, Turbopuffer) through our authenticated Lambda proxy
 * (`POST /ai/proxy`), which injects the real provider API key server-side. This
 * is how the app talks to those providers WITHOUT shipping any key in the bundle.
 *
 * Drop-in: pass it as the `fetch` for an SDK, or call it directly in place of
 * `fetch(url, init)`. Non-provider URLs fall through to a normal fetch unchanged.
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const baseFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

// Hosts whose traffic must be proxied (key injected server-side).
function isProviderHost(host: string): boolean {
  return (
    host === 'generativelanguage.googleapis.com' ||
    host === 'openrouter.ai' ||
    host.endsWith('.turbopuffer.com')
  );
}

export const aiProxyFetch: typeof globalThis.fetch = (async (
  input: RequestInfo | URL,
  init: RequestInit = {},
): Promise<Response> => {
  const url =
    typeof input === 'string' ? input :
    input instanceof URL ? input.toString() :
    (input as Request).url;

  let host = '';
  try { host = new URL(url).host; } catch { /* fall through */ }

  // Not a provider call → behave like a normal fetch.
  if (!host || !isProviderHost(host)) {
    return baseFetch(input as any, init);
  }

  const token = await getIdToken();
  const method = (init.method || 'GET').toUpperCase();
  const body =
    init.body == null ? undefined :
    typeof init.body === 'string' ? init.body :
    JSON.stringify(init.body);

  return baseFetch(`${API_BASE}/ai/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ url, method, body }),
    signal: init.signal ?? undefined,
  });
}) as typeof globalThis.fetch;

/** Mint a short-lived Deepgram streaming token via the authed proxy. */
export async function getDeepgramToken(ttlSeconds = 3600): Promise<string> {
  const token = await getIdToken();
  const resp = await baseFetch(`${API_BASE}/ai/deepgram-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ ttl_seconds: ttlSeconds }),
  });
  if (!resp.ok) {
    // 403 = the server's Deepgram key lacks the Member+ role needed to mint
    // streaming tokens. Surface an actionable message, not a bare status code.
    if (resp.status === 403) {
      throw new Error(
        'Live transcription unavailable: the Deepgram key needs "Member" role to issue streaming tokens. Update the key in Deepgram, then retry.'
      );
    }
    throw new Error(`Deepgram token request failed: ${resp.status}`);
  }
  const data = await resp.json();
  const access = data.access_token || data.accessToken;
  if (!access) throw new Error('Deepgram token response missing access_token');
  return access as string;
}
