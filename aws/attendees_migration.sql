-- Add attendees column to task_history
ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb;

CREATE INDEX IF NOT EXISTS idx_task_history_attendees
  ON task_history USING GIN (attendees);
