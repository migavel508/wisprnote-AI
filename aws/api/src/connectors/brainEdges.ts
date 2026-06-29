import { query, queryOne } from '../db';
import { ACCOUNT_SCOPE } from './schema';

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
      // Space-scoped brain: which SPACE this edge belongs to (its intent meeting's space).
      // Backfilled (follow-linked-meeting) for legacy edges; set on write going forward.
      await query(`ALTER TABLE brain_edge ADD COLUMN IF NOT EXISTS space_id UUID`);
      await query(`CREATE INDEX IF NOT EXISTS brain_edge_ws_idx ON brain_edge (user_id, workspace_id)`);
      await query(`CREATE INDEX IF NOT EXISTS brain_edge_space_idx ON brain_edge (user_id, workspace_id, space_id)`);
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
  userId: string; workspaceId: string; spaceId?: string | null;
  srcKind: string; srcId: string; dstKind: string; dstId: string;
  relation: string; origin: string; confidence?: number; evidence?: string;
  verdict?: string; rationale?: string;
}

/** Upsert an edge (idempotent). Skips self-loops. Returns true if NEWLY inserted (not an
 *  update). When verdict/rationale are supplied they refresh on conflict, so re-judging a
 *  link updates the reasoning shown on the line; otherwise existing values are kept. */
export async function insertEdge(e: EdgeInput): Promise<boolean> {
  if (e.srcKind === e.dstKind && e.srcId === e.dstId) return false;
  // STRICT space isolation (P0): never link two items in DIFFERENT real spaces. Cross-space edges
  // were how a meeting in one space pulled in another space's Jira/commits. Unscoped endpoints
  // (sentinel/null — not yet space-assigned) are allowed; a genuinely cross-space pair is refused.
  if (e.srcKind === 'item' && e.dstKind === 'item') {
    const sp = await queryOne<{ a: string | null; b: string | null }>(
      `SELECT (SELECT space_id::text FROM knowledge_item WHERE id=$1) AS a,
              (SELECT space_id::text FROM knowledge_item WHERE id=$2) AS b`,
      [e.srcId, e.dstId],
    ).catch(() => null);
    const a = sp?.a, b = sp?.b;
    if (a && b && a !== ACCOUNT_SCOPE && b !== ACCOUNT_SCOPE && a !== b) return false;
  }
  const r = await queryOne<{ inserted: boolean }>(
    `INSERT INTO brain_edge (user_id, workspace_id, space_id, src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence, verdict, rationale)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
     ON CONFLICT (user_id, workspace_id, src_kind, src_id, dst_kind, dst_id, relation) DO UPDATE SET
       space_id   = COALESCE(EXCLUDED.space_id, brain_edge.space_id),
       confidence = COALESCE(EXCLUDED.confidence, brain_edge.confidence),
       evidence   = COALESCE(EXCLUDED.evidence, brain_edge.evidence),
       verdict    = COALESCE(EXCLUDED.verdict, brain_edge.verdict),
       rationale  = COALESCE(EXCLUDED.rationale, brain_edge.rationale)
     RETURNING (xmax = 0) AS inserted`,
    [e.userId, e.workspaceId, e.spaceId ?? null, e.srcKind, e.srcId, e.dstKind, e.dstId, e.relation, e.origin, e.confidence ?? null, e.evidence ?? null, e.verdict ?? null, e.rationale ?? null],
  );
  return !!r?.inserted;
}

export interface BrainEdgeRow {
  src_kind: string; src_id: string; dst_kind: string; dst_id: string;
  relation: string; origin: string; confidence: number | null; evidence: string | null;
  verdict: string | null; rationale: string | null;
}

/** All edges for a workspace (for the brain map + lineage). When `spaceId` is given, strictly
 *  scoped to that space — the brain is always (workspace + space) scoped. */
export async function getBrainEdges(userId: string, workspaceId: string, limit = 500, spaceId?: string | null): Promise<BrainEdgeRow[]> {
  await ensureBrainEdgeSchema();
  return query<BrainEdgeRow>(
    `SELECT src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence, verdict, rationale
       FROM brain_edge
      WHERE user_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR space_id=$3)
      ORDER BY created_at DESC LIMIT ${limit}`,
    [userId, workspaceId, spaceId ?? null],
  );
}

/** Neighbours of a node (both directions), strictly (workspace + space) scoped. Used by the
 *  brain map's node-detail card and chat graph-expansion. `spaceId` null = workspace-wide. */
export async function neighboursOf(userId: string, workspaceId: string, kind: string, id: string, limit = 12, spaceId?: string | null): Promise<BrainEdgeRow[]> {
  await ensureBrainEdgeSchema();
  return query<BrainEdgeRow>(
    `SELECT src_kind, src_id, dst_kind, dst_id, relation, origin, confidence, evidence, verdict, rationale
       FROM brain_edge
      WHERE user_id=$1 AND workspace_id=$2 AND ($5::uuid IS NULL OR space_id=$5)
        AND ((src_kind=$3 AND src_id=$4) OR (dst_kind=$3 AND dst_id=$4))
      ORDER BY confidence DESC NULLS LAST LIMIT ${limit}`,
    [userId, workspaceId, kind, id, spaceId ?? null],
  );
}
