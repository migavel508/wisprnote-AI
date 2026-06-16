# The Company Brain — Decisions → Action, safely (design)

> Design source-of-truth for turning Wisprnote from "records + recalls" into a
> brain that **acts** — turning settled meeting decisions into real, assigned work
> in connected tools (Jira first), **without acting prematurely or at runaway cost**.
> Companion to CLAUDE.md (vision) and IMPLEMENTATION_PLAN.md (execution). Planning
> doc — built in phases, each non-breaking, nothing writes without human approval.

## 1. Mental model: one brain per workspace, many senses
It is **not** a Jira brain + a meeting brain. Each **workspace** has **one brain**
whose `knowledge_item` store + decision ledger + conviction engine are fed by every
connected sense — meetings + Jira today, GitHub/Slack/Gmail next. Each new connector
adds a sense (and eventually a pair of hands). Multi-company users get clean
isolation: one brain per workspace.

## 2. Workspace scoping + adaptive org → Jira routing
The brain must adapt to however a company organizes itself — never impose a shape.
- Connections + ingestion are **workspace-scoped**: `connector_credentials` and
  `knowledge_item` carry `workspace_id`; a Jira connected in Workspace A only sees
  A's meetings; chat/actions are scoped to the active workspace.
- **Routing map** `(workspace_id, folder_id?, source) → jira_project_key` handles all
  shapes: one workspace→one project · folders-per-client→project-per-folder · one
  workspace-per-client→its own project. (`folders`/`task_folders` are the folder unit.)
- **Adaptive, not hardcoded:** auto-suggest the mapping by semantically matching the
  workspace/folder name to the customer's Jira projects (`getVisibleJiraProjects`),
  confirm once, remember. No mapping yet → the approval card asks + offers to save it.

## 3. People directory → email → Jira assignee
- People records gain **`email`**, surfaced in the People section (sourced from
  `workspace_members` / attendees / light manual entry). Workspace-scoped, sensitive
  — never in the client bundle, same discipline as tokens.
- **Assignee resolution chain:** meeting name → person (fuzzy `namesMatch`, the
  existing resolver) → that person's **email** → Jira **accountId**.
  - Jira assigns by **accountId**, not email (Atlassian privacy). The MCP exposes
    **`lookupJiraAccountId`** (name/email → accountId); cache the accountId on the
    person record (one-time lookup).
- Default-assign from this match, **always editable** before the issue is created.

## 4. The conviction layer (patience before action) — the moat
The brain must **accumulate conviction across meetings** and act only when a decision
is genuinely *settled*. Acting on a single meeting's signal is both unsafe (reversals
erode trust) and expensive at scale.

- **Decision thread** = a canonical question/decision tracked ACROSS meetings (stitched
  via the `kg_edges` continuation/resolution/escalation/recurring relationships we
  already compute), with a timeline of states.
- **State machine:** `surfaced → debated → tentative → settled → proposed → executed`
  (+ `reversed`, `stale`).
- **Conviction score** gates promotion, from: consistency of agreement across meetings
  (oscillation keeps it low), recency + a settling window (hold across ≥2 meetings or
  ≥N days), no recent reversal, decider authority/quorum, explicitness ("we decided"
  vs "maybe").
- Worked example (the design constraint): disagree(m1) → disagree(m2) → agree(m3) =
  low conviction (one agreement after two disagreements) → **wait**. m4 confirms →
  conviction crosses threshold → eligible to propose. Never acts on the flip alone.
- **Change-triggered, not meeting-triggered:** cheap deterministic matching/state-diff
  runs every meeting; the expensive LLM "is this settled, draft the action" runs ONLY
  when a thread's state materially changes.

## 5. Action flow (gated, end-to-end)
```
meetings + Jira → knowledge_item → decision threads (lineage)
  → conviction engine (settled? stable? not reversed?)        [change-triggered]
  → resolve routing (workspace/folder → Jira project) + assignee (name → email → accountId)
  → dedup vs LIVE Jira (issue already exists? → propose update/comment, not a dupe)
  → PROPOSAL card (editable: project · assignee · title/desc/type/priority/due · why)
  → human approves → execute via Jira MCP write tools (createJiraIssue / transition / comment)
  → audit ledger + link knowledge_item ↔ Jira issue → reflect back into the brain
```
We already have the read data (for dedup), the MCP write tools, KG extraction, and the
connector/broker/sync rails. New: workspace scoping, routing map, decision-thread
ledger, conviction engine, the editable approval card.

## 6. Cost architecture (wisdom = savings)
- **Cheap-before-expensive:** deterministic match + state-diff every meeting; LLM
  reasoning only on material state change.
- **Coalesce/debounce:** one evaluation per thread per change, not per mention.
- **Per-workspace action/reasoning budget** (ties to the cost-control work; per-account
  breaker as backstop).
- Patience itself avoids create-then-revert churn — the costliest failure mode.

## 7. Principles / risks
- **Default-but-confirm:** auto-suggest routing + assignee aggressively; surface for one
  confirmation, then remember. Ambiguity (two "Alex"es) resolved in the card, not silently.
- **Never auto-write first.** Settled → propose → human approves. Earn trust before any
  autonomy; only the lowest-risk tier ever auto-executes later, per policy.
- **Bias to patience.** A slightly-too-patient brain is trustworthy; a too-eager one is a
  liability. Tune thresholds conservatively on real data.
- Decision *identity* (same thread as last week?) and reversal detection are the hard,
  fuzzy parts — invest there.

## 8. Build order (each shippable, non-breaking)
1. ✅ **Workspace-scope connectors + ingestion** — `workspace_id` on `connector_credentials`/`knowledge_item`/`oauth_state` (sentinel `ACCOUNT_SCOPE` default; `sync_state.scope` = `workspace_id`). Broker/sync/routes/`connectorService` thread `workspaceId`; Connectors tab has a workspace selector. Migration backfills legacy rows to each user's **default (earliest) workspace** before `NOT NULL` (live Jira connection preserved). Deployed + verified (`connector-sync` → sources:1/processed:4/errors:0).
2. ✅ **People directory + email** — `people_directory` (user_id,name,email,jira_account_id); `POST /contacts` upsert + `GET /contacts` LEFT JOIN; PeoplePage inline email editor. Basis for assignee resolution.
3. ✅ **Jira in chat** (per workspace) — `chatAgent` pulls `knowledge_item` (workspace-scoped) into evidence so chat lists/uses connected Jira. (SQL retrieval today; Turbopuffer embed is the scale refinement.)
4. ✅ **Routing map** — `connector_routing` (`connectors/routing.ts`): confirmed route → name-match suggestion → first project; **learned** (approving a create remembers workspace→project). Used by both the agent and chat-create. *Pending:* folder-level routing.
5. ✅ **Decision-thread conviction engine** (`connectors/jira/conviction.ts`). One flash-model call per workspace per sweep over the chronological decision stream: groups threads, marks SETTLED + high-conviction only when agreement held (≥2 meetings / final, not reversed) — the disagree→disagree→agree flip stays low-conviction and waits. Settled threads → proposals alongside owned action items. *Pending:* persistent thread-state ledger (recomputed each sweep today; the LLM sees full history so conviction still accumulates correctly).
6. ✅ **Propose-and-edit approval card → execute + audit + rollback.** Chat-driven HITL: `chatAgent` emits an editable `JiraActionProposal`; `JiraActionCard` (chat + Suggested-actions queue) is fully editable; approval calls `POST /connectors/jira/action` → `executeJiraAction` (create/update/assign/comment/transition/close via Atlassian MCP, real schemas; assignee resolution name→email→accountId cached). Every write is recorded in `action_audit` (`connectors/jira/audit.ts`) with a best-effort inverse; the success card offers **Undo** (create→close, transition→prior status, edit→prior fields; comments not reversible via MCP).

"Patience" is enforced structurally: the agent NEVER writes — it only proposes; every Jira write requires an explicit human approval in the card.

## 9. The Living Brain — unified cross-source memory (architecture)
Today connectors are **live hands**: the MCP tool-use agent (`mcp/agent.ts`) reads Jira/GitHub in the moment and proposes writes. That gives freshness + actions, but it is **not the brain**. The brain is the *persisted, associated* graph where a meeting decision, the Jira ticket it became, and the GitHub PR that implements it are **linked** and **compound over time**. Only meetings have that today (`knowledge_graph` + `kg_edges`). This section unifies all sources into one graph.

**Live vs. brain (both required):** Live = senses + hands (fresh reads, writes). Brain = persisted associated memory (the graph) that answers "trace this decision to shipped code" and powers cross-source reasoning. Sync ingests live data INTO the brain; the brain INFORMS the agent's live actions (dedup, lineage, conviction).

### 9.1 One graph, many senses
```
 SENSES (connectors)        UNIFY (L2/L3)            ASSOCIATE (the brain)         USE
 Meetings ─┐
 Jira      ─┼─ sync → knowledge_item ─→ brain_edge: provenance · reference ·  ─→  Chat (RAG + graph expansion)
 GitHub    ─┤        + ONE Turbopuffer    people · semantic (deterministic→LLM)    Agent (dedup, conviction)
 Confluence┘          vector index                                                 Brain map (multi-source viz)
```
- **Nodes** = `knowledge_item` rows (meeting | jira | github | …) + the meeting-derived entities already in `knowledge_graph` (decision, action_item, person, topic).
- **Edges** = NEW `brain_edge (workspace_id, src_type, src_id, dst_type, dst_id, relation, origin, confidence, evidence, created_at)` — any node ↔ any node, workspace-scoped.

### 9.2 Association engine (the heart) — cheapest signal first, LLM only to confirm
1. **Provenance (free, exact):** `action_proposal`/`action_audit` already record `source_meeting_id` → the Jira issue the agent created. Persist `meeting→decision→jira_issue`. Same when a PR is opened from an issue.
2. **Reference (deterministic parse):** GitHub PR/commit/branch text ("fixes PROJ-3", "closes #42"), Jira dev-panel links → `jira_issue ↔ github_pr`, `commit ↔ issue`.
3. **People (deterministic):** unify identities via `people_directory` (name → email → Jira accountId / GitHub login). One Person node ↔ their meetings/tickets/PRs.
4. **Semantic (embedding ANN + LLM):** the unified index finds cross-source neighbours; a bounded LLM pass (reuse the **kgLink** pattern) confirms + labels ("this PR implements this decision").

### 9.3 Reuse vs. new
- **Reuse:** `knowledge_item` (Jira lands here; GitHub via the new adapter), `knowledge_graph`, `people_directory`, **kgEmbed/kgLink/kgSweep**, Turbopuffer, the KnowledgePage force-graph.
- **New:** GitHub sync adapter; embed `knowledge_item` into a unified workspace namespace; `brain_edge` + a `brain-link` EventBridge sweep (cross-source twin of `kgLink`); multi-source graph UI + lineage view.

### 9.4 Build order (non-breaking; priority = cross-source answers)
- **A — GitHub into memory:** ✅ `connectors/github/index.ts` sync adapter → `knowledge_item` (issues+PRs the user is involved in via `search_issues`/`search_pull_requests` `involves:@me`, most-recent first, bounded 30×2/tick). Registered in the connector-sync sweep (15-min). Verified: `github_sync {count:32}` → `connector-sync sources:3/processed:32/errors:0`. Chat's source-agnostic `fetchKnowledgeItems` now includes GitHub, so it joins cross-source answers immediately.
- **B — Unified retrieval:** ✅ `connectors/brainVector.ts` (Turbopuffer namespace `lumina-knowledge-items`, filtered by user_id+workspace_id) + `connectors/embed.ts` (`embedKnowledgeItems` reuses `embedTexts`/gemini-embedding-001; `semanticSearchItems`). `knowledge_item` gains `embedded_at` (incremental). The connector-sync sweep embeds new/changed items each tick. `chatAgent.fetchKnowledgeItems(q)` now retrieves SEMANTICALLY across sources (recency fallback). Verified: 46 items embedded; "bug fix" returns GitHub PRs **and** Jira PROJ-3 ranked together. *Pending:* fold meetings into the SAME vector index (today meetings retrieve via their own kg_embeddings path + are combined in evidence).
- **C — Association engine:** ✅ `connectors/brainEdges.ts` (`brain_edge` + `brain_link_state`) + `connectors/brainLink.ts` (`runBrainLink`): **provenance** (action_proposal meeting→spawned Jira issue) → **reference** ("fixes PROJ-3", "#42" parsed from bodies) → **semantic** (embedding-nearest cross-source, threshold 0.74, marked in brain_link_state). `__job:'brain-link'` on a 30-min EventBridge rule (`wisprnote-api-brain-link`); `GET /brain/edges?workspace=` for the map. Verified: 182 edges, cross-source confirmed (e.g. GitHub "disocver UI bug fix" ↔ Jira PROJ-3 "button bug issue" @0.87). *Note:* for this data provenance/reference were 0 (no executed meeting→Jira proposals; GitHub repos don't cite Jira keys) — semantic carries it; the deterministic linkers fire as soon as those signals exist.
- **D — Brain-aware chat:** ✅ `embed.ts expandWithNeighbours` pulls a retrieved item's linked neighbours (`brain_edge`) into chat evidence + annotates lineage (`_linked`); the live agent gets a `search_brain` tool (semantic + cross-tool links). Prompt instructs tracing lineage. Verified: "what GitHub work relates to our Jira bug issues?" → traced PROJ-3 → merged PRs #5/#2 with details. *Pending:* agent dedup-before-propose + conviction reading cross-source status.
- **E — Brain map (UI):** ✅ `GET /brain/graph?workspace=` (nodes = items + meetings, links = brain_edge) → `src/components/BrainMapModal.tsx` (ForceGraph2D, nodes coloured by source: meeting=green/jira=blue/github=violet, click opens in tool) opened from a **Brain map** button on the workspace header (`src/services/brainService.ts`).
