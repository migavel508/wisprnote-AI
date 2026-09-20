import { useMemo } from 'react';
import { parseTranscript, speakerInitials, speakerColorIndex } from '../lib/transcript';

/**
 * Structured transcript panel: speakers on the left, what they said on the right.
 *
 * This replaces rendering the transcript as markdown prose. Prose gave every turn
 * the same visual weight and, because the live path joins turns with a space
 * rather than a newline, collapsed the whole meeting into a single paragraph with
 * no way to scan who said what.
 *
 * The layout is a two-column grid rather than a flex row so every speaker column
 * shares one width — turns line up down the page instead of the text left edge
 * jittering with the length of each name. It collapses to stacked rows on narrow
 * windows, where a fixed name gutter would leave too little room for the words.
 */

/** Accent per speaker. Slot 0 is reserved for the local user. */
const PALETTE = [
  { dot: 'bg-[#819C1F]', text: 'text-[#5f7318] dark:text-[#acc36a]', chip: 'bg-[#819C1F]/10 dark:bg-[#acc36a]/15' },
  { dot: 'bg-sky-500',    text: 'text-sky-700 dark:text-sky-300',     chip: 'bg-sky-500/10 dark:bg-sky-400/15' },
  { dot: 'bg-violet-500', text: 'text-violet-700 dark:text-violet-300', chip: 'bg-violet-500/10 dark:bg-violet-400/15' },
  { dot: 'bg-amber-500',  text: 'text-amber-700 dark:text-amber-300',  chip: 'bg-amber-500/10 dark:bg-amber-400/15' },
  { dot: 'bg-rose-500',   text: 'text-rose-700 dark:text-rose-300',    chip: 'bg-rose-500/10 dark:bg-rose-400/15' },
  { dot: 'bg-teal-500',   text: 'text-teal-700 dark:text-teal-300',    chip: 'bg-teal-500/10 dark:bg-teal-400/15' },
];

export default function TranscriptView({ text }: { text: string }) {
  const turns = useMemo(() => parseTranscript(text), [text]);

  if (turns.length === 0) {
    return (
      <p className="text-[13.5px] text-zinc-500 dark:text-app-fg-subtle py-10 text-center">
        No transcript for this meeting.
      </p>
    );
  }

  return (
    <div className="divide-y divide-zinc-200/70 dark:divide-app-border">
      {turns.map((turn, i) => {
        const c = PALETTE[speakerColorIndex(turn.speaker, PALETTE.length)];
        const isSelf = /^you$/i.test(turn.speaker.trim());
        return (
          <div
            key={i}
            className="grid grid-cols-1 sm:grid-cols-[132px_minmax(0,1fr)] gap-1 sm:gap-5 py-3.5 first:pt-1"
          >
            {/* Speaker column */}
            <div className="flex items-start gap-2 sm:pt-[3px] min-w-0">
              {turn.speaker ? (
                <>
                  <span
                    className={`mt-[7px] w-1.5 h-1.5 rounded-full flex-shrink-0 ${c.dot}`}
                    aria-hidden
                  />
                  <span
                    className={`text-[12.5px] font-semibold tracking-[-0.01em] leading-[1.5] truncate ${c.text}`}
                    title={turn.speaker}
                  >
                    {isSelf ? 'You' : turn.speaker}
                  </span>
                </>
              ) : (
                <span className="text-[12.5px] text-zinc-400 dark:text-app-fg-subtle italic">—</span>
              )}
            </div>

            {/* Spoken content */}
            <p className="text-[14.5px] leading-[1.72] text-zinc-700 dark:text-zinc-300 whitespace-pre-wrap break-words min-w-0">
              {turn.text}
            </p>
          </div>
        );
      })}
    </div>
  );
}

export { speakerInitials };
