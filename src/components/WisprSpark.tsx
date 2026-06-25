import { useEffect, useState } from 'react';

/**
 * WISPR SPARK — the Wisprnote mark, animated EXACTLY like Claude's working shimmer.
 *
 * Replicates the reference algorithm (Claude Code, bridge/bridgeStatusUtil.ts):
 *   • a narrow bright BAND (3 units wide: [glimmer-1 … glimmer+1]) sweeps across the rays,
 *   • RIGHT-TO-LEFT (reverse sweep) — the glimmer index DECREASES each tick,
 *   • stepped at exactly SHIMMER_INTERVAL_MS = 150ms (not smooth easing),
 *   • with a GAP between sweeps (cycleLength = count + GAP) so it sweeps, pauses, repeats,
 *   • band rays are BRIGHT; all others sit at a DIM baseline (the mark is always visible).
 * Idle: a static green starburst. Respects prefers-reduced-motion (no sweep → static).
 */

// Irregular rays in angular order (angle°, length, stroke width) — the hand-drawn starburst.
const RAYS: { a: number; l: number; w: number }[] = [
  { a: -82, l: 42, w: 8 },
  { a: -52, l: 40, w: 9 },
  { a: -28, l: 24, w: 7 },
  { a: -6, l: 40, w: 9 },
  { a: 16, l: 22, w: 7 },
  { a: 38, l: 30, w: 8 },
  { a: 60, l: 19, w: 6 },
  { a: 88, l: 36, w: 9 },
  { a: 112, l: 24, w: 7 },
  { a: 138, l: 32, w: 8 },
  { a: 162, l: 21, w: 7 },
  { a: 182, l: 40, w: 9 },
  { a: 208, l: 26, w: 7 },
  { a: 232, l: 34, w: 8 },
  { a: 256, l: 22, w: 7 },
];
const CX = 50, CY = 50, INNER = 5;

const SHIMMER_INTERVAL_MS = 150;   // Claude's exact tick cadence
const GAP = 6;                     // pause between sweeps (Claude uses +20 for long text; an icon wants a short breath)
const BASELINE = 0.4;              // dim opacity for rays outside the bright band

export default function WisprSpark({
  size = 20,
  active = false,
  color = '#7BA22E',
  shimmerColor = '#CDE89B',
  className = '',
}: { size?: number; active?: boolean; color?: string; shimmerColor?: string; className?: string }) {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    if (typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
    const id = setInterval(() => setTick((t) => t + 1), SHIMMER_INTERVAL_MS);
    return () => clearInterval(id);
  }, [active]);

  const n = RAYS.length;
  const cycle = n + GAP;
  // Reverse sweep: glimmer starts off the right edge and decreases each tick (Claude's formula shape).
  const glimmer = active ? (n + Math.floor(GAP / 2)) - (tick % cycle) : -999;

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 100 100"
      className={`wispr-spark ${className}`}
      style={{ overflow: 'visible', display: 'block' }}
      aria-hidden="true"
    >
      {RAYS.map((r, i) => {
        const rad = (r.a * Math.PI) / 180;
        const x1 = CX + Math.cos(rad) * INNER;
        const y1 = CY + Math.sin(rad) * INNER;
        const x2 = CX + Math.cos(rad) * (INNER + r.l);
        const y2 = CY + Math.sin(rad) * (INNER + r.l);
        const inBand = active && i >= glimmer - 1 && i <= glimmer + 1;   // 3-wide bright band
        return (
          <line
            key={i}
            x1={x1} y1={y1} x2={x2} y2={y2}
            stroke={inBand ? shimmerColor : color}
            strokeWidth={r.w}
            strokeLinecap="round"
            opacity={active ? (inBand ? 1 : BASELINE) : 1}
            style={{ transition: 'opacity 150ms linear, stroke 150ms linear' }}
          />
        );
      })}
    </svg>
  );
}
