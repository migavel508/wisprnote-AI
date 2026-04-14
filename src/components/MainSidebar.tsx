import { useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { 
  Search, 
  FileText, 
  MessageCircle, 
  Share2, 
  History,
  Sidebar as SidebarIcon, 
  ChevronsUpDown, 
  SquarePen,
  User,
  FileOutput,
  Mic,
  LogOut,
  BookMarked
} from 'lucide-react';
import { Session } from '@supabase/supabase-js';

type View = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks';

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
  const [showSearch, setShowSearch] = useState(false);

  const navItems = [
    { id: 'process' as View, label: 'Process', icon: Mic },
    { id: 'notes' as View, label: 'Notes', icon: FileText },
    { id: 'chat' as View, label: 'Chat', icon: MessageCircle },
    { id: 'notebooks' as View, label: 'Notebooks', icon: BookMarked },
    { id: 'knowledge' as View, label: 'Knowledge', icon: Share2 },
  ];

  if (!isOpen) {
    return (
      <button 
        onClick={onToggle}
        className="fixed top-4 left-4 z-50 w-8 h-8 bg-white border border-[#e5e5e5] rounded-lg flex items-center justify-center text-[#595959] hover:text-[#1a1a1a] hover:bg-[#f5f5f5] transition-colors shadow-sm"
      >
        <SidebarIcon size={16} strokeWidth={2} />
      </button>
    );
  }

  return (
    <>
      {/* Mobile overlay backdrop */}
      <div 
        className="fixed inset-0 bg-black/20 z-[60] md:hidden"
        onClick={onToggle}
      />
      
      <motion.div 
        initial={{ x: -240, opacity: 0 }}
        animate={{ x: 0, opacity: 1 }}
        exit={{ x: -240, opacity: 0 }}
        transition={{ duration: 0.2 }}
        className="fixed md:relative h-screen w-[240px] bg-[#f8f8f7] border-r border-[#e5e5e5] flex flex-col flex-shrink-0 font-[system-ui] z-[70]"
      >
      {/* Sidebar Toggle */}
      <div className="flex items-center justify-start px-4 pt-4 pb-4">
        <button 
          onClick={onToggle}
          className="text-[#595959] hover:text-[#1a1a1a] transition-colors rounded-[8px] p-2 border border-[#e3e3e0] bg-white hover:bg-[#f5f5f5]"
        >
          <SidebarIcon size={16} strokeWidth={2} />
        </button>
      </div>

      {/* Search */}
      <div className="px-3 pb-4">
        <button 
          onClick={() => setShowSearch(true)}
          className="w-full flex items-center gap-2.5 px-2.5 py-1.5 text-[13px] text-[#595959] bg-transparent border border-[#e3e3e0] hover:bg-[#e8e8e6] rounded-full transition-colors"
        >
          <Search size={14} strokeWidth={2} />
          <span className="font-medium">Search</span>
          <span className="ml-auto text-[11px] font-semibold text-[#808080] tracking-wider px-1">⌘K</span>
        </button>
      </div>

      {/* Main Navigation */}
      <nav className="px-2 space-y-0.5">
        {navItems.map((item) => {
          const Icon = item.icon;
          const isActive = currentView === item.id;
          return (
            <button
              key={item.id}
              onClick={() => onViewChange(item.id)}
              className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[13.5px] rounded-[6px] transition-colors ${
                isActive 
                  ? 'bg-[#e8e8e6] text-[#1a1a1a] font-medium' 
                  : 'text-[#595959] hover:bg-[#e8e8e6]'
              }`}
            >
              <Icon 
                size={15} 
                strokeWidth={2} 
                className={isActive ? 'text-[#1a1a1a]' : 'text-[#595959]'} 
              />
              <span>{item.label}</span>
            </button>
          );
        })}
      </nav>

      {/* Spaces / History Section */}
      <div className="mt-[26px] px-2">
        <div className="text-[11.5px] font-semibold text-[#808080] px-3 mb-1.5 tracking-wide">
          Recent
        </div>
        <div className="space-y-0.5">
          <button
            onClick={() => onViewChange('history')}
            className={`w-full flex items-center gap-2.5 px-3 py-1.5 text-[13.5px] rounded-[6px] transition-colors ${
              currentView === 'history' 
                ? 'bg-[#e8e8e6] text-[#1a1a1a] font-medium' 
                : 'text-[#1a1a1a] hover:bg-[#e8e8e6]'
            }`}
          >
            <div className="w-[20px] h-[20px] rounded-md bg-[#e3e3e0] flex items-center justify-center flex-shrink-0 border border-[#d6d6d4]">
              <History size={11} className="text-[#595959]" strokeWidth={2.5} />
            </div>
            <span>All Meetings</span>
          </button>
        </div>
      </div>

      {/* Status Indicator */}
      <div className="mt-6 px-4">
        <div className="flex items-center gap-2 px-2 py-2 bg-white/50 rounded-lg border border-[#e3e3e0]">
          <div className={`w-2 h-2 rounded-full ${status === 'idle' ? 'bg-green-500' : 'bg-amber-500 animate-pulse'}`}></div>
          <span className="text-[11px] font-medium text-[#595959]">
            {status !== 'idle' ? status.charAt(0).toUpperCase() + status.slice(1) : 'Ready'}
          </span>
        </div>
      </div>

      {/* Spacer */}
      <div className="flex-1" />

      {/* Bottom section */}
      <div className="px-3 pb-3">
        {/* Bottom icon actions */}
        <div className="flex items-center gap-[18px] mb-4 px-2">
          <button className="text-[#808080] hover:text-[#1a1a1a] transition-colors">
            <SquarePen size={15} strokeWidth={2} />
          </button>
          <button className="text-[#808080] hover:text-[#1a1a1a] transition-colors">
            <User size={15} strokeWidth={2} />
          </button>
          <button className="text-[#808080] hover:text-[#1a1a1a] transition-colors">
            <FileOutput size={15} strokeWidth={2} />
          </button>
        </div>

        {/* App branding pill */}
        <div className="bg-transparent border border-[#d6d6d4] rounded-[14px] p-[3px] mb-3.5 flex items-center justify-between shadow-sm">
          <div className="flex items-center gap-1.5 pl-1.5">
            <img src="/logo.png" alt="Logo" className="w-5 h-5 rounded-full object-cover" />
            <span className="text-[12.5px] text-[#1a1a1a] font-medium">Wisprnote AI</span>
          </div>
          <div className="px-3 py-1 text-[11px] font-semibold bg-[#262626] text-white rounded-[10px]">
            Pro
          </div>
        </div>

        {/* Divider */}
        <div className="h-px bg-[#e5e5e5] w-full mb-3"></div>

        {/* User profile */}
        <div className="flex items-center justify-between">
          <button className="flex-1 flex items-center gap-2.5 px-2 py-1 text-[13.5px] font-medium text-[#1a1a1a] hover:bg-[#e8e8e6] rounded-[6px] transition-colors">
            <div className="w-[20px] h-[20px] rounded-md bg-[#1f2937] flex items-center justify-center flex-shrink-0 relative overflow-hidden shadow-sm">
              <div className="absolute inset-0 bg-gradient-to-br from-[#374151] to-[#111827] opacity-90"></div>
              <span className="text-white text-[8px] font-bold relative z-10">
                {session?.user?.email?.substring(0, 2).toUpperCase() || 'AI'}
              </span>
            </div>
            <span className="truncate max-w-[120px]">
              {session?.user?.email?.split('@')[0] || 'User'}
            </span>
            <ChevronsUpDown size={12} className="ml-auto text-[#808080]" strokeWidth={2.5} />
          </button>
          <button 
            onClick={onSignOut}
            className="p-1.5 text-[#808080] hover:text-red-500 hover:bg-red-50 rounded-md transition-colors ml-1"
            title="Sign Out"
          >
            <LogOut size={14} strokeWidth={2} />
          </button>
        </div>
      </div>
    </motion.div>
    </>
  );
}
