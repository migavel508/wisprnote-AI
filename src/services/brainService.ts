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

export interface BrainNode { id: string; kind: string; source: string; type: string; title: string; url: string | null }
export interface BrainLink { source: string; target: string; relation: string; origin: string }

export async function getBrainGraph(workspaceId: string): Promise<{ nodes: BrainNode[]; links: BrainLink[] }> {
  try {
    const token = await getIdToken();
    const r = await baseFetch(`${API_BASE}/brain/graph?workspace=${encodeURIComponent(workspaceId)}`, {
      headers: { 'Content-Type': 'application/json', Authorization: token },
    });
    if (!r.ok) return { nodes: [], links: [] };
    const d = await r.json();
    const nodes: BrainNode[] = Array.isArray(d.nodes) ? d.nodes : [];
    const ids = new Set(nodes.map((n) => n.id));
    // Keep only edges whose endpoints are present, so the graph renderer never breaks.
    const links: BrainLink[] = (Array.isArray(d.edges) ? d.edges : [])
      .map((e: any) => ({ source: `${e.src_kind}:${e.src_id}`, target: `${e.dst_kind}:${e.dst_id}`, relation: e.relation, origin: e.origin }))
      .filter((l: BrainLink) => ids.has(l.source) && ids.has(l.target));
    return { nodes, links };
  } catch {
    return { nodes: [], links: [] };
  }
}
