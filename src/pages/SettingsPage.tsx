import { useState } from 'react';
import {
  Home,
  SlidersHorizontal,
  User,
  CalendarDays,
  Bell,
  Plug,
  Headphones,
  CircleHelp,
  Building2,
  Users,
  BarChart3,
  CreditCard,
  Gift,
  LogOut,
} from 'lucide-react';
import type { AuthSession } from '../services/awsAuthService';
import PreferencesTab from './settings/PreferencesTab';
import BillingTab from './settings/BillingTab';
import AnalyticsTab from './settings/AnalyticsTab';
import ConnectionsTab from './settings/ConnectionsTab';
import AudioDevicesPage from './AudioDevicesPage';
import { formatDisplayName, formatDisplayInitials } from '../lib/displayName';

export type SettingsTab =
  | 'preferences'
  | 'profile'
  | 'calendar'
  | 'notifications'
  | 'connectors'
  | 'devices'
  | 'help'
  | 'workspace-general'
  | 'team'
  | 'analytics'
  | 'billing'
  | 'referrals';

interface SettingsPageProps {
  session: AuthSession | null;
  onClose: () => void;
  onSignOut: () => void;
}

const PERSONAL_ITEMS: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: 'preferences', label: 'Preferences', icon: SlidersHorizontal },
  { id: 'profile', label: 'Profile', icon: User },
  { id: 'calendar', label: 'Calendar', icon: CalendarDays },
  { id: 'notifications', label: 'Notifications', icon: Bell },
  { id: 'connectors', label: 'Connectors', icon: Plug },
  { id: 'devices', label: 'Devices', icon: Headphones },
  { id: 'help', label: 'Get help', icon: CircleHelp },
];

const WORKSPACE_ITEMS: { id: SettingsTab; label: string; icon: typeof User }[] = [
  { id: 'workspace-general', label: 'General', icon: Building2 },
  { id: 'team', label: 'Team', icon: Users },
  { id: 'analytics', label: 'Analytics', icon: BarChart3 },
  { id: 'billing', label: 'Billing', icon: CreditCard },
  { id: 'referrals', label: 'Referrals', icon: Gift },
];

function ComingSoon({ title }: { title: string }) {
  return (
    <div className="max-w-[680px] mx-auto px-8 pb-16">
      <h1 className="text-[28px] font-serif text-app-fg tracking-[-0.02em] pt-2 mb-1">{title}</h1>
      <div className="mt-10 rounded-xl border border-dashed border-app-divider px-6 py-10 text-center">
        <div className="text-[13px] text-app-fg-subtle tracking-[-0.01em]">
          This section is coming next. Phase 3 will build it out.
        </div>
      </div>
    </div>
  );
}

const TAB_TITLES: Record<SettingsTab, string> = {
  preferences: 'Preferences',
  profile: 'Profile',
  calendar: 'Calendar',
  notifications: 'Notifications',
  connectors: 'Connectors',
  devices: 'Devices',
  help: 'Get help',
  'workspace-general': 'General',
  team: 'Team',
  analytics: 'Analytics',
  billing: 'Billing',
  referrals: 'Referrals',
};

function NavButton({
  icon: Icon,
  label,
  active,
  onClick,
}: {
  icon: typeof User;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-lg transition-all duration-200 ${
        active
          ? 'bg-app-nav-active-bg text-app-nav-active-fg font-medium shadow-sm'
          : 'text-app-nav-fg hover:bg-app-nav-hover-bg hover:text-app-nav-fg-hover'
      }`}
    >
      <Icon size={15} strokeWidth={active ? 1.8 : 1.5} className="flex-shrink-0" />
      <span className="tracking-[-0.01em]">{label}</span>
    </button>
  );
}

export default function SettingsPage({ session, onClose, onSignOut }: SettingsPageProps) {
  const [tab, setTab] = useState<SettingsTab>('preferences');

  const email = session?.user?.email ?? '';
  const name = formatDisplayName(email, session?.user?.name);
  const initials = formatDisplayInitials(email, session?.user?.name);
  const picture = session?.user?.picture;

  return (
    <div className="flex h-full bg-app-bg font-sans">
      {/* Left nav */}
      <aside className="w-[240px] flex-shrink-0 bg-app-canvas border-r border-app-divider flex flex-col">
        <div data-tauri-drag-region className="h-12 flex-shrink-0 cursor-grab" />

        {/* Profile header */}
        <div className="px-4 pt-2 pb-4 flex flex-col items-center text-center">
          <div className="w-12 h-12 rounded-full overflow-hidden bg-zinc-900 text-white dark:bg-zinc-100 dark:text-zinc-900 flex items-center justify-center mb-2">
            {picture ? (
              <img
                src={picture}
                alt={name}
                referrerPolicy="no-referrer"
                className="w-full h-full object-cover"
                onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
              />
            ) : (
              <span className="text-[14px] font-mono font-medium tracking-wider">{initials}</span>
            )}
          </div>
          <div className="text-[14px] font-semibold text-app-fg tracking-[-0.01em] truncate w-full">{name}</div>
          <div className="text-[11px] text-app-fg-subtle truncate w-full mt-0.5">{email}</div>
        </div>

        {/* Personal */}
        <nav className="px-2.5 space-y-px">
          {PERSONAL_ITEMS.map(item => (
            <NavButton
              key={item.id}
              icon={item.icon}
              label={item.label}
              active={tab === item.id}
              onClick={() => setTab(item.id)}
            />
          ))}
        </nav>

        {/* Workspace */}
        <div className="mt-5 px-2.5">
          <div className="text-[9px] font-mono font-medium text-app-fg-label uppercase tracking-[0.12em] px-2.5 mb-1.5">
            Workspace
          </div>
          <div className="space-y-px">
            {WORKSPACE_ITEMS.map(item => (
              <NavButton
                key={item.id}
                icon={item.icon}
                label={item.label}
                active={tab === item.id}
                onClick={() => setTab(item.id)}
              />
            ))}
          </div>
        </div>

        <div className="flex-1 min-h-0" />

        {/* Sign out */}
        <div className="px-2.5 pb-4">
          <button
            onClick={onSignOut}
            className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-lg text-red-600 dark:text-red-400 hover:bg-red-50 dark:hover:bg-red-950/30 transition-all duration-200"
          >
            <LogOut size={15} strokeWidth={1.5} className="flex-shrink-0" />
            <span className="tracking-[-0.01em] font-medium">Sign out</span>
          </button>
        </div>
      </aside>

      {/* Main content */}
      <main className="flex-1 min-w-0 flex flex-col bg-app-bg overflow-hidden">
        {/* Top bar */}
        <div data-tauri-drag-region className="relative h-12 flex-shrink-0 flex items-center px-4 border-b border-app-divider/60">
          <button
            onClick={onClose}
            title="Back"
            className="w-8 h-8 rounded-lg bg-app-canvas border border-app-divider flex items-center justify-center text-app-fg-muted hover:text-app-fg hover:border-app-fg-subtle/40 transition-colors"
          >
            <Home size={13} strokeWidth={1.8} />
          </button>
          <div className="absolute left-1/2 -translate-x-1/2 text-[12.5px] font-medium text-app-fg-muted tracking-[-0.01em]">
            Settings
          </div>
        </div>

        <div className="flex-1 overflow-y-auto">
          {tab === 'preferences' ? (
            <PreferencesTab />
          ) : tab === 'analytics' ? (
            <AnalyticsTab />
          ) : tab === 'billing' ? (
            <BillingTab session={session} />
          ) : tab === 'connectors' ? (
            <ConnectionsTab />
          ) : tab === 'devices' ? (
            <AudioDevicesPage />
          ) : (
            <ComingSoon title={TAB_TITLES[tab]} />
          )}
        </div>
      </main>
    </div>
  );
}
