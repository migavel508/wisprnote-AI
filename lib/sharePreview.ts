/**
 * Shared metadata loader for link previews (Vercel /api routes).
 * Set API_GATEWAY_URL (or VITE_API_GATEWAY_URL) in Vercel project env to match production API.
 */

function stripMd(s: string): string {
  if (!s) return '';
  return s
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`[^`]+`/g, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]+\)/g, '$1')
    .replace(/[#>*_\-–—]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type SharePreview = { title: string; description: string; denied: boolean };

export async function loadSharePreview(token: string): Promise<SharePreview> {
  const fallback: SharePreview = {
    title: 'Wisprnote',
    description: 'Meeting notes and summaries — open this link to view the shared meeting.',
    denied: false,
  };

  const base = (process.env.API_GATEWAY_URL || process.env.VITE_API_GATEWAY_URL || '').replace(/\/$/, '');
  if (!base || !token) return fallback;

  const url = `${base}/shares/verify/${encodeURIComponent(token)}`;
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) {
      return { title: 'Shared meeting', description: 'This shared link could not be loaded.', denied: true };
    }
    const data = (await r.json()) as Record<string, unknown>;

    if (data?.denied === true) {
      const reason = String((data as { reason?: string }).reason || '');
      if (reason === 'sign_in_required') {
        return {
          title: 'Shared meeting',
          description: 'Sign in with an authorized email to view this meeting on Wisprnote.',
          denied: true,
        };
      }
      return {
        title: 'Shared meeting',
        description: reason || 'This link is not available.',
        denied: true,
      };
    }

    const m = data.meeting as
      | { filename?: string; summary?: string | null; notes?: string | null }
      | undefined;
    const title = m?.filename?.trim() ? String(m.filename) : 'Shared meeting';
    const summary = m?.summary ? stripMd(String(m.summary)) : '';
    const notes = m?.notes ? stripMd(String(m.notes)) : '';
    let description = (summary || notes || 'Meeting notes and summary shared via Wisprnote.').slice(0, 320);
    if ((summary || notes).length > 320) description += '…';

    return { title, description, denied: false };
  } catch {
    return fallback;
  }
}

export function escapeHtml(s: string | undefined | null): string {
  const t = s == null ? '' : String(s);
  return t
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
