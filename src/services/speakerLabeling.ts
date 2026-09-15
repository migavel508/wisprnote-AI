// ─── Speaker-labeling policy (single source of truth) ──────────────────────────
//
// Why this module exists
// ----------------------
// Speaker identity must come from a RELIABLE signal, never from inferring "who is
// the app user" out of the words "I"/"me". Live recording gets identity for free
// from the physical audio channel (mic = "You", system = "Speaker N") in the Rust
// layer. Uploaded files have no channel separation — the user may not even be in
// the recording — so the ONLY honest labeling is neutral "Speaker 1..N", attaching
// a real name only when that name is actually spoken in the audio.
//
// A previous version injected the account holder's name onto any first-person
// speaker ("if they say 'I'/'me', label them <userName>"). Because every speaker
// says "I" and "me", that stamped the user's name onto arbitrary/other speakers —
// and onto uploads the user wasn't even in. That rule is gone, and it lives here
// now so it can't silently come back (see speakerLabeling.test.ts).

/**
 * Where the audio came from. Determines which labeling policy applies.
 *  - `live`         — native mic+system capture, labeled by channel in Rust (NOT this module).
 *  - `upload`       — a file the user uploaded; they may not even be present.
 *  - `native-batch` — recorded mic+system, mixed to mono before transcription.
 *  - `mic-only`     — browser MediaRecorder, microphone only.
 * All non-live sources use neutral `Speaker N` labeling (no channel info survives).
 */
export type AudioSourceKind = 'live' | 'upload' | 'native-batch' | 'mic-only';

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

// ─── The speaker identity model ────────────────────────────────────────────────
//
// Three layers, deliberately kept distinct because they answer different questions
// and have very different reliability:
//
//   1. CHANNEL  — which physical stream did this audio arrive on? Mic = the local
//                 user ("You"); system = everyone else. Coarse but certain, and the
//                 only reason we can ever say "You" without guessing.
//   2. DIARISED — which anonymous voice is this, per the recogniser? Soniox returns
//                 a numeric `speaker` on the system channel. Acoustic, server-side,
//                 and it can renumber mid-session.
//   3. NAME     — what is that voice called? NOT an acoustic question; no amount of
//                 signal processing recovers a name from a waveform. Today the only
//                 trustworthy source is the user typing it (see `renameSpeaker`).
//
// Diarisation is NOT speaker recognition. Layer 2 gives you "a distinct voice",
// never "this specific person".

/** Where a diarised identifier came from. The dedup key is `${source}:${id}`. */
export type SpeakerSource = 'mic' | 'system';

/** A speaker as the transcript refers to it, before any display resolution. */
export interface SpeakerRef {
  source: SpeakerSource;
  /** The recogniser's numeric id. Always 0 for the mic (the channel *is* the id). */
  id: number;
}

/** How a name came to be attached — an explicit user edit outranks everything. */
export type NameOrigin = 'user' | 'machine';

export interface SpeakerPerson {
  name: string;
  origin: NameOrigin;
}

/**
 * The persisted identity map for one meeting.
 *
 * `ordinals` is what keeps "Speaker 3" meaning the same person for the whole
 * transcript: the ordinal is assigned on FIRST APPEARANCE and never recomputed, so
 * if the recogniser renumbers its internal ids mid-meeting the visible label does
 * not shuffle under the reader. Storing it (rather than deriving it at render time)
 * is the whole point.
 */
export interface SpeakerMap {
  people: Record<string, SpeakerPerson>;
  /** `${source}:${id}` → person key. */
  assignments: Record<string, string | null>;
  /** `${source}:${id}` → stable display ordinal, by order of first appearance. */
  ordinals: Record<string, number>;
}

export function emptySpeakerMap(): SpeakerMap {
  return { people: {}, assignments: {}, ordinals: {} };
}

export function speakerKey(ref: SpeakerRef): string {
  return `${ref.source}:${ref.id}`;
}

/**
 * Assign `ref` its stable ordinal, allocating the next free one on first sight.
 * Mutates and returns the map so callers can thread it through a reduce.
 */
export function ensureOrdinal(map: SpeakerMap, ref: SpeakerRef): number {
  const key = speakerKey(ref);
  const existing = map.ordinals[key];
  if (existing != null) return existing;
  const next = Object.keys(map.ordinals).length + 1;
  map.ordinals[key] = next;
  return next;
}

/**
 * Resolve the label to show for a speaker.
 *
 * Priority, highest first:
 *   1. The mic channel is the local user — "You", or "<Name> (You)" if we know it.
 *   2. An assigned person's name (a user rename, or a machine suggestion).
 *   3. "Speaker N" on the stable ordinal.
 *
 * `ownerName` is only ever applied to the MIC channel. It is never used to guess at
 * a system-channel voice, which is the mistake that stamps the account holder's
 * name onto strangers.
 */
export function resolveSpeakerLabel(
  map: SpeakerMap,
  ref: SpeakerRef,
  ownerName?: string
): string {
  const key = speakerKey(ref);
  const personKey = map.assignments[key];
  const person = personKey ? map.people[personKey] : undefined;

  if (ref.source === 'mic') {
    const name = person?.name || ownerName?.trim();
    return name ? `${name} (You)` : 'You';
  }
  if (person?.name) return person.name;
  return `Speaker ${map.ordinals[key] ?? ensureOrdinal(map, ref)}`;
}

// ─── Edit primitives ───────────────────────────────────────────────────────────
//
// A user edit is the only signal that outranks the machine, so it is written to
// `origin: 'user'` and never overwritten by a later machine suggestion.

/** Name a speaker, reusing the person already linked to it when there is one. */
export function renameSpeaker(map: SpeakerMap, ref: SpeakerRef, name: string): SpeakerMap {
  const trimmed = name.trim();
  const key = speakerKey(ref);
  const next: SpeakerMap = {
    people: { ...map.people },
    assignments: { ...map.assignments },
    ordinals: { ...map.ordinals },
  };
  if (!trimmed) {
    next.assignments[key] = null; // clearing the name unassigns
    return next;
  }
  const existing = next.assignments[key];
  const personKey = existing ?? `p${Object.keys(next.people).length + 1}`;
  next.people[personKey] = { name: trimmed, origin: 'user' };
  next.assignments[key] = personKey;
  return next;
}

/** Link a speaker to a person that already exists in the map. */
export function assignSpeaker(map: SpeakerMap, ref: SpeakerRef, personKey: string): SpeakerMap {
  if (!map.people[personKey]) return map;
  return { ...map, assignments: { ...map.assignments, [speakerKey(ref)]: personKey } };
}

/** Detach a speaker from whatever person it resolved to, back to "Speaker N". */
export function unassignSpeaker(map: SpeakerMap, ref: SpeakerRef): SpeakerMap {
  return { ...map, assignments: { ...map.assignments, [speakerKey(ref)]: null } };
}

// ─── Name denoising ────────────────────────────────────────────────────────────
//
// Reserved for machine-suggested names, which arrive noisily (a name flickers, the
// wrong voice is briefly credited). Rather than trust any single observation, a
// candidate must repeat before it counts, and an established name must be
// contradicted repeatedly before it is replaced.
//
// This is a count-and-hysteresis scheme on purpose: there are no similarity scores
// or continuous thresholds to tune, so its behaviour is fully predictable.

export interface DenoiseConfig {
  /** Consecutive identical observations before a candidate becomes canonical. */
  promoteThreshold: number;
  /** Consecutive contradictions before an established name is replaced. */
  remapThreshold: number;
  /** After a remap, further remaps are blocked for this long. */
  remapCooldownMs: number;
}

export const DEFAULT_DENOISE: DenoiseConfig = {
  promoteThreshold: 3,
  remapThreshold: 5,
  remapCooldownMs: 30_000,
};

/** Clamp a config into the supported range so a bad value can't disable denoising. */
export function clampDenoise(cfg: Partial<DenoiseConfig>): DenoiseConfig {
  const promote = Math.min(Math.max(cfg.promoteThreshold ?? 3, 2), 20);
  const remap = Math.min(Math.max(cfg.remapThreshold ?? Math.max(promote + 2, 5), promote + 1), 30);
  const cooldown = Math.min(Math.max(cfg.remapCooldownMs ?? 30_000, 5_000), 120_000);
  return { promoteThreshold: promote, remapThreshold: remap, remapCooldownMs: cooldown };
}

export type DenoiseDecision =
  | 'accumulating'
  | 'promoted'
  | 'held'
  | 'rejected'
  | 'cooldown_blocked'
  | 'remapped';

interface DenoiseState {
  canonical?: string;
  candidate?: string;
  streak: number;
  lastRemapAt: number;
}

/**
 * Turns a stream of noisy per-speaker name observations into stable canonical names.
 * One instance per meeting; `observe` is called with every machine suggestion.
 */
export class SpeakerNameDenoiser {
  private readonly cfg: DenoiseConfig;
  private readonly state = new Map<string, DenoiseState>();

  constructor(cfg: Partial<DenoiseConfig> = {}) {
    this.cfg = clampDenoise(cfg);
  }

  /** The settled name for a speaker, if one has been promoted. */
  canonical(ref: SpeakerRef): string | undefined {
    return this.state.get(speakerKey(ref))?.canonical;
  }

  observe(ref: SpeakerRef, name: string, now = Date.now()): DenoiseDecision {
    const observed = name.trim();
    if (!observed) return 'rejected';

    const key = speakerKey(ref);
    const s = this.state.get(key) ?? { streak: 0, lastRemapAt: 0 };
    this.state.set(key, s);

    // Seeing the established name again just reinforces it.
    if (s.canonical === observed) {
      s.candidate = undefined;
      s.streak = 0;
      return 'held';
    }

    // A different name from last time restarts the count — the threshold counts
    // CONSECUTIVE agreement, so flicker can never accumulate toward a promotion.
    if (s.candidate !== observed) {
      s.candidate = observed;
      s.streak = 1;
    } else {
      s.streak += 1;
    }

    // No name yet: promote once the candidate repeats enough.
    if (!s.canonical) {
      if (s.streak >= this.cfg.promoteThreshold) {
        s.canonical = observed;
        s.candidate = undefined;
        s.streak = 0;
        return 'promoted';
      }
      return 'accumulating';
    }

    // Replacing an established name is deliberately harder than setting one.
    if (s.streak >= this.cfg.remapThreshold) {
      if (now - s.lastRemapAt < this.cfg.remapCooldownMs) return 'cooldown_blocked';
      s.canonical = observed;
      s.candidate = undefined;
      s.streak = 0;
      s.lastRemapAt = now;
      return 'remapped';
    }
    return 'accumulating';
  }
}

// ─── Folding provider tokens into a transcript ─────────────────────────────────

/** A diarised token as returned by the transcription provider. */
export interface DiarisedToken {
  text: string;
  start_ms?: number;
  end_ms?: number;
  speaker?: string;
}

/**
 * Turn a flat token stream into speaker-labelled lines.
 *
 * Applies the same two rules as the live path so both sources read identically:
 * adjacent tokens from the SAME speaker merge into one line, and a new line starts
 * when the speaker changes or a silence gap opens. Ordinals come from the shared
 * `SpeakerMap`, so "Speaker 2" means the same person here as it does live.
 *
 * Uploaded audio has no channel separation — the user may not even be in the
 * recording — so every voice is a `system` speaker. Nothing is ever labelled "You".
 */
export function foldTokensToTranscript(
  tokens: DiarisedToken[],
  map: SpeakerMap,
  gapMs = 1_200
): { text: string; map: SpeakerMap } {
  const lines: string[] = [];
  let speaker: string | undefined;
  let buf = '';
  let lastEnd = 0;

  const flush = () => {
    const t = buf.trim();
    if (!t) { buf = ''; return; }
    const ref: SpeakerRef = { source: 'system', id: Number(speaker ?? 0) || 0 };
    ensureOrdinal(map, ref);
    lines.push(`${resolveSpeakerLabel(map, ref)}: ${t}`);
    buf = '';
  };

  for (const tok of tokens) {
    const changed = speaker !== undefined && tok.speaker !== speaker;
    const gapped = lastEnd > 0 && (tok.start_ms ?? 0) - lastEnd > gapMs;
    if (changed || gapped) flush();
    if (!buf) speaker = tok.speaker;
    buf += tok.text;
    lastEnd = tok.end_ms ?? lastEnd;
  }
  flush();

  return { text: lines.join('\n'), map };
}
