# Space Isolation Audit — Cross-Space Data Leak

> **Ask:** strict per-space isolation. A connector (and everything derived from it — items, brain map,
> activity, agent suggestions) must live ONLY in the space that explicitly authorized it. Today a set
> of Jira tasks scoped to one space duplicated into another space after a meeting. This audits *why*,
> then proposes the architecture to make space a hard boundary. **No code changed.**
>
> Evidence cited as `file:line` from the live code (2026-06-28).

---

## 1. The intended model (the contract that's being violated)

- An **integration is authorized per `(workspace, space)`** — its token is stored that way:
  `connector_credentials` PK = `(user_id, workspace_id, space_id, source)` (`trust/broker.ts:29`).
- Every derived row carries a `space_id`: `knowledge_item`, `brain_edge`, `brain_event`,
  `action_proposal`, `task_history`.
- **The contract should be:** a connector item / edge / event / suggestion is owned by *exactly one*
  `(workspace, space)` — the space of the **authorizing credential** — and nothing crosses that line
  unless the user explicitly connects the integration in the other space.

The foundation is right. The violations are in five subsystems that reach **across** the boundary.

---

## 2. Current architecture — where the boundary breaks

### 🔴 A. Authorization: the token falls back to *any* space in the workspace
`trust/broker.ts:44–55` — `getToken(user, workspace, space, source)` first looks for the exact
`(workspace, space)` credential, but if none exists it **falls back** to:
```
SELECT token … WHERE user_id AND workspace_id AND source ORDER BY updated_at DESC LIMIT 1
```
→ **a space with no Jira connection silently borrows another space's Jira token.** This is the literal
"the system accesses a connection the user didn't authorize for that space." Every read/action that
resolves a token for space B can end up using space A's authorization.

### 🔴 B. Linking: brainLink groups by **workspace**, so it links **across spaces**
`connectors/brainLink.ts:133–144` — it iterates `DISTINCT (user_id, workspace_id)` and loads
`knowledge_item WHERE user_id AND workspace_id` (the **whole workspace**, every space). It then forms
`brain_edge`s between any items it judges related — so a **meeting in space B** gets an edge to a
**Jira issue in space A / sentinel**. Cross-space edges are the trigger for the duplication in (C).

### 🔴 C. Scoping "repair": backfill RE-HOMES connector items into a linked meeting's space
`spaces.ts:245–258` (`backfillSpaceScoping`, step 1) — *"follow the linked meeting"*:
```
UPDATE knowledge_item ki SET space_id = m.space_id   -- m = a meeting linked via brain_edge
 WHERE ki.source <> 'meeting' AND (ki.space_id = SENTINEL OR ki.space_id = default-space)
   AND ki.id IN (e.src_id, e.dst_id)                 -- ki is edge-linked to that meeting
```
A Jira issue sitting at the sentinel/default space, once a meeting in space B links to it (via B),
is **moved into space B** — a space that never connected Jira. Runs at bootstrap **and on every brain
sync** (`index.ts:975`). This is the exact "duplicated into another space after a meeting" you saw.

### 🔴 D. Orphan reclaim moves connector data across **workspaces**
`spaces.ts:177–216` (`reclaimOrphanConnectorData`) — moves `knowledge_item / brain_edge / brain_event /
action_proposal / connector_credentials` whose `workspace_id` isn't a current workspace into the
**default** workspace. Useful for recovery, but it mixes provenance and, with (C), spreads connector
items into spaces by meeting-link rather than by authorization. (It's also why the same issue exists
under two `workspace_id`s — the "drift" — e.g. PROJ-7 under `7a2ddf96` *and* `879647b1`.)

### 🔴 E. Suggestion generators reach across spaces
- **Reconcile** (`connectors/jira/reconcile.ts:36–58`): iterates credentials by `(user, workspace)`
  **only** (not space) and queries `knowledge_item … WHERE workspace_id` — proposes for the **whole
  workspace**, so a space with no Jira gets Jira suggestions.
- **Reasoner** (`connectors/suggestionReasoner.ts`): meetings are space-scoped (good, `:152`), but the
  *existing Jira* it diffs against is **workspace-scoped** (`:171 WHERE workspace_id … source='jira'`),
  and the target `projectKey` is resolved at **workspace** level (`resolveProjectKey`) — so it can
  propose into a project that belongs to a *different* space's connection.
- **Agent** (`connectors/jira/agent.ts`): per-space meetings now, but still resolves the project key at
  workspace level.

### 🟢 F. Reads are *mostly* space-scoped — but they faithfully render the leaked data
Brain map graph/node/alerts scope by `space_id` (`index.ts` graph/node/alerts), and `getEvents` was
just fixed to scope by the stable `space_id` (`connectors/brainEvents.ts`). These are correct — but
because the **write side (A–E)** already copied/re-homed items into the wrong spaces, a correctly
space-scoped read still shows another space's Jira. (My recent "freshest-status across copies" fix in
graph/node is a **band-aid** for the duplication — it deliberately reads across spaces for status and
should be retired once duplication is eliminated.)

### The concrete trace (your PROJ-7)
Jira authorized in spaces `ebf64c10` + `d75c7852` → sync writes a correct row in each. A meeting in
space `02518268` linked to PROJ-7 (B, workspace-grouped brainLink) → the sentinel/default PROJ-7
copy was **re-homed into `02518268`** (C) → PROJ-7 now appears in a space that never connected Jira,
stale. Three rows, one issue, two of them illegitimate.

---

## 3. Current vs. proposed (per subsystem)

| Subsystem | Current (leaks) | Proposed (strict space) |
|---|---|---|
| **Authorization** | Token falls back to any space in the workspace (`broker.ts:50`) | **No fallback.** `getToken(space)` returns a token **only** for that exact `(workspace, space)`; else "not connected here." |
| **Ingestion/sync** | Per-connected-space upsert (correct) **+** backfill re-homes copies | Item's `space_id` = **the authorizing credential's space, only**. One row per `(space, source, source_id)` for each space that *connected* it. |
| **Linking** | brainLink groups by workspace → cross-space edges (`brainLink.ts:133`) | brainLink groups by **`(workspace, space)`**; candidates restricted to the **same space**. No cross-space edges. |
| **Scoping repair** | "Follow the linked meeting" moves connector items into meeting's space (`spaces.ts:245`) | **Remove** the re-home. Repair only fills `NULL → connecting space`; **never** moves a connector item to a meeting's space. |
| **Orphan reclaim** | Cross-workspace move into default (`spaces.ts:177`) | Keep recovery, but **preserve `(workspace, space)`**; never merge a connector item into a space that didn't authorize it. Fix the workspace-id drift as a one-time migration, not an ongoing mover. |
| **Suggestions: reconcile** | Per `(user, workspace)`, workspace-wide queries (`reconcile.ts:36`) | Per **`(user, workspace, space)`**; all detector queries filter `space_id`; only spaces with a Jira credential are processed. |
| **Suggestions: reasoner/agent** | Existing-Jira + projectKey resolved at workspace level | Existing-Jira scoped to the **space**; project key from **that space's** credential. No connection in the space → no suggestions for that connector. |
| **Reads (brain map/activity)** | Space-scoped, but show leaked data; freshest-status reads across copies | Stay space-scoped; **retire** the cross-copy status band-aid once duplication is gone. |

---

## 4. Proposed architecture — one rule, enforced everywhere

**The scope contract:** *every connector-derived row (item, edge, event, suggestion) is owned by
exactly one `(workspace, space)` — the space of the credential that authorized the integration — and
no code path may read, write, link, or act outside that pair without the user connecting the
integration in that space.*

Concretely:

1. **Authorization is the only source of scope.** A connector item exists in space S **iff** there is
   a `connector_credentials` row for `(workspace, S, source)`. Remove the broker token fallback (A).
2. **One enforcement chokepoint.** A single `assertSpaceConnection(user, workspace, space, source)`
   that every sync / read / suggestion / action calls. No subsystem resolves a connection any other way.
3. **Derivation never changes ownership.** Linking, backfill, and reclaim may *fill* a missing scope
   from the authorizing credential, but may **never** move a connector item to a meeting's space (C),
   nor link items across spaces (B). Cross-space "this relates to that" is out of scope (or a future,
   explicit, read-only feature — never a data mutation).
4. **Generators are space-local.** Reconcile / reasoner / agent iterate `(workspace, space)` credentials
   and query strictly by `space_id`; a space with no credential produces nothing for that connector.
5. **Reads stay strict** (already true) and the freshest-status cross-copy band-aid is removed once the
   data is clean.

---

## 5. Remediation plan (phased)

- **P0 — Stop the bleeding (code, no data change). ✅ IMPLEMENTED (built, pending deploy).**
  - **A** — `trust/broker.ts:getToken`: cross-space token fallback now fires **only** for account-level
    callers (`spaceId === ACCOUNT_SCOPE`). A real space never borrows another space's token.
  - **B** — `connectors/brainEdges.ts:insertEdge`: refuses an edge between two items in **different real
    spaces** (single chokepoint — kills cross-space linking regardless of how candidates are generated).
  - **C** — `spaces.ts:backfillSpaceScoping`: removed step-1 "follow the linked meeting" re-home of
    connector items. A connector item's space is owned solely by its credential (set at sync).
  - **E** — `connectors/jira/reconcile.ts`: now iterates `(user, workspace, space)` and every detector
    filters `space_id`; `connectors/suggestionReasoner.ts`: existing-Jira diff scoped to the space.
  - **Deferred to P0.5** (coordinated signature change, done with care): thread `space` through
    `jiraMeta` / `jira.context` / `resolveMcpConnection` so a space's **project key + write token** come
    only from *that space's* connection. Today these resolve at workspace level; the broker fix means a
    real space won't borrow a token, but the account-level meta lookups still pick a workspace
    connection. Low blast radius (affects project-key choice, not which space data lands in).
  - *After P0, no NEW cross-space duplication can occur.*
- **P1 — Clean up the leaked data (one-time migration).** Delete connector `knowledge_item` rows whose
  `space_id` has **no** matching `connector_credentials` row for that source (the illegitimate copies);
  consolidate the `workspace_id` drift (`7a2ddf96 → 879647b1`); drop now-orphaned `brain_edge` /
  `brain_event` / `action_proposal`. Idempotent, dry-run first (report counts), reversible by backup.
- **P2 — Guardrails.** A scope-integrity check (cron/probe) that flags any connector row in a space
  without a matching credential; retire the freshest-status band-aid; add a test that a connection in
  space A is invisible/unusable in space B.

---

## 6. What this fixes (your acceptance criteria)
- ✅ A Jira task scoped to one space **cannot** appear in another after a meeting (C, B removed).
- ✅ The system **only** uses connections the user explicitly authorized **in that space** (A removed +
  single chokepoint).
- ✅ Brain map, activity, suggestions, and tools are all derived from the *same* per-space authorization
  — no subsystem reaches across the boundary.

> Recommendation: do **P0 first** (stops all new leakage, low risk), verify a connection in space A is
> invisible in space B, then run the **P1** cleanup migration (dry-run → apply) to remove the existing
> duplicates. **P0 is code-only and safe; P1 deletes data, so it ships behind an explicit "yes, migrate"
> with a dry-run report first.**
