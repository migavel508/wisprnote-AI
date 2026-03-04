-- =====================================================
-- KNOWLEDGE GRAPH SCHEMA FOR WISPRNOTE
-- Execute this script in your Supabase SQL Editor
-- =====================================================

-- 1. Main knowledge_graph table: stores extracted KG data per meeting
CREATE TABLE IF NOT EXISTS knowledge_graph (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  meeting_title TEXT NOT NULL,
  
  -- Store full extracted data as JSONB for flexibility
  topics JSONB DEFAULT '[]'::jsonb,
  decisions JSONB DEFAULT '[]'::jsonb,
  people JSONB DEFAULT '[]'::jsonb,
  action_items JSONB DEFAULT '[]'::jsonb,
  refs JSONB DEFAULT '[]'::jsonb,
  
  -- Unique constraint: one KG entry per task
  UNIQUE(task_id)
);

-- 2. Topics table: normalized topic storage for cross-meeting linking
CREATE TABLE IF NOT EXISTS kg_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  -- Normalized topic name (lowercase, trimmed) for matching
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  
  -- Unique per user
  UNIQUE(user_id, normalized_name)
);

-- 3. Junction table: links meetings to topics with status
CREATE TABLE IF NOT EXISTS kg_meeting_topics (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  knowledge_graph_id UUID NOT NULL REFERENCES knowledge_graph(id) ON DELETE CASCADE,
  topic_id UUID NOT NULL REFERENCES kg_topics(id) ON DELETE CASCADE,
  
  -- Status of this topic in this specific meeting
  status TEXT NOT NULL CHECK (status IN ('new', 'ongoing', 'resolved', 'revisited', 'off-track')),
  summary TEXT,
  
  -- One entry per meeting-topic pair
  UNIQUE(knowledge_graph_id, topic_id)
);

-- 4. People table: normalized people storage
CREATE TABLE IF NOT EXISTS kg_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  user_id UUID REFERENCES auth.users(id) ON DELETE CASCADE,
  
  normalized_name TEXT NOT NULL,
  display_name TEXT NOT NULL,
  
  UNIQUE(user_id, normalized_name)
);

-- 5. Junction table: links meetings to people
CREATE TABLE IF NOT EXISTS kg_meeting_people (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  knowledge_graph_id UUID NOT NULL REFERENCES knowledge_graph(id) ON DELETE CASCADE,
  person_id UUID NOT NULL REFERENCES kg_people(id) ON DELETE CASCADE,
  
  UNIQUE(knowledge_graph_id, person_id)
);

-- 6. Decisions table: stores decisions with topic links
CREATE TABLE IF NOT EXISTS kg_decisions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  knowledge_graph_id UUID NOT NULL REFERENCES knowledge_graph(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES kg_topics(id) ON DELETE SET NULL,
  
  decision_text TEXT NOT NULL,
  related_topic_name TEXT -- Original topic name for reference
);

-- 7. Action items table
CREATE TABLE IF NOT EXISTS kg_action_items (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  
  knowledge_graph_id UUID NOT NULL REFERENCES knowledge_graph(id) ON DELETE CASCADE,
  topic_id UUID REFERENCES kg_topics(id) ON DELETE SET NULL,
  person_id UUID REFERENCES kg_people(id) ON DELETE SET NULL,
  
  task_text TEXT NOT NULL,
  owner_name TEXT,
  related_topic_name TEXT,
  status TEXT DEFAULT 'pending' CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled'))
);

-- =====================================================
-- INDEXES FOR PERFORMANCE
-- =====================================================

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_user_id ON knowledge_graph(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_graph_task_id ON knowledge_graph(task_id);
CREATE INDEX IF NOT EXISTS idx_kg_topics_user_id ON kg_topics(user_id);
CREATE INDEX IF NOT EXISTS idx_kg_topics_normalized_name ON kg_topics(normalized_name);
CREATE INDEX IF NOT EXISTS idx_kg_meeting_topics_kg_id ON kg_meeting_topics(knowledge_graph_id);
CREATE INDEX IF NOT EXISTS idx_kg_meeting_topics_topic_id ON kg_meeting_topics(topic_id);
CREATE INDEX IF NOT EXISTS idx_kg_people_user_id ON kg_people(user_id);
CREATE INDEX IF NOT EXISTS idx_kg_decisions_kg_id ON kg_decisions(knowledge_graph_id);
CREATE INDEX IF NOT EXISTS idx_kg_action_items_kg_id ON kg_action_items(knowledge_graph_id);

-- =====================================================
-- ROW LEVEL SECURITY (RLS)
-- =====================================================

ALTER TABLE knowledge_graph ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_meeting_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_meeting_people ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE kg_action_items ENABLE ROW LEVEL SECURITY;

-- Policies for knowledge_graph
CREATE POLICY "Users can view own knowledge graph" ON knowledge_graph
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own knowledge graph" ON knowledge_graph
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own knowledge graph" ON knowledge_graph
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own knowledge graph" ON knowledge_graph
  FOR DELETE USING (auth.uid() = user_id);

-- Policies for kg_topics
CREATE POLICY "Users can view own topics" ON kg_topics
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own topics" ON kg_topics
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own topics" ON kg_topics
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own topics" ON kg_topics
  FOR DELETE USING (auth.uid() = user_id);

-- Policies for kg_meeting_topics (via knowledge_graph ownership)
CREATE POLICY "Users can manage meeting topics" ON kg_meeting_topics
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM knowledge_graph kg 
      WHERE kg.id = kg_meeting_topics.knowledge_graph_id 
      AND kg.user_id = auth.uid()
    )
  );

-- Policies for kg_people
CREATE POLICY "Users can view own people" ON kg_people
  FOR SELECT USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own people" ON kg_people
  FOR INSERT WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own people" ON kg_people
  FOR UPDATE USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own people" ON kg_people
  FOR DELETE USING (auth.uid() = user_id);

-- Policies for kg_meeting_people
CREATE POLICY "Users can manage meeting people" ON kg_meeting_people
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM knowledge_graph kg 
      WHERE kg.id = kg_meeting_people.knowledge_graph_id 
      AND kg.user_id = auth.uid()
    )
  );

-- Policies for kg_decisions
CREATE POLICY "Users can manage decisions" ON kg_decisions
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM knowledge_graph kg 
      WHERE kg.id = kg_decisions.knowledge_graph_id 
      AND kg.user_id = auth.uid()
    )
  );

-- Policies for kg_action_items
CREATE POLICY "Users can manage action items" ON kg_action_items
  FOR ALL USING (
    EXISTS (
      SELECT 1 FROM knowledge_graph kg 
      WHERE kg.id = kg_action_items.knowledge_graph_id 
      AND kg.user_id = auth.uid()
    )
  );

-- =====================================================
-- HELPER FUNCTION: Get cross-meeting topic connections
-- =====================================================

CREATE OR REPLACE FUNCTION get_topic_connections(p_user_id UUID)
RETURNS TABLE (
  topic_id UUID,
  topic_name TEXT,
  meeting_count BIGINT,
  meeting_ids UUID[],
  statuses TEXT[]
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    t.id as topic_id,
    t.display_name as topic_name,
    COUNT(DISTINCT mt.knowledge_graph_id) as meeting_count,
    ARRAY_AGG(DISTINCT kg.task_id) as meeting_ids,
    ARRAY_AGG(DISTINCT mt.status) as statuses
  FROM kg_topics t
  JOIN kg_meeting_topics mt ON mt.topic_id = t.id
  JOIN knowledge_graph kg ON kg.id = mt.knowledge_graph_id
  WHERE t.user_id = p_user_id
  GROUP BY t.id, t.display_name
  HAVING COUNT(DISTINCT mt.knowledge_graph_id) > 1
  ORDER BY meeting_count DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- HELPER FUNCTION: Get full knowledge graph for user
-- =====================================================

CREATE OR REPLACE FUNCTION get_full_knowledge_graph(p_user_id UUID)
RETURNS TABLE (
  kg_id UUID,
  task_id UUID,
  meeting_title TEXT,
  topics JSONB,
  decisions JSONB,
  people JSONB,
  action_items JSONB,
  refs JSONB,
  created_at TIMESTAMPTZ
) AS $$
BEGIN
  RETURN QUERY
  SELECT 
    kg.id as kg_id,
    kg.task_id,
    kg.meeting_title,
    kg.topics,
    kg.decisions,
    kg.people,
    kg.action_items,
    kg.refs,
    kg.created_at
  FROM knowledge_graph kg
  WHERE kg.user_id = p_user_id
  ORDER BY kg.created_at DESC;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- =====================================================
-- TRIGGER: Update updated_at timestamp
-- =====================================================

CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER update_knowledge_graph_updated_at
  BEFORE UPDATE ON knowledge_graph
  FOR EACH ROW
  EXECUTE FUNCTION update_updated_at_column();

-- =====================================================
-- SUCCESS MESSAGE
-- =====================================================
DO $$
BEGIN
  RAISE NOTICE 'Knowledge Graph schema created successfully!';
END $$;
