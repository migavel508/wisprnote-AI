import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { escapeHtml, loadSharePreview } from '../lib/sharePreview';

function readBundledIndexHtml(): string | null {
  try {
    const p = join(process.cwd(), 'dist', 'index.html');
    return readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

async function fetchIndexHtml(siteUrl: string): Promise<string | null> {
  const urls = [`${siteUrl}/`, `${siteUrl}/index.html`];
  for (const url of urls) {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12_000);
    try {
      const idxRes = await fetch(url, {
        redirect: 'follow',
        signal: ctrl.signal,
      });
      if (idxRes.ok) {
        const html = await idxRes.text();
        if (html.includes('</head>') && (html.includes('<div id="root"') || html.includes('<script'))) {
          return html;
        }
      }
    } catch {
      /* try next */
    } finally {
      clearTimeout(t);
    }
  }
  return null;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  try {
    const raw = req.query.token;
    const token = typeof raw === 'string' ? raw : Array.isArray(raw) ? String(raw[0] ?? '') : '';
    if (!token) {
      res.status(400).send('Missing share token');
      return;
    }

    const host = (req.headers['x-forwarded-host'] as string) || req.headers.host || '';
    const proto = (req.headers['x-forwarded-proto'] as string) || 'https';
    const siteUrl = (
      process.env.WISPRNOTE_PUBLIC_URL || (host ? `${proto}://${host}` : 'https://www.wisprnote.com')
    ).replace(/\/$/, '');

    const canonical = `${siteUrl}/shared/${encodeURIComponent(token)}`;
    const preview = await loadSharePreview(token);
    const title = preview.title || 'Wisprnote';
    const description = preview.description || '';

    const ogImageUrl = `${siteUrl}/api/og/share/${encodeURIComponent(token)}`;

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

    let html = readBundledIndexHtml();
    if (!html) {
      html = (await fetchIndexHtml(siteUrl)) ?? '';
    }

    if (html && html.includes('</head>')) {
      html = html.replace('</head>', `${meta}</head>`);
      html = html.replace(/<title>[^<]*<\/title>/, `<title>${escapeHtml(title)} · Wisprnote</title>`);
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
      res.status(200).send(html);
      return;
    }

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    res.status(200).send(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  ${meta}
  <title>${escapeHtml(title)} · Wisprnote</title>
</head>
<body>
  <p style="font-family:system-ui;padding:2rem;color:#666">This shared link is only available in the Wisprnote app or full web build. If you are the site owner, ensure <code>dist/index.html</code> is bundled with <code>api/share-html</code> (see <code>vercel.json</code> includeFiles).</p>
</body>
</html>`);
  } catch (err) {
    console.error('share-html error', err);
    res.status(500).send('Share preview failed. Check logs.');
  }
}
