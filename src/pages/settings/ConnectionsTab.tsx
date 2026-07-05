import { useCallback, useEffect, useState } from 'react';
import { Loader2, Check, X, ExternalLink, RefreshCw, FolderOpen, Plus, Plug, ChevronDown } from 'lucide-react';
import { CONNECTORS, CONNECTOR_CATEGORIES, type ConnectorDef } from '../../config/connectors';
import {
  isConnectorsEnabled, listConnectors, getConnectorOAuthUrl, disconnectConnector, setConnectorToken,
  getProjectMapping, setProjectMapping,
  listCustomConnectors, createCustomConnector, deleteCustomConnector, configureConnector,
  type ConnectorStatus,
} from '../../services/connectorService';
import {
  listDevProjects, syncLocalSessions, getPathMappings, setPathMapping,
  type DevProject, type SyncSummary,
} from '../../services/localSessionsService';
import ConnectorToolsModal from '../../components/ConnectorToolsModal';
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
  c, connected, busy, available, onConnect, onConfigure, onDisconnect, onLocalSetup, onManageTools,
}: {
  c: ConnectorDef; connected: boolean; busy: boolean; available?: boolean;
  onConnect: (id: string) => void; onConfigure: (c: ConnectorDef) => void; onDisconnect: (id: string) => void;
  onLocalSetup: (c: ConnectorDef) => void;
  onManageTools: (c: ConnectorDef) => void;
}) {
  const Icon = c.icon;
  const enabled = isConnectorsEnabled();
  // Actionable = endpoint known now (pinned, or the server reports it configured). Otherwise an MCP
  // connector is still CONNECTABLE via bring-your-own endpoint (the reference's `mcp add`): clicking
  // Connect asks for the MCP server URL. Only non-MCP / feature-off cards stay "coming soon".
  const actionable = enabled && (c.status === 'live' || available === true);
  const isLocal = c.via === 'local';
  // Named catalog connectors (Slack, Google, …) are enabled by the OPERATOR: the MCP endpoint +
  // OAuth client live in Secrets, so when configured `available` flips true and Connect runs the
  // browser OAuth flow — the user never pastes an MCP URL or a token. We deliberately do NOT offer
  // the per-user "paste URL + tokens" form on these cards anymore; a genuinely arbitrary server is
  // added through the separate "Add custom connector" flow instead.
  const canConfigure = false;
  const showConnect = actionable || canConfigure;

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
        ) : !showConnect ? (
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

      {isLocal ? (
        <button
          onClick={() => actionable && onLocalSetup(c)} disabled={!actionable}
          className={`mt-1 w-full py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-2 ${
            actionable
              ? (connected
                  ? 'bg-app-chip text-app-fg-muted border border-app-border hover:text-app-fg'
                  : 'bg-app-accent text-app-accent-fg hover:bg-app-accent-hover')
              : 'bg-app-chip text-app-fg-subtle border border-app-border cursor-not-allowed'
          }`}
        >
          {actionable ? (connected ? 'Manage projects' : 'Set up') : 'Set up — coming soon'}
        </button>
      ) : connected ? (
        <div className="mt-1 flex items-center gap-1.5">
          {/* Per-tool permission editor (the trust plane) — only for remote MCP connectors. */}
          <button
            onClick={() => onManageTools(c)}
            className="flex-1 py-2 rounded-lg text-[12px] font-medium bg-app-accent text-app-accent-fg hover:bg-app-accent-hover transition-colors"
          >
            Tool permissions
          </button>
          <button
            onClick={() => onDisconnect(c.id)} disabled={busy}
            className="py-2 px-3 rounded-lg text-[12px] font-medium bg-app-chip text-app-fg-muted border border-app-border hover:text-app-fg transition-colors disabled:opacity-50"
          >
            {busy ? '…' : 'Disconnect'}
          </button>
        </div>
      ) : (
        <button
          onClick={() => { if (busy) return; if (actionable) onConnect(c.id); else if (canConfigure) onConfigure(c); }}
          disabled={!showConnect || busy}
          className={`mt-1 w-full py-2 rounded-lg text-[12px] font-medium transition-colors flex items-center justify-center gap-2 ${
            showConnect
              ? 'bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-60'
              : 'bg-app-chip text-app-fg-subtle border border-app-border cursor-not-allowed'
          }`}
        >
          {busy && <Loader2 size={13} className="animate-spin" />}
          {showConnect ? (busy ? 'Connecting…' : 'Connect') : 'Connect — coming soon'}
        </button>
      )}
    </div>
  );
}

interface ConnectionsTabProps {
  /** When set, connections are scoped to this workspace and the picker is hidden
   *  (used by the workspace-level "Integrations" entry). */
  fixedWorkspaceId?: string;
  /** When set, connections are scoped to this SPACE — connectors are connected INSIDE a space
   *  (the space's Integrations tab). The connection + everything it ingests belong to this space. */
  fixedSpaceId?: string;
  /** Drop the page chrome (title/padding) so it fits inside a modal. */
  embedded?: boolean;
}

export default function ConnectionsTab({ fixedWorkspaceId, fixedSpaceId, embedded }: ConnectionsTabProps = {}) {
  const [statusById, setStatusById] = useState<Record<string, ConnectorStatus>>({});
  const [busyId, setBusyId] = useState<string | null>(null);
  // Connections are workspace-scoped: pick which workspace to connect tools for.
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [pickedWorkspaceId, setPickedWorkspaceId] = useState<string | null>(null);
  // A fixed workspace (from the workspace page) overrides the in-tab picker.
  const workspaceId = fixedWorkspaceId ?? pickedWorkspaceId;
  const spaceId = fixedSpaceId;   // when embedded in a space, all connector ops are space-scoped
  const showPicker = !fixedWorkspaceId;

  useEffect(() => {
    if (!isConnectorsEnabled() || fixedWorkspaceId) return;
    void getWorkspaces()
      .then((ws) => { setWorkspaces(ws); setPickedWorkspaceId((prev) => prev ?? ws[0]?.id ?? null); })
      .catch(() => { /* leave empty — falls back to account-level scope */ });
  }, [fixedWorkspaceId]);

  const refresh = useCallback(async () => {
    if (!isConnectorsEnabled()) return;
    const { connectors } = await listConnectors(workspaceId ?? undefined, spaceId ?? undefined);
    setStatusById(Object.fromEntries(connectors.map((c) => [c.id, c])));
  }, [workspaceId, spaceId]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Re-check status whenever the app regains focus (e.g. returning from the OAuth browser tab), so a
  // server-side-completed connection shows up without needing the deep-link callback.
  useEffect(() => {
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refresh]);

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
  const [toolsFor, setToolsFor] = useState<ConnectorDef | null>(null);   // per-tool permission editor
  const [patToken, setPatToken] = useState('');
  const [patBusy, setPatBusy] = useState(false);
  const [patError, setPatError] = useState<string | null>(null);

  // Custom connectors (user-added remote MCP servers — "Add custom connector").
  const [customConns, setCustomConns] = useState<import('../../services/connectorService').CustomConnector[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addName, setAddName] = useState('');
  const [addUrl, setAddUrl] = useState('');
  const [addAdvOpen, setAddAdvOpen] = useState(false);
  const [addClientId, setAddClientId] = useState('');
  const [addClientSecret, setAddClientSecret] = useState('');
  const [adding, setAdding] = useState(false);
  const [addError, setAddError] = useState<string | null>(null);

  // BYO-endpoint configure dialog for a catalog connector (Slack/Gmail/…).
  const [configFor, setConfigFor] = useState<ConnectorDef | null>(null);
  const [configUrl, setConfigUrl] = useState('');
  const [configAdvOpen, setConfigAdvOpen] = useState(false);
  const [configClientId, setConfigClientId] = useState('');
  const [configClientSecret, setConfigClientSecret] = useState('');
  const [configuring, setConfiguring] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const loadCustom = useCallback(() => { if (workspaceId) void listCustomConnectors(workspaceId).then(setCustomConns).catch(() => {}); else setCustomConns([]); }, [workspaceId]);
  useEffect(() => { loadCustom(); }, [loadCustom]);

  // Local dev-session (Claude Code / Codex) setup — machine-local path→folder mapping + sync.
  const [localOpen, setLocalOpen] = useState(false);
  const [localLoading, setLocalLoading] = useState(false);
  const [devProjects, setDevProjects] = useState<DevProject[]>([]);
  const [localMap, setLocalMap] = useState<Record<string, string>>({});
  const [localBusy, setLocalBusy] = useState(false);
  const [localSummary, setLocalSummary] = useState<SyncSummary | null>(null);

  // Keep the card's "configured" badge in sync with the stored mapping for this workspace.
  useEffect(() => { setLocalMap(workspaceId ? getPathMappings(workspaceId) : {}); }, [workspaceId]);

  const openLocalSetup = useCallback(async (_c: ConnectorDef) => {
    if (!workspaceId) return;
    setLocalSummary(null);
    setLocalMap(getPathMappings(workspaceId));
    void getFolders(workspaceId).then(setFolders).catch(() => {});
    setLocalOpen(true);
    setLocalLoading(true);
    const ps = await listDevProjects();
    setDevProjects(ps);
    setLocalLoading(false);
  }, [workspaceId]);

  const assignLocalFolder = useCallback((path: string, folderId: string | null) => {
    if (!workspaceId) return;
    setPathMapping(workspaceId, path, folderId);
    setLocalMap(getPathMappings(workspaceId));
  }, [workspaceId]);

  const runLocalSync = useCallback(async () => {
    if (!workspaceId) return;
    setLocalBusy(true);
    try { setLocalSummary(await syncLocalSessions(workspaceId)); }
    finally { setLocalBusy(false); }
  }, [workspaceId]);

  const localConfigured = Object.keys(localMap).length > 0;
  const basename = (p: string) => p.replace(/\/+$/, '').split('/').filter(Boolean).pop() || p;
  // Group detected projects by cwd (a path may have both Claude Code AND Codex sessions).
  const projectRows = Object.values(
    devProjects.reduce((acc, p) => {
      const e = acc[p.cwd] || (acc[p.cwd] = { cwd: p.cwd, sessionCount: 0, tools: [] as string[] });
      e.sessionCount += p.sessionCount;
      const label = p.source === 'claude-code' ? 'Claude Code' : 'Codex';
      if (!e.tools.includes(label)) e.tools.push(label);
      return acc;
    }, {} as Record<string, { cwd: string; sessionCount: number; tools: string[] }>),
  ).sort((a, b) => b.sessionCount - a.sessionCount);

  const onConnect = useCallback(async (id: string) => {
    const def = CONNECTORS.find((c) => c.id === id);
    if (def?.connect === 'pat') { setPatError(null); setPatToken(''); setPatFor(def); return; }
    setBusyId(id);
    try {
      setPendingConnector(id);
      const url = await getConnectorOAuthUrl(id, workspaceId ?? undefined, spaceId ?? undefined);
      if (isTauri) {
        const { open } = await import('@tauri-apps/plugin-shell');
        await open(url);
        // OAuth completes SERVER-SIDE (the browser shows "Connected"); the wisprnote:// deep link is
        // unreliable, so we POLL connection status to clear the spinner once the token lands — rather
        // than waiting on the deep-link callback (which may never fire). Gives up after 3 min.
        const startedAt = Date.now();
        const poll = async () => {
          if (Date.now() - startedAt > 180_000) { setBusyId((b) => (b === id ? null : b)); return; }
          try {
            const { connectors } = await listConnectors(workspaceId ?? undefined, spaceId ?? undefined);
            setStatusById(Object.fromEntries(connectors.map((c) => [c.id, c])));
            if (connectors.find((c) => c.id === id)?.connected) { setBusyId((b) => (b === id ? null : b)); return; }
          } catch { /* keep polling */ }
          window.setTimeout(poll, 2500);
        };
        window.setTimeout(poll, 3000);
      } else {
        window.location.href = url;
      }
    } catch (e) {
      setBusyId(null);
      console.error('connector_oauth_url_failed', e);
    }
  }, [workspaceId, spaceId]);

  const submitPat = useCallback(async () => {
    if (!patFor || !patToken.trim()) return;
    setPatBusy(true); setPatError(null);
    const res = await setConnectorToken(patFor.id, patToken.trim(), workspaceId ?? undefined, spaceId ?? undefined).catch(() => ({ connected: false, error: 'Network error.' }));
    setPatBusy(false);
    if (res.connected) { setPatFor(null); setPatToken(''); void refresh(); }
    else setPatError(res.error || 'Token was rejected.');
  }, [patFor, patToken, workspaceId, spaceId, refresh]);

  const onDisconnect = useCallback(async (id: string) => {
    setBusyId(id);
    try {
      // Custom connectors are removed entirely (delete the definition + its token); built-ins just disconnect.
      if (id.startsWith('custom-')) { if (workspaceId) await deleteCustomConnector(workspaceId, id); loadCustom(); await refresh(); }
      else { await disconnectConnector(id, workspaceId ?? undefined, spaceId ?? undefined); await refresh(); }
    } finally { setBusyId(null); }
  }, [refresh, workspaceId, spaceId, loadCustom]);

  const submitAddCustom = useCallback(async () => {
    if (!workspaceId || !addName.trim() || !addUrl.trim() || adding) return;
    setAdding(true); setAddError(null);
    try {
      const r = await createCustomConnector(workspaceId, {
        name: addName.trim(), url: addUrl.trim(),
        oauthClientId: addClientId.trim() || undefined, oauthClientSecret: addClientSecret.trim() || undefined,
      });
      setAddOpen(false); setAddName(''); setAddUrl(''); setAddClientId(''); setAddClientSecret(''); setAddAdvOpen(false);
      await refresh(); loadCustom();
      if (r.needsAuth) onConnect(r.slug);   // server says auth needed → kick off the OAuth sign-in
    } catch (e: any) { setAddError(e?.message || 'Could not add the connector.'); }
    finally { setAdding(false); }
  }, [workspaceId, addName, addUrl, addClientId, addClientSecret, adding, refresh, loadCustom, onConnect]);

  const openConfigure = useCallback((c: ConnectorDef) => {
    setConfigError(null); setConfigUrl(''); setConfigClientId(''); setConfigClientSecret(''); setConfigAdvOpen(false);
    setConfigFor(c);
  }, []);

  const submitConfigure = useCallback(async () => {
    if (!configFor || !configUrl.trim() || configuring) return;
    setConfiguring(true); setConfigError(null);
    try {
      const id = configFor.id;
      const res = await configureConnector(id, {
        url: configUrl.trim(),
        oauthClientId: configClientId.trim() || undefined, oauthClientSecret: configClientSecret.trim() || undefined,
      }, workspaceId ?? undefined);
      setConfigFor(null); setConfigUrl(''); setConfigClientId(''); setConfigClientSecret(''); setConfigAdvOpen(false);
      await refresh();
      if (res.needsAuth) onConnect(id);   // endpoint stored → kick off the OAuth sign-in
    } catch (e: any) { setConfigError(e?.message || 'Could not configure the connector.'); }
    finally { setConfiguring(false); }
  }, [configFor, configUrl, configClientId, configClientSecret, configuring, workspaceId, refresh, onConnect]);

  // Map stored custom connectors → ConnectorDef so they render with the SAME card + connect/tools logic.
  const customDefs: ConnectorDef[] = customConns.map((cc) => ({
    id: cc.slug, name: cc.name, description: cc.url, category: 'Custom connectors',
    access: 'Read + Write', status: 'live', via: 'mcp', docs: cc.url, icon: Plug, scopes: ['Custom MCP server'],
  }));

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
                    connected={c.via === 'local' ? localConfigured : !!statusById[c.id]?.connected}
                    busy={busyId === c.id}
                    available={statusById[c.id]?.available}
                    onConnect={onConnect}
                    onConfigure={openConfigure}
                    onDisconnect={onDisconnect}
                    onLocalSetup={openLocalSetup}
                    onManageTools={setToolsFor}
                  />
                ))}
              </div>
            </section>
          );
        })}

        {isConnectorsEnabled() && workspaceId && (
          <section>
            <div className="flex items-center justify-between mb-3">
              <div className="text-[9px] font-mono font-medium text-app-fg-label uppercase tracking-[0.12em]">Custom connectors</div>
              <button onClick={() => { setAddError(null); setAddOpen(true); }} className="flex items-center gap-1.5 text-[11.5px] font-medium text-app-accent hover:opacity-80">
                <Plus size={13} /> Add custom connector
              </button>
            </div>
            {customDefs.length === 0 ? (
              <p className="text-[12px] text-app-fg-subtle leading-relaxed">Connect any remote MCP server by URL — its tools are discovered automatically and governed by the same per-tool permissions.</p>
            ) : (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {customDefs.map((c) => (
                  <ConnectorCard
                    key={c.id} c={c}
                    connected={!!statusById[c.id]?.connected}
                    busy={busyId === c.id}
                    onConnect={onConnect} onConfigure={openConfigure} onDisconnect={onDisconnect}
                    onLocalSetup={openLocalSetup} onManageTools={setToolsFor}
                  />
                ))}
              </div>
            )}
          </section>
        )}
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

      {localOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => !localBusy && setLocalOpen(false)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[580px] max-w-[94vw] max-h-[82vh] flex flex-col p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-[15px] font-semibold text-app-fg">Local dev sessions</h3>
              <button onClick={() => !localBusy && setLocalOpen(false)} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={15} /></button>
            </div>
            <p className="text-[12px] text-app-fg-subtle leading-relaxed mb-3">
              Map each local project to a workspace folder. Only mapped projects are read into the brain — and your
              transcripts never leave this machine; only a short, redacted summary of each session is uploaded.
            </p>
            <div className="flex-1 overflow-y-auto -mx-1 px-1">
              {localLoading ? (
                <div className="py-10 flex items-center justify-center gap-2 text-[12.5px] text-app-fg-subtle"><Loader2 size={14} className="animate-spin" /> Scanning local sessions…</div>
              ) : projectRows.length === 0 ? (
                <p className="py-10 text-center text-[12.5px] text-app-fg-subtle">No Claude Code or Codex sessions found on this machine.</p>
              ) : (
                <div className="space-y-1.5">
                  {projectRows.map((p) => (
                    <div key={p.cwd} className="flex items-center gap-3 rounded-lg border border-app-border bg-app-panel px-3 py-2">
                      <FolderOpen size={15} className="text-app-fg-subtle flex-shrink-0" />
                      <div className="min-w-0 flex-1">
                        <div className="text-[12.5px] text-app-fg truncate">{basename(p.cwd)}</div>
                        <div className="text-[10.5px] text-app-fg-subtle truncate">{p.cwd}</div>
                      </div>
                      <span className="text-[10px] text-app-fg-subtle whitespace-nowrap">{p.tools.join(' · ')} · {p.sessionCount}</span>
                      <select value={localMap[p.cwd] || ''} onChange={(e) => assignLocalFolder(p.cwd, e.target.value || null)}
                        className="text-[12px] bg-app-canvas border border-app-border rounded-lg px-2 py-1 text-app-fg outline-none focus:border-app-accent max-w-[170px]">
                        <option value="">— Don’t ingest —</option>
                        {folders.map((f) => <option key={f.id} value={f.id}>{f.name}</option>)}
                      </select>
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div className="flex items-center justify-between gap-3 mt-3 pt-3 border-t border-app-border">
              <div className="text-[11.5px] text-app-fg-subtle min-w-0">
                {localSummary ? (
                  <>Uploaded {localSummary.upserted} session{localSummary.upserted === 1 ? '' : 's'} from {localSummary.mappedProjects} project{localSummary.mappedProjects === 1 ? '' : 's'}.
                  {(localSummary.skippedCompressed > 0 || localSummary.skippedLarge > 0) && <> Skipped {localSummary.skippedCompressed} compressed, {localSummary.skippedLarge} oversized.</>}</>
                ) : folders.length === 0 ? 'Create a folder in this workspace first, then map projects to it.' : 'Folders come from this workspace. Changes save automatically.'}
              </div>
              <button onClick={runLocalSync} disabled={localBusy || !localConfigured}
                className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-50 flex items-center gap-1.5 whitespace-nowrap">
                {localBusy ? <Loader2 size={13} className="animate-spin" /> : <RefreshCw size={13} />} Sync now
              </button>
            </div>
          </div>
        </div>
      )}

      {toolsFor && workspaceId && (
        <ConnectorToolsModal
          connectorId={toolsFor.id}
          connectorName={toolsFor.name}
          workspaceId={workspaceId}
          onClose={() => setToolsFor(null)}
        />
      )}

      {addOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => !adding && setAddOpen(false)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[560px] max-w-[94vw] max-h-[88vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-[15px] font-semibold text-app-fg flex items-center gap-2">Add custom connector <span className="text-[9px] font-mono uppercase tracking-wider px-1.5 py-0.5 rounded bg-app-chip text-app-fg-subtle">Beta</span></h3>
              <button onClick={() => !adding && setAddOpen(false)} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={15} /></button>
            </div>
            <p className="text-[12px] text-app-fg-subtle leading-relaxed mb-4">Connect to any remote MCP server. Its tools are discovered automatically and governed by per-tool permissions. Only add connectors from developers you trust.</p>

            <input autoFocus value={addName} onChange={(e) => setAddName(e.target.value)} placeholder="Name"
              className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle mb-2.5" />
            <input value={addUrl} onChange={(e) => setAddUrl(e.target.value)} placeholder="Remote MCP server URL (https://…)"
              className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle mb-3" />

            <button onClick={() => setAddAdvOpen((v) => !v)} className="flex items-center gap-1 text-[12.5px] text-app-fg-muted hover:text-app-fg mb-2">
              <ChevronDown size={14} className={`transition-transform ${addAdvOpen ? 'rotate-180' : ''}`} /> Advanced settings
            </button>
            {addAdvOpen && (
              <div className="space-y-2.5 mb-3">
                <input value={addClientId} onChange={(e) => setAddClientId(e.target.value)} placeholder="OAuth Client ID (optional)"
                  className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle" />
                <input type="password" value={addClientSecret} onChange={(e) => setAddClientSecret(e.target.value)} placeholder="OAuth Client Secret (optional)"
                  className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle" />
                <p className="text-[11px] text-app-fg-subtle leading-relaxed">Leave blank to auto-register (DCR). Provide a Client ID for servers that need a pre-registered OAuth app. No-auth servers connect on Add.</p>
              </div>
            )}

            {addError && <p className="text-[11.5px] text-red-500 mb-2">{addError}</p>}
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={() => setAddOpen(false)} disabled={adding} className="px-3 py-1.5 rounded-lg text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg disabled:opacity-50">Cancel</button>
              <button onClick={submitAddCustom} disabled={adding || !addName.trim() || !/^https:\/\//i.test(addUrl.trim())}
                className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-50 flex items-center gap-1.5">
                {adding ? <Loader2 size={13} className="animate-spin" /> : <Plus size={13} />} Add
              </button>
            </div>
          </div>
        </div>
      )}

      {configFor && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => !configuring && setConfigFor(null)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[560px] max-w-[94vw] max-h-[88vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-1">
              <h3 className="text-[15px] font-semibold text-app-fg">Connect {configFor.name}</h3>
              <button onClick={() => !configuring && setConfigFor(null)} className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={15} /></button>
            </div>
            <p className="text-[12px] text-app-fg-subtle leading-relaxed mb-4">
              {configFor.name} connects through your own MCP server endpoint. Paste its URL below — its tools are discovered automatically and governed by per-tool permissions.
              {configFor.docs && (
                <> <a href={configFor.docs} target="_blank" rel="noreferrer" className="text-app-accent hover:underline inline-flex items-center gap-0.5">Setup guide <ExternalLink size={10} /></a>.</>
              )}
            </p>

            <input autoFocus value={configUrl} onChange={(e) => setConfigUrl(e.target.value)} placeholder="MCP server URL (https://…)"
              className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle mb-3" />

            <button onClick={() => setConfigAdvOpen((v) => !v)} className="flex items-center gap-1 text-[12.5px] text-app-fg-muted hover:text-app-fg mb-2">
              <ChevronDown size={14} className={`transition-transform ${configAdvOpen ? 'rotate-180' : ''}`} /> Advanced settings
            </button>
            {configAdvOpen && (
              <div className="space-y-2.5 mb-3">
                <input value={configClientId} onChange={(e) => setConfigClientId(e.target.value)} placeholder="OAuth Client ID (optional)"
                  className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle" />
                <input type="password" value={configClientSecret} onChange={(e) => setConfigClientSecret(e.target.value)} placeholder="OAuth Client Secret (optional)"
                  className="w-full text-[13px] bg-app-panel border border-app-border rounded-lg px-3 py-2 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle" />
                <p className="text-[11px] text-app-fg-subtle leading-relaxed">Leave blank to auto-register (DCR). Google and Slack need a pre-registered OAuth app — provide its Client ID/Secret here.</p>
              </div>
            )}

            {configError && <p className="text-[11.5px] text-red-500 mb-2">{configError}</p>}
            <div className="flex justify-end gap-2 mt-2">
              <button onClick={() => setConfigFor(null)} disabled={configuring} className="px-3 py-1.5 rounded-lg text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg disabled:opacity-50">Cancel</button>
              <button onClick={submitConfigure} disabled={configuring || !/^https:\/\//i.test(configUrl.trim())}
                className="px-3.5 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-50 flex items-center gap-1.5">
                {configuring ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} />} Connect
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
