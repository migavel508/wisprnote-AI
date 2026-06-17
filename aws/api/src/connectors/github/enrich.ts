import { query, queryOne } from '../../db';
import { resolveMcpConnection, type McpConn } from '../../mcp/connection';
import { mcpCallTool } from '../../mcp/client';
import { getSecrets } from '../../secrets';
import { MODELS } from '../../models/registry';

/**
 * Commit content for the Living-Brain — built in TWO tiers to control LLM input-token cost.
 * Commit MESSAGES are unreliable ("v1", "v2", fluff), so we don't reason about them; we use
 * the commit SHA to read the ACTUAL change. But sending every commit's full diff to an LLM
 * is enormously expensive, so the diff→LLM step is gated:
 *
 *   TIER 1  fingerprintCommits()  — for EVERY commit: get_commit (a GitHub API call, $0 in
 *           tokens) → a deterministic FINGERPRINT (filenames + dirs + stats + message line).
 *           Strong, cheap signal for candidate matching. NO LLM. Stored in `fingerprint`.
 *   TIER 2  enrichCommit(id)      — LAZY, on-demand: only when a commit becomes a top-K link
 *           candidate for a meeting (called by brainLink) do we send its real diff to a cheap
 *           model for a summary. Cached forever in `enriched_summary` (commits are immutable).
 *
 * Net effect: the expensive diff→LLM pass fires for (meetings × ~K candidates), not for the
 * whole commit history × repos × workspaces. Cost scales with meetings, not commits.
 */

const PATCH_PER_FILE = 400;
const DIGEST_CHARS = 6000;
const FINGERPRINT_CHARS = 1500;

// Files that are generated / vendored / binary — high diff volume, low reasoning value.
const GENERATED = /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|Cargo\.lock|go\.sum|composer\.lock|poetry\.lock)$|(^|\/)(dist|build|node_modules|vendor|\.next|out|coverage)\/|\.(min\.(js|css)|map)$|\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|eot|pdf|lock)$/i;

let cols: Promise<void> | null = null;
function ensureCommitCols(): Promise<void> {
  // Both stored SEPARATELY from `body` so a connector re-sync (which rewrites body) can't
  // clobber them. `fingerprint` = cheap deterministic metadata (Tier 1); `enriched_summary`
  // = the diff-grounded LLM summary (Tier 2). Empty string '' = "tried, skip — don't retry".
  if (!cols) cols = (async () => {
    await query(`ALTER TABLE knowledge_item ADD COLUMN IF NOT EXISTS fingerprint TEXT`);
    await query(`ALTER TABLE knowledge_item ADD COLUMN IF NOT EXISTS enriched_summary TEXT`);
  })().then(() => {}).catch((e) => { cols = null; throw e; });
  return cols;
}

/** Parse "owner/repo@sha" (commit) into get_commit args. */
function commitLoc(sourceId: string): { owner: string; repo: string; sha: string } | null {
  const m = String(sourceId).match(/^([^/]+)\/([^@#]+)[@#](.+)$/);
  return m ? { owner: m[1], repo: m[2], sha: m[3] } : null;
}

/** get_commit by SHA → parsed payload (files[], stats, commit.message). null on failure.
 *  NOTE: do NOT pass `detail:true` — the GitHub MCP rejects it ("not valid JSON"). */
async function getCommitDetail(conn: McpConn, sourceId: string): Promise<any | null> {
  const loc = commitLoc(sourceId);
  if (!loc) return null;
  const c = await mcpCallTool(conn.server, conn.token, 'get_commit', { owner: loc.owner, repo: loc.repo, sha: loc.sha }).catch(() => null);
  if (!c || c.isError) return null;
  try { return JSON.parse(c?.content?.[0]?.text ?? '{}'); } catch { return null; }
}

/** Deterministic fingerprint (Tier 1) — filenames + dirs + stats + message line. No LLM. */
function buildFingerprint(p: any): string {
  const files: any[] = Array.isArray(p.files) ? p.files : [];
  const real = files.filter((f) => !GENERATED.test(f.filename || ''));
  const use = real.length ? real : files;     // if a commit is ONLY generated files, still note them
  const dirs = [...new Set(use.map((f) => String(f.filename || '').split('/').slice(0, -1).join('/')).filter(Boolean))].slice(0, 8);
  const names = use.slice(0, 20).map((f) => `${f.filename} (+${f.additions || 0}/-${f.deletions || 0})`);
  const msgLine = String(p.commit?.message || '').split('\n')[0].slice(0, 120);
  const stats = p.stats ? `total +${p.stats.additions || 0}/-${p.stats.deletions || 0} across ${files.length} files` : `${files.length} files`;
  return [msgLine, dirs.length ? `dirs: ${dirs.join(', ')}` : '', stats, names.join('\n')].filter(Boolean).join('\n').slice(0, FINGERPRINT_CHARS);
}

async function summarizeDiff(input: string): Promise<string | null> {
  const secrets = await getSecrets();
  if (!secrets.GEMINI_API_KEY) return null;
  const sys = `You are given a git commit's ACTUAL file changes (filenames + patches). Summarize what was implemented/changed in 2-3 factual sentences — the feature/fix and the areas of code touched. Ignore the commit message; describe the real diff. If the commit changes ONLY asset/binary/config files (images, icons, fonts, lockfiles), give ONE concise sentence naming what assets changed (e.g. "Replaced the app logo and regenerated the Android/iOS launcher icons across the icon set."). Always respond in prose — never output a raw file list. Plain text only.`;
  const models = [MODELS.kgExtract.primary, ...(MODELS.kgExtract.fallbacks || [])];   // cheap Flash tier
  // maxOutputTokens must cover gemini-3's THINKING tokens too (they count against this budget)
  // — 300 was being consumed by thinking, cutting the summary mid-sentence. 2048 leaves room.
  const body = JSON.stringify({ systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: 'user', parts: [{ text: input }] }], generationConfig: { temperature: 0.1, maxOutputTokens: 2048 } });
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 8000);
      let r: Response;
      try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${secrets.GEMINI_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal }); }
      catch { clearTimeout(timer); continue; } finally { clearTimeout(timer); }
      if (r.ok) { const d: any = await r.json(); return (d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim() || null; }
      if (r.status === 404 || r.status === 400) break;
      if (![429, 500, 502, 503, 529].includes(r.status)) break;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  return null;
}

/** TIER 1 — fingerprint a bounded batch of commits (cheap; no LLM). Drains all commits so
 *  semantic candidate-matching has strong filename signal without paying diff-LLM cost. */
export async function fingerprintCommits(cap = 12): Promise<{ fingerprinted: number }> {
  await ensureCommitCols();
  const rows = await query<any>(
    `SELECT id, user_id, workspace_id, source_id FROM knowledge_item
      WHERE source='github' AND type='commit' AND fingerprint IS NULL
      ORDER BY synced_at DESC LIMIT ${cap}`,
  ).catch(() => []);
  if (!rows.length) return { fingerprinted: 0 };

  const connCache = new Map<string, McpConn | null>();
  let n = 0;
  for (const r of rows) {
    const key = `${r.user_id}:${r.workspace_id}`;
    if (!connCache.has(key)) connCache.set(key, await resolveMcpConnection(r.user_id, r.workspace_id, 'github').catch(() => null));
    const conn = connCache.get(key);
    const detail = conn ? await getCommitDetail(conn, r.source_id) : null;
    if (!detail) { await query(`UPDATE knowledge_item SET fingerprint='' WHERE id=$1`, [r.id]).catch(() => {}); continue; }
    const fp = buildFingerprint(detail);
    // Bump synced_at so the embed sweep re-embeds the commit using its fingerprint.
    await query(`UPDATE knowledge_item SET fingerprint=$2, synced_at=NOW() WHERE id=$1`, [r.id, fp]).catch(() => {});
    n++;
  }
  console.log('github_fingerprint', JSON.stringify({ fingerprinted: n }));
  return { fingerprinted: n };
}

/** Backfill drip — eagerly summarise commits that lazy enrichment hasn't reached yet, so the
 *  brain map is fully populated with prose (not fingerprints). Hard-capped per tick so the
 *  cost stays negligible + spike-proof; recent-first; only NULL summaries; cached after. */
export async function backfillCommitSummaries(cap = 6): Promise<{ enriched: number; remaining: number }> {
  await ensureCommitCols();
  const rows = await query<{ id: string; user_id: string; workspace_id: string }>(
    `SELECT id, user_id, workspace_id FROM knowledge_item
      WHERE source='github' AND type='commit' AND enriched_summary IS NULL
      ORDER BY synced_at DESC LIMIT ${cap}`,
  ).catch(() => []);
  let n = 0;
  for (const r of rows) { if (await enrichCommit(r.user_id, r.workspace_id, r.id).catch(() => null)) n++; }
  const left = await queryOne<{ c: number }>(
    `SELECT count(*)::int c FROM knowledge_item WHERE source='github' AND type='commit' AND enriched_summary IS NULL`,
  ).catch(() => ({ c: 0 }));
  const remaining = left?.c ?? 0;
  console.log('github_backfill', JSON.stringify({ enriched: n, remaining }));   // no silent truncation
  return { enriched: n, remaining };
}

/** TIER 2 — LAZY single-commit diff summary. Called by brainLink ONLY for commits that
 *  became a link candidate. Returns the summary (or null). Cached forever in enriched_summary. */
export async function enrichCommit(userId: string, workspaceId: string, id: string): Promise<string | null> {
  await ensureCommitCols();
  const row = await queryOne<{ source_id: string; enriched_summary: string | null }>(
    `SELECT source_id, enriched_summary FROM knowledge_item WHERE id=$1 AND type='commit'`, [id],
  ).catch(() => null);
  if (!row) return null;
  if (row.enriched_summary) return row.enriched_summary || null;   // already enriched (or skip-marked '')

  const conn = await resolveMcpConnection(userId, workspaceId, 'github').catch(() => null);
  const detail = conn ? await getCommitDetail(conn, row.source_id) : null;
  if (!detail) { await query(`UPDATE knowledge_item SET enriched_summary='' WHERE id=$1`, [id]).catch(() => {}); return null; }

  const files: any[] = Array.isArray(detail.files) ? detail.files : [];
  const codeFiles = files.filter((f) => !GENERATED.test(f.filename || ''));
  // Asset-only commit (logos, icons, lockfiles — no code): summarise from the file LIST so we
  // still return PROSE ("updated logo + app icons"), never a raw filename dump.
  const assetOnly = codeFiles.length === 0 && files.length > 0;
  const digestFiles = assetOnly ? files : codeFiles;
  const digest = digestFiles.slice(0, 30)
    .map((f) => `${f.filename} (+${f.additions || 0}/-${f.deletions || 0})${(!assetOnly && f.patch) ? '\n' + String(f.patch).slice(0, PATCH_PER_FILE) : ''}`)
    .join('\n').slice(0, DIGEST_CHARS);
  const summary = await summarizeDiff(`Commit message (untrusted): ${detail.commit?.message || ''}\nStats: ${JSON.stringify(detail.stats || {})}\n\n${assetOnly ? 'This commit changes only asset/binary/config files (no source code).\n' : ''}Files changed (${files.length}):\n${digest}`);
  if (summary) {
    await query(`UPDATE knowledge_item SET enriched_summary=$2, synced_at=NOW() WHERE id=$1`, [id, summary.slice(0, 2000)]);
    return summary;
  }
  await query(`UPDATE knowledge_item SET enriched_summary='' WHERE id=$1`, [id]).catch(() => {});
  return null;
}
