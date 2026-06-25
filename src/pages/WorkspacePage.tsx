import { useState, useEffect, useRef } from 'react';
import {
  Plus, MoreHorizontal, X, Loader2, FileText, Mic, Star, Pencil, Trash2,
  UserPlus, FolderPlus, Lock, ChevronDown, Cable, Link2, ChevronLeft,
  Folder as FolderIcon, Search, Paperclip,
} from 'lucide-react';
import {
  Workspace, Folder as FolderType, WorkspaceMeeting, Space,
  isDefaultWorkspace,
  deleteFolder, renameFolder,
  getFolderMeetings,
  getWorkspaceDescription, setWorkspaceDescription,
  getWorkspaceImage, getAvatarGradient,
  getSpaces, getSpaceFolders, getSpaceMeetings, createFolderInSpace,
  updateSpace, deleteSpace, moveNoteToSpace,
} from '../services/workspaceService';
import { setWorkspaceSelection, useWorkspaceSelection } from '../services/workspaceSelection';
import type { TaskHistory } from '../services/awsService';
import { getTaskById, getWorkspaceKnowledgeGraph } from '../services/awsService';
import WorkspaceChat from '../components/WorkspaceChat';
import { onVaultEvent } from '../lib/vaultEvents';
import type { SearchableMeeting } from '../services/geminiService';
import type { KGLite } from '../services/meetingEvidence';
import CreateFolderModal, { type FolderDraft } from '../components/CreateFolderModal';
import ConnectionsTab from './settings/ConnectionsTab';
import { isConnectorsEnabled } from '../services/connectorService';
import JiraActionCard from '../components/JiraActionCard';
import BrainMapModal from '../components/BrainMapModal';
import { listProposals, resolveProposal, type ProposalRow } from '../services/proposalService';
import { getJiraMeta, type JiraMeta } from '../services/jiraActionService';
import { Sparkles, BrainCircuit } from 'lucide-react';

// ── helpers ───────────────────────────────────────────────────────────────────

function groupByDate(meetings: WorkspaceMeeting[]) {
  const groups: { label: string; items: WorkspaceMeeting[] }[] = [];
  const map = new Map<string, WorkspaceMeeting[]>();
  const today = new Date();
  const yesterday = new Date(today); yesterday.setDate(today.getDate() - 1);
  for (const m of meetings) {
    const d = new Date(m.created_at);
    let label: string;
    if (d.toDateString() === today.toDateString()) label = 'Today';
    else if (d.toDateString() === yesterday.toDateString()) label = 'Yesterday';
    else label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(m);
  }
  map.forEach((items, label) => groups.push({ label, items }));
  return groups;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// ── Folder icon ───────────────────────────────────────────────────────────────

function FolderGlyph({ folder, size = 32 }: { folder: FolderType; size?: number }) {
  if (folder.iconType === 'emoji' && folder.emoji) {
    return (
      <div className="rounded-xl flex items-center justify-center bg-app-nav-hover-bg" style={{ width: size, height: size }}>
        <span style={{ fontSize: size * 0.55, lineHeight: 1 }}>{folder.emoji}</span>
      </div>
    );
  }
  const color = folder.color || '#6b7280';
  return (
    <div
      className="rounded-xl flex items-center justify-center"
      style={{ width: size, height: size, background: `${color}22` }}
    >
      <FolderIcon size={size * 0.5} strokeWidth={1.7} style={{ color }} />
    </div>
  );
}

// ── Workspace glyph ───────────────────────────────────────────────────────────

function WorkspaceGlyph({ ws, size = 32 }: { ws: Workspace; size?: number }) {
  if (isDefaultWorkspace(ws)) {
    return (
      <div className="rounded-xl bg-app-nav-hover-bg flex items-center justify-center" style={{ width: size, height: size }}>
        <Lock size={size * 0.45} strokeWidth={1.7} className="text-app-fg-muted" />
      </div>
    );
  }
  const image = getWorkspaceImage(ws.id);
  if (image) {
    return (
      <div className="rounded-xl overflow-hidden flex-shrink-0" style={{ width: size, height: size }}>
        <img src={image} alt={ws.name} className="w-full h-full object-cover" />
      </div>
    );
  }
  const initial = (ws.name.charAt(0) || '?').toUpperCase();
  const [c1, c2, c3] = getAvatarGradient(ws.name || 'workspace');
  return (
    <div
      className="rounded-xl flex items-center justify-center text-white font-semibold overflow-hidden"
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${c1} 0%, ${c2} 55%, ${c3} 100%)`,
        fontSize: size * 0.42,
      }}
    >
      {initial}
    </div>
  );
}

// ── Folder picker dropdown for a note row ─────────────────────────────────────

export function FolderPicker({
  workspaces, foldersByWs, currentWsId, currentFolderId,
  onSelectWorkspace, onSelectFolder, onCreateFolder,
}: {
  workspaces: Workspace[];
  foldersByWs: Record<string, FolderType[]>;
  currentWsId: string | null;
  currentFolderId: string | null;
  onSelectWorkspace: (wsId: string) => void;
  onSelectFolder: (wsId: string, folderId: string) => void;
  onCreateFolder: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const popRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (popRef.current && !popRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [open]);

  const currentWs = workspaces.find(w => w.id === currentWsId);
  const currentFolder = currentFolderId
    ? (foldersByWs[currentWsId || ''] || []).find(f => f.id === currentFolderId)
    : null;
  // When the note is at workspace root inside "My notes", show "Private" badge with lock.
  const isPrivateRoot = !currentFolder && currentWs && isDefaultWorkspace(currentWs);
  const label = currentFolder?.name || (isPrivateRoot ? 'Private' : currentWs?.name) || 'Move…';

  const q = query.toLowerCase();

  return (
    <div className="relative" ref={popRef}>
      <button
        onClick={e => { e.stopPropagation(); setOpen(v => !v); }}
        title={label}
        className={`flex items-center rounded-full text-[12px] text-app-fg-muted transition-all duration-150 ${
          open
            ? 'pl-1 pr-2 py-0.5 bg-app-nav-active-bg'
            : 'p-0.5 group-hover:pl-1 group-hover:pr-2 group-hover:py-0.5 group-hover:bg-app-nav-active-bg'
        }`}
      >
        {currentFolder ? (
          <FolderGlyph folder={currentFolder} size={18} />
        ) : currentWs ? (
          <WorkspaceGlyph ws={currentWs} size={18} />
        ) : null}
        {/* Granola-style: collapsed to just the icon; the exact workspace/folder
            name + chevron reveal — inside a rounded pill — on row hover or while
            the picker is open. */}
        <span
          className={`flex items-center overflow-hidden whitespace-nowrap transition-all duration-150 ${
            open || !(currentFolder || currentWs)
              ? 'max-w-[170px] opacity-100'
              : 'max-w-0 opacity-0 group-hover:max-w-[170px] group-hover:opacity-100'
          }`}
        >
          <span className="truncate max-w-[120px] pl-1.5 font-medium">{label}</span>
          <ChevronDown size={12} strokeWidth={1.9} className="ml-1 flex-shrink-0" />
        </span>
      </button>

      {open && (
        <div
          onClick={e => e.stopPropagation()}
          className="absolute right-0 top-full mt-1 z-50 w-[240px] bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] overflow-hidden"
        >
          <div className="p-2 border-b border-app-divider">
            <div className="flex items-center gap-2 px-2 py-1 rounded-lg bg-app-nav-hover-bg">
              <Search size={11} strokeWidth={1.8} className="text-app-fg-subtle" />
              <input
                autoFocus
                value={query}
                onChange={e => setQuery(e.target.value)}
                placeholder="Search"
                className="flex-1 bg-transparent outline-none text-[12px] text-app-fg placeholder:text-app-fg-subtle"
              />
            </div>
          </div>
          <div className="max-h-[260px] overflow-y-auto py-1">
            {workspaces.filter(ws => ws.name.toLowerCase().includes(q)).map(ws => {
              const folders = (foldersByWs[ws.id] || []).filter(f => f.name.toLowerCase().includes(q));
              return (
                <div key={ws.id}>
                  <button
                    onClick={() => { onSelectWorkspace(ws.id); setOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-1.5 hover:bg-app-nav-hover-bg text-left transition-colors"
                  >
                    {isDefaultWorkspace(ws)
                      ? <Lock size={12} strokeWidth={1.8} className="text-app-fg-muted flex-shrink-0" />
                      : <span className="text-[14px] leading-none">{ws.emoji}</span>}
                    <span className="flex-1 text-[12.5px] text-app-fg truncate">{ws.name}</span>
                    {currentWsId === ws.id && !currentFolderId && (
                      <span className="text-[12px] text-app-fg">✓</span>
                    )}
                  </button>
                  {folders.map(f => (
                    <button
                      key={f.id}
                      onClick={() => { onSelectFolder(ws.id, f.id); setOpen(false); }}
                      className="w-full flex items-center gap-2 pl-8 pr-3 py-1.5 hover:bg-app-nav-hover-bg text-left transition-colors"
                    >
                      <FolderGlyph folder={f} size={14} />
                      <span className="flex-1 text-[12px] text-app-fg-muted truncate">{f.name}</span>
                      {currentFolderId === f.id && <span className="text-[12px] text-app-fg">✓</span>}
                    </button>
                  ))}
                </div>
              );
            })}
          </div>
          <button
            onClick={() => { onCreateFolder(); setOpen(false); }}
            className="w-full flex items-center gap-2 px-3 py-2 border-t border-app-divider text-app-fg hover:bg-app-nav-hover-bg transition-colors"
          >
            <FolderPlus size={13} strokeWidth={1.7} className="text-emerald-600 dark:text-emerald-400" />
            <span className="text-[12.5px] font-medium">New folder</span>
          </button>
        </div>
      )}
    </div>
  );
}

// ── Note row ──────────────────────────────────────────────────────────────────

function NoteRow({
  meeting, onSelect, onRemove, workspaces, foldersByWs, currentWsId, currentFolderId,
  onChangeFolder, onCreateFolder,
}: {
  meeting: WorkspaceMeeting;
  onSelect: () => void;
  onRemove: () => void;
  workspaces: Workspace[];
  foldersByWs: Record<string, FolderType[]>;
  currentWsId: string | null;
  currentFolderId: string | null;
  onChangeFolder: (taskId: string, wsId: string, folderId: string | null) => void;
  onCreateFolder: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [menuOpen]);

  return (
    <div
      onClick={onSelect}
      className="group flex items-center gap-3 px-3 py-2.5 hover:bg-app-nav-hover-bg rounded-xl cursor-pointer transition-all"
    >
      <div className="w-7 h-7 rounded-md bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0">
        <FileText size={13} strokeWidth={1.7} className="text-app-fg-subtle" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-app-fg truncate leading-tight tracking-[-0.01em]">
          {meeting.filename || 'New note'}
        </p>
        <p className="text-[11px] text-app-fg-subtle mt-0.5">Me</p>
      </div>
      <div className="flex items-center gap-1 flex-shrink-0">
        <FolderPicker
          workspaces={workspaces}
          foldersByWs={foldersByWs}
          currentWsId={currentWsId}
          currentFolderId={currentFolderId}
          onSelectWorkspace={(wsId) => onChangeFolder(meeting.id, wsId, null)}
          onSelectFolder={(wsId, folderId) => onChangeFolder(meeting.id, wsId, folderId)}
          onCreateFolder={onCreateFolder}
        />
        <span className="text-[11px] text-app-fg-subtle px-1 group-hover:hidden">{formatTime(meeting.created_at)}</span>
        <div className="relative" ref={menuRef}>
          <button
            onClick={e => { e.stopPropagation(); setMenuOpen(v => !v); }}
            className="opacity-0 group-hover:opacity-100 p-1 rounded-md text-app-fg-subtle hover:bg-app-canvas hover:text-app-fg transition-all"
          >
            <MoreHorizontal size={13} strokeWidth={1.7} />
          </button>
          {menuOpen && (
            <div className="absolute right-0 top-full mt-1 z-50 w-44 bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] py-1">
              <button
                onClick={e => { e.stopPropagation(); setMenuOpen(false); navigator.clipboard?.writeText(window.location.origin + '/notes/' + meeting.id).catch(() => {}); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg flex items-center gap-2"
              >
                <Link2 size={12} strokeWidth={1.7} className="text-app-fg-subtle" /> Copy link
              </button>
              <button
                onClick={e => { e.stopPropagation(); setMenuOpen(false); onRemove(); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2"
              >
                <X size={12} strokeWidth={1.7} /> Remove from folder
              </button>
              <button
                onClick={e => { e.stopPropagation(); setMenuOpen(false); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg flex items-center gap-2"
              >
                <FolderPlus size={12} strokeWidth={1.7} className="text-app-fg-subtle" /> Add to folder
              </button>
              <div className="h-px bg-app-divider mx-2 my-1" />
              <button
                onClick={e => { e.stopPropagation(); setMenuOpen(false); onRemove(); }}
                className="w-full text-left px-3 py-1.5 text-[12.5px] text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 flex items-center gap-2"
              >
                <Trash2 size={12} strokeWidth={1.7} /> Move to trash
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────

interface WorkspacePageProps {
  allTasks: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
}

export default function WorkspacePage({ allTasks, onSelectTask }: WorkspacePageProps) {
  const selection = useWorkspaceSelection();

  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [foldersByWs, setFoldersByWs] = useState<Record<string, FolderType[]>>({});
  const [meetings, setMeetings] = useState<WorkspaceMeeting[]>([]);
  // Mapping: meetingId -> folderId for the current view (used to show per-row folder badges)
  const [meetingFolderMap, setMeetingFolderMap] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [activeTab, setActiveTab] = useState<'notes' | 'files'>('notes');
  const [descText, setDescText] = useState('');
  const [descSaved, setDescSaved] = useState('');
  const [editingDesc, setEditingDesc] = useState(false);
  const [headerMenuOpen, setHeaderMenuOpen] = useState(false);
  const [showCreateFolder, setShowCreateFolder] = useState(false);
  const [showIntegrations, setShowIntegrations] = useState(false);
  const [renameTarget, setRenameTarget] = useState<{ type: 'ws' | 'folder'; id: string; name: string } | null>(null);
  // Autonomous agent → HITL proposal queue (Suggested actions).
  const [showProposals, setShowProposals] = useState(false);
  const [showBrainMap, setShowBrainMap] = useState(false);
  const [proposals, setProposals] = useState<ProposalRow[]>([]);
  const [jiraMeta, setJiraMeta] = useState<JiraMeta | undefined>(undefined);
  const [addMeetingOpen, setAddMeetingOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addingTaskId, setAddingTaskId] = useState<string | null>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);
  // Bumped by vault events so this page refreshes when a note is moved or spaces/
  // folders change ANYWHERE in the app — keeps every page in sync without a reload.
  const [spacesTick, setSpacesTick] = useState(0);
  const [notesTick, setNotesTick] = useState(0);
  useEffect(() => {
    const offSpaces = onVaultEvent('spaces:changed', () => setSpacesTick(t => t + 1));
    const offNotes = onVaultEvent('notes:changed', () => setNotesTick(t => t + 1));
    return () => { offSpaces(); offNotes(); };
  }, []);

  // This page renders the active SPACE (a space has a name, folders, meetings,
  // members, brain map + connectors). We load the workspace's SPACES as the unit
  // list; `selection.folderId` carries the selected space (or a folder within it).
  useEffect(() => {
    getSpaces().then(spaces => {
      setWorkspaces(spaces as unknown as Workspace[]);
      // Default to the private "My notes" space when nothing is selected.
      if (!selection.folderId && spaces.length > 0) {
        const def = spaces.find(s => s.is_default) || spaces[0];
        setWorkspaceSelection(selection.workspaceId, def.id);
      }
      // Prefetch each space's folders so the picker + counts + drilldown work.
      Promise.all(spaces.map(s => getSpaceFolders(s.id).then(f => ({ id: s.id, f })).catch(() => ({ id: s.id, f: [] as FolderType[] }))))
        .then(rows => {
          const m: Record<string, FolderType[]> = {};
          for (const r of rows) m[r.id] = r.f;
          setFoldersByWs(m);
        });
    }).finally(() => setLoading(false));
    // Re-run when spaces/folders change anywhere (spacesTick) so the unit list,
    // folder lists and counts stay current without a manual refresh.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spacesTick]);

  // Active SPACE (held in `activeWs`) + an optional folder drilled within it.
  const selId = selection.folderId;
  const activeWs = workspaces.find(w => w.id === selId)
    || workspaces.find(w => (foldersByWs[w.id] || []).some(f => f.id === selId))
    || null;
  const activeFolder = activeWs ? (foldersByWs[activeWs.id] || []).find(f => f.id === selId) || null : null;
  const isPrivate = isDefaultWorkspace(activeWs); // is_default flag → the private "My notes" space
  // Connectors, brain map, KG and proposals are WORKSPACE-level features (data is
  // keyed by workspace, not space), so they always use the master workspace id.
  const masterWorkspaceId = selection.workspaceId;

  // Load the agent's pending proposals (+ Jira meta) — workspace-level, shown on
  // non-private spaces.
  useEffect(() => {
    if (!masterWorkspaceId || isPrivate || !isConnectorsEnabled()) { setProposals([]); return; }
    let cancelled = false;
    void listProposals(masterWorkspaceId).then((p) => { if (!cancelled) setProposals(p); }).catch(() => {});
    void getJiraMeta(masterWorkspaceId).then((m) => { if (!cancelled) setJiraMeta(m); }).catch(() => {});
    return () => { cancelled = true; };
  }, [masterWorkspaceId, isPrivate]);

  const onProposalResolved = (id: string, status: 'executed' | 'dismissed', result?: unknown) => {
    setProposals((prev) => prev.filter((x) => x.id !== id));
    void resolveProposal(id, status, result);
  };

  // Hydrate description for current context
  useEffect(() => {
    if (activeFolder) {
      const d = activeFolder.description || '';
      setDescSaved(d); setDescText(d);
    } else if (activeWs) {
      const d = getWorkspaceDescription(activeWs.id);
      setDescSaved(d); setDescText(d);
    } else { setDescSaved(''); setDescText(''); }
  }, [activeWs?.id, activeFolder?.id]);

  // Load meetings for current context. When viewing a workspace at the top level,
  // also aggregate notes from all of its folders so users see *every* note in the space.
  useEffect(() => {
    if (!activeWs) { setMeetings([]); setMeetingFolderMap({}); return; }
    setLoadingContent(true);

    const run = async () => {
      try {
        if (activeFolder) {
          const list = await getFolderMeetings(activeFolder.id);
          setMeetings(list);
          const map: Record<string, string> = {};
          for (const m of list) map[m.id] = activeFolder.id;
          setMeetingFolderMap(map);
          return;
        }

        const folders = foldersByWs[activeWs.id] || [];
        // Fetch the SPACE's own meetings and every folder's meetings in ONE parallel
        // batch — the space root lists every note in the space (filed or not).
        const [wsMeetings, folderResults] = await Promise.all([
          getSpaceMeetings(activeWs.id),
          Promise.all(
            folders.map(f => getFolderMeetings(f.id).then(list => ({ folderId: f.id, list })).catch(() => ({ folderId: f.id, list: [] as WorkspaceMeeting[] })))
          ),
        ]);
        // The workspace is the MASTER overall view — it lists EVERY meeting (filed or not),
        // each tagged with WHERE it lives (its folder). A foldered meeting is one entry here,
        // badged with its folder; it is not duplicated. Dedup by id so it appears exactly once.
        const folderMap: Record<string, string> = {};
        const merged: Record<string, WorkspaceMeeting> = {};
        for (const m of wsMeetings) merged[m.id] = m;
        for (const { folderId, list } of folderResults) {
          for (const m of list) {
            merged[m.id] = m;
            folderMap[m.id] = folderId; // the meeting's home folder → shown as a badge
          }
        }
        const combined = Object.values(merged).sort(
          (a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime()
        );
        setMeetings(combined);
        setMeetingFolderMap(folderMap);
      } finally {
        setLoadingContent(false);
      }
    };
    run();
    // Depend on THIS workspace's folder list (stable) rather than the whole
    // foldersByWs object, whose identity changes when the mount prefetch resolves
    // — that previously triggered a redundant second N+1 reload of every folder.
    // notesTick re-runs this when a note is moved anywhere, so the space's meeting
    // list adds/drops the note immediately.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWs?.id, activeFolder?.id, foldersByWs[activeWs?.id ?? ''], notesTick]);

  // Full-text evidence for the workspace chat (transcription/notes/summary).
  // Reuse the already-loaded `allTasks` where present; lazily hydrate the rest
  // via getTaskById (workspaces hold few meetings), cached across re-renders so
  // the chat only ever fetches each note once.
  const [scopedMeetings, setScopedMeetings] = useState<SearchableMeeting[]>([]);
  const scopedTextCacheRef = useRef<Map<string, { transcription: string; summary: string; notes: string; attendees: string[] }>>(new Map());
  useEffect(() => {
    if (!activeWs || activeFolder) { setScopedMeetings([]); return; }
    let cancelled = false;
    const byId = new Map(allTasks.filter(t => t.id).map(t => [t.id as string, t]));
    (async () => {
      // Per-meeting knowledge graph (action items, decisions, people, topic
      // status incl. off-track) for this workspace → powers structured evidence
      // cards + the "off-track" filter in the workspace chat.
      const kgByTask = new Map<string, KGLite>();
      try {
        const kg = await getWorkspaceKnowledgeGraph(masterWorkspaceId ?? activeWs.id);
        for (const e of kg) kgByTask.set(e.task_id, { topics: e.topics, decisions: e.decisions, action_items: e.action_items, people: e.people });
      } catch { /* non-fatal — cards still carry date/attendees */ }

      const built = await Promise.all(meetings.map(async (wm): Promise<SearchableMeeting> => {
        let text = scopedTextCacheRef.current.get(wm.id);
        if (!text) {
          const local = byId.get(wm.id);
          if (local && (local.transcription || local.notes || local.summary)) {
            text = { transcription: local.transcription || '', summary: local.summary || wm.summary || '', notes: local.notes || '', attendees: local.attendees || [] };
          } else {
            const full = await getTaskById(wm.id).catch(() => null);
            text = { transcription: full?.transcription || '', summary: full?.summary || wm.summary || '', notes: full?.notes || '', attendees: full?.attendees || [] };
          }
          scopedTextCacheRef.current.set(wm.id, text);
        }
        return {
          meetingId: wm.id,
          title: wm.filename || byId.get(wm.id)?.filename || 'Untitled',
          transcription: text.transcription,
          summary: text.summary,
          notes: text.notes,
          createdAt: wm.created_at,
          attendees: text.attendees,
          kg: kgByTask.get(wm.id) ?? null,
        };
      }));
      if (!cancelled) setScopedMeetings(built);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWs?.id, activeFolder?.id, meetings, allTasks]);

  // Click-outside for header menu
  useEffect(() => {
    if (!headerMenuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (headerMenuRef.current && !headerMenuRef.current.contains(e.target as Node)) setHeaderMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [headerMenuOpen]);

  // ── Handlers ────────────────────────────────────────────────────────────────

  const saveDescription = () => {
    if (!activeWs) return;
    if (activeFolder) {
      // Folder description is client-side
      const all: Record<string, FolderType[]> = { ...foldersByWs };
      all[activeWs.id] = all[activeWs.id].map(f => f.id === activeFolder.id ? { ...f, description: descText } : f);
      setFoldersByWs(all);
      // Persist via overlay
      import('../services/workspaceService').then(m => m.updateFolderMeta(activeFolder.id, { description: descText }));
    } else {
      setWorkspaceDescription(activeWs.id, descText);
    }
    setDescSaved(descText);
    setEditingDesc(false);
  };

  const handleCreateFolder = async (draft: FolderDraft) => {
    // Folders live INSIDE a space. Create the folder in the active SPACE so it shows
    // up under it (the old createFolder made a workspace-folder with no space_id).
    if (!activeWs) return;
    const created = await createFolderInSpace(activeWs.id, draft.title, {
      iconType: draft.iconType,
      iconName: draft.iconName,
      color: draft.iconColor,
      emoji: draft.emoji,
    });
    setFoldersByWs(p => ({ ...p, [activeWs.id]: [...(p[activeWs.id] || []), created] }));
    setShowCreateFolder(false);
    setWorkspaceSelection(selection.workspaceId, created.id);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const name = renameTarget.name.trim();
    if (!name) { setRenameTarget(null); return; }
    if (renameTarget.type === 'ws') {
      // `activeWs` is a SPACE here — rename via the space endpoint.
      const upd = await updateSpace(renameTarget.id, { name }).catch(() => null);
      if (upd) setWorkspaces(prev => prev.map(w => w.id === renameTarget.id ? { ...w, name } : w));
    } else {
      const upd = await renameFolder(renameTarget.id, name).catch(() => null);
      if (upd) {
        setFoldersByWs(prev => {
          const next = { ...prev };
          for (const k of Object.keys(next)) next[k] = next[k].map(f => f.id === upd.id ? { ...f, name: upd.name } : f);
          return next;
        });
      }
    }
    setRenameTarget(null);
  };

  const handleDeleteWs = async () => {
    if (!activeWs || isDefaultWorkspace(activeWs)) return;
    if (!window.confirm(`Delete "${activeWs.name}"?`)) return;
    await deleteSpace(activeWs.id).catch(() => {}); // `activeWs` is a SPACE here
    const remaining = workspaces.filter(w => w.id !== activeWs.id);
    setWorkspaces(remaining);
    setWorkspaceSelection(remaining[0]?.id || null, null);
  };

  const handleDeleteFolder = async () => {
    if (!activeWs || !activeFolder) return;
    if (!window.confirm(`Delete folder "${activeFolder.name}"?`)) return;
    await deleteFolder(activeFolder.id).catch(() => {});
    setFoldersByWs(p => ({ ...p, [activeWs.id]: (p[activeWs.id] || []).filter(f => f.id !== activeFolder.id) }));
    setWorkspaceSelection(activeWs.id, null);
  };

  const handleAddMeeting = async (taskId: string) => {
    if (!activeWs) return;
    setAddingTaskId(taskId);
    await moveNoteToSpace(activeWs.id, taskId, activeFolder?.id ?? null).catch(() => {});
    const updated = await getSpaceMeetings(activeWs.id).catch(() => meetings);
    setMeetings(updated);
    setAddingTaskId(null);
  };

  const handleRemoveMeeting = async (taskId: string) => {
    // "Remove from this space" → move the note back to the private "My notes" space.
    const def = workspaces.find(w => isDefaultWorkspace(w));
    if (def) await moveNoteToSpace(def.id, taskId, null).catch(() => {});
    setMeetings(prev => prev.filter(m => m.id !== taskId));
  };

  // Move a note to a SPACE (and optionally a folder within it). `spaceId` is the
  // picker's selected space id.
  const handleChangeFolder = async (taskId: string, spaceId: string, folderId: string | null) => {
    if (!activeWs) return;
    await moveNoteToSpace(spaceId, taskId, folderId).catch(() => {});
    if (activeFolder) {
      // Folder view: drops out if it left THIS folder (or this space).
      if (folderId !== activeFolder.id || spaceId !== activeWs.id) setMeetings(prev => prev.filter(m => m.id !== taskId));
    } else {
      // Space root view: keep it listed; just re-badge its folder. Leaves only if it moved to another space.
      setMeetingFolderMap(prev => {
        const next = { ...prev };
        if (folderId) next[taskId] = folderId; else delete next[taskId];
        return next;
      });
      if (spaceId !== activeWs.id) setMeetings(prev => prev.filter(m => m.id !== taskId));
    }
  };

  // ── Render guards ───────────────────────────────────────────────────────────

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center bg-app-panel">
        <Loader2 className="animate-spin text-app-fg-subtle" size={20} />
      </div>
    );
  }

  if (!activeWs) {
    return (
      <div className="h-full flex items-center justify-center bg-app-panel">
        <div className="text-center">
          <p className="text-[14px] font-medium text-app-fg mb-1">No workspace selected</p>
          <p className="text-[12px] text-app-fg-subtle">Pick one from the sidebar</p>
        </div>
      </div>
    );
  }

  const dateGroups = groupByDate(meetings);

  const title = activeFolder?.name || activeWs.name;
  const folderCount = (foldersByWs[activeWs.id] || []).length;
  const titleHint = activeFolder
    ? null
    : isPrivate
      ? 'Notes from all of your private folders.'
      : 'Notes shared across this space.';

  return (
    <div className="h-full flex flex-col overflow-hidden bg-app-panel font-sans">

      {/* Top bar: back button (if folder) + integrations + favorite + share */}
      <div className="flex items-center justify-between px-5 py-3 border-b border-transparent flex-shrink-0">
        <div className="flex items-center gap-2">
          {activeFolder ? (
            <button
              onClick={() => setWorkspaceSelection(activeWs.id, null)}
              className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
              title="Back to workspace"
            >
              <ChevronLeft size={15} strokeWidth={1.7} />
            </button>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {!isPrivate && !activeFolder && proposals.length > 0 && (
            <button
              onClick={() => setShowProposals(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-app-accent hover:bg-app-accent/10 transition-colors"
              title="Actions the agent suggests from your meetings"
            >
              <Sparkles size={12} strokeWidth={1.7} /> Suggested actions
              <span className="ml-0.5 min-w-[16px] h-4 px-1 rounded-full bg-app-accent text-app-accent-fg text-[10px] font-semibold flex items-center justify-center">{proposals.length}</span>
            </button>
          )}
          {!isPrivate && (
            <button
              onClick={() => setShowBrainMap(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
              title={activeFolder ? 'This project as one graph — meetings, Jira, GitHub and dev sessions, linked' : 'See meetings, Jira and GitHub linked as one graph'}
            >
              <BrainCircuit size={12} strokeWidth={1.7} /> {activeFolder ? 'Project brain' : 'Brain map'}
            </button>
          )}
          {!isPrivate && (
            <button
              onClick={() => setShowIntegrations(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
              title={activeFolder ? 'Map this project to its Jira project + GitHub repos' : undefined}
            >
              <Cable size={12} strokeWidth={1.7} /> Integrations
            </button>
          )}
          {activeFolder && (
            <button
              title="Add to favorites"
              className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
            >
              <Star size={14} strokeWidth={1.7} />
            </button>
          )}
          <div className="relative" ref={headerMenuRef}>
            <button
              onClick={() => setHeaderMenuOpen(v => !v)}
              className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
            >
              <MoreHorizontal size={15} strokeWidth={1.7} />
            </button>
            {headerMenuOpen && (
              <div className="absolute right-0 top-full mt-1 z-50 w-48 bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] py-1">
                <button
                  onClick={() => { setShowCreateFolder(true); setHeaderMenuOpen(false); }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg"
                >
                  <FolderPlus size={13} strokeWidth={1.7} className="text-app-fg-subtle" /> Create folder
                </button>
                <button
                  onClick={() => {
                    setRenameTarget(activeFolder
                      ? { type: 'folder', id: activeFolder.id, name: activeFolder.name }
                      : { type: 'ws', id: activeWs.id, name: activeWs.name });
                    setHeaderMenuOpen(false);
                  }}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg"
                >
                  <Pencil size={13} strokeWidth={1.7} className="text-app-fg-subtle" /> Rename
                </button>
                <button className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg">
                  <UserPlus size={13} strokeWidth={1.7} className="text-app-fg-subtle" /> Sharing settings
                </button>
                <div className="h-px bg-app-divider mx-2 my-1" />
                <button
                  onClick={() => { activeFolder ? handleDeleteFolder() : handleDeleteWs(); setHeaderMenuOpen(false); }}
                  disabled={isPrivate && !activeFolder}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30 disabled:opacity-40 disabled:cursor-not-allowed"
                >
                  <Trash2 size={13} strokeWidth={1.7} /> Delete folder
                </button>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">

        {/* Title block */}
        <div className="px-8 pt-6 pb-3 max-w-[920px] mx-auto w-full">
          <div className="flex items-center gap-2 mb-2">
            {activeFolder
              ? <FolderGlyph folder={activeFolder} size={28} />
              : <WorkspaceGlyph ws={activeWs} size={28} />}
            <h1 className="font-serif text-[34px] leading-none text-app-fg tracking-tight">{title}</h1>
          </div>

          {/* Description (editable) */}
          {editingDesc ? (
            <input
              autoFocus
              value={descText}
              onChange={e => setDescText(e.target.value)}
              onBlur={saveDescription}
              onKeyDown={e => { if (e.key === 'Enter') saveDescription(); if (e.key === 'Escape') { setDescText(descSaved); setEditingDesc(false); } }}
              placeholder="Add a description…"
              className="text-[13px] text-app-fg bg-transparent outline-none border-b border-app-divider focus:border-app-fg-subtle w-full max-w-md"
            />
          ) : (
            <button
              onClick={() => setEditingDesc(true)}
              className="text-[13px] text-app-fg-subtle hover:text-app-fg transition-colors text-left"
            >
              {descSaved || (titleHint ?? 'Add a description…')}
            </button>
          )}

          {!activeFolder && !isPrivate && (
            <div className="mt-2 flex items-center gap-1 text-[11.5px] text-app-fg-subtle">
              <UserPlus size={11} strokeWidth={1.7} /> Shared team space
            </div>
          )}

          {/* My notes meta: lock + folder count */}
          {!activeFolder && isPrivate && (
            <div className="mt-2 flex items-center gap-2 text-[11.5px] text-app-fg-subtle">
              <span className="flex items-center gap-1">
                <Lock size={11} strokeWidth={1.7} /> Your private notes and folders
              </span>
              <span>·</span>
              <span className="flex items-center gap-1">
                <FolderIcon size={11} strokeWidth={1.7} />
                {folderCount} folder{folderCount === 1 ? '' : 's'}
              </span>
            </div>
          )}

          {/* "Your private space" callout — soft blue card */}
          {isPrivate && !activeFolder && (
            <div className="mt-5 px-4 py-3 rounded-2xl bg-sky-50/70 dark:bg-sky-950/20 border border-sky-100 dark:border-sky-900/40 flex items-start gap-3 max-w-[760px]">
              <div className="flex-1">
                <div className="text-[13.5px] font-semibold text-app-fg mb-0.5 tracking-[-0.01em]">Your private space</div>
                <div className="text-[12.5px] text-app-fg-muted tracking-[-0.01em]">
                  Your notes live here by default. Nothing gets shared until you choose to share it.
                </div>
              </div>
              <button className="text-app-fg-subtle hover:text-app-fg p-1 -mr-1 -mt-1"><X size={13} /></button>
            </div>
          )}
        </div>

        {/* Folders in this space — click a card to open it. Only at the workspace
            root (folders are one level deep). This is how you browse INTO folders. */}
        {activeWs && !activeFolder && (
          <div className="px-8 pt-5 max-w-[920px] mx-auto w-full">
            <div className="flex items-center justify-between mb-2.5">
              <span className="text-[12.5px] font-semibold text-app-fg tracking-[-0.01em]">Folders</span>
              <button
                onClick={() => setShowCreateFolder(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
              >
                <FolderPlus size={12} strokeWidth={1.7} /> New folder
              </button>
            </div>
            {folderCount === 0 ? (
              <button
                onClick={() => setShowCreateFolder(true)}
                className="w-full flex items-center gap-3 p-4 rounded-2xl border border-dashed border-app-divider text-app-fg-subtle hover:border-app-fg-subtle/40 hover:text-app-fg transition-colors"
              >
                <FolderPlus size={18} strokeWidth={1.7} />
                <span className="text-[12.5px]">No folders yet — create one to organise your notes.</span>
              </button>
            ) : (
              <div className="grid grid-cols-2 sm:grid-cols-3 gap-2.5">
                {(foldersByWs[activeWs.id] || []).map(f => (
                  <button
                    key={f.id}
                    onClick={() => setWorkspaceSelection(activeWs.id, f.id)}
                    className="flex items-center gap-3 p-3 rounded-2xl border border-app-divider bg-app-canvas hover:bg-app-nav-hover-bg hover:border-app-fg-subtle/30 transition-colors text-left"
                  >
                    <FolderGlyph folder={f} size={34} />
                    <div className="min-w-0 flex-1">
                      <div className="text-[13px] font-medium text-app-fg truncate tracking-[-0.01em]">{f.name}</div>
                      <div className="text-[11px] text-app-fg-subtle truncate">{f.description || 'Open folder'}</div>
                    </div>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Workspace chat — scoped to this workspace's notes (+ its folders).
            Shown on the workspace home (not inside a single folder). */}
        {activeWs && !activeFolder && (
          <div className="px-8 max-w-[920px] mx-auto w-full">
            <WorkspaceChat
              key={activeWs.id}
              workspaceId={masterWorkspaceId ?? activeWs.id}
              workspaceName={activeWs.name}
              spaceId={activeWs.id}
              scopedMeetings={scopedMeetings}
            />
          </div>
        )}

        {/* Divider */}
        <div className="h-px bg-app-divider mx-auto mt-6 max-w-[920px]" />

        {/* Tabs + notes list */}
        <div className="px-6 pt-5 max-w-[920px] mx-auto w-full">
          <div className="flex items-center gap-1 mb-2">
            {(['notes', 'files'] as const).map(t => (
              <button
                key={t}
                onClick={() => setActiveTab(t)}
                className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                  activeTab === t ? 'bg-app-nav-active-bg text-app-fg' : 'text-app-fg-subtle hover:text-app-fg hover:bg-app-nav-hover-bg'
                }`}
              >
                {t === 'notes' ? <FileText size={12} strokeWidth={1.7} /> : <Paperclip size={12} strokeWidth={1.7} />}
                {t === 'notes' ? 'Notes' : 'Files'}
              </button>
            ))}
            <div className="flex-1" />
            <button
              onClick={() => setAddMeetingOpen(true)}
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
            >
              <Plus size={12} strokeWidth={1.7} /> Add note
            </button>
          </div>

          {activeTab === 'notes' ? (
            loadingContent ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="animate-spin text-app-fg-subtle" size={18} />
              </div>
            ) : meetings.length === 0 ? (
              <div className="text-center py-20">
                <p className="text-[13px] text-app-fg-subtle mb-3">
                  {activeFolder ? 'No notes in this folder yet.' : 'No notes in this space yet.'}
                </p>
                <button
                  onClick={() => setAddMeetingOpen(true)}
                  className="px-4 py-2 rounded-xl bg-app-fg text-app-canvas text-[12.5px] font-semibold hover:opacity-90 transition-opacity"
                >
                  New note
                </button>
              </div>
            ) : (
              <div className="pb-8">
                {dateGroups.map(({ label, items }) => (
                  <div key={label} className="mb-3">
                    <div className="px-3 py-1.5 text-[11px] text-app-fg-subtle tracking-tight">{label}</div>
                    {items.map(m => {
                      // Use the loaded history entry when available, otherwise build
                      // a minimal task from the workspace meeting itself. Workspace
                      // meetings frequently live outside the paginated history, and
                      // requiring them to be present made those rows un-openable.
                      const task: TaskHistory = allTasks.find(t => t.id === m.id) ?? {
                        id: m.id,
                        filename: m.filename,
                        created_at: m.created_at,
                        duration: m.duration,
                        status: (m.status === 'error' ? 'error' : 'completed'),
                        summary: m.summary ?? undefined,
                      };
                      const folderId = activeFolder?.id ?? meetingFolderMap[m.id] ?? null;
                      return (
                        <NoteRow
                          key={m.id}
                          meeting={m}
                          onSelect={() => onSelectTask(task)}
                          onRemove={() => handleRemoveMeeting(m.id)}
                          workspaces={workspaces}
                          foldersByWs={foldersByWs}
                          currentWsId={activeWs.id}
                          currentFolderId={folderId}
                          onChangeFolder={handleChangeFolder}
                          onCreateFolder={() => setShowCreateFolder(true)}
                        />
                      );
                    })}
                  </div>
                ))}
              </div>
            )
          ) : (
            <div className="py-6">
              <div className="border border-dashed border-app-divider rounded-2xl px-6 py-8 text-center hover:border-app-fg-subtle transition-colors cursor-pointer">
                <div className="flex items-center justify-center gap-2 text-[12.5px] text-app-fg-subtle">
                  <Plus size={13} strokeWidth={1.7} />
                  <span>Click to add or drag &amp; drop files, or <span className="underline text-app-fg">paste text</span></span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add meeting modal */}
      {addMeetingOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setAddMeetingOpen(false)}>
          <div className="bg-app-canvas rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-app-divider" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-app-divider">
              <h3 className="text-[14px] font-semibold text-app-fg">Add to "{activeFolder?.name || activeWs.name}"</h3>
              <button onClick={() => setAddMeetingOpen(false)} className="p-1 rounded-lg hover:bg-app-nav-hover-bg text-app-fg-subtle"><X size={14} /></button>
            </div>
            <div className="p-4">
              <input
                autoFocus
                value={addSearch}
                onChange={e => setAddSearch(e.target.value)}
                placeholder="Search notes…"
                className="w-full px-3 py-2 text-[12.5px] bg-app-nav-hover-bg border border-app-divider rounded-xl outline-none text-app-fg placeholder:text-app-fg-subtle mb-3"
              />
              <div className="space-y-0.5 max-h-64 overflow-y-auto">
                {allTasks
                  .filter(t =>
                    !meetings.find(mt => mt.id === t.id) &&
                    (addSearch === '' || t.filename.toLowerCase().includes(addSearch.toLowerCase()))
                  )
                  .slice(0, 40)
                  .map(t => (
                    <button
                      key={t.id}
                      onClick={() => handleAddMeeting(t.id!)}
                      disabled={addingTaskId === t.id}
                      className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-app-nav-hover-bg text-left transition-colors disabled:opacity-50 group"
                    >
                      <div className="w-7 h-7 rounded-lg bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0">
                        <FileText size={12} className="text-app-fg-subtle" />
                      </div>
                      <span className="flex-1 text-[12.5px] text-app-fg truncate">{t.filename}</span>
                      {addingTaskId === t.id
                        ? <Loader2 size={12} className="animate-spin text-app-fg-subtle" />
                        : <Plus size={12} className="text-app-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity" />}
                    </button>
                  ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create folder modal */}
      {showCreateFolder && (
        <CreateFolderModal
          workspaces={workspaces}
          defaultWorkspaceId={activeWs.id}
          onClose={() => setShowCreateFolder(false)}
          onCreate={handleCreateFolder}
        />
      )}

      {/* Rename modal */}
      {showBrainMap && (
        // A folder selected in the sidebar → SCOPED to that project; workspace level → AGGREGATE.
        <BrainMapModal
          workspaceId={masterWorkspaceId ?? activeWs.id}
          workspaceName={activeWs.name}
          folderId={activeFolder?.id ?? null}
          folderName={activeFolder?.name}
          spaceId={activeWs.id}
          onClose={() => setShowBrainMap(false)}
        />
      )}

      {showProposals && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowProposals(false)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[640px] max-w-[92vw] max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-app-divider flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Sparkles size={15} strokeWidth={1.7} className="text-app-accent flex-shrink-0" />
                <h3 className="text-[15px] font-semibold text-app-fg truncate">Suggested actions · {activeWs.name}</h3>
              </div>
              <button
                onClick={() => setShowProposals(false)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
                title="Close"
              >
                <X size={15} strokeWidth={1.7} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-4">
              <p className="text-[12px] text-app-fg-subtle leading-relaxed mb-3">
                Drawn from this workspace’s meetings. Nothing is written to Jira until you approve —
                review, edit, and approve or dismiss each one.
              </p>
              {proposals.length === 0 ? (
                <p className="text-[13px] text-app-fg-subtle py-8 text-center">No suggestions right now.</p>
              ) : (
                <div className="space-y-3">
                  {proposals.map((pr) => (
                    <JiraActionCard
                      key={pr.id}
                      proposal={pr.proposal}
                      meta={jiraMeta}
                      workspaceId={masterWorkspaceId ?? activeWs.id}
                      rationale={pr.rationale}
                      sourceTitle={pr.source_title}
                      onResolved={(status, result) => onProposalResolved(pr.id, status, result)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showIntegrations && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setShowIntegrations(false)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[720px] max-w-[92vw] max-h-[85vh] flex flex-col overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-app-divider flex-shrink-0">
              <div className="flex items-center gap-2 min-w-0">
                <Cable size={15} strokeWidth={1.7} className="text-app-fg-subtle flex-shrink-0" />
                <h3 className="text-[15px] font-semibold text-app-fg truncate">Integrations · {activeWs.name}</h3>
              </div>
              <button
                onClick={() => setShowIntegrations(false)}
                className="w-7 h-7 flex items-center justify-center rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
                title="Close"
              >
                <X size={15} strokeWidth={1.7} />
              </button>
            </div>
            <div className="flex-1 overflow-y-auto px-6 py-5">
              {isConnectorsEnabled() ? (
                <ConnectionsTab fixedWorkspaceId={masterWorkspaceId ?? activeWs.id} embedded />
              ) : (
                <p className="text-[13px] text-app-fg-subtle leading-relaxed">
                  Connectors aren’t enabled in this build yet. Once enabled, you’ll connect tools
                  like Jira here — scoped to <span className="text-app-fg font-medium">{activeWs.name}</span>.
                </p>
              )}
            </div>
          </div>
        </div>
      )}

      {renameTarget && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setRenameTarget(null)}>
          <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[360px] p-5" onClick={e => e.stopPropagation()}>
            <h3 className="text-[14px] font-semibold text-app-fg mb-3">Rename</h3>
            <input
              autoFocus
              value={renameTarget.name}
              onChange={e => setRenameTarget({ ...renameTarget, name: e.target.value })}
              onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setRenameTarget(null); }}
              className="w-full px-3 py-2 rounded-lg border border-app-divider bg-app-canvas outline-none text-[13px] text-app-fg focus:border-app-fg-subtle"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button onClick={() => setRenameTarget(null)} className="px-3 py-1.5 rounded-lg text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg">Cancel</button>
              <button onClick={handleRename} className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-fg text-app-canvas hover:opacity-90">Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
