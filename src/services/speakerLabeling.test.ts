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
