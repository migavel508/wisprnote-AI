import type { APIGatewayProxyEvent, APIGatewayProxyResult } from 'aws-lambda';

/**
 * SLACK MCP BRIDGE — a minimal MCP server (Streamable-HTTP, JSON-RPC) that we host ourselves and
 * back with the Slack WEB API. Slack's hosted MCP (mcp.slack.com) is gated to Slack-approved
 * clients, which a self-registered app can't clear. But the same operations are plain Web API
 * calls that any app can make on any plan. So the AGENT stays 100% tool-agnostic — it discovers
 * and calls `mcp__slack__*` tools through the normal MCP client — while this bridge does the real
 * work. OAuth still runs against Slack (unchanged); the bridge only serves tools, authed by the
 * Slack access token the caller passes as `Authorization: Bearer <token>`.
 */

const SLACK_API = 'https://slack.com/api';

const TOOLS = [
  {
    name: 'slack_search_channels',
    description: 'List or search Slack channels by name/description. Returns channel names, IDs, and purposes. Leave query empty to list all.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'name/keyword filter; empty lists all' }, limit: { type: 'number' } }, required: [] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'slack_read_channel',
    description: 'Read the most recent messages from a Slack channel by its id (newest first). Use a user id to read a DM.',
    inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, limit: { type: 'number' } }, required: ['channel_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'slack_list_channel_members',
    description: 'List the member user ids of a Slack channel by its id.',
    inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, limit: { type: 'number' } }, required: ['channel_id'] },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'slack_send_message',
    description: 'Send a message to a Slack channel (by channel id) or user (by user id, for a DM). Returns a permalink.',
    inputSchema: { type: 'object', properties: { channel_id: { type: 'string' }, message: { type: 'string' } }, required: ['channel_id', 'message'] },
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
];

async function slack(token: string, method: string, params: Record<string, unknown>): Promise<any> {
  const r = await fetch(`${SLACK_API}/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8', Authorization: `Bearer ${token}` },
    body: JSON.stringify(params),
  });
  const d: any = await r.json().catch(() => ({}));
  if (!d?.ok) throw new Error(`slack.${method}: ${d?.error || `http ${r.status}`}`);
  return d;
}

async function callTool(token: string, name: string, args: any): Promise<string> {
  switch (name) {
    case 'slack_search_channels': {
      const d = await slack(token, 'conversations.list', { types: 'public_channel,private_channel', limit: 200, exclude_archived: true });
      const q = String(args?.query || '').trim().toLowerCase();
      let chans = (d.channels || []).map((c: any) => ({ id: c.id, name: c.name, is_private: !!c.is_private, purpose: c.purpose?.value || c.topic?.value || '' }));
      if (q) chans = chans.filter((c: any) => c.name.toLowerCase().includes(q) || c.purpose.toLowerCase().includes(q));
      return JSON.stringify(chans.slice(0, Math.min(50, Number(args?.limit) || 50)));
    }
    case 'slack_read_channel': {
      const d = await slack(token, 'conversations.history', { channel: String(args?.channel_id), limit: Math.min(100, Math.max(1, Number(args?.limit) || 20)) });
      return JSON.stringify((d.messages || []).map((m: any) => ({ user: m.user || m.bot_id || 'unknown', text: m.text || '', ts: m.ts })));
    }
    case 'slack_list_channel_members': {
      const d = await slack(token, 'conversations.members', { channel: String(args?.channel_id), limit: Math.min(100, Number(args?.limit) || 50) });
      return JSON.stringify({ members: d.members || [] });
    }
    case 'slack_send_message': {
      const d = await slack(token, 'chat.postMessage', { channel: String(args?.channel_id), text: String(args?.message || '') });
      let link = '';
      try { const p = await slack(token, 'chat.getPermalink', { channel: d.channel, message_ts: d.ts }); link = p.permalink || ''; } catch { /* optional */ }
      return JSON.stringify({ ok: true, ts: d.ts, channel: d.channel, link });
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

/** Handle one JSON-RPC request to the bridge (POST /mcp/slack). Authed by the Bearer Slack token. */
export async function handleSlackMcpBridge(event: APIGatewayProxyEvent): Promise<APIGatewayProxyResult> {
  const auth = event.headers?.Authorization || event.headers?.authorization || '';
  const token = auth.replace(/^Bearer\s+/i, '').trim();

  let msg: any = {};
  try { msg = JSON.parse(event.body || '{}'); } catch { /* fall through to parse error */ }
  const id = msg?.id ?? null;
  const okJson = (result: any): APIGatewayProxyResult => ({
    statusCode: 200,
    headers: { 'Content-Type': 'application/json', 'mcp-session-id': 'slack-bridge' },
    body: JSON.stringify({ jsonrpc: '2.0', id, result }),
  });
  const rpcErr = (code: number, message: string): APIGatewayProxyResult => ({
    statusCode: 200, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }),
  });

  const method = msg?.method;
  if (method === 'initialize') {
    return okJson({ protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'wisprnote-slack-bridge', version: '1.0' } });
  }
  if (method === 'notifications/initialized' || method === 'notifications/cancelled') {
    return { statusCode: 202, headers: { 'Content-Type': 'application/json' }, body: '' };
  }
  if (!token) return rpcErr(-32001, 'missing Slack access token (Authorization: Bearer)');
  if (method === 'tools/list') return okJson({ tools: TOOLS });
  if (method === 'tools/call') {
    const name = String(msg?.params?.name || '');
    const args = msg?.params?.arguments || {};
    try {
      const text = await callTool(token, name, args);
      return okJson({ content: [{ type: 'text', text }] });
    } catch (e: any) {
      // MCP convention: tool errors are a normal result with isError, not a protocol error.
      return okJson({ content: [{ type: 'text', text: String(e?.message || e).slice(0, 500) }], isError: true });
    }
  }
  return rpcErr(-32601, `method not found: ${method}`);
}
