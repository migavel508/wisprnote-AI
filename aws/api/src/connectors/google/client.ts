import { getToken } from '../../trust/broker';

/**
 * Direct-REST Google client. Each Google connector (gmail/gcal/gdrive) is authed by ITS OWN broker
 * token (its own OAuth grant + scopes). The broker auto-refreshes the short-lived access token, so
 * callers just ask for the current one. Returns parsed JSON, or null on any failure (a connector must
 * never throw the sync — it just yields an empty page).
 */

const SPACE_DEFAULT = '00000000-0000-0000-0000-000000000000';

/** Fetch the current Google access token for (user, connector, workspace, space). */
export async function googleAccessToken(userId: string, source: string, scope: string): Promise<string | null> {
  const [workspaceId, spaceId = SPACE_DEFAULT] = scope.split(':');
  const cred = await getToken(userId, source, workspaceId, spaceId);
  return (cred?.token as any)?.access_token ?? null;
}

/** Authed GET against a Google REST API. Returns parsed JSON, or null on any failure. */
export async function googleGet(userId: string, source: string, scope: string, url: string): Promise<any | null> {
  const r = await googleFetch(userId, source, scope, url);
  return r?.ok ? r.json : null;
}

export interface GoogleResponse { ok: boolean; status: number; json: any; error?: string }

/**
 * Authed request against a Google REST API (any method). Unlike `googleGet`, this surfaces the status
 * + body so the TOOL layer can report *why* a call failed (e.g. 403 insufficient scope → tell the user
 * to reconnect). Returns null only when there's no token at all (connector not connected). JSON body is
 * sent as application/json unless caller overrides Content-Type (e.g. for a raw RFC822 draft upload).
 */
export async function googleFetch(userId: string, source: string, scope: string, url: string, init?: RequestInit): Promise<GoogleResponse | null> {
  const accessToken = await googleAccessToken(userId, source, scope);
  if (!accessToken) return null;
  try {
    const headers: Record<string, string> = { Authorization: `Bearer ${accessToken}`, ...((init?.headers as Record<string, string>) || {}) };
    if (init?.body != null && !Object.keys(headers).some((h) => h.toLowerCase() === 'content-type')) headers['Content-Type'] = 'application/json';
    const r = await fetch(url, { ...init, headers });
    const text = await r.text().catch(() => '');
    let json: any = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = text; }
    if (!r.ok) {
      const error = (json?.error?.message || (typeof json === 'string' ? json : '') || `HTTP ${r.status}`).slice(0, 200);
      console.error('google_fetch_failed', JSON.stringify({ source, method: init?.method || 'GET', status: r.status, error }));
      return { ok: false, status: r.status, json, error };
    }
    return { ok: true, status: r.status, json };
  } catch (e: any) {
    console.error('google_fetch_error', JSON.stringify({ source, message: e?.message }));
    return { ok: false, status: 0, json: null, error: e?.message || 'network error' };
  }
}

/** Convenience POST with a JSON body. */
export async function googlePost(userId: string, source: string, scope: string, url: string, body: any): Promise<GoogleResponse | null> {
  return googleFetch(userId, source, scope, url, { method: 'POST', body: JSON.stringify(body ?? {}) });
}
