import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

// Meetings/history icon — Wisprnote squircle spiral notepad. Shares the soft
// corner radius, 1.8 stroke and round caps of the chat and window-toggle icons
// so it reads as part of the same icon family. Lucide-compatible API (size /
// strokeWidth / color / className / currentColor), drops into nav arrays like
// any lucide icon.
const MeetingsIcon = forwardRef<SVGSVGElement, LucideProps>(function MeetingsIcon(
  { size = 24, strokeWidth = 1.8, color = 'currentColor', absoluteStrokeWidth: _absolute, ...props },
  ref,
) {
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <rect x="2.5" y="5" width="19" height="16.5" rx="3.6" />
      <path d="M7 2.5v4M12 2.5v4M17 2.5v4" />
      <path d="M7 12.5h10M7 16.5h6.5" />
    </svg>
  );
});

export default MeetingsIcon;
