// Window toggle icon — open (divider rail) / closed (collapsed solid rail).
// Custom Wisprnote-styled pair; matches the lucide icon API (size / strokeWidth /
// className / currentColor) so it drops into buttons like any lucide icon.
interface WindowToggleIconProps {
  open: boolean;
  size?: number;
  strokeWidth?: number;
  className?: string;
}

export default function WindowToggleIcon({
  open,
  size = 19,
  strokeWidth = 1.8,
  className,
}: WindowToggleIconProps) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <rect x="3" y="4.5" width="18" height="15" rx="4.5" />
      {open ? (
        <path d="M8.6 4.5V19.5" />
      ) : (
        <rect x="5.6" y="7" width="3.1" height="10" rx="1.5" fill="currentColor" stroke="none" />
      )}
    </svg>
  );
}
