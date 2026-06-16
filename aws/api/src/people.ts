import { query, queryOne } from './db';

/**
 * People directory — pairs a person's NAME (as it appears in meetings / attendees)
 * with their EMAIL, and (later) their resolved Jira accountId. Meetings give names,
 * workspace_members give emails, but nothing pairs them — so this is the curated
 * bridge. It fills the email into the People section and powers assignee resolution
 * (meeting name → person → email → Jira accountId via `lookupJiraAccountId`).
 *
 * user_id-scoped for now (matches the existing /contacts). Will gain workspace_id
 * when connectors are workspace-scoped.
 */

let ready: Promise<void> | null = null;

export function ensurePeopleSchema(): Promise<void> {
  if (!ready) {
    ready = (async () => {
      await query(`
        CREATE TABLE IF NOT EXISTS people_directory (
          user_id UUID NOT NULL,
          name TEXT NOT NULL,
          email TEXT,
          jira_account_id TEXT,           -- cached from lookupJiraAccountId (assignee resolution)
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (user_id, name)
        )
      `);
    })().catch((e) => { ready = null; throw e; });
  }
  return ready;
}

/** Upsert a person's email (and optionally accountId) by name. */
export async function upsertPerson(userId: string, name: string, email: string | null, jiraAccountId?: string | null): Promise<void> {
  await ensurePeopleSchema();
  await query(
    `INSERT INTO people_directory (user_id, name, email, jira_account_id)
     VALUES ($1,$2,$3,$4)
     ON CONFLICT (user_id, name) DO UPDATE SET
       email=COALESCE(EXCLUDED.email, people_directory.email),
       jira_account_id=COALESCE(EXCLUDED.jira_account_id, people_directory.jira_account_id),
       updated_at=NOW()`,
    [userId, name.trim(), email?.trim() || null, jiraAccountId ?? null],
  );
}

export interface DirectoryPerson { name: string; email: string | null; jira_account_id: string | null }

/** Look up a directory person by (fuzzy-normalized) name — for assignee resolution. */
export async function findPersonByName(userId: string, name: string): Promise<DirectoryPerson | null> {
  await ensurePeopleSchema();
  return queryOne<DirectoryPerson>(
    `SELECT name, email, jira_account_id FROM people_directory
      WHERE user_id=$1 AND lower(btrim(name))=lower(btrim($2)) LIMIT 1`,
    [userId, name],
  );
}
