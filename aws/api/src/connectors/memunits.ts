import { createHash } from 'crypto';
import { query } from '../db';
import { embedTexts } from '../kgEmbed';
import { upsertItemVectors } from './brainVector';
import { ACCOUNT_SCOPE } from './schema';

/**
 * DERIVED MEMORY UNITS (Memory-OS Phase 3) — the quality unlock.
 *
 * A meeting is a 60-minute transcript compressed into ONE vector; "what did we decide about pricing"
 * can't find the pricing decision inside that average. So we also index the high-signal ATOMS the
 * brain already extracted (knowledge_graph.decisions / action_items / topics) as their own memory
 * units in the SAME turbopuffer index — id `${parentItemId}~<type><idx>`, `unit_type` + `parent_id`
 * so retrieval resolves the atom back to its meeting. A query now hits the decision directly.
 *
 * Cost-disciplined: each atom carries a content HASH; an atom whose text is unchanged is NOT
 * re-embedded (mem_unit is the gate). Atoms are short → cheap. All spend metered as brain embedding.
 */

let ready: Promise<void> | null = null;
export function ensureMemUnitSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS mem_unit (
          id TEXT PRIMARY KEY,            -- '${'${parentItemId}'}~d0'
          parent_id BIGINT NOT NULL,      -- knowledge_item.id (the meeting)
          user_id UUID, workspace_id UUID, space_id UUID,
          source TEXT, unit_type TEXT,    -- decision | action | topic | chunk | thread | brief
          text TEXT, hash TEXT,
          embedded_at TIMESTAMPTZ
        )`);
      await query(`CREATE INDEX IF NOT EXISTS mem_unit_space_idx ON mem_unit (space_id)`);
      await query(`CREATE INDEX IF NOT EXISTS mem_unit_parent_idx ON mem_unit (parent_id)`);
      // Space-level state units (the brief) have no item parent — allow NULL.
      await query(`ALTER TABLE mem_unit ALTER COLUMN parent_id DROP NOT NULL`).catch(() => {});
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const hashOf = (s: string): string => createHash('sha1').update(s).digest('hex').slice(0, 16);
const clean = (s: any): string => String(s ?? '').replace(/\s+/g, ' ').trim();

interface Atom { id: string; parent_id: string; unit_type: string; text: string }

/** Build the derived-atom units for one space from its meetings' knowledge_graph, embed the CHANGED
 *  ones ($ = only new/edited atoms), and index them alongside the whole-item vectors. Idempotent. */
export async function buildSpaceUnits(spaceId: string, cap = 400): Promise<{ atoms: number; embedded: number; skipped: number }> {
  await ensureMemUnitSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { atoms: 0, embedded: 0, skipped: 0 };

  const meetings = await query<any>(
    `SELECT m.id AS parent_id, m.user_id, m.workspace_id, m.title,
            kg.decisions, kg.action_items, kg.topics
       FROM knowledge_item m
       JOIN knowledge_graph kg ON kg.task_id::text=m.source_id AND kg.user_id=m.user_id
      WHERE m.space_id=$1 AND m.source='meeting'`, [spaceId],
  ).catch(() => []);
  if (!meetings.length) return { atoms: 0, embedded: 0, skipped: 0 };

  // Assemble every atom with a stable id + its embed text.
  const atoms: Atom[] = [];
  const meta = new Map<string, { user_id: string; workspace_id: string }>();
  for (const m of meetings) {
    const pid = String(m.parent_id);
    meta.set(pid, { user_id: m.user_id, workspace_id: m.workspace_id });
    const title = clean(m.title);
    (Array.isArray(m.decisions) ? m.decisions : []).forEach((d: any, i: number) => {
      const t = clean(d?.decision); if (!t) return;
      atoms.push({ id: `${pid}~d${i}`, parent_id: pid, unit_type: 'decision', text: `Decision (from "${title}")${d?.relatedTopic ? ` about ${clean(d.relatedTopic)}` : ''}: ${t}` });
    });
    (Array.isArray(m.action_items) ? m.action_items : []).forEach((a: any, i: number) => {
      const t = clean(a?.task); if (!t) return;
      atoms.push({ id: `${pid}~a${i}`, parent_id: pid, unit_type: 'action', text: `Action item (from "${title}")${a?.owner && a.owner !== 'Unassigned' ? `, owner ${clean(a.owner)}` : ''}: ${t}` });
    });
    (Array.isArray(m.topics) ? m.topics : []).forEach((tp: any, i: number) => {
      const n = clean(tp?.name); if (!n) return;
      atoms.push({ id: `${pid}~t${i}`, parent_id: pid, unit_type: 'topic', text: `Topic (from "${title}"): ${n}${tp?.summary ? ` — ${clean(tp.summary)}` : ''}${tp?.status ? ` [status: ${clean(tp.status)}]` : ''}` });
    });
  }
  if (!atoms.length) return { atoms: 0, embedded: 0, skipped: 0 };
  const capped = atoms.slice(0, cap);

  // Hash-gate: embed only atoms whose text changed since last time.
  const existing = await query<{ id: string; hash: string }>(
    `SELECT id, hash FROM mem_unit WHERE space_id=$1`, [spaceId],
  ).catch(() => []);
  const prevHash = new Map(existing.map((e) => [e.id, e.hash] as [string, string]));
  const changed = capped.filter((a) => hashOf(a.text) !== prevHash.get(a.id));

  // Persist ALL current atoms (text + hash) so the gate + snippet stay current.
  for (const a of capped) {
    const mm = meta.get(a.parent_id)!;
    await query(
      `INSERT INTO mem_unit (id, parent_id, user_id, workspace_id, space_id, source, unit_type, text, hash)
       VALUES ($1,$2,$3,$4,$5,'meeting',$6,$7,$8)
       ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, hash=EXCLUDED.hash, unit_type=EXCLUDED.unit_type`,
      [a.id, Number(a.parent_id), mm.user_id, mm.workspace_id, spaceId, a.unit_type, a.text.slice(0, 1000), hashOf(a.text)],
    ).catch(() => {});
  }
  if (!changed.length) return { atoms: capped.length, embedded: 0, skipped: capped.length };

  // Embed + index the changed atoms into the SAME namespace as items (unit_type + parent_id set).
  const vecs = await embedTexts(changed.map((a) => a.text)).catch(() => null);
  if (!vecs) return { atoms: capped.length, embedded: 0, skipped: capped.length };
  const ok = await upsertItemVectors(changed.map((a, i) => {
    const mm = meta.get(a.parent_id)!;
    return { id: a.id, vector: vecs[i], user_id: mm.user_id, workspace_id: mm.workspace_id, source: 'meeting', unit_type: a.unit_type, parent_id: a.parent_id };
  }));
  if (!ok) return { atoms: capped.length, embedded: 0, skipped: capped.length };
  await query(`UPDATE mem_unit SET embedded_at=NOW() WHERE id = ANY($1)`, [changed.map((a) => a.id)]).catch(() => {});
  console.log('mem_units', JSON.stringify({ spaceId, atoms: capped.length, embedded: changed.length }));
  return { atoms: capped.length, embedded: changed.length, skipped: capped.length - changed.length };
}

// Split a long body into overlapping windows, preferring paragraph/sentence boundaries.
const CHUNK_CHARS = 1400, CHUNK_OVERLAP = 180, CHUNK_MIN = 1100, MAX_CHUNKS_PER_ITEM = 14;
function chunkText(body: string): string[] {
  const t = clean(body);
  if (t.length <= CHUNK_MIN) return t.length >= 40 ? [t] : [];   // short items already have a whole-item vector
  const out: string[] = [];
  let i = 0;
  while (i < t.length && out.length < MAX_CHUNKS_PER_ITEM) {
    let end = Math.min(i + CHUNK_CHARS, t.length);
    if (end < t.length) {                                        // break on the nearest sentence/space
      const slice = t.slice(i, end);
      const brk = Math.max(slice.lastIndexOf('. '), slice.lastIndexOf('\n'), slice.lastIndexOf(' '));
      if (brk > CHUNK_CHARS * 0.6) end = i + brk + 1;
    }
    out.push(t.slice(i, end).trim());
    if (end >= t.length) break;
    i = end - CHUNK_OVERLAP;
  }
  return out;
}

/**
 * ITEM CHUNKS (Memory-OS Phase 3, second half) — a 60-minute transcript is one averaged vector, so a
 * question about a specific passage can't find it. Split long item bodies (meetings especially) into
 * overlapping chunks and index each into the SAME unified turbopuffer index (unit_type='chunk',
 * parent_id=item) — retrieval already resolves a chunk hit back to its parent item. Hash-gated: a
 * chunk whose text is unchanged is not re-embedded. This completes the "item chunks" box of the arch.
 */
export async function buildSpaceChunks(spaceId: string, cap = 600): Promise<{ chunks: number; embedded: number; skipped: number }> {
  await ensureMemUnitSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { chunks: 0, embedded: 0, skipped: 0 };
  const items = await query<any>(
    `SELECT id, user_id, workspace_id, source, title, body FROM knowledge_item
      WHERE space_id=$1 AND COALESCE(length(body),0) > ${CHUNK_MIN} ORDER BY occurred_at DESC NULLS LAST LIMIT 200`,
    [spaceId],
  ).catch(() => []);
  if (!items.length) return { chunks: 0, embedded: 0, skipped: 0 };

  const units: Array<{ id: string; parent_id: string; user_id: string; workspace_id: string; source: string; text: string }> = [];
  for (const it of items) {
    const title = clean(it.title);
    chunkText(it.body).forEach((c, i) => {
      units.push({ id: `${it.id}~c${i}`, parent_id: String(it.id), user_id: it.user_id, workspace_id: it.workspace_id, source: it.source, text: title ? `${title}\n${c}` : c });
    });
  }
  const capped = units.slice(0, cap);
  if (!capped.length) return { chunks: 0, embedded: 0, skipped: 0 };

  const existing = await query<{ id: string; hash: string }>(`SELECT id, hash FROM mem_unit WHERE space_id=$1 AND unit_type='chunk'`, [spaceId]).catch(() => []);
  const prev = new Map(existing.map((e) => [e.id, e.hash] as [string, string]));
  const changed = capped.filter((u) => hashOf(u.text) !== prev.get(u.id));
  for (const u of capped) {
    await query(
      `INSERT INTO mem_unit (id, parent_id, user_id, workspace_id, space_id, source, unit_type, text, hash)
       VALUES ($1,$2,$3,$4,$5,$6,'chunk',$7,$8)
       ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, hash=EXCLUDED.hash`,
      [u.id, Number(u.parent_id), u.user_id, u.workspace_id, spaceId, u.source, u.text.slice(0, 2000), hashOf(u.text)],
    ).catch(() => {});
  }
  if (!changed.length) return { chunks: capped.length, embedded: 0, skipped: capped.length };
  const vecs = await embedTexts(changed.map((u) => u.text)).catch(() => null);
  if (!vecs) return { chunks: capped.length, embedded: 0, skipped: capped.length };
  const ok = await upsertItemVectors(changed.map((u, i) => ({ id: u.id, vector: vecs[i], user_id: u.user_id, workspace_id: u.workspace_id, source: u.source, unit_type: 'chunk', parent_id: u.parent_id })));
  if (!ok) return { chunks: capped.length, embedded: 0, skipped: capped.length };
  await query(`UPDATE mem_unit SET embedded_at=NOW() WHERE id = ANY($1)`, [changed.map((u) => u.id)]).catch(() => {});
  console.log('mem_chunks', JSON.stringify({ spaceId, chunks: capped.length, embedded: changed.length }));
  return { chunks: capped.length, embedded: changed.length, skipped: capped.length - changed.length };
}

/**
 * STATE UNITS (Memory-OS — the "threads + brief" chip). Index the brain's WORK-STATE into the same
 * unified index so a status query can retrieve it semantically: each ticket/gap THREAD becomes a unit
 * anchored to its item (parent resolves normally), and the SPACE BRIEF becomes a parent-less unit
 * (retrieval returns it as a synthetic 'brain-state' result). Hash-gated. Completes the 4th granularity.
 */
export async function buildSpaceStateUnits(spaceId: string): Promise<{ units: number; embedded: number; skipped: number }> {
  await ensureMemUnitSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { units: 0, embedded: 0, skipped: 0 };
  const owner = await query<any>(`SELECT user_id, workspace_id FROM knowledge_item WHERE space_id=$1 LIMIT 1`, [spaceId]).then((r) => r[0]).catch(() => null);
  if (!owner) return { units: 0, embedded: 0, skipped: 0 };

  const units: Array<{ id: string; parent_id: number | null; source: string; unit_type: string; text: string }> = [];
  // THREAD units — anchored to their knowledge_item (ticket / gap-meeting), so parent resolves cleanly.
  const threads = await query<any>(
    `SELECT t.kind, t.anchor_source, t.anchor_source_id, t.title, t.state, t.evidence, ki.id AS parent_id
       FROM brain_thread t
       LEFT JOIN knowledge_item ki ON ki.space_id=$1 AND ki.source=t.anchor_source AND ki.source_id=t.anchor_source_id
      WHERE t.space_id=$1 AND t.kind IN ('ticket','gap')`, [spaceId],
  ).catch(() => []);
  for (const t of threads) {
    if (!t.parent_id) continue;
    const ev = t.evidence || {};
    const detail = t.kind === 'gap'
      ? `${ev.actionCount || 0} commitments from this meeting were never ticketed`
      : `status "${ev.status || '?'}", ${(ev.commits || []).length} confirmed commit(s), ${(ev.meetings || []).length} source meeting(s)`;
    units.push({ id: `${t.parent_id}~state`, parent_id: Number(t.parent_id), source: t.anchor_source, unit_type: 'thread',
      text: `Work status of ${t.anchor_source_id} (${clean(t.title)}): ${t.state}. ${detail}.` });
  }
  // BRIEF unit — space-level, no item parent.
  const brief = await query<any>(`SELECT narrative FROM space_brief WHERE space_id=$1`, [spaceId]).then((r) => r[0]).catch(() => null);
  if (brief?.narrative) units.push({ id: `brief~${spaceId}`, parent_id: null, source: 'brief', unit_type: 'brief', text: String(brief.narrative) });
  if (!units.length) return { units: 0, embedded: 0, skipped: 0 };

  const existing = await query<{ id: string; hash: string }>(`SELECT id, hash FROM mem_unit WHERE space_id=$1 AND unit_type IN ('thread','brief')`, [spaceId]).catch(() => []);
  const prev = new Map(existing.map((e) => [e.id, e.hash] as [string, string]));
  const changed = units.filter((u) => hashOf(u.text) !== prev.get(u.id));
  for (const u of units) {
    await query(
      `INSERT INTO mem_unit (id, parent_id, user_id, workspace_id, space_id, source, unit_type, text, hash)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT (id) DO UPDATE SET text=EXCLUDED.text, hash=EXCLUDED.hash, unit_type=EXCLUDED.unit_type`,
      [u.id, u.parent_id, owner.user_id, owner.workspace_id, spaceId, u.source, u.unit_type, u.text.slice(0, 1500), hashOf(u.text)],
    ).catch(() => {});
  }
  if (!changed.length) return { units: units.length, embedded: 0, skipped: units.length };
  const vecs = await embedTexts(changed.map((u) => u.text)).catch(() => null);
  if (!vecs) return { units: units.length, embedded: 0, skipped: units.length };
  const ok = await upsertItemVectors(changed.map((u, i) => ({
    id: u.id, vector: vecs[i], user_id: owner.user_id, workspace_id: owner.workspace_id, source: u.source, unit_type: u.unit_type,
    parent_id: u.parent_id != null ? String(u.parent_id) : u.id,   // parent-less units carry their own id → retrieval returns them synthetically
  })));
  if (!ok) return { units: units.length, embedded: 0, skipped: units.length };
  await query(`UPDATE mem_unit SET embedded_at=NOW() WHERE id = ANY($1)`, [changed.map((u) => u.id)]).catch(() => {});
  console.log('mem_state', JSON.stringify({ spaceId, units: units.length, embedded: changed.length }));
  return { units: units.length, embedded: changed.length, skipped: units.length - changed.length };
}
