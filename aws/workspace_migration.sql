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
-- 14. WORKSPACE PARTITION (W0) — workspace as the master scope ("second primary id")
-- Also applied lazily at runtime by aws/api/src/workspaceScope.ts:ensureWorkspacePartitionSchema().
-- ============================================================

-- Master partition column: every recording belongs to exactly one workspace.
ALTER TABLE task_history ADD COLUMN IF NOT EXISTS workspace_id UUID;
CREATE INDEX IF NOT EXISTS idx_task_history_user_ws ON task_history(user_id, workspace_id, created_at DESC);

-- The user's default (home) workspace — username + profile photo, undeletable.
ALTER TABLE workspaces ADD COLUMN IF NOT EXISTS is_default BOOLEAN NOT NULL DEFAULT false;

-- Backfill runs per-user at runtime (resolveDefaultWorkspaceId + backfillUserWorkspacePartition):
--   • a task already in task_workspaces keeps that workspace as its home;
--   • all other tasks go to the user's default workspace;
--   • a user with no workspace gets a default created (named from email until the client
--     renames it to the user's name + photo).

-- ============================================================
-- Done. Workspace tables + partition added.
-- ============================================================
