import { query, queryOne } from '../db';
import { ACCOUNT_SCOPE } from './schema';

/**
 * BRAIN REBUILD — wipe a space's DERIVED brain map and rebuild it from scratch, in place.
 *
 * Deletes only the derived layer (edges, threads, brief, atoms, gap proposals, embed cursors); KEEPS
 * the source of truth (knowledge_item, knowledge_graph, brain_event, connector_credentials) so there's
 * something to rebuild FROM without re-pulling from Jira/GitHub. Then re-runs the whole pipeline —
 * embed → bind (claims) → atoms → link (semantic + verdict) → threads → brief → consolidate — so a
 * single call is an end-to-end test of the current brain functionality. Every step is idempotent, so a
 * partial run (Lambda timeout) is finished by the normal crons (drain-guaranteed).
 */

export interface ResetCounts { brainEdges: number; brainThreads: number; spaceBrief: number; memUnits: number; proposals: number; linkState: number; embeddedReset: number }

/** Delete the derived brain layer for a space. DRY-RUN unless commit=true. Source data is untouched. */
export async function resetSpaceBrain(spaceId: string, commit: boolean): Promise<ResetCounts> {
  const out: ResetCounts = { brainEdges: 0, brainThreads: 0, spaceBrief: 0, memUnits: 0, proposals: 0, linkState: 0, embeddedReset: 0 };
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return out;
  const step = async (countSql: string, deleteSql: string): Promise<number> => {
    const r = await query<{ n: number }>(commit ? deleteSql : countSql, [spaceId]).catch(() => null);
    return r?.[0]?.n ?? 0;
  };
  const del = (table: string) => [`SELECT COUNT(*)::int AS n FROM ${table} WHERE space_id=$1`,
    `WITH d AS (DELETE FROM ${table} WHERE space_id=$1 RETURNING 1) SELECT COUNT(*)::int AS n FROM d`] as const;
  out.brainEdges   = await step(...del('brain_edge'));
  out.brainThreads = await step(...del('brain_thread'));
  out.spaceBrief   = await step(...del('space_brief'));
  out.memUnits     = await step(...del('mem_unit'));
  out.proposals    = await step(...del('action_proposal'));
  // Link cursor for this space's items (so the next link re-processes every one).
  out.linkState = await step(
    `SELECT COUNT(*)::int AS n FROM brain_link_state WHERE item_id IN (SELECT id FROM knowledge_item WHERE space_id=$1)`,
    `WITH d AS (DELETE FROM brain_link_state WHERE item_id IN (SELECT id FROM knowledge_item WHERE space_id=$1) RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
  // Force re-embed: clear the embed markers (UPDATE, not delete) so the item vectors are recomputed.
  out.embeddedReset = await step(
    `SELECT COUNT(*)::int AS n FROM knowledge_item WHERE space_id=$1 AND embedded_at IS NOT NULL`,
    `WITH d AS (UPDATE knowledge_item SET embedded_at=NULL, embedded_hash=NULL WHERE space_id=$1 RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
  return out;
}

export interface RebuildResult { reset: ResetCounts; stages: Record<string, any> }

/** Reset (commit) + rebuild a space's brain end-to-end. Bounded so it fits a Lambda; crons finish any tail. */
export async function rebuildSpaceBrain(spaceId: string): Promise<RebuildResult> {
  const started = Date.now();
  const BUDGET_MS = 250_000;   // stay under the 300s Lambda cap
  const reset = await resetSpaceBrain(spaceId, true);
  const stages: Record<string, any> = {};
  const owner = await queryOne<{ user_id: string; workspace_id: string }>(
    `SELECT user_id, workspace_id FROM knowledge_item WHERE space_id=$1 LIMIT 1`, [spaceId],
  ).catch(() => null);
  if (!owner) return { reset, stages: { error: 'no items in space' } };

  // 0) ENRICH — give GitHub commits real signal BEFORE embedding, else they embed on a bare commit
  //    message, never cross the cross-source floor, and float ISOLATED. Tier 1 fingerprint (filenames
  //    + stats, $0) + Tier 2 diff→summary (LLM prose that actually matches meeting/ticket intent).
  //    Enrich bumps synced_at, so the embed step below re-vectorizes the now-enriched commits.
  try {
    const { fingerprintCommits, backfillCommitSummaries } = await import('./github/enrich');
    const fp = await fingerprintCommits(30).catch(() => ({ fingerprinted: 0 } as any));
    const bf = await backfillCommitSummaries(25).catch(() => ({ enriched: 0 } as any));
    stages.enrich = { fingerprinted: (fp as any).fingerprinted ?? fp, enriched: (bf as any).enriched ?? bf };
  } catch (e: any) { stages.enrich = `error: ${e?.message}`; }

  // 1) EMBED — re-vectorize the space's items (drains the reset markers; bounded loop).
  try {
    const { embedKnowledgeItems } = await import('./embed');
    let embedded = 0; for (let i = 0; i < 6; i++) { const r = await embedKnowledgeItems(96); embedded += r.embedded; if (r.embedded === 0) break; }
    stages.embedded = embedded;
  } catch (e: any) { stages.embedded = `error: ${e?.message}`; }

  // 2) BIND — deterministic claims → confirmed edges (provenance/reference/entity) + ENTITY LINKS
  //    (connect meetings sharing a distinctive client/project/person → fewer isolated nodes).
  try { const { bindSpace } = await import('./brainBind'); stages.bind = await bindSpace(spaceId); } catch (e: any) { stages.bind = `error: ${e?.message}`; }
  try { const { buildSpaceEntityLinks } = await import('./threads'); stages.entityLinks = await buildSpaceEntityLinks(spaceId); } catch (e: any) { stages.entityLinks = `error: ${e?.message}`; }

  // 3) ATOMS + CHUNKS — derived memory units (decisions/actions/topics) + long-body chunks, all into
  //    the one unified turbopuffer index for granular retrieval.
  try { const { buildSpaceUnits, buildSpaceChunks } = await import('./memunits'); stages.units = await buildSpaceUnits(spaceId); stages.chunks = await buildSpaceChunks(spaceId); } catch (e: any) { stages.units = `error: ${e?.message}`; }

  // 4) LINK — semantic connectivity + LLM verdicts (bounded drain over the workspace).
  try {
    const { runBrainLink } = await import('./brainLink');
    const agg = { semantic: 0, llm: 0, rounds: 0 };
    for (let i = 0; i < 6 && Date.now() - started < BUDGET_MS; i++) {
      const r = await runBrainLink({ workspaceId: owner.workspace_id, llmBudget: 8, timeBudgetMs: 30_000 });
      agg.semantic += r.semantic; agg.llm += r.llm; agg.rounds++;
      if (r.semantic === 0 && r.llm === 0) break;
    }
    stages.link = agg;
  } catch (e: any) { stages.link = `error: ${e?.message}`; }

  // 5) THREADS + gap proposals · 6) BRIEF · 7) CONSOLIDATE.
  try { const { buildSpaceThreads, proposeGapTickets } = await import('./threads'); stages.threads = await buildSpaceThreads(spaceId); stages.proposed = (await proposeGapTickets(spaceId)).proposed; } catch (e: any) { stages.threads = `error: ${e?.message}`; }
  try { const { buildSpaceBrief } = await import('./brief'); const b = await buildSpaceBrief(spaceId); stages.brief = b ? 'built' : 'skipped'; } catch (e: any) { stages.brief = `error: ${e?.message}`; }
  // STATE UNITS — index the threads + brief into the unified index (the "threads + brief" chip).
  try { const { buildSpaceStateUnits } = await import('./memunits'); stages.stateUnits = await buildSpaceStateUnits(spaceId); } catch (e: any) { stages.stateUnits = `error: ${e?.message}`; }
  try { const { consolidateSpace } = await import('./consolidate'); stages.consolidate = await consolidateSpace(spaceId); } catch (e: any) { stages.consolidate = `error: ${e?.message}`; }

  stages.tookMs = Date.now() - started;
  console.log('brain_rebuild', JSON.stringify({ spaceId, reset, stages }));
  return { reset, stages };
}
