import { ImageResponse } from '@vercel/og';
import { loadSharePreview } from '../../../lib/sharePreview';

export const config = { runtime: 'edge' };

export default async function handler(request: Request) {
  const url = new URL(request.url);
  const parts = url.pathname.split('/').filter(Boolean);
  const token = decodeURIComponent(parts[parts.length - 1] || '');

  const preview = token ? await loadSharePreview(token) : { title: 'Wisprnote', description: 'Shared meeting notes.', denied: true };
  const title = preview.title.length > 120 ? `${preview.title.slice(0, 117)}…` : preview.title;
  const desc =
    preview.description.length > 420 ? `${preview.description.slice(0, 417)}…` : preview.description;

  return new ImageResponse(
    (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          flexDirection: 'column',
          justifyContent: 'space-between',
          background: 'linear-gradient(165deg, #FAFAF7 0%, #EDEAE4 55%, #E4E1DA 100%)',
          padding: 56,
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, Segoe UI, Helvetica, Arial, sans-serif',
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 28 }}>
          <div
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 20,
              marginBottom: 8,
            }}
          >
            <div
              style={{
                width: 72,
                height: 72,
                borderRadius: 18,
                background: 'linear-gradient(180deg, #f4f4f4 0%, #e8e8e8 100%)',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                border: '1px solid rgba(20,20,20,0.08)',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'flex-end', gap: 5, height: 40 }}>
              <div style={{ width: 7, height: 12, borderRadius: 4, background: '#E8A598' }} />
              <div style={{ width: 7, height: 22, borderRadius: 4, background: '#E8A598' }} />
              <div style={{ width: 7, height: 16, borderRadius: 4, background: '#E8A598' }} />
              <div style={{ width: 7, height: 28, borderRadius: 4, background: '#E8A598' }} />
              <div style={{ width: 7, height: 14, borderRadius: 4, background: '#E8A598' }} />
            </div>
            </div>
            <span style={{ fontSize: 26, fontWeight: 600, color: '#1a1a1a', letterSpacing: -0.5 }}>Wisprnote</span>
          </div>
          <div
            style={{
              fontSize: 52,
              fontWeight: 700,
              color: '#111111',
              lineHeight: 1.12,
              letterSpacing: -1,
              fontFamily: 'Georgia, "Times New Roman", serif',
              maxHeight: 200,
              overflow: 'hidden',
            }}
          >
            {title}
          </div>
          <div
            style={{
              fontSize: 28,
              color: '#4a4a4a',
              lineHeight: 1.45,
              maxHeight: 260,
              overflow: 'hidden',
            }}
          >
            {desc}
          </div>
        </div>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderTop: '2px solid rgba(20,20,20,0.08)',
            paddingTop: 36,
            marginTop: 'auto',
          }}
        >
          <span style={{ fontSize: 24, color: '#333333', fontWeight: 600 }}>Shared via Wisprnote</span>
          <span style={{ fontSize: 22, color: '#666666' }}>wisprnote.com</span>
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
    },
  );
}
