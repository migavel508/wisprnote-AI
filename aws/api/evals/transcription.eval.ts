/**
 * Braintrust eval — TRANSCRIPTION accuracy (Deepgram nova-3).
 *
 * Measures real speech-to-text quality with Word Error Rate (WER) against
 * ground-truth transcripts. It transcribes each audio fixture through Deepgram
 * (the same model the app uses) and scores the result.
 *
 * ── Add fixtures ────────────────────────────────────────────────────────────
 * Drop matched pairs into evals/fixtures/transcription/:
 *     meeting1.wav   (audio: wav/mp3/m4a/flac/ogg)
 *     meeting1.txt   (the exact ground-truth transcript)
 * Keep clips short (10–60s) and sanitised. The eval auto-discovers every pair.
 *
 * Run it (from aws/api):
 *   DEEPGRAM_API_KEY=...  BRAINTRUST_API_KEY=sk-...  \
 *     npx braintrust eval evals/transcription.eval.ts
 *
 * Scores: `word_accuracy` = 1 − WER (1.0 = perfect). With no fixtures present it
 * prints guidance and registers nothing (so it never errors in CI).
 */
import { Eval } from 'braintrust';
import * as fs from 'node:fs';
import * as path from 'node:path';

const DEEPGRAM_KEY = process.env.DEEPGRAM_API_KEY;
const MODEL = process.env.DEEPGRAM_MODEL || 'nova-3';
const FIXTURES = path.join(process.cwd(), 'evals', 'fixtures', 'transcription');
const AUDIO_RE = /\.(wav|mp3|m4a|flac|ogg)$/i;

const CONTENT_TYPE: Record<string, string> = {
  wav: 'audio/wav', mp3: 'audio/mpeg', m4a: 'audio/mp4', flac: 'audio/flac', ogg: 'audio/ogg',
};

interface Fixture { input: { file: string }; expected: string; metadata: { fixture: string }; }

function loadFixtures(): Fixture[] {
  if (!fs.existsSync(FIXTURES)) return [];
  return fs.readdirSync(FIXTURES)
    .filter((f) => AUDIO_RE.test(f))
    .map((audio): Fixture | null => {
      const base = audio.replace(AUDIO_RE, '');
      const txt = path.join(FIXTURES, `${base}.txt`);
      if (!fs.existsSync(txt)) return null;
      return {
        input: { file: path.join(FIXTURES, audio) },
        expected: fs.readFileSync(txt, 'utf8').trim(),
        metadata: { fixture: base },
      };
    })
    .filter((x): x is Fixture => x !== null);
}

/** Normalise text for WER: lowercase, strip punctuation, collapse whitespace. */
function tokens(s: string): string[] {
  return s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, ' ').replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
}

/** Word Error Rate via word-level Levenshtein distance (0 = perfect). */
function wer(refStr: string, hypStr: string): number {
  const ref = tokens(refStr), hyp = tokens(hypStr);
  const n = ref.length, m = hyp.length;
  if (n === 0) return m === 0 ? 0 : 1;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = 0; i <= n; i++) dp[i][0] = i;
  for (let j = 0; j <= m; j++) dp[0][j] = j;
  for (let i = 1; i <= n; i++) {
    for (let j = 1; j <= m; j++) {
      const cost = ref[i - 1] === hyp[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }
  return dp[n][m] / n;
}

async function transcribe(file: string): Promise<string> {
  if (!DEEPGRAM_KEY) throw new Error('Set DEEPGRAM_API_KEY to run this eval');
  const ext = (file.split('.').pop() || 'wav').toLowerCase();
  const params = new URLSearchParams({ model: MODEL, smart_format: 'true', punctuate: 'true' });
  const r = await fetch(`https://api.deepgram.com/v1/listen?${params.toString()}`, {
    method: 'POST',
    headers: { Authorization: `Token ${DEEPGRAM_KEY}`, 'Content-Type': CONTENT_TYPE[ext] || 'audio/wav' },
    body: fs.readFileSync(file),
  });
  const d: any = await r.json();
  if (!r.ok) throw new Error(`Deepgram ${r.status}: ${JSON.stringify(d).slice(0, 200)}`);
  return d?.results?.channels?.[0]?.alternatives?.[0]?.transcript ?? '';
}

const data = loadFixtures();

if (data.length === 0) {
  // eslint-disable-next-line no-console
  console.warn(
    `[transcription.eval] No fixtures found in ${FIXTURES}.\n` +
    `Add <name>.wav + <name>.txt pairs (short, sanitised clips) and re-run.`,
  );
} else {
  Eval('wisprnote-ai', {
    experimentName: 'transcription-accuracy',
    data,
    task: async (input: { file: string }) => transcribe(input.file),
    scores: [
      ({ output, expected }: any) => ({
        name: 'word_accuracy',
        score: Math.max(0, 1 - wer(String(expected ?? ''), String(output ?? ''))),
      }),
    ],
  });
}
