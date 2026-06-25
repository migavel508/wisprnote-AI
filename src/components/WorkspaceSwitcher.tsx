import { useEffect, useRef, useState } from 'react';
import {
  Check,
  ChevronsUpDown,
  Plus,
  LayoutTemplate,
  CircleHelp,
  Settings,
  UserPlus,
  ArrowLeftRight,
  LogOut,
  Smartphone,
  Lock,
  ChevronRight,
} from 'lucide-react';
import { isDefaultWorkspace, getWorkspaceImage, getAvatarGradient } from '../services/workspaceService';
import type { Workspace } from '../services/workspaceService';
import type { AuthSession } from '../services/awsAuthService';
import { formatDisplayName } from '../lib/displayName';

interface WorkspaceSwitcherProps {
  workspaces: Workspace[];
  activeWorkspaceId: string | null;
  session: AuthSession | null;
  onSwitchWorkspace: (ws: Workspace) => void;
  onCreateWorkspace: () => void;
  onInvite: () => void;
  onManageTemplates: () => void;
  onOpenHelp: () => void;
  onOpenSettings: () => void;
  onSignOut: () => void;
}

function Avatar({ ws, size = 20, userPicture, userName }: { ws?: Workspace | null; size?: number; userPicture?: string | null; userName?: string }) {
  // The DEFAULT workspace is the user's own vault → show their profile photo (or a
  // gradient with their initial), never a generic lock.
  if (ws && isDefaultWorkspace(ws)) {
    if (userPicture) {
      return (
        <div className="rounded-md flex-shrink-0 overflow-hidden" style={{ width: size, height: size }}>
          <img src={userPicture} alt={userName ?? 'You'} className="w-full h-full object-cover" />
        </div>
      );
    }
    const [d1, d2, d3] = getAvatarGradient(userName || ws.name || 'you');
    return (
      <div
        className="rounded-md flex items-center justify-center text-white font-semibold flex-shrink-0"
        style={{ width: size, height: size, background: `linear-gradient(135deg, ${d1} 0%, ${d2} 55%, ${d3} 100%)`, fontSize: Math.max(8, size * 0.55) }}
      >
        <span className="tracking-tight">{(userName?.charAt(0) || ws.name?.charAt(0) || '?').toUpperCase()}</span>
      </div>
    );
  }
  const image = ws ? getWorkspaceImage(ws.id) : null;
  if (image) {
    return (
      <div
        className="rounded-md flex-shrink-0 overflow-hidden"
        style={{ width: size, height: size }}
      >
        <img src={image} alt={ws?.name ?? 'Workspace'} className="w-full h-full object-cover" />
      </div>
    );
  }
  const initial = (ws?.name?.charAt(0) || '?').toUpperCase();
  const [c1, c2, c3] = getAvatarGradient(ws?.name || 'workspace');
  return (
    <div
      className="rounded-md flex items-center justify-center text-white font-semibold flex-shrink-0 overflow-hidden"
      style={{
        width: size, height: size,
        background: `linear-gradient(135deg, ${c1} 0%, ${c2} 55%, ${c3} 100%)`,
        fontSize: Math.max(8, size * 0.55),
      }}
    >
      <span className="tracking-tight">{initial}</span>
    </div>
  );
}

export default function WorkspaceSwitcher({
  workspaces,
  activeWorkspaceId,
  session,
  onSwitchWorkspace,
  onCreateWorkspace,
  onInvite,
  onManageTemplates,
  onOpenHelp,
  onOpenSettings,
  onSignOut,
}: WorkspaceSwitcherProps) {
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);

  const active = workspaces.find(w => w.id === activeWorkspaceId) ?? workspaces[0] ?? null;
  const memberCount = 1; // stub; can be wired to getWorkspaceMembers later

  // The default workspace shows the USER's name + photo (it's their personal vault).
  const userName = session?.user?.name || session?.user?.email?.split('@')[0] || 'Workspace';
  const userPicture = (session?.user as any)?.picture || (session?.user as any)?.image || null;
  const displayName = (ws?: Workspace | null) => (ws && isDefaultWorkspace(ws) ? userName : (ws?.name ?? 'Personal'));
  const atWorkspaceLimit = workspaces.length >= 5;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (
        popoverRef.current && !popoverRef.current.contains(e.target as Node) &&
        triggerRef.current && !triggerRef.current.contains(e.target as Node)
      ) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', onDoc);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDoc);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Cmd+, keyboard shortcut for Settings
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === ',') {
        e.preventDefault();
        setOpen(false);
        onOpenSettings();
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onOpenSettings]);

  const handle = (fn: () => void) => () => { setOpen(false); fn(); };

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        onClick={() => setOpen(v => !v)}
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover transition-all duration-200"
      >
        <Avatar ws={active} size={22} userPicture={userPicture} userName={userName} />
        <span className="flex-1 text-left text-[12.5px] font-medium tracking-[-0.01em] truncate">
          {displayName(active)}
        </span>
        <ChevronsUpDown size={12} strokeWidth={1.8} className="text-app-fg-subtle flex-shrink-0" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute left-0 bottom-full mb-2 w-[268px] rounded-2xl bg-app-canvas border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] z-[80] font-sans"
        >
          {/* Workspace header */}
          <div className="px-3 pt-3 pb-2.5">
            <div className="flex items-center gap-2.5">
              <Avatar ws={active} size={32} userPicture={userPicture} userName={userName} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-app-fg tracking-[-0.01em] truncate">
                  {displayName(active)}
                </div>
                <div className="text-[11px] text-app-fg-subtle tracking-[-0.01em]">
                  {memberCount} {memberCount === 1 ? 'member' : 'members'}
                </div>
              </div>
            </div>

            <button
              onClick={handle(onInvite)}
              className="mt-2.5 w-full flex items-center justify-center gap-1.5 py-1.5 rounded-lg bg-app-nav-hover-bg text-app-nav-fg hover:text-app-nav-fg-hover transition-colors text-[12px] font-medium tracking-[-0.01em]"
            >
              <UserPlus size={13} strokeWidth={1.6} />
              <span>Invite teammates</span>
            </button>
          </div>

          <div className="h-px bg-app-divider mx-3" />

          {/* Account switcher */}
          <div className="px-3 py-2">
            <div className="flex items-center justify-between gap-2 px-1 py-1">
              <div className="flex-1 min-w-0">
                <div className="text-[12px] font-medium text-app-fg truncate tracking-[-0.01em]">
                  {formatDisplayName(session?.user?.email, session?.user?.name, 'Signed out')}
                </div>
                {session?.user?.email && (
                  <div className="text-[10.5px] text-app-fg-subtle truncate tracking-[-0.01em]">
                    {session.user.email}
                  </div>
                )}
              </div>
              <button
                title="Switch account"
                className="p-1 rounded-md text-app-fg-subtle hover:text-app-fg hover:bg-app-nav-hover-bg transition-colors flex-shrink-0"
              >
                <ArrowLeftRight size={12} strokeWidth={1.7} />
              </button>
            </div>

            <WorkspaceList
              workspaces={workspaces}
              activeId={active?.id}
              userName={userName}
              userPicture={userPicture}
              atLimit={atWorkspaceLimit}
              onSwitch={(ws) => handle(() => onSwitchWorkspace(ws))()}
              onCreate={handle(onCreateWorkspace)}
            />
          </div>

          <div className="h-px bg-app-divider mx-3" />

          {/* Actions */}
          <div className="px-2 py-1.5">
            <MenuItem icon={Settings} label="Settings" onClick={handle(onOpenSettings)} shortcut="⌘," />
          </div>

          <div className="h-px bg-app-divider mx-3" />

          <div className="px-2 py-1.5">
            <MenuItem icon={LogOut} label="Sign out" onClick={handle(onSignOut)} destructive />
          </div>
        </div>
      )}
    </div>
  );
}

// ── Workspace list with "More workspaces" collapse ────────────────────────────

const VISIBLE_THRESHOLD = 2;

function WorkspaceList({
  workspaces, activeId, userName, userPicture, atLimit, onSwitch, onCreate,
}: {
  workspaces: Workspace[];
  activeId?: string;
  userName: string;
  userPicture?: string | null;
  atLimit: boolean;
  onSwitch: (ws: Workspace) => void;
  onCreate: () => void;
}) {
  const nameOf = (ws: Workspace) => (isDefaultWorkspace(ws) ? userName : ws.name);
  const [showMore, setShowMore] = useState(false);
  const moreRef = useRef<HTMLButtonElement>(null);
  const subRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!showMore) return;
    const onDoc = (e: MouseEvent) => {
      if (
        subRef.current && !subRef.current.contains(e.target as Node) &&
        moreRef.current && !moreRef.current.contains(e.target as Node)
      ) setShowMore(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [showMore]);

  // Always show the user's default (home) workspace first, then the others by age.
  const sorted = [...workspaces].sort((a, b) => {
    if (isDefaultWorkspace(a)) return -1;
    if (isDefaultWorkspace(b)) return 1;
    return new Date(a.created_at).getTime() - new Date(b.created_at).getTime();
  });

  const visible = sorted.slice(0, VISIBLE_THRESHOLD);
  const hidden = sorted.slice(VISIBLE_THRESHOLD);

  return (
    <div className="mt-0.5 space-y-px">
      {visible.map(ws => {
        const isActive = ws.id === activeId;
        return (
          <button
            key={ws.id}
            onClick={() => onSwitch(ws)}
            className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg hover:bg-app-nav-hover-bg transition-colors text-left"
          >
            <Avatar ws={ws} size={20} userPicture={userPicture} userName={userName} />
            <span className="flex-1 text-[12.5px] text-app-fg truncate tracking-[-0.01em]">{nameOf(ws)}</span>
            {isActive && <Check size={13} strokeWidth={2} className="text-app-fg flex-shrink-0" />}
          </button>
        );
      })}

      {hidden.length > 0 ? (
        <div className="relative">
          <button
            ref={moreRef}
            onClick={() => setShowMore(v => !v)}
            className={`w-full flex items-center gap-2 px-1 py-1.5 rounded-lg transition-colors text-left ${
              showMore ? 'bg-app-nav-hover-bg' : 'hover:bg-app-nav-hover-bg'
            }`}
          >
            <div className="w-5 h-5 flex-shrink-0" />
            <span className="flex-1 text-[12.5px] text-app-fg truncate tracking-[-0.01em]">More workspaces</span>
            <ChevronRight size={12} strokeWidth={1.8} className="text-app-fg-subtle flex-shrink-0" />
          </button>

          {showMore && (
            <div
              ref={subRef}
              className="absolute left-full top-0 -translate-y-1.5 ml-2 w-[224px] bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] p-1.5 z-[90]"
            >
              {hidden.map(ws => {
                const isActive = ws.id === activeId;
                return (
                  <button
                    key={ws.id}
                    onClick={() => { setShowMore(false); onSwitch(ws); }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-app-nav-hover-bg transition-colors text-left"
                  >
                    <Avatar ws={ws} size={20} userPicture={userPicture} userName={userName} />
                    <span className="flex-1 text-[12.5px] text-app-fg truncate tracking-[-0.01em]">{nameOf(ws)}</span>
                    {isActive && <Check size={13} strokeWidth={2} className="text-app-fg flex-shrink-0" />}
                  </button>
                );
              })}
              {!atLimit && (
                <button
                  onClick={() => { setShowMore(false); onCreate(); }}
                  className="w-full flex items-center gap-2 px-2 py-1.5 rounded-lg text-app-fg hover:bg-app-nav-hover-bg transition-colors text-left"
                >
                  <Plus size={14} strokeWidth={1.8} className="flex-shrink-0 text-app-fg-subtle" />
                  <span className="text-[12.5px] tracking-[-0.01em]">Add workspace</span>
                </button>
              )}
            </div>
          )}
        </div>
      ) : !atLimit ? (
        <button
          onClick={onCreate}
          className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg text-app-fg-muted hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors text-left"
        >
          <div className="w-5 h-5 rounded-md border border-dashed border-app-divider flex items-center justify-center flex-shrink-0">
            <Plus size={11} strokeWidth={2} />
          </div>
          <span className="text-[12.5px] tracking-[-0.01em]">Add workspace</span>
        </button>
      ) : null}
    </div>
  );
}

function MenuItem({
  icon: Icon,
  label,
  onClick,
  shortcut,
  destructive,
}: {
  icon: typeof Settings;
  label: string;
  onClick: () => void;
  shortcut?: string;
  destructive?: boolean;
}) {
  const base = destructive
    ? 'text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30'
    : 'text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover';
  const iconCls = destructive ? 'text-red-500/80' : 'text-app-fg-subtle';
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2 py-1.5 rounded-lg transition-colors text-left ${base}`}
    >
      <Icon size={14} strokeWidth={1.6} className={`flex-shrink-0 ${iconCls}`} />
      <span className="flex-1 text-[12.5px] tracking-[-0.01em]">{label}</span>
      {shortcut && (
        <span className="text-[10px] font-mono text-app-fg-subtle tracking-wider">{shortcut}</span>
      )}
    </button>
  );
}
