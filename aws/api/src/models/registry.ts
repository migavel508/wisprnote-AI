/**
 * SERVER-SIDE MODEL REGISTRY — the single source of truth for which model
 * version each server-side task uses.
 *
 * Why this exists: model strings used to be hardcoded inline across kgExtract,
 * kgLink, kgEmbed, chatAgent and ai.ts, which drifted out of sync. To change a
 * model version, edit it HERE — not at the call sites.
 *
 * Each entry pins a `primary` model plus optional ordered `fallbacks` (tried in
 * order on 404/unavailable/throttle). `chain()` flattens them into the array the
 * call sites iterate.
 *
 * NOTE: the client has its own registry (`src/config/models.ts`) — the browser
 * (Vite) and Lambda (esbuild) are separate build units, so they can't share one
 * file. Keep cross-runtime choices intentionally aligned.
 */

export type Provider = 'gemini' | 'anthropic' | 'deepgram';

export interface ModelSpec {
  provider: Provider;
  primary: string;
  fallbacks?: string[];
}

export const MODELS = {
  /** Stage A — per-meeting knowledge-graph extraction (kgExtract.ts). */
  kgExtract: { provider: 'gemini', primary: 'gemini-3-flash-preview', fallbacks: ['gemini-3.1-flash-lite'] },
  /** Stage B — meeting + topic embeddings (kgEmbed.ts). 3072-dim; must match the Turbopuffer index. */
  embeddings: { provider: 'gemini', primary: 'gemini-embedding-001', fallbacks: ['text-embedding-004'] },
  /** Stage C — cross-meeting relationship reasoning (kgLink.ts). */
  kgLink: { provider: 'gemini', primary: 'gemini-3-flash-preview', fallbacks: ['gemini-3.1-flash-lite'] },
  /** Server chat agent — Claude synthesis path (chatAgent.ts). */
  chatClaude: { provider: 'anthropic', primary: 'claude-sonnet-4-6' },
  /** Server chat agent — Gemini synthesis / fallback path (chatAgent.ts).
   *  DRIFT: still gemini-2.5-flash while the KG pipeline moved to gemini-3 —
   *  left as-is by the registry migration; change here to unify. */
  chatGemini: { provider: 'gemini', primary: 'gemini-2.5-flash' },
  /** Audio transcription — Deepgram (ai.ts: /ai/transcribe, deepgram-token, metering). */
  transcription: { provider: 'deepgram', primary: 'nova-3' },
} as const satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;

/** Ordered list of models to try for a purpose: [primary, ...fallbacks]. */
export function chain(spec: ModelSpec): string[] {
  return [spec.primary, ...(spec.fallbacks ?? [])];
}
