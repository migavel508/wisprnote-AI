import {
  buildGraphData,
  type MeetingRecord,
  type MeetingEdge,
  type ExtractedRelationship,
  type KGBuildArtifact,
} from './knowledgeGraph.utils';
import type { ServerKgEdge } from '../services/awsService';

/**
 * Build the knowledge-graph render artifact from PRECOMPUTED server edges
 * (Stage C output), with ZERO client-side embedding or LLM work.
 *
 * The server already did the expensive part — semantic neighbours (similarity)
 * and the reasoning-node relationships. Here we just assemble them into the same
 * `KGBuildArtifact` the client renderer expects, reusing `buildGraphData`. We
 * pass an empty embeddings map; `buildGraphData` tolerates that (topic grouping
 * falls back to names), so nothing is recomputed in the browser.
 *
 * Mirrors the scoring of `buildMeetingEdgeMatrix`, but uses the server's stored
 * cosine `similarity` as the embedding score instead of recomputing it.
 */

/** Is the server-side KG render path enabled? (Off by default — opt in after verifying in-app.) */
export function isServerKgEnabled(): boolean {
  return import.meta.env.VITE_SERVER_KG_GRAPH === '1';
}

// Kept in sync with knowledgeGraph.utils.ts (module-private there).
const EDGE_MIN_SCORE = 0.5;
const TOP_K_EDGES = 5;
const CONFIDENCE_MULTIPLIER: Record<string, number> = { high: 3, medium: 1.5, low: 0.5 };
const TYPE_MULTIPLIER: Record<string, number> = {
  continuation: 1.2, resolution: 1.0, escalation: 0.9, recurring: 0.6, reference: 0.4,
};

export function buildArtifactFromServerEdges(kgData: MeetingRecord[], edges: ServerKgEdge[]): KGBuildArtifact {
  const ids = new Set(kgData.map((m) => m.meetingId));
  const meetingMap = new Map(kgData.map((m) => [m.meetingId, m]));
  const valid = (e: ServerKgEdge) => ids.has(e.from_task) && ids.has(e.to_task) && e.from_task !== e.to_task;

  // Relationships (the reasoning-node output).
  const relationships: ExtractedRelationship[] = edges
    .filter((e) => e.relationship_type && valid(e))
    .map((e) => ({
      fromMeetingId: e.from_task,
      toMeetingId: e.to_task,
      relationshipType: e.relationship_type as ExtractedRelationship['relationshipType'],
      sharedThread: e.shared_thread || '',
      confidence: (e.confidence as ExtractedRelationship['confidence']) || 'medium',
    }));

  // Undirected similarity neighbour map (max similarity per pair).
  const sim = new Map<string, Map<string, number>>();
  const addSim = (a: string, b: string, s: number) => {
    if (!sim.has(a)) sim.set(a, new Map());
    const m = sim.get(a)!;
    m.set(b, Math.max(m.get(b) ?? 0, s));
  };
  for (const e of edges) {
    if (e.similarity == null || !valid(e)) continue;
    addSim(e.from_task, e.to_task, e.similarity);
    addSim(e.to_task, e.from_task, e.similarity);
  }

  // Relationship index by meeting.
  const relIndex = new Map<string, ExtractedRelationship[]>();
  for (const r of relationships) {
    relIndex.set(r.fromMeetingId, [...(relIndex.get(r.fromMeetingId) || []), r]);
    relIndex.set(r.toMeetingId, [...(relIndex.get(r.toMeetingId) || []), r]);
  }

  // Build the per-meeting edge matrix (same scoring as buildMeetingEdgeMatrix).
  const matrix = new Map<string, MeetingEdge[]>();
  for (const a of kgData) {
    const aId = a.meetingId;
    const neighbours = sim.get(aId) || new Map<string, number>();
    const candidates = new Set<string>(neighbours.keys());
    for (const r of relIndex.get(aId) || []) {
      candidates.add(r.fromMeetingId === aId ? r.toMeetingId : r.fromMeetingId);
    }

    const edgesA: MeetingEdge[] = [];
    for (const bId of candidates) {
      if (bId === aId) continue;
      const b = meetingMap.get(bId);
      if (!b) continue;
      const embeddingScore = neighbours.get(bId) ?? 0;
      const pairRels = (relIndex.get(aId) || []).filter(
        (r) =>
          (r.fromMeetingId === aId && r.toMeetingId === bId) ||
          (r.fromMeetingId === bId && r.toMeetingId === aId),
      );
      let contextualScore = 0;
      for (const r of pairRels) {
        contextualScore += (CONFIDENCE_MULTIPLIER[r.confidence] || 1) * (TYPE_MULTIPLIER[r.relationshipType] || 0.5);
      }
      const totalScore = embeddingScore * 5 + contextualScore;
      if (totalScore >= EDGE_MIN_SCORE) {
        edgesA.push({ meetingId: bId, meeting: b, embeddingScore, contextualScore, totalScore, relationships: pairRels });
      }
    }
    edgesA.sort((x, y) => y.totalScore - x.totalScore);
    matrix.set(aId, edgesA.slice(0, TOP_K_EDGES));
  }

  const { nodes, links } = buildGraphData(kgData, new Map(), matrix, relationships, null);
  return { nodes, links, meetingEdgeMatrix: matrix, embeddings: new Map(), relationships };
}
