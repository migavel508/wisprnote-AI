// ─── Speaker-labeling policy (single source of truth) ──────────────────────────
//
// Why this module exists
// ----------------------
// Speaker identity must come from a RELIABLE signal, never from inferring "who is
// the app user" out of the words "I"/"me". Realtime mode gets identity for free
// from the physical audio channel (mic = "You", system = "Speaker N") in the Rust
// layer. Batch / upload transcription has no channel separation — the audio is a
// single mono mix (or an arbitrary uploaded file) — so the ONLY honest labeling is
// neutral "Speaker 1..N", attaching a real name only when that name is actually
// spoken in the audio.
//
// A previous version injected the account holder's name onto any first-person
// speaker ("if they say 'I'/'me', label them <userName>"). Because every speaker
// says "I" and "me", that stamped the user's name onto arbitrary/other speakers —
// and onto uploads the user wasn't even in. That rule is gone, and it lives here
// now so it can't silently come back (see speakerLabeling.test.ts).

/**
 * Where the audio came from. Determines which labeling policy applies.
 *  - `realtime`     — native mic+system capture, labeled by channel in Rust (NOT this module).
 *  - `upload`       — a file the user uploaded; they may not even be present.
 *  - `native-batch` — recorded mic+system, mixed to mono before transcription.
 *  - `mic-only`     — browser MediaRecorder, microphone only.
 * All non-realtime sources use neutral `Speaker N` labeling (no channel info survives).
 */
export type AudioSourceKind = 'realtime' | 'upload' | 'native-batch' | 'mic-only';

/**
 * The speaker-identification block injected into batch/upload transcription
 * prompts. Centralised so the policy is defined in exactly one place.
 *
 * Invariant (enforced by tests): this NEVER tells the model to use an account /
 * app-user name, and NEVER maps first-person speech ("I"/"me") to a name.
 */
export function buildSpeakerInstructions(_source: AudioSourceKind): string {
  // The policy is identical for every batch/upload source today: none of them
  // carry channel information once the audio reaches the model, so all of them
  // get neutral numbering. The parameter is kept so call sites stay explicit and
  // a future source-specific tweak has a home — without reopening the old bug.
  return [
    'SPEAKER IDENTIFICATION:',
    '- Identify the distinct speakers by their voice and label each turn.',
    '- Use neutral labels: "Speaker 1", "Speaker 2", "Speaker 3", … numbered in the order each voice first speaks.',
    '- Keep the SAME number for the SAME voice throughout the entire transcript (do not renumber the same person).',
    '- Put each speaker label at the start of their line, followed by a colon, e.g. "Speaker 1: ...".',
    '- Only use a real person\'s NAME instead of "Speaker N" if that exact name is clearly spoken in the audio to identify that speaker (e.g. they introduce themselves, or are addressed by name). When in doubt, keep "Speaker N".',
    '- NEVER guess, invent, or assume anyone\'s name. Do NOT assign a name based on someone saying "I" or "me". If you are not certain who a voice belongs to, it is "Speaker N".',
  ].join('\n');
}

// ─── Cross-chunk speaker reconciliation ────────────────────────────────────────
//
// When a long file is transcribed in overlapping chunks, each chunk numbers its
// speakers independently — so the same voice can be "Speaker 1" in one chunk and
// "Speaker 2" in the next. Because consecutive chunks OVERLAP, the person speaking
// at the end of chunk A is the same person speaking at the start of chunk B. We use
// that single high-confidence anchor to align chunk B's leading speaker to chunk A's
// numbering.
//
// Deliberately conservative: it remaps at most ONE label per seam, and ONLY when
// doing so cannot collide with a different speaker already present in the chunk.
// When anything is ambiguous it leaves the labels untouched — it never merges two
// distinct speakers and never corrupts the transcript (worst case: a no-op, i.e.
// the same behaviour as before this function existed).

const FIRST_LABEL_RE = /(?:^|\n)\s*(Speaker\s+\d+)\s*:/;
const ALL_LABELS_RE = /(Speaker\s+\d+)\s*:/g;

function labelNumber(label: string): string | null {
  return label.match(/\d+/)?.[0] ?? null;
}

function hasLabel(text: string, label: string): boolean {
  const n = labelNumber(label);
  if (!n) return false;
  return new RegExp(`\\bSpeaker\\s+${n}\\b(?!\\d)`).test(text);
}

/** The first speaker label that opens a turn in `text`, or null. */
export function firstSpeakerLabel(text: string): string | null {
  return text.match(FIRST_LABEL_RE)?.[1] ?? null;
}

/** The last speaker label that opens a turn in `text`, or null. */
export function lastSpeakerLabel(text: string): string | null {
  const matches = [...text.matchAll(ALL_LABELS_RE)];
  return matches.length ? matches[matches.length - 1][1] : null;
}

/**
 * Align `currChunk`'s leading speaker to the numbering already established in
 * `prevAccumulated` (the transcript built so far), using the overlap anchor.
 * Returns `currChunk` unchanged when no safe, unambiguous remap exists.
 */
export function reconcileLeadingSpeaker(prevAccumulated: string, currChunk: string): string {
  const prevTail = lastSpeakerLabel(prevAccumulated);
  const currHead = firstSpeakerLabel(currChunk);
  if (!prevTail || !currHead || prevTail === currHead) return currChunk;

  // Safety: if the chunk already uses prevTail's number for some (different)
  // speaker, remapping would merge two distinct people — refuse and leave as-is.
  if (hasLabel(currChunk, prevTail)) return currChunk;

  const headNum = labelNumber(currHead);
  if (!headNum) return currChunk;
  const re = new RegExp(`\\bSpeaker\\s+${headNum}\\b(?!\\d)`, 'g');
  return currChunk.replace(re, prevTail);
}
