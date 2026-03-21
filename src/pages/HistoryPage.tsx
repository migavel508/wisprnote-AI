import { motion } from 'framer-motion';
import { FileAudio, Search, ChevronRight } from 'lucide-react';
import { TaskHistory } from '../services/supabaseService';

interface HistoryPageProps {
  history: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
}

export default function HistoryPage({ history, onSelectTask }: HistoryPageProps) {
  return (
    <div className="absolute inset-0 flex flex-col bg-[#E4E3E0] overflow-hidden">
      {/* Fixed Header */}
      <div className="flex-none bg-[#E4E3E0] border-b border-[#141414]/10 px-4 sm:px-8 py-4">
        <div className="max-w-5xl mx-auto flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
          <h2 className="text-2xl font-serif italic font-bold">All Meetings</h2>
          <div className="flex items-center gap-2 border border-[#141414] bg-white px-3 py-1.5 w-full sm:w-auto">
            <Search className="w-4 h-4 opacity-50" />
            <input 
              type="text" 
              placeholder="Search meetings..." 
              className="bg-transparent border-none outline-none text-xs font-mono w-full sm:w-48" 
            />
          </div>
        </div>
      </div>

      {/* Scrollable Content */}
      <div className="flex-1 overflow-y-auto min-h-0">
        <div className="max-w-5xl mx-auto px-4 sm:px-8 py-6">
          {history.length === 0 ? (
            <div className="text-center py-16">
              <FileAudio className="w-12 h-12 mx-auto mb-4 opacity-20" />
              <p className="text-sm opacity-50">No meetings yet</p>
              <p className="text-xs opacity-40 mt-2">Process your first audio to get started</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
              {history.map((task) => (
                <motion.div 
                  key={task.id}
                  whileHover={{ y: -4 }}
                  onClick={() => onSelectTask(task)}
                  className="border border-[#141414] bg-white p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] cursor-pointer group"
                >
                  <div className="flex justify-between items-start mb-4">
                    <div className="p-2 bg-[#141414]/5 rounded">
                      <FileAudio className="w-6 h-6" />
                    </div>
                    <span className="text-[10px] font-mono opacity-40 uppercase">
                      {new Date(task.created_at!).toLocaleDateString()}
                    </span>
                  </div>
                  <h3 className="font-bold text-sm mb-2 group-hover:underline truncate">{task.filename}</h3>
                  <p className="text-[10px] opacity-50 line-clamp-3 font-mono mb-4">
                    {task.summary || task.transcription.substring(0, 100) + '...'}
                  </p>
                  <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                    View Details <ChevronRight className="w-3 h-3" />
                  </div>
                </motion.div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
