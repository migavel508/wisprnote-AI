import { 
  FileText, 
  MessageCircle, 
  Share2, 
  History,
  Sidebar as SidebarIcon, 
  Mic,
  LogOut,
  BookMarked,
  Settings2,
  HelpCircle,
  Users,
  Gift,
  Settings,
} from 'lucide-react';
import { Session } from '@supabase/supabase-js';

type View = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks' | 'audio-devices';

interface MainSidebarProps {
  currentView: View;
  onViewChange: (view: View) => void;
  isOpen: boolean;
  onToggle: () => void;
  session: Session | null;
  onSignOut: () => void;
  status: string;
}

export default function MainSidebar({ 
  currentView, 
  onViewChange, 
  isOpen, 
  onToggle,
  session,
  onSignOut,
  status
}: MainSidebarProps) {

  const navItems = [
    { id: 'process' as View, label: 'Process', icon: Mic },
    { id: 'notes' as View, label: 'Notes', icon: FileText },
    { id: 'chat' as View, label: 'Chat', icon: MessageCircle },
    { id: 'notebooks' as View, label: 'Notebooks', icon: BookMarked },
    { id: 'knowledge' as View, label: 'Knowledge', icon: Share2 },
    { id: 'audio-devices' as View, label: 'Audio Devices', icon: Settings2 },
  ];

  const bottomItems = [
    { id: 'history' as View, label: 'History', icon: History },
    { id: 'settings' as const, label: 'Settings', icon: Settings },
    { id: 'help' as const, label: 'Help', icon: HelpCircle },
  ];

  // ─── Collapsed: icon-only rail ─────────────────────────────────────────────
  if (!isOpen) {
    return (
      <div className="h-screen w-[52px] bg-[#f5f0eb] flex flex-col items-center flex-shrink-0 font-[system-ui]">
        {/* Drag region for Tauri */}
        <div data-tauri-drag-region className="w-full h-8 flex-shrink-0 cursor-grab" />

        {/* Toggle */}
        <div className="pt-1 pb-4">
          <button
            onClick={onToggle}
            className="w-8 h-8 flex items-center justify-center text-[#8a8078] hover:text-[#1a1a1a] hover:bg-[#e8e0d8] rounded-lg transition-colors"
          >
            <SidebarIcon size={16} strokeWidth={2} />
          </button>
        </div>

        {/* Nav icons */}
        <nav className="flex flex-col items-center gap-1 px-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors relative group ${
                  isActive
                    ? 'bg-[#e8e0d8] text-[#1a1a1a]'
                    : 'text-[#8a8078] hover:bg-[#e8e0d8] hover:text-[#1a1a1a]'
                }`}
                title={item.label}
              >
                <Icon size={18} strokeWidth={isActive ? 2.2 : 1.8} />
                {/* Tooltip */}
                <div className="absolute left-full ml-2 px-2.5 py-1 bg-[#1a1a1a] text-white text-[11px] font-medium rounded-md opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap z-[100]">
                  {item.label}
                </div>
              </button>
            );
          })}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom icons */}
        <div className="flex flex-col items-center gap-1 pb-2 px-1.5">
          <button
            onClick={() => onViewChange('history')}
            className={`w-9 h-9 flex items-center justify-center rounded-lg transition-colors ${
              currentView === 'history'
                ? 'bg-[#e8e0d8] text-[#1a1a1a]'
                : 'text-[#8a8078] hover:bg-[#e8e0d8] hover:text-[#1a1a1a]'
            }`}
            title="History"
          >
            <History size={18} strokeWidth={1.8} />
          </button>
          <button
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[#8a8078] hover:bg-[#e8e0d8] hover:text-[#1a1a1a] transition-colors"
            title="Settings"
          >
            <Settings size={18} strokeWidth={1.8} />
          </button>
          <button
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[#8a8078] hover:bg-[#e8e0d8] hover:text-[#1a1a1a] transition-colors"
            title="Help"
          >
            <HelpCircle size={18} strokeWidth={1.8} />
          </button>
          <button
            onClick={onSignOut}
            className="w-9 h-9 flex items-center justify-center rounded-lg text-[#8a8078] hover:bg-red-50 hover:text-red-500 transition-colors"
            title="Sign Out"
          >
            <LogOut size={16} strokeWidth={1.8} />
          </button>
        </div>
      </div>
    );
  }

  // ─── Expanded: full sidebar with labels ────────────────────────────────────
  return (
    <>
      {/* Mobile overlay */}
      <div 
        className="fixed inset-0 bg-black/20 z-[60] md:hidden"
        onClick={onToggle}
      />
      
      <div className="fixed md:relative h-screen w-[200px] bg-[#f5f0eb] flex flex-col flex-shrink-0 font-[system-ui] z-[70]">
        {/* Drag region for Tauri */}
        <div data-tauri-drag-region className="w-full h-8 flex-shrink-0 cursor-grab" />

        {/* Top: Brand + Toggle */}
        <div className="flex items-center gap-2 px-4 pt-1 pb-5">
          <button
            onClick={onToggle}
            className="w-7 h-7 flex items-center justify-center text-[#8a8078] hover:text-[#1a1a1a] hover:bg-[#e8e0d8] rounded-lg transition-colors"
          >
            <SidebarIcon size={15} strokeWidth={2} />
          </button>
          <div className="flex items-center gap-1.5 ml-0.5">
            <img src="/logo.png" alt="Logo" className="w-5 h-5 rounded-full object-cover" />
            <span className="text-[14px] font-semibold text-[#1a1a1a] tracking-[-0.01em]">Wisprnote</span>
            <span className="text-[10px] font-semibold bg-[#e8e0d8] text-[#8a8078] px-1.5 py-0.5 rounded-md">Pro</span>
          </div>
        </div>

        {/* Main Navigation */}
        <nav className="px-2.5 space-y-0.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13.5px] rounded-lg transition-colors ${
                  isActive
                    ? 'bg-[#e8e0d8] text-[#1a1a1a] font-medium'
                    : 'text-[#6b635b] hover:bg-[#ece5de] hover:text-[#1a1a1a]'
                }`}
              >
                <Icon size={16} strokeWidth={isActive ? 2.2 : 1.8} className="flex-shrink-0" />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Recent Section */}
        <div className="mt-6 px-2.5">
          <div className="text-[10.5px] font-semibold text-[#a09890] uppercase tracking-wider px-2.5 mb-1.5">
            Recent
          </div>
          <button
            onClick={() => onViewChange('history')}
            className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13.5px] rounded-lg transition-colors ${
              currentView === 'history'
                ? 'bg-[#e8e0d8] text-[#1a1a1a] font-medium'
                : 'text-[#6b635b] hover:bg-[#ece5de] hover:text-[#1a1a1a]'
            }`}
          >
            <History size={16} strokeWidth={1.8} className="flex-shrink-0" />
            <span>All Meetings</span>
          </button>
        </div>

        {/* Status */}
        <div className="mt-4 mx-4">
          <div className="flex items-center gap-2 px-2.5 py-2 bg-white/40 rounded-lg border border-[#e5ddd5]">
            <div className={`w-[6px] h-[6px] rounded-full ${status === 'idle' ? 'bg-green-500' : 'bg-amber-500 animate-pulse'}`} />
            <span className="text-[11px] font-medium text-[#8a8078]">
              {status !== 'idle' ? status.charAt(0).toUpperCase() + status.slice(1) : 'Ready'}
            </span>
          </div>
        </div>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Bottom section */}
        <div className="px-2.5 pb-3 space-y-0.5">
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-lg text-[#6b635b] hover:bg-[#ece5de] hover:text-[#1a1a1a] transition-colors">
            <Users size={15} strokeWidth={1.8} className="flex-shrink-0" />
            <span>Invite your team</span>
          </button>
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-lg text-[#6b635b] hover:bg-[#ece5de] hover:text-[#1a1a1a] transition-colors">
            <Gift size={15} strokeWidth={1.8} className="flex-shrink-0" />
            <span>Get a free month</span>
          </button>
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-lg text-[#6b635b] hover:bg-[#ece5de] hover:text-[#1a1a1a] transition-colors">
            <Settings size={15} strokeWidth={1.8} className="flex-shrink-0" />
            <span>Settings</span>
          </button>
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-lg text-[#6b635b] hover:bg-[#ece5de] hover:text-[#1a1a1a] transition-colors">
            <HelpCircle size={15} strokeWidth={1.8} className="flex-shrink-0" />
            <span>Help</span>
          </button>

          {/* Divider */}
          <div className="h-px bg-[#e5ddd5] w-full my-2" />

          {/* User profile */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 px-2 py-1.5 flex-1 min-w-0">
              <div className="w-6 h-6 rounded-full bg-[#1f2937] flex items-center justify-center flex-shrink-0 relative overflow-hidden">
                <span className="text-white text-[9px] font-bold">
                  {session?.user?.email?.substring(0, 2).toUpperCase() || 'AI'}
                </span>
              </div>
              <span className="text-[12.5px] font-medium text-[#1a1a1a] truncate">
                {session?.user?.email?.split('@')[0] || 'User'}
              </span>
            </div>
            <button 
              onClick={onSignOut}
              className="p-1.5 text-[#a09890] hover:text-red-500 hover:bg-red-50 rounded-md transition-colors flex-shrink-0"
              title="Sign Out"
            >
              <LogOut size={14} strokeWidth={1.8} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
