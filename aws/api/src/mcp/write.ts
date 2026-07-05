import { resolveMcpConnection } from './connection';
import { mcpListTools, mcpCallTool, resolveLiveTool } from './client';
import { resolvePermission } from './toolPlane';
import { recordAudit } from '../connectors/jira/audit';

/**
 * Generic MCP write executor — runs ONE approved write tool of any kind (Confluence
 * page/comment, worklog, issue link, Compass component, custom field, …) after the user
 * approves its HITL card. Validates dynamically against the server's own tool list so we
 * support every write the MCP offers without a hand-maintained per-tool list. DELETES are
 * never permitted. Records an audit entry. cloudId is injected where the tool needs it.
 */

// DELETE/destructive names are hard-blocked no matter what. We do NOT whitelist write names —
// any non-destructive tool the user APPROVED runs, so a connector's tools work regardless of their
// naming convention (e.g. Slack's `slack_send_message`, which no verb-prefix rule would match).
const DELETE_VERB = /^(delete|remove|archive|purge|trash|destroy|drop)|_(delete|remove|destroy)\b/i;

export interface McpWriteResult { ok: boolean; message: string; url?: string }

export async function executeMcpWrite(userId: string, workspaceId: string, connector: string, tool: string, args: Record<string, unknown>): Promise<McpWriteResult> {
  // Never run a destructive/delete action, even if approved — the one hard safety rule.
  if (DELETE_VERB.test(tool)) return { ok: false, message: `“${tool}” is a destructive action and is never run automatically.` };

  // TRUST GATE — every tool call crosses the permission engine. 'deny' (the user set this tool to
  // "never") blocks even an approved card; 'allow'/'ask' proceed (the card IS the approval for ask).
  // 'destructive' class is also never auto-run.
  const perm = await resolvePermission(userId, workspaceId, connector, tool).catch(() => null);
  if (perm?.behavior === 'deny') return { ok: false, message: `Blocked by policy — “${tool}” is set to never run for this connector.` };
  if (perm?.klass === 'destructive') return { ok: false, message: `“${tool}” is classified destructive and is never run automatically.` };

  const conn = await resolveMcpConnection(userId, workspaceId, connector);
  if (!conn) return { ok: false, message: `${connector} is not connected in this workspace.` };

  // Validate against the server's LIVE tool list via the shared, connector-agnostic resolver (a
  // stale catalog / name variant must not dead-end an approved action). On a true miss, tell the
  // caller what the server actually offers, and refresh the catalog in the background.
  const tools = await mcpListTools(conn.server, conn.token).catch(() => []);
  const def = resolveLiveTool(tools, tool, connector);
  if (!def) {
    try { const { discoverConnectorTools } = await import('./toolPlane'); void discoverConnectorTools(userId, workspaceId, connector); } catch { /* refresh is best-effort */ }
    const avail = (tools || []).map((t: any) => t.name).slice(0, 40).join(', ');
    return { ok: false, message: `Unknown tool "${tool}" on ${connector}.${avail ? ` The server currently offers: ${avail}.` : ''}` };
  }
  const liveName = String(def.name);
  // Re-apply the hard safety rules to the RESOLVED name (it may differ from the requested one).
  if (DELETE_VERB.test(liveName)) return { ok: false, message: `“${liveName}” is a destructive action and is never run automatically.` };
  // Respect the tool's OWN destructive hint (MCP annotations) — belt-and-suspenders with the classifier.
  if (def.annotations?.destructiveHint === true) return { ok: false, message: `“${liveName}” is marked destructive by the server and is never run automatically.` };
  const needsCloudId = !!def.inputSchema?.properties?.cloudId && !!conn.cloudId;

  try {
    const r = await mcpCallTool(conn.server, conn.token, liveName, { ...(args || {}), ...(needsCloudId ? { cloudId: conn.cloudId } : {}) });
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
