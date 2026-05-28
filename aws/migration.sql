-- ============================================================
-- WISPRNOTE AI — AWS RDS PostgreSQL Schema Migration
-- Adapted from Supabase schema (no auth.users, no RLS)
-- User-scoping handled in application Lambda layer
-- ============================================================

CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- 1. task_history
-- ============================================================
CREATE TABLE IF NOT EXISTS task_history (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id       UUID NOT NULL,
  filename      TEXT NOT NULL,
  transcription TEXT NOT NULL,
  summary       TEXT,
  notes         TEXT,
  audio_url     TEXT,
  status        TEXT NOT NULL CHECK (status IN ('completed', 'error')),
  duration      INTEGER NOT NULL DEFAULT 0,
  prompt        TEXT,
  personal_note TEXT,
  visualization_image TEXT
);

CREATE INDEX IF NOT EXISTS idx_task_history_user_id ON task_history(user_id);
CREATE INDEX IF NOT EXISTS idx_task_history_created_at ON task_history(created_at DESC);

-- ============================================================
-- 2. generated_assets
-- ============================================================
CREATE TABLE IF NOT EXISTS generated_assets (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     UUID NOT NULL,
  task_id     UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  type        TEXT NOT NULL CHECK (type IN ('email', 'wiki')),
  filename    TEXT NOT NULL,
  content     JSONB NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_generated_assets_user_id ON generated_assets(user_id);
CREATE INDEX IF NOT EXISTS idx_generated_assets_task_id ON generated_assets(task_id);

-- ============================================================
-- 3. manual_notes
-- ============================================================
CREATE TABLE IF NOT EXISTS manual_notes (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  user_id     UUID NOT NULL,
  title       TEXT NOT NULL DEFAULT 'Untitled Note',
  content     TEXT NOT NULL DEFAULT ''
);

CREATE INDEX IF NOT EXISTS idx_manual_notes_user_updated
  ON manual_notes (user_id, updated_at DESC);

-- ============================================================
-- 4. knowledge_graph
-- ============================================================
CREATE TABLE IF NOT EXISTS knowledge_graph (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at    TIMESTAMPTZ DEFAULT NOW(),
  updated_at    TIMESTAMPTZ DEFAULT NOW(),
  user_id       UUID NOT NULL,
  task_id       UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  meeting_title TEXT NOT NULL,
  topics        JSONB DEFAULT '[]'::jsonb,
  decisions     JSONB DEFAULT '[]'::jsonb,
  people        JSONB DEFAULT '[]'::jsonb,
  action_items  JSONB DEFAULT '[]'::jsonb,
  refs          JSONB DEFAULT '[]'::jsonb,
  UNIQUE(user_id, task_id)
);

CREATE INDEX IF NOT EXISTS idx_knowledge_graph_user_id ON knowledge_graph(user_id);
CREATE INDEX IF NOT EXISTS idx_knowledge_graph_task_id ON knowledge_graph(task_id);

-- ============================================================
-- 5. chat_history
-- ============================================================
CREATE TABLE IF NOT EXISTS chat_history (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  user_id         UUID NOT NULL,
  task_id         UUID REFERENCES task_history(id) ON DELETE CASCADE,
  role            TEXT NOT NULL CHECK (role IN ('user', 'model')),
  text            TEXT NOT NULL,
  image           TEXT,
  thread_id       TEXT,
  citations       JSONB DEFAULT '[]'::jsonb,
  retrieval_meta  JSONB DEFAULT '{}'::jsonb,
  agent_status    TEXT,
  agent_plan      JSONB DEFAULT '[]'::jsonb
);

CREATE INDEX IF NOT EXISTS idx_chat_history_user_id ON chat_history(user_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_task_id ON chat_history(task_id);
CREATE INDEX IF NOT EXISTS idx_chat_history_created_at ON chat_history(created_at);
CREATE INDEX IF NOT EXISTS idx_chat_history_thread_id ON chat_history(thread_id);

-- ============================================================
-- 6. shared_meetings
-- ============================================================
CREATE TABLE IF NOT EXISTS shared_meetings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  owner_id    UUID NOT NULL,
  share_token TEXT NOT NULL UNIQUE,
  access_type TEXT NOT NULL DEFAULT 'public' CHECK (access_type IN ('public', 'restricted')),
  permissions TEXT[] NOT NULL DEFAULT '{notes,summary,chat}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_shared_meetings_token ON shared_meetings(share_token) WHERE is_active = true;
CREATE INDEX IF NOT EXISTS idx_shared_meetings_task ON shared_meetings(task_id);
CREATE INDEX IF NOT EXISTS idx_shared_meetings_owner ON shared_meetings(owner_id);

-- ============================================================
-- 7. shared_meeting_access
-- ============================================================
CREATE TABLE IF NOT EXISTS shared_meeting_access (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id    UUID NOT NULL REFERENCES shared_meetings(id) ON DELETE CASCADE,
  email       TEXT NOT NULL,
  accessed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (share_id, email)
);

CREATE INDEX IF NOT EXISTS idx_shared_access_email ON shared_meeting_access(lower(email));

-- ============================================================
-- 8. user_ledger_state
-- ============================================================
CREATE TABLE IF NOT EXISTS user_ledger_state (
  user_id                  UUID PRIMARY KEY,
  turbopuffer_indexed_ids  JSONB NOT NULL DEFAULT '[]'::jsonb,
  kg_extracted_ids         JSONB NOT NULL DEFAULT '[]'::jsonb,
  kg_artifact_fingerprint  TEXT,
  kg_artifact_data         JSONB,
  updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_user_ledger_updated
  ON user_ledger_state(updated_at DESC);

-- ============================================================
-- Triggers: auto-update updated_at
-- ============================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER set_manual_notes_updated_at
  BEFORE UPDATE ON manual_notes
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_knowledge_graph_updated_at
  BEFORE UPDATE ON knowledge_graph
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER set_shared_meetings_updated_at
  BEFORE UPDATE ON shared_meetings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Done. All 8 tables created for WisprNote AI on AWS RDS.
-- ============================================================
