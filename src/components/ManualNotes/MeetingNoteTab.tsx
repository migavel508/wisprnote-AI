import React, { useState, useRef, useEffect } from 'react';
import { Loader2, Check } from 'lucide-react';
import { logger } from '../../lib/logger';

const log = logger.scope('MeetingNoteTab');
import { updatePersonalNote } from '../../services/supabaseService';
import { SlashEditor } from './SlashEditor';

interface MeetingNoteTabProps {
  taskId: string;
  initialContent: string;
}

export function MeetingNoteTab({ taskId, initialContent }: MeetingNoteTabProps) {
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved'>('idle');
  const contentRef = useRef(initialContent);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Reset content ref when task changes
  useEffect(() => {
    contentRef.current = initialContent;
  }, [taskId]);

  const scheduleSave = (html: string) => {
    contentRef.current = html;
    if (timerRef.current) clearTimeout(timerRef.current);
    setSaveStatus('idle');
    timerRef.current = setTimeout(async () => {
      setSaveStatus('saving');
      try {
        await updatePersonalNote(taskId, contentRef.current);
        setSaveStatus('saved');
        setTimeout(() => setSaveStatus('idle'), 2000);
      } catch (err) {
        log.error('save_meeting_note_failed', { error: err instanceof Error ? err : undefined });
        setSaveStatus('idle');
      }
    }, 1500);
  };

  return (
    <div className="h-full flex flex-col">
      {/* Status bar */}
      <div className="flex items-center justify-between px-1 pb-3">
        <p className="text-[11px] text-app-fg-muted">
          Personal note — only visible to you
        </p>
        <div className="text-[11px] font-mono text-app-fg-subtle">
          {saveStatus === 'saving' && (
            <span className="flex items-center gap-1.5">
              <Loader2 className="w-3 h-3 animate-spin" />Saving…
            </span>
          )}
          {saveStatus === 'saved' && (
            <span className="flex items-center gap-1.5 text-green-600">
              <Check className="w-3 h-3" />Saved
            </span>
          )}
        </div>
      </div>

      {/* Slash editor — fills remaining space */}
      <div className="flex-1 min-h-0">
        <SlashEditor
          key={taskId}
          content={initialContent}
          placeholder="Your private notes for this meeting… Type '/' for commands"
          enableImageUpload
          onUpdate={scheduleSave}
          className="min-h-[300px]"
        />
      </div>
    </div>
  );
}
