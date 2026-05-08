import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { logger } from '../../lib/logger';

const log = logger.scope('ManualNotesList');
import { 
  FileText, Plus, Search, MoreHorizontal, 
  Trash2, Loader2, Calendar
} from 'lucide-react';
import { ManualNote, getManualNotes, deleteManualNote } from '../../services/awsService';

interface ManualNotesListProps {
  onSelectNote: (note: ManualNote) => void;
  onCreateNote: () => void;
}

export function ManualNotesList({ onSelectNote, onCreateNote }: ManualNotesListProps) {
  const [notes, setNotes] = useState<ManualNote[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [searchQuery, setSearchQuery] = useState('');
  const [deletingId, setDeletingId] = useState<string | null>(null);

  useEffect(() => {
    fetchNotes();
  }, []);

  const fetchNotes = async () => {
    try {
      const fetchedNotes = await getManualNotes();
      setNotes(fetchedNotes);
    } catch (error) {
      log.error('fetch_notes_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setIsLoading(false);
    }
  };

  const handleDelete = async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (!confirm('Are you sure you want to delete this note?')) return;
    
    setDeletingId(id);
    try {
      await deleteManualNote(id);
      setNotes(notes.filter(n => n.id !== id));
    } catch (error) {
      log.error('delete_note_failed', { error: error instanceof Error ? error : undefined });
    } finally {
      setDeletingId(null);
    }
  };

  const filteredNotes = notes.filter(note => 
    note.title.toLowerCase().includes(searchQuery.toLowerCase()) || 
    note.content.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="h-full flex flex-col bg-[#FAFAFA] animate-in fade-in duration-500">
      <div className="flex items-center justify-between px-3 sm:px-6 md:px-8 py-5 sm:py-8">
        <div>
          <h1 className="text-xl sm:text-2xl font-bold tracking-tight text-[#141414]">Notebooks</h1>
          <p className="text-xs sm:text-sm text-gray-500 mt-0.5 sm:mt-1">Your manual notes and drafts.</p>
        </div>
        <button
          onClick={onCreateNote}
          className="flex items-center gap-1.5 sm:gap-2 bg-[#141414] text-[#E4E3E0] px-3 sm:px-4 py-2 sm:py-2.5 rounded-xl hover:bg-black transition-all shadow-[2px_2px_0px_0px_rgba(20,20,20,1)] hover:translate-x-[2px] hover:translate-y-[2px] hover:shadow-none font-medium text-xs sm:text-sm"
        >
          <Plus className="w-4 h-4" />
          <span className="hidden sm:inline">New Note</span>
          <span className="sm:hidden">New</span>
        </button>
      </div>

      <div className="px-3 sm:px-6 md:px-8 pb-3 sm:pb-4">
        <div className="relative max-w-md">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-gray-400" />
          <input
            type="text"
            placeholder="Search notes..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full pl-10 pr-4 py-2 sm:py-2.5 bg-white border border-gray-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-black/5"
          />
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-3 sm:px-6 md:px-8 pb-4 sm:pb-8">
        {isLoading ? (
          <div className="flex items-center justify-center h-64">
            <Loader2 className="w-8 h-8 animate-spin text-gray-400" />
          </div>
        ) : filteredNotes.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-64 border-2 border-dashed border-gray-200 rounded-3xl bg-white/50">
            <FileText className="w-12 h-12 text-gray-300 mb-4" />
            <p className="text-gray-500 font-medium mb-2">No notes found</p>
            <button
              onClick={onCreateNote}
              className="text-sm text-[#141414] underline underline-offset-4 hover:opacity-70"
            >
              Create your first note
            </button>
          </div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
            {filteredNotes.map((note, idx) => (
              <motion.div
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: idx * 0.05 }}
                key={note.id}
                onClick={() => onSelectNote(note)}
                className="bg-white p-4 sm:p-6 rounded-xl sm:rounded-2xl border border-gray-200 hover:border-[#141414] hover:shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] transition-all cursor-pointer group flex flex-col h-40 sm:h-48"
              >
                <div className="flex items-start justify-between mb-4">
                  <div className="p-2 bg-gray-50 rounded-xl text-gray-500 group-hover:text-[#141414] group-hover:bg-gray-100 transition-colors">
                    <FileText className="w-5 h-5" />
                  </div>
                  <button
                    onClick={(e) => handleDelete(e, note.id!)}
                    disabled={deletingId === note.id}
                    className="p-1.5 text-gray-300 hover:text-red-500 hover:bg-red-50 rounded-lg transition-colors"
                  >
                    {deletingId === note.id ? <Loader2 className="w-4 h-4 animate-spin" /> : <Trash2 className="w-4 h-4" />}
                  </button>
                </div>
                
                <h3 className="font-bold text-[#141414] mb-2 line-clamp-1">{note.title}</h3>
                <p className="text-xs text-gray-500 line-clamp-2 mb-auto" 
                   dangerouslySetInnerHTML={{ __html: note.content.replace(/<[^>]*>?/gm, ' ') || 'Empty note' }} 
                />
                
                <div className="flex items-center gap-2 mt-4 text-[10px] font-mono text-gray-400 uppercase">
                  <Calendar className="w-3 h-3" />
                  {new Date(note.updated_at || note.created_at || '').toLocaleDateString()}
                </div>
              </motion.div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}