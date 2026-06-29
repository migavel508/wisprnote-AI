import { query, queryOne } from '../../db';
import { ensureConnectorSchema, ACCOUNT_SCOPE } from '../schema';
import { getSecrets } from '../../secrets';
import { MODELS } from '../../models/registry';
import { upsertItem } from '../sync';
import type { KnowledgeItemInput } from '../registry';

/**
 * LOCAL DEV-SESSION CONNECTOR — Claude Code + Codex.
 *
 * These tools' transcripts live as JSONL on the USER'S MACHINE (~/.claude/projects/*.jsonl,
 * ~/.codex/sessions/**\/rollout-*.jsonl), so unlike Jira/GitHub there is no remote MCP the
 * Lambda can reach. The desktop app reads + REDACTS + compacts each session locally (the raw
 * multi-GB Codex rollouts never leave the machine) and uploads only a small `SessionDigest`.
 *
 * Cost shape mirrors the commit pipeline: ingest is a FAST upsert (deterministic body, no LLM,
 * stays under the API-Gateway timeout); a LAZY `distillSessions()` job on the brain-enrich cron
 * turns each digest into a clean summary with the cheap Flash tier. Sessions land as
 * `knowledge_item(source='claude-code'|'codex', type='session')`, folder-scoped by their cwd, so
 * the existing embed + brain-link pipeline wires a session that edited PROJ-CRM into that
 * project's commits/tickets.
 */

/** Compact, REDACTED per-session payload uploaded by the desktop app. */
export interface SessionDigest {
  source: 'claude-code' | 'codex';
  sessionId: string;
  cwd: string;                  // absolute local path → maps to a connected folder/project
  folderId?: string | null;     // client-resolved cwd→folder (only connected projects are sent)
  gitBranch?: string | null;
  model?: string | null;
  startedAt?: string | null;     // ISO
  endedAt?: string | null;       // ISO → occurred_at
  turnCount?: number;
  userPrompts?: string[];        // the human's asks (high signal), redacted + capped
  assistantText?: string[];      // what the assistant said it did, redacted + capped
  files?: string[];              // files touched (from tool_use / patch_apply)
  commands?: string[];           // shell commands run (redacted)
}

const MAX_SESSIONS = 300;   // per ingest request (client batches the rest)
const PROMPTS_CAP = 24;
const ASSIST_CAP = 16;
const TEXT_CAP = 600;       // chars per snippet
const BODY_CAP = 6000;
const INPUT_CAP = 12000;    // chars sent to the distiller

const SOURCE_LABEL: Record<string, string> = { 'claude-code': 'Claude Code', codex: 'Codex' };

function repoName(cwd: string): string {
  const parts = String(cwd || '').replace(/\/+$/, '').split('/').filter(Boolean);
  return parts[parts.length - 1] || String(cwd || '') || 'workspace';
}
function clip(s: unknown, n: number): string { return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n); }
function isUuid(s: unknown): boolean { return typeof s === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

/** Deterministic, embeddable body — NO LLM (the fast path, under the API timeout). The lazy
 *  `distillSessions` job replaces it with a clean summary once the cron picks it up. */
function deterministicBody(d: SessionDigest): string {
  const label = SOURCE_LABEL[d.source] || d.source;
  const head = `${label} session · ${repoName(d.cwd)}${d.gitBranch ? ` · ${d.gitBranch}` : ''}`;
  const prompts = (d.userPrompts || []).slice(0, PROMPTS_CAP).map((p) => `- ${clip(p, TEXT_CAP)}`).filter((l) => l.length > 2);
  const files = (d.files || []).slice(0, 40).map((f) => clip(f, 120));
  const cmds = (d.commands || []).slice(0, 24).map((c) => clip(c, 120));
  return [
    head,
    prompts.length ? `\nPrompts:\n${prompts.join('\n')}` : '',
    files.length ? `\nFiles touched: ${files.join(', ')}` : '',
    cmds.length ? `\nCommands: ${cmds.join(' · ')}` : '',
  ].filter(Boolean).join('\n').slice(0, BODY_CAP);
}

function titleFrom(d: SessionDigest): string {
  const first = (d.userPrompts || []).find((p) => clip(p, 12).length > 3);
  return clip(first || `Dev session in ${repoName(d.cwd)}`, 120);
}

export interface IngestResult { upserted: number; skipped: number }

/** Fast path: upsert each digest, then mark it for (re)distill (enriched_summary → NULL). The
 *  desktop only uploads new/changed sessions (mtime cursor), so clearing the marker re-distills
 *  exactly the sessions that grew. */
export async function ingestLocalSessions(userId: string, workspaceId: string, digests: SessionDigest[]): Promise<IngestResult> {
  await ensureConnectorSchema();
  let upserted = 0, skipped = 0;
  const doneBySource: Record<string, string[]> = { 'claude-code': [], codex: [] };

  for (const d of (Array.isArray(digests) ? digests : []).slice(0, MAX_SESSIONS)) {
    if (!d || (d.source !== 'claude-code' && d.source !== 'codex') || !d.sessionId || !d.cwd) { skipped++; continue; }
    const it: KnowledgeItemInput = {
      source: d.source,
      source_id: String(d.sessionId),
      type: 'session',
      title: titleFrom(d),
      body: deterministicBody(d),
      people: null,
      links: {
        tool: d.source, cwd: d.cwd, repo: repoName(d.cwd), gitBranch: d.gitBranch ?? null,
        model: d.model ?? null, files: (d.files || []).slice(0, 60), sessionId: d.sessionId,
      },
      raw: { digest: d },
      occurred_at: d.endedAt || d.startedAt || null,
      status: null,
      actor: null,
    };
    const folderId = isUuid(d.folderId) ? String(d.folderId) : null;
    // A dev session is space-scoped via its folder (project); fall back to the sentinel and let
    // the follow-linked-meeting backfill re-home it from the meeting/task it links to.
    let spaceId = ACCOUNT_SCOPE;
    if (folderId) {
      const f = await queryOne<{ space_id: string | null }>(`SELECT space_id FROM folders WHERE id=$1`, [folderId]).catch(() => null);
      if (f?.space_id) spaceId = f.space_id;
    }
    try { await upsertItem(userId, workspaceId, spaceId, it, folderId); doneBySource[d.source].push(String(d.sessionId)); upserted++; }
    catch { skipped++; }
  }

  // For each just-ingested session: (1) mark it for (re)distill, and (2) clear its brain_link_state
  // so the linker re-evaluates it as an intent (links it OUTWARD to the meeting/task/commits it
  // relates to). Without (2), a session linked once via the old path would never re-link.
  for (const src of Object.keys(doneBySource)) {
    const ids = doneBySource[src];
    if (!ids.length) continue;
    await query(
      `UPDATE knowledge_item SET enriched_summary=NULL
        WHERE user_id=$1 AND workspace_id=$2 AND source=$3 AND type='session' AND source_id = ANY($4)`,
      [userId, workspaceId, src, ids],
    ).catch(() => {});
    await query(
      `DELETE FROM brain_link_state WHERE user_id=$1 AND workspace_id=$2 AND item_id IN (
         SELECT id FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source=$3 AND type='session' AND source_id = ANY($4))`,
      [userId, workspaceId, src, ids],
    ).catch(() => {});
  }
  return { upserted, skipped };
}

// ── Lazy distillation (cheap Flash tier, same model as KG extract) ─────────────────────────

const DISTILL_SYS = `You summarize a developer's AI coding session (Claude Code or Codex) for a company knowledge "brain". You are given a redacted digest: the user's prompts, what the assistant did, files touched, and commands run. Produce STRICT JSON:
{"title":"<= 80 chars, specific: what this session accomplished",
 "summary":"3-5 factual sentences — the goal, what was actually built/changed/fixed, and the outcome. Name concrete files, areas, or features.",
 "decisions":["notable technical decisions, if any"],
 "files":["notable files or areas touched"],
 "topics":["short topic/keyword tags"]}
Be factual and concrete; never invent work that isn't evidenced. Output ONLY the JSON object.`;

interface Distilled { title?: string; summary?: string; decisions?: string[]; files?: string[]; topics?: string[] }

function parseJson(t: string): Distilled | null {
  if (!t) return null;
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = t.match(/\{[\s\S]*\}/);
  if (m) { try { return JSON.parse(m[0]); } catch { /* give up */ } }
  return null;
}

async function distillOne(input: string): Promise<Distilled | null> {
  const secrets = await getSecrets();
  if (!secrets.GEMINI_API_KEY) return null;
  const models = [MODELS.kgExtract.primary, ...(MODELS.kgExtract.fallbacks || [])];   // cheap Flash tier
  // maxOutputTokens must cover gemini-3's THINKING tokens too (they count against the budget).
  const body = JSON.stringify({
    systemInstruction: { parts: [{ text: DISTILL_SYS }] },
    contents: [{ role: 'user', parts: [{ text: input }] }],
    generationConfig: { temperature: 0.1, maxOutputTokens: 2048, responseMimeType: 'application/json' },
  });
  for (const model of models) {
    for (let attempt = 0; attempt < 2; attempt++) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 9000);
      let r: Response;
      try { r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${secrets.GEMINI_API_KEY}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body, signal: ctrl.signal }); }
      catch { clearTimeout(timer); continue; } finally { clearTimeout(timer); }
      if (r.ok) { const d: any = await r.json(); return parseJson((d.candidates?.[0]?.content?.parts ?? []).map((p: any) => p?.text ?? '').join('').trim()); }
      if (r.status === 404 || r.status === 400) break;
      if (![429, 500, 502, 503, 529].includes(r.status)) break;
      await new Promise((res) => setTimeout(res, 500 * (attempt + 1)));
    }
  }
  return null;
}

function buildDistillInput(digest: any, fallbackBody: string): string {
  const d = digest && typeof digest === 'object' ? digest : {};
  const label = SOURCE_LABEL[d.source as string] || d.source || 'AI coding';
  const prompts = (d.userPrompts || []).slice(0, PROMPTS_CAP).map((p: unknown) => clip(p, TEXT_CAP)).filter(Boolean);
  const assist = (d.assistantText || []).slice(0, ASSIST_CAP).map((p: unknown) => clip(p, TEXT_CAP)).filter(Boolean);
  const files = (d.files || []).slice(0, 50).map((f: unknown) => clip(f, 120));
  const cmds = (d.commands || []).slice(0, 30).map((c: unknown) => clip(c, 120));
  const text = [
    `Tool: ${label}`,
    `Project: ${repoName(d.cwd || '')}${d.gitBranch ? ` (branch ${d.gitBranch})` : ''}`,
    prompts.length ? `\nUser prompts:\n${prompts.map((p: string) => `- ${p}`).join('\n')}` : '',
    assist.length ? `\nAssistant did:\n${assist.map((p: string) => `- ${p}`).join('\n')}` : '',
    files.length ? `\nFiles touched: ${files.join(', ')}` : '',
    cmds.length ? `\nCommands: ${cmds.join(' · ')}` : '',
  ].filter(Boolean).join('\n').slice(0, INPUT_CAP);
  return text.trim() || clip(fallbackBody, BODY_CAP);
}

function renderMd(o: Distilled): string {
  const lines = [clip(o.summary, 4000)];
  if (Array.isArray(o.decisions) && o.decisions.length) lines.push('\n**Decisions**\n' + o.decisions.slice(0, 8).map((d) => `- ${clip(d, 200)}`).join('\n'));
  if (Array.isArray(o.files) && o.files.length) lines.push('\n**Files**: ' + o.files.slice(0, 30).map((f) => clip(f, 120)).join(', '));
  if (Array.isArray(o.topics) && o.topics.length) lines.push('\n**Topics**: ' + o.topics.slice(0, 12).map((t) => clip(t, 40)).join(', '));
  return lines.join('\n').slice(0, BODY_CAP);
}

/** LAZY distill — drains a bounded batch of un-distilled sessions per brain-enrich tick.
 *  `enriched_summary IS NULL` = needs distill; `''` = tried & gave up (don't spin). Re-sync
 *  resets to NULL to retry. */
export async function distillSessions(cap = 6): Promise<{ distilled: number; remaining: number }> {
  await ensureConnectorSchema();
  const rows = await query<any>(
    `SELECT id, title, body, raw FROM knowledge_item
      WHERE type='session' AND source IN ('claude-code','codex') AND enriched_summary IS NULL
      ORDER BY synced_at DESC LIMIT ${cap}`,
  ).catch(() => []);
  if (!rows.length) return { distilled: 0, remaining: 0 };

  let n = 0;
  for (const r of rows) {
    const input = buildDistillInput(r.raw?.digest, r.body);
    if (!input || input.length < 12) { await query(`UPDATE knowledge_item SET enriched_summary='' WHERE id=$1`, [r.id]).catch(() => {}); continue; }
    const out = await distillOne(input);
    if (!out || !out.summary) {
      // Mark tried so a poison/empty row can't block the head of the queue every tick; a later
      // re-sync (ingest) clears it back to NULL to retry with fresh content.
      await query(`UPDATE knowledge_item SET enriched_summary='' WHERE id=$1`, [r.id]).catch(() => {});
      continue;
    }
    const title = clip(out.title || r.title, 120);
    const md = renderMd(out);
    await query(`UPDATE knowledge_item SET title=$2, body=$3, enriched_summary=$4 WHERE id=$1`, [r.id, title, md, clip(out.summary, 4000) || ' ']).catch(() => {});
    n++;
  }
  const rem = await queryOne<{ c: string }>(`SELECT COUNT(*)::text c FROM knowledge_item WHERE type='session' AND source IN ('claude-code','codex') AND enriched_summary IS NULL`).catch(() => ({ c: '0' }));
  return { distilled: n, remaining: Number(rem?.c || 0) };
}
