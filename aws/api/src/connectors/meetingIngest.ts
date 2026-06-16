import { query } from '../db';
import { ensureConnectorSchema } from './schema';

/**
 * Meeting → knowledge_item ingest (Living-Brain fix). Meetings used to live only in
 * task_history/knowledge_graph, so the brain's embed + link pipeline never saw them —
 * they showed as isolated nodes on the map. This makes each meeting a first-class
 * knowledge_item (source='meeting'), workspace-scoped, so it gets embedded (Phase B)
 * and linked to Jira/GitHub (Phase C) like everything else.
 *
 * Idempotent: one row per (workspace, meeting); only ingests meetings not already present
 * (updates are rare). The brain map then renders meetings CONNECTED to tasks + PRs.
 */

const CAP = 120;

function meetingBody(r: any): string {
  const parts: string[] = [];
  if (r.summary) parts.push(String(r.summary));
  const decisions = Array.isArray(r.decisions) ? r.decisions : [];
  if (decisions.length) parts.push('Decisions: ' + decisions.map((d: any) => d?.decision || d).filter(Boolean).join('; '));
  const ai = Array.isArray(r.action_items) ? r.action_items : [];
  if (ai.length) parts.push('Action items: ' + ai.map((a: any) => `${a?.task || a}${a?.owner ? ` (${a.owner})` : ''}`).filter(Boolean).join('; '));
  const topics = Array.isArray(r.topics) ? r.topics : [];
  if (topics.length) parts.push('Topics: ' + topics.map((t: any) => t?.name || t).filter(Boolean).join(', '));
  if (r.notes && parts.length < 2) parts.push(String(r.notes));
  return parts.join('\n').slice(0, 3000);
}

export async function ingestMeetings(cap = CAP): Promise<{ ingested: number }> {
  await ensureConnectorSchema();
  // Meeting↔workspace pairs (direct or via folder) not yet in knowledge_item.
  const rows = await query<any>(
    `SELECT th.id AS task_id, th.user_id, m.workspace_id, th.created_at, th.filename, th.summary, th.notes, th.attendees,
            kg.decisions, kg.action_items, kg.topics, kg.people
       FROM task_history th
       JOIN (
         SELECT tw.task_id, tw.workspace_id FROM task_workspaces tw
         UNION
         SELECT tf.task_id, f.workspace_id FROM task_folders tf JOIN folders f ON f.id = tf.folder_id
       ) m ON m.task_id = th.id
       LEFT JOIN knowledge_graph kg ON kg.task_id = th.id AND kg.user_id = th.user_id
       LEFT JOIN knowledge_item ki ON ki.user_id = th.user_id AND ki.workspace_id = m.workspace_id
            AND ki.source = 'meeting' AND ki.source_id = th.id::text AND ki.type = 'meeting'
      WHERE ki.id IS NULL
      ORDER BY th.created_at DESC
      LIMIT ${cap}`,
  ).catch(() => []);
  if (!rows.length) return { ingested: 0 };

  let n = 0;
  for (const r of rows) {
    const people = { attendees: Array.isArray(r.attendees) ? r.attendees : [], ...(r.people && typeof r.people === 'object' ? { mentioned: r.people } : {}) };
    await query(
      `INSERT INTO knowledge_item (user_id, workspace_id, source, source_id, type, title, body, people, links, raw, occurred_at)
       VALUES ($1,$2,'meeting',$3,'meeting',$4,$5,$6,'{}'::jsonb,'{}'::jsonb,$7)
       ON CONFLICT (user_id, workspace_id, source, source_id, type) DO UPDATE SET
         title=EXCLUDED.title, body=EXCLUDED.body, people=EXCLUDED.people, occurred_at=EXCLUDED.occurred_at, synced_at=NOW()`,
      [r.user_id, r.workspace_id, String(r.task_id), r.filename || 'Untitled meeting', meetingBody(r), JSON.stringify(people), r.created_at || null],
    ).catch(() => {});
    n++;
  }
  console.log('meeting_ingest', JSON.stringify({ ingested: n }));
  return { ingested: n };
}
