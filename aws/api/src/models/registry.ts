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

export type Provider = 'gemini' | 'anthropic' | 'deepgram' | 'soniox' | 'openai' | 'openrouter';

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
  /** Brain alignment verdict (brainLink.ts) — the CEO-facing "does shipped work match
   *  what was decided?" judgment. Quality-first: Sonnet primary, Gemini 3.1 Pro fallback
   *  (cross-provider; the verdict caller switches endpoints). NOT Opus (cost). Runs on a
   *  SMALL volume (1 batched call per meeting over its top-K candidates), so premium-rate
   *  here is affordable. Diff COMPRESSION (Tier 2) stays on cheap Flash (kgExtract). */
  brainVerdict: { provider: 'anthropic', primary: 'claude-sonnet-4-6', fallbacks: ['gemini-3-flash-preview', 'gemini-2.5-pro'] },
  /** Server chat agent — Gemini synthesis / fallback path (chatAgent.ts).
   *  DRIFT: still gemini-2.5-flash while the KG pipeline moved to gemini-3 —
   *  left as-is by the registry migration; change here to unify. */
  chatGemini: { provider: 'gemini', primary: 'gemini-2.5-flash' },
  /** Chat voice-input clips — Deepgram prerecorded (ai.ts: /ai/transcribe).
   *  NOT the notetaker; meeting audio goes to Soniox (below). */
  transcription: { provider: 'deepgram', primary: 'nova-3' },
  /** MEETING transcription, live — Soniox over WebSocket. The desktop client
   *  streams directly using a temporary key from ai.ts: /ai/soniox-token. */
  meetingLive: { provider: 'soniox', primary: 'stt-rt-v5' },
  /** MEETING transcription, uploaded files — Soniox async (ai.ts: /ai/soniox-transcribe). */
  meetingAsync: { provider: 'soniox', primary: 'stt-async-v5' },
  /** AGENTIC CHAT loop — the default tool-use model. Claude via DIRECT Anthropic API
   *  (NOT OpenRouter). The loop is model-agnostic via the agentTurn provider abstraction;
   *  this is just the default when the user hasn't picked a model. Strong tool-use +
   *  cost-reasonable (matches chatClaude); the user can pick GPT/Gemini in the picker. */
  agentChat: { provider: 'anthropic', primary: 'claude-sonnet-4-6' },
} as const satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;

/** Ordered list of models to try for a purpose: [primary, ...fallbacks]. */
export function chain(spec: ModelSpec): string[] {
  return [spec.primary, ...(spec.fallbacks ?? [])];
}
