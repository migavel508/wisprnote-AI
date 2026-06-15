import { query, queryOne } from '../db';
import { ensureConnectorSchema } from './schema';
import { getConnector, type KnowledgeItemInput } from './registry';

/**
 * Connector sync engine — the connector-side twin of `kgSweep`. Driven by the
 * `connector-sync` EventBridge job. For each connected credential whose connector
 * is registered, pull one bounded page from its cursor, upsert into `knowledge_item`
 * (idempotent), and advance the cursor. Self-healing + safe to re-run.
 */

const SOURCE_CAP = 25;     // connected sources per tick
const TIME_BUDGET_MS = 24_000;

async function upsertItem(userId: string, it: KnowledgeItemInput): Promise<void> {
  await query(
    `INSERT INTO knowledge_item (user_id, source, source_id, type, title, body, people, links, raw, occurred_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10, NOW())
     ON CONFLICT (user_id, source, source_id, type) DO UPDATE SET
       title=EXCLUDED.title, body=EXCLUDED.body, people=EXCLUDED.people,
       links=EXCLUDED.links, raw=EXCLUDED.raw, occurred_at=EXCLUDED.occurred_at, synced_at=NOW()`,
    [
      userId, it.source, it.source_id, it.type, it.title ?? null, it.body ?? null,
      JSON.stringify(it.people ?? null), JSON.stringify(it.links ?? null),
      JSON.stringify(it.raw ?? {}), it.occurred_at ?? null,
    ],
  );
}

export interface ConnectorSyncResult { sources: number; processed: number; errors: number }

export async function runConnectorSync(): Promise<ConnectorSyncResult> {
  await ensureConnectorSchema();
  const started = Date.now();
  const creds = await query<{ user_id: string; source: string }>(
    `SELECT user_id, source FROM connector_credentials ORDER BY updated_at ASC LIMIT $1`,
    [SOURCE_CAP],
  );
  const result: ConnectorSyncResult = { sources: 0, processed: 0, errors: 0 };

  for (const c of creds) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const conn = getConnector(c.source);
    if (!conn) continue; // credential for a not-yet-registered connector
    result.sources++;
    try {
      const st = await queryOne<{ cursor: string | null }>(
        `SELECT cursor FROM sync_state WHERE user_id=$1 AND source=$2 AND scope='default'`,
        [c.user_id, c.source],
      );
      const page = await conn.sync(c.user_id, 'default', st?.cursor ?? null);
      for (const it of page.items) { await upsertItem(c.user_id, it); result.processed++; }
      await query(
        `INSERT INTO sync_state (user_id, source, scope, cursor, last_synced_at)
         VALUES ($1,$2,'default',$3, NOW())
         ON CONFLICT (user_id, source, scope) DO UPDATE SET cursor=EXCLUDED.cursor, last_synced_at=NOW()`,
        [c.user_id, c.source, page.nextCursor],
      );
    } catch (err: any) {
      result.errors++;
      console.error('connector_sync_failed', JSON.stringify({ source: c.source, message: err?.message }));
    }
  }
  console.log('connector_sync_tick', JSON.stringify(result));
  return result;
}
