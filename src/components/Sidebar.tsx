import { useState, useEffect } from 'react';
import { motion } from 'framer-motion';
import { FileAudio, Plus, ChevronLeft, ChevronRight, MessageSquare } from 'lucide-react';
import { TaskHistory } from '../services/awsService';

interface SidebarProps {
  history: TaskHistory[];
  selectedTask: TaskHistory | null;
  isLoading: boolean;
  onSelectTask: (task: TaskHistory) => void;
  onNewTask: () => void;
  onClose: () => void;
  onViewAllChats: () => void;
  isMobile: boolean;
}

const ITEMS_PER_PAGE = 10;

// Skeleton loading component
function SkeletonItem() {
  return (
    <div className="p-3 border-b border-[#141414]/5 animate-pulse">
      <div className="flex items-center gap-2 mb-2">
        <div className="w-3 h-3 bg-[#141414]/10 rounded" />
        <div className="h-3 bg-[#141414]/10 rounded w-3/4" />
      </div>
      <div className="h-2 bg-[#141414]/10 rounded w-1/3" />
    </div>
  );
}

export default function Sidebar({
  history,
  selectedTask,
  isLoading,
  onSelectTask,
  onNewTask,
  onClose,
  onViewAllChats,
  isMobile,
}: SidebarProps) {
  const [currentPage, setCurrentPage] = useState(1);
  
  // Calculate pagination
  const totalPages = Math.ceil(history.length / ITEMS_PER_PAGE);
  const startIndex = (currentPage - 1) * ITEMS_PER_PAGE;
  const endIndex = startIndex + ITEMS_PER_PAGE;
  const currentItems = history.slice(startIndex, endIndex);

  // Reset to page 1 when history changes significantly
  useEffect(() => {
    if (currentPage > totalPages && totalPages > 0) {
      setCurrentPage(totalPages);
    }
  }, [history.length, totalPages, currentPage]);

  return (
    <motion.aside 
      initial={{ width: 0, opacity: 0 }}
      animate={{ width: isMobile ? '100%' : 256, opacity: 1 }}
      exit={{ width: 0, opacity: 0 }}
      className={`border-r border-[#141414] bg-[#F5F5F5] z-40 ${isMobile ? 'absolute inset-0' : 'relative flex-shrink-0 self-stretch'}`}
    >
      {/* Inner container to ensure full height with flex layout */}
      <div className="h-full flex flex-col overflow-hidden">
        {/* Header - Static, never scrolls */}
        <div className="flex-none p-4 border-b border-[#141414] flex items-center justify-between bg-[#F5F5F5]">
          <span className="text-[10px] font-mono uppercase opacity-50 tracking-wider">Recent Tasks</span>
          <div className="flex items-center gap-2">
            {isMobile && (
              <button 
                onClick={onClose}
                className="p-1 hover:bg-[#141414]/10 rounded transition-colors"
              >
                <ChevronLeft className="w-4 h-4 opacity-50" />
              </button>
            )}
            <Plus 
              className="w-4 h-4 cursor-pointer opacity-50 hover:opacity-100 transition-opacity" 
              onClick={onNewTask} 
            />
          </div>
        </div>

        {/* Content - Scrollable area that fills remaining space */}
        <div className="flex-1 overflow-y-auto bg-[#F5F5F5]">
          {isLoading ? (
            // Skeleton loading state
            <>
              <SkeletonItem />
              <SkeletonItem />
              <SkeletonItem />
              <SkeletonItem />
              <SkeletonItem />
            </>
          ) : currentItems.length === 0 ? (
            // Empty state
            <div className="p-4 text-center">
              <p className="text-xs text-[#141414]/50">No meetings yet</p>
              <button 
                onClick={onNewTask}
                className="mt-2 text-xs font-medium text-[#141414] hover:underline"
              >
                Process your first audio
              </button>
            </div>
          ) : (
            // Meeting list
            currentItems.map((task) => (
              <div 
                key={task.id}
                onClick={() => onSelectTask(task)}
                className={`p-3 border-b border-[#141414]/5 cursor-pointer hover:bg-white transition-colors group ${
                  selectedTask?.id === task.id ? 'bg-white' : ''
                }`}
              >
                <div className="flex items-center gap-2 mb-1">
                  <FileAudio className="w-3 h-3 opacity-50 flex-shrink-0" />
                  <span className="text-xs font-bold truncate max-w-[180px]">{task.filename}</span>
                </div>
                <div className="text-[10px] opacity-40 font-mono">
                  {task.created_at ? new Date(task.created_at).toLocaleDateString() : 'No date'}
                </div>
              </div>
            ))
          )}
        </div>

        {/* Pagination - Static at bottom */}
        {!isLoading && totalPages > 1 && (
          <div className="flex-none p-3 border-t border-[#141414]/10 bg-[#F5F5F5] flex items-center justify-between">
            <button
              onClick={() => setCurrentPage(p => Math.max(1, p - 1))}
              disabled={currentPage === 1}
              className="p-1 rounded hover:bg-[#141414]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronLeft className="w-4 h-4" />
            </button>
            
            <span className="text-[10px] font-mono opacity-60">
              {currentPage} / {totalPages}
            </span>
            
            <button
              onClick={() => setCurrentPage(p => Math.min(totalPages, p + 1))}
              disabled={currentPage === totalPages}
              className="p-1 rounded hover:bg-[#141414]/10 disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
            >
              <ChevronRight className="w-4 h-4" />
            </button>
          </div>
        )}

        {/* All Chats Link - Always visible at bottom */}
        <div className="flex-none border-t border-[#141414]/10 bg-[#F5F5F5] mt-auto">
          <button
            onClick={onViewAllChats}
            className="w-full px-3 py-3 flex items-center gap-2 text-xs font-medium text-[#141414]/70 hover:text-[#141414] hover:bg-white transition-colors"
          >
            <MessageSquare className="w-3.5 h-3.5" />
            <span>All Chats</span>
            <span className="ml-auto text-[9px] font-mono opacity-40">
              {history.length}
            </span>
          </button>
        </div>
      </div>
    </motion.aside>
  );
}
