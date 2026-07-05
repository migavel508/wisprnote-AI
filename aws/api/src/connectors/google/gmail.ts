import { registerConnector, type KnowledgeItemInput } from '../registry';
import { googleGet } from './client';

/**
 * Gmail connector (direct REST). Each tick pulls a bounded page of recent messages and maps them to
 * knowledge_item (type='email'). Incremental via a watermark cursor = the max `internalDate` (ms) seen;
 * the next tick queries `after:<cursor>` so only newer mail is fetched. Idempotent on the message id.
 */

const PAGE = 20;

function header(headers: any[], name: string): string {
  return (Array.isArray(headers) ? headers : []).find((h: any) => String(h?.name || '').toLowerCase() === name.toLowerCase())?.value || '';
}
// Decode the best text/plain body from a Gmail payload tree (base64url), falling back to the snippet.
function decodeBody(payload: any): string {
  if (!payload) return '';
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    try { return Buffer.from(payload.body.data, 'base64url').toString('utf8'); } catch { return ''; }
  }
  for (const p of (payload.parts || [])) { const t = decodeBody(p); if (t) return t; }
  if (payload.body?.data) { try { return Buffer.from(payload.body.data, 'base64url').toString('utf8'); } catch { return ''; } }
  return '';
}

registerConnector({
  id: 'gmail',
  async sync(userId, scope, cursor) {
    const afterSec = cursor ? Math.floor(Number(cursor) / 1000) : 0;
    const q = afterSec ? `after:${afterSec}` : 'newer_than:30d';
    const list = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/messages?maxResults=${PAGE}&q=${encodeURIComponent(q)}`);
    const msgs: any[] = list?.messages || [];
    if (!msgs.length) return { items: [], nextCursor: cursor };   // nothing new → keep the watermark

    const items: KnowledgeItemInput[] = [];
    let maxDate = Number(cursor) || 0;
    for (const m of msgs) {
      const full = await googleGet(userId, 'gmail', scope, `https://gmail.googleapis.com/gmail/v1/users/me/messages/${m.id}?format=full`);
      if (!full) continue;
      const hs = full.payload?.headers || [];
      const subject = header(hs, 'Subject');
      const from = header(hs, 'From');
      const to = header(hs, 'To');
      const date = full.internalDate ? Number(full.internalDate) : 0;
      if (date > maxDate) maxDate = date;
      const body = decodeBody(full.payload) || full.snippet || '';
      items.push({
        source: 'gmail', source_id: String(m.id), type: 'email',
        title: subject || '(no subject)',
        body: `From: ${from}\nTo: ${to}\n\n${body}`.slice(0, 8000),
        people: { from, to }, actor: from,
        links: { url: `https://mail.google.com/mail/u/0/#all/${m.threadId || m.id}` },
        raw: full, occurred_at: date ? new Date(date).toISOString() : null,
      });
    }
    // Watermark: advance to the newest message seen (never go backwards).
    const next = maxDate > (Number(cursor) || 0) ? String(maxDate + 1) : cursor;
    return { items, nextCursor: next };
  },
});
