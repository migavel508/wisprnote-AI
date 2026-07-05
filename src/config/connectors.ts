import { Mail, Calendar, HardDrive, Github, Hash, Ticket, SquareTerminal, Braces } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';

/**
 * CONNECTOR CATALOG — the single source of truth for which external tools the app
 * can connect, shown in Settings → Connectors (`ConnectionsTab`).
 *
 * Connectors are **MCP-based**: the Lambda runs an MCP client against each tool's
 * MCP server (see the server-side MCP registry `aws/api/src/mcp/registry.ts` for
 * endpoints/auth/scopes). This catalog is the client-side display half — `id`
 * matches the MCP registry. `via: 'mcp'` = reached through an MCP server;
 * `'local'` = read from local files (not MCP). `status: 'soon'` → disabled card.
 */

export type ConnectorStatus = 'live' | 'soon';

export interface ConnectorDef {
  id: string;
  name: string;
  description: string;
  category: string;
  access: 'Read' | 'Read + Write';
  status: ConnectorStatus;
  via: 'mcp' | 'local';
  docs: string;
  icon: LucideIcon;
  /** Human-readable summary of what we read / can do — shown on the card. */
  scopes: string[];
  /** Connect method: 'oauth' (DCR+PKCE, default) or 'pat' (paste a token, e.g. GitHub). */
  connect?: 'oauth' | 'pat';
  /** For PAT connectors: where to create the token. */
  patUrl?: string;
}

export const CONNECTOR_CATEGORIES = ['Work tools', 'Google Workspace', 'Dev & AI'] as const;

export const CONNECTORS: ConnectorDef[] = [
  {
    id: 'jira', name: 'Jira', category: 'Work tools', access: 'Read + Write', status: 'live',
    via: 'mcp', docs: 'https://support.atlassian.com/atlassian-rovo-mcp-server/', icon: Ticket,
    description: 'Pull issues, comments and sprints into your brain — and turn meeting decisions into tickets.',
    scopes: ['Read issues & comments', 'Create / update issues'],
  },
  {
    id: 'github', name: 'GitHub', category: 'Work tools', access: 'Read + Write', status: 'live',
    via: 'mcp', docs: 'https://github.com/github/github-mcp-server', icon: Github,
    connect: 'pat', patUrl: 'https://github.com/settings/personal-access-tokens',
    description: 'Bring PRs, issues and discussions into context; open issues straight from a decision.',
    scopes: ['Read issues & PRs', 'Create issues & comments'],
  },
  {
    id: 'slack', name: 'Slack', category: 'Work tools', access: 'Read + Write', status: 'soon',
    via: 'mcp', docs: 'https://docs.slack.dev/ai/slack-mcp-server/', icon: Hash,
    description: 'Search channel context and post meeting follow-ups to the right channel.',
    scopes: ['Read messages', 'Post messages'],
  },
  {
    id: 'gmail', name: 'Gmail', category: 'Google Workspace', access: 'Read + Write', status: 'live',
    via: 'mcp', docs: 'https://developers.google.com/workspace/gmail/api/auth/scopes', icon: Mail,
    description: 'Search threads, read mail, and manage labels, drafts & trash — writes always ask first.',
    scopes: ['Read & search mail', 'Drafts, labels & trash'],
  },
  {
    id: 'gcal', name: 'Google Calendar', category: 'Google Workspace', access: 'Read + Write', status: 'live',
    via: 'mcp', docs: 'https://developers.google.com/workspace/calendar/api/auth', icon: Calendar,
    description: 'See your schedule, find free time, and create, update, respond to or delete events — writes always ask first.',
    scopes: ['Read events & free time', 'Create, update & delete events'],
  },
  {
    id: 'gdrive', name: 'Google Drive', category: 'Google Workspace', access: 'Read + Write', status: 'live',
    via: 'mcp', docs: 'https://developers.google.com/workspace/drive/api/guides/api-specific-auth', icon: HardDrive,
    description: 'Search, read & download files, plus copy and create — writes always ask first.',
    scopes: ['Read, search & download files', 'Copy & create files'],
  },
  {
    id: 'claude-code', name: 'Claude Code', category: 'Dev & AI', access: 'Read', status: 'live',
    via: 'local', docs: 'https://docs.claude.com/claude-code', icon: SquareTerminal,
    description: 'Bring your local Claude Code sessions in as engineering context.',
    scopes: ['Read local sessions'],
  },
  {
    id: 'codex', name: 'Codex', category: 'Dev & AI', access: 'Read', status: 'live',
    via: 'local', docs: 'https://platform.openai.com/docs', icon: Braces,
    description: 'Bring OpenAI Codex sessions in as additional context.',
    scopes: ['Read sessions'],
  },
];
