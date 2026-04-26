import { useEffect, useState } from 'react';
import { 
  PenLine, 
  MessageSquareText, 
  Network, 
  Clock,
  PanelLeft, 
  AudioLines,
  LogOut,
  BookOpen,
  Headphones,
  UserPlus,
  Sparkles,
  Settings,
  CircleHelp,
} from 'lucide-react';
import { Session } from '@supabase/supabase-js';
import { getPendingTaskCount } from '../services/supabaseService';

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
  const [pendingSyncCount, setPendingSyncCount] = useState(0);

  useEffect(() => {
    setPendingSyncCount(getPendingTaskCount());
    const timer = window.setInterval(() => {
      setPendingSyncCount(getPendingTaskCount());
    }, 1500);
    return () => window.clearInterval(timer);
  }, []);

  const navItems = [
    { id: 'process' as View, label: 'Record', icon: AudioLines },
    { id: 'notes' as View, label: 'Notes', icon: PenLine },
    { id: 'chat' as View, label: 'Chat', icon: MessageSquareText },
    { id: 'notebooks' as View, label: 'Notebooks', icon: BookOpen },
    { id: 'knowledge' as View, label: 'Knowledge', icon: Network },
    { id: 'audio-devices' as View, label: 'Devices', icon: Headphones },
  ];

  // ─── Collapsed: icon-only rail ─────────────────────────────────────────────
  if (!isOpen) {
    return (
      <div className="h-screen w-[52px] bg-[#e5ddd4] flex flex-col items-center flex-shrink-0 font-sans">
        <div data-tauri-drag-region className="w-full h-12 flex-shrink-0 cursor-grab" />

        <div className="pt-1 pb-4">
          <button
            onClick={onToggle}
            className="w-8 h-8 flex items-center justify-center text-[#9a918a] hover:text-[#1a1a1a] hover:bg-[#d5cbc0] rounded-xl transition-all duration-200"
          >
            <PanelLeft size={16} strokeWidth={1.5} />
          </button>
        </div>

        <nav className="flex flex-col items-center gap-0.5 px-1.5">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-200 relative group ${
                  isActive
                    ? 'bg-[#d5cbc0] text-[#1a1a1a] shadow-sm'
                    : 'text-[#9a918a] hover:bg-[#ddd4c9] hover:text-[#5a524a]'
                }`}
                title={item.label}
              >
                <Icon size={17} strokeWidth={isActive ? 1.8 : 1.5} />
                <div className="absolute left-full ml-2.5 px-2.5 py-1 bg-[#1a1a1a] text-white text-[10px] font-medium tracking-wide rounded-lg opacity-0 group-hover:opacity-100 pointer-events-none transition-opacity whitespace-nowrap z-[100]">
                  {item.label}
                </div>
              </button>
            );
          })}
        </nav>

        <div className="flex-1" />

        <div className="flex flex-col items-center gap-0.5 pb-3 px-1.5">
          <button
            onClick={() => onViewChange('history')}
            className={`w-9 h-9 flex items-center justify-center rounded-xl transition-all duration-200 relative ${
              currentView === 'history'
                ? 'bg-[#d5cbc0] text-[#1a1a1a] shadow-sm'
                : 'text-[#9a918a] hover:bg-[#ddd4c9] hover:text-[#5a524a]'
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
            className="w-9 h-9 flex items-center justify-center rounded-xl text-[#9a918a] hover:bg-[#ddd4c9] hover:text-[#5a524a] transition-all duration-200"
            title="Settings"
          >
            <Settings size={17} strokeWidth={1.5} />
          </button>
          <button
            className="w-9 h-9 flex items-center justify-center rounded-xl text-[#9a918a] hover:bg-[#ddd4c9] hover:text-[#5a524a] transition-all duration-200"
            title="Help"
          >
            <CircleHelp size={17} strokeWidth={1.5} />
          </button>
          <button
            onClick={onSignOut}
            className="w-9 h-9 flex items-center justify-center rounded-xl text-[#9a918a] hover:bg-red-50 hover:text-red-500 transition-all duration-200"
            title="Sign Out"
          >
            <LogOut size={15} strokeWidth={1.5} />
          </button>
        </div>
      </div>
    );
  }

  // ─── Expanded: full sidebar with labels ────────────────────────────────────
  return (
    <>
      <div 
        className="fixed inset-0 bg-black/20 z-[60] md:hidden"
        onClick={onToggle}
      />
      
      <div className="fixed md:relative h-screen w-[200px] bg-[#e5ddd4] flex flex-col flex-shrink-0 font-sans z-[70]">
        <div data-tauri-drag-region className="w-full h-12 flex-shrink-0 cursor-grab" />

        {/* Brand */}
        <div className="flex items-center gap-2 px-4 pt-1 pb-5">
          <button
            onClick={onToggle}
            className="w-7 h-7 flex items-center justify-center text-[#9a918a] hover:text-[#1a1a1a] hover:bg-[#d5cbc0] rounded-xl transition-all duration-200"
          >
            <PanelLeft size={15} strokeWidth={1.5} />
          </button>
          <div className="flex items-center gap-1.5 ml-0.5">
            <img src="/logo.png" alt="Logo" className="w-5 h-5 rounded-full object-cover" />
            <span className="text-[15px] font-serif italic font-semibold text-[#1a1a1a] tracking-[-0.01em]">Wisprnote</span>
            <span className="text-[9px] font-mono font-medium bg-[#d5cbc0] text-[#7a726a] px-1.5 py-0.5 rounded-md uppercase tracking-wider">Pro</span>
          </div>
        </div>

        {/* Main Navigation */}
        <nav className="px-2.5 space-y-px">
          {navItems.map((item) => {
            const Icon = item.icon;
            const isActive = currentView === item.id;
            return (
              <button
                key={item.id}
                onClick={() => onViewChange(item.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-xl transition-all duration-200 ${
                  isActive
                    ? 'bg-[#d5cbc0] text-[#1a1a1a] font-medium shadow-sm'
                    : 'text-[#7a726a] hover:bg-[#ddd4c9] hover:text-[#3a3530]'
                }`}
              >
                <Icon size={15} strokeWidth={isActive ? 1.8 : 1.5} className="flex-shrink-0" />
                <span className="tracking-[-0.01em]">{item.label}</span>
              </button>
            );
          })}
        </nav>

        {/* Recent Section */}
        <div className="mt-5 px-2.5">
          <div className="text-[9px] font-mono font-medium text-[#a09890] uppercase tracking-[0.12em] px-2.5 mb-1.5">
            Recent
          </div>
          <button
            onClick={() => onViewChange('history')}
            className={`w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[13px] rounded-xl transition-all duration-200 ${
              currentView === 'history'
                ? 'bg-[#d5cbc0] text-[#1a1a1a] font-medium shadow-sm'
                : 'text-[#7a726a] hover:bg-[#ddd4c9] hover:text-[#3a3530]'
            }`}
          >
            <Clock size={15} strokeWidth={1.5} className="flex-shrink-0" />
            <span className="tracking-[-0.01em]">All Meetings</span>
            {pendingSyncCount > 0 && (
              <span className="ml-auto inline-flex items-center rounded-full bg-amber-100 text-amber-700 text-[9px] font-mono font-medium px-1.5 py-[1px]">
                {pendingSyncCount > 99 ? '99+' : pendingSyncCount}
              </span>
            )}
          </button>
        </div>

        {/* Status */}
        <div className="mt-4 mx-4">
          <div className="flex items-center gap-2 px-2.5 py-2 bg-white/30 rounded-xl border border-[#cec4b8]/60">
            <div className={`w-[5px] h-[5px] rounded-full ${status === 'idle' ? 'bg-emerald-500' : 'bg-amber-500 animate-pulse'}`} />
            <span className="text-[10px] font-mono font-medium text-[#8a8078] uppercase tracking-wider">
              {status !== 'idle' ? status.charAt(0).toUpperCase() + status.slice(1) : 'Ready'}
            </span>
          </div>
        </div>

        <div className="flex-1" />

        {/* Bottom section */}
        <div className="px-2.5 pb-3 space-y-px">
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] rounded-xl text-[#7a726a] hover:bg-[#ddd4c9] hover:text-[#3a3530] transition-all duration-200">
            <UserPlus size={14} strokeWidth={1.5} className="flex-shrink-0" />
            <span className="tracking-[-0.01em]">Invite your team</span>
          </button>
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] rounded-xl text-[#7a726a] hover:bg-[#ddd4c9] hover:text-[#3a3530] transition-all duration-200">
            <Sparkles size={14} strokeWidth={1.5} className="flex-shrink-0" />
            <span className="tracking-[-0.01em]">Get a free month</span>
          </button>
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] rounded-xl text-[#7a726a] hover:bg-[#ddd4c9] hover:text-[#3a3530] transition-all duration-200">
            <Settings size={14} strokeWidth={1.5} className="flex-shrink-0" />
            <span className="tracking-[-0.01em]">Settings</span>
          </button>
          <button className="w-full flex items-center gap-2.5 px-2.5 py-[7px] text-[12.5px] rounded-xl text-[#7a726a] hover:bg-[#ddd4c9] hover:text-[#3a3530] transition-all duration-200">
            <CircleHelp size={14} strokeWidth={1.5} className="flex-shrink-0" />
            <span className="tracking-[-0.01em]">Help</span>
          </button>

          <div className="h-px bg-[#cec4b8]/50 w-full my-2" />

          {/* User profile */}
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 px-2 py-1.5 flex-1 min-w-0">
              <div className="w-6 h-6 rounded-full bg-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                <span className="text-white text-[8px] font-mono font-medium uppercase tracking-wider">
                  {session?.user?.email?.substring(0, 2).toUpperCase() || 'AI'}
                </span>
              </div>
              <span className="text-[12px] font-medium text-[#3a3530] truncate tracking-[-0.01em]">
                {session?.user?.email?.split('@')[0] || 'User'}
              </span>
            </div>
            <button 
              onClick={onSignOut}
              className="p-1.5 text-[#a09890] hover:text-red-500 hover:bg-red-50 rounded-lg transition-all duration-200 flex-shrink-0"
              title="Sign Out"
            >
              <LogOut size={13} strokeWidth={1.5} />
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
