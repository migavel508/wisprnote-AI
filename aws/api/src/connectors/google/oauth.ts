import { randomBytes, createHash } from 'crypto';
import type { OAuthInflight } from '../../mcp/oauth';

/**
 * Google OAuth 2.0 (auth-code + PKCE) using GOOGLE'S FIXED endpoints — Google has no discoverable MCP
 * server, so we can't use the generic MCP-discovery flow (beginMcpOAuth). We build the authorize URL
 * against a pre-registered operator client (GOOGLE_OAUTH_CLIENT_ID/SECRET) and produce the SAME
 * `OAuthInflight` shape, so `completeMcpOAuth` (token exchange) + the broker's auto-refresh work
 * generically off the `tokenEndpoint` we stash here. `access_type=offline` + `prompt=consent` ensure
 * we get a refresh_token (Google access tokens expire in ~1h).
 */

const AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const b64url = (b: Buffer): string => b.toString('base64url');

export function beginGoogleOAuth(
  client: { clientId: string; clientSecret: string | null },
  scopes: string[],
  redirectUri: string,
): { authorizeUrl: string; inflight: OAuthInflight } {
  const codeVerifier = b64url(randomBytes(32));
  const codeChallenge = b64url(createHash('sha256').update(codeVerifier).digest());
  const state = randomBytes(16).toString('hex');
  const scope = scopes.join(' ');
  const u = new URL(AUTH_URL);
  u.searchParams.set('client_id', client.clientId);
  u.searchParams.set('redirect_uri', redirectUri);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('scope', scope);
  u.searchParams.set('access_type', 'offline');
  u.searchParams.set('include_granted_scopes', 'true');
  u.searchParams.set('prompt', 'consent');
  u.searchParams.set('state', state);
  u.searchParams.set('code_challenge', codeChallenge);
  u.searchParams.set('code_challenge_method', 'S256');
  return {
    authorizeUrl: u.toString(),
    inflight: { state, codeVerifier, clientId: client.clientId, clientSecret: client.clientSecret ?? null, tokenEndpoint: TOKEN_URL, redirectUri, resource: '', scope },
  };
}
