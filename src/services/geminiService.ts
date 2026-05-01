import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { AudioBatch, blobToBase64, BlobReadError } from "./audioService";
import { logger } from '../lib/logger';

const log = logger.scope('Gemini');

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

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

  const response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://lumina-ai.app',
      'X-Title': 'Lumina AI',
    },
    body: JSON.stringify(body),
  });

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

// Unified content generation — routes to OpenRouter or Gemini based on provider
async function generateContent(requestOptions: any): Promise<GenerateContentResponse> {
  if (getProvider() === 'openrouter') {
    return callOpenRouter(requestOptions);
  }
  return ai.models.generateContent(requestOptions);
}

// ─── Retry Utility ───────────────────────────────────────────────────────────
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const RETRYABLE_MSGS = ['rate limit', 'quota', 'overloaded', 'fetch failed', 'network error', 'etimedout', 'econnreset'];

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
        const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${apiKey}`,
            'Content-Type': 'application/json',
            'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://lumina-ai.app',
            'X-Title': 'Lumina AI',
          },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            modalities: ['image', 'text'],
            temperature: 0.2,
          }),
        });

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
  fallbackModels: string[] = ["gemini-3.1-flash-lite-preview", "gemini-3-flash-preview"]
): Promise<GenerateContentResponse> {
  const provider = getProvider();
  let lastError;
  const modelsToTry = [requestOptions.model, ...fallbackModels];

  for (let mi = 0; mi < modelsToTry.length; mi++) {
    const model = modelsToTry[mi];
    // Give the primary model more attempts; fallbacks are safety nets.
    const retries = mi === 0 ? 8 : 4;
    try {
      return await withRetry(
        () => provider === 'openrouter'
          ? callOpenRouter({ ...requestOptions, model })
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
    const { supabase } = await import('./supabaseService');
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      // Use user metadata name if available, else fallback to email prefix
      const name = session.user.user_metadata?.full_name || session.user.user_metadata?.name;
      const emailName = session.user.email?.split('@')[0];
      if (name || emailName) {
        userName = name || emailName || "the user";
      }
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

  const response = await generateWithFallback({
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
  });

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
    const { supabase } = await import('./supabaseService');
    const { data: { session } } = await supabase.auth.getSession();
    if (session?.user) {
      const name = session.user.user_metadata?.full_name || session.user.user_metadata?.name;
      const emailName = session.user.email?.split('@')[0];
      if (name || emailName) {
        userName = name || emailName || "the user";
      }
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

export async function generateMeetingTitle(transcription: string): Promise<string> {
  // Use only first 500 chars to minimize token usage - enough to understand context
  const snippet = transcription.substring(0, 500).trim();
  
  const response = await generateWithFallback({
    model: "gemini-3.1-flash-lite-preview", // Use faster, cheaper model for simple title generation
    contents: `Title this meeting in 3-6 words. No quotes. Just the title.

Content: ${snippet}`,
  });
  
  // Clean up the response
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

function sanitizeInlineCitations(text: string): string {
  return text
    .replace(/\[M\d+-E\d+(?:\s*,\s*M\d+-E\d+)*\]/gi, '')
    .replace(/\[\d+(?:\s*,\s*\d+)*\]/g, '')
    .replace(/\[(summary|source)\]/gi, '')
    .replace(/\s{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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
      model: 'gemini-3.1-flash-lite-preview',
      contents: [{ role: 'user', parts: [{ text: verifierPrompt }] }],
      config: {
        temperature: 0.1,
        maxOutputTokens: 1800,
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
      systemInstruction: `You are a precise intent classifier for a meeting AI assistant called Lumina.

The user has ${isSingleMeeting ? '1 meeting selected' : `${meetingTitles.length} meetings available`}.

Your job is to deeply understand exactly what the user is asking for — not more, not less.

Output ONLY valid JSON (no markdown fences):
{
  "intent": "<precise, actionable 1-sentence description that captures EXACTLY what the user wants — include the specific deliverable, scope, and any constraints they mentioned>",
  "isBroad": ${isSingleMeeting ? 'false' : '<true if the user explicitly or implicitly wants to cover ALL/EVERY meeting, or asks for exhaustive cross-meeting analysis like "key topics from all meetings" or "summarize everything". false if they want specific information that likely lives in a few meetings>'}
}

CRITICAL RULES for intent:
- Preserve the user's exact scope: if they say "key topics" write "key topics", not "decisions" or "action items"
- If they say "all meetings", the intent MUST reflect covering ALL meetings, not a subset
- If they ask for one specific thing (e.g. "key topics"), do NOT expand it to multiple things (e.g. don't add "decisions, action items, and next steps")
- The intent should be a direct instruction that could be given to another AI to execute`,
      maxOutputTokens: 200,
    },
  });

  try {
    const raw = (response.text || '').replace(/```json\s*/gi, '').replace(/```\s*/gi, '').trim();
    const parsed = JSON.parse(raw);
    return {
      intent: parsed.intent || userQuery,
      scope: isSingleMeeting ? 'single' : 'many',
      isBroad: !!parsed.isBroad,
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

  // ── Build rich context from all available sources ──────────────────────────
  let contextSections: string[] = [];

  if (data.preparedContext?.trim()) {
    contextSections.push(data.preparedContext.trim());
  } else {

  // 1. Always include structured notes and summary when available (highest quality)
    if (summary?.trim()) {
      contextSections.push(`=== AI-GENERATED MEETING SUMMARY ===\n${summary.trim()}`);
    }
    if (notes?.trim()) {
      // Strip HTML tags from notes (TipTap saves HTML)
      const plainNotes = notes.replace(/<[^>]+>/g, ' ').replace(/\s{2,}/g, ' ').trim();
      if (plainNotes.length > 20) {
        contextSections.push(`=== MEETING NOTES ===\n${plainNotes}`);
      }
    }

  // 2. Add transcription chunks via BM25 retrieval
    if (transcription?.trim() && useRAG) {
      const chunks = chunkTranscription(transcription);
      // For overview queries fetch more chunks; for specific queries fewer but more precise
      const topK = isOverview ? 10 : 6;
      const results = await retrieveRelevantChunks(message, chunks, topK);
      const retrieved = prepareContext(results);

      if (retrieved.trim()) {
        contextSections.push(`=== TRANSCRIPTION EXCERPTS ===\n${retrieved}`);
      } else if (transcription.trim()) {
        // Fallback: use entire transcription (capped at 6000 chars) when BM25 finds nothing
        contextSections.push(`=== FULL TRANSCRIPTION ===\n${transcription.substring(0, 6000)}${transcription.length > 6000 ? '\n[... truncated ...]' : ''}`);
      }
    } else if (transcription?.trim()) {
      contextSections.push(`=== TRANSCRIPTION ===\n${transcription}`);
    }
  }

  const fullContext = contextSections.join('\n\n');
  const meetingLabel = title ? `"${title}"` : 'this meeting';

  const systemInstruction = isOverview
    ? `You are an expert meeting assistant with access to comprehensive data for ${meetingLabel}.

Your task: Provide a thorough, detailed, well-structured answer to the user's question.

STRICT GROUNDING RULES (most important):
- ONLY state facts that appear verbatim or are directly supported by the context below.
- If information is NOT in the context, say so explicitly — never guess or infer.
- When multiple context sources agree, synthesise into one cohesive answer and note the agreement.
- When sources conflict, present both viewpoints and flag the discrepancy.

FORMATTING:
- Use headings, bullet points, or numbered lists for clarity.
- Name specific speakers, decisions, dates, or action items exactly as they appear in the context.
- Provide FULL detail — do not truncate or over-summarise when the user asks for detail.

MEETING CONTEXT:
${fullContext}

RESPONSE QUALITY CONTRACT:
- Ground every factual claim in the provided evidence.
- Do NOT print citation markers like [M1-E2], [2], [Summary], or [Source].
- If evidence confidence is weak, state uncertainty clearly.`

    : `You are a precise meeting assistant for ${meetingLabel}.

Your task: Answer the user's specific question accurately using ONLY the provided meeting context.

STRICT GROUNDING RULES (most important):
- Answer ONLY from the evidence below — never fabricate or infer facts not present in context.
- Quote or closely paraphrase the exact relevant section(s).
- If the answer is genuinely absent from ALL provided sources, say: "I couldn't find that specific information in this meeting's records."
- If you are uncertain, say so rather than guessing.

FORMATTING:
- Answer directly and specifically — do not pad with irrelevant details.
- If a speaker made the relevant statement, name them.
- If multiple pieces of context are relevant, address each one.

MEETING CONTEXT:
${fullContext}

RESPONSE QUALITY CONTRACT:
- Answer only from supplied evidence — zero fabrication tolerance.
- Do NOT print citation markers like [M1-E2], [2], [Summary], or [Source].
- If evidence is insufficient, state exactly what is missing.`;

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
  const systemInstruction = `You are Lumina, an expert meeting AI assistant.

USER'S EXACT REQUEST: "${params.userQuery}"
INTERPRETED TASK: ${params.intent}
Evidence was retrieved across ${params.meetingsVisited} out of ${params.totalMeetings} total meetings.

STRICT GROUNDING RULES (most important):
- Answer ONLY from the evidence provided below — zero fabrication tolerance.
- Answer EXACTLY what the user asked — nothing more, nothing less.
- If the user asked for "key topics", deliver key topics. Do NOT add action items, next steps, or other extras unless asked.
- If the user asked to cover "all meetings", your response MUST reference ALL meetings with evidence. State how many you covered.
- If the user asked about a specific aspect (decisions, topics, action items), focus ONLY on that aspect.
- If evidence doesn't support a claim, do NOT make it. Say "no evidence found" for that meeting instead.
- When you are uncertain, explicitly flag it rather than guessing.

FORMATTING:
- Use headings, bullet points, or numbered lists for clarity.
- Reference specific speakers and meeting names exactly as they appear in the evidence.
- Cover findings from EVERY meeting that had relevant evidence — do not skip any.
- State the total number of meetings covered at the beginning.

RESPONSE QUALITY CONTRACT:
- Every factual statement must trace back to the evidence below.
- Do NOT print citation markers like [1], [M1-E2], [Source], etc.
- If evidence is weak or missing for some meetings, state that clearly.

${params.context}`;

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
  const provider = getProvider();
  const geminiApiKey = (import.meta as any).env?.VITE_GEMINI_API_KEY || (import.meta as any).env?.GEMINI_API_KEY || process.env.GEMINI_API_KEY;
  const openRouterKey = getOpenRouterKey();
  
  if (provider === 'gemini' && !geminiApiKey) {
    log.error('api_key_missing');
    return { meetingId, meetingTitle, topics: [], decisions: [], people: [], actionItems: [], references: [] };
  }
  if (provider === 'openrouter' && !openRouterKey) {
    log.error('openrouter_key_missing');
    return { meetingId, meetingTitle, topics: [], decisions: [], people: [], actionItems: [], references: [] };
  }
  
  const combinedPrompt = `You are a JSON-only API. You MUST respond with ONLY valid JSON, no text before or after. Never include explanations, greetings, or markdown. Output raw JSON only.

Extract knowledge graph data from this meeting transcription. For each topic discussed, carefully analyze the conversation to determine its status:

TOPIC STATUS RULES (you MUST use one of these exact values):
- "new" = Topic mentioned for the first time, just introduced, no prior discussion implied
- "ongoing" = Topic is actively being worked on, in progress, not yet finished. Look for phrases like "still working on", "in progress", "continuing", "we're looking into", "not done yet"
- "resolved" = Topic has been completed, finished, or a final decision was reached. Look for phrases like "done", "completed", "finished", "signed off", "approved", "wrapped up", "closed"
- "off-track" = Topic has problems, is delayed, blocked, or going wrong. Look for phrases like "delayed", "blocked", "issue with", "problem", "behind schedule", "stuck", "failing", "not working", "concerned about"
- "revisited" = Topic was discussed before and is being brought up again. Look for phrases like "coming back to", "revisiting", "as we discussed before", "following up on", "update on"

Return ONLY this JSON structure:
{"topics":[{"name":"short topic name","summary":"1-2 sentence summary of what was said about this topic","status":"new|ongoing|resolved|off-track|revisited"}],"decisions":[{"decision":"what was decided","relatedTopic":"related topic name"}],"people":["Person Name"],"actionItems":[{"task":"what needs to be done","owner":"who is responsible","relatedTopic":"related topic name"}],"references":["any documents, tools, or resources mentioned"]}

IMPORTANT: Do NOT default all statuses to "new". Carefully read the tone and context of the discussion for each topic. Most real meetings have a mix of statuses.

Meeting: ${meetingTitle}
Transcription: ${cleanTranscriptionForKG(text)}`;

  try {
    const modelsToTry = ['gemini-3-flash-preview', 'gemini-3.1-flash-lite-preview'];
    let response: Response | null = null;
    const MAX_RETRIES = 4;
    const BASE_DELAY = 2000;

    for (const model of modelsToTry) {
      let succeeded = false;
      for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        if (provider === 'openrouter') {
          response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${openRouterKey}`,
              'Content-Type': 'application/json',
              'HTTP-Referer': typeof window !== 'undefined' ? window.location.origin : 'https://lumina-ai.app',
              'X-Title': 'Lumina AI',
            },
            body: JSON.stringify({
              model: toOpenRouterModel(model),
              messages: [{ role: 'user', content: combinedPrompt }],
              temperature: 0.1,
              response_format: { type: 'json_object' },
            })
          });
        } else {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiApiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: [{ text: combinedPrompt }] }],
              generationConfig: { temperature: 0.1, responseMimeType: "application/json" }
            })
          });
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
    let parsed;
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
    
    return { meetingId, meetingTitle, ...parsed };
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
