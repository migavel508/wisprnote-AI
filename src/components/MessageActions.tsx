import { useState } from 'react';
import { Copy, ThumbsUp, ThumbsDown, Check } from 'lucide-react';

/**
 * Per-response action row shown under each completed assistant message:
 * copy · good response · bad response. Subtle by default, color on action —
 * the familiar pattern users expect at the end of an AI answer.
 */
export default function MessageActions({ text, className = '' }: { text: string; className?: string }) {
  const [copied, setCopied] = useState(false);
  const [feedback, setFeedback] = useState<'up' | 'down' | null>(null);

  const copy = () => {
    navigator.clipboard?.writeText(text)
      .then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1500);
      })
      .catch(() => { /* clipboard unavailable — non-fatal */ });
  };

  const btn = 'p-1.5 rounded-md text-zinc-400 dark:text-zinc-500 hover:text-zinc-700 dark:hover:text-zinc-200 hover:bg-zinc-100 dark:hover:bg-app-chip transition-colors';

  return (
    <div className={`flex items-center gap-0.5 ${className}`}>
      <button type="button" onClick={copy} title={copied ? 'Copied' : 'Copy'} aria-label="Copy response" className={btn}>
        {copied ? <Check className="w-[15px] h-[15px] text-[#819C1F]" /> : <Copy className="w-[15px] h-[15px]" />}
      </button>
      <button
        type="button"
        onClick={() => setFeedback(f => (f === 'up' ? null : 'up'))}
        title="Good response"
        aria-label="Good response"
        aria-pressed={feedback === 'up'}
        className={`${btn} ${feedback === 'up' ? 'text-[#819C1F] dark:text-[#acc36a]' : ''}`}
      >
        <ThumbsUp className="w-[15px] h-[15px]" />
      </button>
      <button
        type="button"
        onClick={() => setFeedback(f => (f === 'down' ? null : 'down'))}
        title="Bad response"
        aria-label="Bad response"
        aria-pressed={feedback === 'down'}
        className={`${btn} ${feedback === 'down' ? 'text-red-500' : ''}`}
      >
        <ThumbsDown className="w-[15px] h-[15px]" />
      </button>
    </div>
  );
}
