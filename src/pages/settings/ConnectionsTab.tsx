import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, X, ExternalLink } from 'lucide-react';
import { CONNECTORS, CONNECTOR_CATEGORIES, type ConnectorDef } from '../../config/connectors';
import {
  isConnectorsEnabled, listConnectors, getConnectorOAuthUrl, disconnectConnector, setConnectorToken,
  getProjectMapping, setProjectMapping,
  type ConnectorStatus,
} from '../../services/connectorService';
import { getJiraMeta } from '../../services/jiraActionService';
import { getWorkspaces, getFolders, type Workspace, type Folder } from '../../services/workspaceService';
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

interface ConnectionsTabProps {
  /** When set, connections are scoped to this workspace and the picker is hidden
   *  (used by the workspace-level "Integrations" entry). */
  fixedWorkspaceId?: string;
  /** Drop the page chrome (title/padding) so it fits inside a modal. */
  embedded?: boolean;
}

export default function ConnectionsTab({ fixedWorkspaceId, embedded }: ConnectionsTabProps = {}) {
  const [statusById, setStatusById] = useState<Record<string, ConnectorStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Connections are workspace-scoped: pick which workspace to connect tools for.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(null);
  // A fixed workspace (from the workspace page) overrides the in-tab picker.
  const workspaceId = fixedWorkspaceId ?? pickedWorkspaceId;
  const showPicker = !fixedWorkspaceId;

  useEffect(() => {
    if (!isConnectorsEnabled() || fixedWorkspaceId) return;
    void getWorkspaces()
      .then((ws) => { setWorkspaces(ws); setPickedWorkspaceId((prev) => prev ?? ws[0]?.id ?? null); })
      .catch(() => { /* leave empty — falls back to account-level scope */ });
  }, [fixedWorkspaceId]);

  const refresh = useCallback(async () => {
    if (!isConnectorsEnabled()) return;
    const { connectors } = await listConnectors(workspaceId ?? undefined);
    setStatusById(Object.fromEntries(connectors.map((c) => [c.id, c])));
  }, [workspaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Project mapping: scope each PROJECT (folder) to its own Jira project + GitHub repos.
  // mapFolderId = null → the workspace-wide default ("unfiled"); a folder id → that project.
  const [jiraProject, setJiraProject] = useState('');
  const [repoText, setRepoText] = useState('');
  const [jiraProjects, setJiraProjects] = useState<Array<{ key: string; name: string }>>([]);
  const [savingMap, setSavingMap] = useState(false);
  const [mapSaved, setMapSaved] = useState(false);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [mapFolderId, setMapFolderId] = useState<string | null>(null);

  // Load this workspace's folders (projects) for the mapping target picker.
  useEffect(() => {
    if (!workspaceId) { setFolders([]); return; }
    let cancelled = false;
    void getFolders(workspaceId).then((f) => { if (!cancelled) setFolders(f); }).catch(() => {});
    setMapFolderId(null);   // reset to workspace default when switching workspace
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Load the mapping for the currently-selected target (folder or workspace default).
  useEffect(() => {
    if (!isConnectorsEnabled() || !workspaceId) return;
    let cancelled = false;
    void getProjectMapping(workspaceId, mapFolderId).then((m) => {
      if (cancelled) return;
      setJiraProject(m.jiraProject || '');
      setRepoText((m.githubRepos || []).join(', '));
    });
    void getJiraMeta(workspaceId).then((m) => { if (!cancelled && m.connected) setJiraProjects(m.projects); }).catch(() => {});
    return () => { cancelled = true; };
  }, [workspaceId, mapFolderId]);

  const saveMapping = useCallback(async () => {
    if (!workspaceId) return;
    setSavingMap(true); setMapSaved(false);
    if (jiraProject) await setProjectMapping(workspaceId, { source: 'jira', projectKey: jiraProject }, mapFolderId);
    const repos = repoText.split(',').map((s) => s.trim()).filter(Boolean);
    await setProjectMapping(workspaceId, { source: 'github', repos }, mapFolderId);
    setSavingMap(false); setMapSaved(true);
    setTimeout(() => setMapSaved(false), 2500);
  }, [workspaceId, jiraProject, repoText, mapFolderId]);

  // Finish the OAuth round-trip when the deep-link callback fires.
  const onOAuthDone = useCallback((id: string, ok: boolean) => {
    setBusyId(null);
    if (ok) void refresh();
    else console.error('connector_connect_failed', id);
  }, [refresh]);
  useConnectorOAuth(onOAuthDone);

  // PAT-connect modal state (for connectors whose OAuth lacks DCR, e.g. GitHub).
  const [patFor, setPatFor] = useState<ConnectorDef | null>(null);
  const [patToken, setPatToken] = useState('');
  const [patBusy, setPatBusy] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);

  const onConnect = useCallback(async (id: string) => {
    const def = CONNECTORS.find((c) => c.id === id);
    if (def?.connect === 'pat') { setPatError(null); setPatToken(''); setPatFor(def); return; }
    setBusyId(id);
    try {
      setPendingConnector(id);
      const url = await getConnectorOAuthUrl(id, workspaceId ?? undefined);
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
  }, [workspaceId]);

  const submitPat = useCallback(async () => {
    if (!patFor || !patToken.trim()) return;
    setPatBusy(true); setPatError(null);
    const res = await setConnectorToken(patFor.id, patToken.trim(), workspaceId ?? undefined).catch(() => ({ connected: false, error: 'Network error.' }));
    setPatBusy(false);
    if (res.connected) { setPatFor(null); setPatToken(''); void refresh(); }
    else setPatError(res.error || 'Token was rejected.');
  }, [patFor, patToken, workspaceId, refresh]);

  const onDisconnect = useCallback(async (id: string) => {
    setBusyId(id);
    try { await disconnectConnector(id, workspaceId ?? undefined); await refresh(); } finally { setBusyId(null); }
  }, [refresh, workspaceId]);

  return (
    <div className={embedded ? '' : 'max-w-[820px] mx-auto px-8 pb-16'}>
      {!embedded && (
        <h1 className="text-[28px] font-serif text-app-fg tracking-[-0.02em] pt-2 mb-1">Connectors</h1>
      )}
      <p className="text-[13px] text-app-fg-subtle mb-6 max-w-[560px] leading-relaxed">
        Connect the tools your team already uses, so Wisprnote can pull in context and act
        across them. Each tool connects securely through its MCP server.
      </p>

      {isConnectorsEnabled() && showPicker && workspaces.length > 0 && (
        <div className="mb-8 flex items-center gap-3 flex-wrap">
          <label className="text-[11px] font-medium text-app-fg-muted">Workspace</label>
          <select
            value={pickedWorkspaceId ?? ''}
            onChange={(e) => setPickedWorkspaceId(e.target.value || null)}
            className="text-[12.5px] bg-app-panel border border-app-border rounded-lg px-3 py-1.5 text-app-fg outline-none focus:border-app-accent"
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>{w.emoji ? `${w.emoji} ` : ''}{w.name}</option>
            ))}
          </select>
          <span className="text-[11px] text-app-fg-subtle">
            Connections are scoped to this workspace — connect a different account per company.
          </span>
        </div>
      )}

      {isConnectorsEnabled() && workspaceId && (statusById['jira']?.connected || statusById['github']?.connected) && (
        <div className="mb-8 rounded-xl border border-app-border bg-app-panel p-4">
          <div className="text-[12.5px] font-semibold text-app-fg mb-1">Project mapping</div>
          <p className="text-[11.5px] text-app-fg-subtle leading-relaxed mb-3">
            Map each <strong>project (folder)</strong> to its own Jira project + GitHub repos, so the brain keeps
            every project's meetings, tickets and code separate — and a meeting only ever links to the right
            project. Pick a folder below, or “Workspace default” for anything not in a folder.
          </p>
          {/* Which project (folder) this mapping is for — folder = a project; default = unfiled. */}
          <div className="mb-3">
            <span className="text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] mb-1 block">Project (folder)</span>
            <select value={mapFolderId ?? ''} onChange={(e) => setMapFolderId(e.target.value || null)}
              className="w-full text-[12.5px] bg-app-canvas border border-app-border rounded-lg px-2.5 py-1.5 text-app-fg outline-none focus:border-app-accent">
              <option value="">Workspace default (unfiled)</option>
              {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            {statusById['jira']?.connected && (
              <div>
                <span className="text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] mb-1 block">Jira project</span>
                <select value={jiraProject} onChange={(e) => setJiraProject(e.target.value)}
                  className="w-full text-[12.5px] bg-app-canvas border border-app-border rounded-lg px-2.5 py-1.5 text-app-fg outline-none focus:border-app-accent">
                  <option value="">— none —</option>
                  {jiraProjects.map((p) => <option key={p.key} value={p.key}>{p.key} · {p.name}</option>)}
                </select>
              </div>
            )}
            {statusById['github']?.connected && (
              <div>
                <span className="text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] mb-1 block">GitHub repos</span>
                <input value={repoText} onChange={(e) => setRepoText(e.target.value)} placeholder="owner/repo, owner/repo2"
                  className="w-full text-[12.5px] bg-app-canvas border border-app-border rounded-lg px-2.5 py-1.5 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle" />
              </div>
            )}
          </div>
          <div className="flex items-center gap-2 mt-3">
            <button onClick={saveMapping} disabled={savingMap}
              className="px-3 py-1.5 rounded-lg text-[12px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-60 flex items-center gap-1.5">
              {savingMap ? <Loader2 size={12} className="animate-spin" /> : <Check size={12} strokeWidth={2.5} />} Save mapping
            </button>
            {mapSaved && <span className="text-[11.5px] text-app-fg-subtle">Saved — the next sync scopes this workspace to it.</span>}
          </div>
        </div>
      )}

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

      {patFor && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => !patBusy && setPatFor(null)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[440px] max-w-[92vw] p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-[15px] font-semibold text-app-fg">Connect {patFor.name}</h3>
              <button onClick={() => !patBusy && setPatFor(null)} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={15} /></button>
            </div>
            <p className="text-[12px] text-app-fg-subtle leading-relaxed mb-3">
              {patFor.name} connects with a personal access token (its MCP server doesn’t support
              one-click registration yet). Paste a token with the scopes you want the brain to use.
              {patFor.patUrl && (
                <> <a href={patFor.patUrl} target="_blank" rel="noreferrer" className="text-app-accent hover:underline inline-flex items-center gap-0.5">Create a token <ExternalLink size={10} /></a>.</>
              )}
            </p>
            <input
              type="password"
              autoFocus
              value={patToken}
              onChange={(e) => setPatToken(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void submitPat(); }}
              placeholder="Paste token (e.g. github_pat_…)"
              className="w-full text-[12.5px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent"
            />
            {patError && <p className="mt-2 text-[11.5px] text-red-500">{patError}</p>}
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setPatFor(null)} disabled={patBusy} className="px-3 py-1.5 rounded-lg text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg disabled:opacity-50">Cancel</button>
              <button onClick={submitPat} disabled={patBusy || !patToken.trim()} className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-50 flex items-center gap-1.5">
                {patBusy ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.5} />} Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
