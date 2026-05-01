/**
 * RAG (Retrieval-Augmented Generation) Service
 * Robust pipeline: speaker-aware chunking, BM25 scoring,
 * phrase matching, query expansion, and overlapping windows.
 */

export interface TextChunk {
  id: string;
  text: string;
  chunkIndex: number;
  speakers: string[];
  terms: string[];       // pre-computed term tokens for BM25
}

export interface RetrievalResult {
  chunk: TextChunk;
  score: number;
  matchedPhrases: string[];
}

// ─── Stop words ────────────────────────────────────────────────────────────────
const STOP_WORDS = new Set([
  'the','a','an','and','or','but','in','on','at','to','for','of','with','by',
  'from','as','is','was','are','were','been','be','have','has','had','do',
  'does','did','will','would','could','should','may','might','can','this',
  'that','these','those','i','you','he','she','it','we','they','what','which',
  'who','when','where','why','how','um','uh','like','just','so','well','yeah',
  'okay','right','know','think','going','want','need','get','got','said','say',
  'also','then','very','really','about','there','their','our','your','its',
  'they','them','than','more','some','all','been','had','her','his','not',
]);

// ─── Tokenizer ─────────────────────────────────────────────────────────────────
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 2 && !STOP_WORDS.has(t));
}

// ─── Extract bigrams (2-word phrases) from token list ──────────────────────────
function bigrams(tokens: string[]): string[] {
  const bg: string[] = [];
  for (let i = 0; i < tokens.length - 1; i++) {
    bg.push(`${tokens[i]} ${tokens[i + 1]}`);
  }
  return bg;
}

// ─── Query expansion: add root forms and common synonyms ───────────────────────
function expandQuery(queryTokens: string[]): string[] {
  const expanded = new Set(queryTokens);
  for (const t of queryTokens) {
    // Simple stemming: strip -ing, -ed, -s, -er, -ly endings
    if (t.endsWith('ing') && t.length > 5)  expanded.add(t.slice(0, -3));
    if (t.endsWith('tion'))                  expanded.add(t.slice(0, -4));
    if (t.endsWith('ing'))                   expanded.add(t.slice(0, -3) + 'e');
    if (t.endsWith('ed') && t.length > 4)    expanded.add(t.slice(0, -2));
    if (t.endsWith('s') && t.length > 3)     expanded.add(t.slice(0, -1));
    if (t.endsWith('er') && t.length > 4)    expanded.add(t.slice(0, -2));
    // Common synonym pairs relevant to meeting discussions
    const synonyms: Record<string, string[]> = {
      budget:    ['cost','costs','expense','expenses','spending','funding','money'],
      deadline:  ['due','timeline','date','schedule','when','delivery'],
      issue:     ['problem','bug','blocker','challenge','concern','risk'],
      decision:  ['decided','agreed','approved','resolved','chosen'],
      action:    ['task','todo','follow','next','step','assign'],
      design:    ['ui','ux','layout','mockup','prototype','wireframe'],
      team:      ['members','people','group','everyone','all'],
      meeting:   ['call','sync','session','discussion'],
      update:    ['status','progress','report','latest'],
      launch:    ['release','deploy','ship','go-live','production'],
    };
    for (const [key, vals] of Object.entries(synonyms)) {
      if (t === key || vals.includes(t)) {
        expanded.add(key);
        vals.forEach(v => expanded.add(v));
      }
    }
  }
  return Array.from(expanded);
}

// ─── Chunking: speaker-turn-aware with overlapping sliding window ───────────────
export function chunkTranscription(transcription: string): TextChunk[] {
  // Split at blank lines OR speaker-label boundaries
  const SPEAKER_RE = /^([A-Z][a-zA-Z\s]*\d*|Speaker\s*\d+)\s*:/m;

  // First split into speaker turns
  const rawSegments = transcription
    .split(/\n{2,}/)
    .map(s => s.trim())
    .filter(Boolean);

  const MAX_CHUNK = 1200;
  const sentences: string[] = [];

  for (const seg of rawSegments) {
    if (seg.length <= MAX_CHUNK) {
      sentences.push(seg);
    } else {
      // Split on sentence-ending punctuation, keeping the delimiter
      const parts = seg.match(/[^.!?]+[.!?]+|[^.!?]+$/g) || [seg];
      let buf = '';
      for (const part of parts) {
        if ((buf + part).length > MAX_CHUNK && buf.length > 0) {
          sentences.push(buf.trim());
          buf = part;
        } else {
          buf += part;
        }
      }
      if (buf.trim()) sentences.push(buf.trim());
    }
  }

  const WINDOW_SIZE = 5;
  const STEP = 2;
  const chunks: TextChunk[] = [];
  for (let i = 0; i < sentences.length; i += STEP) {
    const window: string[] = [];
    for (let j = i; j < Math.min(i + WINDOW_SIZE, sentences.length); j++) {
      window.push(sentences[j]);
    }
    const text = window.join('\n');

    // Extract speaker labels present in this chunk
    const speakerMatches = text.match(/^([A-Z][a-zA-Z\s]*\d*|Speaker\s*\d+)\s*:/gm) || [];
    const speakers = speakerMatches.map(s => s.replace(':', '').trim());

    chunks.push({
      id: `c${i}`,
      text,
      chunkIndex: i,
      speakers,
      terms: tokenize(text),
    });
  }

  return chunks;
}

// ─── BM25 retrieval ────────────────────────────────────────────────────────────
const BM25_K1 = 1.5;
const BM25_B  = 0.75;

export async function retrieveRelevantChunks(
  query: string,
  chunks: TextChunk[],
  topK: number = 6
): Promise<RetrievalResult[]> {
  const rawTokens   = tokenize(query);
  const queryTokens = expandQuery(rawTokens);
  const queryBigrams = bigrams(rawTokens);

  if (chunks.length === 0) return [];

  // Compute IDF for each query term over corpus
  const docCount = chunks.length;
  const avgLen = chunks.reduce((s, c) => s + c.terms.length, 0) / docCount;

  const idf = (term: string): number => {
    const df = chunks.filter(c => c.terms.includes(term)).length;
    if (df === 0) return 0;
    return Math.log((docCount - df + 0.5) / (df + 0.5) + 1);
  };

  const scored: RetrievalResult[] = chunks.map(chunk => {
    const dl   = chunk.terms.length;
    const norm = 1 - BM25_B + BM25_B * (dl / avgLen);

    let score = 0;

    // BM25 for single terms
    for (const term of queryTokens) {
      const tf = chunk.terms.filter(t => t === term).length;
      if (tf === 0) continue;
      const tfNorm = (tf * (BM25_K1 + 1)) / (tf + BM25_K1 * norm);
      score += idf(term) * tfNorm;
    }

    // Phrase boost: exact bigram matches from original (non-expanded) query
    const matched: string[] = [];
    const chunkLower = chunk.text.toLowerCase();
    for (const phrase of queryBigrams) {
      if (chunkLower.includes(phrase)) {
        score += 3.0;   // strong phrase match bonus
        matched.push(phrase);
      }
    }

    // Speaker-name boost: if query names a speaker present in the chunk
    for (const tok of rawTokens) {
      if (chunk.speakers.some(s => s.toLowerCase().includes(tok))) {
        score += 2.5;
      }
    }

    // Exact single-word match in original query (non-expanded) boosts
    for (const tok of rawTokens) {
      if (chunk.text.toLowerCase().includes(tok)) {
        score += 0.5;
      }
    }

    return { chunk, score, matchedPhrases: matched };
  });

  // Sort and return top-K non-zero results
  const results = scored
    .filter(r => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, topK);

  // Sort retrieved chunks by original position for readability
  results.sort((a, b) => a.chunk.chunkIndex - b.chunk.chunkIndex);

  return results;
}

// ─── Build context string to inject into LLM ──────────────────────────────────
export function prepareContext(results: RetrievalResult[]): string {
  if (results.length === 0) return '';

  return results.map((r, i) => {
    const speakerTag = r.chunk.speakers.length > 0
      ? ` [${r.chunk.speakers.join(', ')}]`
      : '';
    return `[EXCERPT ${i + 1}${speakerTag}]\n${r.chunk.text}`;
  }).join('\n\n');
}

// ─── Detect query intent ────────────────────────────────────────────────────────
export type QueryIntent = 'overview' | 'specific';

export function detectQueryIntent(query: string): QueryIntent {
  const q = query.toLowerCase();
  const overviewPatterns = [
    'summarize','summary','overview','everything','all about','full picture',
    'tell me about','explain','what happened','what was discussed','what did they',
    'what were','what are the','give me','detail','in detail','comprehensive',
    'breakdown','recap','highlights','key points','main points','discuss',
    'covered','topics','agenda','notes','entire','whole','complete',
  ];
  return overviewPatterns.some(p => q.includes(p)) ? 'overview' : 'specific';
}

