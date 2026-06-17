import { query, queryOne } from '../db';

/**
 * Brain edges (Living-Brain Phase C) — the ASSOCIATIONS that make meetings + Jira +
 * GitHub one graph instead of three searchable piles. A node is referenced by
 * (kind, id): kind 'meeting' → task_history.id; kind 'item' → knowledge_item.id.
 * Edges are workspace-scoped and idempotent. `origin` records how we know:
 *   provenance (we created it) · reference ("fixes PROJ-3", "#42") · people · semantic.
 */

let ready: Promise<void> | null = null;

export function ensureBrainEdgeSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS brain_edge (
          id BIGSERIAL PRIMARY KEY,
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          src_kind TEXT NOT NULL,
          src_id TEXT NOT NULL,
          dst_kind TEXT NOT NULL,
          dst_id TEXT NOT NULL,
          relation TEXT NOT NULL,        -- references | implements | spawned | related | mentions
          origin TEXT NOT NULL,          -- provenance | reference | people | semantic | llm
          confidence REAL,
          evidence TEXT,
          verdict TEXT,                  -- aligned | partial | divergent (reasoning lives ON the edge)
          rationale TEXT,                -- one-sentence "what was intended vs what shipped"
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation)
        )
      `);
      // The verdict/rationale carry the reasoning DIRECTLY on the relationship line (so the
      // brain map can colour + explain each connection) — added here for existing tables.
      await query(`ALTER TABLE brain_edge ADD COLUMN IF NOT EXISTS verdict TEXT`);
      await query(`ALTER TABLE brain_edge ADD COLUMN IF NOT EXISTS rationale TEXT`);
      await query(`CREATE INDEX IF NOT EXISTS brain_edge_ws_idx ON brain_edge (user_id, workspace_id)`);
      await query(`CREATE INDEX IF NOT EXISTS brain_edge_src_idx ON brain_edge (user_id, workspace_id, src_kind, src_id)`);
      await query(`CREATE INDEX IF NOT EXISTS brain_edge_dst_idx ON brain_edge (user_id, workspace_id, dst_kind, dst_id)`);
      // Marks which knowledge_items have had semantic linking done (avoid recompute).
      await query(`
        CREATE TABLE IF NOT EXISTS brain_link_state (
          user_id UUID NOT NULL,
          workspace_id UUID NOT NULL,
          item_id BIGINT NOT NULL,
          linked_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, workspace_id, item_id)
        )
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

export interface EdgeInput {
  userId: string; workspaceId: string;
  srcKind: string; srcId: string; dstKind: string; dstId: string;
  relation: string; origin: string; confidence?: number; evidence?: string;
  verdict?: string; rationale?: string;
}

/** Upsert an edge (idempotent). Skips self-loops. Returns true if NEWLY inserted (not an
 *  update). When verdict/rationale are supplied they refresh on conflict, so re-judging a
 *  link updates the reasoning shown on the line; otherwise existing values are kept. */
export async function insertEdge(e: EdgeInput): Promise<boolean> {
  if (e.srcKind === e.dstKind && e.srcId === e.dstId) return false;
  const r = await queryOne<{ inserted: boolean }>(
    `INSERT INTO brain_edge (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence, verdict, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     ON CONFLICT (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET
       confidence = COALESCE(EXCLUDED.confidence, brain_edge.confidence),
       evidence   = COALESCE(EXCLUDED.evidence, brain_edge.evidence),
       verdict    = COALESCE(EXCLUDED.verdict, brain_edge.verdict),
       rationale  = COALESCE(EXCLUDED.rationale, brain_edge.rationale)
     RETURNING (xmax = 0) AS inserted`,
    [e.userId, e.workspaceId, e.srcKind, e.srcId, e.dstKind, e.dstId, e.relation, e.origin, e.confidence ?? null, e.evidence ?? null, e.verdict ?? null, e.rationale ?? null],
  );
  return !!r?.inserted;
}

export interface BrainEdgeRow {
  src_kind: string; src_id: string; dst_kind: string; dst_id: string;
  relation: string; origin: string; confidence: number | null; evidence: string | null;
  verdict: string | null; rationale: string | null;
}

/** All edges for a workspace (for the brain map + lineage). */
export async function getBrainEdges(userId: string, workspaceId: string, limit = 500): Promise<BrainEdgeRow[]> {
  await ensureBrainEdgeSchema();
  return query<BrainEdgeRow>(
    `SELECT src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence, verdict, rationale
       FROM brain_edge WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT ${limit}`,
    [userId, workspaceId],
  );
}

/** Neighbours of a node (both directions) — used for chat graph-expansion (Phase D). */
export async function neighboursOf(userId: string, workspaceId: string, kind: string, id: string, limit = 12): Promise<BrainEdgeRow[]> {
  await ensureBrainEdgeSchema();
  return query<BrainEdgeRow>(
    `SELECT src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence, verdict, rationale
       FROM brain_edge
      WHERE user_id=$1 AND workspace_id=$2
        AND ((src_kind=$3 AND src_id=$4) OR (dst_kind=$3 AND dst_id=$4))
      ORDER BY confidence DESC NULLS LAST LIMIT ${limit}`,
    [userId, workspaceId, kind, id],
  );
}
