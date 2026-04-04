-- ============================================================
-- WISPRNOTE SUPABASE MIGRATION
-- Run this entire script in Supabase SQL Editor (once)
-- ============================================================

-- ────────────────────────────────────────────────────────────
-- 1. Add missing columns to task_history
-- ────────────────────────────────────────────────────────────
ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS personal_note TEXT;

ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS visualization_image TEXT;

-- ────────────────────────────────────────────────────────────
-- 2. Create manual_notes table
--    (used by the Notebooks / My Note feature)
-- ────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS manual_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title       TEXT NOT NULL DEFAULT 'Untitled Note',
  content     TEXT NOT NULL DEFAULT ''
);

-- Index for fast per-user lookups ordered by recency
CREATE INDEX IF NOT EXISTS manual_notes_user_id_updated_at_idx
  ON manual_notes (user_id, updated_at DESC);

-- ────────────────────────────────────────────────────────────
-- 3. Enable Row-Level Security on manual_notes
-- ────────────────────────────────────────────────────────────
ALTER TABLE manual_notes ENABLE ROW LEVEL SECURITY;

-- Drop existing policies before recreating (idempotent)
DROP POLICY IF EXISTS "manual_notes_select_own" ON manual_notes;
DROP POLICY IF EXISTS "manual_notes_insert_own" ON manual_notes;
DROP POLICY IF EXISTS "manual_notes_update_own" ON manual_notes;
DROP POLICY IF EXISTS "manual_notes_delete_own" ON manual_notes;

-- Users can only see their own notes
CREATE POLICY "manual_notes_select_own"
  ON manual_notes FOR SELECT
  USING (auth.uid() = user_id);

-- Users can only insert their own notes
CREATE POLICY "manual_notes_insert_own"
  ON manual_notes FOR INSERT
  WITH CHECK (auth.uid() = user_id);

-- Users can only update their own notes
CREATE POLICY "manual_notes_update_own"
  ON manual_notes FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- Users can only delete their own notes
CREATE POLICY "manual_notes_delete_own"
  ON manual_notes FOR DELETE
  USING (auth.uid() = user_id);

-- ────────────────────────────────────────────────────────────
-- 4. Auto-update updated_at on manual_notes changes
-- ────────────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS set_manual_notes_updated_at ON manual_notes;
CREATE TRIGGER set_manual_notes_updated_at
  BEFORE UPDATE ON manual_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ────────────────────────────────────────────────────────────
-- Done. Verify with:
--   SELECT column_name FROM information_schema.columns
--   WHERE table_name = 'task_history' AND column_name = 'visualization_image';
--
--   SELECT * FROM manual_notes LIMIT 1;
-- ────────────────────────────────────────────────────────────
