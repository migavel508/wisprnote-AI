import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';
import type { JiraActionProposal } from './jiraActionService';

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
  origin: string;
  source_meeting_id: string | null;
  source_title: string | null;
  rationale: string | null;
  proposal: JiraActionProposal;
  created_at: string;
}

async function authed(path: string, init: RequestInit = {}): Promise<Response> {
  const token = await getIdToken();
  return baseFetch(`${API_BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: token, ...(init.headers || {}) },
  });
}

export async function listProposals(workspaceId: string): Promise<ProposalRow[]> {
  try {
    const r = await authed(`/proposals?workspace=${encodeURIComponent(workspaceId)}`, { method: 'GET' });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.proposals) ? d.proposals : [];
  } catch {
    return [];
  }
}

export async function resolveProposal(id: string, status: 'executed' | 'dismissed', result?: unknown): Promise<void> {
  await authed(`/proposals/${encodeURIComponent(id)}/resolve`, {
    method: 'POST',
    body: JSON.stringify({ status, result }),
  }).catch(() => {});
}
