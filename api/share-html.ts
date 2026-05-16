import type { VercelRequest, VercelResponse } from '@vercel/node';
import { escapeHtml, loadSharePreview } from './_sharePreview.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    res.status(400).send('Missing share token');
    return;
  }

  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const siteUrl = (process.env.WISPRNOTE_PUBLIC_URL || (host ? `${proto}://${host}` : 'https://www.wisprnote.com')).replace(
    /\/$/,
    '',
  );

  const canonical = `${siteUrl}/shared/${encodeURIComponent(token)}`;
  const preview = await loadSharePreview(token);
  const title = preview.title;
  const description = preview.description;

  const ogImageUrl = `${siteUrl}/wisprnote_url_share.png`;

  const meta = `
    <meta name="description" content="${escapeHtml(description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Wisprnote" />
    <meta property="og:title" content="${escapeHtml(title)}" />
    <meta property="og:description" content="${escapeHtml(description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(title)}" />
    <meta name="twitter:description" content="${escapeHtml(description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />
  `;

  try {
    const idxRes = await fetch(`${siteUrl}/index.html`);
    if (idxRes.ok) {
      let html = await idxRes.text();
      html = html.replace('</head>', `${meta}</head>`);
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)} · Wisprnote</title>`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      res.status(200).send(html);
      return;
    }
  } catch {
    /* use fallback shell */
  }

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${meta}
  <title>${escapeHtml(title)} · Wisprnote</title>
</head>
<body>
  <div id="root"></div>
  <p style="font-family:system-ui;padding:2rem;color:#666">Loading shared meeting…</p>
  <script type="module" src="/src/main.tsx"></script>
</body>
</html>`);
}
