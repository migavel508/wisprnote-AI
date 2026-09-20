// ─── Joining observed names to transcript turns ────────────────────────────────
//
// Two independent streams arrive during a meeting:
//
//   1. TRANSCRIPT turns — from the recogniser: "voice #2 said this, at time T".
//   2. OBSERVATIONS    — from the meeting app's own UI, read over the macOS
//                        accessibility tree: "the tile labelled Ada is highlighted
//                        as speaking, at time T".
//
// Neither knows about the other. This module joins them by TIME, which is the only
// thing they share, and is the single place where an anonymous "Speaker 2" becomes
// a named person.
//
// The join rule is deliberately the simplest one that can be reasoned about: take
// the most recent observation at or before the turn started, and reject it if it is
// older than a tolerance. No interpolation, no overlap scoring, no windowing —
// every one of those would let a name drift onto the wrong person's words, and a
// wrong name is far worse than no name.

import {
  SpeakerNameDenoiser,
  type SpeakerRef,
  type SpeakerMap,
  renameSpeaker,
} from './speakerLabeling';

/** How confident the meeting app's UI was about who is speaking. */
export type AttributionState = 'matched' | 'ambiguous' | 'unknown';

/** One reading of the meeting application's participant tiles. */
export interface SpeakerObservation {
  /** The tile highlighted as speaking, when exactly one was. */
  speakerName: string | null;
  /** Every participant name visible this tick — seeds the roster. */
  visibleNames: string[];
  attributionState: AttributionState;
  /** Wall-clock ms, from the same clock the transcript turns are stamped with. */
  timestampMs: number;
}

/**
 * A name is only trusted if it was observed within this window of the turn
 * starting. Beyond it the UI reading is stale — the speaker has very likely
 * changed since — and the turn is left anonymous.
 */
export const ATTRIBUTION_TOLERANCE_MS = 1_500;

/** The log is bounded so a long meeting cannot grow memory without limit. */
const MAX_EVENTS = 10_000;

export interface AttributionResult {
  name: string | null;
  reason: 'matched' | 'stale' | 'ambiguous' | 'unknown' | 'no_observations';
}

/**
 * Append-only log of observations for one meeting, with the time-join on top.
 *
 * Observations must be appended in non-decreasing time order, which is how they
 * arrive from the poller; the lookup is a binary search that relies on it.
 */
export class SpeakerObservationLog {
  private events: SpeakerObservation[] = [];
  private readonly denoiser = new SpeakerNameDenoiser();

  /** Every distinct participant name seen, in order of first appearance. */
  private roster: string[] = [];

  record(obs: SpeakerObservation): void {
    this.events.push(obs);
    if (this.events.length > MAX_EVENTS) {
      // Drop oldest; a meeting long enough to hit this has already attributed them.
      this.events.splice(0, this.events.length - MAX_EVENTS);
    }
    for (const n of obs.visibleNames) {
      if (n && !this.roster.includes(n)) this.roster.push(n);
    }
  }

  /** Participants seen on screen, whether or not they ever spoke. */
  participants(): string[] {
    return [...this.roster];
  }

  size(): number {
    return this.events.length;
  }

  /**
   * The most recent observation at or before `t`. Binary search over the
   * append-only log — O(log n) per transcript turn rather than a scan.
   */
  eventAtOrBefore(t: number): SpeakerObservation | null {
    let lo = 0;
    let hi = this.events.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.events[mid].timestampMs <= t) lo = mid + 1;
      else hi = mid;
    }
    return lo === 0 ? null : this.events[lo - 1];
  }

  /**
   * Resolve the name for a turn that began at `turnStartMs`.
   *
   * Returns a name ONLY when the meeting app was unambiguous and the reading is
   * fresh. `ambiguous` (two tiles both highlighted) deliberately yields nothing:
   * picking one would attach a real person's name to someone else's words.
   */
  attributionFor(turnStartMs: number): AttributionResult {
    const obs = this.eventAtOrBefore(turnStartMs);
    if (!obs) return { name: null, reason: 'no_observations' };
    if (turnStartMs - obs.timestampMs > ATTRIBUTION_TOLERANCE_MS) {
      return { name: null, reason: 'stale' };
    }
    if (obs.attributionState === 'ambiguous') return { name: null, reason: 'ambiguous' };
    if (obs.attributionState !== 'matched' || !obs.speakerName) {
      return { name: null, reason: 'unknown' };
    }
    return { name: obs.speakerName, reason: 'matched' };
  }

  /**
   * Feed a resolved name into the per-speaker denoiser and return the canonical
   * name once it has settled.
   *
   * Observations are noisy — a tile can flicker, the wrong one can highlight for a
   * frame — so a single sighting never names a speaker. The denoiser requires
   * repeated agreement before promoting, and much stronger disagreement before
   * replacing an established name.
   */
  observeForSpeaker(ref: SpeakerRef, name: string, now = Date.now()): string | undefined {
    this.denoiser.observe(ref, name, now);
    return this.denoiser.canonical(ref);
  }

  canonicalFor(ref: SpeakerRef): string | undefined {
    return this.denoiser.canonical(ref);
  }
}

/**
 * Fold a settled machine-observed name into the meeting's speaker map.
 *
 * A name the USER typed always wins: it is never overwritten by a scraped one, no
 * matter how many times the tile agrees. Returns the map unchanged in that case,
 * so callers can apply this unconditionally.
 */
export function applyObservedName(
  map: SpeakerMap,
  ref: SpeakerRef,
  name: string
): SpeakerMap {
  const key = `${ref.source}:${ref.id}`;
  const personKey = map.assignments[key];
  const existing = personKey ? map.people[personKey] : undefined;
  if (existing?.origin === 'user') return map;
  if (existing?.name === name) return map;

  const next = renameSpeaker(map, ref, name);
  // renameSpeaker marks the edit as a user edit; this one came from the machine,
  // so correct the origin — otherwise a scraped guess would outrank a later
  // correction by the person actually in the meeting.
  const assigned = next.assignments[key];
  if (assigned && next.people[assigned]) {
    next.people[assigned] = { name, origin: 'machine' };
  }
  return next;
}
