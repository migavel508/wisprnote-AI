import { query } from '../db';
import { insertEdge } from './brainEdges';

/**
 * BIND (Brain P1) — deterministic, LLM-FREE claim→edge binding.
 *
 * A biological brain binds at the moment of understanding: hearing "Sridhar will fix SCRUM-13 in
 * the repo" already ties person→task→tool. Our extraction (`kgExtract` → `knowledge_graph`) ALREADY
 * produces those claims — decisions, action_items, people, references — but the linker used to throw
 * them away and re-derive associations from embedding similarity. This turns the claims straight into
 * edges the instant a meeting is understood, so a ticket/commit connects to its source meeting
 * immediately — never "no links yet" — with a real reason, at $0. Semantic similarity is demoted to a
 * capped fallback (see brainLink) for items with no claim edge.
 */

const JIRA_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const ENTITY_CAP = 6;   // a common organiser must not wire a meeting to everything

export interface BindItem { id: string; source: string; source_id: string; type: string | null; title: string | null; body: string | null; people: any; space_id: string | null }
export interface BindResult { reference: number; entity: number; provenance: number }

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Pull every human-name string out of a `knowledge_item.people` jsonb, whatever its shape
 *  (meeting {attendees[]}, github {author, assignees[]}, jira {assignee, reporter}, …). */
function peopleNames(people: any): string[] {
  const out: string[] = [];
  const walk = (v: any) => {
    if (!v) return;
    if (typeof v === 'string') { const t = v.trim(); if (t && t.length <= 80) out.push(t); }
    else if (Array.isArray(v)) v.forEach(walk);
    else if (typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(people);
  return out;
}

// CF-6a — generic words that carry no identity for a meeting title. A title made ONLY of these is
// not distinctive enough to be a reliable back-reference needle ("Project Planning" would substring-
// match dozens of connector bodies → false provenance). We require ≥2 DISTINCTIVE tokens (or one long
// rare one) before trusting a title-in-body match.
const GENERIC_TITLE_WORDS = new Set([
  'project', 'planning', 'plan', 'meeting', 'sync', 'review', 'update', 'updates', 'discussion',
  'strategy', 'standup', 'call', 'weekly', 'daily', 'team', 'catch', 'up', 'alignment', 'status',
  'kickoff', 'kick', 'off', 'check', 'in', 'and', 'the', 'a', 'of', 'for', 'to', 'with', 'on',
  'session', 'notes', 'quick', 'general', 'monthly', 'biweekly', 'followup', 'follow', 'touch',
  'base', 'chat', 'talk', 'intro', 'introductory', 'overview', 'recap', 'debrief', 'brief', 'work',
]);

/** Is a meeting title distinctive enough to trust as a provenance back-reference needle? (CF-6a) */
function isDistinctiveTitle(title: string): boolean {
  const toks = norm(title).split(' ').filter(Boolean);
  const distinctive = toks.filter((t) => t.length >= 3 && !GENERIC_TITLE_WORDS.has(t));
  // ≥2 distinctive tokens, OR a single long rare token (e.g. a codename like "Nimbus", "Firmwhite").
  return distinctive.length >= 2 || distinctive.some((t) => t.length >= 8);
}

// CF-6b — match keys for a person name that BRIDGE the display-name ↔ login gap ("John Smith" in a
// meeting vs "jsmith" / "johnsmith" on a GitHub commit). Derived ONLY from BOTH name parts, never a
// bare first/last name — so recall rises without matching every "John" or every "Smith".
function nameLookupKeys(name: string): string[] {
  const n = norm(name);
  const keys = new Set<string>();
  if (n.length >= 3) keys.add(n);                       // full display form ("john smith", or a login)
  const toks = n.split(' ').filter(Boolean);
  if (toks.length >= 2) {
    const first = toks[0], last = toks[toks.length - 1];
    if (first.length >= 1 && last.length >= 2) {
      keys.add(first + last);                           // johnsmith
      keys.add(first[0] + last);                        // jsmith
      keys.add(last + first[0]);                        // smithj
    }
  }
  return [...keys];
}

/**
 * Bind ONE meeting to the connector items it names/shares-people-with, from its knowledge_graph
 * claims + the space's item index (pre-loaded, incl. `people`). Returns the set of target ids it
 * bound so the semantic pass can skip already-explained pairs. NO LLM, NO embeddings.
 */
export async function bindMeetingFromClaims(
  userId: string, workspaceId: string, spaceId: string | null,
  meetingItemId: string, meetingSourceId: string, meetingTitle: string | null, items: BindItem[],
): Promise<{ result: BindResult; bound: Set<string> }> {
  const result: BindResult = { reference: 0, entity: 0, provenance: 0 };
  const bound = new Set<string>();
  const byKey = new Map(items.map((i) => [`${i.source}:${i.source_id}`, String(i.id)]));
  const edge = (dstId: string, relation: string, origin: string, confidence: number, evidence: string) =>
    insertEdge({ userId, workspaceId, spaceId, srcKind: 'item', srcId: meetingItemId, dstKind: 'item', dstId, relation, origin, confidence, evidence });

  // 0) PROVENANCE (back-reference) — a connector item auto-created FROM this meeting quotes it in its
  //    body ("… from the meeting 'Q3 Roadmap Planning'"). This is the strongest signal for
  //    the tool-of-record a meeting spawned, and it survives resets (it lives on the item itself).
  const title = (meetingTitle || '').trim();
  // CF-6a: only trust the back-reference when the title is DISTINCTIVE — a generic title
  // ("Project Planning") would substring-match unrelated connector bodies and forge provenance.
  if (title.length >= 12 && isDistinctiveTitle(title)) {
    const needle = norm(title);
    for (const it of items) {
      if (it.source === 'meeting' || String(it.id) === meetingItemId) continue;
      const body = norm(it.body || '');
      if (body && body.includes(needle)) {
        if (await edge(String(it.id), 'spawned', 'provenance', 1.0, `from meeting "${title.slice(0, 60)}"`)) result.provenance++;
        bound.add(String(it.id));
      }
    }
  }

  const kg = await query<{ decisions: any; action_items: any; people: any; refs: any }>(
    `SELECT decisions, action_items, people, refs FROM knowledge_graph WHERE user_id=$1 AND task_id=$2 LIMIT 1`,
    [userId, meetingSourceId],
  ).then((r) => r[0]).catch(() => null);
  if (!kg) return { result, bound };

  // 1) REFERENCE — Jira keys named in the meeting's decisions / action items / refs → meeting→jira.
  const claimText = [
    ...(Array.isArray(kg.decisions) ? kg.decisions.map((d: any) => d?.decision || '') : []),
    ...(Array.isArray(kg.action_items) ? kg.action_items.map((a: any) => `${a?.task || ''} ${a?.owner || ''}`) : []),
    ...(Array.isArray(kg.refs) ? kg.refs.map((r: any) => String(r || '')) : []),
  ].join('  \n  ');
  const keysSeen = new Set<string>();
  for (const m of claimText.matchAll(JIRA_KEY)) {
    if (keysSeen.has(m[1])) continue; keysSeen.add(m[1]);
    const target = byKey.get(`jira:${m[1]}`);
    if (target && target !== meetingItemId && !bound.has(target)) {
      if (await edge(target, 'references', 'reference', 0.9, m[1])) result.reference++;
      bound.add(target);
    }
  }

  // 2) ENTITY (people) — a person named in the meeting who is the author/assignee of a CONNECTOR item
  //    → meeting↔item. Cross-source only (meeting↔meeting people-links over-connect); capped.
  const peopleIdx = new Map<string, Set<string>>();
  for (const it of items) {
    if (it.source === 'meeting') continue;
    for (const nm of peopleNames(it.people)) {
      const k = norm(nm); if (k.length < 3) continue;
      (peopleIdx.get(k) ?? peopleIdx.set(k, new Set()).get(k)!).add(String(it.id));
    }
  }
  let ent = 0;
  for (const p of (Array.isArray(kg.people) ? kg.people : [])) {
    if (ent >= ENTITY_CAP) break;
    if (norm(String(p || '')).length < 3) continue;
    // CF-6b: match on the full name AND its login variants, so "John Smith" in the meeting binds a
    // commit authored by "jsmith"/"johnsmith". Union the targets across all variant keys.
    const targets = new Set<string>();
    for (const key of nameLookupKeys(String(p || ''))) for (const tid of (peopleIdx.get(key) ?? [])) targets.add(tid);
    for (const tid of targets) {
      if (ent >= ENTITY_CAP) break;
      if (tid === meetingItemId || bound.has(tid)) continue;
      if (await edge(tid, 'people', 'entity', 0.75, String(p))) { result.entity++; ent++; bound.add(tid); }
    }
  }

  return { result, bound };
}

/**
 * Backfill: bind EVERY meeting in a space from its claims. One item load, one kg read per meeting,
 * all deterministic. Reuses `insertEdge` (idempotent + same-space guarded), so it's safe to re-run
 * and rebuilds a space's claim-edges at $0. Called by the `brain-bind` job.
 */
export async function bindSpace(spaceId: string): Promise<{ meetings: number; provenance: number; reference: number; entity: number }> {
  const items = await query<BindItem & { user_id: string; workspace_id: string }>(
    `SELECT id, user_id, workspace_id, source, source_id, type, title, body, people, space_id
       FROM knowledge_item WHERE space_id=$1`, [spaceId],
  ).catch(() => []);
  const agg = { meetings: 0, provenance: 0, reference: 0, entity: 0 };
  const meetings = items.filter((i) => i.source === 'meeting');
  for (const m of meetings) {
    const { result } = await bindMeetingFromClaims(
      m.user_id, m.workspace_id, m.space_id, String(m.id), m.source_id, m.title, items,
    );
    agg.meetings++; agg.provenance += result.provenance; agg.reference += result.reference; agg.entity += result.entity;
  }
  return agg;
}

/**
 * EVENT-FIRST bind (Brain P2): bind every space that received new data in the last `sinceMinutes`.
 * Called at the tail of connector-sync so a freshly-arrived ticket/commit weaves into its meetings
 * in the SAME ingest operation — not on a downstream cron. Bounded + $0. (bindSpace re-binds ALL of a
 * space's meetings, so it catches a new item that references an already-linked meeting.)
 */
export async function bindActiveSpaces(sinceMinutes = 30, cap = 25): Promise<{ spaces: number; provenance: number; reference: number; entity: number }> {
  const rows = await query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM knowledge_item
      WHERE space_id IS NOT NULL AND synced_at > NOW() - ($1 || ' minutes')::interval
      LIMIT ${cap}`, [String(sinceMinutes)],
  ).catch(() => []);
  const agg = { spaces: 0, provenance: 0, reference: 0, entity: 0 };
  for (const r of rows) {
    const b = await bindSpace(r.space_id).catch(() => null);
    if (b) { agg.spaces++; agg.provenance += b.provenance; agg.reference += b.reference; agg.entity += b.entity; }
  }
  return agg;
}
