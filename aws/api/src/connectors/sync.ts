import { query, queryOne } from '../db';
import { ensureConnectorSchema } from './schema';
import { getConnector, type KnowledgeItemInput } from './registry';
import { insertEvent } from './brainEvents';

/**
 * Connector sync engine — the connector-side twin of `kgSweep`. Driven by the
 * `connector-sync` EventBridge job. For each connected credential (per user AND
 * workspace) whose connector is registered, pull one bounded page from its cursor,
 * upsert into `knowledge_item` (idempotent, workspace-scoped), and advance the cursor.
 * The workspace_id is passed to the connector as its `scope`, and used as the
 * `sync_state.scope` so each workspace tracks its own incremental watermark.
 * Self-healing + safe to re-run.
 */

const SOURCE_CAP = 25;     // connected (workspace,source) pairs per tick
const TIME_BUDGET_MS = 24_000;

async function upsertItem(userId: string, workspaceId: string, it: KnowledgeItemInput): Promise<void> {
  // Read the prior row first so we can OBSERVE state changes (status transitions, brand-new
  // commits) and record them as events — the brain mirrors mutations, it doesn't just snapshot.
  const prior = await queryOne<{ id: string; status: string | null }>(
    `SELECT id, status FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source=$3 AND source_id=$4 AND type=$5`,
    [userId, workspaceId, it.source, it.source_id, it.type],
  ).catch(() => null);

  const row = await queryOne<{ id: string }>(
    `INSERT INTO knowledge_item (user_id, workspace_id, source, source_id, type, title, body, status, people, links, raw, occurred_at, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, NOW())
     ON CONFLICT (user_id, workspace_id, source, source_id, type) DO UPDATE SET
       title=EXCLUDED.title, body=EXCLUDED.body, status=EXCLUDED.status, people=EXCLUDED.people,
       links=EXCLUDED.links, raw=EXCLUDED.raw, occurred_at=EXCLUDED.occurred_at, synced_at=NOW()
     RETURNING id`,
    [
      userId, workspaceId, it.source, it.source_id, it.type, it.title ?? null, it.body ?? null, it.status ?? null,
      JSON.stringify(it.people ?? null), JSON.stringify(it.links ?? null),
      JSON.stringify(it.raw ?? {}), it.occurred_at ?? null,
    ],
  );
  const itemId = row?.id ?? prior?.id ?? null;

  // Emit observed events: a status transition, or a brand-new commit landing.
  // NOTE: require a non-null PRIOR status so the first sync (which back-fills NULL→current
  // for every existing issue) doesn't emit a flood of spurious "moved to X" events.
  if (it.status && prior && prior.status && prior.status !== it.status) {
    await insertEvent({ userId, workspaceId, itemId, source: it.source, sourceId: it.source_id, kind: 'status_change', actor: it.actor ?? null, fromState: prior.status, toState: it.status, title: it.title ?? null, occurredAt: it.occurred_at ?? null });
  } else if (!prior && it.type === 'commit') {
    await insertEvent({ userId, workspaceId, itemId, source: it.source, sourceId: it.source_id, kind: 'commit', actor: it.actor ?? null, title: it.title ?? null, occurredAt: it.occurred_at ?? null });
  } else if (!prior && it.status) {
    await insertEvent({ userId, workspaceId, itemId, source: it.source, sourceId: it.source_id, kind: 'created', actor: it.actor ?? null, toState: it.status, title: it.title ?? null, occurredAt: it.occurred_at ?? null });
  }
}

export interface ConnectorSyncResult { sources: number; processed: number; errors: number }

export async function runConnectorSync(workspaceId?: string): Promise<ConnectorSyncResult> {
  await ensureConnectorSchema();
  const started = Date.now();
  // On-demand path scopes to ONE workspace (sync-now); the cron syncs all (round-robin).
  const creds = workspaceId
    ? await query<{ user_id: string; workspace_id: string; source: string }>(
        `SELECT user_id, workspace_id, source FROM connector_credentials WHERE workspace_id=$1`, [workspaceId])
    : await query<{ user_id: string; workspace_id: string; source: string }>(
        `SELECT user_id, workspace_id, source FROM connector_credentials ORDER BY updated_at ASC LIMIT $1`, [SOURCE_CAP]);
  const result: ConnectorSyncResult = { sources: 0, processed: 0, errors: 0 };

  for (const c of creds) {
    if (Date.now() - started > TIME_BUDGET_MS) break;
    const conn = getConnector(c.source);
    if (!conn) continue; // credential for a not-yet-registered connector
    result.sources++;
    const scope = c.workspace_id; // the connector's scope IS the workspace
    try {
      const st = await queryOne<{ cursor: string | null }>(
        `SELECT cursor FROM sync_state WHERE user_id=$1 AND source=$2 AND scope=$3`,
        [c.user_id, c.source, scope],
      );
      const page = await conn.sync(c.user_id, scope, st?.cursor ?? null);
      for (const it of page.items) { await upsertItem(c.user_id, c.workspace_id, it); result.processed++; }
      await query(
        `INSERT INTO sync_state (user_id, source, scope, cursor, last_synced_at)
         VALUES ($1,$2,$3,$4, NOW())
         ON CONFLICT (user_id, source, scope) DO UPDATE SET cursor=EXCLUDED.cursor, last_synced_at=NOW()`,
        [c.user_id, c.source, scope, page.nextCursor],
      );
    } catch (err: any) {
      result.errors++;
      console.error('connector_sync_failed', JSON.stringify({ source: c.source, workspace: scope, message: err?.message }));
    }
  }
  console.log('connector_sync_tick', JSON.stringify(result));
  return result;
}
