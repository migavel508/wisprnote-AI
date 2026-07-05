import {
  buildGraphData,
  type MeetingRecord,
  type MeetingEdge,
  type ExtractedRelationship,
  type KGBuildArtifact,
} from './knowledgeGraph.utils';
import type { ServerKgEdge } from '../services/awsService';
import type { BrainNode, BrainLink } from '../services/brainService';

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

/** Is the UNIFIED brain-graph render path enabled? When on, KnowledgePage draws its meeting graph from
 *  the same `brain_edge` data as the brain map (one graph), retiring the legacy `kg_edges` dependency.
 *  Off by default — opt in with VITE_BRAIN_GRAPH=1 after verifying in-app. */
export function isBrainGraphEnabled(): boolean {
  return import.meta.env.VITE_BRAIN_GRAPH === '1';
}

// Brain edge origins → a similarity-ish score + (optional) a relationship type, so the brain's
// meeting↔meeting links slot into the SAME meeting-graph scoring the KG renderer expects. Confirmed
// origins (provenance/reference/llm/entity/topic) outweigh raw semantic — the brain is precision-first.
const BRAIN_ORIGIN_SCORE: Record<string, number> = { provenance: 1.0, reference: 0.95, llm: 0.9, entity: 0.82, topic: 0.8, semantic: 0.62 };
const BRAIN_ORIGIN_REL: Record<string, ExtractedRelationship['relationshipType'] | undefined> = {
  provenance: 'reference', reference: 'reference', llm: 'continuation', entity: 'recurring', topic: 'recurring',
};

/**
 * Build the meeting-graph render artifact from the UNIFIED brain graph (`brain_edge`) instead of the
 * legacy `kg_edges` — so KnowledgePage and the brain map draw from ONE source. Only meeting↔meeting
 * links are used (the meeting graph is meeting-centric); each brain meeting node is mapped back to its
 * `task_id` via `source_id`. Same `KGBuildArtifact` shape + scoring as `buildArtifactFromServerEdges`.
 */
export function buildArtifactFromBrainGraph(kgData: MeetingRecord[], graph: { nodes: BrainNode[]; links: BrainLink[] }): KGBuildArtifact {
  const ids = new Set(kgData.map((m) => m.meetingId));
  const meetingMap = new Map(kgData.map((m) => [m.meetingId, m]));
  // brain node id ('item:123') → meeting task_id (source_id), for meeting nodes present in kgData.
  const nodeToMeeting = new Map<string, string>();
  for (const n of graph.nodes) if (n.source === 'meeting' && n.source_id && ids.has(n.source_id)) nodeToMeeting.set(n.id, n.source_id);

  const relationships: ExtractedRelationship[] = [];
  const sim = new Map<string, Map<string, number>>();
  const addSim = (a: string, b: string, s: number) => { if (!sim.has(a)) sim.set(a, new Map()); const m = sim.get(a)!; m.set(b, Math.max(m.get(b) ?? 0, s)); };
  for (const l of graph.links) {
    const a = nodeToMeeting.get(l.source), b = nodeToMeeting.get(l.target);
    if (!a || !b || a === b) continue;   // meeting↔meeting only
    const score = BRAIN_ORIGIN_SCORE[l.origin] ?? 0.6;
    addSim(a, b, score); addSim(b, a, score);
    const relType = BRAIN_ORIGIN_REL[l.origin];
    if (relType) relationships.push({ fromMeetingId: a, toMeetingId: b, relationshipType: relType, sharedThread: l.rationale || l.relation || '', confidence: (l.origin === 'llm' || l.origin === 'provenance') ? 'high' : 'medium' });
  }

  const relIndex = new Map<string, ExtractedRelationship[]>();
  for (const r of relationships) {
    relIndex.set(r.fromMeetingId, [...(relIndex.get(r.fromMeetingId) || []), r]);
    relIndex.set(r.toMeetingId, [...(relIndex.get(r.toMeetingId) || []), r]);
  }
  const matrix = new Map<string, MeetingEdge[]>();
  for (const a of kgData) {
    const aId = a.meetingId;
    const neighbours = sim.get(aId) || new Map<string, number>();
    const candidates = new Set<string>(neighbours.keys());
    for (const r of relIndex.get(aId) || []) candidates.add(r.fromMeetingId === aId ? r.toMeetingId : r.fromMeetingId);
    const edgesA: MeetingEdge[] = [];
    for (const bId of candidates) {
      if (bId === aId) continue;
      const b = meetingMap.get(bId);
      if (!b) continue;
      const embeddingScore = neighbours.get(bId) ?? 0;
      const pairRels = (relIndex.get(aId) || []).filter((r) => (r.fromMeetingId === aId && r.toMeetingId === bId) || (r.fromMeetingId === bId && r.toMeetingId === aId));
      let contextualScore = 0;
      for (const r of pairRels) contextualScore += (CONFIDENCE_MULTIPLIER[r.confidence] || 1) * (TYPE_MULTIPLIER[r.relationshipType] || 0.5);
      const totalScore = embeddingScore * 5 + contextualScore;
      if (totalScore >= EDGE_MIN_SCORE) edgesA.push({ meetingId: bId, meeting: b, embeddingScore, contextualScore, totalScore, relationships: pairRels });
    }
    edgesA.sort((x, y) => y.totalScore - x.totalScore);
    matrix.set(aId, edgesA.slice(0, TOP_K_EDGES));
  }
  const { nodes, links } = buildGraphData(kgData, new Map(), matrix, relationships, null);
  return { nodes, links, meetingEdgeMatrix: matrix, embeddings: new Map(), relationships };
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
