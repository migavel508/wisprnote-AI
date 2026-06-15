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
}

export const MCP_SERVERS: Record<string, McpServer> = {
  github: {
    id: 'github', label: 'GitHub',
    transport: 'streamable-http', url: 'https://api.githubcopilot.com/mcp/',
    auth: 'oauth2.1', official: true,
    scopes: ['repo', 'read:issue', 'write:issue', 'read:discussion'],
    docs: 'https://github.com/github/github-mcp-server',
    status: 'ga',
    notes: 'Official remote GitHub MCP (GA Sep 2025), OAuth 2.1 + PKCE. Self-host alt: github/github-mcp-server (docker, PAT).',
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
    id: 'gmail', label: 'Gmail (Google Workspace MCP)',
    transport: 'streamable-http', url: null,
    auth: 'oauth2.0', official: true,
    scopes: ['https://www.googleapis.com/auth/gmail.readonly', 'https://www.googleapis.com/auth/gmail.send'],
    docs: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    status: 'beta',
    notes: 'Google Workspace remote MCP (per-service, OAuth 2.0, configured via an OAuth client). Community all-in-one alt: taylorwilsdon/google_workspace_mcp (OAuth 2.1, self-host).',
  },
  gcal: {
    id: 'gcal', label: 'Google Calendar (Google Workspace MCP)',
    transport: 'streamable-http', url: null,
    auth: 'oauth2.0', official: true,
    scopes: ['https://www.googleapis.com/auth/calendar.readonly', 'https://www.googleapis.com/auth/calendar.events'],
    docs: 'https://developers.google.com/workspace/calendar/api/guides/configure-mcp-server',
    status: 'beta',
    notes: 'Google Calendar remote MCP, OAuth 2.0. Same Google Workspace MCP family as gmail/gdrive.',
  },
  gdrive: {
    id: 'gdrive', label: 'Google Drive (Google Workspace MCP)',
    transport: 'streamable-http', url: null,
    auth: 'oauth2.0', official: true,
    scopes: ['https://www.googleapis.com/auth/drive.readonly'],
    docs: 'https://developers.google.com/workspace/guides/configure-mcp-servers',
    status: 'beta',
    notes: 'Google Drive remote MCP (read), OAuth 2.0.',
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
