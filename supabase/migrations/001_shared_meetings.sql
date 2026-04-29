-- ============================================================================
-- Shared Meetings: link-based sharing with public / email-restricted access
-- ============================================================================

-- 1. Core share record — one per shared meeting link
CREATE TABLE IF NOT EXISTS shared_meetings (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id     UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  owner_id    UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  share_token TEXT NOT NULL UNIQUE,
  access_type TEXT NOT NULL DEFAULT 'public' CHECK (access_type IN ('public', 'restricted')),
  permissions TEXT[] NOT NULL DEFAULT '{notes,summary,chat}',
  is_active   BOOLEAN NOT NULL DEFAULT true,
  expires_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_shared_meetings_token   ON shared_meetings (share_token) WHERE is_active = true;
CREATE INDEX idx_shared_meetings_task    ON shared_meetings (task_id);
CREATE INDEX idx_shared_meetings_owner   ON shared_meetings (owner_id);

-- 2. Per-email access grants for restricted shares
CREATE TABLE IF NOT EXISTS shared_meeting_access (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id   UUID NOT NULL REFERENCES shared_meetings(id) ON DELETE CASCADE,
  email      TEXT NOT NULL,
  accessed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (share_id, email)
);

CREATE INDEX idx_shared_access_email ON shared_meeting_access (lower(email));

-- 3. Auto-update updated_at on shared_meetings
CREATE OR REPLACE FUNCTION update_shared_meetings_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_shared_meetings_updated_at
  BEFORE UPDATE ON shared_meetings
  FOR EACH ROW
  EXECUTE FUNCTION update_shared_meetings_updated_at();

-- ============================================================================
-- Row Level Security
-- ============================================================================

ALTER TABLE shared_meetings ENABLE ROW LEVEL SECURITY;
ALTER TABLE shared_meeting_access ENABLE ROW LEVEL SECURITY;

-- shared_meetings: owners can do everything with their own rows
CREATE POLICY shared_meetings_owner_all
  ON shared_meetings
  FOR ALL
  USING (owner_id = auth.uid())
  WITH CHECK (owner_id = auth.uid());

-- shared_meetings: anyone (including anon) can read active shares by token
CREATE POLICY shared_meetings_public_read
  ON shared_meetings
  FOR SELECT
  USING (is_active = true AND (expires_at IS NULL OR expires_at > now()));

-- shared_meeting_access: owner of the parent share can manage access rows
CREATE POLICY shared_access_owner_all
  ON shared_meeting_access
  FOR ALL
  USING (
    EXISTS (
      SELECT 1 FROM shared_meetings sm
      WHERE sm.id = shared_meeting_access.share_id
        AND sm.owner_id = auth.uid()
    )
  )
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM shared_meetings sm
      WHERE sm.id = shared_meeting_access.share_id
        AND sm.owner_id = auth.uid()
    )
  );

-- shared_meeting_access: authenticated users can see rows matching their email
CREATE POLICY shared_access_viewer_read
  ON shared_meeting_access
  FOR SELECT
  USING (
    lower(email) = lower(auth.email())
  );

-- task_history: allow reading a task that has been shared (public or email match)
CREATE POLICY task_history_shared_read
  ON task_history
  FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM shared_meetings sm
      WHERE sm.task_id = task_history.id
        AND sm.is_active = true
        AND (sm.expires_at IS NULL OR sm.expires_at > now())
        AND (
          sm.access_type = 'public'
          OR EXISTS (
            SELECT 1 FROM shared_meeting_access sma
            WHERE sma.share_id = sm.id
              AND lower(sma.email) = lower(auth.email())
          )
        )
    )
  );
