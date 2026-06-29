import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';

/**
 * Client for the unified BRAIN graph — nodes across all sources (meetings, Jira, GitHub)
 * + the cross-source association edges. Powers the brain-map visualization.
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const baseFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

export interface BrainNode { id: string; kind: string; source: string; type?: string; title: string; url?: string | null; status?: string | null }
export interface BrainLink { source: string; target: string; relation: string; origin: string; verdict?: string | null; rationale?: string | null }
export interface BrainEvent { kind: string; source: string; sourceId?: string | null; actor?: string | null; from?: string | null; to?: string | null; title?: string | null; at?: string | null }

export interface BrainConnection { id: string; title: string; source: string; type?: string; url?: string | null; relation: string; origin: string; direction: 'in' | 'out'; verdict?: string | null; rationale?: string | null }
export interface BrainNodeDetail {
  node: { id: string; source: string; type?: string; title: string; summary?: string | null; body?: string | null; people?: any; url?: string | null; sourceId?: string; occurredAt?: string | null; status?: string | null; advisoryAssessment?: string | null; advisoryNote?: string | null };
  connections: BrainConnection[];
  events?: Array<{ kind: string; actor?: string | null; from?: string | null; to?: string | null; at?: string | null }>;
}

/** On-demand freshness: pull this workspace's latest backend state into the brain NOW. */
export async function syncBrain(workspaceId: string, spaceId?: string | null, linkOnly = false): Promise<{ syncedAt: string } | null> {
  try {
    const token = await getIdToken();
    const sq = spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const lq = linkOnly ? '&link=1' : '';
    const r = await baseFetch(`${API_BASE}/brain/sync?workspace=${encodeURIComponent(workspaceId)}${sq}${lq}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export interface BrainProgress {
  graph: { total: number; processed: number; pending: number };
  suggestions: { total: number; processed: number; pending: number };
  pct: number;
  processing: boolean;
}

/** Brain BUILD progress (how many meetings/connector nodes are linked + reasoned). Drives the
 *  progress bar so the user sees the brain evolving and knows nothing is left unprocessed. */
export async function getBrainProgress(workspaceId: string, spaceId?: string | null): Promise<BrainProgress | null> {
  try {
    const token = await getIdToken();
    const sq = spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const r = await baseFetch(`${API_BASE}/brain/progress?workspace=${encodeURIComponent(workspaceId)}${sq}`, {
      headers: { Authorization: token },
    });
    if (!r.ok) return null;
    return await r.json();
  } catch { return null; }
}

export interface BrainAlert { type: string; severity: string; title: string; detail?: string; intent?: string; url?: string | null }

export async function getBrainAlerts(workspaceId: string, folderId?: string | null, spaceId?: string | null): Promise<BrainAlert[]> {
  try {
    const token = await getIdToken();
    const fq = folderId ? `&folder=${encodeURIComponent(folderId)}` : spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const r = await baseFetch(`${API_BASE}/brain/alerts?workspace=${encodeURIComponent(workspaceId)}${fq}`, {
      headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.alerts) ? d.alerts : [];
  } catch { return []; }
}

export async function getBrainPulse(workspaceId: string, folderId?: string | null, spaceId?: string | null): Promise<BrainEvent[]> {
  try {
    const token = await getIdToken();
    const fq = folderId ? `&folder=${encodeURIComponent(folderId)}` : spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const r = await baseFetch(`${API_BASE}/brain/pulse?workspace=${encodeURIComponent(workspaceId)}${fq}`, {
      headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (!r.ok) return [];
    const d = await r.json();
    return Array.isArray(d.events) ? d.events : [];
  } catch { return []; }
}

export async function getBrainNode(workspaceId: string, id: string, spaceId?: string | null): Promise<BrainNodeDetail | null> {
  try {
    const token = await getIdToken();
    const sq = spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const r = await baseFetch(`${API_BASE}/brain/node?workspace=${encodeURIComponent(workspaceId)}&id=${encodeURIComponent(id)}${sq}`, {
      headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (!r.ok) return null;
    const d = await r.json();
    if (!d?.node) return null;
    return { node: d.node, connections: Array.isArray(d.connections) ? d.connections : [], events: Array.isArray(d.events) ? d.events : [] };
  } catch {
    return null;
  }
}

/** `folderId` scopes to one project, else `spaceId` scopes to one space; omit both for the
 *  whole-workspace aggregate. Folder takes precedence over space. */
export async function getBrainGraph(workspaceId: string, folderId?: string | null, spaceId?: string | null): Promise<{ nodes: BrainNode[]; links: BrainLink[] }> {
  try {
    const token = await getIdToken();
    const fq = folderId ? `&folder=${encodeURIComponent(folderId)}` : spaceId ? `&space=${encodeURIComponent(spaceId)}` : '';
    const r = await baseFetch(`${API_BASE}/brain/graph?workspace=${encodeURIComponent(workspaceId)}${fq}`, {
      headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (!r.ok) return { nodes: [], links: [] };
    const d = await r.json();
    const nodes: BrainNode[] = Array.isArray(d.nodes) ? d.nodes : [];
    const ids = new Set(nodes.map((n) => n.id));
    // Keep only edges whose endpoints are present, so the graph renderer never breaks.
    const links: BrainLink[] = (Array.isArray(d.edges) ? d.edges : [])
      .map((e: any) => ({ source: `${e.src_kind}:${e.src_id}`, target: `${e.dst_kind}:${e.dst_id}`, relation: e.relation, origin: e.origin, verdict: e.verdict ?? null, rationale: e.rationale ?? null }))
      .filter((l: BrainLink) => ids.has(l.source) && ids.has(l.target));
    return { nodes, links };
  } catch {
    return { nodes: [], links: [] };
  }
}
