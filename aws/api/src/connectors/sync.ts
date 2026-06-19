import { query, queryOne } from '../db';
import { ensureConnectorSchema } from './schema';
import { getConnector, type KnowledgeItemInput } from './registry';
import { insertEvent } from './brainEvents';
import { folderResolverFor, WS_DEFAULT } from './routing';

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

async function upsertItem(userId: string, workspaceId: string, it: KnowledgeItemInput, folderId: string | null): Promise<void> {
  // Read the prior row first so we can OBSERVE state changes (status transitions, brand-new
  // commits) and record them as events — the brain mirrors mutations, it doesn't just snapshot.
  const prior = await queryOne<{ id: string; status: string | null }>(
    `SELECT id, status FROM knowledge_item WHERE user_id=$1 AND workspace_id=$2 AND source=$3 AND source_id=$4 AND type=$5`,
    [userId, workspaceId, it.source, it.source_id, it.type],
  ).catch(() => null);

  // folder_id = the project this item belongs to (resolved from its source_id). COALESCE so a
  // re-sync that can't resolve a folder (mapping not loaded) doesn't WIPE an existing tag.
  const row = await queryOne<{ id: string }>(
    `INSERT INTO knowledge_item (user_id, workspace_id, source, source_id, type, title, body, status, people, links, raw, occurred_at, folder_id, synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, NOW())
     ON CONFLICT (user_id, workspace_id, source, source_id, type) DO UPDATE SET
       title=EXCLUDED.title, body=EXCLUDED.body, status=EXCLUDED.status, people=EXCLUDED.people,
       links=EXCLUDED.links, raw=EXCLUDED.raw, occurred_at=EXCLUDED.occurred_at,
       folder_id=COALESCE(EXCLUDED.folder_id, knowledge_item.folder_id), synced_at=NOW()
     RETURNING id`,
    [
      userId, workspaceId, it.source, it.source_id, it.type, it.title ?? null, it.body ?? null, it.status ?? null,
      JSON.stringify(it.people ?? null), JSON.stringify(it.links ?? null),
      JSON.stringify(it.raw ?? {}), it.occurred_at ?? null, folderId,
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
      // Resolve which PROJECT (folder) each item belongs to from its source_id, so cross-source
      // linking later stays inside one project (a meeting never links to the wrong repo/ticket).
      const resolveFolder = await folderResolverFor(c.user_id, c.workspace_id).catch(() => (() => null));
      for (const it of page.items) { await upsertItem(c.user_id, c.workspace_id, it, resolveFolder(it.source, it.source_id)); result.processed++; }
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

/** One-time / occasional BACKFILL: tag existing items with their project (folder) by matching
 *  source_id to a folder mapping. Idempotent + bounded + converging — only touches currently
 *  unfiled items that NOW resolve to a real folder, so it's safe to re-run. (Live sync tags new
 *  + changed items automatically; this catches the items that won't re-sync soon.) */
export async function backfillItemFolders(cap = 1000): Promise<{ tagged: number; workspaces: number }> {
  await ensureConnectorSchema();
  const wss = await query<{ user_id: string; workspace_id: string }>(
    `SELECT DISTINCT user_id, workspace_id FROM connector_routing WHERE folder_id <> '${WS_DEFAULT}'`,
  ).catch(() => []);
  let tagged = 0;
  for (const { user_id, workspace_id } of wss) {
    const resolve = await folderResolverFor(user_id, workspace_id).catch(() => null);
    if (!resolve) continue;
    const items = await query<{ id: string; source: string; source_id: string }>(
      `SELECT id, source, source_id FROM knowledge_item
        WHERE user_id=$1 AND workspace_id=$2 AND folder_id IS NULL AND source IN ('jira','github')
        ORDER BY synced_at DESC LIMIT ${cap}`,
      [user_id, workspace_id],
    ).catch(() => []);
    for (const it of items) {
      const fid = resolve(it.source, it.source_id);
      if (fid) { await query(`UPDATE knowledge_item SET folder_id=$2 WHERE id=$1`, [it.id, fid]).catch(() => {}); tagged++; }
    }
  }
  // Meetings: tag folder from task_folders (their project membership), for all workspaces at once.
  const mt = await queryOne<{ n: string }>(
    `WITH upd AS (
       UPDATE knowledge_item ki SET folder_id = sub.folder_id
         FROM (SELECT tf.task_id::text AS source_id, f.workspace_id, tf.folder_id
                 FROM task_folders tf JOIN folders f ON f.id = tf.folder_id) sub
        WHERE ki.source='meeting' AND ki.type='meeting' AND ki.source_id = sub.source_id
          AND ki.workspace_id = sub.workspace_id AND ki.folder_id IS DISTINCT FROM sub.folder_id
        RETURNING 1)
     SELECT count(*)::text n FROM upd`,
  ).catch(() => ({ n: '0' }));
  const meetingsTagged = Number(mt?.n ?? 0);
  console.log('backfill_item_folders', JSON.stringify({ tagged, meetingsTagged, workspaces: wss.length }));
  return { tagged: tagged + meetingsTagged, workspaces: wss.length };
}
