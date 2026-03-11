-- ============================================================
-- WISPRNOTE AI — Row Level Security Migration
-- Run this entire script in the Supabase SQL Editor (once).
-- It is safe to run multiple times (uses IF NOT EXISTS / DROP IF EXISTS).
-- ============================================================

-- ============================================================
-- 1. task_history
-- ============================================================

-- Ensure user_id column exists
ALTER TABLE task_history
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

-- Index for fast per-user queries
CREATE INDEX IF NOT EXISTS idx_task_history_user_id ON task_history(user_id);

-- Enable RLS
ALTER TABLE task_history ENABLE ROW LEVEL SECURITY;

-- Drop old policies if they exist (clean slate)
DROP POLICY IF EXISTS "Users can view own tasks"   ON task_history;
DROP POLICY IF EXISTS "Users can insert own tasks"  ON task_history;
DROP POLICY IF EXISTS "Users can update own tasks"  ON task_history;
DROP POLICY IF EXISTS "Users can delete own tasks"  ON task_history;

-- Create policies
CREATE POLICY "Users can view own tasks"
  ON task_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks"
  ON task_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks"
  ON task_history FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks"
  ON task_history FOR DELETE
  USING (auth.uid() = user_id);


-- ============================================================
-- 2. generated_assets
-- ============================================================

ALTER TABLE generated_assets
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_generated_assets_user_id ON generated_assets(user_id);

ALTER TABLE generated_assets ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own assets"   ON generated_assets;
DROP POLICY IF EXISTS "Users can insert own assets"  ON generated_assets;
DROP POLICY IF EXISTS "Users can update own assets"  ON generated_assets;
DROP POLICY IF EXISTS "Users can delete own assets"  ON generated_assets;

CREATE POLICY "Users can view own assets"
  ON generated_assets FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own assets"
  ON generated_assets FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own assets"
  ON generated_assets FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own assets"
  ON generated_assets FOR DELETE
  USING (auth.uid() = user_id);


-- ============================================================
-- 3. knowledge_graph
-- ============================================================

ALTER TABLE knowledge_graph
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_user_id ON knowledge_graph(user_id);

-- Drop any old single-column unique constraint on task_id (causes 403 on upsert with RLS)
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conrelid = 'knowledge_graph'::regclass
    AND contype = 'u'
    AND conname LIKE '%task_id%'
    AND array_length(conkey, 1) = 1
  ) THEN
    EXECUTE (
      SELECT 'ALTER TABLE knowledge_graph DROP CONSTRAINT ' || conname
      FROM pg_constraint
      WHERE conrelid = 'knowledge_graph'::regclass
      AND contype = 'u'
      AND conname LIKE '%task_id%'
      AND array_length(conkey, 1) = 1
      LIMIT 1
    );
  END IF;
END $$;

-- Composite unique constraint: one KG entry per user per meeting
ALTER TABLE knowledge_graph
  DROP CONSTRAINT IF EXISTS knowledge_graph_user_id_task_id_key;
ALTER TABLE knowledge_graph
  ADD CONSTRAINT knowledge_graph_user_id_task_id_key UNIQUE (user_id, task_id);

ALTER TABLE knowledge_graph ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own knowledge graph"   ON knowledge_graph;
DROP POLICY IF EXISTS "Users can insert own knowledge graph"  ON knowledge_graph;
DROP POLICY IF EXISTS "Users can update own knowledge graph"  ON knowledge_graph;
DROP POLICY IF EXISTS "Users can delete own knowledge graph"  ON knowledge_graph;

CREATE POLICY "Users can view own knowledge graph"
  ON knowledge_graph FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own knowledge graph"
  ON knowledge_graph FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own knowledge graph"
  ON knowledge_graph FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own knowledge graph"
  ON knowledge_graph FOR DELETE
  USING (auth.uid() = user_id);


-- ============================================================
-- 4. chat_history
-- ============================================================

ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE;

CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON chat_history(user_id);

ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Users can view own chat history"   ON chat_history;
DROP POLICY IF EXISTS "Users can insert own chat history"  ON chat_history;
DROP POLICY IF EXISTS "Users can update own chat history"  ON chat_history;
DROP POLICY IF EXISTS "Users can delete own chat history"  ON chat_history;

CREATE POLICY "Users can view own chat history"
  ON chat_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chat history"
  ON chat_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat history"
  ON chat_history FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own chat history"
  ON chat_history FOR DELETE
  USING (auth.uid() = user_id);


-- ============================================================
-- 5. Backfill note:
--    Existing rows that have NULL user_id will simply be
--    invisible to all users under the RLS policies above.
--    They are NOT deleted — your data stays intact in the DB.
--
--    If you ever want to re-claim old rows for a specific user,
--    run this (replace <your-user-uuid> with the UUID from
--    the Supabase Authentication > Users table):
--
--    UPDATE task_history     SET user_id = '<your-user-uuid>' WHERE user_id IS NULL;
--    UPDATE generated_assets SET user_id = '<your-user-uuid>' WHERE user_id IS NULL;
--    UPDATE knowledge_graph  SET user_id = '<your-user-uuid>' WHERE user_id IS NULL;
--    UPDATE chat_history     SET user_id = '<your-user-uuid>' WHERE user_id IS NULL;
-- ============================================================


-- ============================================================
-- Done. All four tables are now RLS-protected.
-- No existing data was deleted.
-- ============================================================
