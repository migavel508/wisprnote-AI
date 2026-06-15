import { getSecrets } from './secrets';
import { MODELS, chain } from './models/registry';

/**
 * Server-side knowledge-graph extraction.
 *
 * A meeting's transcript is immutable once recorded, so its knowledge graph
 * (topics / decisions / people / action items) should be computed EXACTLY ONCE,
 * server-side, at ingestion — not re-derived in the browser every time the user
 * opens the Knowledge Graph tab. This module is the extractor; `kgSweep.ts`
 * drives it as a background job.
 *
 * The prompt + validation here are a faithful port of the client-side
 * `extractKnowledgeGraph()` (geminiService.ts), so output quality and the topic
 * status taxonomy (incl. "off-track") are identical.
 */

export interface KGTopic { name: string; summary: string; status: string }
export interface KGDecision { decision: string; relatedTopic: string }
export interface KGActionItem { task: string; owner: string; relatedTopic: string }

export interface KGResult {
  topics: KGTopic[];
  decisions: KGDecision[];
  people: string[];
  action_items: KGActionItem[];
  refs: string[];
}

const EMPTY: KGResult = { topics: [], decisions: [], people: [], action_items: [], refs: [] };
const VALID_STATUS = ['new', 'ongoing', 'resolved', 'off-track', 'revisited'];

/** Trim a transcript down to a bounded, model-friendly window (mirrors client cleanTranscriptionForKG). */
function cleanTranscript(raw: string, maxChars = 8000): string {
  let t = (raw || '').replace(/\s+/g, ' ').trim();
  if (t.length > maxChars) {
    // Keep the head and tail — meetings often resolve/decide near the end.
    const head = t.slice(0, Math.floor(maxChars * 0.7));
    const tail = t.slice(-Math.floor(maxChars * 0.3));
    t = `${head}\n…\n${tail}`;
  }
  return t;
}

function buildPrompt(title: string, text: string): string {
  return `You are a JSON-only API. You MUST respond with ONLY valid JSON, no text before or after. Never include explanations, greetings, or markdown. Output raw JSON only.

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

Meeting: ${title}
Transcription: ${cleanTranscript(text)}`;
}

/** Repair common JSON faults from LLM output, then parse. Returns {} on total failure. */
function parseLoose(content: string): any {
  let s = (content || '').trim();
  if (s.startsWith('```json')) s = s.slice(7);
  else if (s.startsWith('```')) s = s.slice(3);
  if (s.endsWith('```')) s = s.slice(0, -3);
  s = s.trim();
  const m = s.match(/\{[\s\S]*\}/);
  if (m) s = m[0];
  try { return JSON.parse(s); } catch { /* repair below */ }
  const repaired = s
    .replace(/,\s*([}\]])/g, '$1')
    .replace(/"\s*\n\s*"/g, '",\n"')
    .replace(/}\s*\n\s*{/g, '},\n{')
    .replace(/([^\\])\\n/g, '$1 ');
  try { return JSON.parse(repaired); } catch { return {}; }
}

function sanitize(parsed: any): KGResult {
  const topics: KGTopic[] = (parsed.topics || [])
    .filter((t: any) => t && typeof t.name === 'string' && t.name.trim().length > 0)
    .map((t: any) => ({
      name: t.name.trim(),
      summary: (t.summary || '').trim(),
      status: VALID_STATUS.includes(t.status) ? t.status : 'new',
    }));
  const decisions: KGDecision[] = (parsed.decisions || [])
    .filter((d: any) => d && typeof d.decision === 'string' && d.decision.trim().length > 0)
    .map((d: any) => ({ decision: d.decision.trim(), relatedTopic: (d.relatedTopic || '').trim() }));
  const people: string[] = (parsed.people || [])
    .filter((p: any) => typeof p === 'string' && p.trim().length > 0)
    .map((p: string) => p.trim());
  const action_items: KGActionItem[] = (parsed.actionItems || parsed.action_items || [])
    .filter((a: any) => a && typeof a.task === 'string' && a.task.trim().length > 0)
    .map((a: any) => ({ task: a.task.trim(), owner: (a.owner || 'Unassigned').trim(), relatedTopic: (a.relatedTopic || '').trim() }));
  const refs: string[] = (parsed.references || parsed.refs || [])
    .filter((r: any) => typeof r === 'string' && r.trim().length > 0)
    .map((r: string) => r.trim());
  return { topics, decisions, people, action_items, refs };
}

/** One Gemini generateContent call returning raw text, with retry on 429/503. */
async function generate(apiKey: string, model: string, prompt: string): Promise<string | null> {
  const MAX_RETRIES = 3;
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const resp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ role: 'user', parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.1, responseMimeType: 'application/json' },
        }),
      },
    );
    if (resp.ok) {
      const data: any = await resp.json();
      return data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    }
    if (resp.status !== 503 && resp.status !== 429) return null;
    if (attempt < MAX_RETRIES) {
      await new Promise((r) => setTimeout(r, 1500 * Math.pow(2, attempt)));
    }
  }
  return null;
}

/**
 * Extract a meeting's knowledge graph from its transcription.
 *
 * Returns a DB-ready KGResult on success (topics may be empty when the meeting
 * genuinely has nothing to extract — that's a valid, terminal result). Returns
 * `null` ONLY on a hard/transient failure (no model reachable, no API key) so
 * the caller knows to retry it on a later sweep rather than persisting a blank.
 * Never throws — a single bad meeting can't break a sweep.
 */
export async function extractKnowledgeGraph(title: string, transcription: string): Promise<KGResult | null> {
  const text = (transcription || '').trim();
  // Too short to ever yield anything — terminal "empty", safe to persist.
  if (text.length < 50) return EMPTY;

  const { GEMINI_API_KEY } = await getSecrets();
  if (!GEMINI_API_KEY) return null; // config issue — retry later, don't blank it

  // Model versions come from the registry (aws/api/src/models/registry.ts).
  const models = chain(MODELS.kgExtract);
  const prompt = buildPrompt(title, text);

  let result = EMPTY;
  let anySuccess = false;
  for (const model of models) {
    const raw = await generate(GEMINI_API_KEY, model, prompt);
    if (raw == null) continue;
    anySuccess = true;
    result = sanitize(parseLoose(raw));
    if (result.topics.length > 0) break;
  }
  // Every model call failed (throttle/network) — signal a retryable failure.
  if (!anySuccess) return null;

  // One simpler retry if we got text but zero topics (matches client behaviour).
  if (result.topics.length === 0 && text.length >= 100) {
    const retryPrompt = `Extract the main discussion topics from this meeting transcription. Return ONLY a JSON object.

RULES:
- You MUST find at least 1 topic. Every meeting discusses something.
- Each topic needs: "name" (2-5 word title, NEVER empty), "summary" (1 sentence), "status" (one of: new, ongoing, resolved, off-track, revisited)

Return: {"topics":[{"name":"Topic Name","summary":"What was discussed","status":"new"}],"decisions":[],"people":[],"actionItems":[],"references":[]}

Meeting: ${title}
Text: ${cleanTranscript(text, 4000)}`;
    const raw = await generate(GEMINI_API_KEY, MODELS.kgExtract.primary, retryPrompt);
    if (raw != null) {
      const retry = sanitize(parseLoose(raw));
      if (retry.topics.length > 0) result = retry;
    }
  }

  return result;
}
