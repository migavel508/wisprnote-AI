import { query, queryOne } from '../db';
import { ACCOUNT_SCOPE } from './schema';
import { semanticSearchItems, expandWithNeighbours } from './embed';
import { getSecrets } from '../secrets';
import { MODELS } from '../models/registry';
import { recordProviderUsage } from '../usage';

/**
 * MEMSCORE — the brain's benchmark harness (Memory-OS plan, Phase 1).
 *
 * Turns "is the brain's memory good?" from a vibe into a NUMBER, so every later storage/retrieval
 * change (one-index, chunking, graph-aware retrieval) is A/B'd against a baseline and only ships if
 * the score goes UP. Mirrors the Ingest→Index→Search→Answer→Evaluate→Report pipeline: Ingest/Index
 * already happened for a live space, so the harness runs SEARCH → (optional) ANSWER → EVALUATE → REPORT
 * over a golden Q&A set.
 *
 * COST DISCIPLINE: the PRIMARY signal — did SEARCH surface the memory that holds the answer? — is
 * scored deterministically (just check whether an expected source id is in the retrieved set). That
 * is what phases 2-4 actually change, and it costs only the query embedding (cheap). The LLM ANSWER +
 * JUDGE layer is OPT-IN (`withAnswer`) and runs on the cheap Flash tier, metered under feature='brain'.
 */

let ready: Promise<void> | null = null;
export function ensureMemScoreSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS mem_benchmark (
          id BIGSERIAL PRIMARY KEY,
          space_id UUID NOT NULL,
          question TEXT NOT NULL,
          expected_answer TEXT,
          expected_sources JSONB,        -- [{source, source_id}] the answer should be grounded in
          category TEXT,                 -- status | decision | gap | topic
          origin TEXT NOT NULL DEFAULT 'auto',   -- 'auto' (generated) | 'paraphrase' (held-out) | 'manual'
          paraphrase_of TEXT,            -- for a paraphrase row: the original auto question it rewords
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE (space_id, question)
        )`);
      await query(`ALTER TABLE mem_benchmark ADD COLUMN IF NOT EXISTS paraphrase_of TEXT`);
      await query(`
        CREATE TABLE IF NOT EXISTS mem_score_run (
          id BIGSERIAL PRIMARY KEY,
          space_id UUID,
          ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          config TEXT,                   -- label for the retrieval config under test
          questions INT,
          retrieval_recall REAL,         -- fraction of Qs where an expected source was retrieved
          retrieval_mrr REAL,            -- mean reciprocal rank of the first expected source
          answer_accuracy REAL,          -- fraction judged correct/partial (null if retrieval-only)
          avg_latency_ms REAL,
          total_tokens INT,
          memscore REAL,                 -- weighted composite (0-100)
          detail JSONB
        )`);
      await query(`CREATE INDEX IF NOT EXISTS mem_score_run_space_idx ON mem_score_run (space_id, ran_at DESC)`);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

const norm = (s: string): string => String(s || '').toLowerCase().replace(/\s+/g, ' ').trim();

/**
 * SEED the golden set for a space DETERMINISTICALLY from its own history ($0, no LLM). Grounded
 * questions whose expected source is known by construction, so retrieval can be scored automatically:
 *   • status  — one per Jira ticket thread ("what is the status of SCRUM-14?") → expect jira:KEY
 *   • decision — one per extracted decision ("what was decided about X?")        → expect meeting:id
 *   • gap     — one per untracked meeting ("what did {meeting} commit that was never ticketed?")
 *   • topic   — one per recurring topic thread ("across meetings, where does {topic} stand?")
 * Idempotent (UNIQUE on question). Returns how many were added.
 */
export async function seedGoldenSet(spaceId: string, cap = 40): Promise<{ added: number; total: number }> {
  await ensureMemScoreSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { added: 0, total: 0 };
  const cases: Array<{ q: string; ans: string | null; sources: any[]; cat: string }> = [];

  // status — from ticket threads
  const tickets = await query<any>(
    `SELECT anchor_source_id, title, state, evidence FROM brain_thread
      WHERE space_id=$1 AND kind='ticket' LIMIT 60`, [spaceId],
  ).catch(() => []);
  for (const t of tickets) {
    const key = t.anchor_source_id;
    cases.push({
      q: `What is the current status of ${key}${t.title ? ` (${String(t.title).slice(0, 60)})` : ''}?`,
      ans: `${key} is ${t.state}${t.evidence?.status ? ` — Jira status "${t.evidence.status}"` : ''}.`,
      sources: [{ source: 'jira', source_id: key }], cat: 'status',
    });
  }
  // decision — from knowledge_graph.decisions
  const decisions = await query<any>(
    `SELECT m.source_id AS meeting_id, m.title AS meeting_title, d->>'decision' AS decision, d->>'relatedTopic' AS topic
       FROM knowledge_item m
       JOIN knowledge_graph kg ON kg.task_id::text=m.source_id AND kg.user_id=m.user_id
       CROSS JOIN LATERAL jsonb_array_elements(COALESCE(kg.decisions,'[]'::jsonb)) d
      WHERE m.space_id=$1 AND m.source='meeting' AND COALESCE(d->>'decision','')<>'' LIMIT 40`, [spaceId],
  ).catch(() => []);
  for (const d of decisions) {
    const subject = d.topic || String(d.decision).split(/[.,]/)[0].slice(0, 50);
    cases.push({
      q: `What was decided about ${subject}?`,
      ans: String(d.decision).slice(0, 300), sources: [{ source: 'meeting', source_id: d.meeting_id }], cat: 'decision',
    });
  }
  // topic — from topic threads
  const topics = await query<any>(
    `SELECT title, evidence FROM brain_thread WHERE space_id=$1 AND kind='topic' LIMIT 25`, [spaceId],
  ).catch(() => []);
  for (const t of topics) {
    cases.push({
      q: `Across meetings, where does the topic "${String(t.title).slice(0, 50)}" stand?`,
      ans: `Discussed in ${t.evidence?.meetingCount || 0} meetings; latest status "${t.evidence?.latestStatus || '?'}".`,
      sources: [], cat: 'topic',   // no single source id — scored by answer only when withAnswer
    });
  }

  let added = 0;
  for (const c of cases.slice(0, cap)) {
    const r = await queryOne<{ inserted: boolean }>(
      `INSERT INTO mem_benchmark (space_id, question, expected_answer, expected_sources, category, origin)
       VALUES ($1,$2,$3,$4,$5,'auto') ON CONFLICT (space_id, question) DO NOTHING
       RETURNING true AS inserted`,
      [spaceId, c.q, c.ans, JSON.stringify(c.sources), c.cat],
    ).catch(() => null);
    if (r?.inserted) added++;
  }
  const total = (await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM mem_benchmark WHERE space_id=$1`, [spaceId]).catch(() => null));
  return { added, total: total ? parseInt(total.n, 10) : added };
}

/**
 * HARDEN the golden set with PARAPHRASES (held-out test). The auto set reuses the exact decision/
 * topic text, so retrieving it is partly self-fulfilling. This LLM-rewords each question into how a
 * real teammate would ask — different words, NO ticket keys — keeping the SAME expected source. Scoring
 * on these tests whether SEMANTIC retrieval finds the right memory from a differently-worded query
 * (the honest signal). One cheap Flash call per question, one-time (idempotent via paraphrase_of).
 */
export async function paraphraseGoldenSet(spaceId: string, cap = 60): Promise<{ added: number; total: number }> {
  await ensureMemScoreSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { added: 0, total: 0 };
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM knowledge_item WHERE space_id=$1 LIMIT 1`, [spaceId]).catch(() => null);
  if (!owner) return { added: 0, total: 0 };
  const done = new Set((await query<{ p: string }>(`SELECT paraphrase_of AS p FROM mem_benchmark WHERE space_id=$1 AND origin='paraphrase' AND paraphrase_of IS NOT NULL`, [spaceId]).catch(() => [])).map((r) => r.p));
  const src = await query<any>(`SELECT question, expected_answer, expected_sources, category FROM mem_benchmark WHERE space_id=$1 AND origin='auto'`, [spaceId]).catch(() => []);
  let added = 0;
  for (const g of src.slice(0, cap)) {
    if (done.has(g.question)) continue;
    const p = await flash(
      'Rewrite the question as a natural question a busy teammate would ask about the SAME underlying subject. Rules: do NOT reuse ticket keys/IDs (e.g. SCRUM-14), do NOT copy exact phrases from the question — refer to the topic in your own words. Output ONLY the rewritten question, one line.',
      g.question, owner.user_id);
    const para = String(p || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    if (!para || para.length < 8 || norm(para) === norm(g.question)) continue;
    const r = await queryOne<{ inserted: boolean }>(
      `INSERT INTO mem_benchmark (space_id, question, expected_answer, expected_sources, category, origin, paraphrase_of)
       VALUES ($1,$2,$3,$4,$5,'paraphrase',$6) ON CONFLICT (space_id, question) DO NOTHING RETURNING true AS inserted`,
      [spaceId, para.slice(0, 400), g.expected_answer, JSON.stringify(g.expected_sources), g.category, g.question],
    ).catch(() => null);
    if (r?.inserted) added++;
  }
  const total = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM mem_benchmark WHERE space_id=$1 AND origin='paraphrase'`, [spaceId]).catch(() => null);
  return { added, total: total ? parseInt(total.n, 10) : added };
}

/**
 * PASSAGE golden questions (to MEASURE item chunks). The auto/paraphrase sets ask about decisions/
 * topics — which ATOMS already nail — so chunks show no gain there. This generates questions about a
 * SPECIFIC passage buried in a meeting body: for a sample of chunks, an LLM writes a question whose
 * answer lives IN that chunk (a detail/fact, not a headline), expected source = the parent item. Only
 * chunk-level indexing can surface these, so scoring them with-vs-without chunks proves the value.
 */
export async function passageGoldenSet(spaceId: string, cap = 24): Promise<{ added: number; total: number }> {
  await ensureMemScoreSchema();
  if (!spaceId || spaceId === ACCOUNT_SCOPE) return { added: 0, total: 0 };
  const owner = await queryOne<{ user_id: string }>(`SELECT user_id FROM knowledge_item WHERE space_id=$1 LIMIT 1`, [spaceId]).catch(() => null);
  if (!owner) return { added: 0, total: 0 };
  // Sample chunks that aren't already turned into a passage question, with their parent's source id.
  const done = new Set((await query<{ p: string }>(`SELECT paraphrase_of AS p FROM mem_benchmark WHERE space_id=$1 AND category='passage' AND paraphrase_of IS NOT NULL`, [spaceId]).catch(() => [])).map((r) => r.p));
  const chunks = await query<any>(
    `SELECT mu.id, mu.text, ki.source, ki.source_id FROM mem_unit mu
       JOIN knowledge_item ki ON ki.id=mu.parent_id
      WHERE mu.space_id=$1 AND mu.unit_type='chunk' AND length(mu.text) > 400
      ORDER BY mu.id LIMIT 120`, [spaceId],
  ).catch(() => []);
  let added = 0;
  for (const c of chunks) {
    if (added >= cap) break;
    if (done.has(c.id)) continue;
    const q = await flash(
      'Read the meeting excerpt. Write ONE specific question whose answer is stated IN this excerpt — a concrete detail, name, number, or statement, NOT a broad topic or decision. Do not quote the excerpt. Output only the question.',
      String(c.text).slice(0, 1400), owner.user_id);
    const question = String(q || '').replace(/\s+/g, ' ').trim().replace(/^["']|["']$/g, '');
    if (!question || question.length < 10) continue;
    const r = await queryOne<{ inserted: boolean }>(
      `INSERT INTO mem_benchmark (space_id, question, expected_answer, expected_sources, category, origin, paraphrase_of)
       VALUES ($1,$2,NULL,$3,'passage','passage',$4) ON CONFLICT (space_id, question) DO NOTHING RETURNING true AS inserted`,
      [spaceId, question.slice(0, 400), JSON.stringify([{ source: c.source, source_id: c.source_id }]), c.id],
    ).catch(() => null);
    if (r?.inserted) added++;
  }
  const total = await queryOne<{ n: string }>(`SELECT COUNT(*)::text AS n FROM mem_benchmark WHERE space_id=$1 AND category='passage'`, [spaceId]).catch(() => null);
  return { added, total: total ? parseInt(total.n, 10) : added };
}

// Cheap Flash call for the optional ANSWER + JUDGE layer (metered under feature='brain').
async function flash(sys: string, user: string, userId: string): Promise<string> {
  const s = await getSecrets();
  if (!s.GEMINI_API_KEY) return '';
  const model = MODELS.kgExtract.primary;   // gemini-3-flash-preview (cheap tier)
  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${s.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 700 } }),
    });
    if (!r.ok) return '';
    const d: any = await r.json();
    void recordProviderUsage(userId, 'brain', 'gemini', model, d).catch(() => {});
    return (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
  } catch { return ''; }
}

/**
 * LLM CROSS-ENCODER rerank (experiment): one cheap Flash call reads the question + the retrieved
 * candidates and returns them most→least relevant. Unlike the deterministic reranker (which lost to
 * the native ANN order), the LLM actually reads each candidate, so it can promote the one that truly
 * answers a reworded query. Costs ONE Flash call per query — measured before any thought of shipping.
 */
async function llmRerankHits(question: string, hits: any[], userId: string): Promise<any[]> {
  if (hits.length <= 1) return hits;
  const list = hits.map((h, i) => `[${i + 1}] (${h.source}:${h.source_id}) ${h.title || ''} — ${(h.body || '').slice(0, 200)}`).join('\n');
  const out = await flash(
    'Rank the memory snippets by how well each helps ANSWER the question. Output ONLY a comma-separated list of snippet numbers, most relevant first. No other text.',
    `Question: ${question}\n\nSnippets:\n${list}`, userId);
  const order = (out.match(/\d+/g) || []).map(Number).filter((n) => n >= 1 && n <= hits.length);
  if (!order.length) return hits;
  const seen = new Set<number>(); const reordered: any[] = [];
  for (const n of order) if (!seen.has(n)) { seen.add(n); reordered.push(hits[n - 1]); }
  hits.forEach((h, i) => { if (!seen.has(i + 1)) reordered.push(h); });   // keep any the LLM omitted
  return reordered;
}

export interface MemScoreOpts { withAnswer?: boolean; useGraph?: boolean; rerank?: boolean; llmRerank?: boolean; noChunks?: boolean; k?: number; config?: string; origin?: string; limit?: number }

/**
 * RUN the benchmark for a space. Retrieval scoring is deterministic (expected source present in the
 * retrieved set?). `useGraph` adds brain_edge neighbour expansion to retrieval (A/B the graph value).
 * `withAnswer` adds the LLM answer+judge layer (opt-in, Flash-tier, metered). Records a run row.
 */
export async function runMemScore(spaceId: string, opts: MemScoreOpts = {}): Promise<any> {
  await ensureMemScoreSchema();
  const k = opts.k ?? 12;
  const owner = await queryOne<{ user_id: string; workspace_id: string }>(
    `SELECT user_id, workspace_id FROM knowledge_item WHERE space_id=$1 LIMIT 1`, [spaceId],
  ).catch(() => null);
  if (!owner) return { error: 'no items in space' };
  // Optionally score only a subset (e.g. origin='paraphrase' — the held-out, differently-worded test).
  // Stable subset (ORDER BY question) when a limit is set — lets the slow LLM-rerank experiment run an
  // apples-to-apples A/B on the SAME questions within the Lambda's 300s budget.
  const lim = opts.limit && opts.limit > 0 ? ` ORDER BY question LIMIT ${Math.min(Math.floor(opts.limit), 200)}` : '';
  const golden = await query<any>(
    `SELECT question, expected_answer, expected_sources, category FROM mem_benchmark
      WHERE space_id=$1 ${opts.origin && opts.origin !== 'all' ? 'AND origin=$2' : ''}${lim}`,
    opts.origin && opts.origin !== 'all' ? [spaceId, opts.origin] : [spaceId],
  ).catch(() => []);
  if (!golden.length) return { error: 'no golden set for this filter — seed it first (seed:true / paraphrase:true)' };

  let recallHits = 0, recallScorable = 0, rrSum = 0, correct = 0, judged = 0;
  let latencyMs = 0, tokensBefore = await brainTokensToday(owner.user_id);
  const detail: any[] = [];

  for (const g of golden) {
    const expected: any[] = Array.isArray(g.expected_sources) ? g.expected_sources : [];
    const t0 = Date.now();
    let hits = await semanticSearchItems(owner.user_id, owner.workspace_id, g.question, k, { rerank: opts.rerank, noChunks: opts.noChunks }).catch(() => []);
    if (opts.useGraph) hits = await expandWithNeighbours(owner.user_id, owner.workspace_id, hits).catch(() => hits);
    if (opts.llmRerank) hits = await llmRerankHits(g.question, hits, owner.user_id).catch(() => hits);
    latencyMs += Date.now() - t0;

    // Retrieval score: rank of the first retrieved item matching an expected source.
    let rank = 0;
    if (expected.length) {
      recallScorable++;
      const want = new Set(expected.map((e) => `${norm(e.source)}:${norm(e.source_id)}`));
      const idx = hits.findIndex((h: any) => want.has(`${norm(h.source)}:${norm(h.source_id)}`));
      if (idx >= 0) { recallHits++; rank = idx + 1; rrSum += 1 / rank; }
    }

    let verdict: string | null = null;
    if (opts.withAnswer) {
      const ctx = hits.slice(0, 8).map((h: any, i: number) => `[${i + 1}] (${h.source}:${h.source_id}) ${h.title || ''} — ${(h.body || '').slice(0, 300)}`).join('\n');
      const answer = await flash(
        'You answer questions ONLY from the provided memory snippets. Cite [n]. If the answer is not present, say "insufficient signal".',
        `Question: ${g.question}\n\nMemory:\n${ctx}`, owner.user_id);
      if (g.expected_answer) {
        judged++;
        const j = await flash(
          'You are a strict grader. Compare the CANDIDATE answer to the REFERENCE. Reply with ONE word: correct, partial, or wrong.',
          `Question: ${g.question}\nREFERENCE: ${g.expected_answer}\nCANDIDATE: ${answer || '(no answer)'}`, owner.user_id);
        verdict = /correct/i.test(j) ? 'correct' : /partial/i.test(j) ? 'partial' : 'wrong';
        if (verdict === 'correct') correct += 1; else if (verdict === 'partial') correct += 0.5;
      }
      detail.push({ q: g.question, cat: g.category, rank, verdict });
    } else {
      detail.push({ q: g.question, cat: g.category, rank });
    }
  }

  const retrieval_recall = recallScorable ? recallHits / recallScorable : 0;
  const retrieval_mrr = recallScorable ? rrSum / recallScorable : 0;
  const answer_accuracy = judged ? correct / judged : null;
  const avg_latency_ms = golden.length ? latencyMs / golden.length : 0;
  const total_tokens = Math.max(0, (await brainTokensToday(owner.user_id)) - tokensBefore);
  // MemScore (0-100): retrieval-led. With answers, answer accuracy dominates; else recall+mrr.
  const memscore = answer_accuracy != null
    ? Math.round(100 * (0.5 * answer_accuracy + 0.3 * retrieval_recall + 0.2 * retrieval_mrr))
    : Math.round(100 * (0.7 * retrieval_recall + 0.3 * retrieval_mrr));

  const config = opts.config || `${opts.useGraph ? 'graph' : 'vector'}${opts.withAnswer ? '+answer' : ''}`;
  await query(
    `INSERT INTO mem_score_run (space_id, config, questions, retrieval_recall, retrieval_mrr, answer_accuracy, avg_latency_ms, total_tokens, memscore, detail)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
    [spaceId, config, golden.length, retrieval_recall, retrieval_mrr, answer_accuracy, avg_latency_ms, total_tokens, memscore, JSON.stringify(detail.slice(0, 60))],
  ).catch(() => {});

  return {
    config, questions: golden.length,
    retrieval_recall: +retrieval_recall.toFixed(3), retrieval_mrr: +retrieval_mrr.toFixed(3),
    answer_accuracy: answer_accuracy != null ? +answer_accuracy.toFixed(3) : null,
    avg_latency_ms: Math.round(avg_latency_ms), total_tokens, memscore,
  };
}

async function brainTokensToday(userId: string): Promise<number> {
  const r = await queryOne<{ t: string }>(
    `SELECT COALESCE(SUM(total_tokens),0)::text AS t FROM usage_events
      WHERE user_id=$1 AND feature='brain' AND created_at >= date_trunc('day', now())`, [userId],
  ).catch(() => null);
  return r ? parseInt(r.t, 10) || 0 : 0;
}

/** Recent runs for a space (the REPORT) — to watch MemScore move as we tune the architecture. */
export async function memScoreHistory(spaceId: string, limit = 20): Promise<any[]> {
  await ensureMemScoreSchema();
  return query<any>(
    `SELECT ran_at, config, questions, retrieval_recall, retrieval_mrr, answer_accuracy, avg_latency_ms, total_tokens, memscore
       FROM mem_score_run WHERE space_id=$1 ORDER BY ran_at DESC LIMIT ${limit}`, [spaceId],
  ).catch(() => []);
}
