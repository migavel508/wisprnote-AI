/**
 * Shared eval helpers.
 *
 * The product GENERATES intelligence (notes / summary / knowledge graph) with
 * Gemini — so each eval's `task` calls Gemini (the production model) to reflect
 * real behavior — and GRADES with an independent Claude judge for neutral,
 * high-quality scoring.
 *
 * Run an eval (from aws/api):
 *   GEMINI_API_KEY=...  ANTHROPIC_API_KEY=sk-ant-...  \
 *     npx braintrust eval evals/notes.eval.ts
 *
 * Override the generation model with GEMINI_MODEL (defaults to a stable model so
 * the eval runs out of the box; set it to the exact production preview model to
 * grade production behavior).
 */

const GEMINI_KEY = process.env.GEMINI_API_KEY;
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;

/** Generation model — mirrors the app's Gemini intelligence calls. */
export const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
/** Independent judge — a strong, neutral grader (not the model under test). */
export const JUDGE_MODEL = process.env.JUDGE_MODEL || 'claude-sonnet-4-6';

/** Call Gemini (the production generator) via the REST API. */
export async function gemini(system: string, user: string, maxOutputTokens = 1400, temperature = 0.2): Promise<string> {
  if (!GEMINI_KEY) throw new Error('Set GEMINI_API_KEY to run this eval');
  const r = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_KEY}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: system }] },
        contents: [{ role: 'user', parts: [{ text: user }] }],
        generationConfig: { maxOutputTokens, temperature },
      }),
    },
  );
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Gemini ${r.status}: ${JSON.stringify(d).slice(0, 300)}`);
  return (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
}

/** Independent Claude judge → returns a 0..1 score. */
export async function judge(system: string, user: string): Promise<number> {
  if (!ANTHROPIC_KEY) throw new Error('Set ANTHROPIC_API_KEY to run this eval (used for the independent judge)');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: JUDGE_MODEL, max_tokens: 16, system, messages: [{ role: 'user', content: user }] }),
  });
  const d: any = await r.json();
  const text = (d.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  const n = parseFloat(text.match(/[0-9]*\.?[0-9]+/)?.[0] ?? '0');
  return isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
}

/** A couple of small, sanitised meeting transcripts shared across evals. */
export const SAMPLE_MEETINGS = [
  {
    title: 'Product sync',
    transcript:
      "Priya: Let's lock the launch. I propose June 20.\n" +
      'Sam: Works for me, assuming QA signs off by the 18th.\n' +
      'Priya: Agreed — June 20, pending QA sign-off. Sam, you own the billing migration.\n' +
      'Lee: I will write the rollback plan by Friday.\n' +
      'Priya: Great. We are NOT changing the pricing tiers this release.',
  },
  {
    title: 'Design review',
    transcript:
      'Maya: The new onboarding has three steps now instead of five.\n' +
      'Tom: Drop-off in testing fell from 40% to 22%.\n' +
      'Maya: Action item — Tom to ship the analytics dashboard next sprint.\n' +
      'Maya: We decided to keep the dark-mode toggle in settings, not the top bar.',
  },
];
