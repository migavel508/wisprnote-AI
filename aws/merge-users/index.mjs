// One-off migration Lambda: merge duplicate Cognito accounts at the DATA layer.
//
// For each {ext, native} pair, re-points every row whose user_id == ext to
// native, across ALL tables that have a user_id column. Unique/PK constraints
// that include user_id are handled by first deleting the external rows that
// would collide with an existing native row (native wins), then updating.
//
// Runs inside the DB VPC. Invoke with payload:
//   { "dryRun": true,  "pairs": [{ "email": "..", "ext": "<uuid>", "native": "<uuid>" }, ...] }
// Set dryRun:false to actually mutate. Everything runs in a single transaction
// per invocation and rolls back on any error.

import pg from 'pg';
import { SecretsManagerClient, GetSecretValueCommand } from '@aws-sdk/client-secrets-manager';

const sm = new SecretsManagerClient({});

async function getDbPassword() {
  const res = await sm.send(new GetSecretValueCommand({ SecretId: process.env.API_SECRETS_ID }));
  const secrets = JSON.parse(res.SecretString || '{}');
  return secrets.DB_PASSWORD;
}

export const handler = async (event) => {
  const dryRun = event?.dryRun !== false; // default to dry-run unless explicitly false
  const pairs = event?.pairs || [];
  if (!pairs.length) return { ok: false, error: 'no pairs provided' };

  const password = await getDbPassword();
  const client = new pg.Client({
    host: process.env.DB_HOST,
    port: parseInt(process.env.DB_PORT || '5432', 10),
    database: process.env.DB_NAME || 'wisprnote',
    user: process.env.DB_USER,
    password,
    ssl: { rejectUnauthorized: false },
    connectionTimeoutMillis: 10000,
  });
  await client.connect();

  const report = { dryRun, pairs: [] };
  try {
    await client.query('BEGIN');

    // All tables in public schema that have a user_id column.
    const { rows: tableRows } = await client.query(
      `SELECT table_name FROM information_schema.columns
       WHERE table_schema='public' AND column_name='user_id' ORDER BY table_name`,
    );
    const tables = tableRows.map((r) => r.table_name);

    for (const pair of pairs) {
      const { ext, native, email } = pair;
      const pairReport = { email, ext, native, tables: {} };

      for (const t of tables) {
        const tbl = `"${t.replace(/"/g, '""')}"`;

        // How many external rows exist (for the report).
        const { rows: cntRows } = await client.query(
          `SELECT COUNT(*)::int AS n FROM ${tbl} WHERE user_id = $1`, [ext],
        );
        const extCount = cntRows[0].n;
        if (extCount === 0) { continue; }

        // Find unique/PK constraints that include user_id → collision risk.
        const { rows: consRows } = await client.query(
          `SELECT tc.constraint_name,
                  array_agg(kcu.column_name::text ORDER BY kcu.ordinal_position) AS cols
             FROM information_schema.table_constraints tc
             JOIN information_schema.key_column_usage kcu
               ON tc.constraint_name = kcu.constraint_name
              AND tc.table_schema = kcu.table_schema
            WHERE tc.table_schema='public' AND tc.table_name=$1
              AND tc.constraint_type IN ('PRIMARY KEY','UNIQUE')
            GROUP BY tc.constraint_name`, [t],
        );

        let deletedConflicts = 0;
        for (const c of consRows) {
          const cols = c.cols;
          if (!cols.includes('user_id')) continue;
          const others = cols.filter((x) => x !== 'user_id');
          if (others.length === 0) {
            // unique on user_id alone → delete ext row if a native row already exists
            const del = await client.query(
              `DELETE FROM ${tbl} WHERE user_id=$1 AND EXISTS (SELECT 1 FROM ${tbl} t2 WHERE t2.user_id=$2)`,
              [ext, native],
            );
            deletedConflicts += del.rowCount;
          } else {
            const cond = others.map((col) => `t2."${col.replace(/"/g, '""')}" = t1."${col.replace(/"/g, '""')}"`).join(' AND ');
            const del = await client.query(
              `DELETE FROM ${tbl} t1 WHERE t1.user_id=$1
                 AND EXISTS (SELECT 1 FROM ${tbl} t2 WHERE t2.user_id=$2 AND ${cond})`,
              [ext, native],
            );
            deletedConflicts += del.rowCount;
          }
        }

        const upd = await client.query(`UPDATE ${tbl} SET user_id=$1 WHERE user_id=$2`, [native, ext]);
        pairReport.tables[t] = { extRows: extCount, moved: upd.rowCount, deletedConflicts };
      }
      report.pairs.push(pairReport);
    }

    if (dryRun) {
      await client.query('ROLLBACK');
      report.committed = false;
    } else {
      await client.query('COMMIT');
      report.committed = true;
    }
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    report.error = String(err?.message || err);
    report.committed = false;
  } finally {
    await client.end().catch(() => {});
  }

  return report;
};
