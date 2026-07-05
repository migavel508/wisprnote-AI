import { registerConnector, type KnowledgeItemInput } from '../registry';
import { googleGet } from './client';

/**
 * Google Drive connector (direct REST, read-only). Indexes file METADATA (name, owners, type, links)
 * so docs are searchable alongside meetings, incremental via `modifiedTime` (RFC3339 watermark cursor).
 * type='file'. Full-content extraction (Docs export) can follow; metadata already makes files findable.
 */

const PAGE = 30;

registerConnector({
  id: 'gdrive',
  async sync(userId, scope, cursor) {
    const since = cursor || new Date(Date.now() - 90 * 86_400_000).toISOString();
    // Non-trashed files modified since the watermark, newest first.
    const q = encodeURIComponent(`trashed=false and modifiedTime > '${since}'`);
    const fields = encodeURIComponent('files(id,name,mimeType,modifiedTime,webViewLink,owners(displayName,emailAddress),description)');
    const url = `https://www.googleapis.com/drive/v3/files?pageSize=${PAGE}&orderBy=modifiedTime desc&q=${q}&fields=${fields}`;
    const res = await googleGet(userId, 'gdrive', scope, url);
    const files: any[] = res?.files || [];
    if (!files.length) return { items: [], nextCursor: cursor };

    const items: KnowledgeItemInput[] = [];
    let maxMod = cursor || '';
    for (const f of files) {
      const owners = (f.owners || []).map((o: any) => o.displayName || o.emailAddress).filter(Boolean);
      const kind = String(f.mimeType || '').replace('application/vnd.google-apps.', '');
      if (f.modifiedTime && f.modifiedTime > maxMod) maxMod = f.modifiedTime;
      items.push({
        source: 'gdrive', source_id: String(f.id), type: 'file',
        title: f.name || '(untitled)',
        body: `${f.description || ''}${owners.length ? `\nOwners: ${owners.join(', ')}` : ''}\nType: ${kind}`.slice(0, 2000),
        people: { owners }, actor: owners[0] || null,
        links: { url: f.webViewLink || null },
        raw: f, occurred_at: f.modifiedTime || null,
      });
    }
    const next = maxMod && maxMod > (cursor || '') ? maxMod : cursor;
    return { items, nextCursor: next };
  },
});
