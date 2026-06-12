import { initLogger, traced, flush, type Span } from 'braintrust';
import { getSecrets } from './secrets';

/**
 * Braintrust LLM observability.
 *
 * Every AI provider call in the app flows through the authed proxy in `ai.ts`,
 * so instrumenting there gives 100% coverage of model traffic from one place —
 * Gemini (chat + embeddings), Claude, OpenRouter, Turbopuffer, Deepgram — each
 * traced with model, latency, token usage, status, and the signed-in user.
 *
 * Tracing is a strict no-op until BRAINTRUST_API_KEY is present in Secrets
 * Manager, and every logging path is wrapped so observability can NEVER break a
 * user-facing AI call. Deploying this without the key changes nothing.
 */

const PROJECT = process.env.BRAINTRUST_PROJECT || 'wisprnote-ai';
// Log full request/response bodies (meeting content) to Braintrust. Set
// BRAINTRUST_LOG_CONTENT=0 to log metadata only (model/latency/tokens/status).
const LOG_CONTENT = (process.env.BRAINTRUST_LOG_CONTENT ?? '1') !== '0';
const MAX_FIELD = 100_000; // cap any single logged field (~100 KB)

let initStarted = false;
let enabled = false;

/** Initialise the Braintrust logger once per warm container. */
async function ensureBraintrust(): Promise<boolean> {
  if (initStarted) return enabled;
  initStarted = true;
  try {
    const secrets = await getSecrets();
    if (!secrets.BRAINTRUST_API_KEY) return (enabled = false);
    initLogger({ projectName: PROJECT, apiKey: secrets.BRAINTRUST_API_KEY });
    enabled = true;
  } catch (e) {
    console.error('Braintrust init failed (tracing disabled):', e);
    enabled = false;
  }
  return enabled;
}

function clip(v: unknown): unknown {
  if (v == null) return undefined;
  if (!LOG_CONTENT) return '[content logging disabled]';
  try {
    if (typeof v === 'string') {
      return v.length > MAX_FIELD ? `${v.slice(0, MAX_FIELD)}…[+${v.length - MAX_FIELD} chars]` : v;
    }
    const s = JSON.stringify(v);
    if (s.length <= MAX_FIELD) return v;
    return `${s.slice(0, MAX_FIELD)}…[+${s.length - MAX_FIELD} chars]`;
  } catch {
    return '[unserializable]';
  }
}

export type SpanKind = 'llm' | 'function';

export interface AISpanMeta {
  /** Span name, e.g. "gemini.generateContent". */
  name: string;
  kind?: SpanKind;
  provider: string;
  model?: string;
  userId?: string;
  /** Request payload (logged as span input). */
  input?: unknown;
  /** Extra metadata to attach. */
  metadata?: Record<string, unknown>;
}

export interface AISpanResult {
  status: number;
  /** Response payload (logged as span output). */
  output?: unknown;
  /** Token / cost metrics. */
  metrics?: Record<string, number>;
  /** Error message, if the call failed. */
  error?: string;
}

/**
 * Trace one AI provider call. `fn` performs the call and returns the API result
 * plus what to log. Returns whatever `fn` returns; logging failures are swallowed
 * so the AI call is never affected.
 */
export async function traceAI<T extends AISpanResult>(
  meta: AISpanMeta,
  fn: () => Promise<T>,
): Promise<T> {
  if (!(await ensureBraintrust())) return fn();
  const start = Date.now();
  try {
    return await traced(
      async (span: Span) => {
        let res: T;
        try {
          res = await fn();
        } catch (err: any) {
          try {
            span.log({
              input: clip(meta.input),
              metadata: { provider: meta.provider, model: meta.model, user_id: meta.userId, ...meta.metadata, error: String(err?.message || err) },
              metrics: { latency_ms: Date.now() - start },
            });
          } catch { /* never break the call */ }
          throw err;
        }
        try {
          span.log({
            input: clip(meta.input),
            output: clip(res.output),
            metadata: {
              provider: meta.provider,
              model: meta.model,
              user_id: meta.userId,
              status: res.status,
              ...(res.error ? { error: res.error } : {}),
              ...meta.metadata,
            },
            metrics: { ...(res.metrics ?? {}), latency_ms: Date.now() - start },
          });
        } catch { /* never break the call */ }
        return res;
      },
      { name: meta.name, type: (meta.kind ?? 'llm') as any },
    );
  } catch (e) {
    // traced() itself failed (e.g. logger issue) — fall back to a raw call so
    // observability can never take down a real request.
    if (e instanceof Error && (e as any).__fromFn) throw e;
    return fn();
  }
}

/** Flush queued spans before the Lambda freezes. Safe to call when disabled. */
export async function flushBraintrust(): Promise<void> {
  if (!enabled) return;
  try {
    await flush();
  } catch (e) {
    console.error('Braintrust flush failed:', e);
  }
}

// ─── Provider/model/usage parsing helpers ────────────────────────────────────

export function providerFromHost(host: string): string {
  if (host === 'generativelanguage.googleapis.com') return 'gemini';
  if (host === 'api.anthropic.com') return 'anthropic';
  if (host === 'openrouter.ai') return 'openrouter';
  if (host.endsWith('.turbopuffer.com')) return 'turbopuffer';
  return host;
}

/** Best-effort model id from the request URL/body for the given provider. */
export function modelFromRequest(provider: string, url: URL, body: string | undefined): string | undefined {
  try {
    if (provider === 'gemini') {
      // .../models/{model}:generateContent  (or :batchEmbedContents, :embedContent)
      const m = url.pathname.match(/\/models\/([^:/]+)[:/]/);
      return m?.[1];
    }
    if (provider === 'anthropic' || provider === 'openrouter') {
      if (!body) return undefined;
      const parsed = JSON.parse(body);
      return typeof parsed?.model === 'string' ? parsed.model : undefined;
    }
  } catch { /* ignore */ }
  return undefined;
}

/** Pull token-usage metrics out of a provider response body (best-effort). */
export function usageMetrics(provider: string, responseText: string): Record<string, number> {
  try {
    const d = JSON.parse(responseText);
    if (provider === 'anthropic' && d?.usage) {
      return {
        input_tokens: Number(d.usage.input_tokens) || 0,
        output_tokens: Number(d.usage.output_tokens) || 0,
        total_tokens: (Number(d.usage.input_tokens) || 0) + (Number(d.usage.output_tokens) || 0),
      };
    }
    if (provider === 'gemini' && d?.usageMetadata) {
      const u = d.usageMetadata;
      return {
        input_tokens: Number(u.promptTokenCount) || 0,
        output_tokens: Number(u.candidatesTokenCount) || 0,
        total_tokens: Number(u.totalTokenCount) || 0,
      };
    }
    if (provider === 'openrouter' && d?.usage) {
      return {
        input_tokens: Number(d.usage.prompt_tokens) || 0,
        output_tokens: Number(d.usage.completion_tokens) || 0,
        total_tokens: Number(d.usage.total_tokens) || 0,
      };
    }
  } catch { /* ignore */ }
  return {};
}
