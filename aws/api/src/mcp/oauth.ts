import { randomBytes, createHash } from 'crypto';
import type { McpServer } from './registry';

/**
 * Generic MCP OAuth (OAuth 2.1 + PKCE + Dynamic Client Registration), per the MCP
 * authorization spec. Reusable for ANY DCR-based MCP server (Atlassian, GitHub,
 * Google, …) — discover → register → authorize (PKCE) → token exchange.
 *
 * No pre-registered app / client secret: the client is registered dynamically at
 * runtime. Verified against a live server in this phase (needs real consent).
 */

export interface OAuthInflight {
  state: string;
  codeVerifier: string;
  clientId: string;
  clientSecret: string | null;
  tokenEndpoint: string;
  redirectUri: string;
  resource: string;
  scope: string;
}

function b64url(buf: Buffer): string { return buf.toString('base64url'); }

async function getJson(url: string): Promise<any | null> {
  try {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    return r.ok ? await r.json() : null;
  } catch { return null; }
}

interface AuthMeta { registration_endpoint?: string; authorization_endpoint: string; token_endpoint: string; scopes_supported?: string[] }

/**
 * Discover the authorization server + its endpoints for an MCP server.
 * RFC 9728 (protected-resource metadata) → RFC 8414 (AS metadata), with the 401
 * `WWW-Authenticate: resource_metadata=…` probe + sensible fallbacks.
 */
export async function discoverMcpAuth(mcpUrl: string): Promise<AuthMeta> {
  const origin = new URL(mcpUrl).origin;

  // 1) protected-resource metadata → authorization server URL
  let prm = await getJson(`${origin}/.well-known/oauth-protected-resource`);
  if (!prm) {
    // probe: an unauthenticated MCP call should 401 with a resource_metadata pointer
    try {
      const r = await fetch(mcpUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
      const wmA = r.headers.get('www-authenticate') || '';
      const m = wmA.match(/resource_metadata="?([^",\s]+)"?/i);
      if (m) prm = await getJson(m[1]);
    } catch { /* ignore */ }
  }
  const asUrl: string =
    (Array.isArray(prm?.authorization_servers) && prm.authorization_servers[0]) || origin;

  // 2) authorization server metadata (RFC 8414, OIDC fallback)
  const meta =
    (await getJson(`${asUrl.replace(/\/$/, '')}/.well-known/oauth-authorization-server`)) ||
    (await getJson(`${asUrl.replace(/\/$/, '')}/.well-known/openid-configuration`));
  if (!meta?.authorization_endpoint || !meta?.token_endpoint) {
    throw new Error(`MCP auth discovery failed for ${mcpUrl} (asUrl=${asUrl})`);
  }
  return {
    registration_endpoint: meta.registration_endpoint,
    authorization_endpoint: meta.authorization_endpoint,
    token_endpoint: meta.token_endpoint,
    scopes_supported: meta.scopes_supported,
  };
}

/** RFC 7591 Dynamic Client Registration. Public client (PKCE, no secret) by default. */
async function dcrRegister(regEndpoint: string, redirectUri: string, scope: string): Promise<{ client_id: string; client_secret: string | null }> {
  const r = await fetch(regEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      client_name: 'Wisprnote',
      redirect_uris: [redirectUri],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
      scope,
    }),
  });
  if (!r.ok) throw new Error(`DCR failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (!j.client_id) throw new Error('DCR response missing client_id');
  return { client_id: j.client_id, client_secret: j.client_secret ?? null };
}

/** Begin the flow: discover → DCR → build the PKCE authorize URL. */
export async function beginMcpOAuth(server: McpServer, redirectUri: string): Promise<{ authorizeUrl: string; inflight: OAuthInflight }> {
  if (!server.url) throw new Error(`MCP server ${server.id} has no endpoint`);
  const meta = await discoverMcpAuth(server.url);
  if (!meta.registration_endpoint) throw new Error(`MCP server ${server.id} does not advertise DCR (registration_endpoint)`);

  const scope = [...new Set([...(server.scopes ?? []), 'offline_access'])].join(' ');
  const { client_id, client_secret } = await dcrRegister(meta.registration_endpoint, redirectUri, scope);

  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const state = randomBytes(16).toString('hex');

  const u = new URL(meta.authorization_endpoint);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('client_id', client_id);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('scope', scope);
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('resource', server.url); // RFC 8707 resource indicator (the MCP server)

  return {
    authorizeUrl: u.toString(),
    inflight: { state, codeVerifier, clientId: client_id, clientSecret: client_secret, tokenEndpoint: meta.token_endpoint, redirectUri, resource: server.url, scope },
  };
}

export interface OAuthToken { access_token: string; refresh_token?: string; expires_in?: number; token_type?: string; raw: any }

/** Complete the flow: exchange the authorization code for tokens. */
export async function completeMcpOAuth(f: OAuthInflight, code: string): Promise<OAuthToken> {
  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    code,
    redirect_uri: f.redirectUri,
    client_id: f.clientId,
    code_verifier: f.codeVerifier,
    resource: f.resource,
  });
  if (f.clientSecret) body.set('client_secret', f.clientSecret);
  const r = await fetch(f.tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: body.toString(),
  });
  if (!r.ok) throw new Error(`Token exchange failed: ${r.status} ${(await r.text()).slice(0, 200)}`);
  const j: any = await r.json();
  if (!j.access_token) throw new Error('Token response missing access_token');
  return { access_token: j.access_token, refresh_token: j.refresh_token, expires_in: j.expires_in, token_type: j.token_type, raw: j };
}
