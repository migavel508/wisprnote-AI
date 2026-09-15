// Run: npx vitest run src/lib/transcript.test.ts
import { describe, it, expect } from 'vitest';
import { parseTranscript, speakerInitials, speakerColorIndex } from './transcript';

describe('parseTranscript', () => {
  it('splits mid-line labels that the live path emits', () => {
    // The live path joins turns with a SPACE, not a newline — this is the exact
    // shape that used to render as one run-on paragraph.
    const turns = parseTranscript(
      'You: Hello, how are you? Speaker 1: I am fine. You: Great to hear.'
    );
    expect(turns).toEqual([
      { speaker: 'You', text: 'Hello, how are you?' },
      { speaker: 'Speaker 1', text: 'I am fine.' },
      { speaker: 'You', text: 'Great to hear.' },
    ]);
  });

  it('merges consecutive turns from the same speaker', () => {
    const turns = parseTranscript('You: First part. You: Second part. Speaker 2: Reply.');
    expect(turns).toHaveLength(2);
    expect(turns[0]).toEqual({ speaker: 'You', text: 'First part. Second part.' });
  });

  it('handles non-Latin speech and labels after a comma', () => {
    // Regression from the reported screenshot: a label can follow ", " rather
    // than sentence punctuation, and the body can be Tamil.
    const turns = parseTranscript('You: இரு, You: ஏன் தெரியல, நெட்வொர்க் ரொம்ப ஸ்லோவா இருக்கு.');
    expect(turns).toHaveLength(1); // same speaker, merged
    expect(turns[0].speaker).toBe('You');
    expect(turns[0].text).toContain('நெட்வொர்க்');
  });

  it('parses line-based transcripts from uploaded files', () => {
    const turns = parseTranscript('Speaker 1: Opening remarks.\nSpeaker 2: A question.\nSpeaker 1: An answer.');
    expect(turns.map(t => t.speaker)).toEqual(['Speaker 1', 'Speaker 2', 'Speaker 1']);
  });

  it('accepts a renamed speaker at the start of a line', () => {
    const turns = parseTranscript('Ada Lovelace: Good morning.\nSpeaker 2: Morning.');
    expect(turns[0]).toEqual({ speaker: 'Ada Lovelace', text: 'Good morning.' });
  });

  it('does NOT split on a colon inside ordinary prose', () => {
    // "Note:" mid-sentence is prose, not a speaker label.
    const turns = parseTranscript('You: One thing to remember: always test the parser.');
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toBe('One thing to remember: always test the parser.');
  });

  it('does not split on a clock time', () => {
    const turns = parseTranscript('You: Let us meet at 10:30 tomorrow.');
    expect(turns).toHaveLength(1);
    expect(turns[0].text).toContain('10:30');
  });

  it('never drops words that precede the first label', () => {
    const turns = parseTranscript('Some preamble text. You: And then I spoke.');
    expect(turns[0]).toEqual({ speaker: '', text: 'Some preamble text.' });
    expect(turns[1].speaker).toBe('You');
  });

  it('returns a single unattributed turn when there are no labels', () => {
    const turns = parseTranscript('Just a plain transcript with no speakers at all.');
    expect(turns).toEqual([{ speaker: '', text: 'Just a plain transcript with no speakers at all.' }]);
  });

  it('is empty for empty input', () => {
    expect(parseTranscript('')).toEqual([]);
    expect(parseTranscript('   \n  ')).toEqual([]);
  });

  it('preserves the full text across a round trip', () => {
    const src = 'You: alpha beta. Speaker 1: gamma delta. You: epsilon.';
    const joined = parseTranscript(src).map(t => t.text).join(' ');
    for (const w of ['alpha', 'beta', 'gamma', 'delta', 'epsilon']) {
      expect(joined).toContain(w);
    }
  });
});

describe('speaker chips', () => {
  it('uses the number for numbered speakers and initials for names', () => {
    expect(speakerInitials('Speaker 3')).toBe('3');
    expect(speakerInitials('Ada Lovelace')).toBe('AL');
    expect(speakerInitials('You')).toBe('You');
  });

  it('gives a speaker a stable colour across calls', () => {
    const a = speakerColorIndex('Speaker 2', 6);
    expect(speakerColorIndex('Speaker 2', 6)).toBe(a);
    expect(speakerColorIndex('You', 6)).toBe(0); // the local user is always slot 0
  });
});
