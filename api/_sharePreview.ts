const API_BASE = (process.env.VITE_API_GATEWAY_URL || process.env.API_GATEWAY_URL || '').replace(/\/$/, '');

export interface SharePreview {
  title: string;
  description: string;
}

export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export async function loadSharePreview(token: string): Promise<SharePreview> {
  const fallback: SharePreview = {
    title: 'Meeting Notes',
    description: 'View this meeting summary shared via Wisprnote AI.',
  };

  if (!API_BASE || !token) return fallback;

  try {
    const res = await fetch(`${API_BASE}/shares/verify/${encodeURIComponent(token)}?_=1`);
    if (!res.ok) return fallback;
    const data = await res.json();
    const meeting = data?.meeting;
    if (!meeting) return fallback;

    const title = (meeting.filename || 'Meeting Notes').trim();
    const raw = (meeting.summary || meeting.notes || '')
      .replace(/#{1,6}\s/g, '')
      .replace(/[*_`~]/g, '')
      .replace(/\n+/g, ' ')
      .trim();
    const description =
      raw.length > 200
        ? raw.slice(0, 200) + '…'
        : raw || 'View this meeting summary shared via Wisprnote AI.';

    return { title, description };
  } catch {
    return fallback;
  }
}
