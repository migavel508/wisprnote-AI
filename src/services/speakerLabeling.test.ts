// ─── Speaker-labeling policy tests ─────────────────────────────────────────────
//
// Run: npx vitest run src/services/speakerLabeling.test.ts
//
// These tests are the guard against the "my name gets stamped onto speakers I'm
// not" regression. If anyone re-introduces an account-name / first-person identity
// rule into the batch transcription prompts, the source-scan test below fails.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
  buildSpeakerInstructions,
  clampDenoise,
  emptySpeakerMap,
  ensureOrdinal,
  renameSpeaker,
  resolveSpeakerLabel,
  SpeakerNameDenoiser,
  unassignSpeaker,
  firstSpeakerLabel,
  lastSpeakerLabel,
  reconcileLeadingSpeaker,
  type AudioSourceKind,
} from './speakerLabeling';

const BATCH_SOURCES: AudioSourceKind[] = ['upload', 'native-batch', 'mic-only'];

describe('buildSpeakerInstructions — policy', () => {
  it.each(BATCH_SOURCES)('never injects an account/app-user identity rule (%s)', (source) => {
    const text = buildSpeakerInstructions(source).toLowerCase();
    // The exact phrasings of the old broken rule, plus the general shape of it.
    expect(text).not.toContain('primary user');
    expect(text).not.toContain('refers to themselves');
    expect(text).not.toContain('app is named');
    expect(text).not.toContain('${username}');
    // Must not tell the model to derive a name from first-person speech.
    expect(text).not.toMatch(/use .* as the speaker label/);
  });

  it.each(BATCH_SOURCES)('uses neutral numbered labels and name-only-if-spoken (%s)', (source) => {
    const text = buildSpeakerInstructions(source);
    expect(text).toContain('Speaker 1');
    expect(text).toContain('Speaker 2');
    // The "only name if explicitly spoken" safeguard must be present.
    expect(text.toLowerCase()).toContain('only use a real');
    expect(text.toLowerCase()).toContain('when in doubt');
  });
});

describe('geminiService source scan — the bug cannot come back', () => {
  it('contains no identity-injection rule in the transcription prompts', () => {
    const src = readFileSync(fileURLToPath(new URL('./geminiService.ts', import.meta.url)), 'utf8');
    expect(src).not.toContain('IMPORTANT IDENTITY RULE');
    expect(src).not.toContain('The primary user of this app is named');
    expect(src).not.toContain('refers to themselves as "me" or "I"');
    // No userName variable feeding a transcription prompt anymore.
    expect(src).not.toMatch(/let userName = "the user"/);
  });
});

describe('speaker-label helpers', () => {
  it('firstSpeakerLabel / lastSpeakerLabel find boundary speakers', () => {
    const t = 'Speaker 1: hello there.\nSpeaker 2: hi.\nSpeaker 1: bye now.';
    expect(firstSpeakerLabel(t)).toBe('Speaker 1');
    expect(lastSpeakerLabel(t)).toBe('Speaker 1');
    expect(firstSpeakerLabel('no labels here')).toBeNull();
    expect(lastSpeakerLabel('no labels here')).toBeNull();
  });
});

describe('reconcileLeadingSpeaker — cross-chunk alignment', () => {
  it('aligns the chunk\'s leading speaker to the previous numbering', () => {
    // The same person speaks across the seam: "Speaker 2" at the end of prev, but
    // renumbered "Speaker 1" at the start of curr. curr does not reuse number 2 for
    // anyone else, so it is safe to align curr's leading speaker to "Speaker 2".
    const prev = 'Speaker 1: opening.\nSpeaker 2: and now I will explain the plan in detail.';
    const curr = 'Speaker 1: continuing the explanation, the next step.\nSpeaker 3: a question.';
    const out = reconcileLeadingSpeaker(prev, curr);
    expect(out.startsWith('Speaker 2: continuing the explanation')).toBe(true);
    // The unrelated speaker is untouched.
    expect(out).toContain('Speaker 3: a question.');
  });

  it('is a no-op when the remap would collide with a distinct speaker', () => {
    // prev tail is Speaker 2; curr already uses Speaker 2 for someone else → refuse.
    const prev = 'Speaker 2: closing thoughts.';
    const curr = 'Speaker 1: new point.\nSpeaker 2: a different person.';
    expect(reconcileLeadingSpeaker(prev, curr)).toBe(curr);
  });

  it('is a no-op when labels are missing or already aligned', () => {
    expect(reconcileLeadingSpeaker('no labels', 'also none')).toBe('also none');
    const aligned = 'Speaker 1: continues.';
    expect(reconcileLeadingSpeaker('Speaker 1: earlier.', aligned)).toBe(aligned);
  });

  it('never corrupts: only the leading label is remapped, others preserved', () => {
    const prev = 'Speaker 3: tail speaker.';
    const curr = 'Speaker 1: lead.\nSpeaker 2: other.';
    const out = reconcileLeadingSpeaker(prev, curr);
    expect(out).toBe('Speaker 3: lead.\nSpeaker 2: other.');
  });
});

// ─── Speaker identity model ────────────────────────────────────────────────────

describe('stable ordinals', () => {
  it('numbers speakers by order of first appearance', () => {
    const map = emptySpeakerMap();
    expect(ensureOrdinal(map, { source: 'system', id: 7 })).toBe(1);
    expect(ensureOrdinal(map, { source: 'system', id: 2 })).toBe(2);
    // Re-seeing a speaker must not allocate a new ordinal.
    expect(ensureOrdinal(map, { source: 'system', id: 7 })).toBe(1);
  });

  it('keeps a label stable when the recogniser renumbers around it', () => {
    // The regression this guards: "Speaker 2" must not become "Speaker 3" just
    // because a new voice appeared, or because upstream ids shifted.
    const map = emptySpeakerMap();
    ensureOrdinal(map, { source: 'system', id: 5 });
    ensureOrdinal(map, { source: 'system', id: 9 });
    const before = resolveSpeakerLabel(map, { source: 'system', id: 9 });
    ensureOrdinal(map, { source: 'system', id: 1 }); // a third voice joins
    expect(resolveSpeakerLabel(map, { source: 'system', id: 9 })).toBe(before);
    expect(before).toBe('Speaker 2');
  });
});

describe('resolveSpeakerLabel', () => {
  it('labels the mic channel as the local user', () => {
    const map = emptySpeakerMap();
    expect(resolveSpeakerLabel(map, { source: 'mic', id: 0 })).toBe('You');
    expect(resolveSpeakerLabel(map, { source: 'mic', id: 0 }, 'Ada')).toBe('Ada (You)');
  });

  it('NEVER applies the account name to a system-channel voice', () => {
    // The old bug, in its new form: the owner's name must not leak onto strangers.
    const map = emptySpeakerMap();
    const label = resolveSpeakerLabel(map, { source: 'system', id: 1 }, 'Ada');
    expect(label).not.toContain('Ada');
    expect(label).toBe('Speaker 1');
  });

  it('prefers an assigned name over the ordinal', () => {
    let map = emptySpeakerMap();
    const ref = { source: 'system' as const, id: 4 };
    ensureOrdinal(map, ref);
    map = renameSpeaker(map, ref, 'Grace');
    expect(resolveSpeakerLabel(map, ref)).toBe('Grace');
  });
});

describe('edit primitives', () => {
  it('a rename is recorded as a user edit and reuses the existing person', () => {
    let map = emptySpeakerMap();
    const ref = { source: 'system' as const, id: 2 };
    map = renameSpeaker(map, ref, 'Grace');
    const firstKey = map.assignments['system:2'];
    map = renameSpeaker(map, ref, 'Grace Hopper');
    expect(map.assignments['system:2']).toBe(firstKey); // same person, renamed
    expect(Object.keys(map.people)).toHaveLength(1);
    expect(map.people[firstKey!]).toEqual({ name: 'Grace Hopper', origin: 'user' });
  });

  it('clearing a name unassigns and falls back to the ordinal', () => {
    let map = emptySpeakerMap();
    const ref = { source: 'system' as const, id: 3 };
    ensureOrdinal(map, ref);
    map = renameSpeaker(map, ref, 'Grace');
    map = renameSpeaker(map, ref, '   ');
    expect(resolveSpeakerLabel(map, ref)).toBe('Speaker 1');
  });

  it('unassign detaches without destroying the person', () => {
    let map = emptySpeakerMap();
    const ref = { source: 'system' as const, id: 1 };
    map = renameSpeaker(map, ref, 'Grace');
    map = unassignSpeaker(map, ref);
    expect(map.assignments['system:1']).toBeNull();
    expect(Object.keys(map.people)).toHaveLength(1);
  });
});

describe('SpeakerNameDenoiser', () => {
  const ref = { source: 'system' as const, id: 1 };

  it('promotes only after the threshold of consecutive agreeing observations', () => {
    const d = new SpeakerNameDenoiser();
    expect(d.observe(ref, 'Grace')).toBe('accumulating');
    expect(d.observe(ref, 'Grace')).toBe('accumulating');
    expect(d.observe(ref, 'Grace')).toBe('promoted');
    expect(d.canonical(ref)).toBe('Grace');
  });

  it('flicker never accumulates toward a promotion', () => {
    const d = new SpeakerNameDenoiser();
    d.observe(ref, 'Grace');
    d.observe(ref, 'Alan');   // contradiction resets the streak
    d.observe(ref, 'Grace');
    expect(d.canonical(ref)).toBeUndefined();
  });

  it('replacing an established name takes more evidence than setting one', () => {
    const d = new SpeakerNameDenoiser();
    for (let i = 0; i < 3; i++) d.observe(ref, 'Grace');
    // Four contradictions is below remapThreshold (5) — the name must hold.
    for (let i = 0; i < 4; i++) d.observe(ref, 'Alan', 100_000);
    expect(d.canonical(ref)).toBe('Grace');
    expect(d.observe(ref, 'Alan', 100_000)).toBe('remapped');
    expect(d.canonical(ref)).toBe('Alan');
  });

  it('blocks a second remap during the cooldown', () => {
    const d = new SpeakerNameDenoiser();
    for (let i = 0; i < 3; i++) d.observe(ref, 'Grace');
    for (let i = 0; i < 5; i++) d.observe(ref, 'Alan', 100_000);
    expect(d.canonical(ref)).toBe('Alan');
    // Immediately contradicting again, inside the 30s window.
    for (let i = 0; i < 4; i++) d.observe(ref, 'Ada', 100_000);
    expect(d.observe(ref, 'Ada', 100_000)).toBe('cooldown_blocked');
    expect(d.canonical(ref)).toBe('Alan');
  });

  it('re-seeing the canonical name holds it', () => {
    const d = new SpeakerNameDenoiser();
    for (let i = 0; i < 3; i++) d.observe(ref, 'Grace');
    expect(d.observe(ref, 'Grace')).toBe('held');
  });

  it('tracks speakers independently', () => {
    const d = new SpeakerNameDenoiser();
    const other = { source: 'system' as const, id: 2 };
    for (let i = 0; i < 3; i++) d.observe(ref, 'Grace');
    for (let i = 0; i < 3; i++) d.observe(other, 'Alan');
    expect(d.canonical(ref)).toBe('Grace');
    expect(d.canonical(other)).toBe('Alan');
  });

  it('clamps out-of-range config instead of disabling denoising', () => {
    expect(clampDenoise({ promoteThreshold: 1 }).promoteThreshold).toBe(2);
    expect(clampDenoise({ promoteThreshold: 99 }).promoteThreshold).toBe(20);
    // remap must always exceed promote, whatever was asked for.
    const c = clampDenoise({ promoteThreshold: 10, remapThreshold: 3 });
    expect(c.remapThreshold).toBeGreaterThan(c.promoteThreshold);
    expect(clampDenoise({ remapCooldownMs: 10 }).remapCooldownMs).toBe(5_000);
  });
});
