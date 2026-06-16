import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';

/**
 * Client for Jira WRITE actions (HITL). The chat/agent produces a proposal; the user
 * confirms an editable card; only then does `executeJiraAction` call the server, which
 * performs the single approved write via the Atlassian MCP. Tokens stay server-side.
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const baseFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

export type JiraOp = 'create' | 'update' | 'comment' | 'transition' | 'assign' | 'close';

export interface JiraActionProposal {
  operation: JiraOp;
  projectKey?: string;
  issueType?: string;        // Task | Bug | Story | Epic
  issueKey?: string;
  summary?: string;
  description?: string;
  assigneeName?: string;
  assigneeAccountId?: string;
  dueDate?: string;          // YYYY-MM-DD
  priority?: string;         // High | Medium | Low
  status?: string;
  comment?: string;
  labels?: string[];
}

export interface JiraMeta {
  connected: boolean;
  cloudId?: string;
  siteUrl?: string;
  projects: Array<{ key: string; name: string; issueTypes: string[] }>;
}

export interface JiraActionResult {
  ok: boolean;
  operation: JiraOp;
  issueKey?: string;
  url?: string;
  message: string;
  auditId?: string;
  undoable?: boolean;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken();
  return baseFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: token, ...(init.headers || {}) },
  });
}

/** Projects + issue types for the workspace's Jira, to populate the card dropdowns. */
export async function getJiraMeta(workspaceId: string): Promise<JiraMeta> {
  try {
    const r = await authed(`/connectors/jira/meta?workspace=${encodeURIComponent(workspaceId)}`, { method: 'GET' });
    if (!r.ok) return { connected: false, projects: [] };
    return await r.json();
  } catch {
    return { connected: false, projects: [] };
  }
}

/** Execute ONE approved write. Called only after the user confirms the card. */
export async function executeJiraAction(workspaceId: string, proposal: JiraActionProposal): Promise<JiraActionResult> {
  const r = await authed(`/connectors/jira/action?workspace=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    body: JSON.stringify(proposal),
  });
  if (!r.ok) return { ok: false, operation: proposal.operation, message: `Action failed (${r.status}).` };
  return await r.json();
}

// ── Generic MCP write (Confluence, worklog, issue links, Compass, …) via HITL ──
export interface McpWriteProposal {
  connector: string;
  tool: string;
  args: Record<string, unknown>;
  summary: string;
}

export interface McpWriteResult { ok: boolean; message: string; url?: string }

/** Execute one approved generic write (any Atlassian write tool). Called after approval. */
export async function executeMcpWrite(workspaceId: string, connector: string, tool: string, args: Record<string, unknown>): Promise<McpWriteResult> {
  const r = await authed(`/connectors/mcp-write?workspace=${encodeURIComponent(workspaceId)}`, {
    method: 'POST',
    body: JSON.stringify({ connector, tool, args }),
  });
  if (!r.ok) return { ok: false, message: `Action failed (${r.status}).` };
  return await r.json();
}

/** Undo a previously executed action via its audit id (runs the stored inverse). */
export async function undoJiraAction(workspaceId: string, auditId: string): Promise<JiraActionResult> {
  const r = await authed(`/connectors/jira/audit/${encodeURIComponent(auditId)}/rollback?workspace=${encodeURIComponent(workspaceId)}`, { method: 'POST' });
  if (!r.ok) return { ok: false, operation: 'update', message: `Undo failed (${r.status}).` };
  return await r.json();
}
