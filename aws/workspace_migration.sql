-- ============================================================
-- WISPRNOTE AI — Workspace Feature Migration
-- Run AFTER migration.sql
-- ============================================================

-- ============================================================
-- 9. workspaces
-- ============================================================
CREATE TABLE IF NOT EXISTS workspaces (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id     UUID NOT NULL,
  name        TEXT NOT NULL,
  emoji       TEXT NOT NULL DEFAULT '🗂️',
  color       TEXT NOT NULL DEFAULT '#f06060',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspaces_user_id ON workspaces(user_id);

CREATE TRIGGER set_workspaces_updated_at
  BEFORE UPDATE ON workspaces
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- 10. workspace_members
-- ============================================================
CREATE TABLE IF NOT EXISTS workspace_members (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'viewer' CHECK (role IN ('viewer', 'editor', 'admin')),
  invited_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (workspace_id, email)
);

CREATE INDEX IF NOT EXISTS idx_workspace_members_workspace ON workspace_members(workspace_id);
CREATE INDEX IF NOT EXISTS idx_workspace_members_email ON workspace_members(lower(email));

-- ============================================================
-- 11. folders
-- ============================================================
CREATE TABLE IF NOT EXISTS folders (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_folders_workspace ON folders(workspace_id);

-- ============================================================
-- 12. task_workspaces (meeting ↔ workspace)
-- ============================================================
CREATE TABLE IF NOT EXISTS task_workspaces (
  task_id      UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  added_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY  (task_id, workspace_id)
);

CREATE INDEX IF NOT EXISTS idx_task_workspaces_workspace ON task_workspaces(workspace_id);

-- ============================================================
-- 13. task_folders (meeting ↔ folder)
-- ============================================================
CREATE TABLE IF NOT EXISTS task_folders (
  task_id   UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  folder_id UUID NOT NULL REFERENCES folders(id) ON DELETE CASCADE,
  added_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (task_id, folder_id)
);

CREATE INDEX IF NOT EXISTS idx_task_folders_folder ON task_folders(folder_id);

-- ============================================================
-- Done. Workspace tables added.
-- ============================================================
