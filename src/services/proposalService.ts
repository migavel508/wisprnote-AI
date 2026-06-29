import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';
import type { JiraActionProposal, McpWriteProposal } from './jiraActionService';

/**
 * Client for the autonomous agent's HITL proposal queue. The agent proposes Jira
 * actions from workspace meetings; these surface here for the human to approve
 * (which executes via the Jira action route) or dismiss. Nothing auto-executes.
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const baseFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

export interface ProposalRow {
  id: string;
  workspace_id: string;
  space_id?: string;
  /** Target connector: 'jira' (default) | 'github' | 'slack' | … | a custom-connector id. */
  kind: string;
  origin: string;
  source_meeting_id: string | null;
  source_title: string | null;
  rationale: string | null;
  /** A JiraActionProposal when kind==='jira', else a generic McpWriteProposal {connector,tool,args}. */
  proposal: JiraActionProposal | McpWriteProposal;
  created_at: string;
  confidence?: number | null;   // critic confidence 0–1 (P4)
  score?: number | null;        // ranking score (P4)
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken();
  return baseFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: token, ...(init.headers || {}) },
  });
}

export interface SuggestionCoverage { reasoned: number; total: number }

/** Pending proposals + how many of the workspace's meetings the engine has reasoned over. */
export async function listSuggestions(workspaceId: string, spaceId?: string | null): Promise<{ proposals: ProposalRow[]; coverage: SuggestionCoverage }> {
  const empty = { proposals: [] as ProposalRow[], coverage: { reasoned: 0, total: 0 } };
  try {
    const sq = spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const r = await authed(`/proposals?workspace=${encodeURIComponent(workspaceId)}${sq}`, { method: 'GET' });
    if (!r.ok) return empty;
    const d = await r.json();
    return { proposals: Array.isArray(d.proposals) ? d.proposals : [], coverage: d.coverage || { reasoned: 0, total: 0 } };
  } catch {
    return empty;
  }
}

export async function listProposals(workspaceId: string, spaceId?: string | null): Promise<ProposalRow[]> {
  return (await listSuggestions(workspaceId, spaceId)).proposals;
}

export async function resolveProposal(id: string, status: 'executed' | 'dismissed', result?: unknown): Promise<void> {
  await authed(`/proposals/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ status, result }),
  }).catch(() => {});
}
