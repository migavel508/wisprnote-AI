/**
 * Braintrust eval — KNOWLEDGE GRAPH extraction.
 *
 * Mirrors the product's `extractKnowledgeGraph` (Gemini): pull structured
 * entities (people, decisions, action items, topics) from a transcript as JSON.
 * Scorers:
 *   • json_valid    — programmatic: parses to the expected shape (arrays present).
 *   • entity_recall — Claude judge: are the real people/decisions/action items
 *                     from the transcript captured (no misses, no fabrication)?
 *
 * Run it (from aws/api):
 *   GEMINI_API_KEY=...  ANTHROPIC_API_KEY=sk-ant-...  \
 *     npx braintrust eval evals/knowledge-graph.eval.ts
 */
import { Eval } from 'braintrust';
import { gemini, judge, SAMPLE_MEETINGS } from './_llm';

const KG_SYSTEM =
  'You are WisprNote AI knowledge-graph extractor. From the transcript, output ONLY a JSON object ' +
  '(no prose, no code fences) with this shape: ' +
  '{"people": string[], "decisions": string[], "action_items": {"owner": string, "task": string}[], "topics": string[]}. ' +
  'Include ONLY entities explicitly present in the transcript. Do not invent anything.';

/** Strip ```json fences and parse; returns null if not valid JSON. */
function parseKG(raw: string): any | null {
  try {
    const cleaned = raw.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim();
    return JSON.parse(cleaned);
  } catch {
    return null;
  }
}

const data = SAMPLE_MEETINGS.map((m) => ({
  input: { transcript: m.transcript },
  metadata: { meeting: m.title },
}));

Eval('wisprnote-ai', {
  experimentName: 'knowledge-graph-extraction',
  data,
  task: async (input: { transcript: string }) =>
    gemini(KG_SYSTEM, `<transcript>\n${input.transcript}\n</transcript>\n\nExtract the knowledge graph as JSON.`, 900, 0),
  scores: [
    async ({ output }: any) => {
      const kg = parseKG(output);
      const ok =
        !!kg &&
        Array.isArray(kg.people) &&
        Array.isArray(kg.decisions) &&
        Array.isArray(kg.action_items) &&
        Array.isArray(kg.topics);
      return { name: 'json_valid', score: ok ? 1 : 0 };
    },
    async ({ input, output }: any) => ({
      name: 'entity_recall',
      score: await judge(
        'You grade whether an extracted knowledge graph captures the real people, decisions, and action items from the transcript, without inventing any. Output ONLY a number 0..1 (1 = all real entities captured and nothing fabricated, 0 = major misses or fabrication).',
        `Transcript:\n${input.transcript}\n\nExtracted JSON:\n${output}\n\nScore:`,
      ),
    }),
  ],
});
