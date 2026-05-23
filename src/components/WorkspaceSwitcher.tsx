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
} from 'lucide-react';
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

function Avatar({ ws, size = 20 }: { ws?: Workspace | null; size?: number }) {
  const initials = ws?.name?.substring(0, 2).toUpperCase() ?? 'WS';
  const bg = ws?.color || '#3f3f46';
  return (
    <div
      className="rounded-md flex items-center justify-center text-white font-medium flex-shrink-0 overflow-hidden"
      style={{ width: size, height: size, backgroundColor: bg, fontSize: Math.max(8, size * 0.42) }}
    >
      {ws?.emoji ? (
        <span style={{ fontSize: size * 0.7, lineHeight: 1 }}>{ws.emoji}</span>
      ) : (
        <span className="tracking-tight">{initials}</span>
      )}
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
        className="w-full flex items-center gap-2 px-2 py-1.5 rounded-xl text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover transition-all duration-200"
      >
        <Avatar ws={active} size={22} />
        <span className="flex-1 text-left text-[12.5px] font-medium tracking-[-0.01em] truncate">
          {active?.name ?? 'Personal'}
        </span>
        <ChevronsUpDown size={12} strokeWidth={1.8} className="text-app-fg-subtle flex-shrink-0" />
      </button>

      {open && (
        <div
          ref={popoverRef}
          className="absolute left-0 bottom-full mb-2 w-[268px] rounded-2xl bg-app-canvas border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.18)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] overflow-hidden z-[80] font-sans"
        >
          {/* Workspace header */}
          <div className="px-3 pt-3 pb-2.5">
            <div className="flex items-center gap-2.5">
              <Avatar ws={active} size={32} />
              <div className="flex-1 min-w-0">
                <div className="text-[13px] font-semibold text-app-fg tracking-[-0.01em] truncate">
                  {active?.name ?? 'Personal'}
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

            <div className="mt-0.5 space-y-px">
              {workspaces.map(ws => {
                const isActive = ws.id === active?.id;
                return (
                  <button
                    key={ws.id}
                    onClick={handle(() => onSwitchWorkspace(ws))}
                    className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg hover:bg-app-nav-hover-bg transition-colors text-left"
                  >
                    <Avatar ws={ws} size={20} />
                    <span className="flex-1 text-[12.5px] text-app-fg truncate tracking-[-0.01em]">
                      {ws.name}
                    </span>
                    {isActive && <Check size={13} strokeWidth={2} className="text-app-fg flex-shrink-0" />}
                  </button>
                );
              })}

              <button
                onClick={handle(onCreateWorkspace)}
                className="w-full flex items-center gap-2 px-1 py-1.5 rounded-lg text-app-fg-muted hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors text-left"
              >
                <div className="w-5 h-5 rounded-md border border-dashed border-app-divider flex items-center justify-center flex-shrink-0">
                  <Plus size={11} strokeWidth={2} />
                </div>
                <span className="text-[12.5px] tracking-[-0.01em]">Add workspace</span>
              </button>
            </div>
          </div>

          <div className="h-px bg-app-divider mx-3" />

          {/* Actions */}
          <div className="px-2 py-1.5">
            <MenuItem icon={LayoutTemplate} label="Manage templates" onClick={handle(onManageTemplates)} />
            <MenuItem icon={CircleHelp} label="Help Center" onClick={handle(onOpenHelp)} />
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
