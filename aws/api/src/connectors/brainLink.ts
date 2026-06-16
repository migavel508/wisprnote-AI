import { query } from '../db';
import { embedTexts } from '../kgEmbed';
import { ensureConnectorSchema } from './schema';
import { ensureBrainEdgeSchema, insertEdge } from './brainEdges';
import { queryNearestItems } from './brainVector';

/**
 * Brain-link sweep (Living-Brain Phase C). Computes cross-source associations and stores
 * them as brain_edges. Driven by an EventBridge job (the association twin of kgLink).
 * Order = cheapest + most trustworthy first:
 *   1. PROVENANCE — we created it (action_proposal: meeting → the Jira issue it spawned).
 *   2. REFERENCE  — explicit cross-refs in text ("fixes SCRUM-3", "#42").
 *   3. SEMANTIC   — embedding-nearest cross-source items ("related"), bounded.
 * Idempotent; bounded per tick; self-healing.
 */

const WORKSPACE_CAP = 25;
const SEM_BATCH = 24;          // items semantically linked per workspace per tick
const SEM_K = 6;
const SEM_MIN_SIM = 0.74;
const TIME_BUDGET_MS = 40_000;

const JIRA_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;

export interface BrainLinkResult { workspaces: number; provenance: number; reference: number; semantic: number }

export async function runBrainLink(): Promise<BrainLinkResult> {
  await ensureConnectorSchema();
  await ensureBrainEdgeSchema();
  const started = Date.now();
  const result: BrainLinkResult = { workspaces: 0, provenance: 0, reference: 0, semantic: 0 };

  const wss: Array<{ user_id: string; workspace_id: string }> = await query<{ user_id: string; workspace_id: string }>(
    `SELECT DISTINCT user_id, workspace_id FROM knowledge_item LIMIT ${WORKSPACE_CAP}`,
  ).catch(() => []);

  for (const { user_id: userId, workspace_id: workspaceId } of wss) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    result.workspaces++;

    // Index this workspace's items by (source, source_id) → id, for reference matching.
    const items: Array<{ id: string; source: string; source_id: string; body: string | null }> = await query<{ id: string; source: string; source_id: string; body: string | null }>(
      `SELECT id, source, source_id, body FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2`,
      [userId, workspaceId],
    ).catch(() => []);
    const byKey = new Map(items.map((i) => [`${i.source}:${i.source_id}`, String(i.id)]));

    // 1) PROVENANCE — meeting → the Jira issue the agent created from it.
    try {
      const prov: Array<{ source_meeting_id: string; result: any }> = await query<{ source_meeting_id: string; result: any }>(
        `SELECT source_meeting_id, result FROM action_proposal
          WHERE user_id=$1 AND workspace_id=$2 AND status='executed' AND source_meeting_id IS NOT NULL`,
        [userId, workspaceId],
      ).catch(() => []);
      for (const p of prov) {
        const key = p.result?.issueKey;
        const jiraItemId = key ? byKey.get(`jira:${key}`) : null;
        const meetingItemId = p.source_meeting_id ? byKey.get(`meeting:${p.source_meeting_id}`) : null;
        if (meetingItemId && jiraItemId) {
          if (await insertEdge({ userId, workspaceId, srcKind: 'item', srcId: meetingItemId, dstKind: 'item', dstId: jiraItemId, relation: 'spawned', origin: 'provenance', confidence: 1, evidence: `created ${key}` })) result.provenance++;
        }
      }
    } catch { /* best-effort */ }

    // 2) REFERENCE — explicit cross-refs inside item bodies.
    for (const it of items) {
      const body = it.body || '';
      // GitHub/anything → Jira key
      if (it.source !== 'jira') {
        for (const m of body.matchAll(JIRA_KEY)) {
          const target = byKey.get(`jira:${m[1]}`);
          if (target && target !== String(it.id)) {
            if (await insertEdge({ userId, workspaceId, srcKind: 'item', srcId: String(it.id), dstKind: 'item', dstId: target, relation: 'references', origin: 'reference', confidence: 0.95, evidence: m[1] })) result.reference++;
          }
        }
      }
      // GitHub → GitHub #num in the same repo
      if (it.source === 'github') {
        const repo = (it.source_id.match(/^([^#]+)#/) || [])[1];
        if (repo) {
          for (const m of body.matchAll(/#(\d+)\b/g)) {
            const target = byKey.get(`github:${repo}#${m[1]}`);
            if (target && target !== String(it.id)) {
              if (await insertEdge({ userId, workspaceId, srcKind: 'item', srcId: String(it.id), dstKind: 'item', dstId: target, relation: 'references', origin: 'reference', confidence: 0.9, evidence: `#${m[1]}` })) result.reference++;
            }
          }
        }
      }
    }

    // 3) SEMANTIC — embedding-nearest items not yet linked (bounded). Cross-source first.
    if (Date.now() - started > TIME_BUDGET_MS) continue;
    const fresh: Array<{ id: string; source: string; title: string | null; body: string | null }> = await query<{ id: string; source: string; title: string | null; body: string | null }>(
      `SELECT k.id, k.source, k.title, k.body FROM knowledge_item k
        WHERE k.user_id=$1 AND k.workspace_id=$2
          AND NOT EXISTS (SELECT 1 FROM brain_link_state s WHERE s.user_id=$1 AND s.workspace_id=$2 AND s.item_id=k.id)
        LIMIT ${SEM_BATCH}`,
      [userId, workspaceId],
    ).catch(() => []);
    if (fresh.length) {
      const vecs = await embedTexts(fresh.map((f) => [f.title, (f.body || '').slice(0, 1500)].filter(Boolean).join('\n'))).catch(() => null);
      if (vecs) {
        const srcById = new Map(items.map((i) => [String(i.id), i.source]));
        for (let i = 0; i < fresh.length; i++) {
          const self = fresh[i];
          const hits = await queryNearestItems(userId, workspaceId, vecs[i], SEM_K).catch(() => null);
          for (const h of hits || []) {
            if (h.id === String(self.id) || h.similarity < SEM_MIN_SIM) continue;
            const crossSource = (srcById.get(h.id) || h.source) !== self.source;
            // keep cross-source related links (the brain's value) + very-strong same-source
            if (!crossSource && h.similarity < 0.82) continue;
            if (await insertEdge({ userId, workspaceId, srcKind: 'item', srcId: String(self.id), dstKind: 'item', dstId: h.id, relation: 'related', origin: 'semantic', confidence: h.similarity })) result.semantic++;
          }
          await query(`INSERT INTO brain_link_state (user_id, workspace_id, item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, workspaceId, self.id]).catch(() => {});
        }
      }
    }
  }

  console.log('brain_link', JSON.stringify(result));
  return result;
}
