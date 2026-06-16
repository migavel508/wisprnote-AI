import { resolveMcpConnection } from './connection';
import { mcpListTools, mcpCallTool } from './client';
import { recordAudit } from '../connectors/jira/audit';

/**
 * Generic MCP write executor — runs ONE approved write tool of any kind (Confluence
 * page/comment, worklog, issue link, Compass component, custom field, …) after the user
 * approves its HITL card. Validates dynamically against the server's own tool list so we
 * support every write the MCP offers without a hand-maintained per-tool list. DELETES are
 * never permitted. Records an audit entry. cloudId is injected where the tool needs it.
 */

// Verb/suffix classifier covering both Atlassian (prefix) and GitHub (suffix) naming.
const WRITE_VERB = /^(create|update|edit|add|transition|publish|merge|put|post|upload|assign|move|set|comment|close|reopen|fork|push|dispatch|rerun|cancel|request)/i;
const WRITE_SUFFIX = /_(write|create|update|add|edit|merge|comment)$/i;
const DELETE_VERB = /^(delete|remove|archive|purge|trash)|_(delete|remove)$/i;

export interface McpWriteResult { ok: boolean; message: string; url?: string }

export async function executeMcpWrite(userId: string, workspaceId: string, connector: string, tool: string, args: Record<string, unknown>): Promise<McpWriteResult> {
  if (DELETE_VERB.test(tool) || !(WRITE_VERB.test(tool) || WRITE_SUFFIX.test(tool))) {
    return { ok: false, message: `"${tool}" is not an allowed write action.` };
  }
  const conn = await resolveMcpConnection(userId, workspaceId, connector);
  if (!conn) return { ok: false, message: `${connector} is not connected in this workspace.` };

  // Validate the tool actually exists on this connector's server before calling it.
  const tools = await mcpListTools(conn.server, conn.token).catch(() => []);
  const def = (tools || []).find((t: any) => t.name === tool);
  if (!def) return { ok: false, message: `Unknown tool "${tool}".` };
  const needsCloudId = !!def.inputSchema?.properties?.cloudId && !!conn.cloudId;

  try {
    const r = await mcpCallTool(conn.server, conn.token, tool, { ...(args || {}), ...(needsCloudId ? { cloudId: conn.cloudId } : {}) });
    const text = (r?.content?.[0]?.text ?? '').toString();
    if (r?.isError) return { ok: false, message: `${connector} rejected it: ${text.slice(0, 250)}` };
    let parsed: any = null; try { parsed = JSON.parse(text); } catch { /* non-JSON ok */ }
    const key = parsed?.key;
    // Jira → browse URL; GitHub & others → html_url/url returned by the tool.
    const url = key && conn.siteUrl ? `${conn.siteUrl}/browse/${key}`
      : (parsed?.html_url || parsed?.url
        || (parsed?._links?.base && parsed?._links?.webui ? `${parsed._links.base}${parsed._links.webui}` : undefined));
    await recordAudit({
      userId, workspaceId, operation: tool as any, issueKey: key ?? null, summary: `${connector}:${tool}`,
      proposal: { operation: tool, connector, ...(args || {}) } as any, result: parsed ?? text.slice(0, 500), rollback: null,
    }).catch(() => {});
    return { ok: true, message: `Done — ${tool}${key ? ` (${key})` : ''}.`, url };
  } catch (e: any) {
    return { ok: false, message: `Failed: ${e?.message || 'error'}` };
  }
}
