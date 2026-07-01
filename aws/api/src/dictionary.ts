import { query } from './db';

/**
 * DICTIONARY — the user's custom vocabulary that fixes transcription of names, emails, jargon
 * and accented words. Per-USER (account-level): a user's dictionary improves every recording,
 * regardless of workspace. Two kinds of entry:
 *   - a TERM (name / email / jargon)      → `misspelling` NULL; biases STT toward this spelling.
 *   - a CORRECTION (misspelling → term)   → `misspelling` set; find/replaced on the transcript.
 * `shared` widens visibility to workspace teammates (the workspace it was shared into = workspace_id).
 */

let _ready: Promise<void> | null = null;
export function ensureDictionarySchema(): Promise<void> {
  if (!_ready) {
    _ready = query(`CREATE TABLE IF NOT EXISTS dictionary (
        id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        user_id      UUID NOT NULL,
        workspace_id UUID,                       -- the workspace a SHARED entry belongs to (else NULL)
        term         TEXT NOT NULL,              -- the correct spelling / name / jargon
        misspelling  TEXT,                       -- set → this is a "correct a misspelling" entry
        shared       BOOLEAN NOT NULL DEFAULT false,
        created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
        updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
      )`)
      .then(() => query('CREATE INDEX IF NOT EXISTS idx_dictionary_user ON dictionary(user_id)'))
      .then(() => query('CREATE INDEX IF NOT EXISTS idx_dictionary_shared ON dictionary(shared, workspace_id)'))
      .then(() => undefined)
      .catch((e) => { _ready = null; throw e; });
  }
  return _ready;
}
