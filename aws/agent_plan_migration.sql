-- ============================================================
-- WISPRNOTE — Persist agent thought-process (search-tool steps)
-- with each chat_history row, so the "Thought process" UI panel
-- (Searched notes / Searched people, with their queries + results)
-- survives reload.
-- Safe to re-run.
-- ============================================================

ALTER TABLE chat_history
  ADD COLUMN IF NOT EXISTS agent_status TEXT,
  ADD COLUMN IF NOT EXISTS agent_plan   JSONB DEFAULT '[]'::jsonb;
