import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { query, queryOne, queryCount } from './db';
import { ok, created, noContent, badRequest, notFound, unauthorized, serverError, corsPreflightResponse, paymentRequired, forbidden } from './response';
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
import './connectors/google';    // registers Gmail + Google Calendar + Google Drive (direct REST + OAuth)
import { ensurePeopleSchema, upsertPerson } from './people';
import { activeWorkspaceId, ensureWorkspacePartition, ensureWorkspacePartitionSchema, validateOwnedWorkspaceId } from './workspaceScope';
import { ensureSpacesSchema, migrateFoldersToSpacesOnce, reconcileSpaces, resolveDefaultSpaceId, validateOwnedSpaceId, canAccessSpace } from './spaces';
import { ensureDictionarySchema } from './dictionary';

// Connector OAuth redirect — the app's own custom scheme; the desktop deep-link handler catches it
// (`wisprnote://connector-callback?code=…&state=…`) and POSTs to /exchange. The https /oauth/callback
// route below is kept as a server-side fallback (dormant unless used as the redirect).
const CONNECTOR_REDIRECT_URI = 'wisprnote://connector-callback';

// Builds the https callback URL on THIS gateway (the server-side-completion fallback).
function oauthCallbackUrl(event: APIGatewayProxyEvent): string {
  const host = event.requestContext?.domainName || (event.headers?.Host || event.headers?.host) || '';
  const stage = (event.requestContext as any)?.stage;
  const base = host ? `https://${host}${stage && stage !== '$default' ? `/${stage}` : ''}` : '';
  return `${base}/oauth/callback`;
}

// Browser hits this after the user approves on the provider's consent screen. No JWT — it's a
// top-level browser redirect — so we correlate by the unguessable, single-use `state` nonce, which
// carries the user + connector + (workspace, space) we stored at oauth-url time.
async function completeConnectorOAuthCallback(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters || {};
  const page = (title: string, msg: string, ok: boolean, returnUrl?: string) => ({
    statusCode: 200,
    headers: { 'Content-Type': 'text/html; charset=utf-8' },
    body: `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;background:#1a1c18;color:#e8e6e1;display:flex;min-height:100vh;align-items:center;justify-content:center;margin:0}
.card{max-width:420px;text-align:center;padding:40px 32px}.icon{font-size:48px;margin-bottom:16px}h1{font-size:20px;margin:0 0 8px}p{color:#9a9b96;line-height:1.5;margin:0 0 20px}.ok{color:#a3c293}
a.btn{display:inline-block;background:#a3c293;color:#1a1c18;text-decoration:none;font-weight:600;padding:10px 22px;border-radius:8px}</style></head>
<body><div class="card"><div class="icon">${ok ? '✅' : '⚠️'}</div><h1 class="${ok ? 'ok' : ''}">${title}</h1><p>${msg}</p>
${returnUrl ? `<a class="btn" href="${returnUrl}">Return to Wisprnote</a>` : ''}</div>
<script>${returnUrl ? `setTimeout(function(){try{window.location.href=${JSON.stringify(returnUrl)}}catch(e){}}, 600);` : ''}setTimeout(function(){try{window.close()}catch(e){}}, ${ok ? 4000 : 6000})</script></body></html>`,
  } as APIGatewayProxyResult);
  if (qs.error) return page('Connection cancelled', String(qs.error_description || qs.error || 'You cancelled the authorization.'), false);
  const code = String(qs.code || ''); const state = String(qs.state || '');
  if (!code || !state) return page('Invalid callback', 'Missing authorization code or state.', false);
  const row = await queryOne<{ inflight: OAuthInflight; user_id: string; source: string; workspace_id: string; space_id: string }>(
    `SELECT inflight, user_id, source, workspace_id, space_id FROM oauth_state WHERE state=$1`, [state],
  ).catch(() => null);
  if (!row) return page('Link expired', 'This authorization link is no longer valid. Please start the connection again from Wisprnote.', false);
  try {
    const token = await completeMcpOAuth(row.inflight, code);
    const stored = {
      ...token.raw,
      oauth_meta: { token_endpoint: row.inflight.tokenEndpoint, client_id: row.inflight.clientId, client_secret: row.inflight.clientSecret ?? null },
      expires_at: token.expires_in ? Date.now() + (token.expires_in - 60) * 1000 : null,
    };
    await storeToken(
      row.user_id, row.source, stored, null,
      row.inflight.scope ? row.inflight.scope.split(' ') : null,
      row.workspace_id || ACCOUNT_SCOPE, row.space_id || ACCOUNT_SCOPE,
    );
    await query(`DELETE FROM oauth_state WHERE state=$1`, [state]).catch(() => {});
    try { const { discoverConnectorTools } = await import('./mcp/toolPlane'); await discoverConnectorTools(row.user_id, row.workspace_id || ACCOUNT_SCOPE, row.source); } catch { /* catalog also fills on the sync cron */ }
    console.log('connector_oauth_completed', JSON.stringify({ source: row.source, workspace: row.workspace_id, space: row.space_id }));
    const back = `wisprnote://connector-callback?connected=1&source=${encodeURIComponent(row.source)}`;
    return page('Connected', `${row.source} is now connected. Returning you to Wisprnote…`, true, back);
  } catch (e: any) {
    console.error('connector_oauth_callback_failed', JSON.stringify({ message: e?.message }));
    return page('Connection failed', String(e?.message || 'Token exchange failed.').slice(0, 200), false);
  }
}

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
/** This API's own public base URL, used to build OAuth callback URLs. Set
    WISPRNOTE_API_URL per deployment so a fork never points at someone else's API. */
const API_SELF_URL = (process.env.WISPRNOTE_API_URL || 'https://hxjaupkwql.execute-api.us-east-1.amazonaws.com/prod').replace(/\/$/, '');

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
      // Keep folder tags fresh: a meeting FILED into a folder after ingestion gets its folder_id
      // here (and its project's dev sessions are re-opened to link to it). Idempotent + bounded.
      try { const { backfillItemFolders } = await import('./connectors/sync'); await backfillItemFolders(); } catch (e: any) { console.error('backfill_folders_failed', e?.message); }
      // Keep each connector's tool catalog (+ classification) fresh for the trust plane.
      try { const { discoverAllConnectorTools } = await import('./mcp/toolPlane'); await discoverAllConnectorTools(25); } catch (e: any) { console.error('tool_discovery_failed', e?.message); }
      try { const { embedKnowledgeItems } = await import('./connectors/embed'); embedded = (await embedKnowledgeItems(96)).embedded; } catch (e: any) { console.error('brain_embed_failed', e?.message); }
      // AUTONOMY: complete the whole pipeline in this one tick — ingest → embed → LINK — so the
      // brain is always current SERVER-SIDE without the client ever driving it (the Brain Map is
      // now read-only). Bounded (small LLM budget + time budget) to stay under the Lambda window;
      // whatever this tick doesn't reach, the dedicated brain-link cron / next tick finishes. Each
      // item is verdicted exactly once (brain_link_state), so re-runs are cheap and idempotent.
      let linked = 0;
      try {
        const { runBrainLink } = await import('./connectors/brainLink');
        const lr = await runBrainLink({ llmBudget: 6, timeBudgetMs: 24_000 });
        linked = lr.provenance + lr.reference + lr.semantic + lr.llm;
      } catch (e: any) { console.error('brain_link_after_sync_failed', e?.message); }
      // EVENT-FIRST bind (Brain P2): re-bind every space that received new data THIS tick, so a
      // freshly-synced ticket/commit weaves into its meetings in the same operation — deterministic,
      // $0, and independent of the LLM (so it works even when the verdict is credit-blocked).
      let bound: any = null;
      try { const { bindActiveSpaces } = await import('./connectors/brainBind'); bound = await bindActiveSpaces(30); } catch (e: any) { console.error('brain_bind_after_sync_failed', e?.message); }
      // THREAD LEDGER (Brain P3): refresh open loops for spaces that got new data this tick.
      let threads: any = null;
      try { const { buildActiveSpaceThreads } = await import('./connectors/threads'); threads = await buildActiveSpaceThreads(30); } catch (e: any) { console.error('brain_threads_after_sync_failed', e?.message); }
      return { statusCode: 200, body: JSON.stringify({ ...r, ingested, embedded, linked, bound, threads }) } as APIGatewayProxyResult;
    } catch (err: any) {
      console.error('connector_sync_failed', JSON.stringify({ message: err?.message, code: err?.code, detail: err?.detail }));
      return { statusCode: 500, body: 'connector-sync-error' } as APIGatewayProxyResult;
    }
  }

  // CONNECTOR DEBUG — READ-ONLY. Reports credential token health + pending OAuth states + sync
  // watermarks, so we can tell an expired/refreshable token from a genuinely-needed reconnect.
  if ((event as any).__job === 'connector-debug') {
    const safe = async (sql: string, params: any[] = []) => { try { return await query<any>(sql, params); } catch (e: any) { return [{ error: e?.message }]; } };
    const creds = await safe(
      `SELECT source, space_id::text AS space_id, account,
              (token->>'expires_at') AS expires_at_ms,
              ((token->>'expires_at') IS NOT NULL AND (token->>'expires_at')::bigint < (extract(epoch from now())*1000)) AS access_expired,
              (token ? 'refresh_token') AS has_refresh,
              ((token->'oauth_meta') ? 'client_id') AS has_oauth_meta,
              updated_at
         FROM connector_credentials ORDER BY source, updated_at DESC`);
    const pending = await safe(
      `SELECT source, workspace_id::text, space_id::text, created_at,
              round(extract(epoch from (now()-created_at))/60)::int AS age_minutes
         FROM oauth_state ORDER BY created_at DESC LIMIT 20`);
    const syncState = await safe(
      `SELECT source, scope, last_synced_at,
              round(extract(epoch from (now()-last_synced_at))/60)::int AS minutes_ago
         FROM sync_state ORDER BY last_synced_at DESC NULLS LAST LIMIT 20`);
    return { statusCode: 200, body: JSON.stringify({
      note: 'READ-ONLY. nowMs=' + Date.now(),
      credentials: creds, pendingOAuthStates: pending, syncWatermarks: syncState,
    }, null, 2) } as APIGatewayProxyResult;
  }

  // SPACE RESET — wipe a space's BRAIN GRAPH + SUGGESTED ACTIONS for a clean re-test, while KEEPING
  // meetings (task_history + meeting items), the knowledge graph, and connector_credentials
  // (connections). A fresh sync then rebuilds the brain from scratch. DRY-RUN unless { commit:true }.
  if ((event as any).__job === 'space-reset') {
    const spaceId = String((event as any).spaceId || '');
    const commit = (event as any).commit === true;
    const results: any = {
      mode: commit ? 'COMMIT — deleted' : 'DRY-RUN — would delete (nothing changed)', space: spaceId,
      keeps: ['meetings (task_history + meeting knowledge_item)', 'knowledge_graph (decisions/action_items)', 'connector_credentials (Jira/GitHub stay connected)'],
    };
    const step = async (label: string, countSql: string, deleteSql: string) => {
      try { const r = await query<any>(commit ? deleteSql : countSql, [spaceId]); results[label] = r?.[0]?.n ?? 0; }
      catch (e: any) { results[label] = `error: ${e?.message}`; }
    };
    // 1) Link cursor for ALL this space's items (do FIRST — needs the items to still exist).
    await step('linkStateReset',
      `SELECT COUNT(*)::int AS n FROM brain_link_state WHERE item_id IN (SELECT id FROM knowledge_item WHERE space_id=$1)`,
      `WITH d AS (DELETE FROM brain_link_state WHERE item_id IN (SELECT id FROM knowledge_item WHERE space_id=$1) RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 2) Suggestion coverage markers for this space's meetings → reasoner re-processes them.
    await step('suggestionCoverageReset',
      `SELECT COUNT(*)::int AS n FROM suggestion_reasoned WHERE meeting_id IN (SELECT id::text FROM task_history WHERE space_id=$1)`,
      `WITH d AS (DELETE FROM suggestion_reasoned WHERE meeting_id IN (SELECT id::text FROM task_history WHERE space_id=$1) RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 3) Connector items (Jira/GitHub/sessions) — KEEP meetings.
    await step('connectorItemsDeleted',
      `SELECT COUNT(*)::int AS n FROM knowledge_item WHERE space_id=$1 AND source <> 'meeting'`,
      `WITH d AS (DELETE FROM knowledge_item WHERE space_id=$1 AND source <> 'meeting' RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 4) Brain edges (whole graph for the space — rebuilds on next link).
    await step('brainEdgesDeleted',
      `SELECT COUNT(*)::int AS n FROM brain_edge WHERE space_id=$1`,
      `WITH d AS (DELETE FROM brain_edge WHERE space_id=$1 RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 5) Brain events (activity feed).
    await step('brainEventsDeleted',
      `SELECT COUNT(*)::int AS n FROM brain_event WHERE space_id=$1`,
      `WITH d AS (DELETE FROM brain_event WHERE space_id=$1 RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 6) Suggested actions (proposals queue).
    await step('proposalsDeleted',
      `SELECT COUNT(*)::int AS n FROM action_proposal WHERE space_id=$1`,
      `WITH d AS (DELETE FROM action_proposal WHERE space_id=$1 RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 7) Sync cursors for this space → connectors re-pull from scratch on the next sync.
    await step('syncCursorsReset',
      `SELECT COUNT(*)::int AS n FROM sync_state WHERE scope LIKE '%'||$1||'%'`,
      `WITH d AS (DELETE FROM sync_state WHERE scope LIKE '%'||$1||'%' RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    return { statusCode: 200, body: JSON.stringify(results, null, 2) } as APIGatewayProxyResult;
  }

  // LLM PROBE — READ-ONLY. Tests the brain-verdict model call so we can see WHY judgeAlignment
  // returns nothing (auth 401 / model 404 / rate 429 / works).
  if ((event as any).__job === 'llm-probe') {
    const { getSecrets } = await import('./secrets');
    const { MODELS } = await import('./models/registry');
    const s = await getSecrets();
    const out: any = { hasAnthropic: !!s.ANTHROPIC_API_KEY, hasGemini: !!s.GEMINI_API_KEY, anthropicKeyLen: (s.ANTHROPIC_API_KEY || '').length, model: MODELS.brainVerdict.primary };
    if (s.ANTHROPIC_API_KEY) {
      try {
        const r = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-api-key': s.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
          body: JSON.stringify({ model: MODELS.brainVerdict.primary, max_tokens: 40, messages: [{ role: 'user', content: 'Reply with the single word OK.' }] }),
        });
        out.anthropicStatus = r.status;
        out.anthropicBody = (await r.text()).slice(0, 400);
      } catch (e: any) { out.anthropicError = e?.message; }
    }
    if (s.GEMINI_API_KEY) {
      const candidates = Array.isArray((event as any).geminiModels) ? (event as any).geminiModels
        : ['gemini-3-pro-preview', 'gemini-3-flash-preview', 'gemini-2.5-pro', 'gemini-2.0-flash'];
      out.geminiTests = [];
      for (const m of candidates) {
        try {
          const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m}:generateContent?key=${s.GEMINI_API_KEY}`, {
            method: 'POST', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply with the single word OK.' }] }] }),
          });
          out.geminiTests.push({ model: m, status: r.status, ok: r.ok });
        } catch (e: any) { out.geminiTests.push({ model: m, error: e?.message }); }
      }
    }
    // Does the EMBEDDING call work? (brainLink needs this; null = no vectors = no links.)
    try {
      const { embedTexts } = await import('./kgEmbed');
      const v = await embedTexts(['hello world test', 'second test text']);
      out.embedOk = Array.isArray(v) && v.length === 2 && Array.isArray(v[0]);
      out.embedDims = v?.[0]?.length ?? null;
    } catch (e: any) { out.embedError = e?.message; }
    // Direct embedding HTTP status (quota 429 vs model 404 vs auth 400)?
    if (s.GEMINI_API_KEY) {
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-embedding-001:batchEmbedContents?key=${s.GEMINI_API_KEY}`, {
          method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ requests: [{ model: 'models/gemini-embedding-001', content: { parts: [{ text: 'test' }] } }] }),
        });
        out.embedStatus = r.status; out.embedBody = (await r.text()).slice(0, 300);
      } catch (e: any) { out.embedHttpError = e?.message; }
    }
    // PERSIST health (CF-4) so `/brain/progress` shows `meaning:` continuously between probes.
    try {
      const { recordLlmHealth, classifyLlmFailure } = await import('./connectors/budget');
      if (out.anthropicStatus != null) await recordLlmHealth('anthropic', out.anthropicStatus === 200 ? 'ok' : classifyLlmFailure(out.anthropicStatus, out.anthropicBody), out.anthropicStatus === 200 ? null : `probe ${out.anthropicStatus}`);
      if (Array.isArray(out.geminiTests) && out.geminiTests.length) {
        const anyOk = out.geminiTests.some((t: any) => t.ok);
        const worst = out.geminiTests.find((t: any) => !t.ok);
        await recordLlmHealth('gemini', anyOk ? 'ok' : classifyLlmFailure(worst?.status || 0, ''), anyOk ? null : `probe ${worst?.status || worst?.error || 'fail'}`);
      }
      if (out.embedStatus != null || out.embedOk != null) await recordLlmHealth('embeddings', out.embedOk ? 'ok' : classifyLlmFailure(out.embedStatus || 0, out.embedBody), out.embedOk ? null : `probe ${out.embedStatus || out.embedError || 'fail'}`);
    } catch { /* health persistence is best-effort */ }
    return { statusCode: 200, body: JSON.stringify(out, null, 2) } as APIGatewayProxyResult;
  }

  // BRAIN-CONSOLIDATE (Brain P4) — the "sleep" pass: prune dangling edges + drop redundant similarity
  // a claim already explains. No spaceId → all spaces (the daily cron); spaceId → one. Deterministic $0.
  if ((event as any).__job === 'brain-consolidate') {
    const spaceId = String((event as any).spaceId || '');
    try {
      const { consolidateSpace, consolidateAll } = await import('./connectors/consolidate');
      const r = spaceId ? await consolidateSpace(spaceId) : await consolidateAll();
      console.log('brain_consolidate', JSON.stringify(r));
      return { statusCode: 200, body: JSON.stringify(r, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('brain_consolidate_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // BRAIN-BIND (Brain P1) — deterministic claim→edge backfill for a space: turn every meeting's
  // extracted claims (people/action_items/refs) into edges, LLM-FREE. Rebuilds the claim layer of a
  // space's brain at $0; idempotent (insertEdge dedups). Run after connector sync / on demand.
  if ((event as any).__job === 'brain-bind') {
    const spaceId = String((event as any).spaceId || '');
    if (!spaceId) return { statusCode: 400, body: 'spaceId required' } as APIGatewayProxyResult;
    try {
      const { bindSpace } = await import('./connectors/brainBind');
      const r = await bindSpace(spaceId);
      console.log('brain_bind', JSON.stringify(r));
      return { statusCode: 200, body: JSON.stringify(r, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('brain_bind_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // BRAIN-THREADS (Brain P3) — build/refresh a space's thread ledger (ticket lifecycles as open loops
  // with derived state). Deterministic, $0. Run after bind (a thread's state reads its lineage edges).
  if ((event as any).__job === 'brain-threads') {
    const spaceId = String((event as any).spaceId || '');
    try {
      const { buildSpaceThreads, buildAllSpaceThreads, proposeGapTickets, listSpaceThreads } = await import('./connectors/threads');
      // No spaceId → the HOURLY CRON: refresh every space's ledger (keeps `stale` honest) + propose
      // the missing tickets. One spaceId → build + propose + (optionally) list that space.
      if (!spaceId) {
        const r = await buildAllSpaceThreads();
        return { statusCode: 200, body: JSON.stringify(r, null, 2) } as APIGatewayProxyResult;
      }
      const r = await buildSpaceThreads(spaceId);
      const proposed = (await proposeGapTickets(spaceId).catch(() => ({ proposed: 0 }))).proposed;
      console.log('brain_threads', JSON.stringify({ ...r, proposed }));
      const list = (event as any).list ? (await listSpaceThreads(spaceId)).map((t: any) => ({ id: t.anchor_source_id, title: (t.title || '').slice(0, 60), state: t.state, evidence: { meetings: (t.evidence?.meetings || []).length, commits: (t.evidence?.commits || []).length } })) : undefined;
      return { statusCode: 200, body: JSON.stringify({ ...r, proposed, threads: list }, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('brain_threads_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // BRAIN-BRIEF (Brain D-1) — build/read a space's chief-of-staff brief (what moved, what's slipping,
  // what's untracked). Deterministic, $0, grounded ONLY in confirmed evidence. No spaceId → rebuild
  // every space's brief. { spaceId, read:true } → return the stored brief without rebuilding.
  if ((event as any).__job === 'brain-brief') {
    const spaceId = String((event as any).spaceId || '');
    try {
      const { buildSpaceBrief, buildAllSpaceBriefs, getSpaceBrief } = await import('./connectors/brief');
      if (!spaceId) {
        const r = await buildAllSpaceBriefs();
        return { statusCode: 200, body: JSON.stringify(r, null, 2) } as APIGatewayProxyResult;
      }
      const r = (event as any).read === true ? await getSpaceBrief(spaceId) : await buildSpaceBrief(spaceId);
      return { statusCode: 200, body: JSON.stringify(r, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('brain_brief_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // GOOGLE-CHECK — verify the Google OAuth begin path end-to-end (operator client configured? valid
  // authorize URL built?) WITHOUT needing a user login. Returns the authorize URL (client_id is public,
  // not a secret). If this works, the app's Connect button will too.
  if ((event as any).__job === 'google-check') {
    const id = String((event as any).connector || 'gmail');
    const out: any = { connector: id };
    try {
      const { getRegistryOAuthClient } = await import('./mcp/customConnectors');
      const client = await getRegistryOAuthClient(id).catch(() => null);
      out.clientConfigured = !!client?.clientId;
      out.clientSecretConfigured = !!client?.clientSecret;
      if (client?.clientId) {
        const { getMcpServer } = await import('./mcp/registry');
        const scopes = getMcpServer(id)?.scopes || [];
        const { beginGoogleOAuth } = await import('./connectors/google/oauth');
        const { authorizeUrl } = beginGoogleOAuth(client, scopes, `${API_SELF_URL}/oauth/callback`);
        out.scopes = scopes;
        out.authorizeUrl = authorizeUrl;
      } else out.hint = 'GOOGLE_OAUTH_CLIENT_ID not readable (secret not set or cache stale).';
      // Is the tool catalog populated for this connector? (the "empty tools list" fix)
      const cat = await query<any>(`SELECT tool_name FROM connector_tool WHERE connector=$1 ORDER BY tool_name`, [id]).catch(() => []);
      out.catalogTools = (cat || []).map((r: any) => r.tool_name);
      const connected = await query<any>(`SELECT COUNT(*)::int AS n FROM connector_credentials WHERE source=$1`, [id]).catch(() => [{ n: 0 }]);
      out.connectedCredentials = connected?.[0]?.n ?? 0;
    } catch (e: any) { out.error = e?.message; }
    return { statusCode: 200, body: JSON.stringify(out, null, 2) } as APIGatewayProxyResult;
  }

  // GITHUB-REMAP — diagnose + fix a stale GitHub repo mapping. When the token's repo access changes,
  // the connector keeps syncing the OLD `connector_routing.repos` (no auto-discovery) → new repo never
  // pulled, old repo's commits linger. DRY-RUN shows: current mapping, the repos actually present in
  // knowledge_item, and (best-effort) the repos the token can now see. { setRepos:['owner/name'],
  // commit:true } remaps → prunes off-list github items → resets the cursor → triggers a fresh sync.
  if ((event as any).__job === 'github-remap') {
    const spaceId = String((event as any).spaceId || '');
    if (!spaceId) return { statusCode: 400, body: 'spaceId required' } as APIGatewayProxyResult;
    const owner = await queryOne<{ user_id: string; workspace_id: string }>(
      `SELECT user_id, workspace_id FROM knowledge_item WHERE space_id=$1 LIMIT 1`, [spaceId],
    ).catch(() => null);
    if (!owner) return { statusCode: 404, body: JSON.stringify({ error: 'no items in space' }) } as APIGatewayProxyResult;
    const out: any = { space: spaceId, workspace: owner.workspace_id };
    const { getAllMappedRepos, setGithubRepos } = await import('./connectors/routing');
    out.currentlyMapped = await getAllMappedRepos(owner.user_id, owner.workspace_id).catch(() => []);
    out.itemRepos = await query<any>(
      `SELECT split_part(split_part(source_id,'@',1),'#',1) AS repo, COUNT(*)::int AS items FROM knowledge_item
        WHERE workspace_id=$1 AND source='github' GROUP BY 1 ORDER BY 2 DESC`, [owner.workspace_id],
    ).catch(() => []);
    // Best-effort: what repos can the token see NOW? Try the live github tools for a repo lister.
    try {
      const { resolveMcpConnection } = await import('./mcp/connection');
      const { mcpListTools, mcpCallTool, resolveLiveTool } = await import('./mcp/client');
      const conn = await resolveMcpConnection(owner.user_id, owner.workspace_id, 'github');
      if (conn) {
        const tools = await mcpListTools(conn.server, conn.token).catch(() => []);
        out.githubTools = (tools || []).map((t: any) => t.name).slice(0, 60);
        const lister = resolveLiveTool(tools, 'search_repositories', 'github') || resolveLiveTool(tools, 'list_repositories', 'github');
        if (lister) {
          const r = await mcpCallTool(conn.server, conn.token, String(lister.name), { query: 'user:@me sort:updated', perPage: 30 }).catch(() => null);
          const text = (r?.content?.[0]?.text ?? '').toString();
          out.discoverySample = text.slice(0, 600);
        }
        // PROBE the mapped repo: how many commits on default branch, and what BRANCHES exist (work on
        // a non-default branch is invisible to list_commits, which defaults to the default branch).
        const probeRepo = String((event as any).probeRepo || (out.currentlyMapped?.[0] || ''));
        if (probeRepo.includes('/')) {
          const [po, pr] = probeRepo.split('/');
          const branchesTool = resolveLiveTool(tools, 'list_branches', 'github');
          if (branchesTool) {
            const rb = await mcpCallTool(conn.server, conn.token, String(branchesTool.name), { owner: po, repo: pr, perPage: 50 }).catch(() => null);
            const bt = (rb?.content?.[0]?.text ?? '').toString();
            try { const j = JSON.parse(bt); const arr = Array.isArray(j) ? j : j.branches || j.items || []; out.branches = arr.map((b: any) => b.name).filter(Boolean); } catch { out.branchesRaw = bt.slice(0, 300); }
          }
          const rc = await mcpCallTool(conn.server, conn.token, 'list_commits', { owner: po, repo: pr, perPage: 100 }).catch(() => null);
          const ct = (rc?.content?.[0]?.text ?? '').toString();
          try { const j = JSON.parse(ct); const arr = Array.isArray(j) ? j : j.commits || j.items || []; out.defaultBranchCommits = arr.length; } catch { out.commitsRaw = ct.slice(0, 300); }
        }
      } else out.githubTools = 'github not connected in this workspace';
    } catch (e: any) { out.discoveryError = e?.message; }

    if ((event as any).commit === true && Array.isArray((event as any).setRepos)) {
      const repos = ((event as any).setRepos as any[]).map((r) => String(r).trim()).filter(Boolean);
      await setGithubRepos(owner.user_id, owner.workspace_id, repos, null);
      const pruned = await query<any>(
        `WITH d AS (DELETE FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source='github'
             AND split_part(split_part(source_id,'@',1),'#',1) <> ALL($3) RETURNING 1) SELECT COUNT(*)::int AS n FROM d`,
        [owner.user_id, owner.workspace_id, repos]).catch(() => null);
      await query(`DELETE FROM sync_state WHERE user_id=$1 AND source='github'`, [owner.user_id]).catch(() => {});
      out.remapped = { repos, prunedItems: pruned?.[0]?.n ?? 0, cursorReset: true };
    }
    return { statusCode: 200, body: JSON.stringify(out, null, 2) } as APIGatewayProxyResult;
  }

  // BRAIN-REBUILD — wipe a space's DERIVED brain map (edges/threads/brief/atoms/proposals/embed
  // cursors; KEEPS knowledge_item + knowledge_graph + events + credentials) and rebuild it end-to-end
  // (embed→bind→atoms→link→threads→brief→consolidate). DRY-RUN by default; { commit:true } wipes;
  // { commit:true, rebuild:true } wipes AND rebuilds. Idempotent; crons finish any tail. Spends tokens
  // on rebuild (embeddings + verdicts + atoms).
  if ((event as any).__job === 'brain-rebuild') {
    const spaceId = String((event as any).spaceId || '');
    if (!spaceId) return { statusCode: 400, body: 'spaceId required' } as APIGatewayProxyResult;
    try {
      const { resetSpaceBrain, rebuildSpaceBrain } = await import('./connectors/brainRebuild');
      const commit = (event as any).commit === true;
      if (commit && (event as any).rebuild === true) {
        return { statusCode: 200, body: JSON.stringify(await rebuildSpaceBrain(spaceId), null, 2) } as APIGatewayProxyResult;
      }
      const reset = await resetSpaceBrain(spaceId, commit);
      return { statusCode: 200, body: JSON.stringify({ mode: commit ? 'COMMIT — derived brain deleted' : 'DRY-RUN — would delete (source items kept)', keeps: ['knowledge_item', 'knowledge_graph', 'brain_event', 'connector_credentials'], reset }, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('brain_rebuild_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // MEM-UNITS (Memory-OS Phase 3) — index a space's derived memory atoms (decisions/action-items/
  // topics from knowledge_graph) as first-class vectors, so retrieval hits the decision directly
  // instead of an averaged whole-meeting vector. Hash-gated (only changed atoms re-embed).
  if ((event as any).__job === 'mem-units') {
    const spaceId = String((event as any).spaceId || '');
    if (!spaceId) return { statusCode: 400, body: 'spaceId required' } as APIGatewayProxyResult;
    try {
      const { buildSpaceUnits, buildSpaceChunks, buildSpaceStateUnits } = await import('./connectors/memunits');
      const atoms = await buildSpaceUnits(spaceId);
      const chunks = await buildSpaceChunks(spaceId);
      const state = await buildSpaceStateUnits(spaceId);
      console.log('mem_units_job', JSON.stringify({ atoms, chunks, state }));
      return { statusCode: 200, body: JSON.stringify({ atoms, chunks, state }, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('mem_units_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // MEM-SCORE (Memory-OS Phase 1) — the brain's benchmark harness. Turns memory quality into a NUMBER
  // so every storage/retrieval change is A/B'd. { spaceId, seed:true } auto-generates the golden set
  // ($0). { spaceId } runs vector retrieval scoring (cheap — query embeddings only). { useGraph:true }
  // adds brain_edge expansion. { withAnswer:true } adds the LLM answer+judge layer (Flash, metered).
  // { spaceId, history:true } returns recent runs (the REPORT).
  if ((event as any).__job === 'mem-score') {
    const spaceId = String((event as any).spaceId || '');
    if (!spaceId) return { statusCode: 400, body: 'spaceId required' } as APIGatewayProxyResult;
    try {
      const { seedGoldenSet, paraphraseGoldenSet, passageGoldenSet, runMemScore, memScoreHistory } = await import('./connectors/memscore');
      if ((event as any).history === true) {
        return { statusCode: 200, body: JSON.stringify(await memScoreHistory(spaceId), null, 2) } as APIGatewayProxyResult;
      }
      const out: any = {};
      if ((event as any).seed === true) out.seed = await seedGoldenSet(spaceId);
      if ((event as any).paraphrase === true) out.paraphrase = await paraphraseGoldenSet(spaceId);
      if ((event as any).passage === true) out.passage = await passageGoldenSet(spaceId);
      if ((event as any).noRun !== true) out.run = await runMemScore(spaceId, {
        withAnswer: (event as any).withAnswer === true,
        useGraph: (event as any).useGraph === true,
        rerank: (event as any).rerank === true,
        llmRerank: (event as any).llmRerank === true,
        noChunks: (event as any).noChunks === true,
        limit: typeof (event as any).limit === 'number' ? (event as any).limit : undefined,
        k: typeof (event as any).k === 'number' ? (event as any).k : undefined,
        origin: (event as any).origin,
        config: (event as any).config,
      });
      console.log('mem_score', JSON.stringify(out.run));
      return { statusCode: 200, body: JSON.stringify(out, null, 2) } as APIGatewayProxyResult;
    } catch (e: any) {
      console.error('mem_score_failed', JSON.stringify({ message: e?.message }));
      return { statusCode: 500, body: JSON.stringify({ error: e?.message }) } as APIGatewayProxyResult;
    }
  }

  // BRAIN-EDGE CLEANUP — removes redundant SAME-SOURCE edges that blob the map (commit↔commit,
  // ticket↔ticket) and trims meeting↔meeting to the strongest few per meeting. DRY-RUN by default;
  // deletes only with { commit:true }. With { resetLinkState:true } it also clears the link cursor for
  // the space so the next brain-link rebuilds proper cross-source lineage (meeting→ticket→commit).
  if ((event as any).__job === 'brain-edge-cleanup') {
    const spaceId = String((event as any).spaceId || '');
    const commit = (event as any).commit === true;
    const MM_KEEP = 3;   // meeting↔meeting links kept per meeting (its strongest)
    const results: any = { mode: commit ? 'COMMIT — edges deleted' : 'DRY-RUN — edges that WOULD be deleted', space: spaceId, meetingLinksKeptPerMeeting: MM_KEEP };
    const step = async (label: string, countSql: string, deleteSql: string) => {
      try { const r = await query<any>(commit ? deleteSql : countSql, [spaceId]); results[label] = r?.[0]?.n ?? 0; }
      catch (e: any) { results[label] = `error: ${e?.message}`; }
    };
    // 0) Optional full edge reset (clean graph rebuild): delete ALL edges for the space.
    if ((event as any).allEdges === true) {
      await step('allEdgesDeleted',
        `SELECT COUNT(*)::int AS n FROM brain_edge WHERE space_id=$1`,
        `WITH d AS (DELETE FROM brain_edge WHERE space_id=$1 RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    }
    // 1) Same-source semantic blobs: github↔github + jira↔jira → remove entirely.
    await step('sameSourceBlobsDeleted',
      `SELECT COUNT(*)::int AS n FROM brain_edge t
         JOIN knowledge_item a ON a.id::text=t.src_id JOIN knowledge_item b ON b.id::text=t.dst_id
        WHERE t.space_id=$1 AND t.origin='semantic' AND a.source=b.source AND a.source IN ('github','jira')`,
      `WITH d AS (DELETE FROM brain_edge t USING knowledge_item a, knowledge_item b
         WHERE a.id::text=t.src_id AND b.id::text=t.dst_id AND t.space_id=$1
           AND t.origin='semantic' AND a.source=b.source AND a.source IN ('github','jira') RETURNING 1)
       SELECT COUNT(*)::int AS n FROM d`);
    // 2) Meeting↔meeting: keep each meeting's top-MM_KEEP by confidence; delete an edge only if it's
    //    beyond the top-K for BOTH its endpoints (so every meeting keeps its strongest links).
    const mmRanked = `SELECT t.id,
         row_number() OVER (PARTITION BY t.src_id ORDER BY t.confidence DESC NULLS LAST, t.created_at DESC) AS r_src,
         row_number() OVER (PARTITION BY t.dst_id ORDER BY t.confidence DESC NULLS LAST, t.created_at DESC) AS r_dst
       FROM brain_edge t
       JOIN knowledge_item a ON a.id::text=t.src_id AND a.source='meeting'
       JOIN knowledge_item b ON b.id::text=t.dst_id AND b.source='meeting'
      WHERE t.space_id=$1`;
    await step('meetingLinksTrimmed',
      `WITH mm AS (${mmRanked}) SELECT COUNT(*)::int AS n FROM mm WHERE r_src > ${MM_KEEP} AND r_dst > ${MM_KEEP}`,
      `WITH mm AS (${mmRanked}), d AS (DELETE FROM brain_edge WHERE id IN (SELECT id FROM mm WHERE r_src > ${MM_KEEP} AND r_dst > ${MM_KEEP}) RETURNING 1)
       SELECT COUNT(*)::int AS n FROM d`);
    // 3) Optional: clear the link cursor for this space's items so brain-link re-derives lineage.
    //    resetSource (e.g. 'github') scopes the reset to one source — re-link commits without
    //    re-running the expensive meeting/ticket LLM verdicts.
    if (commit && (event as any).resetLinkState === true) {
      const resetSource = (event as any).resetSource ? String((event as any).resetSource) : null;
      const sql = resetSource
        ? `WITH d AS (DELETE FROM brain_link_state WHERE item_id IN (SELECT id FROM knowledge_item WHERE space_id=$1 AND source=$2) RETURNING 1) SELECT COUNT(*)::int AS n FROM d`
        : `WITH d AS (DELETE FROM brain_link_state WHERE item_id IN (SELECT id FROM knowledge_item WHERE space_id=$1) RETURNING 1) SELECT COUNT(*)::int AS n FROM d`;
      try { const r = await query<any>(sql, resetSource ? [spaceId, resetSource] : [spaceId]);
        results.linkStateReset = r?.[0]?.n ?? 0;
      } catch (e: any) { results.linkStateReset = `error: ${e?.message}`; }
    }
    return { statusCode: 200, body: JSON.stringify(results, null, 2) } as APIGatewayProxyResult;
  }

  // BRAIN-MAP DEBUG — READ-ONLY. Reports edge composition + fragmentation for a space, so we can see
  // WHY the map looks fragmented/redundant (e.g. github↔github blobs vs. meeting→connector lineage).
  // EDGE-AUDIT — the "hanging lines / isolated nodes" diagnosis. For a space: how many edges have BOTH
  // endpoints as nodes in this space (render fine) vs endpoints that don't resolve to a space node
  // (dangling = deleted item; cross-space = endpoint lives in another space) → those are the hanging
  // lines. Plus how many items are isolated (no edge at all).
  if ((event as any).__job === 'edge-audit') {
    const spaceId = String((event as any).spaceId || '');
    if (!spaceId) return { statusCode: 400, body: 'spaceId required' } as APIGatewayProxyResult;
    const q = async (sql: string) => { try { return (await query<any>(sql, [spaceId]))?.[0]; } catch (e: any) { return { error: e?.message }; } };
    const edges = await q(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE sa.id IS NOT NULL AND da.id IS NOT NULL)::int AS both_in_space,
              COUNT(*) FILTER (WHERE (sa.id IS NULL AND se.id IS NULL) OR (da.id IS NULL AND de.id IS NULL))::int AS dangling_deleted_endpoint,
              COUNT(*) FILTER (WHERE (sa.id IS NULL AND se.id IS NOT NULL) OR (da.id IS NULL AND de.id IS NOT NULL))::int AS endpoint_in_other_space
         FROM brain_edge e
         LEFT JOIN knowledge_item sa ON sa.id::text=e.src_id AND sa.space_id=e.space_id
         LEFT JOIN knowledge_item da ON da.id::text=e.dst_id AND da.space_id=e.space_id
         LEFT JOIN knowledge_item se ON se.id::text=e.src_id
         LEFT JOIN knowledge_item de ON de.id::text=e.dst_id
        WHERE e.space_id=$1`);
    const nodes = await q(
      `SELECT COUNT(*)::int AS total_items,
              COUNT(*) FILTER (WHERE NOT EXISTS (SELECT 1 FROM brain_edge e WHERE e.space_id=$1 AND (e.src_id=ki.id::text OR e.dst_id=ki.id::text)))::int AS isolated_items
         FROM knowledge_item ki WHERE ki.space_id=$1`);
    const isolatedBySource = await query<any>(
      `SELECT ki.source, COUNT(*)::int AS isolated FROM knowledge_item ki
        WHERE ki.space_id=$1 AND NOT EXISTS (SELECT 1 FROM brain_edge e WHERE e.space_id=$1 AND (e.src_id=ki.id::text OR e.dst_id=ki.id::text))
        GROUP BY 1 ORDER BY 2 DESC`, [spaceId]).catch(() => []);
    return { statusCode: 200, body: JSON.stringify({ space: spaceId, edges, nodes, isolatedBySource }, null, 2) } as APIGatewayProxyResult;
  }

  if ((event as any).__job === 'brain-map-debug') {
    const spaceId = String((event as any).spaceId || '');
    const safe = async (sql: string, params: any[] = []) => { try { return await query<any>(sql, params); } catch (e: any) { return [{ error: e?.message }]; } };
    // Edges grouped by origin + the (source-pair) they connect — shows redundant same-source vs lineage.
    const byPair = await safe(
      `SELECT e.origin,
              least(a.source, b.source) AS s1, greatest(a.source, b.source) AS s2,
              (a.source = b.source) AS same_source, COUNT(*)::int AS n
         FROM brain_edge e
         JOIN knowledge_item a ON a.id::text = e.src_id
         JOIN knowledge_item b ON b.id::text = e.dst_id
        WHERE e.space_id=$1
        GROUP BY 1,2,3,4 ORDER BY n DESC`, [spaceId]);
    // Per-node degree distribution by source: are meetings under-connected to connectors?
    const degree = await safe(
      `WITH ends AS (
         SELECT e.src_id AS id FROM brain_edge e WHERE e.space_id=$1
         UNION ALL SELECT e.dst_id FROM brain_edge e WHERE e.space_id=$1)
       SELECT ki.source, COUNT(DISTINCT ki.id)::int AS nodes,
              COALESCE(SUM(d.deg),0)::int AS total_edges,
              COUNT(DISTINCT ki.id) FILTER (WHERE d.deg IS NULL)::int AS isolated
         FROM knowledge_item ki
         LEFT JOIN (SELECT id, COUNT(*)::int AS deg FROM ends GROUP BY id) d ON d.id = ki.id::text
        WHERE ki.space_id=$1
        GROUP BY ki.source ORDER BY nodes DESC`, [spaceId]);
    // Meeting → connector reach: how many meetings have ANY edge to a jira/github item?
    const meetingReach = await safe(
      `SELECT COUNT(*)::int AS meetings,
              COUNT(*) FILTER (WHERE EXISTS (
                SELECT 1 FROM brain_edge e JOIN knowledge_item o ON o.id::text = (CASE WHEN e.src_id=m.id::text THEN e.dst_id ELSE e.src_id END)
                 WHERE e.space_id=m.space_id AND (e.src_id=m.id::text OR e.dst_id=m.id::text)
                   AND o.source IN ('jira','github')))::int AS meetings_linked_to_a_connector
         FROM knowledge_item m WHERE m.space_id=$1 AND m.source='meeting'`, [spaceId]);
    return { statusCode: 200, body: JSON.stringify({
      note: 'READ-ONLY. space=' + spaceId,
      edgesByOriginAndSourcePair: byPair,
      nodesAndDegreeBySource: degree,
      meetingConnectorReach: meetingReach,
    }, null, 2) } as APIGatewayProxyResult;
  }

  // SPACE-LEAK REPORT (P1 dry-run) — READ-ONLY. Reports exactly what the P1 cleanup migration
  // WOULD remove/fix, without changing a single row. Run before any destructive cleanup so the
  // user can see the blast radius. No writes anywhere in this branch.
  if ((event as any).__job === 'space-leak-report') {
    const SENT = ACCOUNT_SCOPE;
    const safe = async (sql: string, params: any[] = []) => { try { return await query<any>(sql, params); } catch (e: any) { return [{ error: e?.message }]; } };
    // 1) The core leak: connector items filed in a space that NEVER authorized that source
    //    (no matching connector_credentials). These are the illegitimate copies P1 deletes.
    const leakedBySource = await safe(
      `SELECT ki.source, COUNT(*)::int AS leaked_rows, COUNT(DISTINCT ki.space_id)::int AS spaces,
              COUNT(DISTINCT ki.user_id)::int AS users
         FROM knowledge_item ki
        WHERE ki.source <> 'meeting' AND ki.space_id IS NOT NULL AND ki.space_id <> $1
          AND NOT EXISTS (SELECT 1 FROM connector_credentials c
            WHERE c.user_id=ki.user_id AND c.workspace_id=ki.workspace_id
              AND c.space_id=ki.space_id AND c.source=ki.source)
        GROUP BY ki.source ORDER BY leaked_rows DESC`, [SENT]);
    // 2) Same connector item (source, source_id) duplicated across >1 space — the symptom.
    const dupAcrossSpaces = await safe(
      `SELECT source, COUNT(*)::int AS items_in_multiple_spaces, SUM(n)::int AS total_rows FROM (
         SELECT user_id, source, source_id, COUNT(DISTINCT space_id) AS n
           FROM knowledge_item WHERE source <> 'meeting' AND space_id IS NOT NULL
          GROUP BY 1,2,3 HAVING COUNT(DISTINCT space_id) > 1
       ) t GROUP BY source ORDER BY total_rows DESC`);
    // 3) A few concrete leaked examples (issue key → the spaces it sits in vs. where it's connected).
    const samples = await safe(
      `SELECT ki.source, ki.source_id,
              array_agg(DISTINCT ki.space_id::text) AS in_spaces,
              (SELECT array_agg(DISTINCT c.space_id::text) FROM connector_credentials c
                 WHERE c.user_id=ki.user_id AND c.workspace_id=ki.workspace_id AND c.source=ki.source) AS connected_spaces
         FROM knowledge_item ki
        WHERE ki.source <> 'meeting' AND ki.space_id IS NOT NULL AND ki.space_id <> $1
          AND NOT EXISTS (SELECT 1 FROM connector_credentials c
            WHERE c.user_id=ki.user_id AND c.workspace_id=ki.workspace_id
              AND c.space_id=ki.space_id AND c.source=ki.source)
        GROUP BY ki.user_id, ki.workspace_id, ki.source, ki.source_id LIMIT 25`, [SENT]);
    // 4) Cross-space brain_edges (both endpoints in different REAL spaces) — B's legacy artifacts.
    const crossSpaceEdges = await safe(
      `SELECT COUNT(*)::int AS n FROM brain_edge e
         JOIN knowledge_item a ON a.id::text=e.src_id
         JOIN knowledge_item b ON b.id::text=e.dst_id
        WHERE a.space_id IS NOT NULL AND b.space_id IS NOT NULL
          AND a.space_id <> $1 AND b.space_id <> $1 AND a.space_id <> b.space_id`, [SENT]);
    // 5) Workspace_id drift — connector data under a workspace_id that no longer exists.
    const wsDrift = await safe(
      `SELECT 'knowledge_item' AS tbl, COUNT(*)::int AS n FROM knowledge_item ki
        WHERE ki.workspace_id NOT IN (SELECT id FROM workspaces WHERE user_id=ki.user_id)
       UNION ALL
       SELECT 'connector_credentials', COUNT(*)::int FROM connector_credentials c
        WHERE c.workspace_id NOT IN (SELECT id FROM workspaces WHERE user_id=c.user_id) AND c.workspace_id <> $1`, [SENT]);
    // 6) action_proposals in a space with no credential for that proposal's connector (jira).
    const leakedProposals = await safe(
      `SELECT COUNT(*)::int AS n FROM action_proposal ap
        WHERE ap.space_id IS NOT NULL AND ap.space_id <> $1
          AND NOT EXISTS (SELECT 1 FROM connector_credentials c
            WHERE c.user_id=ap.user_id AND c.workspace_id=ap.workspace_id
              AND c.space_id=ap.space_id AND c.source='jira')`, [SENT]);
    // 7) Space NAME map + per-space connector picture: for each space, which sources are CONNECTED
    //    (have a credential) vs. which sources have ITEMS sitting in it. Lets us map POZ/Personal.
    const spaceMap = await safe(
      `SELECT s.id::text AS space_id, s.name, s.is_default,
              (SELECT array_agg(DISTINCT c.source) FROM connector_credentials c
                 WHERE c.user_id=s.user_id AND c.space_id=s.id) AS connected_sources,
              (SELECT json_agg(json_build_object('source', x.source, 'items', x.n) ORDER BY x.n DESC)
                 FROM (SELECT ki.source, COUNT(*)::int AS n FROM knowledge_item ki
                         WHERE ki.user_id=s.user_id AND ki.space_id=s.id AND ki.source <> 'meeting'
                         GROUP BY ki.source) x) AS item_sources
         FROM spaces s ORDER BY s.is_default DESC, s.name`);
    return { statusCode: 200, body: JSON.stringify({
      note: 'READ-ONLY dry-run. Nothing was modified. These are the rows P1 cleanup would address.',
      spaceMap,
      leakedConnectorItemsBySource: leakedBySource,
      duplicatedAcrossSpaces: dupAcrossSpaces,
      leakedSamples: samples,
      crossSpaceEdges: crossSpaceEdges?.[0]?.n ?? crossSpaceEdges,
      workspaceIdDrift: wsDrift,
      leakedProposals: leakedProposals?.[0]?.n ?? leakedProposals,
    }, null, 2) } as APIGatewayProxyResult;
  }

  // SPACE-LEAK CLEANUP (P1) — removes the rows the leak left behind. DEFAULTS TO DRY-RUN
  // (count only); deletes ONLY when invoked with { commit: true }. Local connectors
  // (claude-code, codex) are EXCLUDED — they legitimately have no connector_credentials, so the
  // "no credential = leaked" rule must not touch them. The canonical copies in connected spaces
  // are never touched (they have a matching credential).
  if ((event as any).__job === 'space-leak-cleanup') {
    const commit = (event as any).commit === true;
    const SENT = `'${ACCOUNT_SCOPE}'::uuid`;
    const LOCAL = `('meeting','claude-code','codex')`;   // never touched (local; no credentials by design)
    // Optional allowlist: connector data may live ONLY in these spaces — everything else (for
    // credential-based connectors) is leaked, EVEN IF it has a credential (an unintended connection).
    // When omitted, falls back to the credential-presence rule (keep iff a matching credential exists).
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
    const rawKeep = Array.isArray((event as any).keepSpaceIds) ? (event as any).keepSpaceIds : null;
    const keep: string[] | null = rawKeep && rawKeep.length && rawKeep.every((x: any) => typeof x === 'string' && UUID_RE.test(x)) ? rawKeep : null;
    const keepList = keep ? keep.map((x) => `'${x}'::uuid`).join(',') : null;
    const credAbsent = (src: string) =>
      `NOT EXISTS (SELECT 1 FROM connector_credentials c WHERE c.user_id=t.user_id
         AND c.workspace_id=t.workspace_id AND c.space_id=t.space_id AND c.source=${src})`;
    // "not allowed in this space": allowlist mode → space not in keep; else → no matching credential.
    const disallowed = (src: string) => keepList ? `t.space_id NOT IN (${keepList})` : credAbsent(src);
    const results: any = {
      mode: commit ? 'COMMIT — rows DELETED' : 'DRY-RUN — rows that WOULD be deleted (nothing changed)',
      rule: keepList ? `ALLOWLIST — connector data kept ONLY in: ${keep!.join(', ')}` : 'CREDENTIAL-PRESENCE — kept where a matching credential exists',
      excludedLocalConnectors: ['claude-code', 'codex', 'meeting'],
    };
    const step = async (label: string, table: string, where: string) => {
      const sql = commit
        ? `WITH del AS (DELETE FROM ${table} t WHERE ${where} RETURNING 1) SELECT COUNT(*)::int AS n FROM del`
        : `SELECT COUNT(*)::int AS n FROM ${table} t WHERE ${where}`;
      try { const r = await query<any>(sql); results[label] = r?.[0]?.n ?? 0; }
      catch (e: any) { results[label] = `error: ${e?.message}`; }
    };
    // 1) Cross-space edges — both endpoints in DIFFERENT real spaces (always removed).
    await step('crossSpaceEdgesDeleted', 'brain_edge',
      `EXISTS (SELECT 1 FROM knowledge_item a, knowledge_item b
         WHERE a.id::text=t.src_id AND b.id::text=t.dst_id
           AND a.space_id IS NOT NULL AND b.space_id IS NOT NULL
           AND a.space_id <> ${SENT} AND b.space_id <> ${SENT} AND a.space_id <> b.space_id)`);
    // 2) Leaked brain_events (skip local sources).
    await step('leakedEventsDeleted', 'brain_event',
      `t.space_id IS NOT NULL AND t.space_id <> ${SENT} AND t.source NOT IN ('claude-code','codex') AND ${disallowed('t.source')}`);
    // 3) Leaked agent proposals (jira).
    await step('leakedProposalsDeleted', 'action_proposal',
      `t.space_id IS NOT NULL AND t.space_id <> ${SENT} AND ${disallowed(`'jira'`)}`);
    // 4) Leaked connector items — credential-based sources only.
    await step('leakedItemsDeleted', 'knowledge_item',
      `t.source NOT IN ${LOCAL} AND t.space_id IS NOT NULL AND t.space_id <> ${SENT} AND ${disallowed('t.source')}`);
    // 5) Revoke unintended connections (allowlist mode only): credentials outside the kept spaces.
    //    Without this, the next sync would re-pull the data we just deleted.
    if (keepList) {
      await step('credentialsRevoked', 'connector_credentials',
        `t.space_id IS NOT NULL AND t.space_id <> ${SENT} AND t.space_id NOT IN (${keepList})`);
    }
    // 6) Edges now dangling (endpoint item removed) — commit mode only.
    if (commit) {
      await step('danglingEdgesDeleted', 'brain_edge',
        `(t.src_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_item k WHERE k.id::text=t.src_id))
         OR (t.dst_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_item k WHERE k.id::text=t.dst_id))`);
    }
    return { statusCode: 200, body: JSON.stringify(results, null, 2) } as APIGatewayProxyResult;
  }

  // BRAIN-SENTINEL-SWEEP (CF-1) — clears the sentinel/unscoped bucket's LEFTOVERS that produce ghost &
  // DUPLICATE threads: (a) any thread built for ACCOUNT_SCOPE (never a real space), and (b) connector
  // item rows stranded at ACCOUNT_SCOPE that ALSO exist (same source+source_id+type) in a real space —
  // the invisible cross-space dups behind "SCRUM-14 appeared twice". DRY-RUN by default; { commit:true }
  // deletes. Local sources (meeting/claude-code/codex) are never touched. Idempotent + safe to re-run.
  if ((event as any).__job === 'brain-sentinel-sweep') {
    const commit = (event as any).commit === true;
    const SENT = `'${ACCOUNT_SCOPE}'::uuid`;
    const LOCAL = `('meeting','claude-code','codex')`;
    const results: any = { mode: commit ? 'COMMIT — rows DELETED' : 'DRY-RUN — rows that WOULD be deleted (nothing changed)' };
    const step = async (label: string, countSql: string, deleteSql: string) => {
      try { const r = await query<any>(commit ? deleteSql : countSql); results[label] = r?.[0]?.n ?? 0; }
      catch (e: any) { results[label] = `error: ${e?.message}`; }
    };
    // 0) Report the current cross-space duplication (context for the sweep).
    try {
      const d = await query<any>(
        `SELECT source, COUNT(*)::int AS items_in_multiple_spaces, SUM(c)::int AS total_rows FROM (
           SELECT source, source_id, type, COUNT(DISTINCT space_id)::int AS spaces, COUNT(*)::int AS c
             FROM knowledge_item WHERE space_id IS NOT NULL AND source NOT IN ${LOCAL}
            GROUP BY source, source_id, type HAVING COUNT(DISTINCT space_id) > 1) x
         GROUP BY source`);
      results.dupAcrossSpaces = d ?? [];
    } catch (e: any) { results.dupAcrossSpaces = `error: ${e?.message}`; }
    // 1) Ghost threads — any ledger row built for the sentinel bucket.
    await step('sentinelThreadsDeleted',
      `SELECT COUNT(*)::int AS n FROM brain_thread WHERE space_id=${SENT}`,
      `WITH d AS (DELETE FROM brain_thread WHERE space_id=${SENT} RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 2) Sentinel-bucket duplicate connector items (a real-space copy exists) — the canonical copy in
    //    the connected space is kept; only the stranded ACCOUNT_SCOPE row is removed.
    const dupWhere =
      `t.space_id=${SENT} AND t.source NOT IN ${LOCAL}
        AND EXISTS (SELECT 1 FROM knowledge_item r WHERE r.source=t.source AND r.source_id=t.source_id
             AND r.type=t.type AND r.space_id IS NOT NULL AND r.space_id <> ${SENT} AND r.user_id=t.user_id)`;
    await step('sentinelDupItemsDeleted',
      `SELECT COUNT(*)::int AS n FROM knowledge_item t WHERE ${dupWhere}`,
      `WITH d AS (DELETE FROM knowledge_item t WHERE ${dupWhere} RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    // 3) Edges left dangling by (2) — commit mode only (the endpoint item is now gone).
    if (commit) {
      await step('danglingEdgesDeleted',
        '', `WITH d AS (DELETE FROM brain_edge t WHERE
              (t.src_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_item k WHERE k.id::text=t.src_id))
           OR (t.dst_kind='item' AND NOT EXISTS (SELECT 1 FROM knowledge_item k WHERE k.id::text=t.dst_id))
           RETURNING 1) SELECT COUNT(*)::int AS n FROM d`);
    }
    return { statusCode: 200, body: JSON.stringify(results, null, 2) } as APIGatewayProxyResult;
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
      // Local dev sessions (Claude Code / Codex): lazy distill drip on the same cheap Flash tier.
      let sessions = { distilled: 0, remaining: 0 };
      try { const { distillSessions } = await import('./connectors/local/ingest'); sessions = await distillSessions(6); } catch (e: any) { console.error('session_distill_failed', e?.message); }
      return { statusCode: 200, body: JSON.stringify({ ...fp, backfill: bf, sessions }) } as APIGatewayProxyResult;
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
      // Optional targeting (rebuild a specific workspace with a real LLM budget) — used to re-derive
      // lineage after an edge cleanup. Defaults to the normal all-workspace sweep.
      const ws = (event as any).workspaceId as string | undefined;
      const llmBudget = typeof (event as any).llmBudget === 'number' ? (event as any).llmBudget : undefined;
      const timeBudgetMs = typeof (event as any).timeBudgetMs === 'number' ? (event as any).timeBudgetMs : undefined;
      const opts = (ws || llmBudget !== undefined || timeBudgetMs !== undefined) ? { workspaceId: ws, llmBudget, timeBudgetMs } : undefined;
      // DRAIN: keep linking until a full pass produces NOTHING new (backlog empty) or we approach the
      // Lambda limit — so no meeting / connector node is ever left permanently unprocessed. The cron
      // runs this; each round advances the brain_link_state cursor, so successive rounds cover newer
      // items until the whole space is linked. Cheap to re-run when there's nothing to do.
      const drain = (event as any).drain === true;
      if (drain) {
        const started = Date.now();
        const agg = { rounds: 0, provenance: 0, reference: 0, semantic: 0, llm: 0, workspaces: 0, pending: 0 };
        const MAX_MS = 240_000;   // Lambda is 300s; leave headroom
        // STOP on PENDING (items not yet linked), NOT on "0 new edges" — a batch can legitimately
        // produce no edges (items that don't relate) while more items still need processing. We loop
        // until every meeting/connector node is processed, or no round makes progress (stuck guard).
        const pendingSql = ws
          ? `SELECT COUNT(*)::int AS n FROM knowledge_item k WHERE k.workspace_id=$1
               AND NOT EXISTS (SELECT 1 FROM brain_link_state s WHERE s.item_id=k.id AND s.linked_at >= k.synced_at)`
          : `SELECT COUNT(*)::int AS n FROM knowledge_item k
               WHERE NOT EXISTS (SELECT 1 FROM brain_link_state s WHERE s.item_id=k.id AND s.linked_at >= k.synced_at)`;
        let lastPending = Number.POSITIVE_INFINITY;
        while (Date.now() - started < MAX_MS && agg.rounds < 80) {
          const r = await runBrainLink({ ...(opts || {}), timeBudgetMs: Math.min(timeBudgetMs ?? 28_000, MAX_MS - (Date.now() - started)) });
          agg.rounds++; agg.provenance += r.provenance; agg.reference += r.reference; agg.semantic += r.semantic; agg.llm += r.llm; agg.workspaces = r.workspaces;
          const pend = await query<{ n: number }>(pendingSql, ws ? [ws] : []).catch(() => null);
          const pending = pend?.[0]?.n ?? 0;
          agg.pending = pending;
          if (pending === 0) break;                 // everything processed → done
          if (pending >= lastPending) break;        // no progress this round → avoid an infinite loop
          lastPending = pending;
        }
        console.log('brain_link_drained', JSON.stringify(agg));
        return { statusCode: 200, body: JSON.stringify(agg) } as APIGatewayProxyResult;
      }
      return { statusCode: 200, body: JSON.stringify(await runBrainLink(opts)) } as APIGatewayProxyResult;
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
      // Reconciliation loop: cross-tool gaps (commit shipped→ticket not moved; code diverged
      // from intent) → proposed Jira actions into the SAME HITL queue. Propose-only.
      let reconcile = { workspaces: 0, proposed: 0 };
      try { const { runReconcileSweep } = await import('./connectors/jira/reconcile'); reconcile = await runReconcileSweep(); }
      catch (e: any) { console.error('reconcile_sweep_failed', e?.message); }
      // Phase 3 — intelligent gap reasoner: reads ALL the space's decisions + existing Jira tasks
      // and proposes only the missing work (LLM, not rules). Propose-only into the SAME HITL queue.
      let reasoner = { spaces: 0, proposed: 0 };
      try { const { runSuggestionReasoner } = await import('./connectors/suggestionReasoner'); reasoner = await runSuggestionReasoner(); }
      catch (e: any) { console.error('suggestion_reasoner_failed', e?.message); }
      return { statusCode: 200, body: JSON.stringify({ ...r, reconcile, reasoner }) } as APIGatewayProxyResult;
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

    // Public route: connector OAuth callback (browser redirect after consent — no JWT; correlated
    // by the single-use `state` nonce). Completes the token exchange server-side.
    if (resource === 'oauth' && segments[1] === 'callback' && method === 'GET') {
      return await completeConnectorOAuthCallback(event);
    }

    // Public route: self-hosted Slack MCP bridge (Slack Web API behind the MCP protocol). Authed by
    // the Slack Bearer token the MCP client sends — no JWT. Lets the tool-agnostic agent use Slack
    // without Slack's hosted-MCP app-approval gate.
    if (resource === 'mcp' && segments[1] === 'slack' && method === 'POST') {
      const { handleSlackMcpBridge } = await import('./mcp/bridges/slack');
      return await handleSlackMcpBridge(event);
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
      case 'spaces':     return await handleSpaces(method, segments, userId, event);
      case 'dictionary': return await handleDictionary(method, segments, userId, event);
      case 'folders':    return await handleFolders(method, segments, userId, event);
      case 'connectors': return await handleConnectors(method, segments, userId, event);
      case 'proposals':  return await handleProposals(method, segments, userId, event);
      case 'brain':      return await handleBrain(method, segments, userId, event);
      case 'contacts':   return await handleContacts(method, userId, event);
      case 'bootstrap':  return await handleBootstrap(userId, event);
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

    // Partition every new recording into a workspace (the user's vault). Honor a
    // client-supplied workspace_id when it belongs to the user (W2), else fall back to
    // the default workspace — so a row is NEVER left unpartitioned.
    await ensureWorkspacePartitionSchema();
    await ensureSpacesSchema();
    const taskWorkspaceId = (await validateOwnedWorkspaceId(userId, body.workspace_id))
      || (await activeWorkspaceId(event, userId, getUserEmail()));
    // No note lives directly under a workspace — file every recording into a space
    // (a client-supplied one it owns, else the workspace's default "My notes" space),
    // optionally into a folder within it.
    const taskSpaceId = (await validateOwnedSpaceId(userId, taskWorkspaceId, body.space_id))
      || (await resolveDefaultSpaceId(userId, taskWorkspaceId));
    const taskFolderId = body.folder_id ?? null;
    const row = await queryOne(
      `INSERT INTO task_history (user_id, workspace_id, space_id, folder_id, filename, transcription, summary, notes, audio_url, status, duration, prompt, personal_note, visualization_image, attendees, source)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [userId, taskWorkspaceId, taskSpaceId, taskFolderId, body.filename, body.transcription, body.summary, body.notes, body.audio_url, body.status, body.duration || 0, body.prompt, body.personal_note, body.visualization_image, JSON.stringify(body.attendees ?? []), source]
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
              audio_url, status, duration, prompt, personal_note, attendees,
              space_id, folder_id
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

    // W1: scope the listing to the ACTIVE workspace (the user's vault). The client
    // sends X-Workspace-Id; absent/invalid → the user's default workspace.
    const listWorkspaceId = await activeWorkspaceId(event, userId, getUserEmail());
    let whereClause = 'user_id=$1 AND workspace_id=$2';
    const params: any[] = [userId, listWorkspaceId];

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
      ? 'id, user_id, created_at, filename, transcription, summary, notes, audio_url, status, duration, prompt, personal_note, attendees, space_id, folder_id'
      : 'id, created_at, filename, summary, status, duration, attendees, space_id, folder_id';
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
  // Connections are (workspace + space)-scoped — connected INSIDE a space. The client passes
  // the active workspace + space via ?workspace=&space= (GET/DELETE) or body (oauth-url/pat);
  // ACCOUNT_SCOPE if absent.
  const qsWorkspace = event.queryStringParameters?.workspace || ACCOUNT_SCOPE;
  const qsSpace = event.queryStringParameters?.space || ACCOUNT_SCOPE;

  if (method === 'GET' && !id) {
    const creds = await query<{ source: string; account: string | null }>(
      `SELECT source, account FROM connector_credentials WHERE user_id=$1 AND workspace_id=$2 AND space_id=$3`,
      [userId, qsWorkspace, qsSpace],
    );
    const byId = new Map(creds.map((c) => [c.source, c]));
    const { isConnectorAvailable } = await import('./mcp/customConnectors');
    const connectors = await Promise.all(Object.values(MCP_SERVERS).map(async (s) => ({
      id: s.id,
      connected: byId.has(s.id),
      account: byId.get(s.id)?.account ?? null,
      status: s.status,
      // available = has a usable endpoint now (pinned for jira/github; configured for google/slack).
      // The client shows a "coming soon" connector as connectable once this flips true.
      available: await isConnectorAvailable(s.id, userId, qsWorkspace).catch(() => false),
    })));
    return ok({ enabled: true, workspace: qsWorkspace, space: qsSpace, connectors });
  }

  if (method === 'DELETE' && id) {
    await deleteToken(userId, id, qsWorkspace, qsSpace);
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

  // POST /connectors/local/ingest?workspace= { sessions: SessionDigest[] } → ingest local Claude
  // Code / Codex session digests (read + redacted on the desktop). Fast upsert (no LLM); the
  // brain-enrich cron distills them lazily. The client sends only sessions whose cwd maps to a
  // connected folder, attaching folderId per session.
  if (method === 'POST' && id === 'local' && segments[2] === 'ingest') {
    const sessions = parseBody(event)?.sessions;
    const { ingestLocalSessions } = await import('./connectors/local/ingest');
    return ok(await ingestLocalSessions(userId, qsWorkspace, Array.isArray(sessions) ? sessions : []));
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
          `DELETE FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source='github' AND split_part(split_part(source_id,'@',1),'#',1) <> ALL($3)`,
          [userId, qsWorkspace, repos],
        ).catch(() => {});
      }
    }
    // Re-tag existing items into their projects now that the mapping changed (idempotent).
    try { const { backfillItemFolders } = await import('./connectors/sync'); await backfillItemFolders(); } catch { /* best-effort */ }
    return ok({ ok: true, mapping: await getMapping(userId, qsWorkspace, folder) });
  }

  // Custom connectors — user-added remote MCP servers. GET list · POST create · DELETE remove.
  // Once created + connected, they flow through the SAME tool plane (discovery/permission/gate).
  if (id === 'custom') {
    const { createCustomConnector, listCustomConnectors, deleteCustomConnector } = await import('./mcp/customConnectors');
    if (method === 'GET') return ok({ connectors: await listCustomConnectors(userId, qsWorkspace) });
    if (method === 'POST' && !segments[2]) {
      const b = parseBody(event);
      const name = String(b.name || '').trim();
      const url = String(b.url || '').trim();
      if (!name || !/^https:\/\//i.test(url)) return badRequest('A name and an https Remote MCP server URL are required.');
      // Probe: does the server require auth? An unauthenticated tools/list either works (no-auth) or 401s.
      let needsAuth = true;
      try { await mcpListTools({ id: 'probe', url, transport: 'streamable-http' } as any, ''); needsAuth = false; } catch { needsAuth = true; }
      const row = await createCustomConnector(userId, qsWorkspace, {
        name, url, oauthClientId: b.oauthClientId ? String(b.oauthClientId) : null,
        oauthClientSecret: b.oauthClientSecret ? String(b.oauthClientSecret) : null,
        mode: b.mode === 'managed' ? 'managed' : 'individual', auth: needsAuth ? 'oauth' : 'none',
      });
      if (!needsAuth) {
        // No-auth server → connected immediately; discover its tools now.
        await storeToken(userId, row.slug, { access_token: '' }, null, null, qsWorkspace).catch(() => {});
        try { const { discoverConnectorTools } = await import('./mcp/toolPlane'); await discoverConnectorTools(userId, qsWorkspace, row.slug); } catch { /* fills on the sync cron */ }
      }
      return ok({ slug: row.slug, name: row.name, needsAuth });
    }
    if (method === 'DELETE' && segments[2]) {
      await deleteCustomConnector(userId, qsWorkspace, segments[2]).catch(() => {});
      await deleteToken(userId, segments[2], qsWorkspace).catch(() => {});
      return ok({ ok: true });
    }
    return notFound();
  }

  // POST /connectors/{id}/pat?workspace= { token } → connect via a Personal Access Token
  // (for MCP servers whose OAuth lacks DCR, e.g. GitHub). Validated against the live server.
  if (method === 'POST' && id && segments[2] === 'pat') {
    const { getServerConfig } = await import('./mcp/customConnectors');
    const server = await getServerConfig(userId, qsWorkspace, id);
    if (!server?.url) return badRequest('connector has no MCP endpoint');
    const token = String(parseBody(event).token || '').trim();
    if (!token) return badRequest('token required');
    try {
      await mcpListTools(server, token);   // verify the token actually authenticates
    } catch (e: any) {
      return ok({ connected: false, error: `Token was rejected by ${id}. Check the token and its scopes.`, detail: String(e?.message || '').slice(0, 160) });
    }
    await storeToken(userId, id, { access_token: token }, null, server.scopes ?? null, qsWorkspace, qsSpace);
    // Registration: discover + classify this connector's tools so the trust plane has its catalog.
    try { const { discoverConnectorTools } = await import('./mcp/toolPlane'); await discoverConnectorTools(userId, qsWorkspace, id); } catch { /* catalog also fills on the sync cron */ }
    return ok({ connected: true });
  }

  // POST /connectors/{id}/configure { workspace, url, oauthClientId?, oauthClientSecret?, auth? }
  // → bring-your-own MCP endpoint for a catalog connector (Slack/Gmail/…). Stores the endpoint so
  // the next oauth-url/exchange (or no-auth connect) resolves it. The reference's `mcp add` model.
  if (method === 'POST' && id && segments[2] === 'configure') {
    const body = parseBody(event);
    const workspaceId = String(body.workspace || ACCOUNT_SCOPE);
    const url = String(body.url || '').trim();
    if (!/^https:\/\//i.test(url)) return badRequest('A valid https MCP server URL is required.');
    const { configureCatalogConnector } = await import('./mcp/customConnectors');
    await configureCatalogConnector(userId, workspaceId, id, {
      url,
      oauthClientId: body.oauthClientId ? String(body.oauthClientId) : null,
      oauthClientSecret: body.oauthClientSecret ? String(body.oauthClientSecret) : null,
      auth: body.auth === 'none' ? 'none' : 'oauth',
    });
    return ok({ configured: true, needsAuth: body.auth !== 'none' });
  }

  // POST /connectors/{id}/oauth-url { workspace } → discover → (pre-registered client OR DCR) → PKCE URL.
  if (method === 'POST' && id && segments[2] === 'oauth-url') {
    const oauthBody = parseBody(event);
    const workspaceId = String(oauthBody.workspace || ACCOUNT_SCOPE);
    const spaceId = String(oauthBody.space || ACCOUNT_SCOPE);
    const { getServerConfig, getCustomConnectorOAuthClient, getRegistryOAuthClient } = await import('./mcp/customConnectors');
    const server = await getServerConfig(userId, workspaceId, id);
    // DIRECT-REST Google (gmail/gcal/gdrive) — no hosted MCP + no DCR, so use Google's FIXED OAuth
    // endpoints + the operator-configured client. (If MCP_GOOGLE_URL is set, server.url is non-null and
    // we fall through to the generic MCP path instead — both modes supported.)
    const GOOGLE_DIRECT = new Set(['gmail', 'gcal', 'gdrive']);
    if (GOOGLE_DIRECT.has(id) && (!server || !server.url)) {
      const client = await getRegistryOAuthClient(id, userId, workspaceId).catch(() => null);
      if (!client?.clientId) return badRequest('Google is not configured yet — the operator must set GOOGLE_OAUTH_CLIENT_ID / GOOGLE_OAUTH_CLIENT_SECRET.');
      const { getMcpServer } = await import('./mcp/registry');
      const scopes = getMcpServer(id)?.scopes || [];
      const { beginGoogleOAuth } = await import('./connectors/google/oauth');
      const { authorizeUrl, inflight } = beginGoogleOAuth(client, scopes, oauthCallbackUrl(event));
      await query(
        `INSERT INTO oauth_state (state, user_id, source, workspace_id, space_id, inflight) VALUES ($1,$2,$3,$4,$5,$6)
         ON CONFLICT (state) DO UPDATE SET inflight=EXCLUDED.inflight, workspace_id=EXCLUDED.workspace_id, space_id=EXCLUDED.space_id, created_at=NOW()`,
        [inflight.state, userId, id, workspaceId, spaceId, JSON.stringify(inflight)],
      );
      console.log('connector_oauth_url', JSON.stringify({ source: id, workspace: workspaceId, space: spaceId, mode: 'google-direct' }));
      return ok({ url: authorizeUrl });
    }
    if (!server || !server.url) return badRequest('connector has no MCP endpoint');
    // A pre-registered OAuth client: custom connectors carry their own; Google/Slack registry
    // connectors use the operator-configured client (they don't support dynamic registration).
    const providedClient = id.startsWith('custom-')
      ? await getCustomConnectorOAuthClient(userId, workspaceId, id).catch(() => null)
      : await getRegistryOAuthClient(id, userId, workspaceId).catch(() => null);
    const { authorizeUrl, inflight } = await beginMcpOAuth(server, oauthCallbackUrl(event), providedClient || undefined);
    await query(
      `INSERT INTO oauth_state (state, user_id, source, workspace_id, space_id, inflight) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (state) DO UPDATE SET inflight=EXCLUDED.inflight, workspace_id=EXCLUDED.workspace_id, space_id=EXCLUDED.space_id, created_at=NOW()`,
      [inflight.state, userId, id, workspaceId, spaceId, JSON.stringify(inflight)],
    );
    console.log('connector_oauth_url', JSON.stringify({ source: id, workspace: workspaceId, space: spaceId, redirect: CONNECTOR_REDIRECT_URI }));
    return ok({ url: authorizeUrl });
  }

  // POST /connectors/{id}/exchange { code, state } → token → broker (in the workspace
  // recorded at oauth-url time, so the connection lands where the user started it).
  if (method === 'POST' && id && segments[2] === 'exchange') {
    const body = parseBody(event);
    const code = String(body.code || '');
    const state = String(body.state || '');
    console.log('connector_exchange_called', JSON.stringify({ source: id, hasCode: !!code, hasState: !!state }));
    if (!code || !state) return badRequest('missing code/state');
    const row = await queryOne<{ inflight: OAuthInflight; workspace_id: string; space_id: string }>(
      `SELECT inflight, workspace_id, space_id FROM oauth_state WHERE state=$1 AND user_id=$2 AND source=$3`,
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
      row.workspace_id || ACCOUNT_SCOPE, row.space_id || ACCOUNT_SCOPE,
    );
    await query(`DELETE FROM oauth_state WHERE state=$1`, [state]);
    // Registration: discover + classify this connector's tools so the trust plane has its catalog.
    try { const { discoverConnectorTools } = await import('./mcp/toolPlane'); await discoverConnectorTools(userId, row.workspace_id || ACCOUNT_SCOPE, id); } catch { /* catalog also fills on the sync cron */ }
    return ok({ connected: true });
  }

  // GET /connectors/{id}/tools?workspace= → the discovered tool catalog + each tool's RESOLVED
  // permission (allow|ask|deny). Powers the per-tool permission editor (the connector card UI).
  if (method === 'GET' && id && segments[2] === 'tools') {
    const { listConnectorTools } = await import('./mcp/toolPlane');
    return ok({ tools: await listConnectorTools(userId, qsWorkspace, id) });
  }
  // POST /connectors/{id}/tool-permission?workspace= { tool, behavior } → set/clear a per-tool
  // (or connector-wide tool='*') allow|ask|deny rule. Per-tool governance = the trust plane.
  if (method === 'POST' && id && segments[2] === 'tool-permission') {
    const b = parseBody(event);
    const tool = String(b.tool || '').trim();
    if (!tool) return badRequest('tool required');
    const behavior = b.behavior == null ? null : String(b.behavior);
    if (behavior && !['allow', 'ask', 'deny'].includes(behavior)) return badRequest('behavior must be allow|ask|deny');
    const { setToolPermission } = await import('./mcp/toolPlane');
    await setToolPermission(userId, qsWorkspace, id, tool, behavior as any);
    return ok({ ok: true });
  }

  return notFound();
}

// ─── BRAIN (cross-source association graph) ──────────────────────────────────
async function handleBrain(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  if (process.env.CONNECTORS_ENABLED !== '1') return ok({ enabled: false, edges: [] });
  // MEMBERSHIP GATE (Brain P0): a SPACE's brain is shared by its members. Any GET that targets a
  // real space must be made by an owner or member; otherwise deny. (Owner of a single-user space →
  // always allowed, so existing behaviour is unchanged.) Space-scoped reads below then filter by
  // space_id alone (globally-unique), so all members see one shared brain.
  if (method === 'GET') {
    const reqSpace = event.queryStringParameters?.space || null;
    if (reqSpace && reqSpace !== ACCOUNT_SCOPE && !(await canAccessSpace(userId, getUserEmail(), reqSpace))) {
      return forbidden('You are not a member of this space.');
    }
  }
  if (method === 'GET' && segments[1] === 'edges') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    return ok({ enabled: true, edges: await getBrainEdges(userId, ws, 500, event.queryStringParameters?.space || null) });
  }

  // GET /brain/threads?space= → the THREAD LEDGER (Brain P3): the space's work as open loops with
  // state (stale/open/advancing/resolved), most-attention-first. Membership-gated above.
  if (method === 'GET' && segments[1] === 'threads') {
    const space = event.queryStringParameters?.space || null;
    if (!space || space === ACCOUNT_SCOPE) return ok({ enabled: true, threads: [] });
    const { listSpaceThreads } = await import('./connectors/threads');
    return ok({ enabled: true, threads: await listSpaceThreads(space) });
  }

  // POST /brain/rebuild?space= → wipe this space's DERIVED brain map (edges/threads/brief/atoms) and
  // rebuild it from scratch. Source items (meetings/Jira/GitHub + knowledge_graph) are KEPT. The reset
  // runs synchronously (the map clears at once); the rebuild self-invokes in the background and the UI
  // watches /brain/progress. Membership-gated. This is the "Rebuild map" button.
  if (method === 'POST' && segments[1] === 'rebuild') {
    const space = event.queryStringParameters?.space || null;
    if (!space || space === ACCOUNT_SCOPE) return badRequest('space required');
    if (!(await canAccessSpace(userId, getUserEmail(), space))) return forbidden('You are not a member of this space.');
    const { resetSpaceBrain } = await import('./connectors/brainRebuild');
    const reset = await resetSpaceBrain(space, true);
    try { const { kickBrainRebuild } = await import('./kgTrigger'); await kickBrainRebuild(space); } catch { /* cron will still rebuild */ }
    return ok({ ok: true, reset, rebuilding: true });
  }

  // POST /brain/sync?workspace= → ON-DEMAND freshness (the sync-now / open-the-app path).
  // Bounded to fit the API-GW window: pull this workspace's latest Jira/GitHub state, ingest
  // meetings, embed + fingerprint the new items, and form CHEAP links (no slow LLM verdicts —
  // those refresh on the 30-min cron). New commits/tasks + status changes appear immediately.
  if (method === 'POST' && segments[1] === 'sync') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const syncSpace = event.queryStringParameters?.space || undefined;
    // LINK-ONLY nudge (the UI's progress-bar drain): skip the heavy connector pull + just advance the
    // brain LINK + embed cursor a bit, so repeated cheap calls drain the backlog with visible progress.
    if (event.queryStringParameters?.link === '1') {
      const out: any = { embedded: 0, linked: true };
      try { const { embedKnowledgeItems } = await import('./connectors/embed'); out.embedded = (await embedKnowledgeItems(48)).embedded; } catch { /* best-effort */ }
      try { const { runBrainLink } = await import('./connectors/brainLink'); await runBrainLink({ workspaceId: ws, llmBudget: 8, timeBudgetMs: 18_000 }); } catch { /* best-effort */ }
      // EVENT-FIRST bind (Brain P2): re-bind THIS space's meetings deterministically ($0) so any
      // newly-arrived ticket/commit that references a meeting connects in this same nudge.
      if (syncSpace && syncSpace !== ACCOUNT_SCOPE) { try { const { bindSpace } = await import('./connectors/brainBind'); await bindSpace(syncSpace); } catch { /* best-effort */ } }
      return ok({ enabled: true, ...out, syncedAt: new Date().toISOString() });
    }
    const out: any = { synced: 0, ingested: 0, embedded: 0, fingerprinted: 0 };
    try {
      // FIRST recover any connector data orphaned under a deleted/account workspace → bring it into
      // THIS workspace so it sits with the meetings (and so brainLink can link them). Without this,
      // a space's historical Jira/edges/suggestions are structurally invisible to the strict reads.
      try { const { reclaimOrphanConnectorData } = await import('./spaces'); await reclaimOrphanConnectorData(userId, ws); } catch { /* best-effort */ }
      const { runConnectorSync } = await import('./connectors/sync');
      out.synced = (await runConnectorSync(ws, syncSpace)).processed;
      try { const { ingestMeetings } = await import('./connectors/meetingIngest'); out.ingested = (await ingestMeetings()).ingested; } catch { /* best-effort */ }
      try { const { fingerprintCommits } = await import('./connectors/github/enrich'); out.fingerprinted = (await fingerprintCommits(8)).fingerprinted; } catch { /* best-effort */ }
      try { const { embedKnowledgeItems } = await import('./connectors/embed'); out.embedded = (await embedKnowledgeItems(48)).embedded; } catch { /* best-effort */ }
      // Form a few verdicted links right now (incl. meeting↔meeting) so opening a space's brain
      // starts showing interconnections immediately; the rest catch up on the 30-min cron.
      try { const { runBrainLink } = await import('./connectors/brainLink'); await runBrainLink({ workspaceId: ws, llmBudget: 5, timeBudgetMs: 9000 }); } catch { /* verdicts catch up on the cron */ }
      // LAST: file the (now-linked) connector data into the right space (follow-linked-meeting),
      // so this single sync both forms the links AND scopes them to the space.
      try { const { backfillSpaceScoping } = await import('./spaces'); await backfillSpaceScoping(userId); } catch { /* best-effort */ }
      // EVENT-FIRST bind (Brain P2): the sync that INGESTED the data also ASSOCIATES it — re-bind this
      // space's meetings deterministically ($0) so freshly-pulled tickets/commits connect immediately.
      if (syncSpace && syncSpace !== ACCOUNT_SCOPE) {
        try { const { bindSpace } = await import('./connectors/brainBind'); out.bound = await bindSpace(syncSpace); } catch { /* best-effort */ }
        // THREAD LEDGER (Brain P3): refresh this space's open loops after binding (state reads lineage).
        try { const { buildSpaceThreads } = await import('./connectors/threads'); out.threads = await buildSpaceThreads(syncSpace); } catch { /* best-effort */ }
      }
    } catch (err: any) {
      console.error('brain_sync_now_failed', JSON.stringify({ message: err?.message }));
    }
    return ok({ enabled: true, ...out, syncedAt: new Date().toISOString() });
  }

  // GET /brain/progress?workspace=[&space=] → brain BUILD progress for the UI bar. An item is
  // "processed" once it's LINKED (brain_link_state fresh ≥ its synced_at); a meeting's SUGGESTIONS
  // are processed once it's been reasoned over. Drives the progress bar + tells the UI to keep
  // nudging the drain until pending = 0 (so no meeting / connector node is ever left unprocessed).
  if (method === 'GET' && segments[1] === 'progress') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const space = event.queryStringParameters?.space || null;
    const bySpace = !!space && space !== ACCOUNT_SCOPE;
    const col = bySpace ? 'space_id' : 'workspace_id';     // controlled set — safe to interpolate
    const scopeVal = bySpace ? space : ws;
    const graph = await queryOne<{ total: number; linked: number }>(
      `SELECT COUNT(*)::int AS total,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM brain_link_state s
                 WHERE s.item_id = k.id AND s.linked_at >= k.synced_at))::int AS linked
         FROM knowledge_item k WHERE k.user_id=$1 AND k.${col}=$2`,
      [userId, scopeVal],
    ).catch(() => null);
    const sugg = await queryOne<{ meetings: number; reasoned: number }>(
      `SELECT COUNT(*)::int AS meetings,
              COUNT(*) FILTER (WHERE EXISTS (SELECT 1 FROM suggestion_reasoned r
                 WHERE r.meeting_id = th.id::text AND r.user_id = th.user_id))::int AS reasoned
         FROM task_history th WHERE th.user_id=$1 AND th.${col}=$2`,
      [userId, scopeVal],
    ).catch(() => null);
    const total = graph?.total ?? 0, linked = graph?.linked ?? 0;
    const meetings = sugg?.meetings ?? 0, reasoned = sugg?.reasoned ?? 0;
    const graphPending = Math.max(0, total - linked);
    const suggPending = Math.max(0, meetings - reasoned);
    // MEANING-LAYER health (CF-4): expose whether the LLM/embedding layer is degraded (e.g. provider
    // credits depleted) + the user's daily brain-budget headroom. The DETERMINISTIC build above never
    // stops; this tells the UI to show "connections are being enriched" vs "enrichment paused".
    const { getLlmHealth, checkBrainBudget } = await import('./connectors/budget');
    const health = await getLlmHealth().catch(() => ({ status: 'ok', providers: [] }));
    const bud = await checkBrainBudget(userId).catch(() => null);
    return ok({
      graph: { total, processed: linked, pending: graphPending },
      suggestions: { total: meetings, processed: reasoned, pending: suggPending },
      pct: total ? Math.round((linked / total) * 100) : 100,
      processing: graphPending > 0 || suggPending > 0,
      meaning: {
        status: health.status,                              // 'ok' | 'degraded' | 'down'
        providers: health.providers,
        note: health.status === 'ok' ? null : 'The meaning layer (AI enrichment) is paused; deterministic connections are unaffected.',
        budget: bud ? { spentToday: bud.spentToday, dailyLimit: bud.dailyLimit, remaining: bud.remaining, exhausted: !bud.allowed && !bud.unlimited } : null,
      },
    });
  }

  // GET /brain/alerts?workspace= → the leader-facing OFF-TRACK digest: code that diverged
  // from what was decided, risky commits, and tasks stuck in progress. The "is anything wrong?"
  // view for a CEO/lead.
  if (method === 'GET' && segments[1] === 'alerts') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    // Optional folder (project) OR space scope: present → just that project/space; absent →
    // whole workspace. `$3::uuid IS NULL OR <col>=$3` serves both (null = aggregate). Folder
    // takes precedence; otherwise scope by the meeting's space_id. (Column name is chosen from
    // a fixed allow-list below, never user input.)
    const folder = event.queryStringParameters?.folder || null;
    const space = event.queryStringParameters?.space || null;
    const scopeId = folder || space || null;
    const sc = folder ? 'folder_id' : 'space_id';   // which column $3 filters on
    const alerts: any[] = [];
    // 1) Divergent work — a commit/PR went a different direction than the meeting/task intended.
    const diverged = await query<any>(
      `SELECT di.title impl, di.links->>'url' url, e.rationale, si.title intent
         FROM brain_edge e JOIN knowledge_item si ON si.id::text=e.src_id JOIN knowledge_item di ON di.id::text=e.dst_id
        WHERE e.user_id=$1 AND e.workspace_id=$2 AND e.verdict='divergent'
          AND ($3::uuid IS NULL OR di.${sc}=$3 OR si.${sc}=$3) ORDER BY e.created_at DESC LIMIT 15`,
      [userId, ws, scopeId],
    ).catch(() => []);
    for (const d of diverged) alerts.push({ type: 'divergent', severity: 'high', title: d.impl, detail: d.rationale || `Diverges from "${d.intent}"`, intent: d.intent, url: d.url ?? null });
    // 2) Risky commits — the co-architect flagged an architectural risk.
    const risky = await query<any>(
      `SELECT title, advisory_assessment, advisory_note, links->>'url' url FROM knowledge_item
        WHERE user_id=$1 AND workspace_id=$2 AND advisory_assessment IN ('risk','concern')
          AND ($3::uuid IS NULL OR ${sc}=$3) ORDER BY (advisory_assessment='risk') DESC, synced_at DESC LIMIT 20`,
      [userId, ws, scopeId],
    ).catch(() => []);
    for (const r of risky) alerts.push({ type: r.advisory_assessment === 'risk' ? 'risk' : 'concern', severity: r.advisory_assessment === 'risk' ? 'high' : 'low', title: r.title, detail: r.advisory_note || 'Architectural attention suggested', url: r.url ?? null });
    // 3) + 4) Stalled work + untracked decisions — for a SPACE view these are now read from the
    //    THREAD LEDGER (Brain P3.2), the single source of truth for work state, instead of recomputed
    //    heuristics. (Folder/workspace-aggregate views fall back to the heuristics below.)
    if (space && !folder) {
      const staleTickets = await query<any>(
        `SELECT title, evidence FROM brain_thread WHERE space_id=$1 AND kind='ticket' AND state='stale'
          ORDER BY updated_at DESC LIMIT 15`, [space],
      ).catch(() => []);
      for (const s of staleTickets) alerts.push({ type: 'stalled', severity: 'medium', title: s.title, detail: `Stuck in "${s.evidence?.status || 'in progress'}" — no movement in over a week`, url: null });
      const gaps = await query<any>(
        `SELECT title, evidence FROM brain_thread WHERE space_id=$1 AND kind='gap' AND state IN ('open','stale')
          ORDER BY (state='stale') DESC, updated_at DESC LIMIT 15`, [space],
      ).catch(() => []);
      for (const g of gaps) alerts.push({ type: 'untracked', severity: 'medium', title: g.title, detail: `Had ${g.evidence?.actionCount || 0} action item(s) / ${g.evidence?.decisionCount || 0} decision(s) but no Jira task exists`, url: null });
    } else {
      const stalled = await query<any>(
        `SELECT title, status, occurred_at, links->>'url' url FROM knowledge_item
          WHERE user_id=$1 AND workspace_id=$2 AND source='jira' AND status ~* 'progress|review|doing'
            AND occurred_at < NOW() - INTERVAL '7 days'
            AND ($3::uuid IS NULL OR ${sc}=$3) ORDER BY occurred_at ASC LIMIT 15`,
        [userId, ws, scopeId],
      ).catch(() => []);
      for (const s of stalled) alerts.push({ type: 'stalled', severity: 'medium', title: s.title, detail: `Stuck in "${s.status}" since ${new Date(s.occurred_at).toISOString().slice(0, 10)}`, url: s.url ?? null });
      const untracked = await query<any>(
        `SELECT ki.title, ki.occurred_at,
                jsonb_array_length(COALESCE(kg.action_items, '[]'::jsonb)) ai,
                jsonb_array_length(COALESCE(kg.decisions, '[]'::jsonb)) dec
           FROM knowledge_item ki
           JOIN knowledge_graph kg ON kg.task_id::text = ki.source_id AND kg.user_id = ki.user_id
          WHERE ki.user_id=$1 AND ki.workspace_id=$2 AND ki.source='meeting'
            AND ki.occurred_at < NOW() - INTERVAL '7 days'
            AND ($3::uuid IS NULL OR ki.${sc}=$3)
            AND (jsonb_array_length(COALESCE(kg.action_items, '[]'::jsonb)) > 0 OR jsonb_array_length(COALESCE(kg.decisions, '[]'::jsonb)) > 0)
            AND NOT EXISTS (
              SELECT 1 FROM brain_edge e JOIN knowledge_item ji ON ji.id::text = e.dst_id
               WHERE e.user_id=ki.user_id AND e.workspace_id=ki.workspace_id AND e.src_id = ki.id::text AND ji.source='jira')
          ORDER BY ki.occurred_at DESC LIMIT 15`,
        [userId, ws, scopeId],
      ).catch(() => []);
      for (const u of untracked) alerts.push({ type: 'untracked', severity: 'medium', title: u.title, detail: `Had ${u.ai} action item(s) / ${u.dec} decision(s) but no Jira task exists — decided ${new Date(u.occurred_at).toISOString().slice(0, 10)}`, url: null });
    }
    return ok({ enabled: true, alerts });
  }

  // GET /brain/pulse?workspace= → the who-did-what-when activity feed (recent observed events).
  if (method === 'GET' && segments[1] === 'pulse') {
    const ws = event.queryStringParameters?.workspace;
    if (!ws) return badRequest('workspace required');
    const { getEvents } = await import('./connectors/brainEvents');
    // Strict (workspace + space): each event carries its own space_id, so a space's Activity
    // shows only that space's connector + meeting activity. `folder` narrows to one project.
    const events = await getEvents(userId, ws, 40, event.queryStringParameters?.folder || null, event.queryStringParameters?.space || null);
    return ok({ enabled: true, events: events.map((e) => ({ kind: e.kind, source: e.source, sourceId: e.source_id, actor: e.actor, from: e.from_state, to: e.to_state, title: e.title, at: e.occurred_at })) });
  }
  // GET /brain/node?workspace=&id=item:123 → the full info card for one node: its content
  // (for commits, the diff-grounded summary) + every reasoned connection (relation, verdict,
  // rationale) so the brain map can show rich detail like the knowledge graph — not just a link.
  if (method === 'GET' && segments[1] === 'node') {
    const ws = event.queryStringParameters?.workspace;
    const nodeSpace = event.queryStringParameters?.space || null;
    const rawId = (event.queryStringParameters?.id || '').replace(/^item:/, '');
    if (!ws || !rawId || !/^\d+$/.test(rawId)) return badRequest('workspace + numeric id required');
    // STRICTLY (workspace + space)-scoped: the node, its timeline and its connections all belong
    // to the same space the brain map is showing.
    // SPACE view (Brain P0): the node + its timeline + connections scope by space_id (shared brain;
    // membership gated above). Root view stays owner-scoped.
    const bySpace = !!nodeSpace && nodeSpace !== ACCOUNT_SCOPE;
    const STATUS_SUB = `(SELECT k2.status FROM knowledge_item k2 WHERE k2.user_id=ki.user_id AND k2.source=ki.source AND k2.source_id=ki.source_id AND k2.status IS NOT NULL ORDER BY k2.synced_at DESC NULLS LAST LIMIT 1)`;
    const NODE_COLS = `ki.id, ki.source, ki.type, ki.title, ki.body, ki.enriched_summary, ki.fingerprint, ki.people, ki.links, ki.source_id, ki.occurred_at, ${STATUS_SUB} AS status, ki.advisory_assessment, ki.advisory_note`;
    const node = await queryOne<any>(
      bySpace
        ? `SELECT ${NODE_COLS} FROM knowledge_item ki WHERE ki.space_id=$1 AND ki.id=$2`
        : `SELECT ${NODE_COLS} FROM knowledge_item ki WHERE ki.user_id=$1 AND ki.workspace_id=$2 AND ($4::uuid IS NULL OR ki.space_id=$4) AND ki.id=$3`,
      bySpace ? [nodeSpace, rawId] : [userId, ws, rawId, nodeSpace],
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
    // Timeline of observed changes — by the issue's (source, source_id) across ALL its duplicate
    // rows (not just this row's item_id), deduped, so it shows the FULL history incl. the latest
    // transition even when the clicked copy is in a stale space.
    const events = await query<any>(
      `SELECT d.kind, d.actor, d.from_state, d.to_state, d.occurred_at FROM (
         SELECT DISTINCT ON (e.kind, e.to_state, e.occurred_at) e.kind, e.actor, e.from_state, e.to_state, e.occurred_at, e.created_at
           FROM brain_event e
          WHERE ${bySpace ? 'e.space_id=$1' : 'e.user_id=$1'} AND e.source=$2 AND e.source_id=$3
          ORDER BY e.kind, e.to_state, e.occurred_at, e.created_at DESC
       ) d ORDER BY d.occurred_at DESC NULLS LAST LIMIT 12`,
      [bySpace ? nodeSpace : userId, node.source, node.source_id],
    ).catch(() => []);
    const edges = await neighboursOf(userId, ws, 'item', rawId, 40, nodeSpace).catch(() => []);
    // Resolve the OTHER end of each edge to a real item (title/source/url), keep the reasoning.
    const otherIds = Array.from(new Set(edges.map((e) => (e.src_id === rawId ? e.dst_id : e.src_id)).filter((x) => /^\d+$/.test(x))));
    const others = otherIds.length ? await query<any>(
      bySpace
        ? `SELECT id, source, type, title, source_id, links FROM knowledge_item WHERE space_id=$1 AND id = ANY($2::bigint[])`
        : `SELECT id, source, type, title, source_id, links FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND ($4::uuid IS NULL OR space_id=$4) AND id = ANY($3::bigint[])`,
      bySpace ? [nodeSpace, otherIds] : [userId, ws, otherIds, nodeSpace],
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
    const space = event.queryStringParameters?.space || null;
    // STRICTLY (workspace + space)-scoped — NO neighbour expansion (that leaked other spaces'
    // items in). A SPACE view = every item tagged to the space; a FOLDER view narrows to that
    // folder WITHIN its space; absent both = the whole-workspace aggregate. Connector items now
    // carry their space, so a plain space_id filter shows the full picture with zero cross-space leak.
    let viewSpace = space;
    if (folder && !space) {
      const f = await queryOne<{ space_id: string | null }>(`SELECT space_id FROM folders WHERE id=$1`, [folder]).catch(() => null);
      viewSpace = f?.space_id ?? null;
    }
    // `status` = the FRESHEST status across ALL copies of this issue (the same Jira issue can have
    // duplicate rows across spaces / a drifted workspace_id; only the connected copy is sync-fresh).
    // The correlated subquery makes a node show the LIVE status even when the viewed space holds a
    // stale copy — without touching rows or edge ids. (user-scoped → tenant-safe.)
    const FRESH_STATUS = `(SELECT k2.status FROM knowledge_item k2 WHERE k2.user_id=ki.user_id AND k2.source=ki.source AND k2.source_id=ki.source_id AND k2.status IS NOT NULL ORDER BY k2.synced_at DESC NULLS LAST LIMIT 1)`;
    // SPACE view (Brain P0): scope by space_id ALONE → nodes from ALL members of the space (shared
    // brain; membership gated above). Root/workspace view stays owner-scoped.
    const bySpace = !!viewSpace && viewSpace !== ACCOUNT_SCOPE;
    const items = (folder || space)
      ? await query<any>(
          bySpace
            ? `SELECT ki.id, ki.source, ki.type, ki.title, ki.source_id, ki.links, ${FRESH_STATUS} AS status FROM knowledge_item ki
                WHERE ki.space_id=$1 AND ($2::uuid IS NULL OR ki.folder_id=$2) LIMIT 2000`
            : `SELECT ki.id, ki.source, ki.type, ki.title, ki.source_id, ki.links, ${FRESH_STATUS} AS status FROM knowledge_item ki
                WHERE ki.user_id=$1 AND ki.workspace_id=$2 AND ($3::uuid IS NULL OR ki.space_id=$3) AND ($4::uuid IS NULL OR ki.folder_id=$4) LIMIT 2000`,
          bySpace ? [viewSpace, folder] : [userId, ws, viewSpace, folder],
        ).catch(() => [])
      : await query<any>(
          `SELECT ki.id, ki.source, ki.type, ki.title, ki.source_id, ki.links, ${FRESH_STATUS} AS status FROM knowledge_item ki
            WHERE ki.user_id=$1 AND ki.workspace_id=$2 LIMIT 2000`,
          [userId, ws],
        ).catch(() => []);
    const nodes: any[] = items.map((i: any) => ({ id: `item:${i.id}`, kind: 'item', source: i.source, source_id: i.source_id, type: i.type, title: i.title || i.source_id, url: i.links?.url ?? null, status: i.status ?? null }));
    // Edges: strictly scoped to the view's SPACE; the client also drops any edge whose endpoints
    // aren't both visible nodes, so only intra-scope lineage renders.
    const edges = await getBrainEdges(userId, ws, 1500, viewSpace);
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
    // Strictly (workspace + space)-scoped: a space shows only ITS suggestions.
    const proposals = await listPendingProposals(userId, ws, event.queryStringParameters?.space || null);
    // Coverage: how many of THIS SPACE's meetings the engine has reasoned over (no silent caps).
    const { getSuggestionCoverage } = await import('./connectors/suggestionCoverage');
    const coverage = await getSuggestionCoverage(userId, ws, event.queryStringParameters?.space || null).catch(() => ({ reasoned: 0, total: 0 }));
    return ok({ enabled: true, proposals, coverage });
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
    // W1: scope the knowledge graph to the active workspace (join task_history's
    // workspace partition), so KG-driven features see only the active vault.
    const kgWorkspaceId = await activeWorkspaceId(event, userId, getUserEmail());
    const rows = await query(
      `SELECT kg.* FROM knowledge_graph kg
         JOIN task_history th ON th.id = kg.task_id
        WHERE kg.user_id=$1 AND th.workspace_id=$2
        ORDER BY kg.created_at DESC`,
      [userId, kgWorkspaceId],
    );
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
    _chatSchemaReady = query('ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS workspace_id TEXT')
      // `trace` persists the agentic loop's thought-process timeline (tool calls + plan) so it
      // survives a reload, exactly like agent_plan/retrieval_meta.
      .then(() => query('ALTER TABLE chat_history ADD COLUMN IF NOT EXISTS trace JSONB'))
      .then(() => {});
  }
  return _chatSchemaReady;
}

async function handleChat(method: string, userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters || {};
  await ensureChatSchema();

  if (method === 'POST') {
    const body = parseBody(event);
    const messages = Array.isArray(body) ? body : [body];
    // W2: every chat message belongs to a workspace. An explicit workspace_id (the
    // workspace chat surface) wins; otherwise the all-meetings chat is stamped with
    // the ACTIVE workspace from the header — so chat history is per-vault.
    const chatWorkspaceId = await activeWorkspaceId(event, userId, getUserEmail());
    const results: any[] = [];
    for (const m of messages) {
      const row = await queryOne(
        `INSERT INTO chat_history (user_id, task_id, role, text, image, thread_id, citations, retrieval_meta, agent_status, agent_plan, workspace_id, trace)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
        [userId, m.task_id || null, m.role, m.text, m.image || null, m.thread_id || null,
         JSON.stringify(m.citations || []), JSON.stringify(m.retrieval_meta || {}),
         m.agent_status || null, JSON.stringify(m.agent_plan || []), m.workspace_id || chatWorkspaceId,
         m.trace ? JSON.stringify(m.trace) : null]
      );
      results.push(row);
    }
    return Array.isArray(body) ? ok(results) : ok(results[0]);
  }

  if (method === 'GET') {
    // Durable thread list derived from chat_history — so the chat history is
    // reliable even if the client's localStorage thread index is lost.
    if (qs.threads) {
      // W2: chat threads are ALWAYS workspace-scoped. An explicit workspaceId (the
      // workspace chat surface) wins; otherwise the all-meetings thread list is the
      // ACTIVE workspace's threads (from the header).
      const threadsWorkspaceId = qs.workspaceId || await activeWorkspaceId(event, userId, getUserEmail());
      const scope = 'ch.workspace_id = $2';
      const params = [userId, threadsWorkspaceId];
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

    // `key` lets a caller reference the object WITHOUT it being publicly readable —
    // meeting audio is handed to the transcription provider as a short-lived
    // presigned GET (see /ai/soniox-transcribe), never as a public URL.
    return ok({ uploadUrl, publicUrl, key });
  }

  return notFound();
}

// ─── BOOTSTRAP ───────────────────────────────────────────────────────────────
// One request that returns everything the app needs on launch: the first page
// of history, the workspace membership index, the chat-thread list, and the
// ledger. Collapses ~6 cold-start round-trips into a single Lambda invoke —
// dramatically faster first paint on slow networks, and cheaper (fewer invokes).
async function handleBootstrap(userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const pageSize = 24;
  await ensureChatSchema(); // workspace_id column referenced below
  // W0: guarantee a default workspace exists for this user and that every existing
  // recording is partitioned into a workspace (idempotent + guarded).
  const defaultWsId = await ensureWorkspacePartition(userId, getUserEmail());
  // Spaces layer: turn the user's top-level folders into real SPACES (one-time) and
  // guarantee a default "My notes" private space.
  await migrateFoldersToSpacesOnce(userId, defaultWsId);
  // Self-healing: every workspace has a default space and no note sits directly under
  // a workspace (idempotent — catches users whose one-time migration already ran).
  await reconcileSpaces(userId, defaultWsId);
  // Recover connector data the migration orphaned under deleted/account workspaces → the default
  // workspace (so it sits with the meetings), then file it into the right space. Strictly scoped.
  try {
    const { reclaimOrphanConnectorData, backfillSpaceScoping } = await import('./spaces');
    await reclaimOrphanConnectorData(userId, defaultWsId);
    await backfillSpaceScoping(userId);
  } catch { /* best-effort */ }
  // W1: the first page of history is scoped to the ACTIVE workspace (vault). The
  // workspaces list below is still the FULL set so the switcher can show all vaults.
  const bootWorkspaceId = await activeWorkspaceId(event, userId, getUserEmail());
  const [taskRows, taskTotal, workspaces, folders, taskWorkspaces, taskFolders, threads, ledger, userPlan] = await Promise.all([
    query('SELECT id, created_at, filename, summary, status, duration, attendees, space_id, folder_id FROM task_history WHERE user_id=$1 AND workspace_id=$2 ORDER BY created_at DESC LIMIT $3', [userId, bootWorkspaceId, pageSize]),
    queryCount('SELECT COUNT(*) FROM task_history WHERE user_id=$1 AND workspace_id=$2', [userId, bootWorkspaceId]),
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
       WHERE ch.user_id=$1 AND ch.workspace_id=$2 AND ch.thread_id IS NOT NULL
       GROUP BY ch.thread_id, ch.task_id, th.filename
       ORDER BY MAX(ch.created_at) DESC
       LIMIT 200`,
      [userId, bootWorkspaceId],
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
    await ensureWorkspacePartitionSchema(); // parent_id column (space→folder nesting)
    const row = await queryOne(
      `INSERT INTO folders
         (workspace_id, user_id, name, emoji, color, description, icon_type, icon_name, favorite, parent_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [
        workspaceId, userId, body.name.trim(),
        body.emoji ?? null,
        body.color ?? null,
        body.description ?? '',
        body.icon_type ?? body.iconType ?? 'icon',
        body.icon_name ?? body.iconName ?? null,
        body.favorite === true,
        // A child folder's parent must belong to THIS workspace (vault boundary).
        body.parent_id ?? null,
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

// ─── SPACES ──────────────────────────────────────────────────────────────────
// A space is a membership-scoped grouping inside the active workspace; it contains
// folders. Every op is scoped to the caller (vault boundary).
async function handleSpaces(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  await ensureSpacesSchema();
  // Path is `spaces/{id}/{sub}/{subId}` with NO leading empty segment (segments[0]
  // is the resource), matching every other handler (taskId = segments[1]).
  const spaceId = segments[1];
  const sub = segments[2];
  const workspaceId = await activeWorkspaceId(event, userId, getUserEmail());

  // List the active workspace's spaces with folder + member counts.
  if (method === 'GET' && !spaceId) {
    const spaces = await query<any>(
      'SELECT * FROM spaces WHERE workspace_id=$1 AND user_id=$2 ORDER BY is_default DESC, created_at ASC',
      [workspaceId, userId],
    );
    const out = [];
    for (const s of spaces) {
      const folder_count = await queryCount('SELECT COUNT(*) FROM folders WHERE space_id=$1', [s.id]);
      const member_count = await queryCount('SELECT COUNT(*) FROM space_members WHERE space_id=$1', [s.id]);
      out.push({ ...s, folder_count, member_count });
    }
    return ok(out);
  }

  // Create a space (optionally with members) in the active workspace.
  if (method === 'POST' && !spaceId) {
    const body = parseBody(event);
    if (!body.name?.trim()) return badRequest('name is required');
    const row = await queryOne<any>(
      'INSERT INTO spaces (workspace_id, user_id, name, emoji, color, shared_all) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [workspaceId, userId, body.name.trim(), body.emoji ?? null, body.color ?? null, body.shared_all === true],
    );
    if (Array.isArray(body.members)) {
      for (const m of body.members) {
        if (typeof m === 'string' && m.trim()) {
          await query('INSERT INTO space_members (space_id, email) VALUES ($1,$2) ON CONFLICT DO NOTHING', [row!.id, m.trim().toLowerCase()]);
        }
      }
    }
    return created(row);
  }

  // Ownership guard for space-specific operations (vault boundary).
  const space = spaceId ? await queryOne<any>('SELECT * FROM spaces WHERE id=$1 AND user_id=$2', [spaceId, userId]) : null;
  if (spaceId && !space) return notFound();

  if (method === 'GET' && spaceId && sub === 'folders') {
    return ok(await query('SELECT * FROM folders WHERE space_id=$1 ORDER BY created_at ASC', [spaceId]));
  }

  // Meetings filed directly in this space (user-scoped defense-in-depth).
  if (method === 'GET' && spaceId && sub === 'meetings') {
    return ok(await query(
      'SELECT id, filename, created_at, duration, status, summary FROM task_history WHERE user_id=$1 AND space_id=$2 ORDER BY created_at DESC',
      [userId, spaceId],
    ));
  }

  // Move a note INTO this space (optionally into a folder within it). Stamps the
  // note's space_id/folder_id; user-scoped so you can only move your own notes.
  if (method === 'POST' && spaceId && sub === 'meetings') {
    const body = parseBody(event);
    if (!body.task_id) return badRequest('task_id is required');
    // Stamp the space's PARENT workspace too — note lists (history, brain, all-notes
    // chat) partition by workspace_id, so a note moved into a space in another
    // workspace would otherwise be stranded in its old workspace partition.
    await query(
      'UPDATE task_history SET workspace_id=$1, space_id=$2, folder_id=$3 WHERE id=$4 AND user_id=$5',
      [space.workspace_id, spaceId, body.folder_id ?? null, body.task_id, userId],
    );
    return ok({ ok: true });
  }

  if (method === 'POST' && spaceId && sub === 'folders') {
    const body = parseBody(event);
    if (!body.name?.trim()) return badRequest('name is required');
    const row = await queryOne(
      `INSERT INTO folders (workspace_id, user_id, name, emoji, color, description, icon_type, icon_name, favorite, space_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
      [space.workspace_id, userId, body.name.trim(), body.emoji ?? null, body.color ?? null, body.description ?? '',
       body.icon_type ?? body.iconType ?? 'icon', body.icon_name ?? body.iconName ?? null, body.favorite === true, spaceId],
    );
    return created(row);
  }

  if (method === 'GET' && spaceId && sub === 'members') {
    return ok(await query('SELECT * FROM space_members WHERE space_id=$1 ORDER BY invited_at ASC', [spaceId]));
  }

  if (method === 'POST' && spaceId && sub === 'members') {
    const body = parseBody(event);
    if (!body.email?.trim()) return badRequest('email is required');
    await query('INSERT INTO space_members (space_id, email, role) VALUES ($1,$2,$3) ON CONFLICT (space_id,email) DO NOTHING',
      [spaceId, body.email.trim().toLowerCase(), body.role || 'viewer']);
    return ok({ ok: true });
  }

  if (method === 'DELETE' && spaceId && sub === 'members') {
    const email = decodeURIComponent(segments[3] || '');
    await query('DELETE FROM space_members WHERE space_id=$1 AND lower(email)=lower($2)', [spaceId, email]);
    return noContent();
  }

  if (method === 'PUT' && spaceId && !sub) {
    const body = parseBody(event);
    const row = await queryOne(
      'UPDATE spaces SET name=COALESCE($1,name), emoji=COALESCE($2,emoji), color=COALESCE($3,color), updated_at=now() WHERE id=$4 RETURNING *',
      [body.name?.trim() || null, body.emoji || null, body.color || null, spaceId],
    );
    return ok(row);
  }

  if (method === 'DELETE' && spaceId && !sub) {
    if (space.is_default) return badRequest('The default space cannot be deleted');
    // Orphan the space's folders + meetings back to the workspace root (never delete data).
    await query('UPDATE folders SET space_id=NULL WHERE space_id=$1', [spaceId]);
    await query('UPDATE task_history SET space_id=NULL, folder_id=NULL WHERE space_id=$1 AND user_id=$2', [spaceId, userId]);
    await query('DELETE FROM spaces WHERE id=$1', [spaceId]); // cascades space_members
    return noContent();
  }

  return notFound();
}

// ─── DICTIONARY (custom vocabulary → transcription accuracy) ─────────────────
// Per-USER (account-level). GET returns the user's own entries PLUS entries teammates shared
// into a workspace this user belongs to. Mutations are guarded by user_id ownership.
async function handleDictionary(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  await ensureDictionarySchema();
  const entryId = segments[1];
  const email = getUserEmail();
  const COLS = 'id, user_id, workspace_id, term, misspelling, shared, created_at';

  if (method === 'GET' && !entryId) {
    const rows = await query(
      `SELECT ${COLS} FROM dictionary
        WHERE user_id=$1
           OR (shared=true AND workspace_id IN (
                SELECT id FROM workspaces WHERE user_id=$1
                UNION SELECT workspace_id FROM workspace_members WHERE lower(email)=lower($2)))
        ORDER BY created_at DESC`,
      [userId, email],
    );
    return ok(rows);
  }

  if (method === 'POST' && !entryId) {
    const body = parseBody(event);
    const term = (body.term ?? '').trim();
    if (!term) return badRequest('term is required');
    const misspelling = (body.misspelling ?? '').trim() || null;
    const shared = body.shared === true;
    const wsId = shared ? await activeWorkspaceId(event, userId, email) : null;
    const row = await queryOne(
      `INSERT INTO dictionary (user_id, workspace_id, term, misspelling, shared)
       VALUES ($1,$2,$3,$4,$5) RETURNING ${COLS}`,
      [userId, wsId, term, misspelling, shared],
    );
    return created(row);
  }

  // Ownership guard — a user can only edit/delete their OWN entries.
  const entry = entryId ? await queryOne<{ id: string }>('SELECT id FROM dictionary WHERE id=$1 AND user_id=$2', [entryId, userId]) : null;
  if (entryId && !entry) return notFound();

  if (method === 'PUT' && entryId) {
    const body = parseBody(event);
    const shared = typeof body.shared === 'boolean' ? body.shared : null;
    const wsId = body.shared === true ? await activeWorkspaceId(event, userId, email) : null;
    const row = await queryOne(
      `UPDATE dictionary SET
         term = COALESCE($1, term),
         misspelling = COALESCE($2, misspelling),
         shared = COALESCE($3, shared),
         workspace_id = CASE WHEN $3 = true THEN $4 WHEN $3 = false THEN NULL ELSE workspace_id END,
         updated_at = now()
       WHERE id=$5 RETURNING ${COLS}`,
      [
        body.term?.trim() || null,
        body.misspelling !== undefined ? ((body.misspelling ?? '').trim() || null) : null,
        shared, wsId, entryId,
      ],
    );
    return ok(row);
  }

  if (method === 'DELETE' && entryId) {
    await query('DELETE FROM dictionary WHERE id=$1 AND user_id=$2', [entryId, userId]);
    return noContent();
  }

  return notFound();
}

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
         favorite    = COALESCE($7,favorite),
         space_id    = COALESCE($8,space_id)
       WHERE id=$9 RETURNING *`,
      [
        body.name?.trim() || null,
        body.emoji ?? null,
        body.color ?? null,
        body.description ?? null,
        body.icon_type ?? body.iconType ?? null,
        body.icon_name ?? body.iconName ?? null,
        typeof body.favorite === 'boolean' ? body.favorite : null,
        body.space_id ?? null, // move this folder into a space
        folderId,
      ]
    );
    return ok(row);
  }

  if (method === 'GET' && sub === 'meetings') {
    // Canonical filing is task_history.folder_id; also union the legacy task_folders
    // M:N so notes filed under the old model still surface. User-scoped throughout so
    // a foreign task_id placed in this folder can never be read back.
    const rows = await query(
      `SELECT th.id, th.filename, th.created_at, th.duration, th.status, th.summary
       FROM task_history th
       WHERE th.user_id=$2 AND (
         th.folder_id=$1
         OR th.id IN (SELECT task_id FROM task_folders WHERE folder_id=$1)
       )
       ORDER BY th.created_at DESC`,
      [folderId, userId]
    );
    return ok(rows);
  }

  if (method === 'POST' && sub === 'meetings') {
    const body = parseBody(event);
    if (!body.task_id) return badRequest('task_id is required');
    // SECURITY: only act if the caller OWNS the task being added. Stamp the canonical
    // task_history.folder_id (+ the folder's space) so the note shows in the folder
    // and space views; keep the legacy task_folders row for back-compat.
    await query(
      `UPDATE task_history SET folder_id=$2, space_id=COALESCE($3, space_id)
       WHERE id=$1 AND user_id=$4`,
      [body.task_id, folderId, (folder as any).space_id ?? null, userId]
    );
    await query(
      `INSERT INTO task_folders (task_id, folder_id)
       SELECT $1,$2 WHERE EXISTS (SELECT 1 FROM task_history WHERE id=$1 AND user_id=$3)
       ON CONFLICT DO NOTHING`,
      [body.task_id, folderId, userId]
    );
    return noContent();
  }

  if (method === 'DELETE' && sub === 'meetings' && subId) {
    // Unfile from both the canonical column and the legacy M:N (user-scoped).
    await query('UPDATE task_history SET folder_id=NULL WHERE id=$1 AND user_id=$2', [subId, userId]);
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
