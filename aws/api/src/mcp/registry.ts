/**
 * MCP REGISTRY — the single source of truth for the external **MCP servers** our
 * connectors talk to. Same idea as the model registry (`models/registry.ts`):
 * change a server's endpoint / auth / scopes HERE, not scattered across connectors.
 *
 * Architecture: connectors do NOT call vendor REST APIs directly — the Lambda runs
 * an **MCP client** that connects to each tool's MCP server (remote, OAuth) using
 * the user's token from the credential broker, and calls the server's tools. This
 * keeps one uniform integration surface instead of N bespoke API clients.
 *
 * `url` is set only where the official remote endpoint is confirmed. Where it's not
 * yet pinned, `url` is null + `docs` points at the source to confirm during
 * implementation (do NOT invent endpoints). Verified against vendor docs, 2026-06.
 */

export type McpTransport = 'streamable-http' | 'sse' | 'stdio' | 'local';
export type McpAuth = 'oauth2.1' | 'oauth2.0' | 'pat' | 'none';
export type McpStatus = 'ga' | 'beta' | 'community' | 'planned';

export interface McpServer {
  id: string;                 // matches the connector id (src/config/connectors.ts)
  label: string;
  transport: McpTransport;
  url: string | null;         // remote endpoint (null = confirm at impl time via `docs`)
  auth: McpAuth;
  official: boolean;          // first-party vendor MCP vs community
  scopes: string[];           // OAuth scopes / capabilities to request
  docs: string;
  status: McpStatus;
  notes?: string;
  headers?: Record<string, string>;   // static extra headers sent on every MCP request
  connect?: 'oauth' | 'pat';          // how the client connects (default 'oauth' via DCR+PKCE)
}

export const MCP_SERVERS: Record<string, McpServer> = {
  github: {
    id: 'github', label: 'GitHub',
    transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
    auth: 'oauth2.1', official: true,
    scopes: ['repo', 'read:issue', 'write:issue', 'read:discussion'],
    docs: 'https://github.com/github/github-mcp-server',
    status: 'ga',
    notes: 'Official remote GitHub MCP (GA Sep 2025). Its OAuth does NOT advertise DCR, so our generic DCR flow cannot auto-register — we connect via a fine-grained PAT (Bearer) instead. X-MCP-Toolsets selects which toolsets load.',
    // GitHub remote MCP OAuth lacks Dynamic Client Registration → connect with a PAT.
    connect: 'pat',
    // Enable the toolsets our brain uses; the server gates further by the token's scopes.
    headers: { 'X-MCP-Toolsets': 'repos,issues,pull_requests,actions,discussions,users,orgs,notifications' },
  },
  jira: {
    id: 'jira', label: 'Jira (Atlassian Rovo)',
    transport: 'streamable-http', url: 'https://mcp.atlassian.com/v1/mcp',
    auth: 'oauth2.1', official: true,
    scopes: ['read:jira-work', 'write:jira-work', 'read:confluence-content.all'],
    docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/',
    status: 'ga',
    notes: 'Official Atlassian Rovo remote MCP (GA Feb 2026) — covers Jira + Confluence + Compass. The /v1/sse endpoint is deprecated after 2026-06-30; use /v1/mcp.',
  },
  slack: {
    id: 'slack', label: 'Slack',
    transport: 'streamable-http', url: null, // confirm the remote endpoint from the docs at impl time
    auth: 'oauth2.0', official: true,
    scopes: ['channels:read', 'channels:history', 'chat:write', 'search:read'],
    docs: 'https://docs.slack.dev/ai/slack-mcp-server/',
    status: 'beta',
    notes: 'Official Slack MCP server (Salesforce/Slack + Anthropic), OAuth, admin-approved. Endpoint not pinned here — confirm from docs. Community alt: korotovsky/slack-mcp-server (stdio).',
  },
  gmail: {
    id: 'gmail', label: 'Gmail (Google Workspace)',
    transport: 'streamable-http', url: null,
    auth: 'oauth2.0', official: true,
    // gmail.modify is the single scope covering the full hosted-connector tool surface: read/search
    // threads + labels + drafts (read), and create draft, create/add/remove labels, trash (write).
    // It does NOT grant permanent delete or send (we expose neither). Direct-REST, no MCP endpoint.
    scopes: ['https://www.googleapis.com/auth/gmail.modify'],
    docs: 'https://developers.google.com/workspace/gmail/api/auth/scopes',
    status: 'beta',
    notes: 'Direct-REST Google connector (no MCP endpoint). Replicates the hosted Claude-for-Gmail tool set (4 read + 8 write) via connectors/google/tools.ts. gmail.modify is a RESTRICTED scope → production GA needs Google app verification + CASA; testing/unverified works for up to 100 consenting users.',
  },
  gcal: {
    id: 'gcal', label: 'Google Calendar (Google Workspace)',
    transport: 'streamable-http', url: null,
    auth: 'oauth2.0', official: true,
    // Full `calendar` scope covers all 8 hosted-connector tools: list/get events, list calendars,
    // free/busy (read) + create/update/respond/delete (write). RESTRICTED scope → GA needs verification.
    scopes: ['https://www.googleapis.com/auth/calendar'],
    docs: 'https://developers.google.com/workspace/calendar/api/auth',
    status: 'beta',
    notes: 'Direct-REST Google connector. 4 read (events, get, calendar list, free/busy) + 4 write (create, update, respond, delete) via connectors/google/tools.ts.',
  },
  gdrive: {
    id: 'gdrive', label: 'Google Drive (Google Workspace)',
    transport: 'streamable-http', url: null,
    auth: 'oauth2.0', official: true,
    // Full `drive` scope covers all 8 hosted-connector tools: search/list/metadata/permissions/read/
    // download (read) + copy/create (write). RESTRICTED scope → GA needs verification + CASA.
    scopes: ['https://www.googleapis.com/auth/drive'],
    docs: 'https://developers.google.com/workspace/drive/api/guides/api-specific-auth',
    status: 'beta',
    notes: 'Direct-REST Google connector. 6 read + 2 write (copy, create) via connectors/google/tools.ts.',
  },
  'claude-code': {
    id: 'claude-code', label: 'Claude Code sessions',
    transport: 'local', url: null,
    auth: 'none', official: false,
    scopes: [],
    docs: 'https://docs.claude.com/claude-code',
    status: 'planned',
    notes: 'NOT an external MCP — local `~/.claude` `.jsonl` read via Tauri fs. Ingested client-side, not through the MCP client.',
  },
  codex: {
    id: 'codex', label: 'Codex',
    transport: 'local', url: null,
    auth: 'none', official: false,
    scopes: [],
    docs: 'https://platform.openai.com/docs',
    status: 'planned',
    notes: 'NOT a hosted MCP — OpenAI Codex session export read locally / via OpenAI API.',
  },
};

export type McpKey = keyof typeof MCP_SERVERS;

/** Look up an MCP server by connector id. */
export function getMcpServer(id: string): McpServer | undefined {
  return MCP_SERVERS[id];
}

/** Connectors reachable via a remote MCP server (have a confirmed endpoint). */
export function remoteMcpServers(): McpServer[] {
  return Object.values(MCP_SERVERS).filter((s) => s.transport !== 'local' && s.url != null);
}
