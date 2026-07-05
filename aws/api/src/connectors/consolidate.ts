import { query } from '../db';
import { ACCOUNT_SCOPE } from './schema';

// A node may hold at most this many 'possible' (semantic) edges after consolidation — mirrors the
// linker's live cap so the nightly sleep also prunes any historical over-accumulation.
const SEM_DEGREE_CAP = 2;

/**
 * CONSOLIDATION (Brain P4) — the brain's "sleep".
 *
 * A biological brain doesn't append forever: during sleep it replays the day, merges duplicate
 * traces, prunes connections that never fire, and keeps the meaningful structure. Our graph was
 * append-only (hence the commit↔commit blobs + stale/dangling edges we cleaned by hand). This makes
 * that cleanup a STANDING RHYTHM — deterministic, $0, idempotent — so the map a user opens is the
 * consolidated story, not the raw trace log.
 *
 * P4.1 does the two safest, highest-value passes:
 *   1. PRUNE dangling edges — an endpoint item no longer exists.
 *   2. SUPERSEDE redundant similarity — drop a `semantic` ('related') edge when a real CLAIM
 *      (provenance / reference / entity) or a VERDICT (llm) already explains that exact pair. The
 *      claim is the backbone; the similarity guess is noise once the claim exists.
 */

export interface ConsolidateResult { danglingDeleted: number; semanticSuperseded: number; reciprocalDeleted: number; degreeCapped: number; sameSourceDeleted: number }

export async function consolidateSpace(spaceId: string): Promise<ConsolidateResult> {
  const result: ConsolidateResult = { danglingDeleted: 0, semanticSuperseded: 0, reciprocalDeleted: 0, degreeCapped: 0, sameSourceDeleted: 0 };

  // 0) SAME-SOURCE semantic (accuracy) — a 'possible' edge between two items of the SAME source
  //    (meeting↔meeting, ticket↔ticket, commit↔commit) is noise: the map's value is cross-tool
  //    LINEAGE, and meeting continuity is now held by TOPIC threads. Drop them (claims untouched).
  const sameSrc = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM brain_edge e USING knowledge_item a, knowledge_item b
        WHERE e.space_id=$1 AND e.origin='semantic'
          AND a.id::text=e.src_id AND b.id::text=e.dst_id AND a.source=b.source
       RETURNING 1)
     SELECT COUNT(*)::int AS n FROM d`,
    [spaceId],
  ).catch(() => null);
  result.sameSourceDeleted = sameSrc?.[0]?.n ?? 0;

  // 1) Dangling edges — a src/dst 'item' endpoint that was deleted (e.g. by a leak cleanup / re-sync).
  const dangling = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM brain_edge t WHERE t.space_id=$1
         AND ((t.src_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_item k WHERE k.id::text=t.src_id))
           OR (t.dst_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_item k WHERE k.id::text=t.dst_id)))
       RETURNING 1)
     SELECT COUNT(*)::int AS n FROM d`,
    [spaceId],
  ).catch(() => null);
  result.danglingDeleted = dangling?.[0]?.n ?? 0;

  // 2) Redundant similarity — a 'semantic' edge on a pair that ALSO has a claim/verdict edge (either
  //    direction). Keep the explained edge, drop the guess. (Going forward the linker already skips
  //    claim-bound pairs, so this mainly clears legacy redundancy — little churn.)
  const superseded = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM brain_edge s WHERE s.space_id=$1 AND s.origin='semantic'
         AND EXISTS (
           SELECT 1 FROM brain_edge c WHERE c.space_id=s.space_id
             AND c.origin IN ('provenance','reference','entity','llm')
             AND ((c.src_id=s.src_id AND c.dst_id=s.dst_id) OR (c.src_id=s.dst_id AND c.dst_id=s.src_id)))
       RETURNING 1)
     SELECT COUNT(*)::int AS n FROM d`,
    [spaceId],
  ).catch(() => null);
  result.semanticSuperseded = superseded?.[0]?.n ?? 0;

  // 3) Reciprocal duplicates (CF-2) — a symmetric edge stored BOTH ways (A→B and B→A) double-counts
  //    the same association. Going forward insertEdge canonicalizes direction so this can't happen;
  //    this clears LEGACY reciprocals by deleting the non-canonical copy (the one whose src endpoint
  //    sorts AFTER its dst) when its mirror exists.
  const reciprocal = await query<{ n: number }>(
    `WITH d AS (
       DELETE FROM brain_edge s WHERE s.space_id=$1 AND s.origin='semantic' AND s.relation IN ('related','people')
         AND (s.src_kind||':'||s.src_id) > (s.dst_kind||':'||s.dst_id)
         AND EXISTS (SELECT 1 FROM brain_edge m WHERE m.space_id=s.space_id AND m.origin='semantic' AND m.relation=s.relation
             AND m.src_kind=s.dst_kind AND m.src_id=s.dst_id AND m.dst_kind=s.src_kind AND m.dst_id=s.src_id)
       RETURNING 1)
     SELECT COUNT(*)::int AS n FROM d`,
    [spaceId],
  ).catch(() => null);
  result.reciprocalDeleted = reciprocal?.[0]?.n ?? 0;

  // 4) Per-node degree cap (CF-2) — keep only each node's STRONGEST few 'possible' edges; prune the
  //    rest so a single node can't anchor a semantic blob. An edge is dropped if it ranks beyond the
  //    cap for EITHER endpoint (so max degree K holds for every node). Claims/verdicts are untouched.
  const capped = await query<{ n: number }>(
    `WITH endpoints AS (
       SELECT id, (src_kind||':'||src_id) AS node, confidence FROM brain_edge WHERE space_id=$1 AND origin='semantic'
       UNION ALL
       SELECT id, (dst_kind||':'||dst_id) AS node, confidence FROM brain_edge WHERE space_id=$1 AND origin='semantic'),
     ranked AS (
       SELECT id, ROW_NUMBER() OVER (PARTITION BY node ORDER BY confidence DESC NULLS LAST, id) AS rnk FROM endpoints),
     overflow AS (SELECT DISTINCT id FROM ranked WHERE rnk > $2),
     d AS (DELETE FROM brain_edge WHERE id IN (SELECT id FROM overflow) RETURNING 1)
     SELECT COUNT(*)::int AS n FROM d`,
    [spaceId, SEM_DEGREE_CAP],
  ).catch(() => null);
  result.degreeCapped = capped?.[0]?.n ?? 0;

  return result;
}

/** Consolidate every space (the daily "sleep" cron). Bounded by `cap` + a time budget. */
export async function consolidateAll(cap = 200, timeBudgetMs = 120_000): Promise<{ spaces: number; danglingDeleted: number; semanticSuperseded: number; reciprocalDeleted: number; degreeCapped: number }> {
  const started = Date.now();
  // Exclude the sentinel/unscoped bucket (CF-1) — it is not a real space; consolidating it would
  // maintain a ghost graph (and, downstream, ghost threads) for account-scope leftovers.
  const rows = await query<{ space_id: string }>(
    `SELECT DISTINCT space_id FROM brain_edge WHERE space_id IS NOT NULL AND space_id <> $1 LIMIT ${cap}`,
    [ACCOUNT_SCOPE],
  ).catch(() => []);
  const agg = { spaces: 0, danglingDeleted: 0, semanticSuperseded: 0, reciprocalDeleted: 0, degreeCapped: 0, sameSourceDeleted: 0 };
  for (const r of rows) {
    if (Date.now() - started > timeBudgetMs) break;
    const c = await consolidateSpace(r.space_id).catch(() => null);
    if (c) { agg.spaces++; agg.danglingDeleted += c.danglingDeleted; agg.semanticSuperseded += c.semanticSuperseded; agg.reciprocalDeleted += c.reciprocalDeleted; agg.degreeCapped += c.degreeCapped; agg.sameSourceDeleted += c.sameSourceDeleted; }
  }
  console.log('brain_consolidate_all', JSON.stringify(agg));
  return agg;
}
