/**
 * Braintrust eval — meeting SUMMARY quality.
 *
 * Mirrors the product's `generateSummary` (Gemini): a concise summary grounded
 * in the transcript. Claude-judge scorers grade:
 *   • faithfulness — is the summary supported by the transcript (no hallucination)?
 *   • conciseness  — is it tight and free of filler/repetition?
 *
 * Run it (from aws/api):
 *   GEMINI_API_KEY=...  ANTHROPIC_API_KEY=sk-ant-...  \
 *     npx braintrust eval evals/summary.eval.ts
 */
import { Eval } from 'braintrust';
import { gemini, judge, SAMPLE_MEETINGS } from './_llm';

const SUMMARY_SYSTEM =
  'You are WisprNote AI. Write a concise summary (3-5 sentences) of the meeting transcript, ' +
  'covering the main outcomes and decisions. Use ONLY information present in the transcript; do not invent anything.';

const data = SAMPLE_MEETINGS.map((m) => ({
  input: { transcript: m.transcript },
  metadata: { meeting: m.title },
}));

Eval('wisprnote-ai', {
  experimentName: 'summary-generation',
  data,
  task: async (input: { transcript: string }) =>
    gemini(SUMMARY_SYSTEM, `<transcript>\n${input.transcript}\n</transcript>\n\nWrite the summary.`, 500),
  scores: [
    async ({ input, output }: any) => ({
      name: 'faithfulness',
      score: await judge(
        'You grade whether a meeting summary is fully supported by the transcript. Output ONLY a number 0..1 (1 = every claim supported, 0 = fabricates or contradicts).',
        `Transcript:\n${input.transcript}\n\nSummary:\n${output}\n\nScore:`,
      ),
    }),
    async ({ output }: any) => ({
      name: 'conciseness',
      score: await judge(
        'You grade whether a summary is concise and free of filler or repetition (still covering the outcomes). Output ONLY a number 0..1 (1 = tight and clear, 0 = bloated/repetitive).',
        `Summary:\n${output}\n\nScore:`,
      ),
    }),
  ],
});
