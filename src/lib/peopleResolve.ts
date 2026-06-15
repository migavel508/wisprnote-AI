/**
 * Reconcile a meeting's PEOPLE for the knowledge graph.
 *
 * Two sources of names per meeting:
 *  - `attendees`  — the authoritative list the user mapped to the meeting. Correct
 *                   spelling, definitely present.
 *  - `extracted`  — names the model pulled from the transcript. Useful (captures
 *                   people who were mentioned/spoke) but the transcription can
 *                   mis-hear a name ("Jon" for "John", "Sara" for "Sarah").
 *
 * Strategy: attendees are the source of truth. We keep every attendee, then fold
 * in extracted names — but drop any extracted name that's clearly the same person
 * as an attendee (a misspelling), so the graph shows one correct node, not two.
 * Extracted names with no attendee match are kept (people mentioned but not in the
 * attendee list).
 */

function norm(s: string): string {
  return s.toLowerCase().trim().replace(/[^\p{L}\p{N}\s]/gu, '').replace(/\s+/g, ' ');
}
function firstToken(s: string): string {
  return norm(s).split(' ')[0] || '';
}

/** Levenshtein distance — small, bounded inputs (names). */
function lev(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      curr[j] = Math.min(
        prev[j] + 1,
        curr[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = curr;
  }
  return prev[b.length];
}

/** Are two names plausibly the same person? Conservative — same first name, or a
    near-miss spelling of the first name (handles transcription errors). */
export function namesMatch(a: string, b: string): boolean {
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const fa = firstToken(a), fb = firstToken(b);
  if (!fa || !fb) return false;
  if (fa === fb) return true; // "John" vs "John Smith"
  const thr = Math.max(fa.length, fb.length) <= 4 ? 1 : 2;
  return lev(fa, fb) <= thr; // "Jon" vs "John", "Sara" vs "Sarah"
}

function dedupe(names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    const t = (n || '').trim();
    if (!t) continue;
    if (out.some((o) => norm(o) === norm(t))) continue;
    out.push(t);
  }
  return out;
}

/**
 * Merge attendees (authoritative) with transcript-extracted people. Attendees win
 * on spelling; extracted misspellings of an attendee are dropped.
 */
export function mergePeopleWithAttendees(extracted?: string[] | null, attendees?: string[] | null): string[] {
  const att = dedupe(attendees || []);
  const ext = (extracted || []).map((s) => (s || '').trim()).filter(Boolean);
  if (att.length === 0) return dedupe(ext); // no attendee mapping → fall back to extracted
  const result = [...att];
  for (const e of ext) {
    if (att.some((a) => namesMatch(a, e))) continue; // same person as an attendee (poss. misspelled) → skip
    if (result.some((r) => namesMatch(r, e))) continue; // dup among the extracted extras
    result.push(e);
  }
  return result;
}
