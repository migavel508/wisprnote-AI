-- ============================================================
-- WISPRNOTE — Workspace / Folder metadata migration
-- Adds richer metadata that the new UI relies on.
-- Run AFTER workspace_migration.sql.
-- Safe to re-run (uses IF NOT EXISTS on every column).
-- ============================================================

-- ── workspaces: description + image_url ─────────────────────
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS description TEXT       NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS image_url   TEXT;

-- ── folders: emoji / color / description / icon / favorite ──
ALTER TABLE folders
  ADD COLUMN IF NOT EXISTS emoji       TEXT,
  ADD COLUMN IF NOT EXISTS color       TEXT,
  ADD COLUMN IF NOT EXISTS description TEXT       NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS icon_type   TEXT       NOT NULL DEFAULT 'icon'
                          CHECK (icon_type IN ('icon', 'emoji')),
  ADD COLUMN IF NOT EXISTS icon_name   TEXT,
  ADD COLUMN IF NOT EXISTS favorite    BOOLEAN    NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW();

-- Keep folders.updated_at fresh on UPDATE
DROP TRIGGER IF EXISTS set_folders_updated_at ON folders;
CREATE TRIGGER set_folders_updated_at
  BEFORE UPDATE ON folders
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

-- ============================================================
-- Done. No data loss — every new column has a default.
-- ============================================================
