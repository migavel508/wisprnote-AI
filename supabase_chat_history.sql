-- =====================================================
-- CHAT HISTORY SCHEMA FOR WISPRNOTE
-- Execute this script in your Supabase SQL Editor
-- =====================================================

-- Chat history table: stores chat messages per task
CREATE TABLE IF NOT EXISTS chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  text TEXT NOT NULL,
  image TEXT, -- Optional image URL for visualizations
  
  -- Index for efficient querying
  CONSTRAINT valid_role CHECK (role IN ('user', 'model'))
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON chat_history(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_task_id ON chat_history(task_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created_at ON chat_history(created_at);

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

ALTER TABLE chat_history ENABLE ROW LEVEL SECURITY;

-- Policies for chat_history
CREATE POLICY "Users can view own chat history" ON chat_history
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own chat history" ON chat_history
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own chat history" ON chat_history
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own chat history" ON chat_history
  FOR DELETE USING (auth.uid() = user_id);

-- =====================================================
-- HELPER FUNCTION: Get chat history for a task
-- =====================================================

CREATE OR REPLACE FUNCTION get_chat_history_for_task(p_task_id UUID)
RETURNS TABLE (
  id UUID,
  created_at TIMESTAMPTZ,
  role TEXT,
  text TEXT,
  image TEXT
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    ch.id,
    ch.created_at,
    ch.role,
    ch.text,
    ch.image
  FROM chat_history ch
  WHERE ch.task_id = p_task_id
  AND ch.user_id = auth.uid()
  ORDER BY ch.created_at ASC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- SUCCESS MESSAGE
-- =====================================================
DO $$
BEGIN
  RAISE NOTICE 'Chat History schema created successfully!';
END $$;
