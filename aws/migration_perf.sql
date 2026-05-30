-- Performance + correctness migration. Run ONCE at deploy time (psql against
-- the RDS instance), NOT on Lambda cold start. All statements are idempotent.
--
--   psql "$DATABASE_URL" -f aws/migration_perf.sql
--
-- Why not in the Lambda: running ALTER TABLE / CREATE INDEX on every cold start
-- takes an ACCESS EXCLUSIVE lock; under concurrency that serializes/locks the
-- whole table. Apply schema changes here, at deploy time, instead.

-- attendees column + GIN index (previously created on cold start).
ALTER TABLE task_history ADD COLUMN IF NOT EXISTS attendees JSONB NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_task_history_attendees ON task_history USING GIN (attendees);

-- Hot path: list query is WHERE user_id = $1 ORDER BY created_at DESC.
-- A composite index serves both the filter and the sort with no extra sort step,
-- replacing the two single-column indexes that forced a partial scan + sort.
CREATE INDEX IF NOT EXISTS idx_task_history_user_created
  ON task_history (user_id, created_at DESC);
