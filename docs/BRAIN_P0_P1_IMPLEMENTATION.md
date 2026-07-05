# Brain P0 + P1 — File-Level Implementation Plan

> Concrete build plan for the two foundation phases from `BRAIN_ARCHITECTURE_PLAN.md`:
> **P0 — the space-keyed, membership-shared brain** and **P1 — bind at ingestion (claims → edges)**.
> Grounded in the current code (2026-06-29). Each step is independently shippable, non-breaking,
> and verifiable with the diagnostics we already have (`brain-map-debug`, `space-leak-report`).
> Plan only — no code written yet.

---

## Guiding invariants (must hold after every step)
1. **Strict space isolation stays** (the leak fix): a space's brain contains only items synced by
   that space's authorized connectors + that space's meetings.
2. **Membership, not ownership, gates reads**: any member of space S sees S's full brain.
3. **No orphans**: an item with any provenance/entity claim is never shown "no links yet".
4. **Deterministic BIND is $0**: claims→edges uses no LLM; LLM is refinement only.
5. **Backfillable + reversible**: every schema change is additive; every rebuild is a job.

---

## Current state (the three facts this plan turns on)
- `space_members (space_id, email)` PK exists (`spaces.ts:31`) but the brain **never reads it**.
- Brain reads (`handleBrain`, `index.ts:1402`; `getBrainEdges`, `brainEdges.ts`) scope by
  `user_id + workspace_id + space_id` → **per-user brains**.
- Meeting claims already exist in `knowledge_graph` (topics/decisions/people/action_items/refs,
  written by `kgSweep.ts:57`) — but `brainLink` ignores them and re-derives from embeddings.

---

# P0 — Space-keyed brain + membership reads

**Goal:** two users in one space see one shared brain; a non-member is denied; single-user spaces
behave identically. No write-path change — only *scope of reads* + *access gate*.

### P0.1 — Membership resolver (`spaces.ts`)
Add:
```
export async function canAccessSpace(userId, userEmail, spaceId): Promise<boolean>
```
Logic: true if the requester **owns** the space (`SELECT 1 FROM spaces WHERE id=$1 AND user_id=$2`)
OR their email ∈ `space_members` (`SELECT 1 FROM space_members WHERE space_id=$1 AND lower(email)=lower($2)`).
Also add `spaceMemberUserIds(spaceId): Promise<string[]>` (owner + members resolved to user_ids via
the users/cognito email→id mapping) for the read scoping below. Cache per request.

### P0.2 — Gate + re-scope the brain read endpoints (`index.ts handleBrain`)
Every `GET /brain/*` (graph, edges, node, pulse, alerts, progress) currently takes `userId` and a
`space` query param and scopes by `user_id`. Change to:
1. **Gate:** `if (space && !(await canAccessSpace(userId, getUserEmail(), space))) return 403`.
2. **Re-scope:** pass the **space** as the owning scope to the read helpers; drop the `user_id`
   filter (space_id is globally unique, so it already isolates the tenant — verified by the
   `brain-map-debug` job which queries by space_id alone).

### P0.3 — Read helpers scope by space, not user (`brainEdges.ts`, `brainEvents.ts`, `index.ts` graph/node)
- `getBrainEdges` / `neighboursOf` (`brainEdges.ts`): change `WHERE user_id=$1 AND workspace_id=$2
  AND ($3 IS NULL OR space_id=$3)` → `WHERE space_id=$1` (space required for a space view; keep the
  workspace-root path for the "all projects" view, gated by workspace ownership).
- `getEvents` (`brainEvents.ts`): already space-stable; drop the `user_id` predicate when a real
  space is given (space_id is the tenant key).
- `/brain/graph` + `/brain/node` (`index.ts`): the node/edge/status queries scope by `space_id`;
  keep the existing `DISTINCT ON (source, source_id, …)` dedup — now doubly important because a
  shared space may have the same Jira issue synced by two members (two `knowledge_item` rows).
  Node identity in the map becomes **`(source, source_id)`**, not `item_id`.

### P0.4 — Writes keep `user_id` as provenance (no change, documented)
Ingest/sync/link keep writing `user_id` = who brought the item. It is now **provenance, not the
boundary**. `knowledge_item`'s unique key `(user_id, workspace_id, source, source_id, type)` stays
for P0 (per-member identity); shared-space cross-member duplicates are collapsed at *read* by the
DISTINCT-ON dedup, and permanently merged in P4 consolidation.

### P0.5 — Schema: additive indexes only (`schema.ts`)
Add space-first indexes so space-scoped reads are fast:
`CREATE INDEX … ON knowledge_item (space_id, source, source_id)`,
`… ON brain_edge (space_id, created_at DESC)`,
`… ON brain_event (space_id, occurred_at DESC)` (some exist; add the missing ones). No PK change.

### P0 migration + acceptance
- **Backfill:** none needed — data already carries `space_id` (post-leak-fix). Just deploy.
- **Verify:** add a temp `space-brain-check` diagnostic: given a spaceId, return edge/node counts
  by scoping (space_id) vs the old (user_id+space) — they should match for single-user spaces.
- **Accept:** (a) member A and member B of the same space get identical `/brain/graph`; (b) a
  non-member gets 403; (c) an existing single-user space is byte-identical to before.

---

# P1 — Bind at ingestion (claims → edges)

**Goal:** the claims `kgExtract` already produces become edges the moment a meeting is understood,
deterministically and LLM-free; semantic similarity is demoted to a weak, capped prior. Result:
no orphan meetings, explainable links, and roughly half the LLM spend.

### P1.1 — New deterministic binder (`connectors/brainBind.ts`)
```
export async function bindMeeting(userId, workspaceId, spaceId, meetingTaskId): Promise<BindResult>
```
Reads the meeting's `knowledge_graph` row + the space's `knowledge_item` index, and emits edges via
the existing `insertEdge` (which already enforces same-space — the leak guard). Signal hierarchy,
each with a fixed origin + confidence, **highest wins, no LLM**:

| Claim source (already in `knowledge_graph`) | Edge produced | origin | conf |
|---|---|---|---|
| `action_items` matched to a Jira issue (title/text or via executed `action_proposal`) | meeting → jira | `provenance`/`claim` | 1.0 / 0.9 |
| `refs` mentioning a ticket key / repo / url | meeting → that item | `reference` | 0.9 |
| `people` shared with another item (assignee/author/participant) | meeting ↔ item | `entity` | 0.75 |
| topic/decision text ↔ item (only if none of the above) | meeting → item | `semantic` | ANN, capped |

Reuse the existing `JIRA_KEY` regex + `byKey` index from `brainLink.ts`; add a **people index**
(`Map<normalizedPerson, itemId[]>` from `knowledge_item.people` + `knowledge_graph.people`).

### P1.2 — Rewire `brainLink.ts` to BIND-first, semantic-last
- Extract the current provenance + reference blocks into `brainBind.ts` and call `bindMeeting`
  for each fresh meeting **before** the semantic/verdict path.
- Track pairs already bound (a `Set<targetId>`), and make the semantic connectivity fallback (the
  0.40-floor block we added) fire **only for items with zero claim/entity edges** — semantic
  becomes the safety net for genuinely-unrelated items, not the backbone.
- The LLM verdict stays as **REFINE**: it only *colours* (aligned/partial/divergent) edges that
  BIND already created; it never creates the primary association. (Already budget-gated + best-
  effort after the last change — keep.)

### P1.3 — Connector items bind on the same path
A connector item's `entities()` are already partly available: commit messages parsed for
`SCRUM-3` (reference), assignee/author (people). Extend `bindMeeting`'s inverse — when a connector
item lands, bind it to meetings/tickets sharing its ticket-key/people/repo. Formalize a tiny
per-connector contract: `entities(item) → { ticketKeys[], people[], urls[], repo? }` (Jira/GitHub
implement it; Slack/Gmail/Calendar slot in later with zero brain-core change).

### P1.4 — Backfill job (reuse existing infra)
Add `__job:'brain-bind'` (spaceId, commit): runs `bindMeeting` over every meeting in the space +
`entities`-binds every connector item. Idempotent (insertEdge dedups). This replaces the
expensive semantic re-link for the initial build — it's $0 and fast (no embeddings, no verdict).
Pair with the existing `brain-edge-cleanup allEdges` to rebuild a space cleanly from claims.

### P1 acceptance (measured with `brain-map-debug`)
- The auto-suggested-ticket case (SCRUM-13 ← "Helix AI Project Scope Planning") links with
  origin `provenance`/`claim` **at ingest**, not "no links yet".
- Edge composition flips from **semantic-dominated → claim-dominated** (`brain-map-debug` shows
  provenance/reference/entity ≫ semantic).
- LLM calls per newly-ingested meeting drop toward **zero for association** (verdict optional).
- No meeting with ≥1 claim is isolated.

---

## Sequencing, risk, and rollout
- **Build order:** P0.1→P0.2→P0.3 (deploy, verify shared read) → P0.5 indexes → then P1.1→P1.2
  (deploy) → P1.4 backfill one space (POZ) → verify composition → roll to all.
- **Risk — cross-user exposure:** re-scoping reads to `space_id` is safe *only* if the membership
  gate (P0.2) is strict; the space-isolation guards we built (broker no-fallback, `insertEdge`
  same-space, per-space credentials) are the write-side backstop. Add a test: member of A cannot
  read B.
- **Risk — shared-space duplicate items:** two members syncing the same Jira issue → two rows;
  handled at read by DISTINCT-ON `(source, source_id)` in P0; permanently merged in P4.
- **Risk — `knowledge_graph` ownership:** a meeting's kg row is keyed `(user_id, task_id)`; bind
  reads it by `task_id` regardless of requester (it's the space's meeting) — confirm the join
  uses `task_id`, not the requester's `user_id`.
- **Cost:** P1 *reduces* spend (BIND is deterministic); it directly mitigates the credit fragility
  that flatlined the brain. Extraction remains the one LLM call per meeting — the prime
  fine-tuning candidate (see the fine-tuning note) to drive that cost down too.
- **Reversibility:** P0 is read-scope + a gate (revert = restore the user_id filter). P1 adds a
  module + reorders brainLink (revert = call order); no destructive schema change in either.

## Definition of done for the foundation
Two teammates open the same space and see one identical, live brain; a new meeting or a newly
connected tool weaves into it within seconds via explainable claim-edges (not guesses); nothing
shows "still associating" when a real signal exists; and the association layer costs ~$0, leaving
the LLM budget for understanding + refinement. That is the platform P2–P5 build the thread ledger,
consolidation, and enterprise governance on.
