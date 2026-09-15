// Run: npx vitest run src/services/speakerObservations.test.ts
import { describe, it, expect } from 'vitest';
import {
  SpeakerObservationLog,
  applyObservedName,
  ATTRIBUTION_TOLERANCE_MS,
  type SpeakerObservation,
} from './speakerObservations';
import { emptySpeakerMap, renameSpeaker, resolveSpeakerLabel } from './speakerLabeling';

const obs = (
  t: number,
  name: string | null,
  state: SpeakerObservation['attributionState'] = 'matched',
  visible: string[] = name ? [name] : []
): SpeakerObservation => ({
  speakerName: name,
  visibleNames: visible,
  attributionState: state,
  timestampMs: t,
});

describe('eventAtOrBefore', () => {
  it('finds the most recent observation at or before a time', () => {
    const log = new SpeakerObservationLog();
    [1000, 2000, 3000].forEach(t => log.record(obs(t, `n${t}`)));
    expect(log.eventAtOrBefore(2500)?.timestampMs).toBe(2000);
    expect(log.eventAtOrBefore(3000)?.timestampMs).toBe(3000); // inclusive
    expect(log.eventAtOrBefore(999)).toBeNull();               // nothing yet
  });
});

describe('attributionFor', () => {
  it('names a turn when the reading is fresh and unambiguous', () => {
    const log = new SpeakerObservationLog();
    log.record(obs(10_000, 'Ada Lovelace'));
    expect(log.attributionFor(10_500)).toEqual({ name: 'Ada Lovelace', reason: 'matched' });
  });

  it('rejects a reading older than the tolerance', () => {
    const log = new SpeakerObservationLog();
    log.record(obs(10_000, 'Ada Lovelace'));
    const justInside = 10_000 + ATTRIBUTION_TOLERANCE_MS;
    expect(log.attributionFor(justInside).reason).toBe('matched');
    expect(log.attributionFor(justInside + 1)).toEqual({ name: null, reason: 'stale' });
  });

  it('attaches NOTHING when two tiles both claim to be speaking', () => {
    // Guessing here would print a real person's name over someone else's words.
    const log = new SpeakerObservationLog();
    log.record(obs(10_000, null, 'ambiguous', ['Ada', 'Alan']));
    expect(log.attributionFor(10_100)).toEqual({ name: null, reason: 'ambiguous' });
  });

  it('attaches nothing when the app reads as unknown', () => {
    const log = new SpeakerObservationLog();
    log.record(obs(10_000, null, 'unknown'));
    expect(log.attributionFor(10_100).name).toBeNull();
  });

  it('reports when there are no observations at all', () => {
    expect(new SpeakerObservationLog().attributionFor(1).reason).toBe('no_observations');
  });

  it('uses the observation in force at the time, not the latest one', () => {
    // A turn early in the meeting must not be named after whoever is speaking now.
    const log = new SpeakerObservationLog();
    log.record(obs(1_000, 'Ada'));
    log.record(obs(9_000, 'Alan'));
    expect(log.attributionFor(1_200).name).toBe('Ada');
  });
});

describe('roster', () => {
  it('collects every visible participant, including silent ones', () => {
    const log = new SpeakerObservationLog();
    log.record(obs(1_000, 'Ada', 'matched', ['Ada', 'Alan', 'Grace']));
    expect(log.participants()).toEqual(['Ada', 'Alan', 'Grace']);
  });

  it('does not duplicate names across ticks', () => {
    const log = new SpeakerObservationLog();
    log.record(obs(1_000, 'Ada', 'matched', ['Ada', 'Alan']));
    log.record(obs(2_000, 'Alan', 'matched', ['Ada', 'Alan']));
    expect(log.participants()).toEqual(['Ada', 'Alan']);
  });
});

describe('denoising before a name sticks', () => {
  const ref = { source: 'system' as const, id: 2 };

  it('requires repeated agreement before naming a speaker', () => {
    const log = new SpeakerObservationLog();
    expect(log.observeForSpeaker(ref, 'Ada')).toBeUndefined();
    expect(log.observeForSpeaker(ref, 'Ada')).toBeUndefined();
    expect(log.observeForSpeaker(ref, 'Ada')).toBe('Ada');
  });

  it('a flickering tile never promotes a name', () => {
    const log = new SpeakerObservationLog();
    log.observeForSpeaker(ref, 'Ada');
    log.observeForSpeaker(ref, 'Alan');
    log.observeForSpeaker(ref, 'Ada');
    expect(log.canonicalFor(ref)).toBeUndefined();
  });
});

describe('applyObservedName', () => {
  const ref = { source: 'system' as const, id: 1 };

  it('names an unnamed speaker and marks it machine-attributed', () => {
    const map = applyObservedName(emptySpeakerMap(), ref, 'Ada Lovelace');
    const key = map.assignments['system:1']!;
    expect(map.people[key]).toEqual({ name: 'Ada Lovelace', origin: 'machine' });
    expect(resolveSpeakerLabel(map, ref)).toBe('Ada Lovelace');
  });

  it('NEVER overwrites a name the user typed', () => {
    // The whole point of the origin field: a scraped tile must not beat a human.
    let map = renameSpeaker(emptySpeakerMap(), ref, 'Mum');
    map = applyObservedName(map, ref, 'Ada Lovelace');
    expect(resolveSpeakerLabel(map, ref)).toBe('Mum');
  });

  it('is a no-op when the name is already correct', () => {
    const first = applyObservedName(emptySpeakerMap(), ref, 'Ada');
    expect(applyObservedName(first, ref, 'Ada')).toBe(first);
  });
});
