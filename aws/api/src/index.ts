import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { query, queryOne, queryCount } from './db';
import { ok, created, noContent, badRequest, notFound, unauthorized, serverError, corsPreflightResponse, paymentRequired } from './response';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSecrets } from './secrets';
import { handleAI } from './ai';
import { handlePaddleWebhook, handleBilling, getUserPlan } from './billing';
import { planLimits, planLabel } from './plans';
import { ensureUsageSchema, getMeetingUsage, getBatchHoursUsage } from './usage';
import { runKgSweep, runPipelineForMeeting } from './kgSweep';
import { resetLinkState } from './kgLink';
import { reindexMeetingVectors, ensureKgGraphSchema } from './kgEmbed';
import { kickMeetingPipeline } from './kgTrigger';
import { runConnectorSync } from './connectors/sync';
import { ensureConnectorSchema, ACCOUNT_SCOPE } from './connectors/schema';
import { deleteToken, storeToken } from './trust/broker';
import { MCP_SERVERS, getMcpServer } from './mcp/registry';
import { jiraMeta, executeJiraAction, type JiraActionProposal } from './connectors/jira/actions';
import { runJiraAgentSweep } from './connectors/jira/agent';
import { listPendingProposals, resolveProposal } from './connectors/proposals';
import { listAudit, getAudit, markRolledBack } from './connectors/jira/audit';
import { getBrainEdges, neighboursOf } from './connectors/brainEdges';
import { getMapping, setGithubRepos, rememberRoute } from './connectors/routing';
import { executeMcpWrite } from './mcp/write';
import { mcpListTools, mcpCallTool } from './mcp/client';
import { beginMcpOAuth, completeMcpOAuth, type OAuthInflight } from './mcp/oauth';
import './connectors/registry'; // registers the no-op connector
import './connectors/jira';      // registers the Jira (Atlassian MCP) connector
import './connectors/github';    // registers the GitHub (remote MCP) connector
import { ensurePeopleSchema, upsertPerson } from './people';

// Desktop deep-link the OAuth provider redirects back to (validated client-side,
// like the Google sign-in callback). If a provider's DCR rejects custom schemes,
// switch this to a hosted https forwarder.
const CONNECTOR_REDIRECT_URI = 'wisprnote://connector-callback';

const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

// NOTE: Schema migrations are intentionally NOT run here.
// Running ALTER TABLE / CREATE INDEX on every cold start takes an
// ACCESS EXCLUSIVE lock and, under concurrency, causes a lock storm that can
// stall the whole table. Migrations live in aws/migration_perf.sql and are
// applied once at deploy time.

const FROM_EMAIL = process.env.SES_FROM_EMAIL || 'noreply@wisprnote.com';
const SITE_URL = (process.env.WISPRNOTE_PUBLIC_URL || 'https://www.wisprnote.com').replace(/\/$/, '');

const COGNITO_USER_POOL_ID = process.env.COGNITO_USER_POOL_ID || '';
const COGNITO_CLIENT_ID = process.env.COGNITO_CLIENT_ID || '';

const idTokenVerifier = CognitoJwtVerifier.create({
  userPoolId: COGNITO_USER_POOL_ID,
  tokenUse: 'id',
  clientId: COGNITO_CLIENT_ID,
});

interface VerifiedClaims {
  sub: string;
  email?: string;
}

async function verifyToken(event: APIGatewayProxyEvent): Promise<VerifiedClaims> {
  const authHeader = event.headers?.Authorization || event.headers?.authorization || '';
  const token = authHeader.replace(/^Bearer\s+/i, '');
  if (!token) throw new Error('UNAUTHORIZED');

  const payload = await idTokenVerifier.verify(token);
  return { sub: payload.sub, email: (payload as any).email || undefined };
}

let cachedClaims: VerifiedClaims | null = null;

function getUserId(): string {
  if (!cachedClaims?.sub) throw new Error('UNAUTHORIZED');
  return cachedClaims.sub;
}

function getUserEmail(): string | null {
  return cachedClaims?.email || null;
}

function parseBody(event: APIGatewayProxyEvent): any {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}


function generateToken(len = 22): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = new Uint8Array(len);
  require('crypto').randomFillSync(bytes);
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

async function sendShareInviteEmails(options: {
  to: string[];
  meetingTitle: string;
  shareToken: string;
  ownerEmail?: string | null;
}): Promise<void> {
  if (!options.to.length) return;
  const shareUrl = `${SITE_URL}/shared/${options.shareToken}`;
  const sharedBy = options.ownerEmail || 'Someone';
  const subject = `${sharedBy} shared a meeting with you on Wisprnote AI`;

  const html = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8" /><meta name="viewport" content="width=device-width,initial-scale=1" /></head>
<body style="margin:0;padding:0;background:#f5f0eb;font-family:'Inter',system-ui,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f0eb;padding:40px 0;">
    <tr><td align="center">
      <table width="520" cellpadding="0" cellspacing="0" style="background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.06);">

        <!-- Header -->
        <tr>
          <td style="background:#f06060;padding:32px 40px;text-align:center;">
            <p style="margin:0;font-size:22px;font-weight:700;color:#ffffff;letter-spacing:-0.3px;">Wisprnote AI</p>
            <p style="margin:6px 0 0;font-size:13px;color:rgba(255,255,255,0.8);">Listen once. Remember forever.</p>
          </td>
        </tr>

        <!-- Body -->
        <tr>
          <td style="padding:36px 40px 28px;">
            <p style="margin:0 0 8px;font-size:15px;font-weight:600;color:#1c1917;">You've been invited to a meeting</p>
            <p style="margin:0 0 24px;font-size:13px;color:#78716c;line-height:1.6;">
              <strong style="color:#1c1917;">${sharedBy}</strong> shared their meeting notes with you.
            </p>

            <!-- Meeting card -->
            <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf8f5;border:1px solid #e8e2da;border-radius:12px;margin-bottom:28px;">
              <tr>
                <td style="padding:20px 24px;">
                  <p style="margin:0 0 4px;font-size:11px;font-weight:600;color:#a8a29e;text-transform:uppercase;letter-spacing:0.08em;">Meeting</p>
                  <p style="margin:0;font-size:17px;font-weight:700;color:#1c1917;line-height:1.3;">${options.meetingTitle}</p>
                </td>
              </tr>
            </table>

            <!-- CTA button -->
            <table cellpadding="0" cellspacing="0" style="margin:0 auto;">
              <tr>
                <td style="background:#f06060;border-radius:999px;">
                  <a href="${shareUrl}" style="display:inline-block;padding:13px 32px;font-size:14px;font-weight:600;color:#ffffff;text-decoration:none;letter-spacing:-0.1px;">
                    View Meeting Notes →
                  </a>
                </td>
              </tr>
            </table>

            <p style="margin:28px 0 0;font-size:11px;color:#a8a29e;text-align:center;line-height:1.6;">
              Or copy this link: <a href="${shareUrl}" style="color:#f06060;word-break:break-all;">${shareUrl}</a>
            </p>
          </td>
        </tr>

        <!-- Footer -->
        <tr>
          <td style="border-top:1px solid #f0ebe4;padding:20px 40px;text-align:center;">
            <p style="margin:0;font-size:11px;color:#c4bab0;">
              Shared via <strong style="color:#78716c;">Wisprnote AI</strong> · You received this because your email was added to a shared meeting.
            </p>
          </td>
        </tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  const text = `${sharedBy} shared a meeting with you on Wisprnote AI\n\nMeeting: ${options.meetingTitle}\n\nView it here: ${shareUrl}`;

  const { RESEND_API_KEY } = await getSecrets();
  const results = await Promise.allSettled(
    options.to.map(email =>
      fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ from: `Wisprnote AI <${FROM_EMAIL}>`, to: [email], subject, html, text }),
      }).then(async r => {
        if (!r.ok) throw new Error(await r.text());
        return r.json() as Promise<{ id: string }>;
      })
    )
  );

  results.forEach((result, i) => {
    if (result.status === 'rejected') {
      console.error(`Resend failed for ${options.to[i]}:`, result.reason?.message || result.reason);
    } else {
      console.log(`Resend sent to ${options.to[i]}, id:`, result.value?.id);
    }
  });
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  // Warmer ping (EventBridge scheduled): keep a container hot so real user
  // requests don't pay the ~400ms VPC cold start. Eagerly load secrets so the
  // warm container already has them cached. Returns immediately — no auth/DB.
  if ((event as any).__warmer === true) {
    try { await getSecrets(); } catch { /* best effort */ }
    return { statusCode: 200, body: 'warm' } as APIGatewayProxyResult;
  }

  // Background knowledge-graph sweep (EventBridge scheduled). Extracts the KG
  // for any meetings that don't have one yet — no auth/HTTP, runs server-side
  // regardless of whether a desktop app is open. See kgSweep.ts.
  if ((event as any).__job === 'kg-sweep') {
    try {
      const r = await runKgSweep();
      return { statusCode: 200, body: JSON.stringify(r) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('kg_sweep_failed', JSON.stringify({ message: err?.message, code: err?.code, detail: err?.detail }));
      return { statusCode: 500, body: 'kg-sweep-error' } as APIGatewayProxyResult;
    }
  }

  // Maintenance: clear link state so every meeting re-links on the next sweeps
  // (used after a model/prompt change). Background-only — not reachable via HTTP.
  if ((event as any).__job === 'kg-relink') {
    try {
      const r = await resetLinkState();
      return { statusCode: 200, body: JSON.stringify(r) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('kg_relink_failed', JSON.stringify({ message: err?.message, code: err?.code }));
      return { statusCode: 500, body: 'kg-relink-error' } as APIGatewayProxyResult;
    }
  }

  // Fast-path: process ONE meeting's full pipeline (extract→embed→link) right
  // after it's saved. Async self-invoke from the task-save path. Background-only.
  if ((event as any).__job === 'kg-pipe-one') {
    const { userId: u, taskId: t } = event as any;
    try {
      const r = await runPipelineForMeeting(u, t);
      return { statusCode: 200, body: JSON.stringify(r) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('kg_pipe_one_failed', JSON.stringify({ taskId: t, message: err?.message, code: err?.code }));
      return { statusCode: 500, body: 'kg-pipe-one-error' } as APIGatewayProxyResult;
    }
  }

  // Maintenance: pipeline stats (counts). Background-only — not reachable via HTTP.
  if ((event as any).__job === 'kg-stats') {
    try {
      const edges = await queryOne(`SELECT
          count(*) FILTER (WHERE similarity IS NOT NULL)::int AS similarity_edges,
          count(*) FILTER (WHERE relationship_type IS NOT NULL)::int AS relationship_edges,
          count(DISTINCT from_task)::int AS meetings_with_edges
        FROM kg_edges`);
      const linked = await queryOne(`SELECT count(*)::int AS c FROM kg_link_state`);
      const emb = await queryOne(`SELECT count(*) FILTER (WHERE kind='meeting')::int AS meetings, count(*)::int AS total FROM kg_embeddings`);
      return { statusCode: 200, body: JSON.stringify({ edges, linked, embeddings: emb }) } as APIGatewayProxyResult;
    } catch (err: any) {
      return { statusCode: 500, body: JSON.stringify({ error: err?.message }) } as APIGatewayProxyResult;
    }
  }

  // Maintenance: backfill the Turbopuffer ANN index from Postgres meeting vectors
  // (initial backfill + gap repair). Background-only — not reachable via HTTP.
  if ((event as any).__job === 'kg-reindex-vectors') {
    try {
      const r = await reindexMeetingVectors();
      return { statusCode: 200, body: JSON.stringify(r) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('kg_reindex_failed', JSON.stringify({ message: err?.message, code: err?.code }));
      return { statusCode: 500, body: 'kg-reindex-error' } as APIGatewayProxyResult;
    }
  }

  // Connector sync (EventBridge). Drains connected credentials into knowledge_item
  // (the connector-side twin of kg-sweep). Gated off until connectors are enabled.
  if ((event as any).__job === 'connector-sync') {
    if (process.env.CONNECTORS_ENABLED !== '1') {
      return { statusCode: 200, body: JSON.stringify({ disabled: true }) } as APIGatewayProxyResult;
    }
    try {
      const r = await runConnectorSync();
      // Living brain: ingest meetings into knowledge_item (so they're first-class brain
      // nodes), then embed all new/changed items into the unified index. Bounded; best-effort.
      let ingested = 0; let embedded = 0;
      try { const { ingestMeetings } = await import('./connectors/meetingIngest'); ingested = (await ingestMeetings()).ingested; } catch (e: any) { console.error('meeting_ingest_failed', e?.message); }
      try { const { embedKnowledgeItems } = await import('./connectors/embed'); embedded = (await embedKnowledgeItems(96)).embedded; } catch (e: any) { console.error('brain_embed_failed', e?.message); }
      return { statusCode: 200, body: JSON.stringify({ ...r, ingested, embedded }) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('connector_sync_failed', JSON.stringify({ message: err?.message, code: err?.code, detail: err?.detail }));
      return { statusCode: 500, body: 'connector-sync-error' } as APIGatewayProxyResult;
    }
  }

  // Commit FINGERPRINT sweep (EventBridge) — Tier 1 of the cost-bounded brain pipeline.
  // Cheap & deterministic: get_commit (a GitHub API call, $0 in LLM tokens) → filenames +
  // stats fingerprint, so semantic candidate-matching has strong signal WITHOUT a diff→LLM
  // pass over every commit. The expensive Tier-2 diff summary is lazy — brain-link runs it
  // only for the handful of commits that actually become a meeting's link candidates.
  if ((event as any).__job === 'brain-enrich') {
    if (process.env.CONNECTORS_ENABLED !== '1') return { statusCode: 200, body: JSON.stringify({ disabled: true }) } as APIGatewayProxyResult;
    try {
      const { fingerprintCommits, backfillCommitSummaries } = await import('./connectors/github/enrich');
      const fp = await fingerprintCommits(20);                 // Tier 1: cheap, all commits
      const bf = await backfillCommitSummaries(6).catch(() => ({ enriched: 0, remaining: 0 }));   // Tier 2 drip, capped
      return { statusCode: 200, body: JSON.stringify({ ...fp, backfill: bf }) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('brain_enrich_failed', JSON.stringify({ message: err?.message }));
      return { statusCode: 500, body: 'brain-enrich-error' } as APIGatewayProxyResult;
    }
  }

  // Brain-link sweep (EventBridge). Computes cross-source associations into brain_edge.
  if ((event as any).__job === 'brain-link') {
    if (process.env.CONNECTORS_ENABLED !== '1') return { statusCode: 200, body: JSON.stringify({ disabled: true }) } as APIGatewayProxyResult;
    try {
      const { runBrainLink } = await import('./connectors/brainLink');
      return { statusCode: 200, body: JSON.stringify(await runBrainLink()) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('brain_link_failed', JSON.stringify({ message: err?.message }));
      return { statusCode: 500, body: 'brain-link-error' } as APIGatewayProxyResult;
    }
  }

  // Autonomous Jira agent sweep (EventBridge). PROPOSE-ONLY: writes editable proposals
  // into the action_proposal ledger for human review — never touches Jira directly.
  if ((event as any).__job === 'jira-agent-sweep') {
    if (process.env.CONNECTORS_ENABLED !== '1') {
      return { statusCode: 200, body: JSON.stringify({ disabled: true }) } as APIGatewayProxyResult;
    }
    try {
      const r = await runJiraAgentSweep();
      return { statusCode: 200, body: JSON.stringify(r) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('jira_agent_sweep_failed', JSON.stringify({ message: err?.message }));
      return { statusCode: 500, body: 'jira-agent-sweep-error' } as APIGatewayProxyResult;
    }
  }

  if (event.httpMethod === 'OPTIONS') return corsPreflightResponse();

  const path = event.path.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/');
  const resource = segments[0];
  const method = event.httpMethod;
  const qs = event.queryStringParameters || {};

  try {
    // Public route: share verification (no auth required)
    if (resource === 'shares' && segments[1] === 'verify' && segments[2] && method === 'GET') {
      return await handleShareVerify(segments[2], qs.email || null);
    }

    // Public route: Paddle billing webhook (verified by signature, not JWT).
    if (resource === 'billing' && segments[1] === 'webhook' && method === 'POST') {
      return await handlePaddleWebhook(event);
    }

    // Verify JWT and extract claims
    cachedClaims = await verifyToken(event);
    const userId = getUserId();

    switch (resource) {
      case 'tasks':    return await handleTasks(method, segments, userId, event);
      case 'assets':   return await handleAssets(method, userId, event);
      case 'notes':    return await handleNotes(method, segments, userId, event);
      case 'knowledge-graph': return await handleKnowledgeGraph(method, segments, userId, event);
      case 'chat':     return await handleChat(method, userId, event);
      case 'shares':   return await handleShares(method, segments, userId, event);
      case 'ledger':     return await handleLedger(method, segments, userId, event);
      case 'storage':    return await handleStorage(method, segments, userId, event);
      case 'workspaces': return await handleWorkspaces(method, segments, userId, event);
      case 'folders':    return await handleFolders(method, segments, userId, event);
      case 'connectors': return await handleConnectors(method, segments, userId, event);
      case 'proposals':  return await handleProposals(method, segments, userId, event);
      case 'brain':      return await handleBrain(method, segments, userId, event);
      case 'contacts':   return await handleContacts(method, userId, event);
      case 'bootstrap':  return await handleBootstrap(userId);
      case 'billing':    return await handleBilling(method, segments, userId, getUserEmail());
      case 'ai':         return await handleAI(method, segments, userId, event);
      default:           return notFound();
    }
  } catch (err: any) {
    if (err.message === 'UNAUTHORIZED') return unauthorized();
    // TEMP DIAGNOSTIC: log full error detail (pg errors expose code/detail, not
    // always .message) so the 500 root cause is visible in CloudWatch.
    console.error('Handler error:', JSON.stringify({
      message: err?.message,
      code: err?.code,
      detail: err?.detail,
      where: err?.where,
      routine: err?.routine,
      stack: err?.stack,
    }));
    return serverError(err?.message || err?.detail || `err code ${err?.code ?? 'unknown'}`);
  } finally {
    cachedClaims = null;
  }
};

// ─── TASKS ──────────────────────────────────────────────────────────────────

async function handleTasks(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const taskId = segments[1];
  const qs = event.queryStringParameters || {};

  if (method === 'POST' && !taskId) {
    const body = parseBody(event);
    await ensureUsageSchema(); // ensures the task_history.source column exists
    const source = body.source === 'batch' ? 'batch' : 'realtime';

    // ── Plan limits (server-side, authoritative — mirrors website pricing) ────
    // Free: 5 meetings total · Pro: 20/month + 5 batch hrs · Pro Plus: ∞ meetings
    // + 15 batch hrs · Enterprise: unlimited. Enforced here so it can't be
    // bypassed by the client.
    const plan = await getUserPlan(userId, getUserEmail());
    const lim = planLimits(plan);

    if (lim.meetings !== null) {
      const { used } = await getMeetingUsage(userId, plan);
      if (used >= lim.meetings) {
        return paymentRequired({
          error: 'meeting_limit_reached',
          scope: 'meetings',
          message: `Your ${planLabel(plan)} plan allows ${lim.meetings} meeting${lim.meetings === 1 ? '' : 's'}${lim.meetingsPeriod === 'month' ? ' per month' : ''}. Upgrade for more.`,
          plan,
          limit: lim.meetings,
          period: lim.meetingsPeriod,
          used,
        });
      }
    }

    if (source === 'batch' && lim.batchHours !== null) {
      const { usedHours } = await getBatchHoursUsage(userId, plan);
      const incomingHours = (Number(body.duration) || 0) / 3600;
      if (usedHours + incomingHours > lim.batchHours + 0.01) {
        return paymentRequired({
          error: 'batch_hours_exceeded',
          scope: 'batchHours',
          message: `Your ${planLabel(plan)} plan includes ${lim.batchHours} batch-processing hours per month. Upgrade for more.`,
          plan,
          limitHours: lim.batchHours,
          usedHours: Math.round(usedHours * 100) / 100,
        });
      }
    }

    const row = await queryOne(
      `INSERT INTO task_history (user_id, filename, transcription, summary, notes, audio_url, status, duration, prompt, personal_note, visualization_image, attendees, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
      [userId, body.filename, body.transcription, body.summary, body.notes, body.audio_url, body.status, body.duration || 0, body.prompt, body.personal_note, body.visualization_image, JSON.stringify(body.attendees ?? []), source]
    );
    // Fast-path: kick this meeting's KG pipeline immediately (async self-invoke,
    // best-effort) so the graph is ready before the user ever opens it. The cron
    // sweep is the safety net. Gated by KG_FASTPATH=1 (enable only after the
    // self-invoke IAM permission is in place) so there are no failed calls until
    // then. Only when there's a real transcription to process.
    if (process.env.KG_FASTPATH === '1' && row?.id && typeof body.transcription === 'string' && body.transcription.trim().length >= 50) {
      await kickMeetingPipeline(userId, row.id);
    }
    return created(row);
  }

  // Lazy visualization fetch: the base64 image is heavy and only needed when the
  // user opens the Notes tab, so it's excluded from the main task GET and fetched
  // on demand here.
  if (method === 'GET' && taskId && segments[2] === 'visualization') {
    const row = await queryOne<{ visualization_image: string | null }>(
      'SELECT visualization_image FROM task_history WHERE id=$1 AND user_id=$2',
      [taskId, userId]
    );
    return row ? ok({ visualization_image: row.visualization_image }) : notFound();
  }

  if (method === 'GET' && taskId) {
    // Exclude visualization_image (large base64) from the hot single-task fetch
    // that runs on every note open — it's lazy-loaded via the route above.
    const row = await queryOne(
      `SELECT id, user_id, created_at, filename, transcription, summary, notes,
              audio_url, status, duration, prompt, personal_note, attendees
       FROM task_history WHERE id=$1 AND user_id=$2`,
      [taskId, userId]
    );
    return row ? ok(row) : notFound();
  }

  if (method === 'GET' && !taskId) {
    const page = parseInt(qs.page || '0', 10);
    const pageSize = Math.min(parseInt(qs.pageSize || '24', 10), 100);
    const full = qs.full === 'true';
    const search = qs.search?.trim() || '';

    let whereClause = 'user_id=$1';
    const params: any[] = [userId];

    if (search) {
      params.push(`%${search}%`);
      whereClause += ` AND (filename ILIKE $${params.length} OR summary ILIKE $${params.length})`;
    }

    const total = await queryCount(`SELECT COUNT(*) FROM task_history WHERE ${whereClause}`, params);
    // Include attendees in the lightweight payload so the People chip renders on
    // first paint instead of waiting for the per-task detail fetch. It's a small
    // JSONB column (GIN-indexed) so it adds negligible cost to the list query.
    // Even the "full" list never needs the heavy base64 visualization_image —
    // exclude it so bulk fetches don't transfer hundreds of MB. The lightweight
    // list stays minimal (+ attendees for the People chip).
    const fields = full
      ? 'id, user_id, created_at, filename, transcription, summary, notes, audio_url, status, duration, prompt, personal_note, attendees'
      : 'id, created_at, filename, summary, status, duration, attendees';
    const rows = await query(
      `SELECT ${fields} FROM task_history WHERE ${whereClause} ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, pageSize, page * pageSize]
    );
    return ok({ data: rows, hasMore: total > (page + 1) * pageSize, total });
  }

  if (method === 'PUT' && taskId) {
    const body = parseBody(event);
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    for (const key of ['filename', 'summary', 'notes', 'personal_note', 'visualization_image']) {
      if (body[key] !== undefined) { sets.push(`${key}=$${idx++}`); vals.push(body[key]); }
    }
    if (body.attendees !== undefined) {
      sets.push(`attendees=$${idx++}::jsonb`);
      vals.push(JSON.stringify(body.attendees));
    }
    if (!sets.length) return badRequest('No fields to update');
    vals.push(taskId, userId);
    const row = await queryOne(
      `UPDATE task_history SET ${sets.join(',')} WHERE id=$${idx++} AND user_id=$${idx} RETURNING *`, vals
    );
    return row ? ok(row) : notFound();
  }

  return notFound();
}

// ─── ASSETS ─────────────────────────────────────────────────────────────────

async function handleAssets(method: string, userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters || {};

  if (method === 'POST') {
    const body = parseBody(event);
    // SECURITY: only attach assets to a task the caller owns.
    if (body.task_id) {
      const owns = await queryOne('SELECT 1 FROM task_history WHERE id=$1 AND user_id=$2', [body.task_id, userId]);
      if (!owns) return notFound();
    }
    const row = await queryOne(
      'INSERT INTO generated_assets (user_id, task_id, type, filename, content) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [userId, body.task_id, body.type, body.filename, JSON.stringify(body.content)]
    );
    return created(row);
  }

  if (method === 'GET') {
    const taskId = qs.taskId;
    if (!taskId) return badRequest('taskId required');
    const rows = await query('SELECT * FROM generated_assets WHERE task_id=$1 AND user_id=$2 ORDER BY created_at DESC', [taskId, userId]);
    return ok(rows);
  }

  return notFound();
}

// ─── NOTES ──────────────────────────────────────────────────────────────────

async function handleNotes(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const noteId = segments[1];

  if (method === 'POST') {
    const body = parseBody(event);
    if (body.id) {
      const row = await queryOne(
        `UPDATE manual_notes SET title=$1, content=$2, updated_at=NOW() WHERE id=$3 AND user_id=$4 RETURNING *`,
        [body.title, body.content, body.id, userId]
      );
      if (!row) {
        const inserted = await queryOne(
          'INSERT INTO manual_notes (id, user_id, title, content) VALUES ($1,$2,$3,$4) RETURNING *',
          [body.id, userId, body.title, body.content]
        );
        return created(inserted);
      }
      return ok(row);
    }
    const row = await queryOne(
      'INSERT INTO manual_notes (user_id, title, content) VALUES ($1,$2,$3) RETURNING *',
      [userId, body.title, body.content]
    );
    return created(row);
  }

  if (method === 'GET' && !noteId) {
    const rows = await query('SELECT * FROM manual_notes WHERE user_id=$1 ORDER BY updated_at DESC', [userId]);
    return ok(rows);
  }

  if (method === 'DELETE' && noteId) {
    await query('DELETE FROM manual_notes WHERE id=$1 AND user_id=$2', [noteId, userId]);
    return noContent();
  }

  return notFound();
}

// ─── CONNECTORS ─────────────────────────────────────────────────────────────
// Per-user external-tool connections (MCP-based). GET returns connection status
// for the UI; DELETE disconnects. OAuth connect (oauth-url/exchange) lands in UI-1.
async function handleConnectors(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (process.env.CONNECTORS_ENABLED !== '1') return ok({ enabled: false, connectors: [] });
  await ensureConnectorSchema();
  const id = segments[1];
  // Connections are workspace-scoped. The client passes the active workspace via
  // ?workspace= (GET/DELETE) or body.workspace (oauth-url); ACCOUNT_SCOPE if absent.
  const qsWorkspace = event.queryStringParameters?.workspace || ACCOUNT_SCOPE;

  if (method === 'GET' && !id) {
    const creds = await query<{ source: string; account: string | null }>(
      `SELECT source, account FROM connector_credentials WHERE user_id=$1 AND workspace_id=$2`,
      [userId, qsWorkspace],
    );
    const byId = new Map(creds.map((c) => [c.source, c]));
    const connectors = Object.values(MCP_SERVERS).map((s) => ({
      id: s.id,
      connected: byId.has(s.id),
      account: byId.get(s.id)?.account ?? null,
      status: s.status,
    }));
    return ok({ enabled: true, workspace: qsWorkspace, connectors });
  }

  if (method === 'DELETE' && id) {
    await deleteToken(userId, id, qsWorkspace);
    return noContent();
  }

  // GET /connectors/jira/meta?workspace= → projects + issue types for the action card.
  if (method === 'GET' && id === 'jira' && segments[2] === 'meta') {
    const meta = await jiraMeta(userId, qsWorkspace);
    return ok(meta);
  }

  // POST /connectors/jira/action?workspace= { ...proposal } → execute ONE approved write.
  // Human-in-the-loop: the client only calls this after the user confirms the card.
  if (method === 'POST' && id === 'jira' && segments[2] === 'action') {
    const proposal = parseBody(event) as JiraActionProposal;
    if (!proposal?.operation) return badRequest('operation required');
    const result = await executeJiraAction(userId, qsWorkspace, proposal);
    return ok(result);
  }

  // POST /connectors/mcp-write?workspace= { connector, tool, args } → execute ONE approved
  // generic write (Confluence/worklog/links/Compass/…). HITL: only after card approval.
  if (method === 'POST' && id === 'mcp-write') {
    const body = parseBody(event);
    const tool = String(body.tool || '');
    if (!tool) return badRequest('tool required');
    const result = await executeMcpWrite(userId, qsWorkspace, String(body.connector || 'jira'), tool, body.args || {});
    return ok(result);
  }

  // GET /connectors/jira/audit?workspace= → recent executed actions (audit ledger).
  if (method === 'GET' && id === 'jira' && segments[2] === 'audit') {
    const rows = await listAudit(userId, qsWorkspace);
    return ok({ audit: rows });
  }

  // POST /connectors/jira/audit/{id}/rollback → undo a recorded action via its inverse.
  if (method === 'POST' && id === 'jira' && segments[2] === 'audit' && segments[3] && segments[4] === 'rollback') {
    const row = await getAudit(userId, segments[3]);
    if (!row) return notFound();
    if (row.status === 'rolled_back') return ok({ ok: false, message: 'Already rolled back.' });
    if (!row.rollback) return ok({ ok: false, message: 'This action can’t be undone automatically.' });
    const result = await executeJiraAction(userId, row.workspace_id, row.rollback, { audit: false });
    if (result.ok) await markRolledBack(userId, segments[3], result);
    return ok(result);
  }

  // GET /connectors/routing?workspace=[&folder=] → the (folder→workspace-fallback) project mapping.
  if (method === 'GET' && id === 'routing') {
    return ok(await getMapping(userId, qsWorkspace, event.queryStringParameters?.folder || null));
  }
  // POST /connectors/routing?workspace=[&folder=] { source, projectKey?, repos? } → set the mapping
  // for a FOLDER (project) or the workspace default, then backfill so existing items tag to it.
  if (method === 'POST' && id === 'routing') {
    const b = parseBody(event);
    const folder = event.queryStringParameters?.folder || null;
    if (b.source === 'jira' && b.projectKey) await rememberRoute(userId, qsWorkspace, String(b.projectKey), 'jira', true, folder);
    if (b.source === 'github') {
      const repos = Array.isArray(b.repos) ? b.repos.map((r: any) => String(r).trim()).filter(Boolean) : [];
      await setGithubRepos(userId, qsWorkspace, repos, folder);
      // Legacy workspace-wide prune ONLY for the non-folder default mapping (folder mappings are
      // additive — each project keeps its own repos; pruning would delete other projects' items).
      if (!folder && repos.length) {
        await query(
          `DELETE FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source='github' AND split_part(source_id,'#',1) <> ALL($3)`,
          [userId, qsWorkspace, repos],
        ).catch(() => {});
      }
    }
    // Re-tag existing items into their projects now that the mapping changed (idempotent).
    try { const { backfillItemFolders } = await import('./connectors/sync'); await backfillItemFolders(); } catch { /* best-effort */ }
    return ok({ ok: true, mapping: await getMapping(userId, qsWorkspace, folder) });
  }

  // POST /connectors/{id}/pat?workspace= { token } → connect via a Personal Access Token
  // (for MCP servers whose OAuth lacks DCR, e.g. GitHub). Validated against the live server.
  if (method === 'POST' && id && segments[2] === 'pat') {
    const server = getMcpServer(id);
    if (!server?.url) return badRequest('connector has no MCP endpoint');
    const token = String(parseBody(event).token || '').trim();
    if (!token) return badRequest('token required');
    try {
      await mcpListTools(server, token);   // verify the token actually authenticates
    } catch (e: any) {
      return ok({ connected: false, error: `Token was rejected by ${id}. Check the token and its scopes.`, detail: String(e?.message || '').slice(0, 160) });
    }
    await storeToken(userId, id, { access_token: token }, null, server.scopes ?? null, qsWorkspace);
    return ok({ connected: true });
  }

  // POST /connectors/{id}/oauth-url { workspace } → discover + DCR + PKCE authorize URL.
  if (method === 'POST' && id && segments[2] === 'oauth-url') {
    const server = getMcpServer(id);
    if (!server || !server.url) return badRequest('connector has no MCP endpoint');
    const workspaceId = String(parseBody(event).workspace || ACCOUNT_SCOPE);
    const { authorizeUrl, inflight } = await beginMcpOAuth(server, CONNECTOR_REDIRECT_URI);
    await query(
      `INSERT INTO oauth_state (state, user_id, source, workspace_id, inflight) VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (state) DO UPDATE SET inflight=EXCLUDED.inflight, workspace_id=EXCLUDED.workspace_id, created_at=NOW()`,
      [inflight.state, userId, id, workspaceId, JSON.stringify(inflight)],
    );
    return ok({ url: authorizeUrl });
  }

  // POST /connectors/{id}/exchange { code, state } → token → broker (in the workspace
  // recorded at oauth-url time, so the connection lands where the user started it).
  if (method === 'POST' && id && segments[2] === 'exchange') {
    const body = parseBody(event);
    const code = String(body.code || '');
    const state = String(body.state || '');
    if (!code || !state) return badRequest('missing code/state');
    const row = await queryOne<{ inflight: OAuthInflight; workspace_id: string }>(
      `SELECT inflight, workspace_id FROM oauth_state WHERE state=$1 AND user_id=$2 AND source=$3`,
      [state, userId, id],
    );
    if (!row) return badRequest('unknown or expired oauth state');
    const token = await completeMcpOAuth(row.inflight, code);
    // Persist the OAuth refresh metadata + expiry WITH the token so the broker can auto-refresh
    // it later (OAuth access tokens are short-lived; without this the connector goes dark in ~1h).
    const stored = {
      ...token.raw,
      oauth_meta: { token_endpoint: row.inflight.tokenEndpoint, client_id: row.inflight.clientId, client_secret: row.inflight.clientSecret ?? null },
      expires_at: token.expires_in ? Date.now() + (token.expires_in - 60) * 1000 : null,
    };
    await storeToken(
      userId, id, stored, null,
      row.inflight.scope ? row.inflight.scope.split(' ') : null,
      row.workspace_id || ACCOUNT_SCOPE,
    );
    await query(`DELETE FROM oauth_state WHERE state=$1`, [state]);
    return ok({ connected: true });
  }

  return notFound();
}

// ─── BRAIN (cross-source association graph) ──────────────────────────────────
async function handleBrain(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (process.env.CONNECTORS_ENABLED !== '1') return ok({ enabled: false, edges: [] });
  if (method === 'GET' && segments[1] === 'edges') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    return ok({ enabled: true, edges: await getBrainEdges(userId, ws) });
  }

  // POST /brain/sync?workspace= → ON-DEMAND freshness (the sync-now / open-the-app path).
  // Bounded to fit the API-GW window: pull this workspace's latest Jira/GitHub state, ingest
  // meetings, embed + fingerprint the new items, and form CHEAP links (no slow LLM verdicts —
  // those refresh on the 30-min cron). New commits/tasks + status changes appear immediately.
  if (method === 'POST' && segments[1] === 'sync') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const out: any = { synced: 0, ingested: 0, embedded: 0, fingerprinted: 0 };
    try {
      const { runConnectorSync } = await import('./connectors/sync');
      out.synced = (await runConnectorSync(ws)).processed;
      try { const { ingestMeetings } = await import('./connectors/meetingIngest'); out.ingested = (await ingestMeetings()).ingested; } catch { /* best-effort */ }
      try { const { fingerprintCommits } = await import('./connectors/github/enrich'); out.fingerprinted = (await fingerprintCommits(8)).fingerprinted; } catch { /* best-effort */ }
      try { const { embedKnowledgeItems } = await import('./connectors/embed'); out.embedded = (await embedKnowledgeItems(48)).embedded; } catch { /* best-effort */ }
      try { const { runBrainLink } = await import('./connectors/brainLink'); await runBrainLink({ workspaceId: ws, llmBudget: 0, timeBudgetMs: 8000 }); } catch { /* verdicts catch up on the cron */ }
    } catch (err: any) {
      console.error('brain_sync_now_failed', JSON.stringify({ message: err?.message }));
    }
    return ok({ enabled: true, ...out, syncedAt: new Date().toISOString() });
  }

  // GET /brain/alerts?workspace= → the leader-facing OFF-TRACK digest: code that diverged
  // from what was decided, risky commits, and tasks stuck in progress. The "is anything wrong?"
  // view for a CEO/lead.
  if (method === 'GET' && segments[1] === 'alerts') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    // Optional folder (project) scope: present → just that project; absent → whole workspace.
    // `$3::uuid IS NULL OR col=$3` makes one query serve both (null = aggregate).
    const folder = event.queryStringParameters?.folder || null;
    const alerts: any[] = [];
    // 1) Divergent work — a commit/PR went a different direction than the meeting/task intended.
    const diverged = await query<any>(
      `SELECT di.title impl, di.links->>'url' url, e.rationale, si.title intent
         FROM brain_edge e JOIN knowledge_item si ON si.id::text=e.src_id JOIN knowledge_item di ON di.id::text=e.dst_id
        WHERE e.user_id=$1 AND e.workspace_id=$2 AND e.verdict='divergent'
          AND ($3::uuid IS NULL OR di.folder_id=$3) ORDER BY e.created_at DESC LIMIT 15`,
      [userId, ws, folder],
    ).catch(() => []);
    for (const d of diverged) alerts.push({ type: 'divergent', severity: 'high', title: d.impl, detail: d.rationale || `Diverges from "${d.intent}"`, intent: d.intent, url: d.url ?? null });
    // 2) Risky commits — the co-architect flagged an architectural risk.
    const risky = await query<any>(
      `SELECT title, advisory_assessment, advisory_note, links->>'url' url FROM knowledge_item
        WHERE user_id=$1 AND workspace_id=$2 AND advisory_assessment IN ('risk','concern')
          AND ($3::uuid IS NULL OR folder_id=$3) ORDER BY (advisory_assessment='risk') DESC, synced_at DESC LIMIT 20`,
      [userId, ws, folder],
    ).catch(() => []);
    for (const r of risky) alerts.push({ type: r.advisory_assessment === 'risk' ? 'risk' : 'concern', severity: r.advisory_assessment === 'risk' ? 'high' : 'low', title: r.title, detail: r.advisory_note || 'Architectural attention suggested', url: r.url ?? null });
    // 3) Stalled work — a task in progress with no update for over a week.
    const stalled = await query<any>(
      `SELECT title, status, occurred_at, links->>'url' url FROM knowledge_item
        WHERE user_id=$1 AND workspace_id=$2 AND source='jira' AND status ~* 'progress|review|doing'
          AND occurred_at < NOW() - INTERVAL '7 days'
          AND ($3::uuid IS NULL OR folder_id=$3) ORDER BY occurred_at ASC LIMIT 15`,
      [userId, ws, folder],
    ).catch(() => []);
    for (const s of stalled) alerts.push({ type: 'stalled', severity: 'medium', title: s.title, detail: `Stuck in "${s.status}" since ${new Date(s.occurred_at).toISOString().slice(0, 10)}`, url: s.url ?? null });
    // 4) Untracked decisions — a meeting (>7d ago) that HAD action items / decisions but never
    //    became a Jira task (no edge to any jira item). "Decided, but nobody is tracking it."
    const untracked = await query<any>(
      `SELECT ki.title, ki.occurred_at,
              jsonb_array_length(COALESCE(kg.action_items, '[]'::jsonb)) ai,
              jsonb_array_length(COALESCE(kg.decisions, '[]'::jsonb)) dec
         FROM knowledge_item ki
         JOIN knowledge_graph kg ON kg.task_id::text = ki.source_id AND kg.user_id = ki.user_id
        WHERE ki.user_id=$1 AND ki.workspace_id=$2 AND ki.source='meeting'
          AND ki.occurred_at < NOW() - INTERVAL '7 days'
          AND ($3::uuid IS NULL OR ki.folder_id=$3)
          AND (jsonb_array_length(COALESCE(kg.action_items, '[]'::jsonb)) > 0 OR jsonb_array_length(COALESCE(kg.decisions, '[]'::jsonb)) > 0)
          AND NOT EXISTS (
            SELECT 1 FROM brain_edge e JOIN knowledge_item ji ON ji.id::text = e.dst_id
             WHERE e.user_id=ki.user_id AND e.workspace_id=ki.workspace_id AND e.src_id = ki.id::text AND ji.source='jira')
        ORDER BY ki.occurred_at DESC LIMIT 15`,
      [userId, ws, folder],
    ).catch(() => []);
    for (const u of untracked) alerts.push({ type: 'untracked', severity: 'medium', title: u.title, detail: `Had ${u.ai} action item(s) / ${u.dec} decision(s) but no Jira task exists — decided ${new Date(u.occurred_at).toISOString().slice(0, 10)}`, url: null });
    return ok({ enabled: true, alerts });
  }

  // GET /brain/pulse?workspace= → the who-did-what-when activity feed (recent observed events).
  if (method === 'GET' && segments[1] === 'pulse') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const { getEvents } = await import('./connectors/brainEvents');
    const events = await getEvents(userId, ws, 40, event.queryStringParameters?.folder || null);
    return ok({ enabled: true, events: events.map((e) => ({ kind: e.kind, source: e.source, sourceId: e.source_id, actor: e.actor, from: e.from_state, to: e.to_state, title: e.title, at: e.occurred_at })) });
  }
  // GET /brain/node?workspace=&id=item:123 → the full info card for one node: its content
  // (for commits, the diff-grounded summary) + every reasoned connection (relation, verdict,
  // rationale) so the brain map can show rich detail like the knowledge graph — not just a link.
  if (method === 'GET' && segments[1] === 'node') {
    const ws = event.queryStringParameters?.workspace;
    const rawId = (event.queryStringParameters?.id || '').replace(/^item:/, '');
    if (!ws || !rawId || !/^\d+$/.test(rawId)) return badRequest('workspace + numeric id required');
    const node = await queryOne<any>(
      `SELECT id, source, type, title, body, enriched_summary, fingerprint, people, links, source_id, occurred_at, status, advisory_assessment, advisory_note
         FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND id=$3`,
      [userId, ws, rawId],
    ).catch(() => null);
    if (!node) return notFound();
    // On-demand enrichment: if you OPEN a commit that has no diff-summary yet, generate it now
    // (one cheap Flash call) so the card always shows PROSE — never the raw fingerprint dump.
    // Bounded by "only commits you actually look at"; cached after.
    if (node.type === 'commit' && !node.enriched_summary) {
      try {
        const { enrichCommit } = await import('./connectors/github/enrich');
        const s = await enrichCommit(userId, ws, rawId);
        if (s) node.enriched_summary = s;
      } catch { /* fall back to fingerprint */ }
    }
    // Timeline of observed changes for this item (who moved it when).
    const events = await query<any>(
      `SELECT kind, actor, from_state, to_state, occurred_at FROM brain_event
         WHERE user_id=$1 AND workspace_id=$2 AND item_id=$3 ORDER BY occurred_at DESC NULLS LAST LIMIT 12`,
      [userId, ws, rawId],
    ).catch(() => []);
    const edges = await neighboursOf(userId, ws, 'item', rawId, 40).catch(() => []);
    // Resolve the OTHER end of each edge to a real item (title/source/url), keep the reasoning.
    const otherIds = Array.from(new Set(edges.map((e) => (e.src_id === rawId ? e.dst_id : e.src_id)).filter((x) => /^\d+$/.test(x))));
    const others = otherIds.length ? await query<any>(
      `SELECT id, source, type, title, source_id, links FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND id = ANY($3::bigint[])`,
      [userId, ws, otherIds],
    ).catch(() => []) : [];
    const byId = new Map(others.map((o: any) => [String(o.id), o]));
    const connections = edges.map((e) => {
      const outgoing = e.src_id === rawId;
      const otherId = outgoing ? e.dst_id : e.src_id;
      const o = byId.get(otherId);
      if (!o) return null;
      return {
        id: `item:${o.id}`, title: o.title || o.source_id, source: o.source, type: o.type, url: o.links?.url ?? null,
        relation: e.relation, origin: e.origin, direction: outgoing ? 'out' : 'in',
        verdict: e.verdict ?? null, rationale: e.rationale ?? null,
      };
    }).filter(Boolean);
    // Verdict-bearing (reasoned) connections first, then by source.
    connections.sort((a: any, b: any) => (b.verdict ? 1 : 0) - (a.verdict ? 1 : 0));
    return ok({
      enabled: true,
      node: {
        id: `item:${node.id}`, source: node.source, type: node.type, title: node.title || node.source_id,
        summary: node.enriched_summary || node.fingerprint || node.body || null,
        body: node.body || null, people: node.people || null, url: node.links?.url ?? null,
        sourceId: node.source_id, occurredAt: node.occurred_at, status: node.status ?? null,
        advisoryAssessment: node.advisory_assessment ?? null, advisoryNote: node.advisory_note ?? null,
      },
      connections,
      events: events.map((e: any) => ({ kind: e.kind, actor: e.actor, from: e.from_state, to: e.to_state, at: e.occurred_at })),
    });
  }

  // GET /brain/graph?workspace=[&folder=] → nodes (items + meetings) + edges, for the brain map.
  // folder set → just that project (scoped view); omitted → the whole workspace (aggregate).
  if (method === 'GET' && segments[1] === 'graph') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const folder = event.queryStringParameters?.folder || null;
    const edges = await getBrainEdges(userId, ws, 1500);
    // Meetings are now knowledge_item rows (source='meeting'), so this single query covers
    // every brain node — meetings, Jira, GitHub. Scoping NODES by folder is enough: the client
    // drops any edge whose endpoints aren't both present, so only intra-project edges render.
    const items = await query<any>(
      `SELECT id, source, type, title, source_id, links, status FROM knowledge_item
        WHERE user_id=$1 AND workspace_id=$2 AND ($3::uuid IS NULL OR folder_id=$3) LIMIT 2000`,
      [userId, ws, folder],
    ).catch(() => []);
    const nodes: any[] = items.map((i: any) => ({ id: `item:${i.id}`, kind: 'item', source: i.source, type: i.type, title: i.title || i.source_id, url: i.links?.url ?? null, status: i.status ?? null }));
    // Reasoning lives ON the edge (verdict + rationale colour & explain the line — no more
    // floating reasoning nodes). Backfill verdicts from the brain_reasoning ledger so already-
    // judged links (computed before the edge columns existed) colour immediately.
    const { getReasoning } = await import('./connectors/brainReasoning');
    const reasoning = await getReasoning(userId, ws).catch(() => []);
    const byPair = new Map<string, { verdict: string; rationale: string | null }>();
    for (const rr of reasoning) byPair.set(`${rr.meeting_id}->${rr.impl_id}`, { verdict: rr.verdict, rationale: rr.rationale });
    const outEdges = edges.map((e: any) => {
      const verdict = e.verdict || byPair.get(`${e.src_id}->${e.dst_id}`)?.verdict || byPair.get(`${e.dst_id}->${e.src_id}`)?.verdict || null;
      const rationale = e.rationale || byPair.get(`${e.src_id}->${e.dst_id}`)?.rationale || byPair.get(`${e.dst_id}->${e.src_id}`)?.rationale || null;
      return { ...e, verdict, rationale };
    });
    return ok({ enabled: true, nodes, edges: outEdges });
  }
  return notFound();
}

// ─── ACTION PROPOSALS (autonomous agent → HITL queue) ────────────────────────
// The agent writes proposals; the UI lists pending ones and resolves them after the
// human approves (executed) or dismisses. Approval execution itself goes through the
// Jira action route — this only records the outcome in the ledger.
async function handleProposals(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (process.env.CONNECTORS_ENABLED !== '1') return ok({ enabled: false, proposals: [] });
  const id = segments[1];

  if (method === 'GET' && !id) {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const proposals = await listPendingProposals(userId, ws);
    return ok({ enabled: true, proposals });
  }

  if (method === 'POST' && id && segments[2] === 'resolve') {
    const body = parseBody(event);
    const status = body.status === 'executed' ? 'executed' : 'dismissed';
    await resolveProposal(userId, id, status, body.result);
    return ok({ ok: true });
  }

  return notFound();
}

// ─── KNOWLEDGE GRAPH ────────────────────────────────────────────────────────

async function handleKnowledgeGraph(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const taskId = segments[1];

  if (method === 'POST') {
    const body = parseBody(event);
    const entries = Array.isArray(body) ? body : [body];
    const results: any[] = [];
    for (const e of entries) {
      const row = await queryOne(
        `INSERT INTO knowledge_graph (user_id, task_id, meeting_title, topics, decisions, people, action_items, refs)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (user_id, task_id) DO UPDATE SET
           meeting_title=EXCLUDED.meeting_title, topics=EXCLUDED.topics, decisions=EXCLUDED.decisions,
           people=EXCLUDED.people, action_items=EXCLUDED.action_items, refs=EXCLUDED.refs, updated_at=NOW()
         RETURNING *`,
        [userId, e.task_id, e.meeting_title, JSON.stringify(e.topics), JSON.stringify(e.decisions),
         JSON.stringify(e.people), JSON.stringify(e.action_items), JSON.stringify(e.refs)]
      );
      results.push(row);
    }
    return Array.isArray(body) ? ok(results) : ok(results[0]);
  }

  // Precomputed cross-meeting edges (Stage C output) + processing status, so the
  // client renders instantly without running its own embedding/relationship pass.
  //
  // Scoping (all optional — no params = the full graph, backward-compatible):
  //   ?workspace=<id>   only meetings in that workspace
  //   ?since=<ms>&until=<ms>   meeting-date window (epoch ms)
  //   ?limit=<n>        cap to the N most-recent meetings (for large corpora)
  // When scoped, edges are returned only between in-scope meetings (no dangling
  // edges), and `meetings` lists the in-scope task_ids so the client can match nodes.
  if (method === 'GET' && segments[1] === 'edges') {
    await ensureKgGraphSchema();
    const q = event.queryStringParameters || {};
    const workspace = (q.workspace || '').trim() || null;
    const sinceMs = q.since && /^\d+$/.test(q.since) ? Number(q.since) : null;
    const untilMs = q.until && /^\d+$/.test(q.until) ? Number(q.until) : null;
    const limit = q.limit && /^\d+$/.test(q.limit) ? Math.min(Number(q.limit), 5000) : null;
    const scoped = !!(workspace || sinceMs || untilMs || limit);

    const edgeCols = `from_task, to_task, similarity, relationship_type, shared_thread, confidence`;

    if (!scoped) {
      const edges = await query(`SELECT ${edgeCols} FROM kg_edges WHERE user_id=$1`, [userId]);
      const processing = await query<{ task_id: string }>(
        `SELECT kg.task_id FROM knowledge_graph kg
           LEFT JOIN kg_link_state s ON s.user_id=kg.user_id AND s.task_id=kg.task_id
          WHERE kg.user_id=$1 AND s.task_id IS NULL`,
        [userId],
      );
      return ok({ edges, processing: processing.map((p) => p.task_id) });
    }

    // Resolve the in-scope meeting set (most-recent first, by meeting date).
    const conds = ['kg.user_id = $1'];
    const params: any[] = [userId];
    let joins = ' JOIN task_history th ON th.id = kg.task_id AND th.user_id = kg.user_id';
    if (workspace) { joins += ' JOIN task_workspaces tw ON tw.task_id = kg.task_id'; params.push(workspace); conds.push(`tw.workspace_id = $${params.length}`); }
    if (sinceMs) { params.push(sinceMs); conds.push(`th.created_at >= to_timestamp($${params.length}/1000.0)`); }
    if (untilMs) { params.push(untilMs); conds.push(`th.created_at <= to_timestamp($${params.length}/1000.0)`); }
    const lim = limit ?? 2000; // validated integer; safe to inline
    const setRows = await query<{ task_id: string }>(
      `SELECT kg.task_id FROM knowledge_graph kg${joins}
        WHERE ${conds.join(' AND ')}
        ORDER BY th.created_at DESC LIMIT ${lim}`,
      params,
    );
    const ids = setRows.map((r) => r.task_id);
    if (ids.length === 0) return ok({ edges: [], processing: [], meetings: [] });

    const edges = await query(
      `SELECT ${edgeCols} FROM kg_edges
        WHERE user_id=$1 AND from_task = ANY($2::uuid[]) AND to_task = ANY($2::uuid[])`,
      [userId, ids],
    );
    const processing = await query<{ task_id: string }>(
      `SELECT kg.task_id FROM knowledge_graph kg
         LEFT JOIN kg_link_state s ON s.user_id=kg.user_id AND s.task_id=kg.task_id
        WHERE kg.user_id=$1 AND s.task_id IS NULL AND kg.task_id = ANY($2::uuid[])`,
      [userId, ids],
    );
    return ok({ edges, processing: processing.map((p) => p.task_id), meetings: ids });
  }

  if (method === 'GET' && taskId) {
    const row = await queryOne('SELECT * FROM knowledge_graph WHERE task_id=$1 AND user_id=$2', [taskId, userId]);
    return row ? ok(row) : notFound();
  }

  if (method === 'GET' && !taskId) {
    const rows = await query('SELECT * FROM knowledge_graph WHERE user_id=$1 ORDER BY created_at DESC', [userId]);
    return ok(rows);
  }

  if (method === 'DELETE' && taskId) {
    await query('DELETE FROM knowledge_graph WHERE task_id=$1 AND user_id=$2', [taskId, userId]);
    return noContent();
  }

  return notFound();
}

// ─── CHAT ───────────────────────────────────────────────────────────────────

// Lazily add the workspace_id column (per warm container) so workspace-scoped
// chat threads can be tagged + filtered without a separate migration step.
let _chatSchemaReady: Promise<void> | null = null;
function ensureChatSchema(): Promise<void> {
  if (!_chatSchemaReady) {
    _chatSchemaReady = query('ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS workspace_id TEXT').then(() => {});
  }
  return _chatSchemaReady;
}

async function handleChat(method: string, userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters || {};
  await ensureChatSchema();

  if (method === 'POST') {
    const body = parseBody(event);
    const messages = Array.isArray(body) ? body : [body];
    const results: any[] = [];
    for (const m of messages) {
      const row = await queryOne(
        `INSERT INTO chat_history (user_id, task_id, role, text, image, thread_id, citations, retrieval_meta, agent_status, agent_plan, workspace_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [userId, m.task_id || null, m.role, m.text, m.image || null, m.thread_id || null,
         JSON.stringify(m.citations || []), JSON.stringify(m.retrieval_meta || {}),
         m.agent_status || null, JSON.stringify(m.agent_plan || []), m.workspace_id || null]
      );
      results.push(row);
    }
    return Array.isArray(body) ? ok(results) : ok(results[0]);
  }

  if (method === 'GET') {
    // Durable thread list derived from chat_history — so the chat history is
    // reliable even if the client's localStorage thread index is lost.
    if (qs.threads) {
      // A workspace's chat threads are scoped to that workspace; the GLOBAL chat
      // list excludes them (workspace_id IS NULL) so the two never mix.
      const scope = qs.workspaceId
        ? 'ch.workspace_id = $2'
        : 'ch.workspace_id IS NULL';
      const params = qs.workspaceId ? [userId, qs.workspaceId] : [userId];
      const rows = await query(
        `SELECT ch.thread_id,
                ch.task_id,
                MIN(ch.created_at) AS created_at,
                MAX(ch.created_at) AS updated_at,
                (ARRAY_AGG(ch.text ORDER BY ch.created_at) FILTER (WHERE ch.role = 'user'))[1] AS title,
                (ARRAY_AGG(ch.text ORDER BY ch.created_at DESC))[1] AS preview,
                th.filename AS task_title
         FROM chat_history ch
         LEFT JOIN task_history th ON th.id = ch.task_id
         WHERE ch.user_id = $1 AND ${scope} AND ch.thread_id IS NOT NULL AND ch.thread_id <> ''
         GROUP BY ch.thread_id, ch.task_id, th.filename
         ORDER BY MAX(ch.created_at) DESC
         LIMIT 300`,
        params,
      );
      return ok(rows);
    }
    if (qs.taskId) {
      const rows = await query('SELECT * FROM chat_history WHERE task_id=$1 AND user_id=$2 ORDER BY created_at ASC', [qs.taskId, userId]);
      return ok(rows);
    }
    if (qs.threadId) {
      const rows = await query('SELECT * FROM chat_history WHERE thread_id=$1 AND user_id=$2 ORDER BY created_at ASC', [qs.threadId, userId]);
      return ok(rows);
    }
    return badRequest('taskId or threadId required');
  }

  if (method === 'DELETE') {
    if (qs.taskId) {
      await query('DELETE FROM chat_history WHERE task_id=$1 AND user_id=$2', [qs.taskId, userId]);
      return noContent();
    }
    return badRequest('taskId required');
  }

  return notFound();
}

// ─── SHARES ─────────────────────────────────────────────────────────────────

async function handleShares(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const shareId = segments[1];
  const subResource = segments[2];
  const qs = event.queryStringParameters || {};

  if (method === 'POST' && !shareId) {
    const body = parseBody(event);
    // SECURITY: only the OWNER of a meeting may create a share for it. Without
    // this, any user could mint a public share for another user's task_id and
    // then read it through the (intentionally public) share-verify route.
    const owns = await queryOne('SELECT 1 FROM task_history WHERE id=$1 AND user_id=$2', [body.task_id, userId]);
    if (!owns) return notFound();
    const token = generateToken();
    const row = await queryOne(
      `INSERT INTO shared_meetings (task_id, owner_id, share_token, access_type) VALUES ($1,$2,$3,$4) RETURNING *`,
      [body.task_id, userId, token, body.access_type || 'public']
    );
    if (body.emails?.length && row) {
      const emails: string[] = [];
      for (const email of body.emails) {
        const clean = email.trim().toLowerCase();
        await query(
          'INSERT INTO shared_meeting_access (share_id, email) VALUES ($1,$2) ON CONFLICT (share_id, email) DO NOTHING',
          [row.id, clean]
        );
        emails.push(clean);
      }
      if (emails.length) {
        const task = await queryOne('SELECT filename FROM task_history WHERE id=$1', [body.task_id]);
        try {
          await sendShareInviteEmails({
            to: emails,
            meetingTitle: task?.filename || 'Meeting Notes',
            shareToken: token,
            ownerEmail: getUserEmail(),
          });
          console.log('Share invite emails sent to:', emails.join(', '));
        } catch (err) {
          console.error('SES send failed:', err);
        }
      }
    }
    return created(row);
  }

  if (method === 'GET' && !shareId) {
    const taskId = qs.taskId;
    if (!taskId) return badRequest('taskId required');
    const row = await queryOne(
      'SELECT * FROM shared_meetings WHERE task_id=$1 AND owner_id=$2 ORDER BY created_at DESC LIMIT 1',
      [taskId, userId]
    );
    return row ? ok(row) : notFound();
  }

  if (method === 'PUT' && shareId && !subResource) {
    const body = parseBody(event);
    const sets: string[] = [];
    const vals: any[] = [];
    let idx = 1;
    if (body.access_type !== undefined) { sets.push(`access_type=$${idx++}`); vals.push(body.access_type); }
    if (body.is_active !== undefined) { sets.push(`is_active=$${idx++}`); vals.push(body.is_active); }
    if (!sets.length) return badRequest('No fields to update');
    vals.push(shareId, userId);
    const row = await queryOne(
      `UPDATE shared_meetings SET ${sets.join(',')} WHERE id=$${idx++} AND owner_id=$${idx} RETURNING *`, vals
    );
    return row ? ok(row) : notFound();
  }

  if (method === 'DELETE' && shareId && !subResource) {
    await query('DELETE FROM shared_meetings WHERE id=$1 AND owner_id=$2', [shareId, userId]);
    return noContent();
  }

  // Email sub-resource: /shares/{id}/emails
  if (subResource === 'emails') {
    // SECURITY: only the share's owner may view, add, or remove its invited
    // emails. Gate all verbs on ownership before touching shared_meeting_access.
    const ownsShare = await queryOne('SELECT 1 FROM shared_meetings WHERE id=$1 AND owner_id=$2', [shareId, userId]);
    if (!ownsShare) return notFound();
    if (method === 'POST') {
      const body = parseBody(event);
      const emails: string[] = [];
      for (const email of (body.emails || [])) {
        const clean = email.trim().toLowerCase();
        await query(
          'INSERT INTO shared_meeting_access (share_id, email) VALUES ($1,$2) ON CONFLICT (share_id, email) DO NOTHING',
          [shareId, clean]
        );
        emails.push(clean);
      }
      if (emails.length) {
        const share = await queryOne('SELECT share_token, task_id FROM shared_meetings WHERE id=$1 AND owner_id=$2', [shareId, userId]);
        if (share) {
          const task = await queryOne('SELECT filename FROM task_history WHERE id=$1', [share.task_id]);
          try {
            await sendShareInviteEmails({
              to: emails,
              meetingTitle: task?.filename || 'Meeting Notes',
              shareToken: share.share_token,
              ownerEmail: getUserEmail(),
            });
            console.log('Share invite emails sent to:', emails.join(', '));
          } catch (err) {
            console.error('SES send failed:', err);
          }
        }
      }
      return noContent();
    }
    if (method === 'GET') {
      const rows = await query('SELECT * FROM shared_meeting_access WHERE share_id=$1 ORDER BY created_at ASC', [shareId]);
      return ok(rows);
    }
    if (method === 'DELETE' && segments[3]) {
      const email = decodeURIComponent(segments[3]).toLowerCase();
      await query('DELETE FROM shared_meeting_access WHERE share_id=$1 AND email=$2', [shareId, email]);
      return noContent();
    }
  }

  return notFound();
}

async function handleShareVerify(token: string, viewerEmail: string | null): Promise<APIGatewayProxyResult> {
  const share = await queryOne(
    'SELECT * FROM shared_meetings WHERE share_token=$1 AND is_active=true', [token]
  );
  if (!share) return ok({ denied: true, reason: 'This shared link is invalid or has been revoked.' });
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return ok({ denied: true, reason: 'This shared link has expired.' });
  }

  if (share.access_type === 'restricted') {
    if (!viewerEmail) return ok({ denied: true, reason: 'sign_in_required' });
    const access = await queryOne(
      'SELECT id FROM shared_meeting_access WHERE share_id=$1 AND lower(email)=lower($2)', [share.id, viewerEmail]
    );
    if (!access) return ok({ denied: true, reason: 'You do not have access to this meeting. Ask the owner to add your email.' });
    await query('UPDATE shared_meeting_access SET accessed_at=NOW() WHERE id=$1 AND accessed_at IS NULL', [access.id]);
  }

  // Normalize permissions defensively: the column is TEXT[] (pg returns an
  // array), but guard against null / a JSON-encoded string so a malformed row
  // can't throw a 500 ("Something went wrong") on the public share page.
  let perms: string[];
  if (Array.isArray(share.permissions)) {
    perms = share.permissions;
  } else if (typeof share.permissions === 'string') {
    try {
      const parsed = JSON.parse(share.permissions);
      perms = Array.isArray(parsed) ? parsed : ['notes', 'summary', 'chat'];
    } catch {
      // Postgres array literal like {notes,summary,chat}
      perms = share.permissions.replace(/^\{|\}$/g, '').split(',').map((s: string) => s.trim()).filter(Boolean);
    }
  } else {
    perms = ['notes', 'summary', 'chat'];
  }

  const fields = ['filename', 'created_at', 'duration'];
  if (perms.includes('summary')) fields.push('summary');
  if (perms.includes('notes')) fields.push('notes');

  const task = await queryOne(`SELECT ${fields.join(',')} FROM task_history WHERE id=$1`, [share.task_id]);
  if (!task) return ok({ denied: true, reason: 'The shared meeting could not be found.' });

  return ok({
    meeting: {
      filename: task.filename,
      summary: task.summary ?? null,
      notes: task.notes ?? null,
      created_at: task.created_at ?? null,
      duration: task.duration ?? 0,
      permissions: perms,
    },
    share: { ...share, permissions: perms },
  });
}

// ─── LEDGER ─────────────────────────────────────────────────────────────────

async function handleLedger(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (method === 'GET') {
    const row = await queryOne('SELECT * FROM user_ledger_state WHERE user_id=$1', [userId]);
    return ok(row || { turbopuffer_indexed_ids: [], kg_extracted_ids: [], kg_artifact_fingerprint: null, kg_artifact_data: null });
  }

  if (method === 'POST') {
    const body = parseBody(event);
    const row = await queryOne(
      `INSERT INTO user_ledger_state (user_id, turbopuffer_indexed_ids, kg_extracted_ids, kg_artifact_fingerprint, kg_artifact_data)
       VALUES ($1,$2,$3,$4,$5)
       ON CONFLICT (user_id) DO UPDATE SET
         turbopuffer_indexed_ids=EXCLUDED.turbopuffer_indexed_ids,
         kg_extracted_ids=EXCLUDED.kg_extracted_ids,
         kg_artifact_fingerprint=COALESCE(EXCLUDED.kg_artifact_fingerprint, user_ledger_state.kg_artifact_fingerprint),
         kg_artifact_data=COALESCE(EXCLUDED.kg_artifact_data, user_ledger_state.kg_artifact_data),
         updated_at=NOW()
       RETURNING *`,
      [userId, JSON.stringify(body.turbopuffer_indexed_ids || []), JSON.stringify(body.kg_extracted_ids || []),
       body.kg_artifact_fingerprint || null, body.kg_artifact_data ? JSON.stringify(body.kg_artifact_data) : null]
    );
    return ok(row);
  }

  if (method === 'PUT' && segments[1] === 'clear-artifact') {
    await query(
      'UPDATE user_ledger_state SET kg_artifact_fingerprint=NULL, kg_artifact_data=NULL, updated_at=NOW() WHERE user_id=$1',
      [userId]
    );
    return noContent();
  }

  return notFound();
}

// ─── STORAGE ────────────────────────────────────────────────────────────────

async function handleStorage(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (method === 'POST' && segments[1] === 'presign') {
    const body = parseBody(event);
    const ext = (body.filename || 'file').split('.').pop() || 'bin';
    const key = `${userId}/${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;

    const command = new PutObjectCommand({
      Bucket: S3_BUCKET,
      Key: key,
      ContentType: body.contentType || 'application/octet-stream',
    });

    const uploadUrl = await getSignedUrl(s3, command, { expiresIn: 600 });
    const publicUrl = `https://${S3_BUCKET}.s3.${S3_REGION}.amazonaws.com/${key}`;

    return ok({ uploadUrl, publicUrl });
  }

  return notFound();
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────
// One request that returns everything the app needs on launch: the first page
// of history, the workspace membership index, the chat-thread list, and the
// ledger. Collapses ~6 cold-start round-trips into a single Lambda invoke —
// dramatically faster first paint on slow networks, and cheaper (fewer invokes).
async function handleBootstrap(userId: string): Promise<APIGatewayProxyResult> {
  const pageSize = 24;
  await ensureChatSchema(); // workspace_id column referenced below
  const [taskRows, taskTotal, workspaces, folders, taskWorkspaces, taskFolders, threads, ledger, userPlan] = await Promise.all([
    query('SELECT id, created_at, filename, summary, status, duration, attendees FROM task_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2', [userId, pageSize]),
    queryCount('SELECT COUNT(*) FROM task_history WHERE user_id=$1', [userId]),
    query('SELECT * FROM workspaces WHERE user_id=$1 ORDER BY created_at ASC', [userId]),
    query('SELECT f.* FROM folders f JOIN workspaces w ON w.id=f.workspace_id WHERE w.user_id=$1 ORDER BY f.created_at ASC', [userId]),
    query('SELECT tw.task_id, tw.workspace_id FROM task_workspaces tw JOIN workspaces w ON w.id=tw.workspace_id WHERE w.user_id=$1', [userId]),
    query('SELECT tf.task_id, tf.folder_id FROM task_folders tf JOIN folders f ON f.id=tf.folder_id JOIN workspaces w ON w.id=f.workspace_id WHERE w.user_id=$1', [userId]),
    query(
      `SELECT ch.thread_id, ch.task_id,
              MIN(ch.created_at) AS created_at, MAX(ch.created_at) AS updated_at,
              (ARRAY_AGG(ch.text ORDER BY ch.created_at) FILTER (WHERE ch.role='user'))[1] AS title,
              (ARRAY_AGG(ch.text ORDER BY ch.created_at DESC))[1] AS preview,
              th.filename AS task_title
       FROM chat_history ch
       LEFT JOIN task_history th ON th.id = ch.task_id
       WHERE ch.user_id=$1 AND ch.workspace_id IS NULL AND ch.thread_id IS NOT NULL
       GROUP BY ch.thread_id, ch.task_id, th.filename
       ORDER BY MAX(ch.created_at) DESC
       LIMIT 200`,
      [userId],
    ),
    queryOne('SELECT * FROM user_ledger_state WHERE user_id=$1', [userId]),
    getUserPlan(userId, getUserEmail()),
  ]);
  const [meeting, batch] = await Promise.all([
    getMeetingUsage(userId, userPlan),
    getBatchHoursUsage(userId, userPlan),
  ]);
  return ok({
    history: { data: taskRows, hasMore: taskTotal > pageSize, total: taskTotal },
    workspaceIndex: { workspaces, folders, taskWorkspaces, taskFolders },
    chatThreads: threads,
    ledger: ledger || null,
    entitlements: buildEntitlements(userPlan, meeting, batch),
  });
}

/** Entitlements the client uses to show usage + gate plan limits. Keeps the
    flat meeting fields for the existing gate, plus the batch-hour detail. */
export function buildEntitlements(
  plan: string,
  meeting: { used: number; limit: number | null; period: 'total' | 'month' },
  batch: { usedHours: number; limitHours: number | null },
) {
  return {
    plan,
    planLabel: planLabel(plan),
    unlimited: meeting.limit === null,
    // Flat meeting fields (consumed by the free-tier gate).
    meetingCount: meeting.used,
    meetingLimit: meeting.limit,
    meetingsPeriod: meeting.period,
    meetingsRemaining: meeting.limit === null ? null : Math.max(0, meeting.limit - meeting.used),
    batchHours: {
      usedHours: Math.round(batch.usedHours * 100) / 100,
      limitHours: batch.limitHours,
      remainingHours: batch.limitHours === null ? null : Math.max(0, Math.round((batch.limitHours - batch.usedHours) * 100) / 100),
    },
  };
}

// ─── WORKSPACES ──────────────────────────────────────────────────────────────

async function handleWorkspaces(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const workspaceId = segments[1];
  const sub = segments[2]; // 'folders' | 'meetings' | 'members'
  const subId = segments[3];

  // Membership index — workspaces + folders + task↔workspace + task↔folder in a
  // SINGLE request. Replaces the per-workspace/per-folder fan-out (N+1 calls)
  // that made the workspace chips slow to populate, especially on low networks.
  if (method === 'GET' && workspaceId === 'index') {
    const [workspaces, folders, taskWorkspaces, taskFolders] = await Promise.all([
      query('SELECT * FROM workspaces WHERE user_id=$1 ORDER BY created_at ASC', [userId]),
      query('SELECT f.* FROM folders f JOIN workspaces w ON w.id=f.workspace_id WHERE w.user_id=$1 ORDER BY f.created_at ASC', [userId]),
      query('SELECT tw.task_id, tw.workspace_id FROM task_workspaces tw JOIN workspaces w ON w.id=tw.workspace_id WHERE w.user_id=$1', [userId]),
      query('SELECT tf.task_id, tf.folder_id FROM task_folders tf JOIN folders f ON f.id=tf.folder_id JOIN workspaces w ON w.id=f.workspace_id WHERE w.user_id=$1', [userId]),
    ]);
    return ok({ workspaces, folders, taskWorkspaces, taskFolders });
  }

  if (method === 'GET' && !workspaceId) {
    const taskId = event.queryStringParameters?.task_id;
    if (taskId) {
      const rows = await query(
        `SELECT w.*, (tw.task_id IS NOT NULL) AS has_task
         FROM workspaces w
         LEFT JOIN task_workspaces tw ON tw.workspace_id = w.id AND tw.task_id = $2
         WHERE w.user_id = $1
         ORDER BY w.created_at ASC`,
        [userId, taskId]
      );
      return ok(rows);
    }
    const rows = await query('SELECT * FROM workspaces WHERE user_id=$1 ORDER BY created_at ASC', [userId]);
    return ok(rows);
  }

  if (method === 'POST' && !workspaceId) {
    const body = parseBody(event);
    if (!body.name?.trim()) return badRequest('name is required');
    const row = await queryOne(
      `INSERT INTO workspaces (user_id, name, emoji, color, description, image_url)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [
        userId,
        body.name.trim(),
        body.emoji || '🗂️',
        body.color || '#f06060',
        body.description ?? '',
        body.image_url ?? null,
      ]
    );
    return created(row);
  }

  const ws = workspaceId ? await queryOne('SELECT * FROM workspaces WHERE id=$1 AND user_id=$2', [workspaceId, userId]) : null;
  if (workspaceId && !ws) return notFound();

  if (method === 'PUT' && !sub) {
    const body = parseBody(event);
    const row = await queryOne(
      `UPDATE workspaces SET
         name        = COALESCE($1,name),
         emoji       = COALESCE($2,emoji),
         color       = COALESCE($3,color),
         description = COALESCE($4,description),
         image_url   = COALESCE($5,image_url)
       WHERE id=$6 RETURNING *`,
      [
        body.name?.trim() || null,
        body.emoji || null,
        body.color || null,
        body.description ?? null,
        body.image_url ?? null,
        workspaceId,
      ]
    );
    return ok(row);
  }

  if (method === 'DELETE' && !sub) {
    await query('DELETE FROM workspaces WHERE id=$1', [workspaceId]);
    return noContent();
  }

  if (method === 'GET' && sub === 'folders') {
    const rows = await query('SELECT * FROM folders WHERE workspace_id=$1 ORDER BY created_at ASC', [workspaceId]);
    return ok(rows);
  }

  if (method === 'POST' && sub === 'folders') {
    const body = parseBody(event);
    if (!body.name?.trim()) return badRequest('name is required');
    const row = await queryOne(
      `INSERT INTO folders
         (workspace_id, user_id, name, emoji, color, description, icon_type, icon_name, favorite)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
      [
        workspaceId, userId, body.name.trim(),
        body.emoji ?? null,
        body.color ?? null,
        body.description ?? '',
        body.icon_type ?? body.iconType ?? 'icon',
        body.icon_name ?? body.iconName ?? null,
        body.favorite === true,
      ]
    );
    return created(row);
  }

  if (method === 'GET' && sub === 'meetings') {
    // SECURITY: only surface meetings the caller owns (defense-in-depth — the
    // JOIN to task_history must be user-scoped so a foreign task_id attached to
    // this workspace can never be read back).
    const rows = await query(
      `SELECT th.id, th.filename, th.created_at, th.duration, th.status, th.summary
       FROM task_workspaces tw JOIN task_history th ON th.id=tw.task_id
       WHERE tw.workspace_id=$1 AND th.user_id=$2 ORDER BY tw.added_at DESC`,
      [workspaceId, userId]
    );
    return ok(rows);
  }

  // Workspace-scoped knowledge graph: the same per-meeting KG rows, filtered to
  // the meetings that belong to this workspace (via task_workspaces). Mirrors the
  // /meetings route above so the KG can be scoped exactly like meeting notes.
  if (method === 'GET' && sub === 'knowledge-graph') {
    const rows = await query(
      `SELECT kg.task_id, kg.meeting_title, kg.created_at, kg.topics, kg.decisions,
              kg.people, kg.action_items, kg.refs
       FROM knowledge_graph kg
       JOIN task_workspaces tw ON tw.task_id = kg.task_id
       WHERE kg.user_id=$1 AND tw.workspace_id=$2
       ORDER BY kg.created_at DESC`,
      [userId, workspaceId]
    );
    return ok(rows);
  }

  if (method === 'POST' && sub === 'meetings') {
    const body = parseBody(event);
    if (!body.task_id) return badRequest('task_id is required');
    // SECURITY: only insert if the caller OWNS the task being added — prevents
    // attaching another user's meeting to your workspace.
    await query(
      `INSERT INTO task_workspaces (task_id, workspace_id)
       SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM task_history WHERE id=$1 AND user_id=$3)
       ON CONFLICT DO NOTHING`,
      [body.task_id, workspaceId, userId]
    );
    return noContent();
  }

  if (method === 'DELETE' && sub === 'meetings' && subId) {
    await query('DELETE FROM task_workspaces WHERE task_id=$1 AND workspace_id=$2', [subId, workspaceId]);
    return noContent();
  }

  if (method === 'GET' && sub === 'members') {
    const rows = await query('SELECT * FROM workspace_members WHERE workspace_id=$1 ORDER BY invited_at ASC', [workspaceId]);
    return ok(rows);
  }

  if (method === 'POST' && sub === 'members') {
    const body = parseBody(event);
    if (!body.email) return badRequest('email is required');
    const row = await queryOne(
      'INSERT INTO workspace_members (workspace_id, email, role) VALUES ($1,$2,$3) ON CONFLICT (workspace_id,email) DO UPDATE SET role=EXCLUDED.role RETURNING *',
      [workspaceId, body.email.toLowerCase().trim(), body.role || 'viewer']
    );
    return ok(row);
  }

  if (method === 'DELETE' && sub === 'members' && subId) {
    await query('DELETE FROM workspace_members WHERE workspace_id=$1 AND lower(email)=lower($2)', [workspaceId, decodeURIComponent(subId)]);
    return noContent();
  }

  return notFound();
}

// ─── FOLDERS ─────────────────────────────────────────────────────────────────

async function handleFolders(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const folderId = segments[1];
  const sub = segments[2];
  const subId = segments[3];

  if (!folderId) return notFound();

  const folder = await queryOne(
    'SELECT f.* FROM folders f JOIN workspaces w ON w.id=f.workspace_id WHERE f.id=$1 AND w.user_id=$2',
    [folderId, userId]
  );
  if (!folder) return notFound();

  if (method === 'DELETE' && !sub) {
    await query('DELETE FROM folders WHERE id=$1', [folderId]);
    return noContent();
  }

  if (method === 'PUT' && !sub) {
    const body = parseBody(event);
    const row = await queryOne(
      `UPDATE folders SET
         name        = COALESCE($1,name),
         emoji       = COALESCE($2,emoji),
         color       = COALESCE($3,color),
         description = COALESCE($4,description),
         icon_type   = COALESCE($5,icon_type),
         icon_name   = COALESCE($6,icon_name),
         favorite    = COALESCE($7,favorite)
       WHERE id=$8 RETURNING *`,
      [
        body.name?.trim() || null,
        body.emoji ?? null,
        body.color ?? null,
        body.description ?? null,
        body.icon_type ?? body.iconType ?? null,
        body.icon_name ?? body.iconName ?? null,
        typeof body.favorite === 'boolean' ? body.favorite : null,
        folderId,
      ]
    );
    return ok(row);
  }

  if (method === 'GET' && sub === 'meetings') {
    // SECURITY: user-scope the JOIN so a foreign task_id placed in this folder
    // can never be read back.
    const rows = await query(
      `SELECT th.id, th.filename, th.created_at, th.duration, th.status, th.summary
       FROM task_folders tf JOIN task_history th ON th.id=tf.task_id
       WHERE tf.folder_id=$1 AND th.user_id=$2 ORDER BY tf.added_at DESC`,
      [folderId, userId]
    );
    return ok(rows);
  }

  if (method === 'POST' && sub === 'meetings') {
    const body = parseBody(event);
    if (!body.task_id) return badRequest('task_id is required');
    // SECURITY: only insert if the caller OWNS the task being added.
    await query(
      `INSERT INTO task_folders (task_id, folder_id)
       SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM task_history WHERE id=$1 AND user_id=$3)
       ON CONFLICT DO NOTHING`,
      [body.task_id, folderId, userId]
    );
    return noContent();
  }

  if (method === 'DELETE' && sub === 'meetings' && subId) {
    await query('DELETE FROM task_folders WHERE task_id=$1 AND folder_id=$2', [subId, folderId]);
    return noContent();
  }

  return notFound();
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

async function handleContacts(method: string, userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  await ensurePeopleSchema();

  // Set/edit a person's email (and optionally cached Jira accountId) by name.
  if (method === 'POST') {
    const body = parseBody(event);
    const name = String(body.name || '').trim();
    if (!name) return badRequest('name required');
    await upsertPerson(userId, name, body.email ?? null, body.jira_account_id ?? null);
    return ok({ ok: true });
  }

  // GET — meeting-derived people, with email filled from the people directory.
  const rows = await query(
    `SELECT
       combined.name AS name,
       MAX(combined.role)    AS role,
       COALESCE(MAX(combined.email), MAX(pd.email)) AS email,
       MAX(pd.jira_account_id) AS jira_account_id,
       MAX(combined.company) AS company,
       COUNT(DISTINCT combined.task_id)::int AS meeting_count,
       MAX(combined.last_seen) AS last_seen,
       array_agg(DISTINCT combined.task_id::text) AS task_ids
     FROM (
       -- from knowledge graph (AI-extracted people with rich metadata)
       SELECT
         p->>'name'    AS name,
         p->>'role'    AS role,
         p->>'email'   AS email,
         p->>'company' AS company,
         kg.task_id    AS task_id,
         kg.created_at AS last_seen
       FROM knowledge_graph kg, jsonb_array_elements(kg.people) AS p
       WHERE kg.user_id=$1
         AND p->>'name' IS NOT NULL AND (p->>'name') != ''

       UNION ALL

       -- from manually-added attendees in task_history
       SELECT
         a.value::text AS name,
         NULL          AS role,
         NULL          AS email,
         NULL          AS company,
         t.id          AS task_id,
         t.created_at  AS last_seen
       FROM task_history t, jsonb_array_elements_text(t.attendees) AS a
       WHERE t.user_id=$1
         AND a.value IS NOT NULL AND a.value != ''
     ) combined
     LEFT JOIN people_directory pd
       ON pd.user_id=$1 AND lower(btrim(pd.name)) = lower(btrim(combined.name))
     GROUP BY combined.name
     ORDER BY meeting_count DESC, combined.name ASC`,
    [userId]
  );
  return ok(rows);
}
