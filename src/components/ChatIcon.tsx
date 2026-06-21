import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

// Chat icon — Wisprnote circular speech bubble with a lower-left tail. Sized to
// fill the same optical box as the lucide nav icons, 1.8 stroke / round caps.
// Lucide-compatible API (size / strokeWidth / color / className / currentColor),
// so it drops into nav arrays like any lucide icon.
const ChatIcon = forwardRef<SVGSVGElement, LucideProps>(function ChatIcon(
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
      <path d="M7.6 19.9A9 9 0 1 0 4.6 16.6L3.2 20.8Z" />
    </svg>
  );
});

export default ChatIcon;
