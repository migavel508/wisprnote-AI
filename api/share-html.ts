import type { VercelRequest, VercelResponse } from '@vercel/node';
import { readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { escapeHtml, loadSharePreview } from './_sharePreview.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function tryReadIndexHtml(): string | null {
  const candidates = [
    join(__dirname, 'dist', 'index.html'),
    join(__dirname, '..', 'dist', 'index.html'),
    join(process.cwd(), 'dist', 'index.html'),
  ];
  for (const p of candidates) {
    try { return readFileSync(p, 'utf-8'); } catch {}
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const token = typeof req.query.token === 'string' ? req.query.token : '';
  if (!token) {
    res.status(400).send('Missing share token');
    return;
  }

  const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
  const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
  const siteUrl = (
    process.env.WISPRNOTE_PUBLIC_URL ||
    (host ? `${proto}://${host}` : 'https://www.wisprnote.com')
  ).replace(/\/$/, '');

  const canonical = `${siteUrl}/shared/${encodeURIComponent(token)}`;
  const preview = await loadSharePreview(token);
  const ogImageUrl = `${siteUrl}/wisprnote_url_share.png`;

  const meta = `
    <meta name="description" content="${escapeHtml(preview.description)}" />
    <meta property="og:type" content="article" />
    <meta property="og:site_name" content="Wisprnote AI" />
    <meta property="og:title" content="${escapeHtml(preview.title)}" />
    <meta property="og:description" content="${escapeHtml(preview.description)}" />
    <meta property="og:url" content="${escapeHtml(canonical)}" />
    <meta property="og:image" content="${escapeHtml(ogImageUrl)}" />
    <meta property="og:image:width" content="1200" />
    <meta property="og:image:height" content="630" />
    <meta name="twitter:card" content="summary_large_image" />
    <meta name="twitter:title" content="${escapeHtml(preview.title)}" />
    <meta name="twitter:description" content="${escapeHtml(preview.description)}" />
    <meta name="twitter:image" content="${escapeHtml(ogImageUrl)}" />`;

  const pageTitle = `${escapeHtml(preview.title)} · Wisprnote`;

  const injectInto = (html: string) =>
    html
      .replace('</head>', `${meta}\n  </head>`)
      .replace(/<title>[^<]*<\/title>/, `<title>${pageTitle}</title>`);

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');

  // 1. Read bundled dist/index.html from filesystem (most reliable)
  const fsHtml = tryReadIndexHtml();
  if (fsHtml) {
    res.status(200).send(injectInto(fsHtml));
    return;
  }

  // 2. Fetch index.html from the CDN (fallback)
  try {
    const r = await fetch(`${siteUrl}/index.html`);
    if (r.ok) {
      res.status(200).send(injectInto(await r.text()));
      return;
    }
  } catch {}

  // 3. Last resort: OG tags are present for crawlers; real browsers get a loading page
  //    that fetches and replaces itself with the actual SPA.
  res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${meta}
  <title>${pageTitle}</title>
</head>
<body>
  <div id="root"></div>
  <script>
    fetch('/').then(r=>r.text()).then(h=>{document.open();document.write(h);document.close();}).catch(()=>{});
  </script>
</body>
</html>`);
}
