import { query } from '../db';
import { embedTexts } from '../kgEmbed';
import { getSecrets } from '../secrets';
import { MODELS } from '../models/registry';
import { ensureConnectorSchema } from './schema';
import { ensureBrainEdgeSchema, insertEdge } from './brainEdges';
import { queryNearestItems } from './brainVector';

/**
 * Brain-link sweep (Living-Brain Phase C). Computes cross-source associations and stores
 * them as brain_edges. Driven by an EventBridge job (the association twin of kgLink).
 * Order = cheapest + most trustworthy first:
 *   1. PROVENANCE — we created it (action_proposal: meeting → the Jira issue it spawned).
 *   2. REFERENCE  — explicit cross-refs in text ("fixes PROJ-3", "#42").
 *   3. SEMANTIC   — embedding-nearest cross-source items ("related"), bounded.
 * Idempotent; bounded per tick; self-healing.
 */

const WORKSPACE_CAP = 25;
const SEM_BATCH = 24;          // items semantically linked per workspace per tick
const SEM_K = 6;
const SEM_MIN_SIM = 0.74;
const TIME_BUDGET_MS = 40_000;

const JIRA_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const LLM_MEETINGS_PER_TICK = 6;     // meetings LLM-linked per workspace per tick (cost bound)
const LLM_CANDIDATES = 25;

export interface BrainLinkResult { workspaces: number; provenance: number; reference: number; semantic: number; llm: number }

/** Ask the model which tool items a meeting actually relates to (grounded, not fuzzy). */
async function llmLinkMeeting(
  meeting: { title: string | null; body: string | null },
  candidates: Array<{ id: string; source: string; title: string | null }>,
): Promise<Array<{ id: string; relation: string }>> {
  const secrets = await getSecrets();
  if (!secrets.GEMINI_API_KEY || !candidates.length) return [];
  const list = candidates.map((c) => `${c.id} [${c.source}] ${c.title || ''}`).join('\n');
  const sys = `You connect a MEETING to the tracked work items (Jira issues, GitHub PRs/issues) it actually discusses or produced. Be STRICT — only link items the meeting clearly relates to; most meetings link to 0-3 items. Output JSON only: {"links":[{"id": "<candidate id>", "relation": "discussed"|"implements"|"resulted_in"|"related"}]}. Never invent ids; use only ids from the candidate list.`;
  const user = `MEETING:\n${meeting.title || ''}\n${(meeting.body || '').slice(0, 2500)}\n\nCANDIDATE WORK ITEMS (id [source] title):\n${list}`;
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.kgExtract.primary}:generateContent?key=${secrets.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 600 } }),
    });
    const d: any = await r.json();
    if (!r.ok) return [];
    const text = (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
    const parsed = JSON.parse(text);
    const valid = new Set(candidates.map((c) => c.id));
    return (Array.isArray(parsed?.links) ? parsed.links : [])
      .filter((l: any) => valid.has(String(l.id)))
      .map((l: any) => ({ id: String(l.id), relation: ['discussed', 'implements', 'resulted_in', 'related'].includes(l.relation) ? l.relation : 'related' }));
  } catch { return []; }
}

export async function runBrainLink(): Promise<BrainLinkResult> {
  await ensureConnectorSchema();
  await ensureBrainEdgeSchema();
  const started = Date.now();
  const result: BrainLinkResult = { workspaces: 0, provenance: 0, reference: 0, semantic: 0, llm: 0 };

  const wss: Array<{ user_id: string; workspace_id: string }> = await query<{ user_id: string; workspace_id: string }>(
    `SELECT DISTINCT user_id, workspace_id FROM knowledge_item LIMIT ${WORKSPACE_CAP}`,
  ).catch(() => []);

  for (const { user_id: userId, workspace_id: workspaceId } of wss) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    result.workspaces++;

    // Index this workspace's items by (source, source_id) → id, for reference matching.
    const items: Array<{ id: string; source: string; source_id: string; title: string | null; body: string | null }> = await query<{ id: string; source: string; source_id: string; title: string | null; body: string | null }>(
      `SELECT id, source, source_id, title, body FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2`,
      [userId, workspaceId],
    ).catch(() => []);
    // Tool items (non-meeting) are the link candidates for the LLM meeting linker.
    const toolCandidates = items.filter((i) => i.source !== 'meeting').slice(0, LLM_CANDIDATES)
      .map((i) => ({ id: String(i.id), source: i.source, title: i.title }));
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
      const srcById = new Map<string, string>(items.map((i) => [String(i.id), i.source]));
      // Embed non-meeting fresh items for semantic linking (meetings use the LLM linker).
      const nonMeeting = fresh.filter((f) => f.source !== 'meeting');
      const vecById = new Map<string, number[]>();
      if (nonMeeting.length) {
        const vecs = await embedTexts(nonMeeting.map((f) => [f.title, (f.body || '').slice(0, 1500)].filter(Boolean).join('\n'))).catch(() => null);
        if (vecs) nonMeeting.forEach((f, i) => vecById.set(String(f.id), vecs[i]));
      }
      let llmUsed = 0;
      for (const self of fresh) {
        if (Date.now() - started > TIME_BUDGET_MS) break;
        if (self.source === 'meeting') {
          // GROUNDED meeting linking: let the model judge which work items it relates to.
          if (llmUsed < LLM_MEETINGS_PER_TICK && toolCandidates.length) {
            llmUsed++;
            const links = await llmLinkMeeting(self, toolCandidates);
            for (const l of links) {
              if (await insertEdge({ userId, workspaceId, srcKind: 'item', srcId: String(self.id), dstKind: 'item', dstId: l.id, relation: l.relation, origin: 'llm', confidence: 0.9 })) result.llm++;
            }
          } else { continue; }   // leave unmarked → linked on a later tick
        } else {
          const vec = vecById.get(String(self.id));
          const hits = vec ? await queryNearestItems(userId, workspaceId, vec, SEM_K).catch(() => null) : null;
          for (const h of hits || []) {
            if (h.id === String(self.id) || h.similarity < SEM_MIN_SIM) continue;
            const crossSource = (srcById.get(h.id) || h.source) !== self.source;
            if (!crossSource && h.similarity < 0.82) continue;
            if (await insertEdge({ userId, workspaceId, srcKind: 'item', srcId: String(self.id), dstKind: 'item', dstId: h.id, relation: 'related', origin: 'semantic', confidence: h.similarity })) result.semantic++;
          }
        }
        await query(`INSERT INTO brain_link_state (user_id, workspace_id, item_id) VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`, [userId, workspaceId, self.id]).catch(() => {});
      }
    }
  }

  console.log('brain_link', JSON.stringify(result));
  return result;
}
