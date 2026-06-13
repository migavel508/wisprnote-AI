/**
 * Braintrust eval — meeting NOTES generation faithfulness.
 *
 * Mirrors the product's `generateNotes` (Gemini): turn a transcript into
 * structured markdown notes that capture ONLY what was actually said — no
 * invented facts. Two Claude-judge scorers grade each result:
 *   • faithfulness — is every note supported by the transcript (no hallucination)?
 *   • completeness — are the key decisions / action items captured?
 *
 * Run it (from aws/api):
 *   GEMINI_API_KEY=...  ANTHROPIC_API_KEY=sk-ant-...  \
 *     npx braintrust eval evals/notes.eval.ts
 *
 * Results land in the "wisprnote-ai" Braintrust project → Experiments.
 */
import { Eval } from 'braintrust';
import { gemini, judge, SAMPLE_MEETINGS } from './_llm';

const NOTES_SYSTEM =
  'You are WisprNote AI. Turn the meeting transcript into clean, structured markdown notes ' +
  '(headings + bullets) capturing decisions, action items (with owners), and key points. ' +
  'Use ONLY information explicitly present in the transcript. Never invent facts, names, dates, or numbers.';

const data = SAMPLE_MEETINGS.map((m) => ({
  input: { transcript: m.transcript },
  metadata: { meeting: m.title },
}));

Eval('wisprnote-ai', {
  experimentName: 'notes-generation',
  data,
  task: async (input: { transcript: string }) =>
    gemini(NOTES_SYSTEM, `<transcript>\n${input.transcript}\n</transcript>\n\nWrite the meeting notes.`),
  scores: [
    async ({ input, output }: any) => ({
      name: 'faithfulness',
      score: await judge(
        'You grade whether meeting notes are fully supported by the transcript. Output ONLY a number 0..1 (1 = every statement is supported, 0 = contains fabricated facts).',
        `Transcript:\n${input.transcript}\n\nNotes:\n${output}\n\nScore:`,
      ),
    }),
    async ({ input, output }: any) => ({
      name: 'completeness',
      score: await judge(
        'You grade whether meeting notes capture the key decisions and action items (with owners) present in the transcript. Output ONLY a number 0..1.',
        `Transcript:\n${input.transcript}\n\nNotes:\n${output}\n\nScore:`,
      ),
    }),
  ],
});
