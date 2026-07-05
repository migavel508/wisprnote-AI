import { registerConnector, type KnowledgeItemInput } from '../registry';
import { googleGet } from './client';

/**
 * Google Calendar connector (direct REST). Pulls upcoming + recent events from the primary calendar,
 * incremental via `updatedMin` (RFC3339 cursor = the max event `updated` seen). type='event'.
 */

const PAGE = 25;

registerConnector({
  id: 'gcal',
  async sync(userId, scope, cursor) {
    // Backfill: events updated in the last 60 days; incremental: since the watermark.
    const updatedMin = cursor || new Date(Date.now() - 60 * 86_400_000).toISOString();
    const url = `https://www.googleapis.com/calendar/v3/calendars/primary/events`
      + `?maxResults=${PAGE}&singleEvents=true&orderBy=updated&showDeleted=false&updatedMin=${encodeURIComponent(updatedMin)}`;
    const res = await googleGet(userId, 'gcal', scope, url);
    const events: any[] = res?.items || [];
    if (!events.length) return { items: [], nextCursor: cursor };

    const items: KnowledgeItemInput[] = [];
    let maxUpdated = cursor || '';
    for (const e of events) {
      if (e.status === 'cancelled') continue;
      const start = e.start?.dateTime || e.start?.date || null;
      const attendees = (e.attendees || []).map((a: any) => a.email).filter(Boolean);
      const organizer = e.organizer?.email || e.creator?.email || null;
      if (e.updated && e.updated > maxUpdated) maxUpdated = e.updated;
      items.push({
        source: 'gcal', source_id: String(e.id), type: 'event',
        title: e.summary || '(no title)',
        body: `${e.description || ''}${e.location ? `\nLocation: ${e.location}` : ''}${attendees.length ? `\nAttendees: ${attendees.join(', ')}` : ''}`.slice(0, 4000),
        people: { organizer, attendees }, actor: organizer,
        links: { url: e.htmlLink || null },
        raw: e, occurred_at: start,
      });
    }
    const next = maxUpdated && maxUpdated > (cursor || '') ? maxUpdated : cursor;
    return { items, nextCursor: next };
  },
});
