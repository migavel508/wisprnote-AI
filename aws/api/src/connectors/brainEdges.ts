import { query, queryOne } from '../db';

/**
 * Brain edges (Living-Brain Phase C) — the ASSOCIATIONS that make meetings + Jira +
 * GitHub one graph instead of three searchable piles. A node is referenced by
 * (kind, id): kind 'meeting' → task_history.id; kind 'item' → knowledge_item.id.
 * Edges are workspace-scoped and idempotent. `origin` records how we know:
 *   provenance (we created it) · reference ("fixes SCRUM-3", "#42") · people · semantic.
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
          origin TEXT NOT NULL,          -- provenance | reference | people | semantic
          confidence REAL,
          evidence TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation)
        )
      `);
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
}

/** Insert an edge (idempotent). Skips self-loops. Returns true if newly inserted. */
export async function insertEdge(e: EdgeInput): Promise<boolean> {
  if (e.srcKind === e.dstKind && e.srcId === e.dstId) return false;
  const r = await queryOne<{ id: string }>(
    `INSERT INTO brain_edge (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     ON CONFLICT (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation) DO NOTHING
     RETURNING id`,
    [e.userId, e.workspaceId, e.srcKind, e.srcId, e.dstKind, e.dstId, e.relation, e.origin, e.confidence ?? null, e.evidence ?? null],
  );
  return !!r;
}

export interface BrainEdgeRow {
  src_kind: string; src_id: string; dst_kind: string; dst_id: string;
  relation: string; origin: string; confidence: number | null; evidence: string | null;
}

/** All edges for a workspace (for the brain map + lineage). */
export async function getBrainEdges(userId: string, workspaceId: string, limit = 500): Promise<BrainEdgeRow[]> {
  await ensureBrainEdgeSchema();
  return query<BrainEdgeRow>(
    `SELECT src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence
       FROM brain_edge WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT ${limit}`,
    [userId, workspaceId],
  );
}

/** Neighbours of a node (both directions) — used for chat graph-expansion (Phase D). */
export async function neighboursOf(userId: string, workspaceId: string, kind: string, id: string, limit = 12): Promise<BrainEdgeRow[]> {
  await ensureBrainEdgeSchema();
  return query<BrainEdgeRow>(
    `SELECT src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence
       FROM brain_edge
      WHERE user_id=$1 AND workspace_id=$2
        AND ((src_kind=$3 AND src_id=$4) OR (dst_kind=$3 AND dst_id=$4))
      ORDER BY confidence DESC NULLS LAST LIMIT ${limit}`,
    [userId, workspaceId, kind, id],
  );
}
