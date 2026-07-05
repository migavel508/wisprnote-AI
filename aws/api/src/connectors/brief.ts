import { query, queryOne } from '../db';
import { ACCOUNT_SCOPE } from './schema';

/**
 * SPACE BRIEF (Brain D-1) — the CHIEF-OF-STAFF memo. The graph + thread ledger made the brain
 * *inspectable*; the brief makes it *useful*. It is the standing artifact a chief of staff would hand
 * you when you walk in: what happened lately, what MOVED, what's open and SLIPPING, what the code
 * shows, and what's untracked — assembled per space, refreshed on the threads cron, read by the UI
 * and the chat `brain_brief` tool.
 *
 * ACCURACY (D-7): the brief is built ONLY from CONFIRMED evidence — the thread ledger (already
 * confirmed-only after CF-5), status-change events, and item counts. Every number is grounded in a
 * real row, so any sentence is traceable. The deterministic tier below is $0 and always available;
 * an LLM polish tier (later, credit-gated) turns the skeleton into prose WITHOUT inventing facts.
 */

let ready: Promise<void> | null = null;
export function ensureBriefSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS space_brief (
          space_id UUID PRIMARY KEY,
          user_id UUID,
          workspace_id UUID,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          sections JSONB NOT NULL,        -- structured skeleton (grounded counts + evidence ids)
          narrative TEXT                  -- human sentences (deterministic now; LLM-polished later)
        )`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const WINDOW_DAYS = 7;
const daysSince = (t: string | null): number | null => (t ? (Date.now() - new Date(t).getTime()) / 86_400_000 : null);
const plural = (n: number, s: string): string => `${n} ${s}${n === 1 ? '' : 's'}`;

export interface SpaceBrief { spaceId: string; generatedAt: string; sections: any; narrative: string }

/**
 * Build/refresh one space's brief, deterministically ($0). Idempotent (upsert). Reads the thread
 * ledger + recent events + item counts; produces grounded sections + a narrative. Skips the sentinel.
 */
export async function buildSpaceBrief(spaceId: string): Promise<SpaceBrief | null> {
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return null;
  await ensureBriefSchema();

  // Space identity + owning ids (from any item in the space).
  const meta = await queryOne<{ user_id: string; workspace_id: string; name: string | null }>(
    `SELECT ki.user_id, ki.workspace_id,
            (SELECT s.name FROM spaces s WHERE s.id=$1) AS name
       FROM knowledge_item ki WHERE ki.space_id=$1 LIMIT 1`, [spaceId],
  ).catch(() => null);
  if (!meta) return null;
  const name = meta.name || 'this project';

  // 1) THREAD LEDGER — the work-state backbone (already confirmed-evidence only after CF-5).
  const threads = await query<any>(
    `SELECT kind, anchor_source, anchor_source_id, title, state, last_advanced_at, opened_at, evidence
       FROM brain_thread WHERE space_id=$1`, [spaceId],
  ).catch(() => []);
  const tickets = threads.filter((t: any) => t.kind === 'ticket');
  const gaps = threads.filter((t: any) => t.kind === 'gap');
  const topics = threads.filter((t: any) => t.kind === 'topic');   // D-2: meeting↔meeting conversations
  const byState = (arr: any[], s: string) => arr.filter((t: any) => t.state === s).length;

  // ATTENTION — most-attention-first: stale tickets (SLIPPING) then untracked gap meetings. Each
  // carries a grounded "why" + how long it's been idle. This is the heart of the brief.
  // A readable label: the ticket key when short (PROJ-14), else the item title (gap meetings are
  // anchored on a UUID, so the id is not human-readable — use the title).
  const labelOf = (id: string, title: string) => (id && id.length < 20 ? id : (title || '').slice(0, 70));
  const attention = [
    ...tickets.filter((t: any) => t.state === 'stale').map((t: any) => {
      const idle = daysSince(t.last_advanced_at);
      return { id: t.anchor_source_id, title: (t.title || '').slice(0, 100), label: labelOf(t.anchor_source_id, t.title), kind: 'ticket',
        why: `stalled — status "${t.evidence?.status || '?'}", no movement${idle != null ? ` in ${Math.floor(idle)}d` : ''}`,
        idleDays: idle != null ? Math.floor(idle) : null };
    }),
    ...gaps.filter((g: any) => g.state === 'stale' || g.state === 'open').map((g: any) => {
      const n = g.evidence?.actionCount || 0;
      return { id: g.anchor_source_id, title: (g.title || '').slice(0, 100), label: labelOf(g.anchor_source_id, g.title), kind: 'gap',
        why: `untracked — ${plural(n, 'commitment')} never ticketed`,
        idleDays: g.opened_at != null ? Math.floor(daysSince(g.opened_at) ?? 0) : null };
    }),
    // Off-track recurring conversations — a topic discussed across meetings but still unresolved.
    ...topics.filter((t: any) => t.state === 'stale').map((t: any) => ({
      id: t.anchor_source_id, title: (t.title || '').slice(0, 100), label: (t.title || '').slice(0, 70), kind: 'topic',
      why: `unresolved conversation — discussed in ${plural(t.evidence?.meetingCount || 0, 'meeting')}, latest "${t.evidence?.latestStatus || '?'}"`,
      idleDays: t.last_advanced_at != null ? Math.floor(daysSince(t.last_advanced_at) ?? 0) : null })),
  ].sort((a, b) => (b.idleDays ?? 0) - (a.idleDays ?? 0)).slice(0, 8);

  const advancing = tickets.filter((t: any) => t.state === 'advancing')
    .map((t: any) => ({ id: t.anchor_source_id, title: (t.title || '').slice(0, 100),
      confirmedCommits: (t.evidence?.commits || []).length, relatedCommits: Number(t.evidence?.relatedCommits) || 0 }));

  // 2) MOMENTUM — what actually MOVED in the window (confirmed status changes + new commits).
  const moved = await query<any>(
    `SELECT kind, source, source_id, from_state, to_state, title, occurred_at
       FROM brain_event
      WHERE space_id=$1 AND occurred_at > NOW() - ($2 || ' days')::interval
      ORDER BY occurred_at DESC LIMIT 12`, [spaceId, String(WINDOW_DAYS)],
  ).catch(() => []);
  const statusMoves = moved.filter((e: any) => e.kind === 'status_change')
    .map((e: any) => ({ id: e.source_id, title: (e.title || '').slice(0, 80), from: e.from_state, to: e.to_state }));
  const newCommits = moved.filter((e: any) => e.source === 'github').length;

  // 3) INVENTORY — grounded counts by source + what's newly ingested in the window.
  const inv = await query<any>(
    `SELECT source, COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE synced_at > NOW() - ($2 || ' days')::interval)::int AS recent
       FROM knowledge_item WHERE space_id=$1 GROUP BY source`, [spaceId, String(WINDOW_DAYS)],
  ).catch(() => []);
  const invBy = Object.fromEntries(inv.map((r: any) => [r.source, { total: r.total, recent: r.recent }]));

  const sections = {
    space: { id: spaceId, name },
    generatedFor: `last ${WINDOW_DAYS} days`,
    pm: { totalTickets: tickets.length, advancing: byState(tickets, 'advancing'), open: byState(tickets, 'open'),
          stale: byState(tickets, 'stale'), resolved: byState(tickets, 'resolved') },
    momentum: { statusMoves, newCommits, movedCount: statusMoves.length + newCommits },
    attention,
    advancing,
    untracked: { count: gaps.filter((g: any) => g.state !== 'resolved').length,
                 items: gaps.filter((g: any) => g.state !== 'resolved').slice(0, 8).map((g: any) => ({ meeting: (g.title || '').slice(0, 90), commitments: g.evidence?.actionCount || 0 })) },
    // D-2: the meeting↔meeting story — recurring topics + their trail. Unresolved ones lead.
    conversations: { total: topics.length,
      unresolved: topics.filter((t: any) => t.state !== 'resolved')
        .sort((a: any, b: any) => (b.evidence?.meetingCount || 0) - (a.evidence?.meetingCount || 0))
        .slice(0, 6).map((t: any) => ({ topic: (t.title || '').slice(0, 80), meetings: t.evidence?.meetingCount || 0, latest: t.evidence?.latestStatus || '?' })) },
    engineering: { commitsTracked: invBy.github?.total || 0, commitsRecent: invBy.github?.recent || 0 },
    inventory: invBy,
  };

  const narrative = renderNarrative(name, sections);

  await query(
    `INSERT INTO space_brief (space_id, user_id, workspace_id, generated_at, sections, narrative)
     VALUES ($1,$2,$3,NOW(),$4,$5)
     ON CONFLICT (space_id) DO UPDATE SET user_id=EXCLUDED.user_id, workspace_id=EXCLUDED.workspace_id,
       generated_at=NOW(), sections=EXCLUDED.sections, narrative=EXCLUDED.narrative`,
    [spaceId, meta.user_id, meta.workspace_id, JSON.stringify(sections), narrative],
  ).catch(() => {});

  return { spaceId, generatedAt: new Date().toISOString(), sections, narrative };
}

/**
 * DETERMINISTIC narrative — a chief-of-staff paragraph assembled ONLY from grounded skeleton numbers.
 * No invention: every clause maps to a count/id above (D-7). The LLM polish tier will later rewrite
 * THIS text into smoother prose under the same no-invention rule; until then this ships at $0.
 */
function renderNarrative(name: string, s: any): string {
  const parts: string[] = [];
  const pm = s.pm;
  if (pm.totalTickets > 0) {
    const bits = [pm.advancing && `${pm.advancing} advancing`, pm.open && `${pm.open} open`, pm.stale && `${pm.stale} slipping`, pm.resolved && `${pm.resolved} resolved`].filter(Boolean);
    parts.push(`${name} is tracking ${plural(pm.totalTickets, 'ticket')}${bits.length ? ` — ${bits.join(', ')}` : ''}.`);
  } else {
    parts.push(`${name} has no tracked tickets yet.`);
  }
  if (s.momentum.movedCount > 0) {
    const mv = s.momentum.statusMoves.slice(0, 3).map((m: any) => `${m.id} → ${m.to || '?'}`).join(', ');
    parts.push(`In the last ${WINDOW_DAYS} days: ${s.momentum.statusMoves.length ? `${plural(s.momentum.statusMoves.length, 'status change')} (${mv})` : 'no status changes'}${s.momentum.newCommits ? `, ${plural(s.momentum.newCommits, 'new commit')}` : ''}.`);
  } else {
    parts.push(`Nothing moved in the last ${WINDOW_DAYS} days.`);
  }
  if (s.attention.length) {
    const top = s.attention[0];
    parts.push(`${plural(s.attention.length, 'item')} need${s.attention.length === 1 ? 's' : ''} attention — the most urgent is ${top.label} (${top.why}).`);
  } else {
    parts.push('Nothing is currently slipping.');
  }
  if (s.untracked.count > 0) parts.push(`${plural(s.untracked.count, 'meeting commitment')} were made but never ticketed.`);
  if (s.conversations?.unresolved?.length) {
    const top = s.conversations.unresolved[0];
    parts.push(`${plural(s.conversations.unresolved.length, 'recurring topic')} ${s.conversations.unresolved.length === 1 ? 'is' : 'are'} still open across meetings — notably "${top.topic}" (discussed in ${plural(top.meetings, 'meeting')}, latest "${top.latest}").`);
  }
  if (s.engineering.commitsRecent > 0) parts.push(`${plural(s.engineering.commitsRecent, 'commit')} landed recently (${s.engineering.commitsTracked} tracked total).`);
  else if (s.engineering.commitsTracked > 0) parts.push(`No confirmed code activity in the window (${s.engineering.commitsTracked} commits tracked overall).`);
  return parts.join(' ');
}

/** Read a space's stored brief (for the UI / chat tool). Null if never built. */
export async function getSpaceBrief(spaceId: string): Promise<SpaceBrief | null> {
  await ensureBriefSchema();
  const r = await queryOne<any>(
    `SELECT space_id, generated_at, sections, narrative FROM space_brief WHERE space_id=$1`, [spaceId],
  ).catch(() => null);
  if (!r) return null;
  return { spaceId: r.space_id, generatedAt: r.generated_at, sections: r.sections, narrative: r.narrative };
}

/** Build briefs for every real space (the threads-cron tail). Bounded by cap + time budget. */
export async function buildAllSpaceBriefs(cap = 200, timeBudgetMs = 60_000): Promise<{ spaces: number }> {
  await ensureBriefSchema();
  const started = Date.now();
  const rows = await query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM brain_thread WHERE space_id IS NOT NULL AND space_id <> $1 LIMIT ${cap}`,
    [ACCOUNT_SCOPE],
  ).catch(() => []);
  let spaces = 0;
  for (const r of rows) {
    if (Date.now() - started > timeBudgetMs) break;
    const b = await buildSpaceBrief(r.space_id).catch(() => null);
    if (b) spaces++;
  }
  console.log('brain_brief_all', JSON.stringify({ spaces }));
  return { spaces };
}
