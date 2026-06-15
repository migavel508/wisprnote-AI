/**
 * Deterministic date-range parsing for chat queries.
 *
 * The agent used to GUESS a relative `recent_days` from prose, which made
 * "this month", "last 3 days", a specific date, "yesterday", etc. unreliable.
 * This parses the user's question into an absolute [start, end] window (and a
 * human label for the UI tool-step), anchored to the caller's local "now" — so
 * date scoping becomes deterministic instead of model-dependent.
 */

export interface ParsedDateRange {
  /** Inclusive lower bound (epoch ms). */
  startMs: number;
  /** Exclusive upper bound (epoch ms). */
  endMs: number;
  /** Human label for UI tool-steps, e.g. "this month", "last 3 days". */
  label: string;
}

const WORD_NUMBERS: Record<string, number> = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, twenty: 20, thirty: 30, sixty: 60, ninety: 90,
};

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const WEEKDAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];

const startOfDay = (d: Date): Date => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };
const endOfDay = (d: Date): Date => { const x = new Date(d); x.setHours(23, 59, 59, 999); return x; };
const addDays = (d: Date, n: number): Date => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/**
 * Parse a date window from a natural-language query. Returns null when the query
 * carries no date intent (so the caller searches all time).
 */
export function parseDateRange(query: string, nowMs: number = Date.now()): ParsedDateRange | null {
  const q = query.toLowerCase();
  const now = new Date(nowMs);
  const today0 = startOfDay(now);
  const todayEnd = endOfDay(now);

  const range = (start: Date, end: Date, label: string): ParsedDateRange => ({ startMs: start.getTime(), endMs: end.getTime(), label });

  // ── Relative day windows: "last/past N days", "last 3 days", "past three days" ──
  const nDays = q.match(/\b(?:last|past|previous|recent)\s+(\d+|[a-z]+)\s+days?\b/);
  if (nDays) {
    const n = parseInt(nDays[1], 10) || WORD_NUMBERS[nDays[1]] || 0;
    if (n > 0) return range(startOfDay(addDays(now, -(n - 1))), todayEnd, `last ${n} days`);
  }

  if (/\btoday\b/.test(q)) return range(today0, todayEnd, 'today');
  if (/\byesterday\b/.test(q)) return range(startOfDay(addDays(now, -1)), endOfDay(addDays(now, -1)), 'yesterday');

  // ── Week ───────────────────────────────────────────────────────────────────
  const dow = now.getDay(); // 0=Sun
  const mondayOffset = dow === 0 ? -6 : 1 - dow; // ISO week starts Monday
  const thisMonday = startOfDay(addDays(now, mondayOffset));
  if (/\bthis week\b/.test(q)) return range(thisMonday, todayEnd, 'this week');
  if (/\blast week\b|\bpast week\b/.test(q)) return range(addDays(thisMonday, -7), endOfDay(addDays(thisMonday, -1)), 'last week');

  // ── Month ──────────────────────────────────────────────────────────────────
  if (/\bthis month\b/.test(q)) return range(new Date(now.getFullYear(), now.getMonth(), 1), todayEnd, 'this month');
  if (/\blast month\b|\bpast month\b/.test(q)) {
    const firstThis = new Date(now.getFullYear(), now.getMonth(), 1);
    return range(new Date(now.getFullYear(), now.getMonth() - 1, 1), endOfDay(addDays(firstThis, -1)), 'last month');
  }

  // ── Year ───────────────────────────────────────────────────────────────────
  if (/\bthis year\b/.test(q)) return range(new Date(now.getFullYear(), 0, 1), todayEnd, 'this year');
  if (/\blast year\b/.test(q)) return range(new Date(now.getFullYear() - 1, 0, 1), endOfDay(new Date(now.getFullYear() - 1, 11, 31)), 'last year');

  // ── A named month, optionally with a day: "in March", "June 12", "12 June 2025" ──
  const monthIdx = MONTHS.findIndex((m) => new RegExp(`\\b${m}\\b|\\b${m.slice(0, 3)}\\b`).test(q));
  if (monthIdx >= 0) {
    const yearM = q.match(/\b(20\d{2})\b/);
    const year = yearM ? parseInt(yearM[1], 10) : now.getFullYear();
    const dayM = q.match(new RegExp(`(?:${MONTHS[monthIdx].slice(0, 3)}[a-z]*\\.?\\s+(\\d{1,2}))|(\\d{1,2})\\s+${MONTHS[monthIdx].slice(0, 3)}`));
    const day = dayM ? parseInt(dayM[1] || dayM[2], 10) : 0;
    if (day >= 1 && day <= 31) {
      const d = new Date(year, monthIdx, day);
      return range(startOfDay(d), endOfDay(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
    }
    return range(new Date(year, monthIdx, 1), endOfDay(new Date(year, monthIdx + 1, 0)), `${MONTHS[monthIdx][0].toUpperCase()}${MONTHS[monthIdx].slice(1)} ${year}`);
  }

  // ── ISO / numeric date: 2025-06-12, 6/12/2025 ──────────────────────────────
  const iso = q.match(/\b(20\d{2})-(\d{1,2})-(\d{1,2})\b/);
  if (iso) {
    const d = new Date(parseInt(iso[1], 10), parseInt(iso[2], 10) - 1, parseInt(iso[3], 10));
    if (!isNaN(d.getTime())) return range(startOfDay(d), endOfDay(d), d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }));
  }

  // ── "on Monday" → the most recent occurrence of that weekday ────────────────
  const wd = WEEKDAYS.findIndex((w) => new RegExp(`\\bon ${w}\\b|\\blast ${w}\\b|\\b${w}'s?\\b`).test(q));
  if (wd >= 0) {
    let diff = (dow - wd + 7) % 7;
    if (diff === 0) diff = 0; // today is that weekday
    const d = addDays(now, -diff);
    return range(startOfDay(d), endOfDay(d), WEEKDAYS[wd][0].toUpperCase() + WEEKDAYS[wd].slice(1));
  }

  return null;
}

/** Does the query ask about meetings/topics that are off track / stalled / blocked? */
export function detectOffTrack(query: string): boolean {
  return /\boff[-\s]?track\b|\bstalled\b|\bblocked\b|\bbehind\b|\bat risk\b|\bslipping\b|\bdelayed\b|\bnot on track\b|\bstuck\b/i.test(query);
}
