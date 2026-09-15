// ─── Transcript parsing ────────────────────────────────────────────────────────
//
// Turns a stored transcript STRING back into structured turns so the UI can lay
// speakers and their words out in two columns instead of rendering one run-on
// paragraph.
//
// Why parsing is needed at all: transcripts are persisted as plain text (the
// format the summariser, search index and share view all consume), so the turn
// structure has to be recovered at render time. The live path joins turns with a
// space rather than a newline, so a line-anchored regex sees a single line and
// matches almost nothing — which is exactly how the panel ended up as one blob.
//
// The risk when splitting on "Label:" anywhere in free text is false positives —
// "Note:", "10:30", or a colon inside ordinary prose. The rule below is therefore
// deliberately conservative:
//
//   * Labels we ISSUE ourselves ("You", "Speaker 3") are matched anywhere, since
//     they are unambiguous and are what the live path actually emits mid-line.
//   * Any OTHER label (a renamed speaker, or a model-written "Alice:") is matched
//     only at the start of a line, where a colon is structural rather than prose.
//
// Anything unrecognised stays inside the preceding turn rather than being dropped.

export interface TranscriptTurn {
  /** Display label exactly as it appeared, e.g. "You" or "Speaker 2". */
  speaker: string;
  text: string;
}

/** Labels the app emits itself; safe to split on mid-line. */
const KNOWN_LABEL = /(?:^|[\s([])((?:You|Speaker\s+\d+))\s*:\s*/gu;

/**
 * A name-shaped label, only trusted at the start of a line.
 *
 * Sentence punctuation is excluded from the label so a line that merely CONTAINS
 * a colon ("Some preamble text. You: …") cannot have its opening sentence
 * swallowed as the speaker's name.
 */
const LINE_START_LABEL = /^[ \t]*([^\s:.!?…][^:\n.!?…]{0,40}?)\s*:[ \t]*/gmu;

interface Boundary {
  start: number;  // index of the label
  end: number;    // index where the spoken text begins
  speaker: string;
}

function collectBoundaries(text: string): Boundary[] {
  const found: Boundary[] = [];

  for (const re of [KNOWN_LABEL, LINE_START_LABEL]) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const speaker = (m[1] || '').trim();
      if (!speaker) continue;
      // Guard against a runaway match on something like a URL or timestamp.
      if (/^\d+$/.test(speaker)) continue;
      // The label starts after any leading whitespace the pattern consumed.
      const lead = m[0].length - m[0].trimStart().length;
      found.push({ start: m.index + lead, end: m.index + m[0].length, speaker });
    }
  }

  // Earliest first; when two patterns match the same spot, keep one.
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const deduped: Boundary[] = [];
  for (const b of found) {
    const prev = deduped[deduped.length - 1];
    if (prev && b.start < prev.end) continue; // overlaps the previous label
    deduped.push(b);
  }
  return deduped;
}

/**
 * Parse a transcript into speaker turns. Consecutive turns from the same speaker
 * are merged, which is what stops a rapid back-and-forth from rendering as a
 * column of one-word rows.
 *
 * Text before the first label is kept as an unattributed turn rather than
 * discarded — losing words to a formatting rule would be far worse than showing
 * them without a name.
 */
export function parseTranscript(raw: string): TranscriptTurn[] {
  const text = (raw || '').replace(/\r\n?/g, '\n').trim();
  if (!text) return [];

  const bounds = collectBoundaries(text);
  if (bounds.length === 0) {
    return [{ speaker: '', text }];
  }

  const turns: TranscriptTurn[] = [];
  const preamble = text.slice(0, bounds[0].start).trim();
  if (preamble) turns.push({ speaker: '', text: preamble });

  bounds.forEach((b, i) => {
    const stop = i + 1 < bounds.length ? bounds[i + 1].start : text.length;
    const body = text.slice(b.end, stop).trim();
    if (!body) return;
    const prev = turns[turns.length - 1];
    if (prev && prev.speaker === b.speaker) {
      prev.text = `${prev.text} ${body}`.trim();
    } else {
      turns.push({ speaker: b.speaker, text: body });
    }
  });

  return turns;
}

/** Initials for a speaker chip. "Speaker 2" → "2"; "Ada Lovelace" → "AL". */
export function speakerInitials(speaker: string): string {
  const s = speaker.trim();
  if (!s) return '·';
  const numbered = s.match(/^Speaker\s+(\d+)$/i);
  if (numbered) return numbered[1];
  if (/^you$/i.test(s)) return 'You';
  const words = s.split(/\s+/).filter(Boolean).slice(0, 2);
  return words.map((w) => w[0]?.toUpperCase() ?? '').join('') || '·';
}

/**
 * A stable colour index for a speaker, so the same person keeps the same accent
 * for the whole transcript (and across re-renders).
 */
export function speakerColorIndex(speaker: string, paletteSize: number): number {
  const s = speaker.trim().toLowerCase();
  if (!s || s === 'you') return 0;
  const numbered = s.match(/^speaker\s+(\d+)$/);
  if (numbered) return (Number(numbered[1]) % (paletteSize - 1)) + 1;
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return (h % (paletteSize - 1)) + 1;
}
