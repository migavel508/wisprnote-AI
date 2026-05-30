import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { CognitoJwtVerifier } from 'aws-jwt-verify';
import { query, queryOne, queryCount } from './db';
import { ok, created, noContent, badRequest, notFound, unauthorized, serverError, corsPreflightResponse } from './response';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getSecrets } from './secrets';
import { handleAI } from './ai';

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
      case 'contacts':   return await handleContacts(method, userId);
      case 'ai':         return await handleAI(method, segments, event);
      default:           return notFound();
    }
  } catch (err: any) {
    if (err.message === 'UNAUTHORIZED') return unauthorized();
    console.error('Handler error:', err);
    return serverError(err.message || 'Internal server error');
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
    const row = await queryOne(
      `INSERT INTO task_history (user_id, filename, transcription, summary, notes, audio_url, status, duration, prompt, personal_note, visualization_image, attendees)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [userId, body.filename, body.transcription, body.summary, body.notes, body.audio_url, body.status, body.duration || 0, body.prompt, body.personal_note, body.visualization_image, JSON.stringify(body.attendees ?? [])]
    );
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

async function handleChat(method: string, userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const qs = event.queryStringParameters || {};

  if (method === 'POST') {
    const body = parseBody(event);
    const messages = Array.isArray(body) ? body : [body];
    const results: any[] = [];
    for (const m of messages) {
      const row = await queryOne(
        `INSERT INTO chat_history (user_id, task_id, role, text, image, thread_id, citations, retrieval_meta, agent_status, agent_plan)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [userId, m.task_id || null, m.role, m.text, m.image || null, m.thread_id || null,
         JSON.stringify(m.citations || []), JSON.stringify(m.retrieval_meta || {}),
         m.agent_status || null, JSON.stringify(m.agent_plan || [])]
      );
      results.push(row);
    }
    return Array.isArray(body) ? ok(results) : ok(results[0]);
  }

  if (method === 'GET') {
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

  const fields = ['filename', 'created_at', 'duration'];
  if (share.permissions.includes('summary')) fields.push('summary');
  if (share.permissions.includes('notes')) fields.push('notes');

  const task = await queryOne(`SELECT ${fields.join(',')} FROM task_history WHERE id=$1`, [share.task_id]);
  if (!task) return ok({ denied: true, reason: 'The shared meeting could not be found.' });

  return ok({
    meeting: {
      filename: task.filename,
      summary: task.summary ?? null,
      notes: task.notes ?? null,
      created_at: task.created_at ?? null,
      duration: task.duration ?? 0,
      permissions: share.permissions,
    },
    share,
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

// ─── WORKSPACES ──────────────────────────────────────────────────────────────

async function handleWorkspaces(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const workspaceId = segments[1];
  const sub = segments[2]; // 'folders' | 'meetings' | 'members'
  const subId = segments[3];

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
    const rows = await query(
      `SELECT th.id, th.filename, th.created_at, th.duration, th.status, th.summary
       FROM task_workspaces tw JOIN task_history th ON th.id=tw.task_id
       WHERE tw.workspace_id=$1 ORDER BY tw.added_at DESC`,
      [workspaceId]
    );
    return ok(rows);
  }

  if (method === 'POST' && sub === 'meetings') {
    const body = parseBody(event);
    if (!body.task_id) return badRequest('task_id is required');
    await query('INSERT INTO task_workspaces (task_id, workspace_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [body.task_id, workspaceId]);
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
    const rows = await query(
      `SELECT th.id, th.filename, th.created_at, th.duration, th.status, th.summary
       FROM task_folders tf JOIN task_history th ON th.id=tf.task_id
       WHERE tf.folder_id=$1 ORDER BY tf.added_at DESC`,
      [folderId]
    );
    return ok(rows);
  }

  if (method === 'POST' && sub === 'meetings') {
    const body = parseBody(event);
    if (!body.task_id) return badRequest('task_id is required');
    await query('INSERT INTO task_folders (task_id, folder_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [body.task_id, folderId]);
    return noContent();
  }

  if (method === 'DELETE' && sub === 'meetings' && subId) {
    await query('DELETE FROM task_folders WHERE task_id=$1 AND folder_id=$2', [subId, folderId]);
    return noContent();
  }

  return notFound();
}

// ─── CONTACTS ────────────────────────────────────────────────────────────────

async function handleContacts(_method: string, userId: string): Promise<APIGatewayProxyResult> {
  const rows = await query(
    `SELECT
       name,
       MAX(role)    AS role,
       MAX(email)   AS email,
       MAX(company) AS company,
       COUNT(DISTINCT task_id)::int AS meeting_count,
       MAX(last_seen) AS last_seen,
       array_agg(DISTINCT task_id::text) AS task_ids
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
     GROUP BY name
     ORDER BY meeting_count DESC, name ASC`,
    [userId]
  );
  return ok(rows);
}
