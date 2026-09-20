/**
 * CLIENT MODEL REGISTRY — the single source of truth for which model version
 * each client-side AI task uses.
 *
 * Why this exists: model strings used to be hardcoded inline across
 * geminiService.ts, knowledgeGraph.utils.ts, kgEmbedCache.ts and App.tsx, which
 * drifted out of sync. To change a model version, edit it HERE — not at the call
 * sites.
 *
 * Each entry pins a `primary` model + optional ordered `fallbacks` (tried in
 * order on failure). `chain()` flattens them into the array call sites iterate.
 * For OpenRouter the same logical task carries an `or` variant (the provider
 * toggles via VITE_AI_PROVIDER).
 *
 * NOTE 1: user-SELECTABLE chat models (the model picker) live in
 * `src/services/chatModels.ts` — that's the canonical place for those.
 * NOTE 2: the Lambda has its own registry (`aws/api/src/models/registry.ts`) —
 * browser (Vite) and Lambda (esbuild) are separate build units.
 */

export interface ModelSpec {
  primary: string;
  fallbacks?: string[];
  /** OpenRouter equivalents (used when VITE_AI_PROVIDER === 'openrouter'). */
  or?: { primary: string; fallbacks?: string[] };
}

const FLASH: ModelSpec = { primary: 'gemini-3-flash-preview', fallbacks: ['gemini-3.1-flash-lite'] };

export const MODELS = {
  // ── Transcription ──
  /** Gemini File API transcription. Retained for the non-meeting callers in
   *  geminiService.ts; meeting audio (live AND uploaded) goes to Soniox below. */
  transcription: { ...FLASH },
  /** MEETING transcription, live — Soniox stt-rt-v5, streamed client→Soniox over a
   *  WebSocket using a short-lived key from /ai/soniox-token. Metering label
   *  client-side; the model is also pinned server-side in the API registry. */
  meetingLive: { primary: 'stt-rt-v5' },
  /** MEETING transcription, uploaded files — Soniox stt-async-v5, run server-side
   *  via /ai/soniox-transcribe. */
  meetingAsync: { primary: 'stt-async-v5' },
  /** Chat voice-input clips (Deepgram prerecorded, via /ai/transcribe). NOT the notetaker. */
  deepgram: { primary: 'nova-3' },

  // ── Per-meeting artifacts ──
  summary: { ...FLASH },
  notes: { ...FLASH },
  title: { primary: 'gemini-3.1-flash-lite', fallbacks: ['gemini-3.1-flash-lite'] },
  email: { primary: 'gemini-3-flash-preview' },
  wiki: { primary: 'gemini-3-flash-preview' },
  podcastScript: { primary: 'gemini-3-flash-preview' },
  podcastChat: { primary: 'gemini-3-flash-preview' },

  // ── Chat / agent ──
  chatPlan: { ...FLASH },
  groundedVerifier: { primary: 'gemini-3.1-flash-lite', fallbacks: ['gemini-3.1-flash-lite'] },
  singleMeetingChat: { ...FLASH },
  crossMeetingSynth: { ...FLASH },
  /** All-meetings agentic chat (native Gemini path). DRIFT: 2.5-flash while the
   *  rest moved to gemini-3 — left as-is by the registry migration. */
  agentNative: { primary: 'gemini-2.5-flash', fallbacks: ['gemini-3.1-flash-lite'], or: { primary: 'google/gemini-3.1-flash-lite' } },
  agentClaudeFallback: { primary: 'claude-sonnet-4-6' },

  // ── Knowledge graph (client-side path / fallback) ──
  kgExtract: { ...FLASH },
  /** Cross-meeting relationship extraction (knowledgeGraph.utils EXTRACT_MODEL). */
  relationshipExtract: { primary: 'gemini-3-flash-preview' },
  /** Embeddings — 3072-dim; must match the Turbopuffer `lumina-meetings` index. */
  embeddings: {
    primary: 'gemini-embedding-001',
    fallbacks: ['text-embedding-004'],
    or: { primary: 'google/gemini-embedding-001', fallbacks: ['openai/text-embedding-3-large'] },
  },

  // ── Image generation ──
  conceptImage: {
    primary: 'gemini-3.1-flash-image-preview',
    fallbacks: ['gemini-2.5-flash-image-preview'],
    or: { primary: 'google/gemini-2.5-flash-image', fallbacks: ['google/gemini-2.0-flash-exp'] },
  },
  notesVisualization: {
    primary: 'gemini-3.1-flash-image-preview',
    fallbacks: ['gemini-2.5-flash-image-preview'],
    or: { primary: 'google/gemini-2.5-flash-image', fallbacks: ['google/gemini-2.0-flash-exp'] },
  },
} satisfies Record<string, ModelSpec>;

export type ModelKey = keyof typeof MODELS;

/** Ordered list of models to try for a purpose: [primary, ...fallbacks]. */
export function chain(spec: ModelSpec): string[] {
  return [spec.primary, ...(spec.fallbacks ?? [])];
}

/** OpenRouter-aware chain: returns the `or` variant when provider is openrouter. */
export function chainFor(spec: ModelSpec, provider: 'gemini' | 'openrouter'): string[] {
  if (provider === 'openrouter' && spec.or) return [spec.or.primary, ...(spec.or.fallbacks ?? [])];
  return chain(spec);
}
