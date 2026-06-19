import { useEffect, useState, useRef } from 'react';
import {
  MessageSquareText,
  Network,
  Clock,
  House,
  LogOut,
  Headphones,
  Users,
  Sun,
  Moon,
  Monitor,
  Plus,
  Lock,
  Folder as FolderIcon,
  Pencil,
  Trash2,
  Star,
  UserPlus,
  FolderPlus,
} from 'lucide-react';
import { AuthSession } from '../services/awsAuthService';
import { getPendingTaskCount } from '../services/awsService';
import { useTheme, type ThemePreference } from '../theme/ThemeProvider';
import {
  ensureDefaultWorkspace, getFolders, createWorkspace, createFolder,
  deleteWorkspace, updateWorkspace, renameFolder, deleteFolder,
  isDefaultWorkspace, getWorkspaceImage, getAvatarGradient,
  DEFAULT_WORKSPACE_NAME, DEFAULT_WORKSPACE_EMOJI,
  type Workspace, type Folder as FolderType,
} from '../services/workspaceService';
import { setWorkspaceSelection, useWorkspaceSelection } from '../services/workspaceSelection';
import CreateFolderModal, { type FolderDraft } from './CreateFolderModal';
import WorkspaceCreationWizard from './WorkspaceCreationWizard';
import WorkspaceSwitcher from './WorkspaceSwitcher';
import { WisprnoteLogo } from './WisprnoteLogo';

type View = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks' | 'audio-devices' | 'workspace' | 'people' | 'settings';

interface MainSidebarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  isOpen: boolean;
  onToggle: () => void;
  session: AuthSession | null;
  onSignOut: () => void;
  status: string;
  isCompactMode?: boolean;
}

// ── Theme picker pill ─────────────────────────────────────────────────────────
function ThemeAppearancePicker({ collapsed }: { collapsed?: boolean }) {
  const { preference, setPreference } = useTheme();
  const modes: { id: ThemePreference; Icon: typeof Sun; title: string }[] = [
    { id: 'light', Icon: Sun, title: 'Light' },
    { id: 'dark', Icon: Moon, title: 'Dark' },
    { id: 'system', Icon: Monitor, title: 'System' },
  ];

  if (collapsed) {
    return (
      <div className="flex flex-col gap-0.5 items-center py-1">
        {modes.map(({ id, Icon, title }) => (
          <button
            key={id}
            title={title}
            onClick={() => setPreference(id)}
            className={`w-8 h-8 flex items-center justify-center rounded-lg transition-colors ${
              preference === id ? 'bg-app-theme-active text-app-fg shadow-sm' : 'text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg'
            }`}
          >
            <Icon size={15} strokeWidth={1.5} />
          </button>
        ))}
      </div>
    );
  }

  return (
    <div className="mt-1 mb-2 px-0.5">
      <div className="text-[9px] font-mono font-medium text-app-fg-label uppercase tracking-[0.12em] px-2.5 mb-1.5">
        Appearance
      </div>
      <div className="flex gap-0.5 p-0.5 rounded-xl bg-app-theme-track border border-app-status-border" role="group">
        {modes.map(({ id, Icon, title }) => (
          <button
            key={id}
            title={title}
            onClick={() => setPreference(id)}
            className={`flex-1 flex items-center justify-center py-1.5 rounded-lg transition-colors ${
              preference === id ? 'bg-app-theme-active text-app-fg shadow-sm' : 'text-app-fg-muted hover:text-app-fg'
            }`}
          >
            <Icon size={15} strokeWidth={1.5} />
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Workspace avatar (image > gradient + letter) ──────────────────────────────
function WorkspaceAvatar({ ws, size = 16 }: { ws: Workspace; size?: number }) {
  const image = getWorkspaceImage(ws.id);
  if (image) {
    return (
      <div className="rounded-md overflow-hidden flex-shrink-0" style={{ width: size, height: size }}>
        <img src={image} alt={ws.name} className="w-full h-full object-cover" />
      </div>
    );
  }
  const initial = (ws.name.charAt(0) || '?').toUpperCase();
  const [c1, c2, c3] = getAvatarGradient(ws.name || 'workspace');
  return (
    <div
      className="rounded-md flex items-center justify-center text-white font-semibold flex-shrink-0 overflow-hidden"
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${c1} 0%, ${c2} 55%, ${c3} 100%)`,
        fontSize: Math.max(8, size * 0.55),
      }}
    >
      {initial}
    </div>
  );
}

// ── Folder icon helper ────────────────────────────────────────────────────────
function FolderGlyph({ folder, size = 14 }: { folder: FolderType; size?: number }) {
  if (folder.iconType === 'emoji' && folder.emoji) {
    return <span style={{ fontSize: size, lineHeight: 1 }}>{folder.emoji}</span>;
  }
  if (folder.emoji && folder.iconType !== 'icon') {
    return <span style={{ fontSize: size, lineHeight: 1 }}>{folder.emoji}</span>;
  }
  return <FolderIcon size={size} strokeWidth={1.7} style={{ color: folder.color || 'currentColor' }} />;
}

// ── Context menu ──────────────────────────────────────────────────────────────
interface ContextMenuItem {
  label: string;
  icon: typeof Pencil;
  onClick: () => void;
  destructive?: boolean;
  divider?: boolean;
}

function ContextMenu({
  items, anchorRef, onClose,
}: { items: ContextMenuItem[]; anchorRef: React.RefObject<HTMLElement>; onClose: () => void }) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number }>({ left: 0, top: 0 });

  useEffect(() => {
    if (!anchorRef.current) return;
    const r = anchorRef.current.getBoundingClientRect();
    setPos({ left: r.right + 6, top: r.top });
  }, [anchorRef]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  return (
    <div
      ref={menuRef}
      style={{ position: 'fixed', left: pos.left, top: pos.top }}
      className="z-[200] min-w-[180px] bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.6)] py-1"
    >
      {items.map((item, i) => (
        <div key={i}>
          {item.divider && <div className="h-px bg-app-divider mx-2 my-1" />}
          <button
            onClick={() => { item.onClick(); onClose(); }}
            className={`w-full flex items-center gap-2 px-3 py-1.5 text-[12.5px] text-left tracking-[-0.01em] transition-colors ${
              item.destructive
                ? 'text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30'
                : 'text-app-fg hover:bg-app-nav-hover-bg'
            }`}
          >
            <item.icon size={13} strokeWidth={1.7} className={item.destructive ? '' : 'text-app-fg-subtle'} />
            <span className="flex-1">{item.label}</span>
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Workspace row with expand + context menu ──────────────────────────────────
interface WorkspaceRowProps {
  ws: Workspace;
  folders: FolderType[];
  expanded: boolean;
  selectedWorkspaceId: string | null;
  selectedFolderId: string | null;
  onToggleExpand: () => void;
  onSelectWorkspace: () => void;
  onSelectFolder: (f: FolderType) => void;
  onCreateFolder: () => void;
  onRenameWorkspace: () => void;
  onShareWorkspace: () => void;
  onDeleteWorkspace: () => void;
  onRenameFolder: (f: FolderType) => void;
  onShareFolder: (f: FolderType) => void;
  onDeleteFolder: (f: FolderType) => void;
}

function WorkspaceRow({
  ws, folders, expanded, selectedWorkspaceId, selectedFolderId,
  onToggleExpand, onSelectWorkspace, onSelectFolder, onCreateFolder,
  onRenameWorkspace, onShareWorkspace, onDeleteWorkspace,
  onRenameFolder, onShareFolder, onDeleteFolder,
}: WorkspaceRowProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [folderMenu, setFolderMenu] = useState<FolderType | null>(null);
  const moreRef = useRef<HTMLButtonElement>(null);
  const folderMoreRefs = useRef<Record<string, HTMLButtonElement | null>>({});

  const isPrivate = isDefaultWorkspace(ws);
  const isActive = selectedWorkspaceId === ws.id && !selectedFolderId;

  return (
    <>
      <div
        onClick={onSelectWorkspace}
        className={`group w-full flex items-center gap-2 pl-1.5 pr-1 py-[6px] text-[13px] rounded-lg transition-all duration-200 cursor-pointer ${
          isActive ? 'bg-app-nav-active-bg text-app-nav-active-fg font-medium' : 'text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover'
        }`}
      >
        <button
          onClick={e => { e.stopPropagation(); onToggleExpand(); }}
          className="flex-shrink-0 w-4 h-4 flex items-center justify-center text-app-fg-subtle hover:text-app-fg transition-colors"
        >
          <ChevronRight size={11} strokeWidth={2} className={`transition-transform duration-150 ${expanded ? 'rotate-90' : ''}`} />
        </button>
        {isPrivate ? (
          <Lock size={13} strokeWidth={1.8} className="flex-shrink-0 text-app-fg-subtle" />
        ) : (
          <WorkspaceAvatar ws={ws} size={16} />
        )}
        <span className="flex-1 truncate tracking-[-0.01em]">{ws.name}</span>

        {/* + button shown on hover — creates folder in this workspace */}
        <button
          onClick={e => { e.stopPropagation(); onCreateFolder(); }}
          title="Create folder"
          className="opacity-0 group-hover:opacity-100 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-active-bg hover:text-app-fg transition-all"
        >
          <Plus size={12} strokeWidth={1.8} />
        </button>
      </div>

      {/* Folders */}
      {expanded && folders.map(f => {
        const folderActive = selectedFolderId === f.id;
        return (
          <div
            key={f.id}
            onClick={() => onSelectFolder(f)}
            className={`group flex items-center gap-2 pl-7 pr-1 py-[5px] text-[12.5px] rounded-lg cursor-pointer transition-colors ${
              folderActive ? 'bg-app-nav-active-bg text-app-nav-active-fg font-medium' : 'text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover'
            }`}
          >
            <FolderGlyph folder={f} size={13} />
            <span className="flex-1 truncate tracking-[-0.01em]">{f.name}</span>
            <button
              ref={el => { folderMoreRefs.current[f.id] = el; }}
              onClick={e => { e.stopPropagation(); setFolderMenu(f); }}
              className="opacity-0 group-hover:opacity-100 flex-shrink-0 w-5 h-5 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-active-bg hover:text-app-fg transition-all"
            >
              <span className="text-[10px] leading-none">⋯</span>
            </button>
          </div>
        );
      })}

      {/* "Add folder" placeholder when expanded and no folders */}
      {expanded && folders.length === 0 && (
        <button
          onClick={onCreateFolder}
          className="w-full flex items-center gap-2 pl-7 pr-2 py-[5px] text-[12px] rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors"
        >
          <FolderPlus size={12} strokeWidth={1.7} />
          <span className="truncate">Add folder</span>
        </button>
      )}

      {/* Hidden anchor for workspace context menu (... not shown in UI directly,
          but we expose a right-click pattern via the +/folder buttons) */}
      <button ref={moreRef} className="hidden" />
      {menuOpen && (
        <ContextMenu
          anchorRef={moreRef as any}
          onClose={() => setMenuOpen(false)}
          items={[
            { label: 'Create folder', icon: FolderPlus, onClick: onCreateFolder },
            { label: 'Add to favorites', icon: Star, onClick: () => {} },
            { label: 'Rename', icon: Pencil, onClick: onRenameWorkspace, divider: true },
            { label: 'Sharing settings', icon: UserPlus, onClick: onShareWorkspace },
            { label: 'Delete folder', icon: Trash2, onClick: onDeleteWorkspace, destructive: true, divider: true },
          ]}
        />
      )}

      {folderMenu && (
        <ContextMenu
          anchorRef={{ current: folderMoreRefs.current[folderMenu.id] } as any}
          onClose={() => setFolderMenu(null)}
          items={[
            { label: 'Create folder', icon: FolderPlus, onClick: onCreateFolder },
            { label: 'Add to favorites', icon: Star, onClick: () => {} },
            { label: 'Rename', icon: Pencil, onClick: () => onRenameFolder(folderMenu), divider: true },
            { label: 'Sharing settings', icon: UserPlus, onClick: () => onShareFolder(folderMenu) },
            { label: 'Delete folder', icon: Trash2, onClick: () => onDeleteFolder(folderMenu), destructive: true, divider: true },
          ]}
        />
      )}
    </>
  );
}

export default function MainSidebar({
  currentView,
  onViewChange,
  isOpen,
  onToggle,
  session,
  onSignOut,
  status,
  isCompactMode = false,
}: MainSidebarProps) {
  const [pendingSyncCount, setPendingSyncCount] = useState(0);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [foldersByWs, setFoldersByWs] = useState<Record<string, FolderType[]>>({});
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [showCreateWizard, setShowCreateWizard] = useState(false);
  const [folderModalForWs, setFolderModalForWs] = useState<string | null>(null);
  const [renameTarget, setRenameTarget] = useState<{ type: 'ws' | 'folder'; id: string; name: string } | null>(null);
  const selection = useWorkspaceSelection();

  useEffect(() => {
    getPendingTaskCount().then(setPendingSyncCount);
    const timer = window.setInterval(() => getPendingTaskCount().then(setPendingSyncCount), 1500);
    return () => window.clearInterval(timer);
  }, []);

  // Load workspaces (ensuring default exists) + auto-expand default
  useEffect(() => {
    ensureDefaultWorkspace().then(ws => {
      setWorkspaces(ws);
      // Auto-expand the default workspace + currently selected workspace
      const next: Record<string, boolean> = {};
      const def = ws.find(w => w.name === DEFAULT_WORKSPACE_NAME);
      if (def) next[def.id] = true;
      if (selection.workspaceId) next[selection.workspaceId] = true;
      setExpanded(prev => ({ ...next, ...prev }));
      // Prefetch folders for the default workspace
      if (def) getFolders(def.id).then(f => setFoldersByWs(p => ({ ...p, [def.id]: f }))).catch(() => {});
      // If nothing is selected yet, pick the default workspace
      if (!selection.workspaceId && def) setWorkspaceSelection(def.id, null);
    }).catch(() => {});
  }, []);

  const handleWorkspaceCreated = (ws: Workspace) => {
    setWorkspaces(prev => prev.some(w => w.id === ws.id) ? prev : [...prev, ws]);
    setExpanded(prev => ({ ...prev, [ws.id]: true }));
    setWorkspaceSelection(ws.id, null);
    onViewChange('workspace');
  };

  const toggleExpand = async (ws: Workspace) => {
    setExpanded(prev => ({ ...prev, [ws.id]: !prev[ws.id] }));
    if (!foldersByWs[ws.id]) {
      try {
        const f = await getFolders(ws.id);
        setFoldersByWs(p => ({ ...p, [ws.id]: f }));
      } catch {}
    }
  };

  const handleSelectWorkspace = (ws: Workspace) => {
    setWorkspaceSelection(ws.id, null);
    onViewChange('workspace');
    if (!foldersByWs[ws.id]) {
      getFolders(ws.id).then(f => setFoldersByWs(p => ({ ...p, [ws.id]: f }))).catch(() => {});
    }
  };

  const handleSelectFolder = (ws: Workspace, f: FolderType) => {
    setWorkspaceSelection(ws.id, f.id);
    onViewChange('workspace');
  };

  const handleFolderCreated = async (wsId: string, draft: FolderDraft) => {
    const created = await createFolder(wsId, draft.title, {
      iconType: draft.iconType,
      iconName: draft.iconName,
      color: draft.iconColor,
      emoji: draft.emoji,
      description: draft.description,
    });
    setFoldersByWs(p => ({ ...p, [wsId]: [...(p[wsId] || []), created] }));
    setExpanded(p => ({ ...p, [wsId]: true }));
    setFolderModalForWs(null);
    setWorkspaceSelection(wsId, created.id);
    onViewChange('workspace');
  };

  const handleRenameWorkspace = async (ws: Workspace) => {
    setRenameTarget({ type: 'ws', id: ws.id, name: ws.name });
  };
  const handleDeleteWorkspace = async (ws: Workspace) => {
    if (isDefaultWorkspace(ws)) return; // never delete My notes
    if (!window.confirm(`Delete "${ws.name}"? This removes all its folders.`)) return;
    await deleteWorkspace(ws.id).catch(() => {});
    setWorkspaces(prev => prev.filter(w => w.id !== ws.id));
    if (selection.workspaceId === ws.id) setWorkspaceSelection(null, null);
  };
  const handleDeleteFolderById = async (ws: Workspace, f: FolderType) => {
    if (!window.confirm(`Delete folder "${f.name}"?`)) return;
    await deleteFolder(f.id).catch(() => {});
    setFoldersByWs(p => ({ ...p, [ws.id]: (p[ws.id] || []).filter(x => x.id !== f.id) }));
    if (selection.folderId === f.id) setWorkspaceSelection(ws.id, null);
  };
  const commitRename = async () => {
    if (!renameTarget) return;
    const newName = renameTarget.name.trim();
    if (!newName) { setRenameTarget(null); return; }
    if (renameTarget.type === 'ws') {
      const updated = await updateWorkspace(renameTarget.id, { name: newName }).catch(() => null);
      if (updated) setWorkspaces(prev => prev.map(w => w.id === updated.id ? updated : w));
    } else {
      const updated = await renameFolder(renameTarget.id, newName).catch(() => null);
      if (updated) {
        setFoldersByWs(p => {
          const next = { ...p };
          for (const k of Object.keys(next)) {
            next[k] = next[k].map(f => f.id === updated.id ? { ...f, name: updated.name } : f);
          }
          return next;
        });
      }
    }
    setRenameTarget(null);
  };

  const navItems = [
    { id: 'process' as View, label: 'Home', icon: House },
    { id: 'history' as View, label: 'Meetings', icon: Clock },
    { id: 'chat' as View, label: 'Chat', icon: MessageSquareText },
    { id: 'knowledge' as View, label: 'Knowledge', icon: Network },
    { id: 'people' as View, label: 'People', icon: Users },
    { id: 'audio-devices' as View, label: 'Devices', icon: Headphones },
  ];

  // ── Collapsed: icon rail ────────────────────────────────────────────────────
  // Rail shows whenever the sidebar is closed (both in compact mode and when the
  // user manually collapses a wide window). Opening it renders the full sidebar
  // below — in compact mode that's an overlay (see the expanded branch), so the
  // user can ALWAYS toggle between the 52px rail and the full sidebar.
  if (!isOpen) {
    return (
      <div className="sidebar-grain h-full w-[52px] bg-app-canvas flex flex-col items-center flex-shrink-0 font-sans">
        <div className="h-[10px]" />

        {/* Standalone sidebar toggle */}
        <button
          onClick={onToggle}
          title="Open sidebar"
          style={{ pointerEvents: 'all', cursor: 'pointer' }}
          className="w-9 h-9 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover transition-colors flex-shrink-0 mb-1"
        >
          <svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}>
              <rect x="3" y="4.5" width="18" height="15" rx="4.5"/>
              <rect x="5.6" y="7" width="3.1" height="10" rx="1.5" fill="currentColor" stroke="none"/>
            </svg>
        </button>

        <nav className="flex flex-col items-center gap-0.5 px-1.5">
          {navItems.map(({ id, label, icon: Icon }) => {
            const isActive = currentView === id;
            return (
              <button
                key={id}
                onClick={() => onViewChange(id)}
                title={label}
                className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-200 relative group ${
                  isActive ? 'bg-app-nav-active-bg text-app-nav-active-fg shadow-sm' : 'text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover'
                }`}
              >
                <Icon size={17} strokeWidth={isActive ? 1.8 : 1.5} />
                <div className="absolute left-full ml-2.5 px-2.5 py-1 bg-zinc-900 text-white text-[10px] font-medium tracking-wide rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap z-[100]">
                  {label}
                </div>
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-h-0" />

        <ThemeAppearancePicker collapsed />

        <div className="flex flex-col items-center gap-0.5 pb-3 px-1.5">
          <button
            onClick={() => onViewChange('history')}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-all duration-200 relative ${
              currentView === 'history' ? 'bg-app-nav-active-bg text-app-nav-active-fg shadow-sm' : 'text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover'
            }`}
            title="History"
          >
            <Clock size={17} strokeWidth={1.5} />
            {pendingSyncCount > 0 && (
              <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-0.5 rounded-full bg-amber-500 text-white text-[8px] font-semibold leading-[14px] text-center">
                {pendingSyncCount > 9 ? '9+' : pendingSyncCount}
              </span>
            )}
          </button>
          <button
            onClick={onSignOut}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-950/40 dark:hover:text-red-400 transition-all duration-200"
            title="Sign Out"
          >
            <LogOut size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    );
  }

  // ── Expanded sidebar ────────────────────────────────────────────────────────
  return (
    <>
      {/* Transparent click-catcher behind the floating sidebar — lets a click on
          the page close the sidebar, WITHOUT dimming/tinting the content (no
          visual separation, per design). */}
      {isCompactMode && (
        <div className="fixed inset-0 z-[60]" onClick={onToggle} />
      )}

      <div className={`sidebar-grain bg-app-canvas flex flex-col flex-shrink-0 font-sans ${
        isCompactMode
          ? 'fixed left-2 top-[34px] bottom-2 w-[260px] z-[70] rounded-2xl border border-app-border shadow-2xl'
          : 'fixed md:relative h-full w-[200px] z-[70]'
      }`}>
        {/* 10px spacer matches the closed-state rail exactly — App.tsx widens the
            drag-region exclusion zone to left-[200px] when the sidebar is open, so
            the right-aligned toggle at x≈154px is outside the drag region at any y. */}
        <div className="w-full flex-shrink-0 h-[10px]" />

        {/* Header row: logo + name on left, close toggle on right */}
        <div className="flex items-center px-2 flex-shrink-0 mb-1">
          <div className="flex items-center gap-2 flex-1 min-w-0 pl-1">
            <WisprnoteLogo className="w-[26px] h-[26px] flex-shrink-0" />
            <span style={{ fontFamily: "'EB Garamond', Georgia, serif" }} className="text-[17px] font-semibold text-app-fg tracking-[-0.01em] truncate">Wisprnote</span>
          </div>
          <button
            onClick={onToggle}
            title="Close sidebar"
            style={{ pointerEvents: 'all', cursor: 'pointer' }}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover transition-colors flex-shrink-0"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="19" height="19" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" style={{ pointerEvents: 'none' }}>
                <rect x="3" y="4.5" width="18" height="15" rx="4.5"/>
                <path d="M8.6 4.5V19.5"/>
              </svg>
          </button>
        </div>

        {/* Main nav — identical icon container (w-9 h-9, size=17, gap-0.5) to the
            closed rail so nothing changes except the text label appearing beside it. */}
        <nav className="px-2 flex flex-col gap-0.5 flex-shrink-0">
          {navItems.map(({ id, label, icon: Icon }) => {
            const isActive = currentView === id;
            return (
              <button
                key={id}
                onClick={() => onViewChange(id)}
                className={`w-full flex items-center rounded-lg transition-all duration-200 ${
                  isActive ? 'bg-app-nav-active-bg text-app-nav-active-fg font-medium' : 'text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover'
                }`}
              >
                <div className="w-9 h-9 flex items-center justify-center flex-shrink-0">
                  <Icon size={17} strokeWidth={isActive ? 1.8 : 1.5} />
                </div>
                <span className="text-[13px] tracking-[-0.01em]">{label}</span>
                {id === 'history' && pendingSyncCount > 0 && (
                  <span className="ml-auto mr-2 inline-flex items-center rounded-full bg-amber-100 text-amber-800 dark:bg-amber-500/20 dark:text-amber-200 text-[9px] font-mono font-medium px-1.5 py-[1px]">
                    {pendingSyncCount > 99 ? '99+' : pendingSyncCount}
                  </span>
                )}
              </button>
            );
          })}
        </nav>

        <div className="flex-1 min-h-0" />

        {/* Inline rename modal */}
        {renameTarget && (
          <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setRenameTarget(null)}>
            <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[360px] p-5" onClick={e => e.stopPropagation()}>
              <h3 className="text-[14px] font-semibold text-app-fg mb-3">
                Rename {renameTarget.type === 'ws' ? 'workspace' : 'folder'}
              </h3>
              <input
                autoFocus
                value={renameTarget.name}
                onChange={e => setRenameTarget({ ...renameTarget, name: e.target.value })}
                onKeyDown={e => { if (e.key === 'Enter') commitRename(); if (e.key === 'Escape') setRenameTarget(null); }}
                className="w-full px-3 py-2 rounded-lg border border-app-divider bg-app-canvas outline-none text-[13px] text-app-fg focus:border-app-fg-subtle"
              />
              <div className="flex justify-end gap-2 mt-4">
                <button onClick={() => setRenameTarget(null)} className="px-3 py-1.5 rounded-lg text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg">Cancel</button>
                <button onClick={commitRename} className="px-3 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-fg text-app-canvas hover:opacity-90">Save</button>
              </div>
            </div>
          </div>
        )}



        {/* Bottom section — pinned footer (appearance + account) */}
        <div className="px-2.5 pb-3 pt-2 space-y-1 flex-shrink-0">
          {/* Upgrade prompt */}
          <button
            onClick={() => onViewChange('settings')}
            className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg border border-amber-200/70 dark:border-amber-500/25 bg-amber-50/60 dark:bg-amber-500/[0.08] hover:bg-amber-100/80 dark:hover:bg-amber-500/15 transition-colors"
          >
            <Star size={12} strokeWidth={1.8} className="text-amber-500 dark:text-amber-400 flex-shrink-0" />
            <span className="text-[11.5px] font-medium text-amber-700 dark:text-amber-400 tracking-[-0.01em]">Upgrade to Pro</span>
          </button>

          <ThemeAppearancePicker />

          <div className="h-px bg-app-divider w-full my-1" />

          <WorkspaceSwitcher
            workspaces={workspaces}
            activeWorkspaceId={workspaces[0]?.id ?? null}
            session={session}
            onSwitchWorkspace={(ws) => { setWorkspaceSelection(ws.id, null); onViewChange('workspace'); }}
            onCreateWorkspace={() => setShowCreateWizard(true)}
            onInvite={() => onViewChange('workspace')}
            onManageTemplates={() => onViewChange('settings')}
            onOpenHelp={() => onViewChange('settings')}
            onOpenSettings={() => onViewChange('settings')}
            onSignOut={onSignOut}
          />
        </div>

        {showCreateWizard && (
          <WorkspaceCreationWizard
            session={session}
            onClose={() => setShowCreateWizard(false)}
            onCreated={handleWorkspaceCreated}
          />
        )}
      </div>
    </>
  );
}
