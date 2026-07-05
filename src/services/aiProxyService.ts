import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';
import { MODELS } from '../config/models';

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
    host === 'api.anthropic.com' ||
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

  // Usage analytics: forward the caller's feature tag (set via the X-Usage-Feature header on
  // the original init) so the proxy attributes this call's tokens to the right product function.
  let feature = 'other';
  try { feature = new Headers(init.headers as any).get('X-Usage-Feature') || 'other'; } catch { /* no headers */ }

  return baseFetch(`${API_BASE}/ai/proxy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'X-Usage-Feature': feature },
    body: JSON.stringify({ url, method, body }),
    signal: init.signal ?? undefined,
  });
}) as typeof globalThis.fetch;

/**
 * Transcribe a short voice clip (recorded in the chat box) to text via the authed
 * backend (Deepgram prerecorded; key stays server-side). Returns the transcript.
 */
export async function transcribeAudioBlob(blob: Blob): Promise<string> {
  const token = await getIdToken();
  // blob → base64 (no data: prefix)
  const base64: string = await new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const result = String(reader.result || '');
      resolve(result.includes(',') ? result.split(',')[1] : result);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
  // Send the base container type only (e.g. "audio/webm"), not
  // "audio/webm;codecs=opus", so Deepgram gets a Content-Type it recognises.
  const mimetype = (blob.type || 'audio/webm').split(';')[0].trim() || 'audio/webm';
  const resp = await baseFetch(`${API_BASE}/ai/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify({ audio: base64, mimetype }),
  });
  if (!resp.ok) throw new Error(`Transcription failed: ${resp.status}`);
  const data = await resp.json();
  return (data.text || '').trim();
}

/** Is the server-side chat agent enabled? (Off by default — opt in after deploy.) */
export function isServerChatEnabled(): boolean {
  return import.meta.env.VITE_SERVER_CHAT === '1';
}

export interface ServerChatResult {
  answer: string;
  meetings: Array<{ id: string; title: string; date: string }>;
  scope?: string;
  dateLabel?: string;
  sources?: string[];
  // Present when the message was an action request: an editable Jira proposal (HITL).
  proposal?: import('./jiraActionService').JiraActionProposal;
  jiraMeta?: import('./jiraActionService').JiraMeta;
  // Generic write proposals from the MCP agent (Confluence, worklog, links, …) — HITL.
  mcpProposals?: import('./jiraActionService').McpWriteProposal[];
}

/**
 * Call the SERVER-SIDE chat agent (Tier-0 architecture): retrieval + grounded
 * synthesis run entirely in the Lambda, tenant-isolated and bounded — the corpus
 * never reaches the browser. Returns the answer + the meetings it used.
 */
export async function serverChat(opts: {
  query: string;
  scope?: 'all' | 'workspace' | 'space' | 'single';
  workspaceId?: string;
  /** When scope==='space': restrict retrieval to meetings filed in this space. */
  spaceId?: string;
  taskId?: string;
  history?: Array<{ role: 'user' | 'model'; text: string }>;
  model?: 'gemini' | 'claude';
}): Promise<ServerChatResult> {
  const token = await getIdToken();
  const resp = await baseFetch(`${API_BASE}/ai/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(opts),
  });
  if (!resp.ok) throw new Error(`Server chat failed: ${resp.status}`);
  return resp.json();
}

/**
 * Report a finished transcription session's audio duration to the backend so it
 * lands in Braintrust + usage metering. The realtime meeting stream goes
 * client → Deepgram directly (over a WebSocket), so unlike the proxied
 * intelligence calls it can't be traced server-side — this is how realtime
 * (and batch) transcription gets full observability coverage. Best-effort:
 * never throws, never blocks the recording flow.
 */
export async function reportTranscriptionUsage(opts: {
  mode: 'realtime' | 'batch';
  durationSeconds: number;
  model?: string;
  words?: number;
  language?: string;
}): Promise<void> {
  try {
    if (!(opts.durationSeconds > 0)) return;
    const token = await getIdToken();
    await baseFetch(`${API_BASE}/ai/transcription-usage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: token },
      body: JSON.stringify({
        mode: opts.mode,
        duration_seconds: Math.round(opts.durationSeconds),
        model: opts.model || MODELS.deepgram.primary,
        words: opts.words ?? 0,
        language: opts.language || (opts.mode === 'realtime' ? 'multi' : 'en'),
      }),
    });
  } catch {
    /* observability is best-effort — never affect the recording */
  }
}

// Cache the Deepgram streaming token so Record/Resume don't pay a network
// round-trip (client → Lambda → Deepgram) on every action — that round-trip is
// the main reason the buttons felt slow / "had to be clicked many times".
let _dgToken: string | null = null;
let _dgTokenExp = 0; // epoch ms
let _dgInFlight: Promise<string> | null = null;

/** Mint (or reuse) a short-lived Deepgram streaming token via the authed proxy. */
export async function getDeepgramToken(ttlSeconds = 3600): Promise<string> {
  // Reuse the cached token until 60s before expiry.
  if (_dgToken && Date.now() < _dgTokenExp - 60_000) return _dgToken;
  // Coalesce concurrent requests so a burst of Record/Resume mints just one.
  if (_dgInFlight) return _dgInFlight;

  _dgInFlight = (async () => {
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
    const expiresIn = Number(data.expires_in) || ttlSeconds;
    _dgToken = access as string;
    _dgTokenExp = Date.now() + expiresIn * 1000;
    return _dgToken;
  })();
  try {
    return await _dgInFlight;
  } catch (e) {
    _dgToken = null;
    _dgTokenExp = 0;
    throw e;
  } finally {
    _dgInFlight = null;
  }
}

/** Drop the cached Deepgram token (call on sign-out / account switch). */
export function clearDeepgramTokenCache(): void {
  _dgToken = null;
  _dgTokenExp = 0;
  _dgInFlight = null;
}
