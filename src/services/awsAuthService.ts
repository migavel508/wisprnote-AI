import {
  CognitoUserPool,
  CognitoUser,
  AuthenticationDetails,
  CognitoUserSession,
  CognitoUserAttribute,
  ISignUpResult,
  ICognitoStorage,
} from 'amazon-cognito-identity-js';
import { logger } from '../lib/logger';

const log = logger.scope('AWSAuth');

const userPoolId = import.meta.env.VITE_COGNITO_USER_POOL_ID || '';
const clientId = import.meta.env.VITE_COGNITO_CLIENT_ID || '';
const cognitoDomain = import.meta.env.VITE_COGNITO_DOMAIN || '';
const region = import.meta.env.VITE_AWS_REGION || 'us-east-1';

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

export function getGoogleOAuthUrl(redirectUri: string): string {
  const params = new URLSearchParams({
    client_id: clientId,
    response_type: 'code',
    scope: 'openid email profile',
    redirect_uri: redirectUri,
    identity_provider: 'Google',
  });
  return `https://${cognitoDomain}.auth.${region}.amazoncognito.com/oauth2/authorize?${params.toString()}`;
}

export async function exchangeCodeForSession(code: string, redirectUri: string): Promise<AuthSession> {
  const tokenEndpoint = `https://${cognitoDomain}.auth.${region}.amazoncognito.com/oauth2/token`;

  const body = new URLSearchParams({
    grant_type: 'authorization_code',
    client_id: clientId,
    code,
    redirect_uri: redirectUri,
  });

  const resp = await fetch(tokenEndpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token exchange failed: ${text}`);
  }

  const tokens = await resp.json();

  const idPayload = JSON.parse(atob(tokens.id_token.split('.')[1]));
  const session: AuthSession = {
    user: {
      id: idPayload.sub,
      email: idPayload.email || '',
      name: idPayload.name || idPayload.email || '',
    },
    accessToken: tokens.access_token,
    idToken: tokens.id_token,
    refreshToken: tokens.refresh_token,
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
