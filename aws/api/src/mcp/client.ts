import type { McpServer } from './registry';

/**
 * Generic MCP client (Streamable HTTP transport). Connectors call a tool's MCP
 * server through this — one uniform surface instead of N REST clients. Authed with
 * the user's OAuth access token (from the broker).
 *
 * NOTE: wired + verified against a live server in Phase 1 (needs real OAuth creds).
 * Not invoked by anything in Phase 0 (only the no-op connector runs), so it ships
 * dark/safe. Implements: initialize → notifications/initialized → tools/list|call.
 */

const PROTOCOL_VERSION = '2025-06-18';
const TIMEOUT_MS = 20_000;

interface JsonRpcResult { result?: any; error?: { code: number; message: string } }

/** Parse a Streamable-HTTP response that may be plain JSON or an SSE stream. */
async function parseRpc(resp: Response): Promise<JsonRpcResult> {
  const text = await resp.text();
  const ct = resp.headers.get('content-type') || '';
  if (ct.includes('text/event-stream') || text.startsWith('event:') || text.includes('\ndata:')) {
    // take the last `data:` JSON payload in the SSE stream
    const datas = text.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
    for (let i = datas.length - 1; i >= 0; i--) {
      try { return JSON.parse(datas[i]); } catch { /* keep scanning */ }
    }
    return {};
  }
  try { return JSON.parse(text); } catch { return {}; }
}

async function rpc(url: string, token: string, sessionId: string | null, id: number, method: string, params: unknown, extra?: Record<string, string>): Promise<{ body: JsonRpcResult; sessionId: string | null }> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(extra || {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
      signal: ctrl.signal,
    });
    const sid = resp.headers.get('mcp-session-id') || sessionId;
    return { body: await parseRpc(resp), sessionId: sid };
  } finally {
    clearTimeout(timer);
  }
}

async function notify(url: string, token: string, sessionId: string | null, method: string, extra?: Record<string, string>): Promise<void> {
  try {
    await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        Authorization: `Bearer ${token}`,
        'MCP-Protocol-Version': PROTOCOL_VERSION,
        ...(extra || {}),
        ...(sessionId ? { 'Mcp-Session-Id': sessionId } : {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', method, params: {} }),
    });
  } catch { /* notifications are fire-and-forget */ }
}

/** Open a session: initialize handshake. Returns the session id (if any). */
async function openSession(url: string, token: string, extra?: Record<string, string>): Promise<string | null> {
  const { body, sessionId } = await rpc(url, token, null, 1, 'initialize', {
    protocolVersion: PROTOCOL_VERSION,
    capabilities: {},
    clientInfo: { name: 'wisprnote', version: '1.0' },
  }, extra);
  if (body.error) throw new Error(`MCP initialize failed: ${body.error.message}`);
  await notify(url, token, sessionId, 'notifications/initialized', extra);
  return sessionId;
}

/** List the tools a server exposes. */
export async function mcpListTools(server: McpServer, token: string): Promise<any[]> {
  if (!server.url) throw new Error(`MCP server ${server.id} has no endpoint configured`);
  const sid = await openSession(server.url, token, server.headers);
  const { body } = await rpc(server.url, token, sid, 2, 'tools/list', {}, server.headers);
  if (body.error) throw new Error(`MCP tools/list failed: ${body.error.message}`);
  return body.result?.tools ?? [];
}

/** Call one tool and return its result. */
export async function mcpCallTool(server: McpServer, token: string, name: string, args: Record<string, unknown>): Promise<any> {
  if (!server.url) throw new Error(`MCP server ${server.id} has no endpoint configured`);
  const sid = await openSession(server.url, token, server.headers);
  const { body } = await rpc(server.url, token, sid, 3, 'tools/call', { name, arguments: args }, server.headers);
  if (body.error) throw new Error(`MCP tools/call(${name}) failed: ${body.error.message}`);
  return body.result;
}
