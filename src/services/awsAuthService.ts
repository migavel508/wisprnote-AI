import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoIdToken,
  CognitoAccessToken,
  CognitoRefreshToken,
  CognitoUserAttribute,
  ISignUpResult,
  ICognitoStorage,
  ICognitoUserSessionData,
} from 'amazon-cognito-identity-js';
import { logger } from '../lib/logger';

const log = logger.scope('AWSAuth');

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID || '';
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID || '';
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN || '';
const region = import.meta.env.VITE_AWS_REGION || 'us-east-1';
const cognitoClientSecret = import.meta.env.VITE_COGNITO_CLIENT_SECRET || '';
/**
 * Cognito federated provider name for “Continue with Google”.
 * Must match User pool → Sign-in experience → Federated identity provider **name** exactly.
 * Override if yours is not the default `Google`.
 */
function cognitoGoogleIdentityProviderName(): string {
  const fromEnv =
    typeof import.meta.env.VITE_COGNITO_IDENTITY_PROVIDER === 'string'
      ? import.meta.env.VITE_COGNITO_IDENTITY_PROVIDER.trim()
      : '';
  return fromEnv || 'Google';
}

function normalizeCognitoOrigin(raw: string): string {
  let o = raw.trim().replace(/\/+$/, '');
  if (!o) return '';
  if (!/^https?:\/\//i.test(o)) o = `https://${o}`;
  return o;
}

/**
 * Base URL for Hosted UI / Managed login OAuth (no trailing slash).
 * - Prefer VITE_COGNITO_AUTH_ORIGIN (custom domain or regional domain).
 * - If VITE_COGNITO_DOMAIN is a full URL (common misconfig), use it as the origin.
 * - Else treat VITE_COGNITO_DOMAIN as the pool **prefix** only (e.g. wisprnote-auth), not https://auth.example.com.
 */
function cognitoHostedUiOrigin(): string {
  const explicit = normalizeCognitoOrigin(
    typeof import.meta.env.VITE_COGNITO_AUTH_ORIGIN === 'string'
      ? import.meta.env.VITE_COGNITO_AUTH_ORIGIN
      : '',
  );
  if (explicit) return explicit;

  const dom = (cognitoDomain || '').trim();
  if (/^https?:\/\//i.test(dom)) {
    const u = normalizeCognitoOrigin(dom);
    if (u) return u;
  }

  // Bare host without pool prefix pattern, e.g. auth.wisprnote.com
  if (dom && dom.includes('.') && !/\.auth\.[^.]+\.amazoncognito\.com$/i.test(dom) && !/\s/.test(dom)) {
    return normalizeCognitoOrigin(dom);
  }

  const prefix = dom.replace(/^https?:\/\//i, '').split('/')[0]?.replace(/\.auth\..*$/, '') || '';
  if (!prefix) {
    log.error('cognito_hosted_ui_origin_unconfigured', {});
    return '';
  }
  return `https://${prefix}.auth.${region}.amazoncognito.com`;
}

/** PKCE verifier for Hosted UI flows (stored until /oauth2/token exchange). */
const PKCE_STORAGE_KEY = 'wisprnote_cognito_pkce_verifier';

let pkceVerifierMemory: string | null = null;

function storePkceVerifier(verifier: string): void {
  pkceVerifierMemory = verifier;
  try {
    sessionStorage.setItem(PKCE_STORAGE_KEY, verifier);
  } catch {
    /* sessionStorage unavailable – memory fallback only */
  }
}

function takePkceVerifier(): string | null {
  try {
    const v = sessionStorage.getItem(PKCE_STORAGE_KEY);
    if (v) sessionStorage.removeItem(PKCE_STORAGE_KEY);
    if (v) return v;
  } catch { /* ignore */ }
  const m = pkceVerifierMemory;
  pkceVerifierMemory = null;
  return m;
}

function base64UrlEncode(buf: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < buf.length; i++) {
    binary += String.fromCharCode(buf[i]!);
  }
  return btoa(binary)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
}

function randomPkceVerifier(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return base64UrlEncode(bytes);
}

async function pkceChallengeFromVerifier(verifier: string): Promise<string> {
  const data = new TextEncoder().encode(verifier);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', data));
  return base64UrlEncode(hash);
}

// Clear stale Supabase data that fills Tauri WebView localStorage quota
try {
  const keysToRemove: string[] = [];
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i);
    if (key && (key.startsWith('sb-') || key.startsWith('supabase'))) {
      keysToRemove.push(key);
    }
  }
  keysToRemove.forEach(k => localStorage.removeItem(k));
} catch { /* ignore */ }

// In-memory storage fallback for Tauri WebView where localStorage quota is tiny
const memoryStore: Record<string, string> = {};
const cognitoStorage: ICognitoStorage = {
  getItem(key: string): string | null {
    try {
      return localStorage.getItem(key);
    } catch {
      return memoryStore[key] ?? null;
    }
  },
  setItem(key: string, value: string): void {
    try {
      localStorage.setItem(key, value);
    } catch {
      memoryStore[key] = value;
    }
  },
  removeItem(key: string): void {
    try {
      localStorage.removeItem(key);
    } catch { /* ignore */ }
    delete memoryStore[key];
  },
  clear(): void {
    try { localStorage.clear(); } catch { /* ignore */ }
    for (const k of Object.keys(memoryStore)) delete memoryStore[k];
  },
};

const userPool = new CognitoUserPool({
  UserPoolId: userPoolId,
  ClientId: clientId,
  Storage: cognitoStorage,
});

function persistHostedUiTokensToUserPool(tokens: {
  access_token: string;
  id_token: string;
  refresh_token?: string;
}): void {
  const idPayload = JSON.parse(atob(tokens.id_token.split('.')[1])) as Record<string, string>;
  const username = idPayload['cognito:username'] || idPayload.sub;
  const cognitoUser = new CognitoUser({ Username: username, Pool: userPool, Storage: cognitoStorage });
  const data: ICognitoUserSessionData = {
    IdToken: new CognitoIdToken({ IdToken: tokens.id_token }),
    AccessToken: new CognitoAccessToken({ AccessToken: tokens.access_token }),
  };
  if (tokens.refresh_token) {
    data.RefreshToken = new CognitoRefreshToken({ RefreshToken: tokens.refresh_token });
  }
  cognitoUser.setSignInUserSession(new CognitoUserSession(data));
}

export interface AuthSession {
  user: {
    id: string;
    email: string;
    name?: string;
  };
  accessToken: string;
  idToken: string;
  refreshToken: string;
}

type AuthStateCallback = (event: string, session: AuthSession | null) => void;
let authStateListeners: AuthStateCallback[] = [];

function buildSession(cognitoSession: CognitoUserSession, cognitoUser: CognitoUser): AuthSession {
  const idPayload = cognitoSession.getIdToken().decodePayload();
  return {
    user: {
      id: idPayload.sub,
      email: idPayload.email || '',
      name: idPayload.name || idPayload.email || '',
    },
    accessToken: cognitoSession.getAccessToken().getJwtToken(),
    idToken: cognitoSession.getIdToken().getJwtToken(),
    refreshToken: cognitoSession.getRefreshToken().getToken(),
  };
}

function notifyListeners(event: string, session: AuthSession | null) {
  for (const cb of authStateListeners) {
    try { cb(event, session); } catch (e) { log.error('auth_listener_error', { error: e as Error }); }
  }
}

export function onAuthStateChange(callback: AuthStateCallback): { unsubscribe: () => void } {
  authStateListeners.push(callback);
  return {
    unsubscribe: () => {
      authStateListeners = authStateListeners.filter(cb => cb !== callback);
    },
  };
}

export async function getSession(): Promise<AuthSession | null> {
  return new Promise((resolve) => {
    const cognitoUser = userPool.getCurrentUser();
    if (!cognitoUser) {
      resolve(null);
      return;
    }
    cognitoUser.getSession((err: Error | null, session: CognitoUserSession | null) => {
      if (err || !session || !session.isValid()) {
        resolve(null);
        return;
      }
      resolve(buildSession(session, cognitoUser));
    });
  });
}

export async function getIdToken(): Promise<string> {
  const session = await getSession();
  if (!session) throw new Error('User not authenticated');
  return session.idToken;
}

export async function getUserId(): Promise<string> {
  const session = await getSession();
  if (!session) throw new Error('User not authenticated');
  return session.user.id;
}

export async function signUp(email: string, password: string, name?: string): Promise<{ user: any; confirmationRequired: boolean }> {
  return new Promise((resolve, reject) => {
    const attributes: CognitoUserAttribute[] = [
      new CognitoUserAttribute({ Name: 'email', Value: email }),
    ];
    if (name) {
      attributes.push(new CognitoUserAttribute({ Name: 'name', Value: name }));
    }

    userPool.signUp(email, password, attributes, [], (err, result?: ISignUpResult) => {
      if (err) {
        log.error('signup_failed', { error: err });
        reject(err);
        return;
      }
      resolve({
        user: result?.user,
        confirmationRequired: !result?.userConfirmed,
      });
    });
  });
}

export async function confirmSignUp(email: string, code: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool, Storage: cognitoStorage });
    cognitoUser.confirmRegistration(code, true, (err) => {
      if (err) {
        reject(err);
        return;
      }
      resolve();
    });
  });
}

export async function signIn(email: string, password: string): Promise<AuthSession> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool, Storage: cognitoStorage });
    const authDetails = new AuthenticationDetails({ Username: email, Password: password });

    cognitoUser.authenticateUser(authDetails, {
      onSuccess: (session: CognitoUserSession) => {
        const authSession = buildSession(session, cognitoUser);
        notifyListeners('SIGNED_IN', authSession);
        resolve(authSession);
      },
      onFailure: (err: Error) => {
        log.error('signin_failed', { error: err });
        reject(err);
      },
      newPasswordRequired: () => {
        reject(new Error('New password required. Please contact support.'));
      },
    });
  });
}

export async function signOut(): Promise<void> {
  const cognitoUser = userPool.getCurrentUser();
  if (cognitoUser) {
    cognitoUser.signOut();
  }
  notifyListeners('SIGNED_OUT', null);
}

/**
 * Web OAuth redirect_uri — must exactly match a Cognito App client callback URL.
 * Set VITE_WEB_OAUTH_REDIRECT_URI in production (e.g. https://www.wisprnote.com).
 * Falls back to window.location.origin for local dev.
 */
export function getWebOAuthRedirectUri(): string {
  const configured =
    typeof import.meta.env.VITE_WEB_OAUTH_REDIRECT_URI === 'string'
      ? (import.meta.env.VITE_WEB_OAUTH_REDIRECT_URI as string).trim()
      : '';
  if (configured) {
    const noTrail = configured.replace(/\/+$/, '');
    return /^https?:\/\//i.test(noTrail) ? noTrail : `https://${noTrail}`;
  }
  return typeof window !== 'undefined' ? window.location.origin : '';
}

/**
 * Cognito Hosted UI authorize URL with PKCE.
 * Always sets identity_provider so Cognito skips its sign-in page and sends the user straight to Google
 * (your in-app screen stays the only Wisprnote-branded login step before Google’s consent).
 */
export async function getGoogleOAuthUrl(redirectUri: string): Promise<string> {
  const verifier = randomPkceVerifier();
  storePkceVerifier(verifier);
  const challenge = await pkceChallengeFromVerifier(verifier);
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
    code_challenge_method: 'S256',
    code_challenge: challenge,
    identity_provider: cognitoGoogleIdentityProviderName(),
  });
  return `${cognitoHostedUiOrigin()}/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForSession(code: string, redirectUri: string): Promise<AuthSession> {
  const tokenEndpoint = `${cognitoHostedUiOrigin()}/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });

  const codeVerifier = takePkceVerifier();
  if (codeVerifier) {
    body.set('code_verifier', codeVerifier);
  }

  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  const secret = cognitoClientSecret.trim();
  if (secret) {
    const basic = btoa(`${clientId}:${secret}`);
    headers.Authorization = `Basic ${basic}`;
  }

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers,
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    log.error('oauth_token_exchange_failed', { status: resp.status, body: text.slice(0, 500) });
    throw new Error(`Token exchange failed: ${text}`);
  }

  const tokens = (await resp.json()) as {
    access_token: string;
    id_token: string;
    refresh_token?: string;
  };

  persistHostedUiTokensToUserPool(tokens);

  const idPayload = JSON.parse(atob(tokens.id_token.split('.')[1])) as Record<string, string>;
  const session: AuthSession = {
    user: {
      id: idPayload.sub,
      email: idPayload.email || '',
      name: idPayload.name || idPayload.email || '',
    },
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token || '',
  };

  notifyListeners('SIGNED_IN', session);
  return session;
}

export async function forgotPassword(email: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool, Storage: cognitoStorage });
    cognitoUser.forgotPassword({
      onSuccess: () => resolve(),
      onFailure: (err: Error) => reject(err),
    });
  });
}

export async function confirmForgotPassword(email: string, code: string, newPassword: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const cognitoUser = new CognitoUser({ Username: email, Pool: userPool, Storage: cognitoStorage });
    cognitoUser.confirmPassword(code, newPassword, {
      onSuccess: () => resolve(),
      onFailure: (err: Error) => reject(err),
    });
  });
}
