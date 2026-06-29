# Suggested Actions Engine — Current State & Target Architecture

> **What this is:** an honest assessment of how "Suggested actions" works today, its real limitations,
> and a robust, phased enterprise architecture to make it reason across the **whole brain** (every
> meeting × every connected tool) instead of a narrow, recent, Jira-only slice.
>
> **Status:** design doc. No code changed by writing this. Phases are sequenced so each is shippable,
> non-breaking, and reuses the existing HITL rails.
>
> Grounded in the real code as of 2026-06: `aws/api/src/connectors/jira/agent.ts`,
> `aws/api/src/connectors/jira/reconcile.ts`, `aws/api/src/connectors/proposals.ts`,
> `aws/api/src/mcp/toolPlane.ts`, `src/pages/WorkspacePage.tsx`.

---

## 1. TL;DR

- **Today**, the "Suggested actions" badge is fed by two hourly sweeps that look at **only the last
  30 days / 20 most-recent meetings**, propose **Jira actions only**, and the cross-tool detectors
  fire **only where the brain already drew a link**. It is a rule-based, Jira-anchored, recent-window
  slice — **not** a holistic engine over the full corpus and all connected tools.
- **Target**: a hybrid **Suggested Actions Engine** — deterministic detectors *plus* a semantic
  reasoner over the entire embedded brain — that proposes the highest-value next actions in **any**
  connected tool, with **guaranteed coverage** ("reasoned over N of N"), one trust gate, and the same
  human-in-the-loop approval + audit + rollback we already have.

---

## 2. How it works today (honest current state)

The badge in `src/pages/WorkspacePage.tsx` (line ~719, "Suggested actions") shows
`proposals.length` — pending rows in the `action_proposal` table for the workspace, fetched via
`proposalService.listPendingProposals`. That queue is populated by **two server-side sweeps** on the
hourly `jira-agent-sweep` EventBridge cron:

### 2.1 Jira agent sweep — `runJiraAgentSweep()` (`connectors/jira/agent.ts`)
- Iterates workspaces that have a connected **Jira** credential (`WORKSPACE_CAP = 20`).
- For each, pulls **recent meetings only**: `MEETING_LOOKBACK_DAYS = 30`, `MEETINGS_PER_WS = 20`
  (`ORDER BY created_at DESC LIMIT 20`).
- Reads those meetings' `action_items` (from `knowledge_graph`) → proposes **Jira issue creation**.
- A "conviction layer" turns **settled cross-meeting decisions** (`kg_edges`) into proposals.
- Caps `PROPOSALS_PER_WS = 12`.

### 2.2 Reconcile sweep — `runReconcileSweep()` (`connectors/jira/reconcile.ts`)
Three fixed SQL detectors over the `brain_edge` cross-tool graph, each capped `PER_DETECTOR_CAP = 8`:
- **A. Transition gap** — a non-done Jira ticket with `aligned`/`partial` GitHub code linked → propose
  moving it forward (To Do → In Review → Done).
- **B. Divergence flag** — work judged `divergent` linked to a ticket → propose a heads-up comment.
- **C. Stale decided-work nudge** — an open Jira ticket that traces (via `brain_edge`) to a `meeting`
  decision and is idle ≥ `STALE_DAYS = 7` → propose a nudge comment.

Both sweeps are **propose-only**, write to `action_proposal`, are deduped by `dedupKey`, and render
through the existing approval cards (`JiraActionCard` / `McpActionCard`) → `executeJiraAction` →
audit → rollback.

---

## 3. Limitations (why it doesn't reference the whole picture)

1. **Not all meetings.** The Jira agent only scans the **last 30 days / 20 most-recent** meetings.
   In a 50-meeting history, older or lower-ranked meetings are never reconsidered for new actions.
2. **Jira-only actions.** Every *proposed action* is a Jira create/comment/transition. GitHub,
   Claude Code, Codex (and now Slack/Gmail/Calendar/Drive) are used **only as read-signal** — the
   engine never proposes "open a GitHub issue", "post to Slack", "draft a Gmail reply", "hold time on
   the calendar".
3. **Link-dependent.** The reconcile detectors fire **only where a `brain_edge` already exists**. A
   decision the brain-link cron never connected to a ticket/commit yields nothing.
4. **Rule-based, not reasoning.** Detectors are fixed heuristics (status regex, 7-day staleness,
   verdict enums) — not a model reasoning holistically over the corpus to find the best next action.
5. **No coverage guarantee.** Silent caps (`LIMIT 20`, `PER_DETECTOR_CAP 8`, `WORKSPACE_CAP 20`). The
   UI never says "reasoned over N of N" — so gaps are invisible.

> Net: the user's intuition is correct. "Suggested actions" is a **narrow, Jira-anchored,
> recent-window, link-dependent slice**, not a comprehensive engine.

---

## 4. Target architecture (the engine)

A six-stage pipeline, event-driven for freshness and cursor-swept for completeness. Each stage is a
small, testable unit; the later stages reuse what we already built.

```
Brain (all meetings × every connected tool — full corpus, always synced)
        │
        ▼
CANDIDATE GENERATION  ── (a) deterministic detectors   ── (b) semantic reasoner (LLM, full-corpus retrieval)
        │
        ▼
ACTION PLANNER  (connector-agnostic — map each candidate to a tool action via the tool plane)
        │
        ▼
VERIFY · DEDUP · RANK  (adversarial check, dedup vs systems of record, score by impact×confidence×urgency, expiry)
        │
        ▼
HUMAN APPROVAL → GATED EXECUTE  (approval cards · trust gate · audit · reversible)
        │
        ▼
CROSS-CUTTING:  coverage ledger (N of N) · trust gate (allow/ask/deny) · token budget · audit
```

### 4.1 Signal layer — the whole corpus, event-driven
- Every meeting processed, KG extraction, and connector sync emits a normalized **change event**
  into a work queue (extend the existing `brain_event` + sync crons).
- Reasoning is triggered **incrementally** per change *and* a **cursor-based backfill** walks the
  entire history in pages. **No recency `LIMIT`.** A `suggestion_coverage` cursor per workspace
  records progress so the full corpus is covered over time, not truncated.

### 4.2 Candidate generation — hybrid recall
Two complementary generators, both running over the *full* corpus (not a window):
- **(a) Deterministic detectors** — cheap, precise, high-recall on known patterns. Keep today's three
  reconcile rules; add: *decision-with-no-ticket*, *unassigned/overdue action item*, *blocked*,
  *duplicate-of-existing*. Run on changed entities, incrementally.
- **(b) Semantic reasoner (LLM)** — broad, fuzzy. Retrieval over the fully embedded brain
  (`knowledge_item` + Turbopuffer) → an agent asks *"what should happen next that hasn't?"* and emits
  candidate actions **with citations**. Map-reduce over the corpus in pages so coverage is complete.
  This is what catches what rigid rules + missing edges miss, and does **not** require a pre-existing
  `brain_edge`.

### 4.3 Action planner — connector-agnostic
- Each candidate is mapped to a **concrete tool action** through the **tool plane**
  (`connector_tool` catalog + `resolvePermission`, `mcp/toolPlane.ts`).
- Actions may target **any connected tool**: Jira (create/transition/comment), GitHub (issue/PR
  comment), Slack (post), Gmail (draft), Calendar (event) — chosen by the planner, gated by policy.
- This is the single biggest product change: suggestions become **cross-tool**, not Jira-only.

### 4.4 Verify · dedup · rank
- **Verify** (adversarial): is the action real, not already done, not a duplicate of an existing
  ticket/PR/proposal? Default to rejecting on uncertainty (mirror the agentic-loop verify pattern).
- **Dedup** against `action_proposal` *and* systems of record (don't propose a ticket that exists).
- **Rank** by `impact × confidence × urgency`; attach `confidence` + `expires_at`. The badge then
  shows the **best** actions, not a capped arbitrary slice.

### 4.5 Human approval → gated execution
- Survivors flow into the **existing rails** unchanged: `action_proposal` → approval cards
  (`JiraActionCard` / `McpActionCard`) → gated executor (`executeJiraAction` / `executeMcpWrite`) →
  audit ledger → rollback. The trust gate (`resolvePermission`) is the one chokepoint.

### 4.6 Cross-cutting governance (the enterprise rail)
- **Coverage ledger** — per workspace, track which meetings/items were reasoned over + the cursor;
  surface **"reasoned over N of N meetings"** in the UI. No silent caps — log any truncation.
- **Trust gate** — `allow / ask / deny` + risk tiers on every proposed action.
- **Token budget** — tiered models: detectors always-on (cheap); the LLM reasoner runs batched +
  bounded by a per-workspace token budget (cost control at scale).
- **Audit + multi-tenant scoping** (user_id/workspace, folder-scoped projects) + **freshness SLAs**
  (incremental within minutes; full coverage within hours) + **observability** (proposal volume,
  accept rate, false-positive rate via Braintrust).

---

## 5. Data model additions (reuse first)

Reuse `action_proposal` as the final queue. Add two small things:

```sql
-- Per-workspace reasoning coverage so the UI can show "N of N" and the sweep can resume.
CREATE TABLE IF NOT EXISTS suggestion_coverage (
  user_id        UUID NOT NULL,
  workspace_id   TEXT NOT NULL,
  cursor         TEXT,                 -- last item/meeting reasoned over (resumable backfill)
  reasoned_count INT  NOT NULL DEFAULT 0,
  total_count    INT  NOT NULL DEFAULT 0,
  last_run_at    TIMESTAMPTZ,
  PRIMARY KEY (user_id, workspace_id)
);

-- Optional: enrich action_proposal with ranking fields (or add columns to it).
-- ALTER TABLE action_proposal ADD COLUMN confidence REAL, ADD COLUMN impact REAL,
--   ADD COLUMN expires_at TIMESTAMPTZ, ADD COLUMN evidence JSONB;  -- citations: meeting/ticket/commit ids
```

`evidence` makes every suggestion **traceable** (which meeting/decision/commit it came from) — the
provenance enterprises require.

---

## 6. Execution model (scale)

- **Event-driven incremental** — a processed meeting / synced ticket enqueues reasoning for that item
  + its graph neighbors → fresh suggestions within minutes.
- **Scheduled backfill** — a cursor sweep (on the existing cron) walks the full corpus in pages until
  `reasoned_count == total_count`; logs progress; **never** silently stops at a `LIMIT`.
- **Tiered cost** — deterministic detectors on every change; the LLM reasoner batched + token-budgeted
  per workspace; premium model only for the verify/rank step.

---

## 7. Phased plan (each shippable, non-breaking)

| Phase | Goal | Acceptance |
|---|---|---|
| **P1 — Full coverage** | Remove the 30-day / 20-meeting window in `runJiraAgentSweep`; add `suggestion_coverage` + a cursor backfill so **all** meetings are reasoned over; surface "reasoned over N of N" in the UI. | On a 50-meeting workspace, every meeting's action items are eligible; the UI shows full coverage; no silent truncation. |
| **P2 — Connector-agnostic actions** | Let the planner propose actions in **any** connected tool via the tool plane (not just Jira). Generalize `action_proposal` + cards to render any MCP write (the rails are already generic). | A proposal targeting GitHub/Slack/Gmail renders an approval card and executes through `executeMcpWrite` + the gate. |
| **P3 — Semantic reasoner** | Add the LLM candidate generator over full-corpus retrieval, with citations + token budget. Runs alongside the detectors. | On real data, it surfaces ≥1 correct action the rules miss, each citing its source meeting/item. |
| **P4 — Verify · rank · expiry** | Adversarial verify, dedup vs systems of record, score (impact×confidence×urgency), expiry. Badge shows ranked best. | False-positive rate drops; no duplicates of existing tickets; proposals expire. |
| **P5 — Governance & observability** | Risk tiers, per-workspace token budget, freshness SLA, Braintrust metrics (volume, accept rate, FP rate). | Dashboards show coverage %, accept rate; budget caps hold; everything audited. |

> **P1 is the quickest honesty win** — it alone removes the "only recent meetings" gap and makes
> coverage visible. P2 removes the "Jira-only" gap. P3 removes the "rules-only / link-dependent" gap.

---

## 8. What it reuses vs. net-new

- **Reuses:** `action_proposal` + `insertProposal` + dedupKey, `JiraActionCard`/`McpActionCard`,
  `executeJiraAction`/`executeMcpWrite`, `resolvePermission` (trust gate), audit + rollback, the
  embedded brain (`knowledge_item` + Turbopuffer), `brain_edge`, the EventBridge cron.
- **Net-new:** the semantic reasoner (candidate generator), the connector-agnostic action planner,
  the verify/rank/dedup stage, the `suggestion_coverage` ledger, and the ranking fields on proposals.

---

## 9. Definition of done (every phase)
1. Works on real data (not mocks); idempotent + safe to re-run.
2. No silent caps — any truncation is logged and coverage is surfaced.
3. Every proposed action is gated (`resolvePermission`), audited, and reversible.
4. `npm run lint` + server `tsc` clean; verified via a temporary `kx-verify` probe before stripping.
5. This doc updated if a decision changes.

---

*Bottom line: today's "Suggested actions" is a useful but narrow first loop. The engine above keeps
its safe HITL spine and widens the front end from "recent Jira gaps" to "the best next action,
anywhere, reasoned over everything" — with coverage you can prove.*
