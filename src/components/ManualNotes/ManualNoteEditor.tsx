import React, { useState, useEffect, useRef } from 'react';
import { ChevronLeft, Loader2, Check } from 'lucide-react';
import { logger } from '../../lib/logger';

const log = logger.scope('ManualNoteEditor');
import { ManualNote, saveManualNote } from '../../services/supabaseService';
import { SlashEditor } from './SlashEditor';

interface ManualNoteEditorProps {
  note: ManualNote | null;
  onSave: (note: ManualNote) => void;
  onBack: () => void;
}

export function ManualNoteEditor({ note, onSave, onBack }: ManualNoteEditorProps) {
  const [title, setTitle] = useState(note?.title || 'Untitled');
  const [isSaving, setIsSaving] = useState(false);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saved'>('idle');
  const contentRef = useRef(note?.content || '');
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const scheduleSave = () => {
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
    saveTimerRef.current = setTimeout(() => handleSave(), 1500);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      const saved = await saveManualNote({
        id: note?.id,
        title: title.trim() || 'Untitled',
        content: contentRef.current,
      });
      setSaveStatus('saved');
      setTimeout(() => setSaveStatus('idle'), 2000);
      onSave(saved);
    } catch (err) {
      log.error('save_failed', { error: err instanceof Error ? err : undefined });
    } finally {
      setIsSaving(false);
    }
  };

  // Schedule save when title changes
  useEffect(() => { scheduleSave(); }, [title]);

  return (
    <div className="flex flex-col h-full bg-[#faf9f7]">
      {/* Header */}
      <div className="flex-none flex items-center justify-between px-8 py-3 border-b border-[#e5e5e5] bg-[#faf9f7]/90 backdrop-blur sticky top-0 z-10">
        <button
          onClick={onBack}
          className="flex items-center gap-1.5 text-[13px] text-[#595959] hover:text-[#1a1a1a] transition-colors"
        >
          <ChevronLeft className="w-4 h-4" />
          All Notes
        </button>
        <div className="text-[11px] font-mono text-[#999]">
          {isSaving ? (
            <span className="flex items-center gap-1.5"><Loader2 className="w-3 h-3 animate-spin" />Saving…</span>
          ) : saveStatus === 'saved' ? (
            <span className="flex items-center gap-1.5 text-green-600"><Check className="w-3 h-3" />Saved</span>
          ) : null}
        </div>
      </div>

      {/* Scrollable editor area */}
      <div className="flex-1 overflow-y-auto">
        <div className="max-w-3xl mx-auto px-8 sm:px-12 py-14">
          {/* Title */}
          <input
            type="text"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Untitled"
            className="w-full text-[2.5rem] font-bold leading-tight border-none outline-none placeholder:text-[#d8d8d8] mb-6 bg-transparent"
          />

          {/* Notion-like slash editor */}
          <SlashEditor
            content={note?.content || ''}
            placeholder="Type '/' for commands, or just start writing…"
            autoFocus
            enableImageUpload
            onUpdate={(html) => {
              contentRef.current = html;
              scheduleSave();
            }}
          />
        </div>
      </div>
    </div>
  );
}