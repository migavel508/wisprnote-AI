/**
 * Braintrust ONLINE-SCORING scorers (production logs).
 *
 * These register reusable LLM-judge scorers in the "wisprnote-ai" project so
 * Braintrust can run them AUTOMATICALLY on a sample of live production spans —
 * the proxied intelligence calls (Gemini / Claude / OpenRouter chat, notes,
 * summary, knowledge graph) that flow through `ai.ts`.
 *
 * ── One-time setup ──────────────────────────────────────────────────────────
 * 1. Push these scorers into the project (run from aws/api):
 *        BRAINTRUST_API_KEY=sk-...  npm run push:scorers
 *    (or: npx braintrust push evals/scorers.ts)
 * 2. In Braintrust → project "wisprnote-ai" → Configuration → Environment
 *    variables, set ANTHROPIC_API_KEY (the judge calls Claude). Outbound fetch
 *    to api.anthropic.com runs in Braintrust's function sandbox.
 * 3. In Braintrust → project → Configuration → Online scoring, add a rule:
 *      • Scorer: "Faithfulness" (and "Answer relevancy")
 *      • Sampling rate: e.g. 10–25% of spans
 *      • Filter (recommended): span name contains "anthropic" OR "gemini" OR
 *        "openrouter" — i.e. the LLM intelligence calls — so transcription /
 *        embedding / vector spans are skipped.
 *
 * Each scorer is defensive: if it can't find an answer or grounding context in
 * the span it returns null (skipped), so it never errors on a non-chat span.
 */
import { projects } from 'braintrust';

const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-sonnet-4-6';
const MAX = 12_000; // cap judged text so a huge transcript can't blow the judge call

/** Best-effort: pull the assistant's answer text out of any provider span output. */
function extractAnswer(output: unknown): string {
  if (output == null) return '';
  let v: any = output;
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s.startsWith('{') && !s.startsWith('[')) return s; // already plain text
    try { v = JSON.parse(s); } catch { return s; }
  }
  // Anthropic: { content: [{ type: 'text', text }] }
  if (Array.isArray(v?.content)) {
    const t = v.content.filter((b: any) => b?.type === 'text').map((b: any) => b.text).join('').trim();
    if (t) return t;
  }
  // Gemini: { candidates: [{ content: { parts: [{ text }] } }] }
  const gem = v?.candidates?.[0]?.content?.parts?.map((p: any) => p?.text ?? '').join('').trim();
  if (gem) return gem;
  // OpenRouter / OpenAI: { choices: [{ message: { content } }] }
  const oai = v?.choices?.[0]?.message?.content;
  if (typeof oai === 'string' && oai.trim()) return oai.trim();
  // {text: "..."}
  if (typeof v?.text === 'string') return v.text.trim();
  return typeof output === 'string' ? output : '';
}

/** Best-effort: serialize the request (the grounding prompt) to text. */
function extractPrompt(input: unknown): string {
  if (input == null) return '';
  const v: any = input;
  const parts: string[] = [];
  if (typeof v?.system === 'string') parts.push(v.system);
  // Anthropic / OpenAI messages
  if (Array.isArray(v?.messages)) {
    for (const m of v.messages) {
      const c = m?.content;
      parts.push(typeof c === 'string' ? c : JSON.stringify(c));
    }
  }
  // Gemini contents
  if (Array.isArray(v?.contents)) {
    for (const c of v.contents) {
      const t = (c?.parts ?? []).map((p: any) => p?.text ?? '').join(' ');
      if (t) parts.push(t);
    }
  }
  if (typeof v?.systemInstruction?.parts?.[0]?.text === 'string') parts.push(v.systemInstruction.parts[0].text);
  const joined = parts.filter(Boolean).join('\n').trim();
  return joined || (typeof input === 'string' ? input : JSON.stringify(input));
}

/** Independent Claude judge → 0..1 (null on misconfig so online scoring is safe). */
async function judge(system: string, user: string): Promise<number | null> {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return null; // configure ANTHROPIC_API_KEY in the Braintrust project env
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 16, system, messages: [{ role: 'user', content: user }] }),
  });
  if (!r.ok) return null;
  const d: any = await r.json();
  const text = (d.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  const n = parseFloat(text.match(/[0-9]*\.?[0-9]+/)?.[0] ?? '');
  return isNaN(n) ? null : Math.max(0, Math.min(1, n));
}

const project = projects.create({ name: process.env.BRAINTRUST_PROJECT || 'wisprnote-ai' });

// Is every claim in the answer supported by the prompt/context? (hallucination guard)
project.scorers.create({
  name: 'Faithfulness',
  slug: 'faithfulness',
  description: 'Is the model answer fully grounded in the request context (no fabrication)?',
  handler: async ({ input, output }: { input?: unknown; output?: unknown }) => {
    const answer = extractAnswer(output).slice(0, MAX);
    const context = extractPrompt(input).slice(0, MAX);
    if (!answer || !context) return null; // not an answer-style span → skip
    return judge(
      'You grade whether an answer is fully supported by the given source material. Output ONLY a number 0..1 (1 = every claim supported, 0 = contradicts or fabricates).',
      `Source material:\n${context}\n\nAnswer:\n${answer}\n\nScore:`,
    );
  },
});

// Does the answer actually address the request? (relevancy / usefulness)
project.scorers.create({
  name: 'Answer relevancy',
  slug: 'answer-relevancy',
  description: 'Does the answer address what the request asked, using the context?',
  handler: async ({ input, output }: { input?: unknown; output?: unknown }) => {
    const answer = extractAnswer(output).slice(0, MAX);
    const context = extractPrompt(input).slice(0, MAX);
    if (!answer || !context) return null;
    return judge(
      'You grade whether an answer actually addresses the request (correctly saying information is absent counts as relevant when it truly is). Output ONLY a number 0..1.',
      `Request/context:\n${context}\n\nAnswer:\n${answer}\n\nScore:`,
    );
  },
});
