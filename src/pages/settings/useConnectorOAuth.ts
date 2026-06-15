import { useEffect } from 'react';
import { exchangeConnector } from '../../services/connectorService';

/**
 * Handles the connector OAuth callback (`wisprnote://connector-callback?code=…&state=…`),
 * mirroring the Google sign-in deep-link handler in Auth.tsx. The connector id isn't
 * in the callback, so we stash it (`pending`) when the connect is initiated and read
 * it back here — surviving an app relaunch via localStorage.
 */

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const PENDING_KEY = 'wn_connector_pending';

export function setPendingConnector(id: string): void {
  try { localStorage.setItem(PENDING_KEY, id); } catch { /* ignore */ }
}
function takePendingConnector(): string | null {
  try { const v = localStorage.getItem(PENDING_KEY); if (v) localStorage.removeItem(PENDING_KEY); return v; } catch { return null; }
}

export function useConnectorOAuth(onDone: (id: string, ok: boolean) => void): void {
  useEffect(() => {
    // Web: provider redirected back with ?code=&state= on this page.
    if (!isTauri) {
      const p = new URLSearchParams(window.location.search);
      const code = p.get('code'); const state = p.get('state');
      const id = code && state ? takePendingConnector() : null;
      if (code && state && id) {
        exchangeConnector(id, code, state)
          .then(() => onDone(id, true))
          .catch(() => onDone(id, false))
          .finally(() => window.history.replaceState({}, document.title, window.location.pathname));
      }
      return;
    }

    // Desktop: deep-link callback.
    let unlisten: (() => void) | undefined;
    const consume = async (url: string) => {
      if (!url.startsWith('wisprnote://connector-callback')) return;
      const id = takePendingConnector();
      try {
        const u = new URL(url);
        const code = u.searchParams.get('code'); const state = u.searchParams.get('state');
        if (!code || !state || !id) return;
        await exchangeConnector(id, code, state);
        onDone(id, true);
      } catch {
        if (id) onDone(id, false);
      }
    };
    (async () => {
      const { onOpenUrl, getCurrent } = await import('@tauri-apps/plugin-deep-link');
      const cur = await getCurrent();
      if (cur?.length) for (const u of cur) await consume(u);
      unlisten = await onOpenUrl(async (urls) => { for (const u of urls) await consume(u); });
    })().catch(() => { /* deep-link init best-effort */ });
    return () => { if (unlisten) unlisten(); };
  }, [onDone]);
}
