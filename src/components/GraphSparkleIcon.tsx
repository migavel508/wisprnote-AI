import { forwardRef } from 'react';
import type { LucideProps } from 'lucide-react';

// Knowledge icon — Wisprnote node-link graph with two outline sparkles in the
// bottom-right. This is a more detailed icon than the rest of the rail, so the
// nav's default stroke (1.5/1.8, even 2 on mobile) makes it read heavy/buggy at
// 17px. We scale the incoming strokeWidth down (~0.65) so it always renders
// light and clean, while keeping a touch more weight when the tab is active.
// Lucide-compatible API (size / strokeWidth / color / className / currentColor).
const GraphSparkleIcon = forwardRef<SVGSVGElement, LucideProps>(function GraphSparkleIcon(
  { size = 24, strokeWidth = 1.5, color = 'currentColor', absoluteStrokeWidth: _absolute, ...props },
  ref,
) {
  const sw = Number(strokeWidth) * 0.65;
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color}
      strokeWidth={sw}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <path d="M11.56 7.48 15.24 10.12" />
      <path d="M8.55 8.89 8.45 10.21" />
      <path d="M11.56 13.09 14.64 12.61" />
      <circle cx="8.8" cy="5.5" r="3.4" />
      <circle cx="18" cy="12.1" r="3.4" />
      <circle cx="8.2" cy="13.6" r="3.4" />
      <path d="M17.6 17.1C17.6 18.38 17.92 18.7 19.2 18.7 17.92 18.7 17.6 19.02 17.6 20.3 17.6 19.02 17.28 18.7 16 18.7 17.28 18.7 17.6 18.38 17.6 17.1Z" />
      <path d="M20.7 19.7C20.7 20.42 20.88 20.6 21.6 20.6 20.88 20.6 20.7 20.78 20.7 21.5 20.7 20.78 20.52 20.6 19.8 20.6 20.52 20.6 20.7 20.42 20.7 19.7Z" />
    </svg>
  );
});

export default GraphSparkleIcon;
