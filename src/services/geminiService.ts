import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { AudioBatch, blobToBase64, BlobReadError } from "./audioService";
import { logger } from '../lib/logger';
import { formatDisplayName } from '../lib/displayName';

const log = logger.scope('Gemini');

const GEMINI_API_KEY = process.env.GEMINI_API_KEY || "";
const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

// In the Tauri desktop app, route large uploads (inline audio) through the Rust
// HTTP stack instead of the WebView's fetch. WebKit drops big multi-MB request
// bodies with "Load failed" / "connection lost"; the Rust client doesn't.
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const httpFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

/**
 * Calls the Gemini generateContent REST endpoint directly via the Tauri HTTP
 * plugin (Rust networking). Used for the audio-transcription batches whose large
 * inline-base64 payloads fail through the WebView's fetch. Returns the same
 * minimal shape (`text` + `candidates`) the rest of the code expects.
 */
async function geminiGenerateContentRest(requestOptions: any, timeoutMs = 120000): Promise<GenerateContentResponse> {
  if (!GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not configured');

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(requestOptions.model)}:generateContent`;
  const body: any = { contents: requestOptions.contents };
  const cfg = requestOptions.config;
  if (cfg) {
    if (cfg.systemInstruction) {
      body.systemInstruction = typeof cfg.systemInstruction === 'string'
        ? { parts: [{ text: cfg.systemInstruction }] }
        : cfg.systemInstruction;
    }
    const gen: any = {};
    if (cfg.temperature !== undefined) gen.temperature = cfg.temperature;
    if (cfg.maxOutputTokens !== undefined) gen.maxOutputTokens = cfg.maxOutputTokens;
    if (cfg.responseMimeType) gen.responseMimeType = cfg.responseMimeType;
    if (Object.keys(gen).length) body.generationConfig = gen;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let resp: Response;
  try {
    resp = await httpFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': GEMINI_API_KEY },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
  } catch (e: any) {
    const aborted = e?.name === 'AbortError' || controller.signal.aborted;
    const err: any = new Error(aborted
      ? `Gemini request timed out after ${Math.round(timeoutMs / 1000)}s`
      : `Network error: ${e?.message || 'fetch failed'}`);
    err.status = 0;
    err.code = aborted ? 'TIMEOUT' : 'NETWORK';
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    const errText = await resp.text();
    const error: any = new Error(`Gemini error (${resp.status}): ${errText}`);
    error.status = resp.status;
    throw error;
  }

  const data = await resp.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];
  const text = parts.map((p: any) => (typeof p.text === 'string' ? p.text : '')).join('');
  return { text, candidates: data.candidates } as any;
}

// ─── AI Provider Configuration ───────────────────────────────────────────────
type AIProvider = 'gemini' | 'openrouter';

function getProvider(): AIProvider {
  const p = (import.meta as any).env?.VITE_AI_PROVIDER ||
    process.env.VITE_AI_PROVIDER || 'gemini';
  return p === 'openrouter' ? 'openrouter' : 'gemini';
}

function getOpenRouterKey(): string {
  return (import.meta as any).env?.VITE_OPENROUTER_API_KEY ||
    process.env.VITE_OPENROUTER_API_KEY || '';
}

function toOpenRouterModel(model: string): string {
  if (model.startsWith('google/')) return model;
  return `google/${model}`;
}

function getOpenRouterImageModel(): string {
  return (import.meta as any).env?.VITE_OPENROUTER_IMAGE_MODEL ||
    process.env.VITE_OPENROUTER_IMAGE_MODEL ||
    'google/gemini-2.5-flash-image';
}

// Fetch with a hard timeout + clearer network error messages. Without this,
// a dropped connection can leave OpenRouter requests hanging for minutes
// before the browser eventually gives up.
async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = 60000
): Promise<Response> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) {
    const err: any = new Error('Network connection lost — you appear to be offline.');
    err.status = 0;
    err.code = 'OFFLINE';
    throw err;
  }

  const controller = new AbortController();
  const externalSignal = (init as any).signal as AbortSignal | undefined;
  if (externalSignal) {
    if (externalSignal.aborted) controller.abort();
    else externalSignal.addEventListener('abort', () => controller.abort(), { once: true });
  }
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (e: any) {
    const isAbort = e?.name === 'AbortError' || controller.signal.aborted;
    if (isAbort) {
      const err: any = new Error(`Request timed out after ${Math.round(timeoutMs / 1000)}s — network connection lost or API too slow.`);
      err.status = 0;
      err.code = 'TIMEOUT';
      throw err;
    }
    // TypeError from fetch usually means DNS/TCP failure (no internet, CORS, server down).
    if (e instanceof TypeError) {
      const err: any = new Error(`Network error: ${e.message || 'fetch failed'} — check your internet connection.`);
      err.status = 0;
      err.code = 'NETWORK';
      throw err;
    }
    throw e;
  } finally {
    clearTimeout(timer);
  }
}

// Convert Google GenAI content format → OpenAI-compatible messages
function convertToOpenAIMessages(
  contents: any,
  config?: any
): Array<{ role: string; content: any }> {
  const msgs: Array<{ role: string; content: any }> = [];

  if (config?.systemInstruction) {
    let sys = config.systemInstruction;
    if (config?.responseSchema) {
      sys += `\n\nYou MUST respond with valid JSON matching this schema:\n${JSON.stringify(config.responseSchema, null, 2)}`;
    }
    msgs.push({ role: 'system', content: sys });
  } else if (config?.responseSchema) {
    msgs.push({
      role: 'system',
      content: `You MUST respond with valid JSON matching this schema:\n${JSON.stringify(config.responseSchema, null, 2)}`,
    });
  }

  if (typeof contents === 'string') {
    msgs.push({ role: 'user', content: contents });
    return msgs;
  }

  if (contents && !Array.isArray(contents) && contents.parts) {
    msgs.push({ role: 'user', content: convertParts(contents.parts) });
    return msgs;
  }

  if (Array.isArray(contents)) {
    for (const msg of contents) {
      const role = msg.role === 'model' ? 'assistant' : (msg.role || 'user');
      if (msg.parts) {
        msgs.push({ role, content: convertParts(msg.parts) });
      }
    }
  }

  return msgs;
}

const AUDIO_MIMES = new Set([
  'audio/wav', 'audio/x-wav', 'audio/mpeg', 'audio/mp3', 'audio/mp4',
  'audio/aac', 'audio/ogg', 'audio/flac', 'audio/aiff', 'audio/m4a',
  'audio/webm',
]);

function mimeToAudioFormat(mime: string): string {
  const map: Record<string, string> = {
    'audio/wav': 'wav', 'audio/x-wav': 'wav',
    'audio/mpeg': 'mp3', 'audio/mp3': 'mp3',
    'audio/mp4': 'm4a', 'audio/m4a': 'm4a',
    'audio/aac': 'aac', 'audio/ogg': 'ogg',
    'audio/flac': 'flac', 'audio/aiff': 'aiff',
    'audio/webm': 'wav',
  };
  return map[mime] || 'wav';
}

function convertParts(parts: any[]): any {
  const hasMultimodal = parts.some((p: any) => p.inlineData);
  if (!hasMultimodal) {
    return parts.filter((p: any) => p.text).map((p: any) => p.text).join('\n');
  }
  return parts.map((p: any) => {
    if (p.text) return { type: 'text' as const, text: p.text };
    if (p.inlineData) {
      const mime = p.inlineData.mimeType || '';
      if (AUDIO_MIMES.has(mime)) {
        return {
          type: 'input_audio' as const,
          input_audio: {
            data: p.inlineData.data,
            format: mimeToAudioFormat(mime),
          },
        };
      }
      return {
        type: 'image_url' as const,
        image_url: {
          url: `data:${mime};base64,${p.inlineData.data}`,
        },
      };
    }
    if (p.fileData) {
      return { type: 'text' as const, text: `[File reference: ${p.fileData.fileUri}]` };
    }
    return { type: 'text' as const, text: '' };
  });
}

async function callOpenRouter(requestOptions: any): Promise<GenerateContentResponse> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error('VITE_OPENROUTER_API_KEY is not configured');

  const model = toOpenRouterModel(requestOptions.model);
  const messages = convertToOpenAIMessages(requestOptions.contents, requestOptions.config);

  const body: any = { model, messages };
  if (requestOptions.config?.maxOutputTokens) body.max_tokens = requestOptions.config.maxOutputTokens;
  if (requestOptions.config?.temperature !== undefined) body.temperature = requestOptions.config.temperature;
  if (requestOptions.config?.responseMimeType === 'application/json') {
    body.response_format = { type: 'json_object' };
  }

  const response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://wisprnote.app',
      'X-Title': 'WisprNote AI',
    },
    body: JSON.stringify(body),
  }, 90000);

  if (!response.ok) {
    const errText = await response.text();
    const error: any = new Error(`OpenRouter error (${response.status}): ${errText}`);
    error.status = response.status;
    throw error;
  }

  const data = await response.json();
  const text = data.choices?.[0]?.message?.content || '';

  return {
    text,
    candidates: [{ content: { parts: [{ text }] } }],
  } as any;
}

// Unified content generation — routes to OpenRouter or Gemini based on provider.
// Wrap in withRetry so transient network drops / timeouts auto-recover.
async function generateContent(requestOptions: any): Promise<GenerateContentResponse> {
  if (getProvider() === 'openrouter') {
    return withRetry(() => callOpenRouter(requestOptions), 4);
  }
  return withRetry(() => ai.models.generateContent(requestOptions), 4);
}

// ─── Retry Utility ───────────────────────────────────────────────────────────
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_MSGS = ['rate limit', 'quota', 'overloaded', 'fetch failed', 'network error', 'timed out', 'timeout', 'aborted', 'etimedout', 'econnreset', 'enotfound'];

function parseRetryDelayMs(error: any): number | null {
  const msg = String(error?.message || '');
  const secMatch = msg.match(/"retryDelay"\s*:\s*"(\d+)s"/i) || msg.match(/retryDelay[^0-9]*(\d+)s/i);
  if (secMatch?.[1]) return Number(secMatch[1]) * 1000;
  const msMatch = msg.match(/"retryDelay"\s*:\s*"(\d+)ms"/i) || msg.match(/retryDelay[^0-9]*(\d+)ms/i);
  if (msMatch?.[1]) return Number(msMatch[1]);
  return null;
}

async function withRetry<T>(fn: () => Promise<T>, maxRetries = 5, baseDelayMs = 2000): Promise<T> {
  let lastError: any;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      if (attempt === maxRetries) break;
      
      const status: number = error.status ?? error.statusCode ?? error?.error?.code ?? error?.code ?? 0;
      const msg = (error.message ?? '').toLowerCase();

      // Bail out immediately if the device is offline — retrying won't help and
      // wastes the user's time. The next user action will trigger a fresh try.
      if (error?.code === 'OFFLINE' || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
        throw error;
      }

      const retryable = RETRYABLE_STATUSES.has(status) ||
        RETRYABLE_MSGS.some(m => msg.includes(m)) ||
        status === 0;

      if (!retryable) throw error;

      // Rate-limit (429) and quota errors need a much longer cooldown than
      // transient 5xx errors — the API typically enforces a 30-60s window.
      const isRateLimit = status === 429 || msg.includes('rate limit') || msg.includes('quota') || msg.includes('resource exhausted');
      const suggestedDelay = parseRetryDelayMs(error);
      const computedDelay = isRateLimit
        ? Math.min(20000 * Math.pow(1.5, attempt), 120000) + Math.random() * 5000
        : baseDelayMs * Math.pow(2, attempt) + Math.random() * 1000;
      const delay = suggestedDelay ? Math.max(computedDelay, suggestedDelay) : computedDelay;

      log.warn('retry_attempt', {
        attempt: attempt + 1,
        maxRetries,
        delayMs: Math.round(delay),
        status,
        isRateLimit,
        suggestedDelayMs: suggestedDelay,
        message: error.message
      });
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw lastError;
}

async function generateImageWithOpenRouter(prompt: string): Promise<string | null> {
  const apiKey = getOpenRouterKey();
  if (!apiKey) throw new Error('VITE_OPENROUTER_API_KEY is not configured');

  const modelCandidates = [
    getOpenRouterImageModel(),
    'google/gemini-2.5-flash-image',
    'google/gemini-2.0-flash-exp',
  ].filter((m, i, arr) => arr.indexOf(m) === i);

  let lastError: any = null;

  for (const model of modelCandidates) {
    try {
      const response = await withRetry(async () => {
        const res = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://wisprnote.app',
            'X-Title': 'WisprNote AI',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            modalities: ['image', 'text'],
            temperature: 0.2,
          }),
        }, 120000);

        if (!res.ok) {
          const errText = await res.text();
          const error: any = new Error(`OpenRouter image error (${res.status}) [${model}]: ${errText}`);
          error.status = res.status;
          throw error;
        }
        return res;
      }, 8);

      const data = await response.json();
      const imageEntry = data?.choices?.[0]?.message?.images?.[0];
      const imageUrl = imageEntry?.image_url?.url || imageEntry?.url;
      if (typeof imageUrl === 'string' && imageUrl.length > 0) {
        return imageUrl;
      }

      const assistantText = data?.choices?.[0]?.message?.content;
      throw new Error(
        `OpenRouter image response missing image payload [${model}]. Assistant content: ${String(assistantText || '').slice(0, 300)}`
      );
    } catch (error) {
      lastError = error;
      log.warn('openrouter_image_model_failed', {
        model,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    }
  }

  throw lastError || new Error('OpenRouter image generation failed for all model candidates');
}

function getApiKey(): string {
  return (process.env.GEMINI_API_KEY as string) ||
    ((import.meta as any).env?.VITE_GEMINI_API_KEY ?? '');
}

// Utility to try a model and fallback if it fails (e.g. 503 Service Unavailable)
async function generateWithFallback(
  requestOptions: any,
  fallbackModels: string[] = ["gemini-3.1-flash-lite"],
  // When true, Gemini calls go through the Tauri HTTP plugin instead of the SDK
  // (for large inline-audio uploads that the WebView fetch can't handle).
  useRestTransport = false,
): Promise<GenerateContentResponse> {
  const provider = getProvider();
  let lastError: Error | null = null;
  const modelsToTry = [requestOptions.model, ...fallbackModels];

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    // Give the primary model more attempts; fallbacks are safety nets.
    const retries = mi === 0 ? 8 : 4;
    try {
      return await withRetry(
        () => provider === 'openrouter'
          ? callOpenRouter({ ...requestOptions, model })
          : useRestTransport
            ? geminiGenerateContentRest({ ...requestOptions, model })
            : ai.models.generateContent({ ...requestOptions, model }),
        retries
      );
    } catch (error: any) {
      log.warn('model_retries_exhausted', { model, provider, message: error.message });
      lastError = error;
      const status: number = error.status ?? error.statusCode ?? error?.error?.code ?? error?.code ?? 0;
      if (status !== 503 && status !== 429) {
        throw error;
      }
    }
  }
  throw lastError;
}

export interface ProcessResult {
  text: string;
  batchIndex: number;
  startTime: number;
  endTime: number;
}

export async function processAudioBatch(batch: AudioBatch, prompt: string): Promise<ProcessResult> {
  let base64Data: string;
  try {
    base64Data = await blobToBase64(batch.blob);
  } catch (blobErr) {
    // Propagate BlobReadError directly — callers must NOT treat this as a
    // transient network issue (it means the audio data is gone from memory).
    if (blobErr instanceof BlobReadError) throw blobErr;
    throw new BlobReadError(`Unexpected blob read failure: ${(blobErr as Error).message}`);
  }
  
  // ─── Fetch User Identity ──────────────────────────────────────────────────
  let userName = "the user";
  try {
    const { getSession } = await import('./awsAuthService');
    const session = await getSession();
    if (session?.user) {
      userName = formatDisplayName(session.user.email, session.user.name, 'the user');
    }
  } catch (e) {
    log.warn('get_user_session_failed', { error: e instanceof Error ? e : undefined });
  }

  // Calculate overlap info for the prompt
  const overlapInfo = batch.overlapStart && batch.overlapStart > 0
    ? `\nNOTE: The first ~${batch.overlapStart} seconds of this chunk overlap with the previous chunk for continuity. This is intentional to ensure no content is lost at boundaries.`
    : '';
  
  // Use a transcription-focused prompt to get clean transcription output
  const transcriptionPrompt = `You are a professional transcription service. Your ONLY task is to transcribe the spoken words in this audio accurately and verbatim.

CRITICAL RULES AGAINST HALLUCINATIONS (MUST FOLLOW STRICTLY):
- If the audio contains ONLY silence, breathing, background noise, static, typing, or music — output ABSOLUTELY NOTHING. Do not invent dialogue.
- Do NOT hallucinate words that are not clearly spoken. If you are not 100% sure what was said, output [inaudible].
- If there is a long gap of silence, do not fill it with fabricated text. Simply output the spoken words before and after the gap.
- Do NOT write a summary, analysis, or description of the audio (e.g. do not write "The audio is a recording of a meeting"). Only output the transcript.

HANDLING SILENCE AND NOISE:
- Silence, pauses, and gaps are NORMAL in audio recordings. Do not interpret them as missing content.
- Background noise (fans, AC, typing, traffic) should be IGNORED — only transcribe actual speech.
- If someone coughs, clears throat, or makes non-verbal sounds, you may note [cough] or [clears throat] but do not invent words.
- Low audio quality or distant speech should be marked as [inaudible] rather than guessed.

FORMATTING RULES & SPEAKER ID:
- Output ONLY the exact words spoken in the audio
- Do NOT use bullet points or markdown formatting - just plain text paragraphs
- Include speaker labels if multiple speakers are detected.
- IMPORTANT IDENTITY RULE: The primary user of this app is named "${userName}". If the speaker refers to themselves as "me" or "I" and you need to assign a speaker label, or if someone addresses them by name, use "${userName}:" as the speaker label.
- Preserve natural speech patterns including filler words (um, uh, etc.) if present

This is part ${batch.index + 1} of ${batch.total} of the audio recording (from ${Math.floor(batch.startTime)}s to ${Math.floor(batch.endTime)}s).${overlapInfo}

${prompt ? `Additional context (domain vocabulary to look out for): ${prompt}` : ''}

Now transcribe the spoken audio verbatim. If no speech is present, return empty text. Do not apologize or explain — just output the transcript:`;

  const response = await generateWithFallback(
    {
      model: "gemini-3-flash-preview",
      contents: [
        {
          parts: [
            {
              inlineData: {
                mimeType: batch.mimeType,
                data: base64Data,
              },
            },
            {
              text: transcriptionPrompt,
            },
          ],
        },
      ],
    },
    undefined,
    true, // route the large inline-audio upload through the Tauri HTTP plugin
  );

  return {
    text: response.text || "",
    batchIndex: batch.index,
    startTime: batch.startTime,
    endTime: batch.endTime,
  };
}

// ─── Gemini File API ──────────────────────────────────────────────────────────

// Track consecutive File API failures so we stop wasting time + memory on an
// upload path that clearly doesn't work in this environment (common in Tauri/WebKit).
let _fileApiConsecutiveFailures = 0;
const FILE_API_MAX_CONSECUTIVE_FAILURES = 2;

export function isFileApiDisabledByFailures(): boolean {
  return _fileApiConsecutiveFailures >= FILE_API_MAX_CONSECUTIVE_FAILURES;
}

export function resetFileApiFailures(): void {
  _fileApiConsecutiveFailures = 0;
}

// Uploads an audio Blob to the Gemini File API via resumable upload.
// Returns the file URI and internal name needed for subsequent calls.
export async function uploadAudioToFileAPI(
  blob: Blob,
  mimeType: string,
  displayName: string
): Promise<{ uri: string; name: string }> {
  if (getProvider() === 'openrouter') {
    throw new Error('File API not available with OpenRouter — falling back to batch processing');
  }
  if (isFileApiDisabledByFailures()) {
    throw new Error('File API skipped — too many consecutive failures in this session');
  }
  const apiKey = getApiKey();
  if (!apiKey) throw new Error('GEMINI_API_KEY is not configured');

  try {
    // Step 1 — initiate resumable upload session (lightweight, no blob data)
    const initRes = await withRetry(() => fetch(
      `https://generativelanguage.googleapis.com/upload/v1beta/files?uploadType=resumable&key=${apiKey}`,
      {
        method: 'POST',
        headers: {
          'X-Goog-Upload-Protocol': 'resumable',
          'X-Goog-Upload-Command': 'start',
          'X-Goog-Upload-Header-Content-Length': String(blob.size),
          'X-Goog-Upload-Header-Content-Type': mimeType,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ file: { displayName } }),
      }
    ), 2); // reduced retries: init is fast — if it fails twice, something is wrong

    if (!initRes.ok) {
      const err = await initRes.text();
      throw new Error(`File API init failed (${initRes.status}): ${err}`);
    }

    const uploadUrl = initRes.headers.get('X-Goog-Upload-URL');
    if (!uploadUrl) throw new Error('File API did not return an upload URL');

    // Step 2 — upload the binary data.
    // Pass the blob directly as the fetch body instead of converting to
    // ArrayBuffer first.  This avoids doubling the file's memory footprint
    // and prevents WebKit from creating orphaned internal blob resources
    // that trigger WebKitBlobResource errors on failure/retry.
    const uploadRes = await withRetry(() => fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Length': String(blob.size),
        'X-Goog-Upload-Offset': '0',
        'X-Goog-Upload-Command': 'upload, finalize',
      },
      body: blob,
    }), 1); // only 1 retry — each attempt creates WebKit blob resources

    if (!uploadRes.ok) {
      const err = await uploadRes.text();
      throw new Error(`File API upload failed (${uploadRes.status}): ${err}`);
    }

    const data = await uploadRes.json();
    _fileApiConsecutiveFailures = 0; // success resets the counter
    return {
      uri: data.file?.uri ?? data.uri,
      name: data.file?.name ?? data.name,
    };
  } catch (err) {
    _fileApiConsecutiveFailures++;
    throw err;
  }
}

// Polls until the uploaded file reaches ACTIVE state (ready to use).
export async function waitForFileActive(name: string, maxWaitMs = 90000): Promise<void> {
  const apiKey = getApiKey();
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`
    );
    if (!res.ok) return; // if we can't check status, optimistically proceed
    const data = await res.json();
    if (data.state === 'ACTIVE') return;
    if (data.state === 'FAILED') throw new Error('Gemini File API: file processing FAILED');
    await new Promise(r => setTimeout(r, 2000));
  }
}

// Best-effort deletion — never throws.
export async function deleteFromFileAPI(name: string): Promise<void> {
  const apiKey = getApiKey();
  try {
    await fetch(
      `https://generativelanguage.googleapis.com/v1beta/${name}?key=${apiKey}`,
      { method: 'DELETE' }
    );
  } catch { /* best-effort */ }
}

// Transcribes a file already uploaded to the File API via a single model call.
// This is used for large files (>25MB) where batching would be inefficient.
export async function transcribeViaFileAPI(
  fileUri: string,
  mimeType: string,
  prompt: string
): Promise<string> {
  if (getProvider() === 'openrouter') {
    throw new Error('File API not available with OpenRouter — falling back to batch processing');
  }
  // ─── Fetch User Identity ──────────────────────────────────────────────────
  let userName = "the user";
  try {
    const { getSession } = await import('./awsAuthService');
    const session = await getSession();
    if (session?.user) {
      userName = formatDisplayName(session.user.email, session.user.name, 'the user');
    }
  } catch (e) {
    log.warn('get_user_session_failed', { error: e instanceof Error ? e : undefined });
  }

  const transcriptionPrompt = `You are a professional transcription service. Your ONLY task is to transcribe ALL spoken words in this audio accurately and completely.

CRITICAL RULES AGAINST HALLUCINATIONS (MUST FOLLOW STRICTLY):
- If any section contains ONLY silence, breathing, background noise, static, typing, or music — output nothing for that section. Do not invent dialogue.
- Do NOT hallucinate words that are not clearly spoken. If you are not 100% sure what was said, output [inaudible].
- If there is a long gap of silence, do not fill it with fabricated text. Simply output the spoken words before and after the gap.
- Do NOT write a summary, analysis, or description of the audio. Only output the transcript.

HANDLING SILENCE AND NOISE:
- Silence, pauses, and gaps are NORMAL in audio recordings. Do not interpret them as missing content.
- Background noise (fans, AC, typing, traffic) should be IGNORED — only transcribe actual speech.
- If someone coughs, clears throat, or makes non-verbal sounds, you may note [cough] or [clears throat] but do not invent words.
- Low audio quality or distant speech should be marked as [inaudible] rather than guessed.

FORMATTING RULES & SPEAKER ID:
- Output ONLY the exact words spoken in the audio
- Do NOT use bullet points or markdown formatting - just plain text paragraphs
- Include speaker labels if multiple speakers are detected (e.g., "Speaker 1:", "Speaker 2:")
- IMPORTANT IDENTITY RULE: The primary user of this app is named "${userName}". If the speaker refers to themselves as "me" or "I" and you need to assign a speaker label, or if someone addresses them by name, use "${userName}:" as the speaker label.
- Preserve natural speech patterns including filler words (um, uh, etc.) if present

COMPLETENESS:
- This is a COMPLETE audio file. Transcribe EVERYTHING from start to finish.
- Do not skip any sections, even if they seem repetitive or contain long pauses.
- Ensure the entire audio duration is covered in your transcription.

${prompt ? `Additional context (domain vocabulary to look out for): ${prompt}` : ''}

Now transcribe the complete audio verbatim. If no speech is present, return empty text. Do not apologize or explain — just output the transcript:`;

  const response = await generateWithFallback({
    model: 'gemini-3-flash-preview',
    contents: [{
      parts: [
        { fileData: { mimeType, fileUri } } as any,
        { text: transcriptionPrompt },
      ],
    }],
  });
  return response.text ?? '';
}

export async function generateSummary(text: string): Promise<string> {
  const response = await generateWithFallback({
    model: "gemini-3-flash-preview",
    contents: `You are a professional meeting summarizer. Create a comprehensive summary of the following transcription.

IMPORTANT INSTRUCTIONS:
- If the transcription contains multiple languages, TRANSLATE all non-English content to English
- Base your summary ONLY on what is explicitly stated in the transcription
- Do NOT add information, assumptions, or interpretations that are not in the original text
- Do NOT hallucinate or make up details
- Preserve all key points, decisions, and action items mentioned
- Use clear, professional language
- Structure the summary with:
  • Executive Summary (2-3 sentences)
  • Key Discussion Points (bullet points)
  • Decisions Made (if any)
  • Action Items (if any)
  • Next Steps (if mentioned)

Transcription:
${text}`,
  });
  return response.text || "";
}

// Build a token-bounded view of the whole meeting (beginning + middle + end)
// so titles reflect what was actually discussed end-to-end, not just the intro.
function buildTitleContext(transcription: string): string {
  const clean = transcription.trim().replace(/\s+/g, ' ');
  const MAX_CHARS = 3600; // ~900 tokens — keeps the call cheap on flash-lite
  if (clean.length <= MAX_CHARS) return clean;
  const slice = Math.floor(MAX_CHARS / 3);
  const head = clean.slice(0, slice);
  const midStart = Math.max(0, Math.floor(clean.length / 2 - slice / 2));
  const middle = clean.slice(midStart, midStart + slice);
  const tail = clean.slice(-slice);
  return `[BEGINNING]\n${head}\n\n[MIDDLE]\n${middle}\n\n[END]\n${tail}`;
}

export async function generateMeetingTitle(transcription: string): Promise<string> {
  const context = buildTitleContext(transcription);

  const response = await generateWithFallback({
    model: "gemini-3.1-flash-lite",
    contents: `Title this meeting in 3-6 words based on the OVERALL discussion (not just the opening). Output the title only — no quotes, no trailing punctuation, no explanation.

${context}`,
    config: {
      temperature: 0.3,
      maxOutputTokens: 24,
    },
  });

  let title = (response.text || "").trim();
  title = title.replace(/^["']|["']$/g, '');
  title = title.replace(/\n.*/g, '');
  title = title.trim();

  if (!title || title.length > 60) {
    return "Untitled Meeting";
  }

  return title;
}

export async function generateNotes(text: string): Promise<string> {
  const response = await generateWithFallback({
    model: "gemini-3-flash-preview",
    contents: `You are a professional note-taker. Transform the following transcription into structured, comprehensive notes.

IMPORTANT INSTRUCTIONS:
- If the transcription contains multiple languages, TRANSLATE all non-English content to English
- Extract ONLY information that is explicitly mentioned in the transcription
- Do NOT add assumptions, interpretations, or made-up details
- Do NOT hallucinate or invent information
- Preserve the chronological flow and context of the discussion
- Use Notion-style formatting with clear hierarchy
- Include:
  • Main topics discussed (with ## headings)
  • Key points under each topic (bullet points)
  • Specific details, numbers, dates mentioned
  • Speaker attributions when important (e.g., "John mentioned...")
  • Questions raised and answers provided
  • Any concerns or blockers mentioned

Format using Markdown:
- Use ## for main topics
- Use ### for subtopics
- Use bullet points (-) for details
- Use **bold** for emphasis on critical items
- Use > for important quotes or decisions

Transcription:
${text}`,
  });
  return response.text || "";
}

export interface ChatTaskData {
  transcription: string;
  notes?: string;
  summary?: string;
  title?: string;
  preparedContext?: string;
  retrievalMeta?: {
    confidence?: number;
    scope?: 'single' | 'many';
    selectedMeetingIds?: string[];
    tokenUsage?: {
      totalTokens?: number;
    };
  };
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length * 0.25);
}

function trimHistoryToTokenBudget(
  history: { role: 'user' | 'model'; parts: { text: string }[] }[],
  tokenBudget: number,
): { role: 'user' | 'model'; parts: { text: string }[] }[] {
  if (!history.length) return [];
  const kept: { role: 'user' | 'model'; parts: { text: string }[] }[] = [];
  let used = 0;
  for (let i = history.length - 1; i >= 0; i--) {
    const message = history[i];
    const joined = message.parts.map((p) => p.text).join('\n');
    const tokens = estimateTokens(joined) + 12;
    if (used + tokens > tokenBudget) break;
    used += tokens;
    kept.push(message);
  }
  return kept.reverse();
}

function normalizeMarkdownFormatting(text: string): string {
  let out = text;

  // Fix em-dash / en-dash used as inline bullet separators: "text – item" → newline + "- item"
  out = out.replace(/([^\n])[ \t][–—][ \t](?=\S)/g, '$1\n- ');

  // Ensure numbered list items always start on their own line
  out = out.replace(/([^\n])(\s+)(\d+\.\s+\*\*)/g, (_, before, _ws, item) => `${before}\n\n${item}`);

  // Ensure ## / ### headings always have a blank line before them
  out = out.replace(/([^\n])\n(#{1,3} )/g, '$1\n\n$2');

  // Collapse 4+ newlines to at most 2
  out = out.replace(/\n{4,}/g, '\n\n\n');

  return out.trim();
}

function sanitizeInlineCitations(text: string): string {
  const cleaned = text
    .replace(/\[M\d+-E\d+(?:\s*,\s*M\d+-E\d+)*\]/gi, '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\[(summary|source)\]/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return normalizeMarkdownFormatting(cleaned);
}

type QuestionCategory = 'action-items' | 'decisions' | 'summary' | 'people' | 'specific-fact' | 'comparison' | 'general';

function detectQuestionCategory(query: string): QuestionCategory {
  const q = query.toLowerCase();
  if (/action.?item|task|to.?do|follow.?up|assign|owner|responsible|who.*(?:should|will|need to|handle|take care)/.test(q)) return 'action-items';
  if (/\bdecision|decide|decided|agreed|approved?|conclusion|outcome|voted|chose|selected\b/.test(q)) return 'decisions';
  if (/summar|overview|recap|highlight|key.?point|main.?point|gist|brief|tell me about|what happened|what was discussed/.test(q)) return 'summary';
  if (/who attended|who (?:was|were|is|are)|attendee|participant|speaker|team member|people in/.test(q)) return 'people';
  if (/compar|differ|versus|\bvs\.?\b|contrast|better|worse|pros.?and.?cons|options/.test(q)) return 'comparison';
  if (/what.+(?:said|mentioned|discussed|talked|brought|raised|covered)|when|where|how much|how many|quote|exact/.test(q)) return 'specific-fact';
  return 'general';
}

const MARKDOWN_RULES = `
CRITICAL MARKDOWN RULES — MUST FOLLOW EXACTLY:
- NEVER use – (en-dash) or — (em-dash) as a bullet point. Use only - (hyphen) followed by a space.
- Every list item MUST start on its own NEW LINE.
- Every numbered section MUST have a blank line before the next one.
- Sub-bullets under a numbered item must be indented with 3 spaces and use - .
- Do NOT run multiple items onto the same line separated by dashes.
- Output must be valid GitHub-flavored Markdown — it will be rendered directly.`;

function buildFormatGuide(category: QuestionCategory): string {
  switch (category) {
    case 'action-items':
      return `RESPONSE FORMAT — Action Items:
Group tasks by category (if applicable) using ## headings. Each task on its own numbered line.

## [Category Name]
1. **[Task]** — Owner: [Name or Unassigned] | Due: [date or "TBD"]
2. **[Task]** — Owner: [Name or Unassigned] | Due: [date or "TBD"]

## [Next Category]
1. **[Task]** — Owner: [Name or Unassigned] | Due: [date or "TBD"]

If no categories apply, use a flat numbered list:
1. **[Task]** — Owner: [Name] | Due: [date]

If no action items are found, say so in one sentence.
${MARKDOWN_RULES}`;

    case 'decisions':
      return `RESPONSE FORMAT — Decisions:
One bullet per decision. Group under ## headings if there are many topics.

## [Topic or Meeting Section]
- **[Decision]** — [who decided / context]
- **[Decision]** — [who decided / context]

If no decisions are found, say so in one sentence.
${MARKDOWN_RULES}`;

    case 'summary':
      return `RESPONSE FORMAT — Summary:
Use this exact structure (omit sections not present in the context):

## Overview
[2-3 sentence high-level summary]

## Key Discussion Points
- [point 1]
- [point 2]
- [point 3]

## Decisions Made
- [decision] *(write "None recorded" if absent)*

## Action Items
1. **[task]** — Owner: [Name]
2. **[task]** — Owner: [Name]

## Next Steps
- [step] *(omit entire section if not mentioned)*
${MARKDOWN_RULES}`;

    case 'people':
      return `RESPONSE FORMAT — People:
One person per bullet with their role or contribution.

- **[Name]** — [role or what they contributed / said]
- **[Name]** — [role or what they contributed / said]
${MARKDOWN_RULES}`;

    case 'comparison':
      return `RESPONSE FORMAT — Comparison:
Show each option as a separate block.

**[Option A / Person A]**
- [key point]
- [key point]

**[Option B / Person B]**
- [key point]
- [key point]

**Key difference:** [1 sentence summary]
${MARKDOWN_RULES}`;

    case 'specific-fact':
      return `RESPONSE FORMAT — Direct Answer:
Answer directly in 1-2 sentences first, then provide supporting context or a quote below.

If quoting a speaker: > "[quote]" — *[Speaker Name]*
${MARKDOWN_RULES}`;

    default:
      return `RESPONSE FORMAT:
- Use ## headings to separate major sections.
- Use - (hyphen) for ALL bullet points — never em-dash or en-dash.
- Use **bold** for key terms, names, and important facts.
- Keep paragraphs short (2-3 sentences max).
- Put the most important information first.
${MARKDOWN_RULES}`;
  }
}

async function enforceGroundedAnswer(params: {
  question: string;
  answer: string;
  context: string;
}): Promise<string> {
  if (!params.answer.trim() || !params.context.trim()) {
    return params.answer;
  }

  const verifierPrompt = `You are a strict factual verifier.

QUESTION:
${params.question}

CONTEXT:
${params.context}

DRAFT ANSWER:
${params.answer}

Task:
1) Check whether every claim in DRAFT ANSWER is supported by CONTEXT.
2) If fully supported, return the same answer.
3) If not fully supported, rewrite answer to remove unsupported claims and keep only grounded facts.
4) If context lacks required facts, explicitly say what is missing instead of guessing.

Output ONLY valid JSON:
{
  "isGrounded": true or false,
  "correctedAnswer": "final grounded answer"
}`;

  try {
    const verification = await generateWithFallback({
      model: 'gemini-3.1-flash-lite',
      contents: [{ role: 'user', parts: [{ text: verifierPrompt }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 1200,
      },
    });

    const raw = (verification.text || '')
      .replace(/```json\s*/gi, '')
      .replace(/```\s*/gi, '')
      .trim();
    const parsed = JSON.parse(raw);
    const corrected = typeof parsed?.correctedAnswer === 'string'
      ? parsed.correctedAnswer
      : params.answer;
    return sanitizeInlineCitations(corrected);
  } catch {
    return sanitizeInlineCitations(params.answer);
  }
}

export interface AgentPlan {
  intent: string;
  scope: 'single' | 'many';
  isBroad: boolean;
  /** 1–3 short, human-readable steps describing how the assistant will answer. */
  plan: string[];
}

export async function agentPlanQuery(
  userQuery: string,
  meetingTitles: string[],
  isSingleMeeting: boolean,
): Promise<AgentPlan> {
  const response = await generateWithFallback({
    model: 'gemini-3-flash-preview',
    contents: [{ role: 'user', parts: [{ text: userQuery }] }],
    config: {
      systemInstruction: `You are a precise intent classifier for a meeting AI assistant called WisprNote AI.

The user has ${isSingleMeeting ? '1 meeting selected' : `${meetingTitles.length} meetings available`}.

Your job is to deeply understand exactly what the user is asking for — not more, not less.

Output ONLY valid JSON (no markdown fences):
{
  "intent": "<precise, actionable 1-sentence description that captures EXACTLY what the user wants — include the specific deliverable, scope, and any constraints they mentioned>",
  "isBroad": ${isSingleMeeting ? 'false' : '<true if the user explicitly or implicitly wants to cover ALL/EVERY meeting, or asks for exhaustive cross-meeting analysis like "key topics from all meetings" or "summarize everything". false if they want specific information that likely lives in a few meetings>'},
  "plan": ["<step 1>", "<step 2>"]
}

CRITICAL RULES for intent:
- Preserve the user's exact scope: if they say "key topics" write "key topics", not "decisions" or "action items"
- If they say "all meetings", the intent MUST reflect covering ALL meetings, not a subset
- If they ask for one specific thing (e.g. "key topics"), do NOT expand it to multiple things (e.g. don't add "decisions, action items, and next steps")
- The intent should be a direct instruction that could be given to another AI to execute

RULES for plan (1–3 short steps, each ≤ 12 words, describing HOW you'll answer):
- Name the retrieval approach concretely. For a date window (e.g. "this month") say e.g. "List every meeting from the last 30 days". For a person say "Look up <name> in the contacts directory". For a topic say "Search notes for <topic> across meetings".
- Then a synthesis step, e.g. "Summarize the key themes across all of them".
- Be specific to THIS request — do not write generic filler.`,
      maxOutputTokens: 260,
    },
  });

  try {
    const raw = (response.text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const parsed = JSON.parse(raw);
    const plan = Array.isArray(parsed.plan)
      ? parsed.plan.filter((s: unknown): s is string => typeof s === 'string' && s.trim().length > 0).slice(0, 3)
      : [];
    return {
      intent: parsed.intent || userQuery,
      scope: isSingleMeeting ? 'single' : 'many',
      isBroad: !!parsed.isBroad,
      plan,
    };
  } catch {
    const broadPatterns = [
      'all meetings', 'every meeting', 'across all', 'across meetings',
      'all the meetings', 'from all meetings', 'overall', 'main decisions',
      'key decisions', 'key topics', 'all decisions', 'everything',
    ];
    const qLower = userQuery.toLowerCase();
    const isBroad = !isSingleMeeting && broadPatterns.some(p => qLower.includes(p));
    return {
      intent: userQuery,
      scope: isSingleMeeting ? 'single' : 'many',
      isBroad,
      plan: ['Search the relevant meeting notes', 'Synthesize a direct answer from what I find'],
    };
  }
}

export async function chatWithNotes(
  taskData: ChatTaskData | string,
  message: string,
  history: { role: 'user' | 'model', parts: { text: string }[] }[],
  useRAG: boolean = true
): Promise<string> {
  // Backwards-compat: accept plain string (legacy call sites)
  const data: ChatTaskData = typeof taskData === 'string'
    ? { transcription: taskData }
    : taskData;

  const { transcription, notes, summary, title } = data;

  const {
    chunkTranscription,
    retrieveRelevantChunks,
    prepareContext,
    detectQueryIntent,
  } = await import('./ragService');

  const intent = detectQueryIntent(message);
  const isOverview = intent === 'overview';
  const questionCategory = detectQuestionCategory(message);
  const formatGuide = buildFormatGuide(questionCategory);

  // ── Build context in anarlog-style <context> XML block ─────────────────────
  let fullContext = '';

  if (data.preparedContext?.trim()) {
    fullContext = data.preparedContext.trim();
  } else {
    const contextParts: string[] = [];

    if (title) contextParts.push(`Title: ${title}`);

    if (summary?.trim()) {
      contextParts.push(`Enhanced Meeting Summary:\n${summary.trim()}`);
    }

    if (notes?.trim()) {
      const plainNotes = notes.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (plainNotes.length > 20) {
        contextParts.push(`User Written Notes:\n${plainNotes}`);
      }
    }

    if (transcription?.trim() && useRAG) {
      const chunks = chunkTranscription(transcription);
      const topK = isOverview ? 10 : 6;
      const results = await retrieveRelevantChunks(message, chunks, topK);
      const retrieved = prepareContext(results);

      if (retrieved.trim()) {
        contextParts.push(`Relevant Transcript Excerpts:\n${retrieved}`);
      } else {
        contextParts.push(`Full Meeting Transcript:\n${transcription.substring(0, 6000)}${transcription.length > 6000 ? '\n[... truncated ...]' : ''}`);
      }
    } else if (transcription?.trim()) {
      contextParts.push(`Full Meeting Transcript:\n${transcription}`);
    }

    if (contextParts.length > 0) {
      fullContext = `<context>\n\n${contextParts.join('\n\n')}\n\n</context>`;
    }
  }

  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const systemInstruction = `Current date: ${today}

You are WisprNote AI, a helpful meeting assistant. Your purpose is to help users understand their meeting content better.

- Always keep your responses concise, professional, and directly relevant to the user's questions.
- Your primary source of truth is the meeting transcript. Generate responses primarily from the transcript, then the summary or notes.
- Only state facts that appear in the context. If information is not there, say so explicitly — never guess or infer.
- Do NOT print citation markers like [M1-E2], [2], [Summary], or [Source].
- Do NOT add any source references, citation blocks, or footnotes at the end of your response.
- If the answer is genuinely absent from all sources, say: "I couldn't find that information in this meeting's records."

${formatGuide}

${fullContext}`;

  const recentHistory = trimHistoryToTokenBudget(history, 2400);

  const response = await generateWithFallback({
    model: "gemini-3-flash-preview",
    contents: [
      ...recentHistory,
      { role: 'user', parts: [{ text: message }] }
    ],
    config: {
      systemInstruction,
      temperature: 0.15,
      maxOutputTokens: isOverview ? 4000 : 2400,
    }
  });
  return enforceGroundedAnswer({
    question: message,
    answer: response.text || '',
    context: fullContext,
  });
}

export async function agentSynthesizeFromEvidence(params: {
  userQuery: string;
  intent: string;
  context: string;
  history: { role: 'user' | 'model'; parts: { text: string }[] }[];
  meetingsVisited: number;
  totalMeetings: number;
}): Promise<string> {
  const crossMeetingCategory = detectQuestionCategory(params.userQuery);
  const crossMeetingFormat = buildFormatGuide(crossMeetingCategory);
  const today = new Date().toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });

  const systemInstruction = `Current date: ${today}

You are WisprNote AI, a helpful meeting assistant searching across ${params.meetingsVisited} of ${params.totalMeetings} available meetings.

User's request: "${params.userQuery}"
Task: ${params.intent}

- Answer ONLY from the evidence provided — never fabricate or infer facts not present.
- Answer EXACTLY what the user asked — nothing more, nothing less.
- If the user asked to cover all meetings, group findings by meeting using ## [Meeting Title] headings.
- If evidence is missing for a meeting, write "No relevant evidence found" for that meeting.
- Do NOT print citation markers like [1], [M1-E2], [Source], etc.
- Do NOT add any source references, citation blocks, or footnotes at the end of your response.
- Begin with a one-line coverage note: "Found relevant information in X of Y meetings."

${crossMeetingFormat}

<context>

${params.context}

</context>`;

  const recentHistory = trimHistoryToTokenBudget(params.history, 1400);

  const response = await generateWithFallback({
    model: 'gemini-3-flash-preview',
    contents: [
      ...recentHistory,
      { role: 'user', parts: [{ text: params.userQuery }] },
    ],
    config: {
      systemInstruction,
      temperature: 0.15,
      maxOutputTokens: 4800,
    },
  });
  return enforceGroundedAnswer({
    question: params.userQuery,
    answer: response.text || '',
    context: params.context,
  });
}

// ─── Agentic Tool-Calling Chat (All Meetings) ────────────────────────────────

export interface SearchableMeeting {
  meetingId: string;
  title: string;
  transcription: string;
  summary?: string;
  notes?: string;
  createdAt?: string;
}

export interface AgentSearchStep {
  callId: string;
  query: string;
  filters?: { recent_days?: number };
  status: 'running' | 'done';
  kind?: 'notes' | 'contacts';
  results?: Array<{ meetingId: string; meetingTitle: string; score: number; date?: string }>;
  contacts?: Array<{
    name: string;
    role?: string | null;
    company?: string | null;
    email?: string | null;
    meeting_count: number;
    task_ids: string[];
    last_seen?: string;
  }>;
}

export interface AgentChatCallbacks {
  /** Fired once, before any tool call, with the assistant's plan for this query. */
  onPlan?: (plan: { intent: string; steps: string[] }) => void;
  onToolCallStart: (step: AgentSearchStep) => void;
  onToolCallDone: (step: AgentSearchStep) => void;
  searchFn?: (
    query: string,
    filters?: { recent_days?: number },
    limit?: number,
  ) => Promise<{ results: AgentSearchStep['results']; contextText: string }>;
  contactsFn?: (
    query: string,
    limit?: number,
  ) => Promise<{
    contacts: NonNullable<AgentSearchStep['contacts']>;
    meetings: NonNullable<AgentSearchStep['results']>;
    contextText: string;
  }>;
}

function scoreKeywordMatch(query: string, text: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(t => t.length > 2);
  const haystack = text.toLowerCase();
  let score = 0;
  for (const term of terms) {
    const re = new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
    score += (haystack.match(re) ?? []).length;
  }
  return score;
}

async function executeSearchNotes(
  query: string,
  filters: { recent_days?: number } | undefined,
  limit: number,
  allMeetings: SearchableMeeting[],
): Promise<{ results: AgentSearchStep['results']; contextText: string }> {
  let pool = allMeetings;
  const hasDateFilter = !!(filters?.recent_days && filters.recent_days > 0);

  if (hasDateFilter) {
    const cutoff = Date.now() - filters!.recent_days! * 24 * 60 * 60 * 1000;
    pool = allMeetings.filter(m => {
      if (!m.createdAt) return false;
      return new Date(m.createdAt).getTime() >= cutoff;
    });
  }

  const cap = Math.min(Math.max(limit, 1), 10);
  const trimmedQuery = query.trim();
  let top: { m: SearchableMeeting; score: number }[];

  if (trimmedQuery.length === 0) {
    // Date-range listing: return EVERY meeting in the window (no top-N cap), so
    // recaps like "this month" cover all meetings rather than just 10.
    top = pool
      .slice()
      .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
      .map(m => ({ m, score: 1 }));
  } else {
    const scored = pool
      .map(m => {
        const fullText = `${m.title} ${m.notes || ''} ${m.summary || ''} ${m.transcription}`;
        return { m, score: scoreKeywordMatch(trimmedQuery, fullText) };
      })
      .sort((a, b) => b.score - a.score);

    top = scored.filter(s => s.score > 0).slice(0, cap);
    if (top.length === 0 && hasDateFilter && scored.length > 0) {
      top = scored
        .slice()
        .sort((a, b) => (b.m.createdAt ?? '').localeCompare(a.m.createdAt ?? ''))
        .slice(0, cap);
    } else if (top.length === 0 && scored.length > 0) {
      top = scored.slice(0, Math.min(cap, 3));
    }
  }

  const contextParts = top.map(({ m }) => {
    const date = m.createdAt
      ? new Date(m.createdAt).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' })
      : '';
    const content = m.notes?.trim() || m.summary?.trim() || m.transcription.slice(0, 3000);
    return `Title: ${m.title}${date ? `\nDate: ${date}` : ''}\n\n${content}`;
  });

  return {
    results: top.map(({ m, score }) => ({
      meetingId: m.meetingId,
      meetingTitle: m.title,
      score,
      date: m.createdAt,
    })),
    contextText: contextParts.length > 0
      ? contextParts.join('\n\n---\n\n')
      : 'No matching meetings found.',
  };
}

export async function agentChatAllMeetings(
  userQuery: string,
  history: { role: 'user' | 'model'; parts: { text: string }[] }[],
  meetings: SearchableMeeting[],
  callbacks: AgentChatCallbacks,
): Promise<string> {
  const now = new Date();
  const today = now.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
  const dayOfWeek = now.getDay();
  const daysSinceMonday = (dayOfWeek + 6) % 7;
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - daysSinceMonday);
  const weekStartLabel = weekStart.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  const todayLabel = now.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

  const meetingIndex = meetings
    .slice()
    .sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''))
    .map((m, i) => {
      const date = m.createdAt
        ? new Date(m.createdAt).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
        : 'unknown date';
      return `${i + 1}. "${m.title}" (${date})`;
    })
    .join('\n');

  let systemInstruction = `Today's date: ${today}
Current week: ${weekStartLabel} – ${todayLabel} (Monday through today)

You are WisprNote AI, a meeting intelligence assistant.
You have access to ${meetings.length} meeting recordings via the search_notes tool, plus a contacts directory via the search_contacts tool.

Available meetings (newest first):
${meetingIndex}

How to use the search_notes tool:
- query: a topic/person/keyword string. LEAVE IT EMPTY ("") when the user is asking for a date-range listing such as "this week", "today", "yesterday", "last week", "this month", "summary of my week/month" — combine an empty query with filters.recent_days. An empty-query listing returns EVERY meeting in the range (the limit is ignored for listings), so you always get the COMPLETE set — even if that's 30+ meetings — not a truncated top-10.
- filters.recent_days: 1 = today, 2 = today + yesterday, 7 = this week / last 7 days, 14 = last 2 weeks, 30 = last month. For "this week" specifically use 7. For "this month" use 30 (or 31). A recap of "the whole month" MUST use an empty query + recent_days so nothing is dropped.
- limit: ONLY applies to topic/keyword searches (non-empty query); it caps how many semantically-matching meetings come back (1–10). It does NOT cap empty-query date-range listings — those always return everything in the window. When a topic could span multiple meetings, pass a higher limit (8–10).
- search_notes uses Turbopuffer semantic similarity (ANN + BM25 hybrid) over transcript chunks, so it surfaces meetings that discuss the topic even when the wording differs from the query (e.g. "obsidian changes" finds meetings discussing "migrating notes into the vault" or "Granola export"). Always pick the higher limit when the question is open-ended like "what changes do I need to make on X" — the answer likely spans several meetings.
- You may call search_notes multiple times: e.g. one empty-query date-range call to list all meetings, then targeted follow-up calls with specific names or topics.

How to use the search_contacts tool (this is the AUTHORITATIVE tool for person queries):
- query: a person's name, email fragment, role, or company.
- limit: max contacts to return (default 5).
- search_contacts cross-references TWO sources stored in AWS: (1) the People directory (auto-extracted contacts with meeting_count, task_ids, role, company, email, last_seen) AND (2) the Knowledge Graph per-meeting entries (topics, decisions, action_items, people-mentioned arrays). Names that appear only as third-party mentions inside transcripts are picked up via the Knowledge Graph branch even when the person isn't a contact.
- The response includes, for EVERY meeting that person attended OR was mentioned in within the last 30 days: meeting title + date + task_id, the Knowledge Graph topics/decisions/action_items, the meeting NOTES, the SUMMARY, and a TRANSCRIPT excerpt. This is the COMPLETE evidence — you do not need a follow-up search_notes call for the same person.

How to answer:
1. ALWAYS call a search tool first. Never answer from memory.
2. PERSON-SPECIFIC QUERIES (e.g. "how is Moulish doing", "what has X been working on", "performance of Y this month", "what did X say about Z", "summarize X's contributions"):
   a. Call search_contacts(query=person_name) ONCE. That single call returns all the evidence you need.
   b. Synthesize the answer DIRECTLY from the EVIDENCE blocks. Cover ALL the meetings listed there. Reference meeting titles when citing facts. Use the Knowledge Graph topics/decisions/action_items as your primary structure when relevant.
   c. DO NOT call search_notes for the same person — it would only re-fetch a subset of what search_contacts already gave you, and it filters by transcript keyword match which drops meetings where the person attended but wasn't named in the text.
3. When summarizing a time window without a specific person (e.g. "recap this month"), call search_notes with query="" + the right recent_days. The listing returns ALL meetings in that window — cover every one of them in your answer.
4. Only state facts found in the retrieved content — never invent or assume.
5. If search_contacts returns no matches, only then fall back to search_notes with the name as the query.
6. MEETING SUMMARIES are AI-generated and may contain errors. When a claim about a person's specific role, task ownership, or assignment comes only from a summary (no transcript evidence), add a brief caveat: "(from AI-generated summary — verify in transcript)". Never repeat a summary claim as a certain fact without transcript backup.`;

  const searchTool = {
    functionDeclarations: [
      {
        name: 'search_notes',
        description:
          'Search meeting notes and transcripts. Pass an empty query with filters.recent_days to list every meeting in a date range (e.g. "this week", "today"). Pass a topic or person name to find specific content.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description:
                'Text to search for: person name, topic, or keyword. Pass an empty string ("") to list meetings by date only.',
            },
            filters: {
              type: Type.OBJECT,
              description: 'Optional filters to narrow results',
              properties: {
                recent_days: {
                  type: Type.INTEGER,
                  description:
                    'Return only meetings from the last N days (counts back from today, inclusive). Use 1 for today, 2 for today+yesterday, 7 for this week / last 7 days, 14 for last two weeks, 30 for last month.',
                },
              },
            },
            limit: {
              type: Type.INTEGER,
              description: 'Caps topic/keyword searches only (1–10, default 5). IGNORED for empty-query date-range listings, which always return every meeting in the window.',
            },
          },
          required: [],
        },
      },
      {
        name: 'search_contacts',
        description:
          'Look up people in the contacts directory by name, email, role, or company. Returns each match with their meeting_count, list of meeting IDs (task_ids), meeting titles + dates, and last_seen date. Call this FIRST whenever the user mentions a specific person — it gives you the authoritative list of meetings that person was in, instead of relying on keyword matches in transcripts.',
        parameters: {
          type: Type.OBJECT,
          properties: {
            query: {
              type: Type.STRING,
              description: "Person name, email fragment, role, or company to search.",
            },
            limit: {
              type: Type.INTEGER,
              description: 'Max contacts to return (1–10, default 5).',
            },
          },
          required: ['query'],
        },
      },
    ],
  };

  // ── Think first: produce a short plan before acting ─────────────────────────
  // A single cheap classifier call decides intent + the concrete steps. We show
  // it to the user (onPlan) AND feed it back to the agent so it executes the
  // plan instead of jumping straight into an arbitrary tool call.
  try {
    const plan = await agentPlanQuery(userQuery, meetings.map(m => m.title), false);
    if (plan.plan.length > 0) {
      callbacks.onPlan?.({ intent: plan.intent, steps: plan.plan });
      systemInstruction += `\n\nYOUR PLAN FOR THIS REQUEST (follow it):\n- Goal: ${plan.intent}\n${plan.plan.map((s, i) => `- Step ${i + 1}: ${s}`).join('\n')}`;
    }
  } catch (e) {
    log.warn('agent_plan_failed', { error: e instanceof Error ? e : undefined });
  }

  const recentHistory = trimHistoryToTokenBudget(history, 1200);
  const MAX_STEPS = 5;
  let callIndex = 0;

  if (getProvider() === 'openrouter') {
    // ── OpenRouter path: OpenAI-compatible tool calling ──────────────────────
    const openaiTools = [
      {
        type: 'function',
        function: {
          name: 'search_notes',
          description:
            'Search meeting notes and transcripts. Pass an empty query with filters.recent_days to list every meeting in a date range (e.g. "this week", "today"). Pass a topic or person name to find specific content.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description:
                  'Text to search for: person name, topic, or keyword. Pass an empty string ("") to list meetings by date only.',
              },
              filters: {
                type: 'object',
                properties: {
                  recent_days: {
                    type: 'integer',
                    description:
                      'Return only meetings from the last N days (counts back from today, inclusive). Use 1 for today, 2 for today+yesterday, 7 for this week / last 7 days, 14 for last two weeks, 30 for last month.',
                  },
                },
              },
              limit: {
                type: 'integer',
                description: 'Caps topic/keyword searches only (1–10, default 5). IGNORED for empty-query date-range listings, which always return every meeting in the window.',
              },
            },
            required: [],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'search_contacts',
          description:
            'AUTHORITATIVE one-shot lookup for any person-specific query. Cross-references the People directory AND the Knowledge Graph in AWS. For each matched person, returns the FULL EVIDENCE (Knowledge Graph topics/decisions/action_items + meeting notes + summary + transcript excerpts) for every meeting they attended or were mentioned in within the last 30 days. After calling this, answer directly from the evidence — do NOT call search_notes for the same person.',
          parameters: {
            type: 'object',
            properties: {
              query: {
                type: 'string',
                description: "Person name, email fragment, role, or company to search.",
              },
              limit: {
                type: 'integer',
                description: 'Max contacts to return (1–10, default 5).',
              },
            },
            required: ['query'],
          },
        },
      },
    ];

    const messages: any[] = [
      { role: 'system', content: systemInstruction },
      ...recentHistory.map((m: any) => ({
        role: m.role === 'model' ? 'assistant' : m.role,
        content: m.parts?.map((p: any) => p.text).join('') ?? '',
      })),
      { role: 'user', content: userQuery },
    ];

    const apiKey = getOpenRouterKey();
    if (!apiKey) throw new Error('VITE_OPENROUTER_API_KEY is not configured');

    const SYNTH_NUDGE = 'You have searched enough. Now synthesize a direct answer from the evidence you retrieved. Use the meeting summaries and transcript excerpts. If information is incomplete, state what you found and note any gaps. Do NOT call search_notes or search_contacts again.';

    for (let step = 0; step < MAX_STEPS; step++) {
      const isFinalStep = step === MAX_STEPS - 1;
      const isPreFinalStep = step === MAX_STEPS - 2;

      // On the second-to-last step, inject a synthesis nudge so the AI knows to answer next.
      if (isPreFinalStep) {
        messages.push({ role: 'user', content: SYNTH_NUDGE });
      }

      const res = await withRetry(() =>
        fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://wisprnote.app',
            'X-Title': 'WisprNote AI',
          },
          body: JSON.stringify({
            model: 'google/gemini-3.1-flash-lite',
            messages,
            // Final step: no tools — forces AI to write a text response.
            ...(isFinalStep ? {} : { tools: openaiTools, tool_choice: 'auto' }),
            temperature: 0.1,
            max_tokens: 5000,
          }),
        }, 90000).then(async r => {
          if (!r.ok) {
            const err: any = new Error(`OpenRouter ${r.status}: ${await r.text()}`);
            err.status = r.status;
            throw err;
          }
          return r.json();
        })
      );

      const msg = res.choices?.[0]?.message;
      if (!msg) break;

      const toolCalls: any[] = msg.tool_calls ?? [];
      log.debug('agent_chat_step_or', { step, hasToolCalls: toolCalls.length > 0, content: String(msg.content ?? '').slice(0, 80) });

      if (toolCalls.length === 0) {
        const text = (msg.content ?? '').trim();
        return text ? sanitizeInlineCitations(text) : 'I could not find relevant information in the meeting notes.';
      }

      messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: toolCalls });

      for (const tc of toolCalls) {
        const callId = `${callIndex++}`;
        const toolName = tc.function?.name ?? 'search_notes';
        let args: any = {};
        try { args = JSON.parse(tc.function?.arguments ?? '{}'); } catch { /* ignore */ }

        const query: string = typeof args.query === 'string' ? args.query : '';
        const limit: number = typeof args.limit === 'number' ? args.limit : 5;

        if (toolName === 'search_contacts') {
          log.debug('agent_tool_call_or', { callId, tool: 'search_contacts', query, limit });
          callbacks.onToolCallStart({ callId, query, status: 'running', kind: 'contacts' });

          const { contacts, meetings, contextText } = callbacks.contactsFn
            ? await callbacks.contactsFn(query, limit)
            : { contacts: [], meetings: [], contextText: 'No contacts directory available.' };

          log.debug('agent_tool_result_or', { callId, tool: 'search_contacts', contactCount: contacts.length, meetingCount: meetings.length });
          callbacks.onToolCallDone({ callId, query, status: 'done', kind: 'contacts', contacts, results: meetings });

          messages.push({ role: 'tool', tool_call_id: tc.id, content: contextText });
          continue;
        }

        const filters: { recent_days?: number } | undefined =
          args.filters && typeof args.filters === 'object'
            ? { recent_days: typeof args.filters.recent_days === 'number' ? args.filters.recent_days : undefined }
            : undefined;

        log.debug('agent_tool_call_or', { callId, tool: 'search_notes', query, filters, limit });
        callbacks.onToolCallStart({ callId, query, filters, status: 'running', kind: 'notes' });

        const doSearch = callbacks.searchFn ?? ((q, f, l) => executeSearchNotes(q, f, l ?? 5, meetings));
        const { results, contextText } = await doSearch(query, filters, limit);

        log.debug('agent_tool_result_or', { callId, resultCount: results?.length ?? 0 });
        callbacks.onToolCallDone({ callId, query, filters, status: 'done', kind: 'notes', results });

        messages.push({ role: 'tool', tool_call_id: tc.id, content: contextText });
      }
    }

    return 'I was unable to find a definitive answer after searching the meeting notes.';
  }

  // ── Native Gemini path ────────────────────────────────────────────────────
  const contents: any[] = [
    ...recentHistory,
    { role: 'user', parts: [{ text: userQuery }] },
  ];

  const SYNTH_NUDGE_GEMINI = 'You have searched enough. Now synthesize a direct answer from the evidence you retrieved. Use the meeting summaries and transcript excerpts. If information is incomplete, state what you found and note any gaps. Do NOT call search_notes or search_contacts again.';

  for (let step = 0; step < MAX_STEPS; step++) {
    const isFinalStep = step === MAX_STEPS - 1;
    const isPreFinalStep = step === MAX_STEPS - 2;

    // On the second-to-last step, append a synthesis nudge so the AI commits to answering next.
    if (isPreFinalStep) {
      contents.push({ role: 'user', parts: [{ text: SYNTH_NUDGE_GEMINI }] });
    }

    const response = await generateWithFallback({
      model: 'gemini-2.5-flash',
      contents,
      config: {
        systemInstruction,
        // Final step: remove tools so Gemini is forced to emit text.
        ...(isFinalStep ? {} : { tools: [searchTool] }),
        temperature: 0.1,
        maxOutputTokens: 5000,
      },
    });

    const parts = response.candidates?.[0]?.content?.parts ?? [];
    const functionCallParts = parts.filter((p: any) => p.functionCall);
    const textParts = parts.filter((p: any) => p.text?.trim());

    log.debug('agent_chat_step', {
      step,
      hasFunctionCalls: functionCallParts.length > 0,
      hasText: textParts.length > 0,
      responseText: response.text?.slice(0, 80) ?? '',
    });

    if (functionCallParts.length === 0) {
      const text = textParts.map((p: any) => p.text).join('').trim() || response.text?.trim() || '';
      return text ? sanitizeInlineCitations(text) : 'I could not find relevant information in the meeting notes.';
    }

    contents.push({ role: 'model', parts });

    const toolResponseParts: any[] = [];

    for (const part of functionCallParts) {
      const fc = part.functionCall;
      if (!fc) continue;
      const callId = `${callIndex++}`;
      const toolName: string = typeof fc.name === 'string' ? fc.name : 'search_notes';
      const query: string = typeof fc.args?.query === 'string' ? fc.args.query : '';
      const limit: number = typeof fc.args?.limit === 'number' ? fc.args.limit : 5;

      if (toolName === 'search_contacts') {
        log.debug('agent_tool_call', { callId, tool: 'search_contacts', query, limit });
        callbacks.onToolCallStart({ callId, query, status: 'running', kind: 'contacts' });

        const { contacts, meetings, contextText } = callbacks.contactsFn
          ? await callbacks.contactsFn(query, limit)
          : { contacts: [], meetings: [], contextText: 'No contacts directory available.' };

        log.debug('agent_tool_result', { callId, tool: 'search_contacts', contactCount: contacts.length, meetingCount: meetings.length });
        callbacks.onToolCallDone({ callId, query, status: 'done', kind: 'contacts', contacts, results: meetings });

        toolResponseParts.push({
          functionResponse: { name: fc.name, response: { content: contextText } },
        });
        continue;
      }

      const rawFilters = fc.args?.filters;
      const filters: { recent_days?: number } | undefined =
        rawFilters && typeof rawFilters === 'object' && !Array.isArray(rawFilters)
          ? { recent_days: typeof (rawFilters as any).recent_days === 'number' ? (rawFilters as any).recent_days : undefined }
          : undefined;

      log.debug('agent_tool_call', { callId, tool: 'search_notes', query, filters, limit });
      callbacks.onToolCallStart({ callId, query, filters, status: 'running', kind: 'notes' });

      const doSearch = callbacks.searchFn ?? ((q, f, l) => executeSearchNotes(q, f, l ?? 5, meetings));
      const { results, contextText } = await doSearch(query, filters, limit);

      log.debug('agent_tool_result', { callId, resultCount: results?.length ?? 0, contextLen: contextText.length });
      callbacks.onToolCallDone({ callId, query, filters, status: 'done', kind: 'notes', results });

      toolResponseParts.push({
        functionResponse: { name: fc.name, response: { content: contextText } },
      });
    }

    contents.push({ role: 'user', parts: toolResponseParts });
  }

  return 'I was unable to find a definitive answer after searching the meeting notes.';
}

export async function generateConceptImage(description: string): Promise<string | null> {
  const prompt = `Create a highly detailed, professional, and accurate concept visualization for: "${description}".
The visualization should be a clean, modern architecture diagram, flowchart, or technical map.
Style: Minimalist, tech-focused, high-contrast, suitable for an executive dashboard.
Ensure all elements are clearly defined and the layout is logically structured.`;

  try {
    if (getProvider() === 'openrouter') {
      return await generateImageWithOpenRouter(prompt);
    }

    const response: GenerateContentResponse = await generateWithFallback({
      model: 'gemini-3.1-flash-image-preview',
      contents: { parts: [{ text: prompt }] },
      // keep image fallback chain inside Gemini only
    }, ['gemini-2.5-flash-image-preview']);

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:image/png;base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('generate_concept_image_failed', {
      message: err.message,
      stack: err.stack,
      provider: getProvider(),
    });
    return null;
  }
}

export async function generateNotesVisualization(notes: string): Promise<string | null> {
  try {
    const prompt = `Generate a sketchnote image that looks EXACTLY like it was hand-drawn by a professional graphic recorder live during a meeting, using black Staedtler marker pens and blue/red Sharpie markers on a large off-white A1 paper sheet.

CRITICAL — WHAT THIS IMAGE MUST NOT LOOK LIKE:
❌ DO NOT generate a digital infographic, a PowerPoint slide, a Canva template, or any computer-designed layout.
❌ DO NOT use any computer fonts — all text must look genuinely handwritten with visible stroke variation.
❌ DO NOT draw perfectly straight lines, perfect circles, or perfect rectangles — all lines must have slight natural wobble and imperfection.
❌ DO NOT use the same layout template as any other meeting — the arrangement must be completely unique to this meeting's topic.
❌ DO NOT fill large areas with solid color blocks — use hatching, cross-hatching, or light blue ink washes for shading.
❌ DO NOT write full sentences — only short punchy phrases, key numbers, and names.

PHYSICAL MEDIUM TO SIMULATE:
The image must look like it was drawn using:
- A thick black Sharpie marker for main outlines, headers, and borders (thick strokes, slightly uneven edges)
- A medium black fineliner (Staedtler 0.5mm) for body text and fine details (thin lines, slightly irregular)
- A BLUE Copic marker or Sharpie for highlights, underlines, fill shading (light blue washes, not solid fills)
- A RED marker only for warnings, blockers, urgent callouts
- Paper texture: slightly off-white, warm, like a paper flip chart pad

HAND-LETTERING RULES:
- All headers: ALL-CAPS, thick marker letterforms with slight weight variation between strokes. Letters slightly touch or overlap. NOT a font.
- Sub-headers: Mixed case, medium weight, letters slightly uneven in height
- Body text: Small printed handwriting style — letters slightly varied in size, baseline gently undulating
- Numbers and statistics: Write them large and bold, circled or underlined by hand

UNIQUE LAYOUT BASED ON TOPIC:
Before drawing, identify the meeting type and adapt the layout accordingly:
- Sprint/standup → columns per team member or workstream, progress bar, clock icon
- Strategy/business review → rocket or arrow motif, performance charts, goals section
- Interview → person portrait sketch in one section, comparison boxes, decision callout
- Product/design → wireframe sketches, flow diagram, user quote bubble
- Workshop/ideation → brain or lightbulb, concept cards laid out, prioritization grid
- Any meeting → always different from the others, layout driven by the topic

PAGE STRUCTURE:
1. TOP BANNER: Full-width bold hand-lettered title (ALL CAPS, thick marker style). Underline with a wavy double line in blue. Subtitle below in smaller handwriting (date, duration, attendees, goal).
2. MIDDLE ZONES: 2-3 irregular column zones of varying widths and heights — NOT a uniform grid. Each zone contains 1-2 sections.
3. BOTTOM STRIP: 1-2 wide sections for action items, decisions, or next steps — full width or nearly full width.
4. CONNECTING ARROWS: Bold hand-drawn curved or diagonal arrows connecting related sections, showing flow.

SECTION BORDER VARIETY (use all of these within one image):
- Solid hand-drawn rectangle with slightly imperfect corners
- Dashed/dotted border (like torn paper edge)
- Cloud or thought bubble outline
- Jagged "explode" star shape for important callouts
- No border — just a bold underlined header with content below

ILLUSTRATION RULES (CRITICAL for non-boring look):
- Draw 3-5 small hand-drawn sketch illustrations relevant to the meeting content. These are NOT icons from a library — they are quick but expressive sketches:
  • A person's face/upper body (simple but recognizable) for candidates or team sections
  • A product sketch (laptop, phone, can, bottle) for product meetings
  • A rocket with flames for growth/strategy
  • A brain with electricity lines for ideation
  • A trophy or star cluster for achievements
  • A declining/rising hand-drawn graph for performance data
  • A calendar page for deadlines
  • A speech bubble with a key quote
- These illustrations must look genuinely hand-drawn, NOT clipart. Slight imperfections and visible ink strokes are DESIRED.

INLINE DATA VISUALIZATION (draw these by hand, not digitally):
- Progress/status → horizontal bar drawn with thick marker, partially filled, labeled "XX%"
- Percentages/distribution → small pie chart with 2-3 hand-drawn wedges, labeled in handwriting
- Sequence/flow → boxes or circles connected with thick arrows: Step 1 → Step 2 → Step 3
- Comparison → two boxes side by side "OPTION A ✗" vs "OPTION B ✓" with hand-drawn X and checkmark
- Prioritization → simple dot grid or ranked list with numbers circled
- Action items → hand-drawn checkbox squares ☐ before each item, ☑ for done

COLOR USAGE — ADAPT PALETTE TO MEETING TYPE:
First, identify the meeting type from the notes, then pick ONE matching palette below:
- Tech / Engineering / Sprint / Dev standup → Primary: COBALT BLUE. Secondary: RED (for blockers only)
- Strategy / Business review / OKRs / Revenue → Primary: DEEP NAVY BLUE + GOLD/AMBER accents. Secondary: RED for risks
- Product / Design / UX / Creative → Primary: TEAL/CYAN. Secondary: CORAL ORANGE
- Marketing / Brand / Launch / Campaign → Primary: WARM ORANGE. Secondary: DEEP PURPLE
- HR / Hiring / Interview / Recruitment → Primary: SLATE BLUE. Secondary: GREEN (for strengths/approvals)
- Finance / Budget / Quarterly → Primary: FOREST GREEN. Secondary: RED (for deficits/risks)
- Workshop / Ideation / Brainstorm → Primary: VIVID PURPLE. Secondary: BRIGHT YELLOW highlights
- Sales / Client / Partnership → Primary: WARM TEAL. Secondary: ORANGE
- General / Unknown → Primary: COBALT BLUE. Secondary: RED

APPLY THE PALETTE:
- Background: Off-white/warm white paper texture
- 90% of all lines, borders, and text: BLACK marker ink — this never changes
- Primary color: Use for section header underlines, connecting arrows, key number highlights, and light wash shading on illustrations
- Secondary color: Use SPARINGLY — only for the most critical callouts, urgent items, or blockers
- Do NOT use any colors outside the selected palette
- Do NOT paint large solid color fills — use light washes, hatching, and underlines only

CONTENT RULES:
- Infer 4-6 section titles from the content (e.g. "TEAM UPDATES", "BLOCKERS", "SPRINT GOAL", "KEY DECISIONS", "ACTION ITEMS", "NEXT STEPS", "PERFORMANCE", "GOALS", "BACKGROUND", "RISKS")
- Maximum 6-8 words per bullet point. No sentences.
- Key numbers and statistics must be LARGE and visually prominent
- Urgent items prefixed with red △ or "⚠ BLOCKER:"
- If names mentioned, add a small "ATTENDEES:" cluster

═══ MEETING NOTES ═══
${notes}`;

    if (getProvider() === 'openrouter') {
      return await generateImageWithOpenRouter(prompt);
    }

    const response = await generateWithFallback({
      model: 'gemini-3.1-flash-image-preview',
      contents: prompt,
    }, ['gemini-2.5-flash-image-preview']);

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        return `data:${part.inlineData.mimeType || 'image/jpeg'};base64,${part.inlineData.data}`;
      }
    }
    return null;
  } catch (error) {
    const err = error instanceof Error ? error : new Error(String(error));
    log.error('generate_visualization_failed', {
      message: err.message,
      stack: err.stack,
      provider: getProvider(),
    });
    return null;
  }
}

export async function generateEmailContent(text: string): Promise<any> {
  const response: GenerateContentResponse = await generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are an expert executive assistant. Based on the following meeting transcription, generate a highly detailed, professional follow-up email.
    DO NOT MISS ANY DETAILS. Capture every single decision, discussion point, and task mentioned in the meeting.
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: "Email subject line (e.g., 'Meeting Notes & Action Items: [Topic]')" },
          greeting: { type: Type.STRING, description: "Email greeting (e.g., 'Hi Team,')" },
          meetingObjective: { type: Type.STRING, description: "The main purpose or objective of the meeting" },
          keyDecisions: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "List of all major decisions made during the meeting"
          },
          discussionPoints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                topic: { type: Type.STRING, description: "Topic discussed" },
                details: { 
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Detailed bullet points capturing EVERYTHING discussed about this topic"
                }
              },
              required: ["topic", "details"]
            },
            description: "Exhaustive breakdown of all topics discussed"
          },
          tasks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                task: { type: Type.STRING, description: "Detailed description of the action item" },
                owner: { type: Type.STRING, description: "Person responsible (use 'Unassigned' if not explicitly stated)" },
                deadline: { type: Type.STRING, description: "Due date or timeframe (use 'TBD' if not stated)" },
                priority: { type: Type.STRING, description: "Priority level: High, Medium, or Low based on context" },
                notes: { type: Type.STRING, description: "Any additional context or dependencies for the task" }
              },
              required: ["task", "owner", "deadline", "priority", "notes"]
            },
            description: "Comprehensive list of all action items and next steps"
          },
          nextMeeting: { type: Type.STRING, description: "Details about the next sync/meeting if mentioned, or proposed next steps" },
          closing: { type: Type.STRING, description: "Professional closing statement" }
        },
        required: ["subject", "greeting", "meetingObjective", "keyDecisions", "discussionPoints", "tasks", "nextMeeting", "closing"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    log.error('parse_email_json_failed', { error: e instanceof Error ? e : undefined });
    return { subject: "Follow-up", greeting: "Hi Team,", meetingObjective: "", keyDecisions: [], discussionPoints: [], tasks: [], nextMeeting: "", closing: "Best regards" };
  }
}

function cleanTranscriptionForKG(raw: string, maxChars = 8000): string {
  let cleaned = raw
    .replace(/\n{3,}/g, '\n\n')           // collapse 3+ newlines → 2
    .replace(/[ \t]{2,}/g, ' ')            // collapse multiple spaces/tabs → 1
    .replace(/(\b(um|uh|hmm|yeah|like|you know|I mean)\b[.,]?\s*)+/gi, ' ') // strip filler words
    .trim();

  if (cleaned.length <= maxChars) return cleaned;

  // Truncate to last complete sentence within maxChars
  const slice = cleaned.substring(0, maxChars);
  const lastSentenceEnd = Math.max(
    slice.lastIndexOf('. '),
    slice.lastIndexOf('? '),
    slice.lastIndexOf('! ')
  );
  return lastSentenceEnd > maxChars * 0.5
    ? slice.substring(0, lastSentenceEnd + 1)
    : slice;
}

export async function extractKnowledgeGraph(meetingId: string, meetingTitle: string, text: string): Promise<any> {
  const emptyResult = { meetingId, meetingTitle, topics: [], decisions: [], people: [], actionItems: [], references: [] };

  if (!text || text.trim().length < 50) {
    log.warn('kg_extraction_skipped_short_text', { meetingId, textLength: text?.length || 0 });
    return emptyResult;
  }

  const provider = getProvider();
  const geminiApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || (import.meta as any).env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const openRouterKey = getOpenRouterKey();
  
  if (provider === 'gemini' && !geminiApiKey) {
    log.error('api_key_missing');
    return emptyResult;
  }
  if (provider === 'openrouter' && !openRouterKey) {
    log.error('openrouter_key_missing');
    return emptyResult;
  }
  
  const combinedPrompt = `You are a JSON-only API. You MUST respond with ONLY valid JSON, no text before or after. Never include explanations, greetings, or markdown. Output raw JSON only.

Extract knowledge graph data from this meeting transcription. You MUST extract AT LEAST one topic from any meeting transcription — even brief meetings have at least one discussion point.

TOPIC RULES:
- Every topic MUST have a non-empty "name" field (2-5 words describing the topic)
- Every topic MUST have a non-empty "summary" field (1-2 sentences about what was discussed)
- Every topic MUST have a valid "status" field (one of the values below)
- NEVER return a topic with an empty or blank "name" — this is a critical error

TOPIC STATUS RULES (you MUST use one of these exact values):
- "new" = Topic mentioned for the first time, just introduced, no prior discussion implied
- "ongoing" = Topic is actively being worked on, in progress, not yet finished. Look for phrases like "still working on", "in progress", "continuing", "we're looking into", "not done yet"
- "resolved" = Topic has been completed, finished, or a final decision was reached. Look for phrases like "done", "completed", "finished", "signed off", "approved", "wrapped up", "closed"
- "off-track" = Topic has problems, is delayed, blocked, or going wrong. Look for phrases like "delayed", "blocked", "issue with", "problem", "behind schedule", "stuck", "failing", "not working", "concerned about"
- "revisited" = Topic was discussed before and is being brought up again. Look for phrases like "coming back to", "revisiting", "as we discussed before", "following up on", "update on"

Return ONLY this JSON structure:
{"topics":[{"name":"short topic name (REQUIRED, non-empty)","summary":"1-2 sentence summary (REQUIRED, non-empty)","status":"new|ongoing|resolved|off-track|revisited"}],"decisions":[{"decision":"what was decided","relatedTopic":"related topic name"}],"people":["Person Name"],"actionItems":[{"task":"what needs to be done","owner":"who is responsible","relatedTopic":"related topic name"}],"references":["any documents, tools, or resources mentioned"]}

IMPORTANT: Do NOT default all statuses to "new". Carefully read the tone and context of the discussion for each topic. Most real meetings have a mix of statuses.

Meeting: ${meetingTitle}
Transcription: ${cleanTranscriptionForKG(text)}`;

  try {
    const modelsToTry = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite'];
    let response: Response | null = null;
    const MAX_RETRIES = 4;
    const BASE_DELAY = 2000;

    for (const model of modelsToTry) {
      let succeeded = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (provider === 'openrouter') {
          response = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://wisprnote.app',
              'X-Title': 'WisprNote AI',
            },
            body: JSON.stringify({
              model: toOpenRouterModel(model),
              messages: [{ role: 'user', content: combinedPrompt }],
              temperature: 0.1,
              response_format: { type: 'json_object' },
            })
          }, 90000);
        } else {
          response = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: combinedPrompt }] }],
              generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
            })
          }, 90000);
        }

        if (response.ok) { succeeded = true; break; }
        if (response.status !== 503 && response.status !== 429) break;
        if (attempt < MAX_RETRIES) {
          const delay = BASE_DELAY * Math.pow(2, attempt) + Math.random() * 1000;
          log.warn('kg_extraction_retry', { model, provider, status: response.status, delayMs: Math.round(delay), attempt: attempt + 1 });
          await new Promise(r => setTimeout(r, delay));
        }
      }
      if (succeeded) break;
      const errorText = await response!.text();
      log.warn('kg_extraction_model_failed', { model, provider, status: response!.status, body: errorText.slice(0, 200) });
    }

    if (!response || !response.ok) {
      throw new Error(`All KG extraction models failed (provider: ${provider})`);
    }

    const data = await response.json();
    const content = provider === 'openrouter'
      ? data.choices?.[0]?.message?.content || '{}'
      : data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    
    // Extract and repair JSON from response
    let cleanContent = content.trim();
    
    // Remove markdown code blocks if Gemini ignores responseMimeType
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.slice(7);
    } else if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.slice(3);
    }
    if (cleanContent.endsWith('```')) {
      cleanContent = cleanContent.slice(0, -3);
    }
    cleanContent = cleanContent.trim();
    
    // Try to find JSON object in the response if it starts with text
    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanContent = jsonMatch[0];
    }

    // Attempt to repair common JSON issues
    const repairJson = (str: string): string => {
      let repaired = str;
      // Fix trailing commas before ] or }
      repaired = repaired.replace(/,\s*([}\]])/g, '$1');
      // Fix missing commas between array elements
      repaired = repaired.replace(/"\s*\n\s*"/g, '",\n"');
      repaired = repaired.replace(/}\s*\n\s*{/g, '},\n{');
      // Fix unescaped newlines in strings (replace with space)
      repaired = repaired.replace(/([^\\])\\n/g, '$1 ');
      return repaired;
    };

    // Try parsing, with repair fallback
    let parsed: any;
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      try {
        parsed = JSON.parse(repairJson(cleanContent));
      } catch {
        // Last resort: extract what we can manually
        log.warn('json_repair_failed');
        parsed = {
          topics: [],
          decisions: [],
          people: [],
          actionItems: [],
          references: []
        };
        
        // Try to extract topics array
        const topicsMatch = cleanContent.match(/"topics"\s*:\s*\[([\s\S]*?)\]/);
        if (topicsMatch) {
          try {
            parsed.topics = JSON.parse(`[${topicsMatch[1]}]`.replace(/,\s*]/g, ']'));
          } catch { /* ignore */ }
        }
        
        // Try to extract people array
        const peopleMatch = cleanContent.match(/"people"\s*:\s*\[([\s\S]*?)\]/);
        if (peopleMatch) {
          try {
            parsed.people = JSON.parse(`[${peopleMatch[1]}]`.replace(/,\s*]/g, ']'));
          } catch { /* ignore */ }
        }
      }
    }
    
    // Validate and sanitize extracted data — filter out malformed entries
    const validTopics = (parsed.topics || []).filter(
      (t: any) => t && typeof t.name === 'string' && t.name.trim().length > 0
    ).map((t: any) => ({
      name: t.name.trim(),
      summary: (t.summary || '').trim(),
      status: ['new', 'ongoing', 'resolved', 'off-track', 'revisited'].includes(t.status) ? t.status : 'new',
    }));

    const validDecisions = (parsed.decisions || []).filter(
      (d: any) => d && typeof d.decision === 'string' && d.decision.trim().length > 0
    ).map((d: any) => ({
      decision: d.decision.trim(),
      relatedTopic: (d.relatedTopic || '').trim(),
    }));

    const validPeople = (parsed.people || []).filter(
      (p: any) => typeof p === 'string' && p.trim().length > 0
    ).map((p: string) => p.trim());

    const validActionItems = (parsed.actionItems || parsed.action_items || []).filter(
      (a: any) => a && typeof a.task === 'string' && a.task.trim().length > 0
    ).map((a: any) => ({
      task: a.task.trim(),
      owner: (a.owner || 'Unassigned').trim(),
      relatedTopic: (a.relatedTopic || '').trim(),
    }));

    const validReferences = (parsed.references || []).filter(
      (r: any) => typeof r === 'string' && r.trim().length > 0
    );

    // If extraction produced zero valid topics despite having text, attempt one retry with a simpler prompt
    if (validTopics.length === 0 && text.trim().length >= 100) {
      log.warn('kg_zero_topics_retry', { meetingId, meetingTitle });
      try {
        const retryPrompt = `Extract the main discussion topics from this meeting transcription. Return ONLY a JSON object.

RULES:
- You MUST find at least 1 topic. Every meeting discusses something.
- Each topic needs: "name" (2-5 word title, NEVER empty), "summary" (1 sentence), "status" (one of: new, ongoing, resolved, off-track, revisited)

Return: {"topics":[{"name":"Topic Name","summary":"What was discussed","status":"new"}],"decisions":[],"people":[],"actionItems":[],"references":[]}

Meeting: ${meetingTitle}
Text: ${cleanTranscriptionForKG(text, 4000)}`;

        const retryModel = 'gemini-3-flash-preview';
        let retryResp: Response;
        if (provider === 'openrouter') {
          retryResp = await fetchWithTimeout('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://wisprnote.app',
              'X-Title': 'WisprNote AI',
            },
            body: JSON.stringify({
              model: toOpenRouterModel(retryModel),
              messages: [{ role: 'user', content: retryPrompt }],
              temperature: 0.2,
              response_format: { type: 'json_object' },
            })
          }, 90000);
        } else {
          retryResp = await fetchWithTimeout(`https://generativelanguage.googleapis.com/v1beta/models/${retryModel}:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: retryPrompt }] }],
              generationConfig: { temperature: 0.2, responseMimeType: "application/json" }
            })
          }, 90000);
        }

        if (retryResp.ok) {
          const retryData = await retryResp.json();
          const retryContent = provider === 'openrouter'
            ? retryData.choices?.[0]?.message?.content || '{}'
            : retryData.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
          let retryClean = retryContent.trim().replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
          const retryJsonMatch = retryClean.match(/\{[\s\S]*\}/);
          if (retryJsonMatch) retryClean = retryJsonMatch[0];
          const retryParsed = JSON.parse(retryClean);
          const retryTopics = (retryParsed.topics || []).filter(
            (t: any) => t && typeof t.name === 'string' && t.name.trim().length > 0
          ).map((t: any) => ({
            name: t.name.trim(),
            summary: (t.summary || '').trim(),
            status: ['new', 'ongoing', 'resolved', 'off-track', 'revisited'].includes(t.status) ? t.status : 'new',
          }));
          if (retryTopics.length > 0) {
            log.info('kg_retry_recovered_topics', { meetingId, topicCount: retryTopics.length });
            return {
              meetingId, meetingTitle,
              topics: retryTopics,
              decisions: validDecisions,
              people: validPeople,
              actionItems: validActionItems,
              references: validReferences,
            };
          }
        }
      } catch (retryErr) {
        log.warn('kg_retry_failed', { meetingId, error: retryErr instanceof Error ? retryErr : undefined });
      }
    }

    return {
      meetingId,
      meetingTitle,
      topics: validTopics,
      decisions: validDecisions,
      people: validPeople,
      actionItems: validActionItems,
      references: validReferences,
    };
  } catch (e) {
    log.error('kg_extraction_failed', { error: e instanceof Error ? e : undefined });
    return { meetingId, meetingTitle, topics: [], decisions: [], people: [], actionItems: [], references: [] };
  }
}

export async function generateWikiContent(text: string, style: 'MECE' | 'PRD'): Promise<any> {
  const prompt = style === 'MECE' 
    ? `Generate a detailed end-to-end report using the MECE (Mutually Exclusive, Collectively Exhaustive) framework. Ensure all points are logically grouped and exhaustive.`
    : `Generate a comprehensive Product Requirements Document (PRD). Include detailed sections for UI/UX Requirements, User Stories, Developer Team Tasks, and Competitor Analysis.`;

  const response: GenerateContentResponse = await generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following meeting transcription, ${prompt}
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Document title" },
          subtitle: { type: Type.STRING, description: "Document subtitle or description" },
          date: { type: Type.STRING, description: "Document date" },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING, description: "Section heading" },
                content: { type: Type.STRING, description: "Section content (detailed paragraph)" },
                bullets: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING },
                  description: "Key bullet points for this section"
                }
              },
              required: ["heading", "content", "bullets"]
            }
          },
          conclusion: { type: Type.STRING, description: "Conclusion or summary" }
        },
        required: ["title", "subtitle", "date", "sections", "conclusion"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    log.error('parse_wiki_json_failed', { error: e instanceof Error ? e : undefined });
    return { title: "Wiki Document", subtitle: "", date: new Date().toLocaleDateString(), sections: [], conclusion: "" };
  }
}

export async function generatePodcastScript(text: string): Promise<any> {
  const response: GenerateContentResponse = await generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are two engaging podcast hosts, Alex and Sarah. Based on the following meeting transcription or notes, create an engaging, dynamic podcast script.
    - Alex is the lead host, energetic and curious.
    - Sarah is the analytical co-host, insightful and witty.
    - They should banter, occasionally joke or laugh, and break down the complex topics from the meeting into easy-to-understand conversational bites.
    - Ensure the script flows naturally like a real audio podcast.
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Catchy title for this podcast episode" },
          dialogue: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                speaker: { type: Type.STRING, description: "Must be exactly 'Alex' or 'Sarah'" },
                text: { type: Type.STRING, description: "The spoken dialogue" },
                emotion: { type: Type.STRING, description: "Optional emotion cue (e.g., 'laughing', 'serious', 'excited')" }
              },
              required: ["speaker", "text"]
            },
            description: "The sequential script of the podcast"
          }
        },
        required: ["title", "dialogue"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    log.error('parse_podcast_json_failed', { error: e instanceof Error ? e : undefined });
    return { title: "Meeting Breakdown", dialogue: [{ speaker: "Alex", text: "Welcome to the podcast! We had some issues processing the notes, but we'll try again later." }] };
  }
}

export async function chatWithPodcast(context: string, currentDialogue: any[], userMessage: string): Promise<any> {
  const dialogueHistory = currentDialogue.map(d => `${d.speaker}: ${d.text}`).join('\n');
  
  const response: GenerateContentResponse = await generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are two engaging podcast hosts, Alex and Sarah, currently mid-recording. 
    A special guest (the User) has just joined the studio live and said something.
    Based on the meeting context, the ongoing dialogue, and the user's input, generate the next few lines of dialogue where Alex and Sarah react to the user and continue the conversation.
    Keep the same energetic, witty podcast tone. The hosts should directly address the "Guest".
    
    Original Meeting Context:
    ${context}
    
    Recent Dialogue:
    ${dialogueHistory.slice(-1000)} // Last ~1000 chars of dialogue
    
    Guest (User) just said:
    "${userMessage}"
    
    Generate 2-4 new lines of dialogue responding to the guest.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          dialogue: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                speaker: { type: Type.STRING, description: "Must be exactly 'Alex' or 'Sarah'" },
                text: { type: Type.STRING, description: "The spoken dialogue responding to the guest" },
                emotion: { type: Type.STRING, description: "Optional emotion cue" }
              },
              required: ["speaker", "text"]
            }
          }
        },
        required: ["dialogue"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}").dialogue || [];
  } catch (e) {
    log.error('parse_podcast_chat_json_failed', { error: e instanceof Error ? e : undefined });
    return [{ speaker: "Alex", text: "Wow, great point from our guest!" }, { speaker: "Sarah", text: "Absolutely, thanks for joining us." }];
  }
}
