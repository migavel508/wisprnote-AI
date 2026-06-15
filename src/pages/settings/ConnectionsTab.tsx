import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check } from 'lucide-react';
import { CONNECTORS, CONNECTOR_CATEGORIES, type ConnectorDef } from '../../config/connectors';
import {
  isConnectorsEnabled, listConnectors, getConnectorOAuthUrl, disconnectConnector,
  type ConnectorStatus,
} from '../../services/connectorService';
import { useConnectorOAuth, setPendingConnector } from './useConnectorOAuth';

/**
 * Settings → Connectors. Catalog from `src/config/connectors.ts`. When
 * VITE_CONNECTORS=1 and a connector is `live`, the card runs the real OAuth-via-MCP
 * connect flow (server does DCR+PKCE; we open the URL + handle the deep-link
 * callback). Otherwise it's a disabled "coming soon" card (default, fully dark).
 */

const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;

function ConnectorCard({
  c, connected, busy, onConnect, onDisconnect,
}: {
  c: ConnectorDef; connected: boolean; busy: boolean;
  onConnect: (id: string) => void; onDisconnect: (id: string) => void;
}) {
  const Icon = c.icon;
  const enabled = isConnectorsEnabled();
  const actionable = enabled && c.status === 'live';

  return (
    <div className="rounded-xl border border-app-border bg-app-panel p-4 flex flex-col gap-3 transition-colors hover:border-app-border-strong">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-10 h-10 rounded-lg bg-app-chip border border-app-border flex items-center justify-center text-app-fg-muted flex-shrink-0">
            <Icon size={18} strokeWidth={1.6} />
          </div>
          <div className="min-w-0">
            <div className="text-[14px] font-semibold text-app-fg truncate">{c.name}</div>
            <div className="text-[11px] text-app-fg-subtle">{c.access} · {c.via === 'mcp' ? 'via MCP' : 'Local'}</div>
          </div>
        </div>
        {connected ? (
          <span className="text-[9px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full bg-app-accent/15 text-app-accent border border-app-accent/30 whitespace-nowrap flex items-center gap-1 flex-shrink-0">
            <Check size={10} strokeWidth={2.5} /> Connected
          </span>
        ) : !actionable ? (
          <span className="text-[9px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full bg-app-chip text-app-fg-subtle border border-app-border whitespace-nowrap flex-shrink-0">
            Coming soon
          </span>
        ) : null}
      </div>

      <p className="text-[12.5px] text-app-fg-muted leading-relaxed">{c.description}</p>

      <div className="flex flex-wrap gap-1.5">
        {c.scopes.map((s) => (
          <span key={s} className="text-[10px] px-2 py-0.5 rounded-md bg-app-raised border border-app-border text-app-fg-subtle">{s}</span>
        ))}
      </div>

      {connected ? (
        <button
          onClick={() => onDisconnect(c.id)} disabled={busy}
          className="mt-1 w-full py-2 rounded-lg text-[12px] font-medium bg-app-chip text-app-fg-muted border border-app-border hover:text-app-fg transition-colors disabled:opacity-50"
        >
          {busy ? 'Working…' : 'Disconnect'}
        </button>
      ) : (
        <button
          onClick={() => actionable && onConnect(c.id)} disabled={!actionable || busy}
          className={`mt-1 w-full py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-2 ${
            actionable
              ? 'bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-60'
              : 'bg-app-chip text-app-fg-subtle border border-app-border cursor-not-allowed'
          }`}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {actionable ? (busy ? 'Connecting…' : 'Connect') : 'Connect — coming soon'}
        </button>
      )}
    </div>
  );
}

export default function ConnectionsTab() {
  const [statusById, setStatusById] = useState<Record<string, ConnectorStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!isConnectorsEnabled()) return;
    const { connectors } = await listConnectors();
    setStatusById(Object.fromEntries(connectors.map((c) => [c.id, c])));
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // Finish the OAuth round-trip when the deep-link callback fires.
  const onOAuthDone = useCallback((id: string, ok: boolean) => {
    setBusyId(null);
    if (ok) void refresh();
    else console.error('connector_connect_failed', id);
  }, [refresh]);
  useConnectorOAuth(onOAuthDone);

  const onConnect = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      setPendingConnector(id);
      const url = await getConnectorOAuthUrl(id);
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
      } else {
        window.location.href = url;
      }
      // busy stays until the callback resolves (onOAuthDone) or the user retries.
    } catch (e) {
      setBusyId(null);
      console.error('connector_oauth_url_failed', e);
    }
  }, []);

  const onDisconnect = useCallback(async (id: string) => {
    setBusyId(id);
    try { await disconnectConnector(id); await refresh(); } finally { setBusyId(null); }
  }, [refresh]);

  return (
    <div className="max-w-[820px] mx-auto px-8 pb-16">
      <h1 className="text-[28px] font-serif text-app-fg tracking-[-0.02em] pt-2 mb-1">Connectors</h1>
      <p className="text-[13px] text-app-fg-subtle mb-8 max-w-[560px] leading-relaxed">
        Connect the tools your team already uses, so Wisprnote can pull in context and act
        across them. Each tool connects securely through its MCP server.
      </p>

      <div className="space-y-9">
        {CONNECTOR_CATEGORIES.map((cat) => {
          const items = CONNECTORS.filter((c) => c.category === cat);
          if (!items.length) return null;
          return (
            <section key={cat}>
              <div className="text-[9px] font-mono font-medium text-app-fg-label uppercase tracking-[0.12em] mb-3">{cat}</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {items.map((c) => (
                  <ConnectorCard
                    key={c.id}
                    c={c}
                    connected={!!statusById[c.id]?.connected}
                    busy={busyId === c.id}
                    onConnect={onConnect}
                    onDisconnect={onDisconnect}
                  />
                ))}
              </div>
            </section>
          );
        })}
      </div>
    </div>
  );
}
