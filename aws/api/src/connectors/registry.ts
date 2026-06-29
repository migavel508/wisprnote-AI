/**
 * Connector framework. A connector is a thin adapter that pulls a tool's data into
 * `knowledge_item` (and, later, executes actions). Sync is server-side, driven by
 * the `connector-sync` job (the kgSweep pattern). Connectors are MCP-based: their
 * `sync()` calls the tool's MCP server (see `../mcp/registry.ts` + `../mcp/client.ts`)
 * authed by the broker — they don't hand-roll vendor REST clients.
 */

export interface KnowledgeItemInput {
  source: string;          // 'jira' | 'github' | ...  (matches the connector id)
  source_id: string;       // 'PROJ-123', message id, …
  type: string;            // 'issue' | 'email' | 'comment' | ...
  title?: string;
  body?: string;
  people?: unknown;
  links?: unknown;
  raw: unknown;            // full original payload — never lose data
  occurred_at?: string | null;
  status?: string | null;  // live backend state (Jira status name / GitHub PR state); drives events
  actor?: string | null;   // who currently owns/authored it (assignee / commit author) — for events
  /** Observed HISTORICAL state transitions (from the source's changelog), oldest→newest. Recorded
      as brain_events on upsert (idempotent) so the Activity feed shows full history, not just the
      delta between two syncs. */
  events?: Array<{ kind: 'status_change'; fromState?: string | null; toState: string; actor?: string | null; occurredAt: string }>;
}

/** One bounded page of a sync; the engine loops/advances the cursor across ticks. */
export interface SyncPage {
  items: KnowledgeItemInput[];
  nextCursor: string | null;   // null = caught up
}

export interface Connector {
  id: string;
  /** Pull one bounded page for a user/scope from `cursor` (null = first/backfill). */
  sync(userId: string, scope: string, cursor: string | null): Promise<SyncPage>;
}

const REGISTRY = new Map<string, Connector>();

export function registerConnector(c: Connector): void { REGISTRY.set(c.id, c); }
export function getConnector(id: string): Connector | undefined { return REGISTRY.get(id); }
export function listConnectorIds(): string[] { return [...REGISTRY.keys()]; }

// No-op connector — exercises the whole loop (register → sync → upsert) end-to-end
// without any external dependency. Real connectors (Jira, …) register in Phase 1.
registerConnector({
  id: 'noop',
  async sync() { return { items: [], nextCursor: null }; },
});
