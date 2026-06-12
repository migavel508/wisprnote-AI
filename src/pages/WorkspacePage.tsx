import { useState, useEffect, useRef } from 'react';
import {
  Plus, MoreHorizontal, X, Loader2, FileText, Mic, Star, Pencil, Trash2,
  UserPlus, FolderPlus, Lock, ChevronDown, Cable, Link2, ChevronLeft,
  Folder as FolderIcon, Search, Paperclip,
} from 'lucide-react';
import {
  Workspace, Folder as FolderType, WorkspaceMeeting,
  ensureDefaultWorkspace, isDefaultWorkspace,
  getFolders, createFolder,
  deleteFolder, renameFolder,
  updateWorkspace, deleteWorkspace,
  getWorkspaceMeetings, getFolderMeetings,
  addMeetingToWorkspace, removeMeetingFromWorkspace,
  getWorkspaceDescription, setWorkspaceDescription,
  getWorkspaceImage, getAvatarGradient,
} from '../services/workspaceService';
import { setWorkspaceSelection, useWorkspaceSelection } from '../services/workspaceSelection';
import type { TaskHistory } from '../services/awsService';
import CreateFolderModal, { type FolderDraft } from '../components/CreateFolderModal';

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
        className="flex items-center gap-1.5 px-2 py-1 rounded-lg text-[11.5px] text-app-fg-subtle hover:bg-app-nav-hover-bg transition-colors"
      >
        {currentFolder ? (
          <FolderGlyph folder={currentFolder} size={14} />
        ) : currentWs ? (
          <WorkspaceGlyph ws={currentWs} size={14} />
        ) : null}
        <span className="truncate max-w-[120px]">{label}</span>
        <ChevronDown size={11} strokeWidth={1.7} />
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
        <span className="text-[11px] text-app-fg-subtle px-1">{formatTime(meeting.created_at)}</span>
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
  const [renameTarget, setRenameTarget] = useState<{ type: 'ws' | 'folder'; id: string; name: string } | null>(null);
  const [addMeetingOpen, setAddMeetingOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addingTaskId, setAddingTaskId] = useState<string | null>(null);
  const headerMenuRef = useRef<HTMLDivElement>(null);

  // Load workspaces
  useEffect(() => {
    ensureDefaultWorkspace().then(ws => {
      setWorkspaces(ws);
      // If nothing selected, pick the default
      if (!selection.workspaceId && ws.length > 0) {
        setWorkspaceSelection(ws[0].id, null);
      }
      // Prefetch folders for all workspaces so picker works
      Promise.all(ws.map(w => getFolders(w.id).then(f => ({ id: w.id, f })).catch(() => ({ id: w.id, f: [] as FolderType[] }))))
        .then(rows => {
          const m: Record<string, FolderType[]> = {};
          for (const r of rows) m[r.id] = r.f;
          setFoldersByWs(m);
        });
    }).finally(() => setLoading(false));
  }, []);

  // Active workspace and folder
  const activeWs = workspaces.find(w => w.id === selection.workspaceId) || null;
  const activeFolder = activeWs && selection.folderId
    ? (foldersByWs[activeWs.id] || []).find(f => f.id === selection.folderId) || null
    : null;
  const isPrivate = isDefaultWorkspace(activeWs);

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
        // Fetch the workspace's own meetings and every folder's meetings in ONE
        // parallel batch (was: ws call awaited first, then a second await wave).
        const [wsMeetings, folderResults] = await Promise.all([
          getWorkspaceMeetings(activeWs.id),
          Promise.all(
            folders.map(f => getFolderMeetings(f.id).then(list => ({ folderId: f.id, list })).catch(() => ({ folderId: f.id, list: [] as WorkspaceMeeting[] })))
          ),
        ]);
        const folderMap: Record<string, string> = {};
        const merged: Record<string, WorkspaceMeeting> = {};
        for (const m of wsMeetings) merged[m.id] = m;
        for (const { folderId, list } of folderResults) {
          for (const m of list) {
            merged[m.id] = m;
            folderMap[m.id] = folderId; // last folder wins; UI shows a single badge
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
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWs?.id, activeFolder?.id, foldersByWs[activeWs?.id ?? '']]);

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
    if (!draft.workspaceId) return;
    const created = await createFolder(draft.workspaceId, draft.title, {
      iconType: draft.iconType,
      iconName: draft.iconName,
      color: draft.iconColor,
      emoji: draft.emoji,
      description: draft.description,
    });
    setFoldersByWs(p => ({ ...p, [draft.workspaceId]: [...(p[draft.workspaceId] || []), created] }));
    setShowCreateFolder(false);
    setWorkspaceSelection(draft.workspaceId, created.id);
  };

  const handleRename = async () => {
    if (!renameTarget) return;
    const name = renameTarget.name.trim();
    if (!name) { setRenameTarget(null); return; }
    if (renameTarget.type === 'ws') {
      const upd = await updateWorkspace(renameTarget.id, { name }).catch(() => null);
      if (upd) setWorkspaces(prev => prev.map(w => w.id === upd.id ? upd : w));
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
    await deleteWorkspace(activeWs.id).catch(() => {});
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
    await addMeetingToWorkspace(activeWs.id, taskId).catch(() => {});
    const updated = await getWorkspaceMeetings(activeWs.id).catch(() => meetings);
    setMeetings(updated);
    setAddingTaskId(null);
  };

  const handleRemoveMeeting = async (taskId: string) => {
    if (!activeWs) return;
    await removeMeetingFromWorkspace(activeWs.id, taskId).catch(() => {});
    setMeetings(prev => prev.filter(m => m.id !== taskId));
  };

  const handleChangeFolder = async (taskId: string, wsId: string, folderId: string | null) => {
    if (!activeWs) return;
    // Remove from current workspace if changing workspace
    if (wsId !== activeWs.id) {
      await removeMeetingFromWorkspace(activeWs.id, taskId).catch(() => {});
    }
    await addMeetingToWorkspace(wsId, taskId).catch(() => {});
    // Folder add (best-effort)
    if (folderId) {
      const { addMeetingToFolder } = await import('../services/workspaceService');
      await addMeetingToFolder(folderId, taskId).catch(() => {});
    }
    if (wsId !== activeWs.id || folderId !== selection.folderId) {
      setMeetings(prev => prev.filter(m => m.id !== taskId));
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
      : 'Notes visible to your entire workspace.';

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
          {!isPrivate && !activeFolder && (
            <button className="flex items-center gap-1.5 px-2.5 py-1 rounded-md text-[12px] text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors">
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
              <UserPlus size={11} strokeWidth={1.7} /> Your team workspace
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

        {/* Ask bar */}
        <div className="px-8 max-w-[920px] mx-auto w-full">
          <div className="flex items-center gap-3 px-4 py-3 bg-app-canvas border border-app-divider rounded-2xl hover:border-app-fg-subtle transition-colors">
            <span className="flex-1 text-[13px] text-app-fg-subtle tracking-[-0.01em]">
              {activeFolder ? 'Ask about folder' : 'Ask anything'}
            </span>
            <button className="text-[11px] text-app-fg-subtle hover:text-app-fg flex items-center gap-1">
              Sonnet 4.6 <ChevronDown size={11} />
            </button>
            <Paperclip size={13} strokeWidth={1.7} className="text-app-fg-subtle" />
            <Mic size={13} strokeWidth={1.7} className="text-app-fg-subtle" />
          </div>

          {/* Quick recipes */}
          <div className="flex items-center justify-between mt-3">
            <div className="flex items-center gap-3 flex-wrap">
              {['Catch me up', 'List key decisions', 'Show in flight projects'].map(chip => (
                <button key={chip} className="text-[12px] text-app-fg-subtle hover:text-app-fg flex items-center gap-1.5 transition-colors">
                  <span className="inline-block w-3.5 h-3.5 rounded border border-app-divider text-center text-[8px] leading-[12px]">/</span>
                  {chip}
                </button>
              ))}
            </div>
            <button className="text-[12px] text-app-fg-subtle hover:text-app-fg flex items-center gap-1.5">
              <span className="inline-block w-3.5 h-3.5 grid grid-cols-2 gap-[1px]">
                <span className="bg-app-fg-subtle rounded-[1px]" />
                <span className="bg-app-fg-subtle rounded-[1px]" />
                <span className="bg-app-fg-subtle rounded-[1px]" />
                <span className="bg-app-fg-subtle rounded-[1px]" />
              </span>
              All recipes
            </button>
          </div>
        </div>

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
                  {activeFolder ? 'No notes in this folder yet.' : 'No notes in this workspace yet.'}
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
