import { ChevronDown, Lock, Radio, Power, PanelRightOpen, Palette, Sparkles, Link2, ExternalLink, Database } from 'lucide-react';
import Toggle from '../../components/ui/Toggle';
import { useTheme, type ThemePreference } from '../../theme/ThemeProvider';
import { useSetting } from './useSetting';

// ── Row primitive ────────────────────────────────────────────────────────────
function Row({
  icon: Icon,
  title,
  description,
  children,
  iconBg = 'bg-emerald-50 dark:bg-emerald-900/30 text-emerald-700 dark:text-emerald-300',
}: {
  icon: typeof Power;
  title: string;
  description: string;
  children: React.ReactNode;
  iconBg?: string;
}) {
  return (
    <div className="flex items-start gap-3 py-3.5">
      <div className={`w-8 h-8 rounded-lg flex items-center justify-center flex-shrink-0 ${iconBg}`}>
        <Icon size={15} strokeWidth={1.8} />
      </div>
      <div className="flex-1 min-w-0 pr-3">
        <div className="text-[13.5px] font-medium text-app-fg tracking-[-0.01em]">{title}</div>
        <div className="text-[12px] text-app-fg-subtle leading-snug mt-0.5">{description}</div>
      </div>
      <div className="flex-shrink-0 self-center">{children}</div>
    </div>
  );
}

function Card({ children }: { children: React.ReactNode }) {
  return (
    <div className="bg-app-canvas rounded-2xl border border-app-divider divide-y divide-app-divider px-4">
      {children}
    </div>
  );
}

function SectionHeading({ children }: { children: React.ReactNode }) {
  return (
    <div className="text-[11.5px] font-medium text-app-fg-subtle tracking-[-0.01em] mt-7 mb-2 px-1">
      {children}
    </div>
  );
}

// ── Select pill ──────────────────────────────────────────────────────────────
function Select<T extends string>({
  value,
  onChange,
  options,
}: {
  value: T;
  onChange: (v: T) => void;
  options: { value: T; label: string }[];
}) {
  return (
    <div className="relative">
      <select
        value={value}
        onChange={e => onChange(e.target.value as T)}
        className="appearance-none bg-app-nav-hover-bg text-app-fg text-[12.5px] font-medium rounded-lg pl-3 pr-8 py-1.5 tracking-[-0.01em] border border-app-divider hover:border-app-fg-subtle/40 transition-colors cursor-pointer focus:outline-none focus:ring-2 focus:ring-emerald-500/30 min-w-[140px]"
      >
        {options.map(opt => (
          <option key={opt.value} value={opt.value}>{opt.label}</option>
        ))}
      </select>
      <ChevronDown size={13} strokeWidth={2} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-app-fg-subtle pointer-events-none" />
    </div>
  );
}

// ── App icon picker ──────────────────────────────────────────────────────────
const APP_ICONS = [
  { id: 'classic', label: 'Classic', locked: false, bg: 'bg-emerald-500' },
  { id: 'noir', label: 'Noir', locked: false, bg: 'bg-zinc-900' },
  { id: 'paper', label: 'Paper', locked: false, bg: 'bg-zinc-100 border border-zinc-300' },
  { id: 'plum', label: 'Plum', locked: true, bg: 'bg-purple-400' },
  { id: 'slate', label: 'Slate', locked: true, bg: 'bg-slate-400' },
  { id: 'rose', label: 'Rose', locked: true, bg: 'bg-rose-300' },
  { id: 'sky', label: 'Sky', locked: true, bg: 'bg-sky-300' },
];

function AppIconPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div className="bg-app-nav-hover-bg rounded-xl p-2 flex items-center gap-1.5 mt-1">
      {APP_ICONS.map(icon => {
        const isActive = value === icon.id;
        return (
          <button
            key={icon.id}
            disabled={icon.locked}
            onClick={() => !icon.locked && onChange(icon.id)}
            title={icon.label + (icon.locked ? ' (Pro)' : '')}
            className={`relative w-10 h-10 rounded-lg flex items-center justify-center transition-all flex-shrink-0 ${icon.bg} ${
              isActive ? 'ring-2 ring-offset-2 ring-emerald-600 ring-offset-app-nav-hover-bg' : ''
            } ${icon.locked ? 'opacity-60 cursor-not-allowed' : 'hover:scale-105 cursor-pointer'}`}
          >
            <div className="w-4 h-4 rounded-full border-2 border-white/90" />
            {icon.locked && (
              <div className="absolute -bottom-0.5 -right-0.5 w-4 h-4 rounded-full bg-zinc-900 text-white flex items-center justify-center">
                <Lock size={8} strokeWidth={2.5} />
              </div>
            )}
          </button>
        );
      })}
    </div>
  );
}

// ── Tab content ──────────────────────────────────────────────────────────────
export default function PreferencesTab() {
  const { preference: themePref, setPreference: setThemePref } = useTheme();

  const [liveIndicator, setLiveIndicator] = useSetting('liveMeetingIndicator', true);
  const [openOnLogin, setOpenOnLogin] = useSetting('openOnLogin', false);
  const [moveAsideInMeeting, setMoveAsideInMeeting] = useSetting('moveAsideInMeeting', true);
  const [appIcon, setAppIcon] = useSetting<string>('appIcon', 'classic');
  const [defaultShare, setDefaultShare] = useSetting<'anyone' | 'workspace' | 'private'>('defaultLinkSharing', 'anyone');
  const [openLinksInApp, setOpenLinksInApp] = useSetting('openSharedLinksInApp', true);
  const [improveModels, setImproveModels] = useSetting('improveModels', false);

  return (
    <div className="max-w-[680px] mx-auto px-8 pb-16">
      <h1 className="text-[28px] font-serif text-app-fg tracking-[-0.02em] pt-2 mb-1">Preferences</h1>

      <SectionHeading>General</SectionHeading>
      <Card>
        <Row
          icon={Radio}
          title="Live meeting indicator"
          description="Shows on the right of your screen while transcribing"
        >
          <Toggle checked={liveIndicator} onChange={setLiveIndicator} ariaLabel="Live meeting indicator" />
        </Row>
        <Row
          icon={Power}
          title="Open WisprNote when you log in"
          description="WisprNote will open automatically when you log in"
          iconBg="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
        >
          <Toggle checked={openOnLogin} onChange={setOpenOnLogin} ariaLabel="Open on login" />
        </Row>
        <Row
          icon={PanelRightOpen}
          title="Move WisprNote aside in meetings"
          description="When a meeting starts, WisprNote repositions so you can keep taking notes"
          iconBg="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
        >
          <Toggle checked={moveAsideInMeeting} onChange={setMoveAsideInMeeting} ariaLabel="Move aside in meetings" />
        </Row>
      </Card>

      <SectionHeading>Appearance</SectionHeading>
      <Card>
        <Row
          icon={Palette}
          title="Theme"
          description="Choose your interface color scheme"
          iconBg="bg-blue-50 dark:bg-blue-900/30 text-blue-700 dark:text-blue-300"
        >
          <Select<ThemePreference>
            value={themePref}
            onChange={setThemePref}
            options={[
              { value: 'light', label: 'Light' },
              { value: 'dark', label: 'Dark' },
              { value: 'system', label: 'System' },
            ]}
          />
        </Row>
        <div className="py-3.5">
          <div className="flex items-start gap-3">
            <div className="w-8 h-8 rounded-lg bg-amber-50 dark:bg-amber-900/30 text-amber-700 dark:text-amber-300 flex items-center justify-center flex-shrink-0">
              <Sparkles size={15} strokeWidth={1.8} />
            </div>
            <div className="flex-1 min-w-0">
              <div className="text-[13.5px] font-medium text-app-fg tracking-[-0.01em]">App icon</div>
              <div className="text-[12px] text-app-fg-subtle leading-snug mt-0.5">Unlock custom icons for your notepad</div>
              <AppIconPicker value={appIcon} onChange={setAppIcon} />
            </div>
          </div>
        </div>
      </Card>

      <SectionHeading>Data &amp; sharing</SectionHeading>
      <Card>
        <Row
          icon={Link2}
          title="Default link sharing"
          description="By default, your notes are viewable by anyone with the link"
          iconBg="bg-violet-50 dark:bg-violet-900/30 text-violet-700 dark:text-violet-300"
        >
          <Select<'anyone' | 'workspace' | 'private'>
            value={defaultShare}
            onChange={setDefaultShare}
            options={[
              { value: 'anyone', label: 'Anyone with the link' },
              { value: 'workspace', label: 'Workspace members' },
              { value: 'private', label: 'Only me' },
            ]}
          />
        </Row>
        <Row
          icon={ExternalLink}
          title="Always open shared links in WisprNote"
          description="When you visit a shared note or folder link in your web browser, automatically open it in the WisprNote desktop app"
          iconBg="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
        >
          <Toggle checked={openLinksInApp} onChange={setOpenLinksInApp} ariaLabel="Open shared links in app" />
        </Row>
        <Row
          icon={Database}
          title="Use my data to improve models for everyone"
          description="Your data is anonymized and used to improve the experience for WisprNote users."
          iconBg="bg-zinc-100 dark:bg-zinc-800 text-zinc-700 dark:text-zinc-300"
        >
          <Toggle checked={improveModels} onChange={setImproveModels} ariaLabel="Improve models" />
        </Row>
      </Card>
    </div>
  );
}
