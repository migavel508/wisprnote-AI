import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';
import { query, queryOne, queryCount } from './db';
import { ok, created, noContent, badRequest, notFound, unauthorized, serverError, corsPreflightResponse } from './response';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

const S3_BUCKET = process.env.S3_BUCKET || '';
const S3_REGION = process.env.AWS_REGION || 'us-east-1';
const s3 = new S3Client({ region: S3_REGION });

function getUserId(event: APIGatewayProxyEvent): string {
  const claims = event.requestContext.authorizer?.claims;
  const sub = claims?.sub;
  if (!sub) throw new Error('UNAUTHORIZED');
  return sub;
}

function getUserEmail(event: APIGatewayProxyEvent): string | null {
  return event.requestContext.authorizer?.claims?.email || null;
}

function parseBody(event: APIGatewayProxyEvent): any {
  if (!event.body) return {};
  try { return JSON.parse(event.body); } catch { return {}; }
}

function getPathParam(event: APIGatewayProxyEvent, segments: string[], index: number): string | undefined {
  return segments[index];
}

function generateToken(len = 22): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let result = '';
  const bytes = new Uint8Array(len);
  require('crypto').randomFillSync(bytes);
  for (const b of bytes) result += chars[b % chars.length];
  return result;
}

export const handler = async (event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> => {
  if (event.httpMethod === 'OPTIONS') return corsPreflightResponse();

  const path = event.path.replace(/^\/+|\/+$/g, '');
  const segments = path.split('/');
  const resource = segments[0];
  const method = event.httpMethod;
  const qs = event.queryStringParameters || {};

  try {
    // Public route: share verification
    if (resource === 'shares' && segments[1] === 'verify' && segments[2] && method === 'GET') {
      return await handleShareVerify(segments[2], qs.email || null);
    }

    const userId = getUserId(event);

    switch (resource) {
      case 'tasks':    return await handleTasks(method, segments, userId, event);
      case 'assets':   return await handleAssets(method, userId, event);
      case 'notes':    return await handleNotes(method, segments, userId, event);
      case 'knowledge-graph': return await handleKnowledgeGraph(method, segments, userId, event);
      case 'chat':     return await handleChat(method, userId, event);
      case 'shares':   return await handleShares(method, segments, userId, event);
      case 'ledger':   return await handleLedger(method, segments, userId, event);
      case 'storage':  return await handleStorage(method, segments, userId, event);
      default:         return notFound();
    }
  } catch (err: any) {
    if (err.message === 'UNAUTHORIZED') return unauthorized();
    console.error('Handler error:', err);
    return serverError(err.message || 'Internal server error');
  }
};

// ─── TASKS ──────────────────────────────────────────────────────────────────

async function handleTasks(method: string, segments: string[], userId: string, event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const taskId = segments[1];
  const qs = event.queryStringParameters || {};

  if (method === 'POST' && !taskId) {
    const body = parseBody(event);
    const row = await queryOne(
      `INSERT INTO task_history (user_id, filename, transcription, summary, notes, audio_url, status, duration, prompt, personal_note, visualization_image)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [userId, body.filename, body.transcription, body.summary, body.notes, body.audio_url, body.status, body.duration || 0, body.prompt, body.personal_note, body.visualization_image]
    );
    return created(row);
  }

  if (method === 'GET' && taskId) {
    const row = await queryOne('SELECT * FROM task_history WHERE id=$1 AND user_id=$2', [taskId, userId]);
    return row ? ok(row) : notFound();
  }

  if (method === 'GET' && !taskId) {
    const page = parseInt(qs.page || '0', 10);
    const pageSize = parseInt(qs.pageSize || '20', 10);
    const full = qs.full === 'true';

    const total = await queryCount('SELECT COUNT(*) FROM task_history WHERE user_id=$1', [userId]);
    const fields = full ? '*' : 'id, created_at, filename, summary, status, duration';
    const rows = await query(
      `SELECT ${fields} FROM task_history WHERE user_id=$1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [userId, pageSize, page * pageSize]
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
        `INSERT INTO chat_history (user_id, task_id, role, text, image, thread_id, citations, retrieval_meta)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING *`,
        [userId, m.task_id || null, m.role, m.text, m.image || null, m.thread_id || null,
         JSON.stringify(m.citations || []), JSON.stringify(m.retrieval_meta || {})]
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
      for (const email of body.emails) {
        await query(
          'INSERT INTO shared_meeting_access (share_id, email) VALUES ($1,$2) ON CONFLICT (share_id, email) DO NOTHING',
          [row.id, email.trim().toLowerCase()]
        );
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
      for (const email of (body.emails || [])) {
        await query(
          'INSERT INTO shared_meeting_access (share_id, email) VALUES ($1,$2) ON CONFLICT (share_id, email) DO NOTHING',
          [shareId, email.trim().toLowerCase()]
        );
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
