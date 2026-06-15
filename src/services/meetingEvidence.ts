/**
 * Structured "evidence card" builder shared by every chat retrieval path.
 *
 * The old evidence blocks were transcript chunks + a notes/summary slice, which
 * dropped the meeting's hard facts — so answers missed the DATE, ATTENDEES,
 * ACTION ITEMS, and DECISIONS even when the right meeting was found. A card
 * ALWAYS leads with those structured facts (they're tiny) and then appends the
 * retrieved content, so the model can never omit who/when/what-was-decided.
 */

export interface KGLite {
  topics?: Array<{ name: string; summary?: string; status?: string }>;
  decisions?: Array<{ decision: string; relatedTopic?: string }>;
  action_items?: Array<{ task: string; owner?: string; relatedTopic?: string }>;
  people?: string[];
}

export interface EvidenceCardInput {
  title: string;
  createdAt?: string;
  attendees?: string[];
  kg?: KGLite | null;
  /** The retrieved body (transcript excerpt, notes, or summary). */
  content: string;
}

const OFF_TRACK = new Set(['off-track', 'off track', 'blocked', 'stalled', 'at-risk', 'at risk']);

export function formatMeetingDate(createdAt?: string): string {
  if (!createdAt) return 'unknown date';
  const d = new Date(createdAt);
  if (isNaN(d.getTime())) return 'unknown date';
  return d.toLocaleString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit' });
}

/** True if any KG topic for this meeting is flagged off-track / blocked. */
export function hasOffTrackTopic(kg?: KGLite | null): boolean {
  return !!kg?.topics?.some((t) => t.status && OFF_TRACK.has(t.status.toLowerCase()));
}

/**
 * Build a single meeting's structured evidence card. `header` is always present
 * (date + attendees + KG facts); `content` is appended when available.
 */
export function buildMeetingCard(input: EvidenceCardInput): string {
  const lines: string[] = [];
  lines.push(`### ${input.title} — ${formatMeetingDate(input.createdAt)}`);

  if (input.attendees?.length) {
    lines.push(`Attendees: ${input.attendees.join(', ')}`);
  }

  const kg = input.kg;
  if (kg) {
    if (kg.action_items?.length) {
      lines.push('Action items:');
      for (const a of kg.action_items.slice(0, 20)) {
        lines.push(`  • ${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}${a.relatedTopic ? ` [${a.relatedTopic}]` : ''}`);
      }
    }
    if (kg.decisions?.length) {
      lines.push('Decisions:');
      for (const d of kg.decisions.slice(0, 20)) lines.push(`  • ${d.decision}`);
    }
    const offTrack = (kg.topics ?? []).filter((t) => t.status && OFF_TRACK.has(t.status.toLowerCase()));
    if (offTrack.length) {
      lines.push('⚠️ Off-track topics:');
      for (const t of offTrack) lines.push(`  • ${t.name}${t.summary ? ` — ${t.summary.slice(0, 200)}` : ''}`);
    }
    if (kg.topics?.length) {
      const other = kg.topics.filter((t) => !(t.status && OFF_TRACK.has(t.status.toLowerCase()))).slice(0, 12);
      if (other.length) lines.push(`Topics: ${other.map((t) => `${t.name}${t.status ? ` (${t.status})` : ''}`).join(', ')}`);
    }
  }

  const body = (input.content || '').trim();
  if (body) {
    lines.push('---');
    lines.push(body);
  }
  return lines.join('\n');
}
