import { query } from '../db';
import { insertProposal } from './proposals';
import { insertEdge } from './brainEdges';
import { ACCOUNT_SCOPE } from './schema';

// Only these edge origins are TRUSTED evidence. A 'semantic' edge is a similarity GUESS — it must
// never count as a confirmed commit/meeting on a thread (that is how "SCRUM-14 · 7 commits" became
// false), and it must never silence a gap. Confidence propagates: confirmed = fact, semantic = maybe.
const CONFIRMED_ORIGINS = `('provenance','reference','entity','llm','topic')`;

/**
 * THREAD LEDGER (Brain P3) — the brain's WORKING MEMORY.
 *
 * A biological brain holds unfinished business as an active, nagging representation (the Zeigarnik
 * effect) until it's resolved, and tests every new input against it. Our brain stored items + edges
 * but never the *state of the work itself*. A THREAD is a piece of work moving through tools over
 * time — anchored (for now) on a Jira ticket, with a derived lifecycle state and its evidence trail
 * (the meeting that spawned it + the commits implementing it). This is what lets the brain answer the
 * chief-of-staff questions: what's open, what's advancing, what's resolved, and what's SLIPPING.
 *
 * Fully DETERMINISTIC + $0 — state is derived from status + linked code + recency, no LLM.
 */

let ready: Promise<void> | null = null;
export function ensureThreadSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS brain_thread (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          space_id UUID NOT NULL,
          kind TEXT NOT NULL,                 -- 'ticket' (P3.1) · later 'decision' | 'action'
          anchor_source TEXT NOT NULL,        -- 'jira' | 'meeting'
          anchor_source_id TEXT NOT NULL,     -- 'SCRUM-13' | meeting id
          title TEXT,
          state TEXT NOT NULL,                -- 'open' | 'advancing' | 'resolved' | 'stale'
          opened_at TIMESTAMPTZ,
          last_advanced_at TIMESTAMPTZ,
          evidence JSONB,                     -- { status, commits[], meetings[] }
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (space_id, kind, anchor_source, anchor_source_id)
        )`);
      await query(`CREATE INDEX IF NOT EXISTS brain_thread_space_idx ON brain_thread (space_id, state)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const DONEISH = /done|closed|resolved|complete|shipped|merged|cancel/i;
const ADVANCING = /progress|review|qa|verify|staging|testing|doing/i;
const STALE_DAYS = 7;

export interface ThreadRow {
  kind: string; anchor_source: string; anchor_source_id: string; title: string | null;
  state: string; opened_at: string | null; last_advanced_at: string | null; evidence: any;
}

export interface ThreadBuildResult { threads: number; open: number; advancing: number; resolved: number; stale: number; gaps: number; topics: number }

/** Build/refresh every Jira ticket's thread for a space, deterministically. Idempotent (upsert). */
export async function buildSpaceThreads(spaceId: string): Promise<ThreadBuildResult> {
  await ensureThreadSchema();
  // CF-1: never build a ledger for the sentinel/unscoped bucket — it is not a real space, and its
  // account-scope leftovers (e.g. duplicated Jira rows) would surface as GHOST/duplicate threads.
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { threads: 0, open: 0, advancing: 0, resolved: 0, stale: 0, gaps: 0, topics: 0 };
  // CF-5: evidence is split into CONFIRMED (claims/verdict — counted as fact) and RELATED (semantic
  // guesses — kept separately, shown only as a hedged "possibly related"). The state machine and the
  // "N commits" a user sees are driven by confirmed evidence ONLY.
  const tickets = await query<any>(
    `SELECT ji.id, ji.user_id, ji.workspace_id, ji.space_id, ji.source_id, ji.title, ji.status, ji.occurred_at,
            (SELECT max(e.occurred_at) FROM brain_event e
               WHERE e.space_id=ji.space_id AND e.source='jira' AND e.source_id=ji.source_id) AS last_event,
            (SELECT array_agg(DISTINCT o.source_id) FROM brain_edge be
               JOIN knowledge_item o ON o.id::text = (CASE WHEN be.src_id=ji.id::text THEN be.dst_id ELSE be.src_id END)
              WHERE be.space_id=ji.space_id AND (be.src_id=ji.id::text OR be.dst_id=ji.id::text)
                AND be.origin IN ${CONFIRMED_ORIGINS} AND o.source='github') AS commits,
            (SELECT COUNT(DISTINCT o.id) FROM brain_edge be
               JOIN knowledge_item o ON o.id::text = (CASE WHEN be.src_id=ji.id::text THEN be.dst_id ELSE be.src_id END)
              WHERE be.space_id=ji.space_id AND (be.src_id=ji.id::text OR be.dst_id=ji.id::text)
                AND be.origin='semantic' AND o.source='github') AS related_commits,
            (SELECT array_agg(DISTINCT o.title) FROM brain_edge be
               JOIN knowledge_item o ON o.id::text = (CASE WHEN be.src_id=ji.id::text THEN be.dst_id ELSE be.src_id END)
              WHERE be.space_id=ji.space_id AND (be.src_id=ji.id::text OR be.dst_id=ji.id::text)
                AND be.origin IN ${CONFIRMED_ORIGINS} AND o.source='meeting') AS meetings
       FROM knowledge_item ji
      WHERE ji.space_id=$1 AND ji.source='jira'
      GROUP BY ji.id`,
    [spaceId],
  ).catch(() => []);

  const agg: ThreadBuildResult = { threads: 0, open: 0, advancing: 0, resolved: 0, stale: 0, gaps: 0, topics: 0 };
  for (const t of tickets) {
    const status = String(t.status || '');
    const commits = (Array.isArray(t.commits) ? t.commits : []).filter(Boolean);
    const meetings = (Array.isArray(t.meetings) ? t.meetings : []).filter(Boolean);
    const relatedCommits = parseInt(t.related_commits, 10) || 0;   // 'possible' — never proves advancement
    let state: 'open' | 'advancing' | 'resolved' | 'stale';
    if (DONEISH.test(status)) state = 'resolved';
    // 'advancing' now requires CONFIRMED commits (or an in-progress status) — a semantic guess no
    // longer flips a ticket to "someone started coding" when nobody did (CF-5).
    else if (ADVANCING.test(status) || commits.length > 0) state = 'advancing';
    else state = 'open';
    const lastMove = t.last_event || t.occurred_at || null;
    if (state !== 'resolved' && lastMove) {
      const days = (Date.now() - new Date(lastMove).getTime()) / 86_400_000;
      if (days > STALE_DAYS) state = 'stale';   // open/advancing + idle → SLIPPING
    }
    await query(
      `INSERT INTO brain_thread (user_id, workspace_id, space_id, kind, anchor_source, anchor_source_id, title, state, opened_at, last_advanced_at, evidence, updated_at)
       VALUES ($1,$2,$3,'ticket','jira',$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (space_id, kind, anchor_source, anchor_source_id) DO UPDATE SET
         title=EXCLUDED.title, state=EXCLUDED.state, last_advanced_at=EXCLUDED.last_advanced_at,
         evidence=EXCLUDED.evidence, updated_at=NOW()`,
      [t.user_id, t.workspace_id, t.space_id, t.source_id, t.title, state, t.occurred_at, lastMove, JSON.stringify({ status, commits, meetings, relatedCommits })],
    ).catch(() => {});
    agg.threads++; agg[state]++;
  }

  // GAP THREADS (Brain P3.2) — the "decided, but nothing happened" open loop: a meeting that made
  // commitments (action_items / decisions) yet spawned NO Jira ticket. This is the strongest off-track
  // signal a brain can hold — a human who ran that meeting would keep nagging until it's tracked.
  const gapMeetings = await query<any>(
    `SELECT m.id, m.user_id, m.workspace_id, m.space_id, m.source_id, m.title, m.occurred_at,
            jsonb_array_length(COALESCE(kg.action_items, '[]'::jsonb)) AS ai,
            jsonb_array_length(COALESCE(kg.decisions, '[]'::jsonb)) AS dec,
            EXISTS (SELECT 1 FROM brain_edge e
                      JOIN knowledge_item ji ON ji.id::text = (CASE WHEN e.src_id=m.id::text THEN e.dst_id ELSE e.src_id END)
                     WHERE e.space_id=m.space_id AND (e.src_id=m.id::text OR e.dst_id=m.id::text)
                       AND e.origin IN ${CONFIRMED_ORIGINS} AND ji.source='jira') AS has_ticket
       FROM knowledge_item m
       JOIN knowledge_graph kg ON kg.task_id::text = m.source_id AND kg.user_id = m.user_id
      WHERE m.space_id=$1 AND m.source='meeting'
        AND (jsonb_array_length(COALESCE(kg.action_items, '[]'::jsonb)) > 0 OR jsonb_array_length(COALESCE(kg.decisions, '[]'::jsonb)) > 0)`,
    [spaceId],
  ).catch(() => []);
  for (const m of gapMeetings) {
    // Tracked (has a ticket) → the gap is resolved; else open, or stale if the meeting is >7d old.
    let state: 'open' | 'resolved' | 'stale';
    if (m.has_ticket) state = 'resolved';
    else if (m.occurred_at && (Date.now() - new Date(m.occurred_at).getTime()) / 86_400_000 > STALE_DAYS) state = 'stale';
    else state = 'open';
    await query(
      `INSERT INTO brain_thread (user_id, workspace_id, space_id, kind, anchor_source, anchor_source_id, title, state, opened_at, last_advanced_at, evidence, updated_at)
       VALUES ($1,$2,$3,'gap','meeting',$4,$5,$6,$7,$7,$8,NOW())
       ON CONFLICT (space_id, kind, anchor_source, anchor_source_id) DO UPDATE SET
         title=EXCLUDED.title, state=EXCLUDED.state, evidence=EXCLUDED.evidence, updated_at=NOW()`,
      [m.user_id, m.workspace_id, m.space_id, m.source_id, m.title, state, m.occurred_at, JSON.stringify({ actionCount: m.ai, decisionCount: m.dec })],
    ).catch(() => {});
    if (state !== 'resolved') agg.gaps++;
  }

  // TOPIC threads (D-2) — the meeting↔meeting conversation story, from topics already extracted ($0).
  const topics = await buildSpaceTopics(spaceId).catch(() => ({ topics: 0, offTrack: 0, topicEdges: 0 }));
  agg.topics = topics.topics;
  return agg;
}

// TOPIC threads normalize a topic name for cross-meeting grouping: lowercase, punctuation→space,
// collapse whitespace. DETERMINISTIC on purpose (no embeddings = $0 + no false merges) — "SDLC
// Planning" and "SDLC planning" merge; "SDLC plan" stays separate (accuracy over recall).
const normTopic = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const TOPIC_MIN_MEETINGS = 2;   // a "thread" is CONTINUITY — a topic in ≥2 meetings; one-offs aren't threads
const TOPIC_CAP = 120;          // most-discussed topics per space (bound the ledger)

/**
 * TOPIC THREADS (Brain D-2) — the MEETING↔MEETING story. Ticket threads track work; topic threads
 * track the CONVERSATION: a subject discussed across multiple meetings, with a derived state from its
 * status trail ("SDLC planning — 6 meetings over 3 weeks, still unresolved"). Fully DETERMINISTIC +
 * $0: it reads the topics kgExtract ALREADY produced (name/status per meeting) — no new LLM or
 * embedding calls. This is the continuity layer the graph never had.
 */
export async function buildSpaceTopics(spaceId: string): Promise<{ topics: number; offTrack: number; topicEdges: number }> {
  await ensureThreadSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { topics: 0, offTrack: 0, topicEdges: 0 };
  // Unnest every meeting's extracted topics in the space (topics already exist — $0).
  const rows = await query<any>(
    `SELECT m.user_id, m.workspace_id, m.id AS item_id, m.space_id, m.source_id AS meeting_id, m.title AS meeting_title, m.occurred_at,
            t->>'name' AS topic, lower(COALESCE(t->>'status','')) AS status, t->>'summary' AS summary
       FROM knowledge_item m
       JOIN knowledge_graph kg ON kg.task_id::text = m.source_id AND kg.user_id = m.user_id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(kg.topics, '[]'::jsonb)) t
      WHERE m.space_id=$1 AND m.source='meeting' AND COALESCE(t->>'name','') <> ''`,
    [spaceId],
  ).catch(() => []);
  if (!rows.length) return { topics: 0, offTrack: 0, topicEdges: 0 };

  // Group mentions by normalized topic key.
  const groups = new Map<string, { display: string; mentions: any[] }>();
  for (const r of rows) {
    const key = normTopic(r.topic);
    if (!key) continue;
    let g = groups.get(key);
    if (!g) { g = { display: String(r.topic).trim(), mentions: [] }; groups.set(key, g); }
    g.mentions.push(r);
  }
  // Only RECURRING topics become threads; take the most-discussed, bounded.
  const recurring = [...groups.entries()]
    .filter(([, g]) => new Set(g.mentions.map((m) => m.meeting_id)).size >= TOPIC_MIN_MEETINGS)
    .sort((a, b) => b[1].mentions.length - a[1].mentions.length)
    .slice(0, TOPIC_CAP);

  let offTrack = 0; let topicEdges = 0;
  const TOPIC_EDGES_PER_TOPIC = 4;   // bound: connect a topic's first few meetings, never a full clique
  for (const [key, g] of recurring) {
    const sorted = [...g.mentions].sort((a, b) => new Date(a.occurred_at || 0).getTime() - new Date(b.occurred_at || 0).getTime());
    // TOPIC EDGES — connect the meetings that share this recurring topic as a temporal CHAIN, so the
    // map shows meeting↔meeting continuity ("this subject carried from meeting A to B"). CONFIRMED tier
    // (origin='topic' — a real shared subject, not a similarity guess), so it survives semantic cleanup
    // and counts as evidence. This is what reduces the "disconnected meeting nodes" honestly.
    {
      const seen = new Set<string>(); const chain: any[] = [];
      for (const m of sorted) { const id = String(m.item_id); if (id && !seen.has(id)) { seen.add(id); chain.push(m); } }
      const sp = chain[0]?.space_id ?? spaceId;
      for (let i = 1; i < chain.length && i <= TOPIC_EDGES_PER_TOPIC; i++) {
        const a = chain[i - 1], b = chain[i];
        if (await insertEdge({ userId: a.user_id, workspaceId: a.workspace_id, spaceId: sp, srcKind: 'item', srcId: String(a.item_id), dstKind: 'item', dstId: String(b.item_id), relation: 'related', origin: 'topic', confidence: 0.85, evidence: `shared topic: ${g.display.slice(0, 60)}` })) topicEdges++;
      }
    }
    const latest = sorted[sorted.length - 1];
    const latestStatus = latest.status || 'new';
    const lastAt = latest.occurred_at || null;
    const meetings = [...new Set(sorted.map((m) => m.meeting_title).filter(Boolean))];
    const idle = lastAt ? (Date.now() - new Date(lastAt).getTime()) / 86_400_000 : null;
    // State: resolved (latest resolved) · stale (latest off-track OR idle >7d) · advancing (actively
    // revisited/ongoing) · open (new/undetermined). off-track/stale is the attention signal.
    let state: 'open' | 'advancing' | 'resolved' | 'stale';
    if (latestStatus === 'resolved') state = 'resolved';
    else if (latestStatus === 'off-track' || (idle != null && idle > STALE_DAYS)) state = 'stale';
    else if (latestStatus === 'ongoing' || latestStatus === 'revisited') state = 'advancing';
    else state = 'open';
    if (state === 'stale') offTrack++;
    await query(
      `INSERT INTO brain_thread (user_id, workspace_id, space_id, kind, anchor_source, anchor_source_id, title, state, opened_at, last_advanced_at, evidence, updated_at)
       VALUES ($1,$2,$3,'topic','topic',$4,$5,$6,$7,$8,$9,NOW())
       ON CONFLICT (space_id, kind, anchor_source, anchor_source_id) DO UPDATE SET
         title=EXCLUDED.title, state=EXCLUDED.state, last_advanced_at=EXCLUDED.last_advanced_at,
         evidence=EXCLUDED.evidence, updated_at=NOW()`,
      [g.mentions[0].user_id, g.mentions[0].workspace_id, spaceId, key, g.display.slice(0, 120), state,
       sorted[0].occurred_at || null, lastAt,
       JSON.stringify({ meetingCount: meetings.length, mentions: g.mentions.length, latestStatus,
                        meetings: meetings.slice(0, 8), summary: (latest.summary || '').slice(0, 200) })],
    ).catch(() => {});
  }
  return { topics: recurring.length, offTrack, topicEdges };
}

const normEntity = (s: string): string => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().replace(/\s+/g, ' ');
const ENTITY_MIN_MEETINGS = 2;   // an entity shared by ≥2 meetings can connect them
const ENTITY_MAX_MEETINGS = 5;   // …but skip entities in >5 meetings (a whole-team attendee / generic
                                 // topic = too common → would hairball). Rarity = distinctiveness.
const ENTITY_EDGES_PER_MEETING = 3;   // cap each meeting's entity links → a web, never a hairball

/**
 * ENTITY LINKS — connect meetings that share a DISTINCTIVE named entity (a client/project/person that
 * appears in only a FEW meetings), so meetings about the same subject cluster instead of floating
 * isolated. Rarity-filtered (skip entities in >5 meetings) + degree-capped so it never becomes the old
 * similarity hairball. CONFIRMED tier (origin='entity' — a real shared entity, not a guess), $0.
 */
export async function buildSpaceEntityLinks(spaceId: string): Promise<{ entityEdges: number }> {
  await ensureThreadSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { entityEdges: 0 };
  const rows = await query<any>(
    `SELECT m.id AS item_id, m.user_id, m.workspace_id, m.space_id, m.occurred_at,
            kg.people, kg.topics, kg.decisions
       FROM knowledge_item m
       JOIN knowledge_graph kg ON kg.task_id::text = m.source_id AND kg.user_id = m.user_id
      WHERE m.space_id=$1 AND m.source='meeting'`, [spaceId],
  ).catch(() => []);
  if (rows.length < 2) return { entityEdges: 0 };

  // entity key → meetings that mention it (people names + topic names + decision "relatedTopic").
  const byEntity = new Map<string, any[]>();
  const addEntity = (key: string, m: any) => { if (key.length < 4) return; (byEntity.get(key) ?? byEntity.set(key, []).get(key)!).push(m); };
  for (const m of rows) {
    const ents = new Set<string>();
    for (const p of (Array.isArray(m.people) ? m.people : [])) ents.add(normEntity(String(p)));
    for (const t of (Array.isArray(m.topics) ? m.topics : [])) { if (t?.name) ents.add(normEntity(String(t.name))); }
    for (const d of (Array.isArray(m.decisions) ? m.decisions : [])) { if (d?.relatedTopic) ents.add(normEntity(String(d.relatedTopic))); }
    for (const e of ents) addEntity(e, m);
  }

  const degree = new Map<string, number>();   // per-meeting entity-edge count (cap → no hairball)
  let entityEdges = 0;
  // Distinctive entities first (fewest meetings = most specific), so caps go to the strongest signals.
  const distinctive = [...byEntity.entries()]
    .filter(([, ms]) => { const u = new Set(ms.map((x) => String(x.item_id))); return u.size >= ENTITY_MIN_MEETINGS && u.size <= ENTITY_MAX_MEETINGS; })
    .sort((a, b) => a[1].length - b[1].length);
  const repOf = new Map<string, any>();   // entity → its earliest meeting (a stable cluster anchor)
  for (const [key, ms] of distinctive) {
    const uniq = [...new Map(ms.map((x) => [String(x.item_id), x])).values()]
      .sort((a, b) => new Date(a.occurred_at || 0).getTime() - new Date(b.occurred_at || 0).getTime());
    repOf.set(key, uniq[0]);
    for (let i = 1; i < uniq.length; i++) {   // temporal chain among the entity's meetings
      const a = uniq[i - 1], b = uniq[i];
      if ((degree.get(String(a.item_id)) ?? 0) >= ENTITY_EDGES_PER_MEETING || (degree.get(String(b.item_id)) ?? 0) >= ENTITY_EDGES_PER_MEETING) continue;
      if (await insertEdge({ userId: a.user_id, workspaceId: a.workspace_id, spaceId: a.space_id ?? spaceId, srcKind: 'item', srcId: String(a.item_id), dstKind: 'item', dstId: String(b.item_id), relation: 'related', origin: 'entity', confidence: 0.8, evidence: `shared: ${key.slice(0, 50)}` })) {
        entityEdges++; degree.set(String(a.item_id), (degree.get(String(a.item_id)) ?? 0) + 1); degree.set(String(b.item_id), (degree.get(String(b.item_id)) ?? 0) + 1);
      }
    }
  }

  // Connect NON-meeting items (jira/github) to a meeting cluster when their text NAMES a distinctive
  // entity — a ticket about "New Mountain Capital" joins the NMC meetings. Key length ≥6 + rarity filter
  // keep it specific (no linking on generic words); capped per item. Cross-source, CONFIRMED tier.
  const keys = [...repOf.keys()].filter((k) => k.length >= 6).sort((a, b) => b.length - a.length);
  if (keys.length) {
    const others = await query<any>(
      `SELECT id, user_id, workspace_id, space_id, title, body FROM knowledge_item WHERE space_id=$1 AND source <> 'meeting'`, [spaceId],
    ).catch(() => []);
    for (const it of others) {
      const text = normEntity(`${it.title || ''} ${(it.body || '').slice(0, 1500)}`);
      let made = 0;
      for (const key of keys) {
        if (made >= 2) break;
        if (!text.includes(key)) continue;
        const rep = repOf.get(key);
        if (!rep || String(rep.item_id) === String(it.id)) continue;
        if (await insertEdge({ userId: it.user_id, workspaceId: it.workspace_id, spaceId: it.space_id ?? spaceId, srcKind: 'item', srcId: String(it.id), dstKind: 'item', dstId: String(rep.item_id), relation: 'related', origin: 'entity', confidence: 0.78, evidence: `names: ${key.slice(0, 50)}` })) { entityEdges++; made++; }
      }
    }
  }
  return { entityEdges };
}

/** Build threads for every space that got new data recently — called at the connector-sync tail so
 *  the ledger stays current as tickets move, in the same operation. Deterministic + $0. */
export async function buildActiveSpaceThreads(sinceMinutes = 30, cap = 25): Promise<{ spaces: number; open: number; stale: number }> {
  await ensureThreadSchema();
  const rows = await query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM knowledge_item
      WHERE space_id IS NOT NULL AND space_id <> $2 AND synced_at > NOW() - ($1 || ' minutes')::interval
      LIMIT ${cap}`, [String(sinceMinutes), ACCOUNT_SCOPE],
  ).catch(() => []);
  const agg = { spaces: 0, open: 0, stale: 0 };
  for (const r of rows) {
    const b = await buildSpaceThreads(r.space_id).catch(() => null);
    if (b) { agg.spaces++; agg.open += b.open; agg.stale += b.stale; }
    // Keep the derived MEMORY UNITS fresh as new meetings land (Memory-OS P3) — hash-gated, so
    // unchanged atoms cost nothing; only new/edited decisions/actions/topics are re-embedded.
    try { const { buildSpaceUnits, buildSpaceChunks, buildSpaceStateUnits } = await import('./memunits'); await buildSpaceUnits(r.space_id); await buildSpaceChunks(r.space_id); await buildSpaceStateUnits(r.space_id); } catch { /* best-effort */ }
    await buildSpaceEntityLinks(r.space_id).catch(() => {});   // keep meeting↔meeting entity clusters fresh
  }
  return agg;
}

/**
 * Refresh EVERY space's thread ledger (the hourly cron). Unlike the sync-tail builder (active spaces
 * only), this re-derives state for ALL spaces so `stale` stays honest as tickets cross the 7-day line
 * even when nothing synced. Deterministic + $0; bounded by `cap` spaces + a time budget.
 */
export async function buildAllSpaceThreads(cap = 200, timeBudgetMs = 120_000): Promise<{ spaces: number; open: number; advancing: number; resolved: number; stale: number; gaps: number; proposed: number }> {
  await ensureThreadSchema();
  const started = Date.now();
  const rows = await query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM knowledge_item WHERE space_id IS NOT NULL AND space_id <> $1 AND source='jira' LIMIT ${cap}`,
    [ACCOUNT_SCOPE],
  ).catch(() => []);
  const agg = { spaces: 0, open: 0, advancing: 0, resolved: 0, stale: 0, gaps: 0, proposed: 0 };
  for (const r of rows) {
    if (Date.now() - started > timeBudgetMs) break;
    const b = await buildSpaceThreads(r.space_id).catch(() => null);
    if (b) { agg.spaces++; agg.open += b.open; agg.advancing += b.advancing; agg.resolved += b.resolved; agg.stale += b.stale; agg.gaps += b.gaps; }
    // Close the loop: propose the missing tickets for this space's untracked (stale-gap) meetings.
    const p = await proposeGapTickets(r.space_id).catch(() => null);
    if (p) agg.proposed += p.proposed;
    // Refresh the CHIEF-OF-STAFF brief from the freshly-built ledger (D-1) — same operation, $0.
    try { const { buildSpaceBrief } = await import('./brief'); await buildSpaceBrief(r.space_id); } catch { /* brief is best-effort */ }
  }
  console.log('brain_threads_all', JSON.stringify(agg));
  return agg;
}

const slugify = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);

/**
 * CLOSE THE LOOP (Brain P3 → OS turn): for each STALE GAP thread (a meeting that made commitments but
 * never got a ticket, now >1wk old), propose creating the missing Jira ticket — DETERMINISTICALLY,
 * $0, no LLM (so the action loop works even when the reasoner is credit-blocked). Proposals land in
 * the SAME HITL queue (`action_proposal`); on approval the ticket is created and the gap resolves.
 * Idempotent via dedup_key. The space's project key is inferred from its existing Jira issues.
 */
export async function proposeGapTickets(spaceId: string): Promise<{ proposed: number }> {
  // CF-6: infer the space's Jira project key(s). If the space has MORE THAN ONE project, we cannot
  // know which one a given untracked meeting belongs to — proposing into the dominant one would file
  // the ticket in the WRONG project. Accuracy over coverage: skip proposing here rather than guess.
  const projs = await query<{ pk: string; c: number }>(
    `SELECT split_part(source_id,'-',1) AS pk, COUNT(*)::int AS c FROM knowledge_item
      WHERE space_id=$1 AND source='jira' AND source_id ~ '^[A-Z][A-Z0-9]+-[0-9]+$'
      GROUP BY 1 ORDER BY c DESC`, [spaceId],
  ).catch(() => []);
  if (!projs.length) return { proposed: 0 };         // no Jira project in this space → nowhere to propose
  if (projs.length > 1) {
    console.log('propose_gap_skipped_multiproject', JSON.stringify({ spaceId, projects: projs.map((p) => p.pk) }));
    return { proposed: 0 };                          // ambiguous target → skip, don't file into the wrong project
  }
  const projectKey = projs[0].pk;
  const gaps = await query<any>(
    `SELECT t.anchor_source_id AS msid, t.title, m.user_id, m.workspace_id, kg.action_items
       FROM brain_thread t
       JOIN knowledge_item m ON m.space_id=t.space_id AND m.source='meeting' AND m.source_id=t.anchor_source_id
       JOIN knowledge_graph kg ON kg.task_id::text = m.source_id AND kg.user_id = m.user_id
      WHERE t.space_id=$1 AND t.kind='gap' AND t.state='stale' LIMIT 25`, [spaceId],
  ).catch(() => []);
  let proposed = 0;
  for (const g of gaps) {
    const actions = (Array.isArray(g.action_items) ? g.action_items : []).filter((a: any) => a?.task && String(a.task).trim());
    for (const a of actions.slice(0, 2)) {   // top 2 unactioned items per untracked meeting
      const task = String(a.task).trim();
      const ok = await insertProposal({
        userId: g.user_id, workspaceId: g.workspace_id, spaceId, kind: 'jira', origin: 'gap',
        dedupKey: `gap:${g.msid}:${slugify(task)}`,
        proposal: {
          operation: 'create', projectKey, issueType: 'Task', summary: task.slice(0, 240),
          description: `An unactioned commitment from the meeting "${g.title}" — decided but never ticketed (the meeting is over a week old). Proposed automatically by Wisprnote.`,
          assigneeName: a?.owner && a.owner !== 'Unassigned' ? String(a.owner) : undefined,
        },
        sourceTitle: g.title, rationale: 'Untracked commitment — this meeting made a decision/action but no Jira ticket exists.',
        confidence: 0.7, score: 0.7, expiresInDays: 30,
      }).catch(() => false);
      if (ok) proposed++;
    }
  }
  return { proposed };
}

/** A space's threads for the UI — MOST-ATTENTION-FIRST (stale → open → advancing → resolved). */
export async function listSpaceThreads(spaceId: string): Promise<ThreadRow[]> {
  await ensureThreadSchema();
  return query<ThreadRow>(
    `SELECT kind, anchor_source, anchor_source_id, title, state, opened_at, last_advanced_at, evidence
       FROM brain_thread WHERE space_id=$1
      ORDER BY CASE state WHEN 'stale' THEN 0 WHEN 'open' THEN 1 WHEN 'advancing' THEN 2 ELSE 3 END,
               last_advanced_at DESC NULLS LAST
      LIMIT 500`,
    [spaceId],
  ).catch(() => []);
}
