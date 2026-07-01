import { query } from '../db';
import { embedTexts } from '../kgEmbed';
import { getSecrets } from '../secrets';
import { MODELS } from '../models/registry';
import { ensureConnectorSchema } from './schema';
import { ensureBrainEdgeSchema, insertEdge } from './brainEdges';
import { insertReasoning, type Verdict } from './brainReasoning';
import { queryNearestItems } from './brainVector';
import { enrichCommit } from './github/enrich';

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
const GH_XSRC_SIM = 0.45;      // recall floor for a commit→meeting/ticket link (code↔prose is weak)
const GH_XSRC_CAP = 2;         // a commit links to at most its 1-2 most-related meeting/ticket
const TIME_BUDGET_MS = 32_000;   // stay well under the 60s Lambda cap even with LLM calls

const JIRA_KEY = /\b([A-Z][A-Z0-9]+-\d+)\b/g;
const LLM_INTENT_PER_TICK = 8;       // intents (meetings + Jira tasks) verdicted per workspace per tick
const CAND_K = 6;                    // top-K candidate work items per intent (cost bound)
const CAND_MIN_SIM = 0.35;           // candidate-gen floor — LOW on purpose: commit fingerprints
                                     // (filenames/stats) match prose weakly, so favour recall and
                                     // let the strict Sonnet verdict prune. CAND_K still caps cost.

export interface BrainLinkResult { workspaces: number; provenance: number; reference: number; semantic: number; llm: number }

const VERDICT_SYS = `You are a technical lead reviewing work against intent. You are given an INTENT — a MEETING (a decision/discussion), a JIRA TASK (work to be done), or a DEV SESSION (a Claude Code / Codex AI coding session that DID work) — and candidate ITEMS (meetings, Jira issues, GitHub commits/PRs, or dev sessions) that may relate to it. JUDGE which candidates genuinely relate to the intent. When the intent is a DEV SESSION, the candidates are the meeting/task that planned it and the commits it produced — judge whether each is about the SAME work. Be STRICT — only include items that clearly relate; most intents relate to 0-4 items.
For each related item give:
- "relation": "discussed"|"implements"|"resulted_in"|"related"
- "verdict": how well the work item matches what the intent wanted — "aligned" (does what was asked), "partial" (related but incomplete/differs somewhat), "divergent" (claims to relate but the actual work goes a different direction than intended), "unrelated" (not actually connected — drop it).
- "rationale": ONE sentence: what the intent wanted vs what the item actually is/does (cite specifics — for commits, reason about the REAL code change described, not the commit message).
- For a GitHub commit/PR ALSO add a co-architect read of the code itself:
  - "assessment": "sound" (well-structured, no concern) | "concern" (works but has a design smell — coupling, missing tests/error-handling, scope creep) | "risk" (a real architectural problem — security, scalability, wrong layer).
  - "suggestion": ONE concrete sentence proposing a better approach or what to watch — empty "" if assessment is "sound". Be specific and helpful to the developer.
Output JSON only: {"links":[{"id","relation","verdict","rationale","assessment","suggestion"}]}. Use only ids from the candidate list; never invent.`;

/** Pull the first {...} JSON object out of a model response (handles ```json fences / prose). */
function extractJson(text: string): any | null {
  const s = text.indexOf('{'); const e = text.lastIndexOf('}');
  if (s < 0 || e <= s) return null;
  try { return JSON.parse(text.slice(s, e + 1)); } catch { return null; }
}

async function callAnthropic(model: string, sys: string, user: string, key: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12_000);
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 1600, system: sys, messages: [{ role: 'user', content: user }] }),
      signal: ctrl.signal,
    });
    if (!r.ok) return '';
    const d: any = await r.json();
    return (Array.isArray(d?.content) ? d.content : []).map((b: any) => b?.text ?? '').join('').trim();
  } catch { return ''; } finally { clearTimeout(timer); }
}

async function callGemini(model: string, sys: string, user: string, key: string): Promise<string> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9_000);   // fast-fail: the verdict must never block the build
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 2500 } }),
      signal: ctrl.signal,
    });
    if (!r.ok) return '';
    const d: any = await r.json();
    return (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
  } catch { return ''; } finally { clearTimeout(timer); }
}

/** TIER 3 — the alignment VERDICT. One batched call per intent (meeting OR Jira task) over
 *  its top-K candidates. Quality-first model (Sonnet primary → Gemini 3.1 Pro fallback;
 *  brainVerdict registry). Candidates carry the REAL diff summary (Tier 2) for commits, so
 *  the judgment is grounded in actual code, not fluff messages. */
async function judgeAlignment(
  intent: { kind: 'MEETING' | 'JIRA TASK' | 'DEV SESSION'; title: string | null; body: string | null },
  candidates: Array<{ id: string; source: string; text: string }>,
): Promise<Array<{ id: string; relation: string; verdict: Verdict; rationale: string; assessment: string | null; suggestion: string | null }>> {
  if (!candidates.length) return [];
  const secrets = await getSecrets();
  const list = candidates.map((c) => `${c.id} [${c.source}] ${(c.text || '').slice(0, 240)}`).join('\n');
  const user = `INTENT (${intent.kind}):\n${intent.title || ''}\n${(intent.body || '').slice(0, 2500)}\n\nCANDIDATE WORK ITEMS (id [source] description):\n${list}`;

  let text = '';
  if (secrets.ANTHROPIC_API_KEY) text = await callAnthropic(MODELS.brainVerdict.primary, VERDICT_SYS, user, secrets.ANTHROPIC_API_KEY);
  if (!text && secrets.GEMINI_API_KEY) text = await callGemini(MODELS.brainVerdict.fallbacks?.[0] || 'gemini-3.1-pro', VERDICT_SYS, user, secrets.GEMINI_API_KEY);
  if (!text) return [];

  const parsed = extractJson(text);
  if (!parsed) return [];
  const valid = new Set(candidates.map((c) => c.id));
  const verdicts = ['aligned', 'partial', 'divergent', 'unrelated'];
  const assessments = ['sound', 'concern', 'risk'];
  return (Array.isArray(parsed?.links) ? parsed.links : [])
    .filter((l: any) => valid.has(String(l.id)) && l.verdict !== 'unrelated')
    .map((l: any) => ({
      id: String(l.id),
      relation: ['discussed', 'implements', 'resulted_in', 'related'].includes(l.relation) ? l.relation : 'related',
      verdict: (verdicts.includes(l.verdict) ? l.verdict : 'partial') as Verdict,
      rationale: String(l.rationale || '').slice(0, 300),
      assessment: assessments.includes(l.assessment) ? l.assessment : null,
      suggestion: l.suggestion ? String(l.suggestion).slice(0, 300) : null,
    }));
}

export interface BrainLinkOpts {
  workspaceId?: string;    // scope to one workspace (the on-demand sync-now path)
  llmBudget?: number;      // verdict calls allowed per workspace (0 = cheap links only — fast path)
  timeBudgetMs?: number;   // override the default sweep budget
}

export async function runBrainLink(opts?: BrainLinkOpts): Promise<BrainLinkResult> {
  await ensureConnectorSchema();
  await ensureBrainEdgeSchema();
  const started = Date.now();
  const result: BrainLinkResult = { workspaces: 0, provenance: 0, reference: 0, semantic: 0, llm: 0 };
  const llmBudget = opts?.llmBudget ?? LLM_INTENT_PER_TICK;
  const timeBudget = opts?.timeBudgetMs ?? TIME_BUDGET_MS;

  const wss: Array<{ user_id: string; workspace_id: string }> = opts?.workspaceId
    ? await query<{ user_id: string; workspace_id: string }>(`SELECT DISTINCT user_id, workspace_id FROM knowledge_item WHERE workspace_id=$1`, [opts.workspaceId]).catch(() => [])
    : await query<{ user_id: string; workspace_id: string }>(`SELECT DISTINCT user_id, workspace_id FROM knowledge_item LIMIT ${WORKSPACE_CAP}`).catch(() => []);

  for (const { user_id: userId, workspace_id: workspaceId } of wss) {
    if (Date.now() - started > timeBudget) break;
    result.workspaces++;

    // Index this workspace's items by (source, source_id) → id, for reference matching.
    type Item = { id: string; source: string; source_id: string; type: string | null; title: string | null; body: string | null; enriched_summary: string | null; fingerprint: string | null; folder_id: string | null; space_id: string | null };
    const items: Item[] = await query<any>(
      `SELECT id, source, source_id, type, title, body, enriched_summary, fingerprint, folder_id, space_id FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2`,
      [userId, workspaceId],
    ).catch(() => []);
    const byKey = new Map(items.map((i) => [`${i.source}:${i.source_id}`, String(i.id)]));
    const itemById = new Map(items.map((i) => [String(i.id), i]));

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
          const sp = itemById.get(meetingItemId)?.space_id ?? itemById.get(jiraItemId)?.space_id ?? null;
          if (await insertEdge({ userId, workspaceId, spaceId: sp, srcKind: 'item', srcId: meetingItemId, dstKind: 'item', dstId: jiraItemId, relation: 'spawned', origin: 'provenance', confidence: 1, evidence: `created ${key}` })) result.provenance++;
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
            if (await insertEdge({ userId, workspaceId, spaceId: it.space_id ?? itemById.get(target)?.space_id ?? null, srcKind: 'item', srcId: String(it.id), dstKind: 'item', dstId: target, relation: 'references', origin: 'reference', confidence: 0.95, evidence: m[1] })) result.reference++;
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
              if (await insertEdge({ userId, workspaceId, spaceId: it.space_id ?? itemById.get(target)?.space_id ?? null, srcKind: 'item', srcId: String(it.id), dstKind: 'item', dstId: target, relation: 'references', origin: 'reference', confidence: 0.9, evidence: `#${m[1]}` })) result.reference++;
            }
          }
        }
      }
    }

    // 3) SEMANTIC — embedding-nearest items not yet linked (bounded). Cross-source first.
    if (Date.now() - started > timeBudget) continue;
    // Fetch meetings and non-meetings SEPARATELY so a flood of new items (e.g. commits)
    // never starves the meeting linker — meetings are the spine of the brain.
    type Fresh = { id: string; source: string; title: string | null; body: string | null };
    const freshMeetings: Fresh[] = await query<Fresh>(
      `SELECT k.id, k.source, k.title, k.body FROM knowledge_item k
        WHERE k.user_id=$1 AND k.workspace_id=$2 AND k.source='meeting'
          AND NOT EXISTS (SELECT 1 FROM brain_link_state s WHERE s.user_id=$1 AND s.workspace_id=$2 AND s.item_id=k.id AND s.linked_at >= k.synced_at)
        ORDER BY k.occurred_at DESC NULLS LAST LIMIT ${LLM_INTENT_PER_TICK}`,
      [userId, workspaceId],
    ).catch(() => []);
    // Jira TASKS are intents too (the middle hop) — fetch them on their own so a flood of
    // commits never starves the meeting→task→commit lineage.
    const freshTasks: Fresh[] = await query<Fresh>(
      `SELECT k.id, k.source, k.title, k.body FROM knowledge_item k
        WHERE k.user_id=$1 AND k.workspace_id=$2 AND k.source='jira'
          AND NOT EXISTS (SELECT 1 FROM brain_link_state s WHERE s.user_id=$1 AND s.workspace_id=$2 AND s.item_id=k.id AND s.linked_at >= k.synced_at)
        ORDER BY k.occurred_at DESC NULLS LAST LIMIT ${LLM_INTENT_PER_TICK}`,
      [userId, workspaceId],
    ).catch(() => []);
    const freshOther: Fresh[] = await query<Fresh>(
      `SELECT k.id, k.source, k.title, k.body FROM knowledge_item k
        WHERE k.user_id=$1 AND k.workspace_id=$2 AND k.source NOT IN ('meeting','jira')
          AND NOT EXISTS (SELECT 1 FROM brain_link_state s WHERE s.user_id=$1 AND s.workspace_id=$2 AND s.item_id=k.id AND s.linked_at >= k.synced_at)
        LIMIT ${SEM_BATCH}`,
      [userId, workspaceId],
    ).catch(() => []);
    // Tasks FIRST: they're few and form the middle hop (task→commit). Processing them ahead
    // of the many meetings guarantees the full meeting→task→commit chain forms each tick
    // (once linked they drop out, so meetings then get the full budget on later ticks).
    const fresh = [...freshTasks, ...freshMeetings, ...freshOther];
    if (fresh.length) {
      // Embed ALL fresh items in ONE batch call (not per-intent) — the intent pipeline below reads its
      // self-vector from here instead of re-embedding each meeting/ticket individually. That per-item
      // re-embed was hammering the embedding API (429s → retries) and made bulk brain-building crawl.
      const vecById = new Map<string, number[]>();
      {
        const vecs = await embedTexts(fresh.map((f) => [f.title, (f.body || '').slice(0, 1500)].filter(Boolean).join('\n'))).catch(() => null);
        if (vecs) fresh.forEach((f, i) => vecById.set(String(f.id), vecs[i]));
      }
      let llmUsed = 0;
      for (const self of fresh) {
        if (Date.now() - started > timeBudget) break;
        // INTENT linking — meetings AND Jira tasks both get the grounded verdict pipeline,
        // building the real lineage: meeting → Jira task → GitHub commit, with a reasoning
        // verdict ON EACH LINE.
        //   1. CANDIDATES (cheap): embed the intent, ANN-nearest → top-K work items. For a
        //      Jira task we restrict candidates to CODE (github), so the chain is task→commit.
        //   2. LAZY ENRICH (Tier 2): only these K candidate commits pay the diff→summary cost
        //      — i.e. we read the actual commit diff to judge whether it implements the intent.
        //   3. VERDICT (Tier 3): ONE batched Sonnet→Gemini call → verdict+rationale stored
        //      DIRECTLY on the edge (the brain map colours + explains the line).
        if (self.source === 'meeting' || self.source === 'jira' || self.source === 'claude-code' || self.source === 'codex') {
          // NOTE: connectivity (semantic, turbopuffer) ALWAYS runs below — it does NOT depend on the
          // LLM. Only the VERDICT (quality colouring) is budget-gated, so a slow/unavailable verdict
          // model never blocks the brain from connecting its nodes.
          const isTask = self.source === 'jira';
          const isSession = self.source === 'claude-code' || self.source === 'codex';
          // FOLDER SCOPING — but asymmetric, because a meeting and a task have different shapes:
          //  • A JIRA TASK is single-project: its implementing commits MUST be in its own folder
          //    → hard folder gate (prevents task→wrong-repo links).
          //  • A MEETING can span projects (or be left unfiled): its CONTENT decides which
          //    projects it relates to. So we do NOT gate a meeting to one folder — candidates
          //    come from all projects and each resulting link is attributed to the CANDIDATE's
          //    project. Cross-project + unfiled meetings therefore link to every project they
          //    actually discuss; the similarity floor + strict verdict keep out projects they don't.
          const intentFolder = itemById.get(String(self.id))?.folder_id ?? null;
          // A DEV SESSION (Claude Code / Codex) is its own intent: it links OUTWARD to the work it
          // relates to — the meeting that planned it, the Jira task it implemented, the commits it
          // produced. (Modelling it as an intent — not a candidate — means a freshly-synced session
          // links to ALREADY-linked meetings/tasks without re-running them.)
          // A MEETING links to related MEETINGS too (so a space of related meetings shows
          // interconnections, not just isolated nodes) plus Jira/GitHub. A Jira TASK links to the
          // MEETING it came from (a ticket auto-suggested from a meeting MUST connect back to it) AND
          // the commits that implement it. A dev session links to all three. (Meetings are exempt from
          // the per-folder gate below, so a task finds its source meeting even when unfiled.)
          const candSources = isSession ? ['meeting', 'jira', 'github'] : isTask ? ['meeting', 'github'] : ['meeting', 'jira', 'github'];
          const candK = (isTask || isSession) ? CAND_K + 4 : 10;   // room for both the source meeting + commits
          const mv = vecById.get(String(self.id));   // batch-embedded above — no per-intent re-embed
          const hits = mv ? await queryNearestItems(userId, workspaceId, mv, candK * 4, candSources).catch(() => null) : null;
          const candIds: string[] = (hits || [])
            .filter((h) => {
              if (h.id === String(self.id) || h.similarity < CAND_MIN_SIM) return false;
              const it = itemById.get(h.id);
              if (!it) return false;
              // Single-project intents (task, session) restrict CODE/TICKET candidates to their own
              // folder; meetings span projects and are exempt (an unfiled meeting may match either).
              if ((isTask || isSession) && it.source !== 'meeting' && (it.folder_id ?? null) !== intentFolder) return false;
              return true;
            })
            .slice(0, candK)
            .map((h) => h.id);
          // GUARANTEE the project's OWN items are judged. A dev session and the meeting / Jira task /
          // commits FILED IN ITS FOLDER are the same project, so they must always be candidates —
          // otherwise an ad-hoc similarity search can rank cross-project meetings higher and the
          // session never even considers its own project's meeting. The strict verdict still decides.
          if (isSession && intentFolder) {
            for (const [iid, it] of itemById) {
              if (candIds.length >= candK + 8) break;
              if (iid === String(self.id) || candIds.includes(iid)) continue;
              if ((it.folder_id ?? null) !== intentFolder) continue;
              if (it.source !== 'meeting' && it.source !== 'jira' && it.source !== 'github') continue;
              candIds.push(iid);
            }
          }
          const cands: Array<{ id: string; source: string; text: string }> = [];
          for (const cid of candIds) {
            const it = itemById.get(cid);
            if (!it) continue;
            let text = it.enriched_summary || it.fingerprint || it.body || it.title || '';
            if (it.type === 'commit' && !it.enriched_summary) {
              const s = await enrichCommit(userId, workspaceId, cid).catch(() => null);   // Tier 2: read the real diff
              if (s) text = s;
            }
            cands.push({ id: cid, source: it.source, text });
          }
          // VERDICT (Tier 3, quality colouring) — BUDGET-GATED + best-effort. A slow/credit-less
          // verdict model never blocks the connectivity below; it just leaves the edge uncoloured.
          const verdictTargets = new Set<string>();
          if (llmUsed < llmBudget) {
            llmUsed++;
            const links = await judgeAlignment({ kind: isSession ? 'DEV SESSION' : isTask ? 'JIRA TASK' : 'MEETING', title: self.title, body: self.body }, cands);
            // Cap SAME-SOURCE links (e.g. meeting↔meeting) to the strongest few — interconnected, not a blob.
            const SAME_SOURCE_CAP = 3;
            let sameSourceMade = 0;
            for (const l of links) {
              const sameSrc = itemById.get(l.id)?.source === self.source;
              if (sameSrc && sameSourceMade >= SAME_SOURCE_CAP) continue;
              const inserted = await insertEdge({ userId, workspaceId, spaceId: itemById.get(String(self.id))?.space_id ?? itemById.get(l.id)?.space_id ?? null, srcKind: 'item', srcId: String(self.id), dstKind: 'item', dstId: l.id, relation: l.relation, origin: 'llm', confidence: 0.9, evidence: l.verdict, verdict: l.verdict, rationale: l.rationale });
              if (inserted) { result.llm++; if (sameSrc) sameSourceMade++; }
              verdictTargets.add(l.id);
              if (!isTask && !isSession) await insertReasoning({ userId, workspaceId, meetingId: String(self.id), implId: l.id, verdict: l.verdict, rationale: l.rationale, tags: [l.verdict, l.relation] }).catch(() => {});
              if (l.assessment && itemById.get(l.id)?.type === 'commit') {
                await query(`UPDATE knowledge_item SET advisory_assessment=$2, advisory_note=$3 WHERE id=$1`, [l.id, l.assessment, l.suggestion]).catch(() => {});
              }
            }
          }
          // CONNECTIVITY (semantic, turbopuffer) — ALWAYS runs (no LLM), so every meeting/ticket links
          // to its NEAREST related items even when the verdict is unavailable. Capped + floored — enough
          // that no node floats alone, never enough to re-form a blob. Skips pairs the verdict coloured.
          let fb = 0;
          for (const h of (hits || [])) {
            if (fb >= 2) break;
            if (h.id === String(self.id) || h.similarity < 0.40 || verdictTargets.has(h.id)) continue;
            const hit = itemById.get(h.id);
            if (!hit) continue;
            if ((isTask || isSession) && hit.source !== 'meeting' && (hit.folder_id ?? null) !== intentFolder) continue;
            if (await insertEdge({ userId, workspaceId, spaceId: itemById.get(String(self.id))?.space_id ?? hit.space_id ?? null, srcKind: 'item', srcId: String(self.id), dstKind: 'item', dstId: h.id, relation: 'related', origin: 'semantic', confidence: h.similarity })) { result.semantic++; fb++; }
          }
        } else {
          // A GitHub commit links CROSS-SOURCE ONLY — to the Jira ticket / meeting it relates to,
          // NEVER to other commits (commit↔commit just builds a redundant blob). Commit diffs match
          // meeting/ticket PROSE weakly, so use a recall floor and cap each commit to its 1-2
          // most-related items — enough to attach it to the work, never enough to re-form a blob.
          const selfFolder = itemById.get(String(self.id))?.folder_id ?? null;
          const vec = vecById.get(String(self.id));
          const hits = vec ? await queryNearestItems(userId, workspaceId, vec, SEM_K * 4, ['meeting', 'jira']).catch(() => null) : null;
          let made = 0;
          for (const h of hits || []) {
            if (made >= GH_XSRC_CAP) break;
            if (h.id === String(self.id) || h.similarity < GH_XSRC_SIM) continue;
            const hit = itemById.get(h.id);
            if (!hit || (hit.folder_id ?? null) !== selfFolder) continue;   // same project only
            if (hit.source === self.source) continue;                       // cross-source only
            if (await insertEdge({ userId, workspaceId, spaceId: itemById.get(String(self.id))?.space_id ?? hit.space_id ?? null, srcKind: 'item', srcId: String(self.id), dstKind: 'item', dstId: h.id, relation: 'related', origin: 'semantic', confidence: h.similarity })) { result.semantic++; made++; }
          }
        }
        await query(`INSERT INTO brain_link_state (user_id, workspace_id, item_id) VALUES ($1,$2,$3) ON CONFLICT (user_id, workspace_id, item_id) DO UPDATE SET linked_at=NOW()`, [userId, workspaceId, self.id]).catch(() => {});
      }
    }
  }

  console.log('brain_link', JSON.stringify(result));
  return result;
}
