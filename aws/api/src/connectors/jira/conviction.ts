import { query } from '../../db';
import { getSecrets } from '../../secrets';
import { MODELS } from '../../models/registry';

/**
 * Conviction engine (v2) — "patience before action". The agent must accumulate
 * conviction ACROSS meetings and only act on a decision that is genuinely SETTLED.
 * Acting on a single flip is both unsafe (reversals erode trust) and costly at scale.
 *
 * Approach: gather the chronological stream of decisions across a workspace's recent
 * meetings, and ask the model to (a) group related ones into decision threads, (b) judge
 * each thread's trajectory, and (c) mark a thread SETTLED + high-conviction ONLY when the
 * agreement is stable (held across ≥2 meetings / clearly final, not oscillating). The
 * canonical guard: disagree → disagree → agree = low conviction → wait; a later
 * confirmation pushes it over the threshold. Only settled+high threads yield an action.
 *
 * Bounded + cheap: one flash-model call per workspace per sweep over a capped window.
 */

const LOOKBACK_DAYS = 45;
const MAX_MEETINGS = 30;
const MAX_DECISIONS = 60;
const MAX_CHARS = 9000;

export interface SettledThread {
  topic: string;
  finalDecision: string;
  conviction: 'low' | 'medium' | 'high';
  recommendedSummary: string;
  issueType?: string;
  reason: string;
}

export async function evaluateSettledThreads(userId: string, workspaceId: string): Promise<SettledThread[]> {
  const secrets = await getSecrets();
  if (!secrets.GEMINI_API_KEY) return [];

  const meetings = await query<{ filename: string; created_at: string; decisions: any }>(
    `SELECT th.filename, th.created_at, kg.decisions
       FROM task_history th
       JOIN knowledge_graph kg ON kg.task_id = th.id AND kg.user_id = th.user_id
      WHERE th.user_id = $1
        AND th.created_at > NOW() - INTERVAL '${LOOKBACK_DAYS} days'
        AND th.id IN (
          SELECT tw.task_id FROM task_workspaces tw WHERE tw.workspace_id = $2
          UNION
          SELECT tf.task_id FROM task_folders tf JOIN folders f ON f.id = tf.folder_id WHERE f.workspace_id = $2
        )
      ORDER BY th.created_at ASC LIMIT ${MAX_MEETINGS}`,
    [userId, workspaceId],
  ).catch(() => []);
  if (!meetings.length) return [];

  // Chronological decision stream (oldest → newest, so trajectory is readable).
  const lines: string[] = [];
  let count = 0, chars = 0;
  for (const m of meetings) {
    const decs: any[] = Array.isArray(m.decisions) ? m.decisions : [];
    const date = m.created_at ? new Date(m.created_at).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' }) : '';
    for (const d of decs) {
      const text = String(d?.decision || d?.summary || d || '').trim();
      if (!text) continue;
      const line = `[${date}] "${m.filename || 'Untitled'}": ${text}`;
      if (count >= MAX_DECISIONS || chars + line.length > MAX_CHARS) break;
      lines.push(line); count++; chars += line.length;
    }
  }
  if (count < 1) return [];

  const sys = `You assess whether decisions discussed across meetings are SETTLED enough to turn into tracked work. You are given a CHRONOLOGICAL stream of decision statements (oldest first) from one workspace.
Group related statements into decision THREADS. For each thread, judge the trajectory over time:
- SETTLED + high conviction ONLY when the latest position is a clear agreement that has HELD (stable across ≥2 meetings, or explicitly final) and was NOT recently reversed.
- If a thread oscillated (e.g. disagreed, then disagreed, then agreed only once), conviction is LOW and settled=false — we WAIT for confirmation rather than act on a single flip.
- Tentative ("maybe", "we'll see") → low conviction.
Output JSON ONLY: {"threads":[{"topic": string, "settled": boolean, "conviction": "low"|"medium"|"high", "finalDecision": string, "recommendedSummary": string, "issueType": "Task"|"Bug"|"Story"|"Epic", "reason": string}]}.
recommendedSummary = a concise Jira issue title capturing the work the settled decision implies (null/empty if not settled). reason = one sentence citing the trajectory (e.g. "agreed in 2 consecutive meetings, no reversal" or "flipped once after two disagreements — not settled").`;
  const user = `Decision stream:\n${lines.join('\n')}`;

  try {
    const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${MODELS.kgExtract.primary}:generateContent?key=${secrets.GEMINI_API_KEY}`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: user }] }], generationConfig: { responseMimeType: 'application/json', temperature: 0.1, maxOutputTokens: 1500 } }),
    });
    const d: any = await r.json();
    if (!r.ok) return [];
    const text = (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim();
    const parsed = JSON.parse(text);
    const threads: any[] = Array.isArray(parsed?.threads) ? parsed.threads : [];
    return threads
      .filter((t) => t?.settled === true && t?.conviction === 'high' && String(t?.recommendedSummary || '').trim())
      .map((t) => ({
        topic: String(t.topic || '').slice(0, 120),
        finalDecision: String(t.finalDecision || '').slice(0, 400),
        conviction: 'high' as const,
        recommendedSummary: String(t.recommendedSummary).slice(0, 240),
        issueType: ['Task', 'Bug', 'Story', 'Epic'].includes(t.issueType) ? t.issueType : 'Task',
        reason: String(t.reason || '').slice(0, 300),
      }));
  } catch {
    return [];
  }
}
