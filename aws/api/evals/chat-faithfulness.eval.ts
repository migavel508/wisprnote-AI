/**
 * Braintrust eval — chat answer FAITHFULNESS / GROUNDING.
 *
 * Catches the failure mode that matters most for a meeting assistant: answers
 * that aren't supported by the retrieved meeting evidence (hallucination).
 *
 * The task answers each question strictly from the provided context (the same
 * instruction the product uses), then two LLM-judge scorers grade the result:
 *   • faithfulness — is every claim supported by the context?
 *   • coverage     — does it actually answer the question from the context?
 *
 * Run it:
 *   cd aws/api
 *   BRAINTRUST_API_KEY=sk-...  ANTHROPIC_API_KEY=sk-ant-...  \
 *     npx braintrust eval evals/chat-faithfulness.eval.ts
 *
 * Results land in the "wisprnote-ai" project → Experiments. Wire it into CI to
 * block regressions, and/or enable Braintrust ONLINE scoring on the project so
 * these scorers run automatically on real production chat spans (Braintrust →
 * project → Configuration → Online scoring).
 */
import { Eval } from 'braintrust';

const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY;
const JUDGE_MODEL = 'claude-sonnet-4-6';
const ANSWER_MODEL = 'claude-sonnet-4-6';

async function claude(system: string, user: string, maxTokens = 700): Promise<string> {
  if (!ANTHROPIC_KEY) throw new Error('Set ANTHROPIC_API_KEY to run this eval');
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: ANSWER_MODEL, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] }),
  });
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return (d.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
}

async function judge(model: string, system: string, user: string): Promise<number> {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': ANTHROPIC_KEY!, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 16, system, messages: [{ role: 'user', content: user }] }),
  });
  const d: any = await r.json();
  const text = (d.content ?? []).filter((b: any) => b.type === 'text').map((b: any) => b.text).join('').trim();
  const n = parseFloat(text.match(/[0-9]*\.?[0-9]+/)?.[0] ?? '0');
  return isNaN(n) ? 0 : Math.max(0, Math.min(1, n));
}

// A small golden set of meeting-style Q&A grounded in short evidence blocks.
// Extend this with real (sanitised) examples from your transcripts over time.
const data = [
  {
    input: {
      question: 'What did we decide about the launch date?',
      context: 'Standup (Jun 9): Priya proposed shipping on June 20. The team agreed to lock June 20 as the launch date, pending QA sign-off.',
    },
    expected: 'The team locked June 20 as the launch date, pending QA sign-off.',
  },
  {
    input: {
      question: 'Who owns the billing migration?',
      context: 'Planning (Jun 7): Action items — Sam to lead the billing migration; Lee to write the rollback plan.',
    },
    expected: 'Sam owns the billing migration.',
  },
  {
    input: {
      question: 'What is the Q3 revenue target?',
      context: 'Sync (Jun 8): We discussed hiring and the new office. No revenue figures were mentioned.',
    },
    expected: "Not stated in the meeting — there's no revenue figure in the context.",
  },
];

Eval('wisprnote-ai', {
  experimentName: 'chat-faithfulness',
  data,
  task: async (input: { question: string; context: string }) => {
    return claude(
      'You are WisprNote AI. Answer ONLY from the provided meeting context. If the answer is not present, say so explicitly. Do not invent facts.',
      `<context>\n${input.context}\n</context>\n\nQuestion: ${input.question}`,
    );
  },
  scores: [
    async ({ input, output }: any) => ({
      name: 'faithfulness',
      score: await judge(
        JUDGE_MODEL,
        'You grade whether an answer is fully supported by the given context. Output ONLY a number from 0 to 1 (1 = every claim supported, 0 = contradicts or fabricates).',
        `Context:\n${input.context}\n\nAnswer:\n${output}\n\nScore:`,
      ),
    }),
    async ({ input, output }: any) => ({
      name: 'coverage',
      score: await judge(
        JUDGE_MODEL,
        'You grade whether an answer actually addresses the question using the context (correctly saying "not stated" counts as full coverage when the context lacks the answer). Output ONLY a number from 0 to 1.',
        `Context:\n${input.context}\n\nQuestion:\n${input.question}\n\nAnswer:\n${output}\n\nScore:`,
      ),
    }),
  ],
});
