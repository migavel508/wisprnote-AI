import { googleGet, googlePost, googleFetch } from './client';

/**
 * STATIC tool catalog + executor for the direct-REST Google connectors — the parity replica of the
 * hosted "Claude for Gmail / Calendar / Drive" MCP connectors (which Anthropic operates and we can't
 * point at). MCP connectors get their tools from a live `tools/list`; Google has no MCP server, so we
 * DECLARE the same tool surface here, populate it into `connector_tool` on connect (so the
 * Tools/Permissions UI shows the full set, grouped read vs write), and execute each against Google's
 * REST APIs. Each tool carries its own `klass` so the trust plane buckets + gates it correctly:
 *   read  → allow (runs)         · write → ask (approval card) · destructive → deny (blocked by default)
 * Scopes (mcp/registry.ts): Gmail `gmail.modify`, Calendar full `calendar`, Drive full `drive`.
 * Catalog sizes mirror the hosted connectors: Gmail 4 read + 8 write · Calendar 4 + 4 · Drive 6 read + 2 write.
 */

const ACCOUNT_SCOPE = '00000000-0000-0000-0000-000000000000';
export function isGoogleConnector(id: string): boolean { return id === 'gmail' || id === 'gcal' || id === 'gdrive'; }

export type GoogleToolClass = 'read' | 'write' | 'destructive';
export interface GoogleToolDef { name: string; description: string; klass: GoogleToolClass; inputSchema: any }

const obj = (properties: any, required?: string[]) => ({ type: 'object', properties, ...(required ? { required } : {}) });

export const GOOGLE_TOOLS: Record<string, GoogleToolDef[]> = {
  gmail: [
    // ── Read-only (4) ──
    { name: 'gmail_search_messages', klass: 'read', description: "Searches for email threads from the authenticated user's Gmail account. Use Gmail search operators in `query` — e.g. `from:alice subject:invoice newer_than:7d`.", inputSchema: obj({ query: { type: 'string', description: 'Gmail search query (operators supported).' }, limit: { type: 'number', description: 'Max messages to return (default 10).' } }, ['query']) },
    { name: 'gmail_read_thread', klass: 'read', description: "Retrieves a specific email thread from the authenticated user's Gmail account, including every message's sender, subject, and body.", inputSchema: obj({ id: { type: 'string', description: 'Thread id (or a message id from that thread) returned by gmail_search_messages.' } }, ['id']) },
    { name: 'gmail_list_drafts', klass: 'read', description: "Lists draft emails from the authenticated user's Gmail account.", inputSchema: obj({ limit: { type: 'number', description: 'Max drafts to return (default 20).' } }) },
    { name: 'gmail_list_labels', klass: 'read', description: 'Lists user labels.', inputSchema: obj({}) },
    // ── Write / delete (8) ──
    { name: 'gmail_create_draft', klass: 'write', description: "Creates a new draft email in the authenticated user's Gmail account.", inputSchema: obj({ to: { type: 'string', description: 'Recipient email address(es), comma-separated.' }, subject: { type: 'string' }, body: { type: 'string', description: 'Plain-text body of the draft.' }, cc: { type: 'string' } }, ['body']) },
    { name: 'gmail_create_label', klass: 'write', description: 'Creates a new label.', inputSchema: obj({ name: { type: 'string', description: 'Label name (use "Parent/Child" for a nested label).' } }, ['name']) },
    { name: 'gmail_add_labels_to_message', klass: 'write', description: 'Adds labels to a message.', inputSchema: obj({ id: { type: 'string', description: 'Message id.' }, labels: { type: 'array', items: { type: 'string' }, description: 'Label names or ids to add (e.g. ["STARRED","Follow up"]).' } }, ['id', 'labels']) },
    { name: 'gmail_add_labels_to_thread', klass: 'write', description: 'Adds labels to a thread.', inputSchema: obj({ id: { type: 'string', description: 'Thread id.' }, labels: { type: 'array', items: { type: 'string' } } }, ['id', 'labels']) },
    { name: 'gmail_remove_labels_from_message', klass: 'write', description: 'Removes labels from a message.', inputSchema: obj({ id: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['id', 'labels']) },
    { name: 'gmail_remove_labels_from_thread', klass: 'write', description: 'Removes labels from a thread.', inputSchema: obj({ id: { type: 'string' }, labels: { type: 'array', items: { type: 'string' } } }, ['id', 'labels']) },
    { name: 'gmail_trash_message', klass: 'write', description: 'Adds a sensitive label (Trash or Spam) to a message — moves it to Trash. Reversible.', inputSchema: obj({ id: { type: 'string', description: 'Message id.' } }, ['id']) },
    { name: 'gmail_trash_thread', klass: 'write', description: 'Adds a sensitive label (Trash or Spam) to a thread — moves the whole thread to Trash. Reversible.', inputSchema: obj({ id: { type: 'string', description: 'Thread id.' } }, ['id']) },
  ],
  gcal: [
    // ── Read-only (4) — mirrors the hosted Calendar connector ──
    { name: 'gcal_list_events', klass: 'read', description: 'Lists calendar events in a given calendar (defaults to the primary calendar, last 7 days onward). Returns start time, title, location, and attendees.', inputSchema: obj({ calendarId: { type: 'string', description: "Calendar id (default 'primary')." }, timeMin: { type: 'string', description: 'ISO 8601 lower bound (optional).' }, timeMax: { type: 'string', description: 'ISO 8601 upper bound (optional).' }, limit: { type: 'number' } }) },
    { name: 'gcal_get_event', klass: 'read', description: 'Returns a single event on the specified calendar by event id.', inputSchema: obj({ id: { type: 'string', description: 'Event id.' }, calendarId: { type: 'string', description: "Calendar id (default 'primary')." } }, ['id']) },
    { name: 'gcal_list_calendars', klass: 'read', description: "Returns the calendars on the user's calendar list.", inputSchema: obj({}) },
    { name: 'gcal_find_free_time', klass: 'read', description: 'Suggests free time periods across one or more calendars in a window (inverts busy blocks from a free/busy query).', inputSchema: obj({ timeMin: { type: 'string', description: 'ISO 8601 window start (default now).' }, timeMax: { type: 'string', description: 'ISO 8601 window end (default now + 7 days).' }, calendars: { type: 'array', items: { type: 'string' }, description: "Calendar ids to check (default ['primary'])." }, minDurationMinutes: { type: 'number', description: 'Only return free slots at least this long (default 30).' } }) },
    // ── Write / delete (4) ──
    { name: 'gcal_create_event', klass: 'write', description: 'Creates a calendar event.', inputSchema: obj({ summary: { type: 'string', description: 'Event title.' }, start: { type: 'string', description: 'ISO 8601 start datetime.' }, end: { type: 'string', description: 'ISO 8601 end datetime (defaults to start + 1h).' }, location: { type: 'string' }, description: { type: 'string' }, attendees: { type: 'array', items: { type: 'string' }, description: 'Attendee email addresses.' }, calendarId: { type: 'string', description: "Calendar id (default 'primary')." } }, ['summary', 'start']) },
    { name: 'gcal_update_event', klass: 'write', description: 'Updates a calendar event — pass only the fields to change.', inputSchema: obj({ id: { type: 'string', description: 'Event id.' }, summary: { type: 'string' }, start: { type: 'string', description: 'ISO 8601 start.' }, end: { type: 'string', description: 'ISO 8601 end.' }, location: { type: 'string' }, description: { type: 'string' }, calendarId: { type: 'string', description: "Calendar id (default 'primary')." } }, ['id']) },
    { name: 'gcal_respond_to_event', klass: 'write', description: 'Responds to an event invitation (accepted / declined / tentative) as the current user.', inputSchema: obj({ id: { type: 'string', description: 'Event id.' }, response: { type: 'string', description: "One of 'accepted', 'declined', 'tentative'." }, calendarId: { type: 'string', description: "Calendar id (default 'primary')." } }, ['id', 'response']) },
    { name: 'gcal_delete_event', klass: 'write', description: 'Deletes a calendar event (recoverable from Trash for ~30 days).', inputSchema: obj({ id: { type: 'string', description: 'Event id.' }, calendarId: { type: 'string', description: "Calendar id (default 'primary')." } }, ['id']) },
  ],
  gdrive: [
    // ── Read-only (6) — mirrors the hosted Drive connector ──
    { name: 'gdrive_search_files', klass: 'read', description: "Searches for files by name or content in the user's Google Drive. Returns matching files (name, type, owner, link).", inputSchema: obj({ query: { type: 'string' }, limit: { type: 'number' } }, ['query']) },
    { name: 'gdrive_list_recent_files', klass: 'read', description: "Lists the most recently modified files in the user's Google Drive.", inputSchema: obj({ limit: { type: 'number' } }) },
    { name: 'gdrive_get_file_metadata', klass: 'read', description: 'Gets metadata for a Drive file by id — name, type, size, owners, created/modified dates, and link.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'gdrive_get_file_permissions', klass: 'read', description: 'Lists the sharing permissions on a Drive file — who can view or edit it.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'gdrive_read_file_content', klass: 'read', description: 'Reads the text content of a Drive file by id (exports Google Docs/Sheets/Slides to text).', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    { name: 'gdrive_download_file_content', klass: 'read', description: 'Downloads the raw content of a Drive file by id — text is returned inline; binary is summarized (type + size).', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
    // ── Write / delete (2) ──
    { name: 'gdrive_copy_file', klass: 'write', description: 'Creates a copy of a Drive file.', inputSchema: obj({ id: { type: 'string', description: 'Id of the file to copy.' }, name: { type: 'string', description: 'Name for the copy (optional).' } }, ['id']) },
    { name: 'gdrive_create_file', klass: 'write', description: "Creates a new file in the user's Google Drive with the given text content.", inputSchema: obj({ name: { type: 'string' }, content: { type: 'string' }, mimeType: { type: 'string', description: 'Defaults to text/plain.' }, folderId: { type: 'string', description: 'Parent folder id (optional).' } }, ['name', 'content']) },
  ],
};

// ── helpers ──────────────────────────────────────────────────────────────────
function header(headers: any[], name: string): string {
  return (Array.isArray(headers) ? headers : []).find((h: any) => String(h?.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}
function decodeBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) { try { return Buffer.from(payload.body.data, 'base64url').toString('utf8'); } catch { return ''; } }
  for (const p of (payload.parts || [])) { const t = decodeBody(p); if (t) return t; }
  if (payload.body?.data) { try { return Buffer.from(payload.body.data, 'base64url').toString('utf8'); } catch { return ''; } }
  return '';
}
/** Build a base64url-encoded RFC 2822 message for drafts.create. */
function rfc822(to: string, cc: string, subject: string, body: string): string {
  const lines = [
    to ? `To: ${to}` : '', cc ? `Cc: ${cc}` : '', subject ? `Subject: ${subject}` : '',
    'Content-Type: text/plain; charset="UTF-8"', 'MIME-Version: 1.0', '', body || '',
  ].filter((l, i) => l !== '' || i > 2);
  return Buffer.from(lines.join('\r\n'), 'utf8').toString('base64url');
}
/** Resolve a mix of label names / ids / system labels (STARRED, IMPORTANT…) to Gmail label ids. */
async function resolveLabelIds(userId: string, scope: string, inputs: string[]): Promise<string[]> {
  const wanted = (inputs || []).map((s) => String(s).trim()).filter(Boolean);
  if (!wanted.length) return [];
  const res = await googleGet(userId, 'gmail', scope, 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
  const labels: any[] = res?.labels || [];
  const byId = new Map(labels.map((l) => [l.id, l.id]));
  const byName = new Map(labels.map((l) => [String(l.name).toLowerCase(), l.id]));
  const out: string[] = [];
  for (const w of wanted) {
    const id = byId.get(w) || byName.get(w.toLowerCase()) || (/^[A-Z_]+$/.test(w) ? w : undefined);
    if (id) out.push(id);
  }
  return out;
}
/** Standard "you need to reconnect" message when a write hits an insufficient-scope 403. */
function scopeHint(source: string, r: { status?: number; error?: string } | null): string | null {
  if (r && (r.status === 403 || r.status === 401) && /scope|insufficient|permission/i.test(r.error || '')) {
    return `${source} is connected with read-only permission. Disconnect and reconnect ${source} to grant write access, then try again.`;
  }
  return null;
}
/** The text/plain-ish export MIME for a Google-native Drive type (Docs/Sheets/Slides), else null. */
function driveExportMime(mimeType: string): string | null {
  if (mimeType === 'application/vnd.google-apps.spreadsheet') return 'text/csv';
  if (mimeType.startsWith('application/vnd.google-apps.')) return 'text/plain';   // docs, slides, etc.
  return null;
}
/** Heuristic: is this string safe to show as text (not raw binary)? Flags NUL / control-char-heavy data. */
function isMostlyText(s: string): boolean {
  if (!s) return true;
  const sample = s.slice(0, 2000);
  let bad = 0;
  for (const ch of sample) { const c = ch.charCodeAt(0); if (c === 0 || c < 9 || (c > 13 && c < 32)) bad++; }
  return bad / sample.length < 0.1;
}

export interface GoogleToolResult { ok: boolean; isError?: boolean; content: string }
const err = (content: string): GoogleToolResult => ({ ok: false, isError: true, content });

/** Execute one Google tool. Uses the workspace's stored token (getToken falls back across spaces). */
export async function executeGoogleTool(userId: string, workspaceId: string, connector: string, tool: string, args: any): Promise<GoogleToolResult> {
  const scope = `${workspaceId}:${ACCOUNT_SCOPE}`;
  const a = args || {};
  try {
    // ── GMAIL ────────────────────────────────────────────────────────────────
    if (tool === 'gmail_search_messages') {
      const q = String(a.query || '').trim(); const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 25);
      if (!q) return err('gmail_search_messages requires "query".');
      const list = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent(q)}`);
      if (list == null) return err('Gmail is not connected in this workspace.');
      const msgs: any[] = list.messages || [];
      if (!msgs.length) return { ok: true, content: `No Gmail messages match "${q}".` };
      const lines: string[] = [];
      for (const m of msgs.slice(0, limit)) {
        const full = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=metadata&metadataHeaders=Subject&metadataHeaders=From&metadataHeaders=Date`);
        const hs = full?.payload?.headers || [];
        lines.push(`[msg:${m.id} thread:${m.threadId}] ${header(hs, 'Subject') || '(no subject)'} — from ${header(hs, 'From')} (${header(hs, 'Date')})\n    ${(full?.snippet || '').slice(0, 200)}`);
      }
      return { ok: true, content: `Found ${lines.length} message(s):\n\n${lines.join('\n')}` };
    }
    if (tool === 'gmail_read_thread') {
      const id = String(a.id || '').trim(); if (!id) return err('gmail_read_thread requires "id".');
      const t = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/threads/${id}?format=full`);
      if (t == null) return err('Gmail not connected, or thread not found.');
      const msgs: any[] = t.messages || [];
      if (!msgs.length) return { ok: true, content: 'Thread has no messages.' };
      const blocks = msgs.map((m: any, i: number) => {
        const hs = m.payload?.headers || [];
        return `── Message ${i + 1} ──\nFrom: ${header(hs, 'From')}\nDate: ${header(hs, 'Date')}\nSubject: ${header(hs, 'Subject')}\n\n${(decodeBody(m.payload) || m.snippet || '').slice(0, 2500)}`;
      });
      return { ok: true, content: `Thread ${id} (${msgs.length} message(s)):\n\n${blocks.join('\n\n')}`.slice(0, 8000) };
    }
    if (tool === 'gmail_list_drafts') {
      const limit = Math.min(Math.max(Number(a.limit) || 20, 1), 50);
      const res = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/drafts?maxResults=${limit}`);
      if (res == null) return err('Gmail is not connected in this workspace.');
      const drafts: any[] = res.drafts || [];
      if (!drafts.length) return { ok: true, content: 'No drafts.' };
      const lines: string[] = [];
      for (const d of drafts.slice(0, limit)) {
        const full = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/drafts/${d.id}?format=metadata`);
        const hs = full?.message?.payload?.headers || [];
        lines.push(`[draft:${d.id}] To: ${header(hs, 'To') || '(none)'} — ${header(hs, 'Subject') || '(no subject)'}`);
      }
      return { ok: true, content: `${lines.length} draft(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gmail_list_labels') {
      const res = await googleGet(userId, 'gmail', scope, 'https://gmail.googleapis.com/gmail/v1/users/me/labels');
      if (res == null) return err('Gmail is not connected in this workspace.');
      const labels: any[] = res.labels || [];
      const lines = labels.map((l: any) => `${l.name} [${l.id}]${l.type === 'system' ? ' (system)' : ''}`);
      return { ok: true, content: `${lines.length} label(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gmail_create_draft') {
      const body = String(a.body || '');
      const raw = rfc822(String(a.to || ''), String(a.cc || ''), String(a.subject || ''), body);
      const r = await googlePost(userId, 'gmail', scope, 'https://gmail.googleapis.com/gmail/v1/users/me/drafts', { message: { raw } });
      if (r == null) return err('Gmail is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Gmail', r) || `Could not create draft: ${r.error}`);
      return { ok: true, content: `Draft created (id ${r.json?.id}${a.to ? `, to ${a.to}` : ''}${a.subject ? `, subject "${a.subject}"` : ''}). It's saved in Drafts — not sent.` };
    }
    if (tool === 'gmail_create_label') {
      const name = String(a.name || '').trim(); if (!name) return err('gmail_create_label requires "name".');
      const r = await googlePost(userId, 'gmail', scope, 'https://gmail.googleapis.com/gmail/v1/users/me/labels', { name, labelListVisibility: 'labelShow', messageListVisibility: 'show' });
      if (r == null) return err('Gmail is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Gmail', r) || `Could not create label: ${r.error}`);
      return { ok: true, content: `Label "${name}" created (id ${r.json?.id}).` };
    }
    if (tool === 'gmail_add_labels_to_message' || tool === 'gmail_remove_labels_from_message' ||
        tool === 'gmail_add_labels_to_thread' || tool === 'gmail_remove_labels_from_thread') {
      const id = String(a.id || '').trim(); if (!id) return err(`${tool} requires "id".`);
      const ids = await resolveLabelIds(userId, scope, Array.isArray(a.labels) ? a.labels : [a.labels].filter(Boolean));
      if (!ids.length) return err('No matching labels — pass label names (from gmail_list_labels) or ids.');
      const isThread = tool.endsWith('thread');
      const isAdd = tool.startsWith('gmail_add');
      const kind = isThread ? 'threads' : 'messages';
      const patch = isAdd ? { addLabelIds: ids } : { removeLabelIds: ids };
      const r = await googlePost(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/${kind}/${id}/modify`, patch);
      if (r == null) return err('Gmail is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Gmail', r) || `Could not update labels: ${r.error}`);
      return { ok: true, content: `${isAdd ? 'Added' : 'Removed'} ${ids.length} label(s) ${isAdd ? 'to' : 'from'} ${isThread ? 'thread' : 'message'} ${id}.` };
    }
    if (tool === 'gmail_trash_message' || tool === 'gmail_trash_thread') {
      const id = String(a.id || '').trim(); if (!id) return err(`${tool} requires "id".`);
      const kind = tool.endsWith('thread') ? 'threads' : 'messages';
      const r = await googlePost(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/${kind}/${id}/trash`, {});
      if (r == null) return err('Gmail is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Gmail', r) || `Could not trash: ${r.error}`);
      return { ok: true, content: `Moved ${kind === 'threads' ? 'thread' : 'message'} ${id} to Trash (recoverable for 30 days).` };
    }

    // ── CALENDAR ───────────────────────────────────────────────────────────────
    if (tool === 'gcal_list_events') {
      const calId = encodeURIComponent(String(a.calendarId || 'primary'));
      const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
      const timeMin = a.timeMin || new Date(Date.now() - 7 * 86_400_000).toISOString();
      const params = `maxResults=${limit}&singleEvents=true&orderBy=startTime&timeMin=${encodeURIComponent(timeMin)}${a.timeMax ? `&timeMax=${encodeURIComponent(a.timeMax)}` : ''}`;
      const res = await googleGet(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events?${params}`);
      if (res == null) return err('Google Calendar is not connected in this workspace.');
      const events = (res.items || []).filter((e: any) => e.status !== 'cancelled');
      if (!events.length) return { ok: true, content: 'No calendar events in that window.' };
      const lines = events.map((e: any) => `[${e.id}] ${e.start?.dateTime || e.start?.date} — ${e.summary || '(no title)'}${e.location ? ` @ ${e.location}` : ''}${(e.attendees || []).length ? ` · ${e.attendees.length} attendee(s)` : ''}`);
      return { ok: true, content: `${lines.length} event(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gcal_get_event') {
      const id = String(a.id || '').trim(); if (!id) return err('gcal_get_event requires "id".');
      const calId = encodeURIComponent(String(a.calendarId || 'primary'));
      const res = await googleGet(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(id)}`);
      if (res == null) return err('Google Calendar not connected, or event not found.');
      const attendees = (res.attendees || []).map((at: any) => `${at.email}${at.responseStatus ? ` (${at.responseStatus})` : ''}`).join(', ');
      return { ok: true, content: [
        `Title: ${res.summary || '(no title)'}`, `Start: ${res.start?.dateTime || res.start?.date}`, `End: ${res.end?.dateTime || res.end?.date}`,
        res.location ? `Location: ${res.location}` : '', res.description ? `Description: ${res.description}` : '',
        attendees ? `Attendees: ${attendees}` : '', res.htmlLink ? `Link: ${res.htmlLink}` : '',
      ].filter(Boolean).join('\n') };
    }
    if (tool === 'gcal_list_calendars') {
      const res = await googleGet(userId, 'gcal', scope, 'https://www.googleapis.com/calendar/v3/users/me/calendarList?maxResults=100');
      if (res == null) return err('Google Calendar is not connected in this workspace.');
      const cals: any[] = res.items || [];
      if (!cals.length) return { ok: true, content: 'No calendars.' };
      const lines = cals.map((c: any) => `[${c.id}] ${c.summary}${c.primary ? ' (primary)' : ''} — ${c.accessRole}`);
      return { ok: true, content: `${lines.length} calendar(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gcal_find_free_time') {
      const timeMin = a.timeMin || new Date(Date.now()).toISOString();
      const timeMax = a.timeMax || new Date(Date.now() + 7 * 86_400_000).toISOString();
      const minMs = Math.max(Number(a.minDurationMinutes) || 30, 1) * 60_000;
      const items = (Array.isArray(a.calendars) && a.calendars.length ? a.calendars : ['primary']).map((c: string) => ({ id: String(c) }));
      const r = await googlePost(userId, 'gcal', scope, 'https://www.googleapis.com/calendar/v3/freeBusy', { timeMin, timeMax, items });
      if (r == null) return err('Google Calendar is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Calendar', r) || `Could not query free/busy: ${r.error}`);
      const busy: Array<[number, number]> = [];
      for (const c of Object.values(r.json?.calendars || {}) as any[]) {
        for (const b of (c.busy || [])) { const s = Date.parse(b.start), e = Date.parse(b.end); if (!Number.isNaN(s) && !Number.isNaN(e)) busy.push([s, e]); }
      }
      busy.sort((x, y) => x[0] - y[0]);
      const merged: Array<[number, number]> = [];
      for (const [s, e] of busy) { const last = merged[merged.length - 1]; if (last && s <= last[1]) last[1] = Math.max(last[1], e); else merged.push([s, e]); }
      const winStart = Date.parse(timeMin), winEnd = Date.parse(timeMax);
      const free: Array<[number, number]> = []; let cursor = winStart;
      for (const [s, e] of merged) { if (s > cursor) free.push([cursor, Math.min(s, winEnd)]); cursor = Math.max(cursor, e); if (cursor >= winEnd) break; }
      if (cursor < winEnd) free.push([cursor, winEnd]);
      const slots = free.filter(([s, e]) => e - s >= minMs);
      if (!slots.length) return { ok: true, content: 'No free slots of the requested length in that window.' };
      const lines = slots.slice(0, 30).map(([s, e]) => `${new Date(s).toISOString()} → ${new Date(e).toISOString()} (${Math.round((e - s) / 60000)} min)`);
      return { ok: true, content: `${lines.length} free slot(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gcal_create_event') {
      const summary = String(a.summary || '').trim(); const start = String(a.start || '').trim();
      if (!summary || !start) return err('gcal_create_event requires "summary" and "start".');
      const startMs = Date.parse(start); if (Number.isNaN(startMs)) return err('"start" must be an ISO 8601 datetime.');
      const end = a.end && !Number.isNaN(Date.parse(a.end)) ? String(a.end) : new Date(startMs + 3_600_000).toISOString();
      const body: any = { summary, start: { dateTime: new Date(startMs).toISOString() }, end: { dateTime: new Date(Date.parse(end)).toISOString() } };
      if (a.location) body.location = String(a.location);
      if (a.description) body.description = String(a.description);
      if (Array.isArray(a.attendees) && a.attendees.length) body.attendees = a.attendees.map((em: string) => ({ email: String(em) }));
      const calId = encodeURIComponent(String(a.calendarId || 'primary'));
      const r = await googlePost(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events`, body);
      if (r == null) return err('Google Calendar is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Calendar', r) || `Could not create event: ${r.error}`);
      return { ok: true, content: `Event "${summary}" created for ${body.start.dateTime}${r.json?.htmlLink ? ` — ${r.json.htmlLink}` : ''}.` };
    }
    if (tool === 'gcal_update_event') {
      const id = String(a.id || '').trim(); if (!id) return err('gcal_update_event requires "id".');
      const calId = encodeURIComponent(String(a.calendarId || 'primary'));
      const patch: any = {};
      if (a.summary != null) patch.summary = String(a.summary);
      if (a.location != null) patch.location = String(a.location);
      if (a.description != null) patch.description = String(a.description);
      if (a.start) { const ms = Date.parse(String(a.start)); if (!Number.isNaN(ms)) patch.start = { dateTime: new Date(ms).toISOString() }; }
      if (a.end) { const ms = Date.parse(String(a.end)); if (!Number.isNaN(ms)) patch.end = { dateTime: new Date(ms).toISOString() }; }
      if (!Object.keys(patch).length) return err('gcal_update_event: pass at least one field to change (summary/start/end/location/description).');
      const r = await googleFetch(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(patch) });
      if (r == null) return err('Google Calendar is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Calendar', r) || `Could not update event: ${r.error}`);
      return { ok: true, content: `Event ${id} updated.` };
    }
    if (tool === 'gcal_respond_to_event') {
      const id = String(a.id || '').trim(); const response = String(a.response || '').trim().toLowerCase();
      if (!id) return err('gcal_respond_to_event requires "id".');
      if (!['accepted', 'declined', 'tentative'].includes(response)) return err('"response" must be accepted, declined, or tentative.');
      const calId = encodeURIComponent(String(a.calendarId || 'primary'));
      const ev = await googleGet(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(id)}`);
      if (ev == null) return err('Google Calendar not connected, or event not found.');
      const attendees: any[] = ev.attendees || [];
      const self = attendees.find((at: any) => at.self);
      if (!self) return err('You are not an attendee on this event, so there is nothing to respond to.');
      self.responseStatus = response;
      const r = await googleFetch(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify({ attendees }) });
      if (r == null) return err('Google Calendar is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Calendar', r) || `Could not respond: ${r.error}`);
      return { ok: true, content: `Responded "${response}" to event ${id}.` };
    }
    if (tool === 'gcal_delete_event') {
      const id = String(a.id || '').trim(); if (!id) return err('gcal_delete_event requires "id".');
      const calId = encodeURIComponent(String(a.calendarId || 'primary'));
      const r = await googleFetch(userId, 'gcal', scope, `https://www.googleapis.com/calendar/v3/calendars/${calId}/events/${encodeURIComponent(id)}`, { method: 'DELETE' });
      if (r == null) return err('Google Calendar is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Calendar', r) || `Could not delete event: ${r.error}`);
      return { ok: true, content: `Event ${id} deleted (recoverable from Trash for ~30 days).` };
    }

    // ── DRIVE ──────────────────────────────────────────────────────────────────
    if (tool === 'gdrive_search_files') {
      const q = String(a.query || '').trim(); const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
      if (!q) return err('gdrive_search_files requires "query".');
      const safe = q.replace(/'/g, '');
      const dq = encodeURIComponent(`trashed=false and (name contains '${safe}' or fullText contains '${safe}')`);
      const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))');
      const res = await googleGet(userId, 'gdrive', scope, `https://www.googleapis.com/drive/v3/files?pageSize=${limit}&q=${dq}&fields=${fields}`);
      if (res == null) return err('Google Drive is not connected in this workspace.');
      const files: any[] = res.files || [];
      if (!files.length) return { ok: true, content: `No Drive files match "${q}".` };
      const lines = files.map((f: any) => `[${f.id}] ${f.name} (${String(f.mimeType || '').replace('application/vnd.google-apps.', '')}) — ${f.webViewLink || ''}`);
      return { ok: true, content: `${lines.length} file(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gdrive_list_recent_files') {
      const limit = Math.min(Math.max(Number(a.limit) || 15, 1), 50);
      const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName))');
      const res = await googleGet(userId, 'gdrive', scope, `https://www.googleapis.com/drive/v3/files?pageSize=${limit}&orderBy=${encodeURIComponent('modifiedTime desc')}&q=${encodeURIComponent('trashed=false')}&fields=${fields}`);
      if (res == null) return err('Google Drive is not connected in this workspace.');
      const files: any[] = res.files || [];
      if (!files.length) return { ok: true, content: 'No recent files.' };
      const lines = files.map((f: any) => `[${f.id}] ${f.name} (${String(f.mimeType || '').replace('application/vnd.google-apps.', '')}) — modified ${f.modifiedTime}`);
      return { ok: true, content: `${lines.length} recent file(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gdrive_get_file_metadata') {
      const id = String(a.id || '').trim(); if (!id) return err('gdrive_get_file_metadata requires "id".');
      const fields = encodeURIComponent('id,name,mimeType,size,createdTime,modifiedTime,owners(displayName,emailAddress),webViewLink,parents,shared');
      const res = await googleGet(userId, 'gdrive', scope, `https://www.googleapis.com/drive/v3/files/${id}?fields=${fields}`);
      if (res == null) return err('Google Drive not connected, or file not found.');
      const owners = (res.owners || []).map((o: any) => o.displayName || o.emailAddress).join(', ');
      return { ok: true, content: [
        `Name: ${res.name}`, `Type: ${res.mimeType}`, res.size ? `Size: ${res.size} bytes` : '',
        `Created: ${res.createdTime}`, `Modified: ${res.modifiedTime}`, owners ? `Owner(s): ${owners}` : '',
        res.shared != null ? `Shared: ${res.shared}` : '', res.webViewLink ? `Link: ${res.webViewLink}` : '',
      ].filter(Boolean).join('\n') };
    }
    if (tool === 'gdrive_get_file_permissions') {
      const id = String(a.id || '').trim(); if (!id) return err('gdrive_get_file_permissions requires "id".');
      const fields = encodeURIComponent('permissions(id,type,role,emailAddress,displayName,domain)');
      const res = await googleGet(userId, 'gdrive', scope, `https://www.googleapis.com/drive/v3/files/${id}/permissions?fields=${fields}`);
      if (res == null) return err('Google Drive not connected, or file not found.');
      const perms: any[] = res.permissions || [];
      if (!perms.length) return { ok: true, content: 'No explicit permissions (private to owner).' };
      const lines = perms.map((p: any) => `${p.role} — ${p.type}${p.emailAddress ? ` ${p.emailAddress}` : ''}${p.displayName ? ` (${p.displayName})` : ''}${p.domain ? ` @${p.domain}` : ''}`);
      return { ok: true, content: `${lines.length} permission(s):\n${lines.join('\n')}` };
    }
    if (tool === 'gdrive_read_file_content' || tool === 'gdrive_download_file_content') {
      const id = String(a.id || '').trim(); if (!id) return err(`${tool} requires "id".`);
      const meta = await googleGet(userId, 'gdrive', scope, `https://www.googleapis.com/drive/v3/files/${id}?fields=name,mimeType,size`);
      if (meta == null) return err('Google Drive not connected, or file not found.');
      const mime = String(meta.mimeType || '');
      const exportMime = driveExportMime(mime);
      const url = exportMime
        ? `https://www.googleapis.com/drive/v3/files/${id}/export?mimeType=${encodeURIComponent(exportMime)}`
        : `https://www.googleapis.com/drive/v3/files/${id}?alt=media`;
      const r = await googleFetch(userId, 'gdrive', scope, url);
      if (r == null) return err('Google Drive is not connected in this workspace.');
      if (!r.ok) return err(`Could not read "${meta.name}": ${r.error}`);
      const raw = typeof r.json === 'string' ? r.json : JSON.stringify(r.json);
      if (!exportMime && !isMostlyText(raw)) {
        return { ok: true, content: `"${meta.name}" is a binary ${mime} file${meta.size ? ` (${meta.size} bytes)` : ''} — not shown as text. Open it via its Drive link.` };
      }
      return { ok: true, content: `${meta.name}:\n\n${String(raw).slice(0, 6000)}` };
    }
    if (tool === 'gdrive_copy_file') {
      const id = String(a.id || '').trim(); if (!id) return err('gdrive_copy_file requires "id".');
      const body: any = {}; if (a.name) body.name = String(a.name);
      const r = await googlePost(userId, 'gdrive', scope, `https://www.googleapis.com/drive/v3/files/${id}/copy?fields=id,name,webViewLink`, body);
      if (r == null) return err('Google Drive is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Drive', r) || `Could not copy file: ${r.error}`);
      return { ok: true, content: `Copied to "${r.json?.name}" (id ${r.json?.id})${r.json?.webViewLink ? ` — ${r.json.webViewLink}` : ''}.` };
    }
    if (tool === 'gdrive_create_file') {
      const name = String(a.name || '').trim(); const content = String(a.content ?? '');
      if (!name) return err('gdrive_create_file requires "name".');
      const mimeType = String(a.mimeType || 'text/plain');
      const metadata: any = { name, mimeType }; if (a.folderId) metadata.parents = [String(a.folderId)];
      const boundary = '----lumina_gdrive_boundary_9f2c7a1e';
      const multipart =
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
        `--${boundary}\r\nContent-Type: ${mimeType}\r\n\r\n${content}\r\n--${boundary}--`;
      const r = await googleFetch(userId, 'gdrive', scope, 'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id,name,webViewLink', {
        method: 'POST', headers: { 'Content-Type': `multipart/related; boundary=${boundary}` }, body: multipart,
      });
      if (r == null) return err('Google Drive is not connected in this workspace.');
      if (!r.ok) return err(scopeHint('Google Drive', r) || `Could not create file: ${r.error}`);
      return { ok: true, content: `Created "${r.json?.name}" (id ${r.json?.id})${r.json?.webViewLink ? ` — ${r.json.webViewLink}` : ''}.` };
    }

    return err(`Unknown Google tool "${tool}".`);
  } catch (e: any) {
    return err(`Google tool failed: ${e?.message || 'error'}`);
  }
}
