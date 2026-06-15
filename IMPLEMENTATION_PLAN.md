# Wisprnote OS — Implementation Plan (the "how")

> Companion to **CLAUDE.md** (the *vision/why*). This is the *execution/how*: a
> concrete, incremental, **non-breaking** build sequence grounded in the real
> `desktop/Lumina-AI-` codebase (AWS Lambda `wisprnote-api` + RDS Postgres + API
> Gateway + EventBridge + Secrets Manager + Turbopuffer). Each phase is
> independently shippable, leaves the app working, and is verified before the
> next starts.

---

## 0. Non-breaking discipline (applies to EVERY phase)

These are the rules we've already proven this codebase follows — keep using them:

1. **Additive schema only.** New tables via `ensure*Schema()` in the Lambda (the
   `kgEmbed.ts` / `usage.ts` pattern) or `aws/migration.sql`. Never alter/drop an
   existing column. New columns are nullable with safe defaults.
2. **Feature-flag every new surface.** Server: `process.env.*` gates (e.g.
   `KG_FASTPATH`); client: `import.meta.env.VITE_*` (e.g. `VITE_SERVER_KG_GRAPH`).
   Default OFF — ship "dark", verify, then flip.
3. **Fallback, never replace.** New paths fall back to the existing one when a flag
   is off or a call fails (the server-KG-graph read path is the template).
4. **Idempotent everywhere.** Upsert on a unique key (`ON CONFLICT`), so re-runs are
   safe — exactly like `knowledge_graph` / `kg_embeddings`.
5. **Background work = the sweep pattern.** EventBridge → Lambda `__job` route →
   bounded batch → idempotent upsert → Turbopuffer. Reuse `kgSweep.ts` wholesale.
6. **Gate each step:** `tsc --noEmit` clean + the relevant `__job` verified on the
   live Lambda (invoke + check counts) before moving on.
7. **Cost-gated ingestion.** Every new source that embeds data is bounded and tied
   to plan limits / the cost-control work (`plans.ts`, `usage.ts`) — no unbounded
   org-wide ingestion without a budget check.

---

## 1. What we already have (the head start)

| Asset | File(s) | Reuse for |
|---|---|---|
| Background sync engine | `kgSweep.ts`, `index.ts` (`__job` routes), EventBridge `wisprnote-api-kg-sweep` | connector backfill + incremental sync |
| Embeddings + vector index | `kgEmbed.ts` (`embedTexts`), `kgVector.ts` (Turbopuffer ANN, tenant-scoped) | embedding `knowledge_item` |
| Idempotent schema bootstrap | `ensureKgGraphSchema()` pattern | `knowledge_item` / `sync_state` / `decision` tables |
| Model registry | `src/config/models.ts`, `aws/api/src/models/registry.ts` | pin connector/agent models |
| **MCP registry** | `aws/api/src/mcp/registry.ts` | endpoints/auth/scopes per connector **MCP server** |
| Tenant isolation | `tenantScopeTurbopuffer`, `user_id`-scoped SQL | per-user/workspace data safety |
| Ledger pattern | `usage.ts`, `awsLedgerService.ts`, `lib/kgLedger.ts` | `audit_log` / action ledger |
| Observability + evals | `observability.ts` (`traceAI`, Braintrust) | action eval gates |
| Decisions/action_items extraction | `knowledge_graph` JSONB + `kgExtract.ts` | Phase 3 action proposals (half-done) |
| Plan limits / metering | `plans.ts`, `usage.ts` | cost-gating ingestion + actions |

**Correction vs the old vision:** connector *sync* runs **server-side** (Lambda +
EventBridge — the sweep engine), NOT in the client. New server code lives in
`aws/api/src/connectors/`, `aws/api/src/actions/`, `aws/api/src/trust/`. The client
only does OAuth connect + display.

---

## 2. Phases

### Phase 0 — Foundation (dark, additive)
**Goal:** the rails every connector plugs into, with zero user-visible change.
- `ensureKnowledgeItemSchema()` → `knowledge_item` + `sync_state` tables (RDS,
  `user_id`/`workspace_id`-scoped, `unique(user_id, source, source_id, type)`).
- `aws/api/src/connectors/registry.ts` — `Connector` interface + registry
  (`backfill`, `incremental`, `actions`, `execute`, `rollback`).
- **MCP layer:** `aws/api/src/mcp/registry.ts` (✅ created) + a generic **MCP client**
  the connector framework uses to call any registered server's tools, authed by the
  broker. Connectors are thin adapters over MCP — not bespoke REST clients.
- `connector_credentials` table (KMS-encrypted tokens) + a **broker stub** that
  reads tokens server-side and never returns raw creds. (Secrets Manager for shared
  app keys; the table for per-user OAuth tokens — Secrets Manager per-user doesn't
  scale.)
- `__job: 'connector-sync'` route + a `wisprnote-api-connector-sync` EventBridge rule
  (clone of the KG sweep) that drains `sync_state` cursors via the registry.
- A no-op test connector to exercise the loop end-to-end.

**Reuses:** `kgSweep` engine, `ensure*Schema`, `kgVector`/`kgEmbed`.
**Non-breaking:** all additive + flagged (`CONNECTORS_ENABLED`); no existing
route/table/flow touched.
**Acceptance:** migration applies; no-op connector registers and a sync tick writes
to `knowledge_item`; `/tasks`, `/ai/*`, `kg-sweep` all behave exactly as before; `tsc` clean.

---

### Phase 1 — Jira read connector (the proof)
**Goal:** prove external context flows into the existing brain, end-to-end.
- `aws/api/src/connectors/jira/` — a thin adapter over the **Atlassian Rovo MCP**
  server (`mcp/registry.ts` → `https://mcp.atlassian.com/v1/mcp`, OAuth via the
  broker): list/search issues + comments through MCP tools; normalize ADF→markdown;
  `backfill` + `incremental` cursors in `sync_state`.
- Sync upserts `knowledge_item`; embed via `embedTexts` → Turbopuffer (new source
  tag, tenant-scoped).
- Extend chat retrieval (`chatAgent.ts` / Turbopuffer query) to include
  `knowledge_item` vectors filtered by `source` — **additively**.

**Reuses:** Phase 0 rails, `kgEmbed.embedTexts`, `kgVector` ANN, model registry.
**Non-breaking:** Jira is off until a user connects it; retrieval extension is
additive (no Jira data → identical chat behaviour); behind `CONNECTORS_ENABLED`.
**Acceptance:** real Jira issues + comments are queryable in chat **with citations**;
re-sync is idempotent; a meeting-only question is unchanged.

---

### Phase 2 — Context fusion (remaining read connectors)
**Goal:** the company memory layer — answer across all sources.
- Read connectors (same interface): Gmail, Calendar, Drive, GitHub, Slack, Claude
  Code sessions, Codex. Each independent + individually flagged.
- Hybrid cross-source RAG + rerank in the retrieval layer.
- `brain.ask` / `brain.search` (read-only) exposed via `mcp-server/`.
- **Cost guardrail:** per-connector ingestion volume metered (`usage.ts`) and bounded
  by plan tier — large mailboxes/repos sync incrementally within a budget.

**Reuses:** Phase 0/1 rails per connector.
**Non-breaking:** each connector additive + flagged + read-only.
**Acceptance:** a cross-source question (meeting + Jira + email) returns a correct,
cited answer; scheduled incremental sync keeps sources fresh; cost stays within tier.

---

### Phase 3 — Decisions + proposed actions + approvals (NO writes)
**Goal:** meeting → proposed actions → human approves → recorded. No silent writes.
- Extend extraction (build on `knowledge_graph.decisions/action_items`) → concrete
  **action proposals** cross-referenced with systems of record.
- `decision` / `action` / `audit_log` tables (additive; mirror the ledger pattern).
- **Approval queue UI** — new page/panel, flagged (`VITE_ACTIONS_UI`), brand tokens.
- Executors run **dry-run only** (build the payload, never call a write API).

**Reuses:** `kgExtract` output, ledger pattern, the brand-token UI system.
**Non-breaking:** proposals only; nothing executes; UI behind a flag.
**Acceptance:** from a real meeting, ≥3 correct proposals land in the approval queue;
approve/reject is logged to `audit_log`; **nothing writes to any external tool**.

---

### Phase 4 — Action execution + Trust & Safety (L6)
**Goal:** the brain completes work, safely.
- **Credential broker + policy engine** (`aws/api/src/trust/`): every write goes
  through the broker; tokens never leave it; each action validated against
  risk-tiered policy (`low` auto / `medium` 1 approval / `high` explicit).
- Real writes via each connector's **MCP-server tools** (`execute()`); **idempotency
  keys** + **`rollback_token`**
  per action kind.
- **Braintrust eval gates** (reuse `traceAI`) + sandbox; a workflow can't auto-run
  until its eval set passes.

**Reuses:** `observability.ts` eval/trace, the `action` ledger, connector `execute`.
**Non-breaking:** only **approved** actions execute; high-risk can't bypass approval;
per-connector write enablement, flagged; dry-run remains the default.
**Acceptance:** an approved action executes in the real tool, is auditable end-to-end
(meeting → decision → approver → result), and is **reversible**; evals pass.

---

### Phase 5 — Workflow templates + team brain
**Goal:** encode repeated org workflows; shared multi-user brain.
- Templates (standup → ticket updates; sales call → CRM + follow-up).
- Auto-execute `low`-risk per policy; scheduled/triggered workflows (EventBridge).
- Team brain via the existing **workspace** model + Lambda-enforced
  `user_id`/`workspace` scoping; per-user permissions = connector visibility.

**Non-breaking:** templates opt-in; auto-execute only for `low`-risk under explicit
policy; workspace scoping reuses existing isolation.
**Acceptance:** ≥1 template runs trigger→recorded outcome with correct approvals; two
users share a workspace brain scoped to their permissions.

---

### Phase 6 — Cross-platform packaging (parallel track)
**Goal:** signed installers on macOS · Windows · Linux. (Orthogonal — can run
alongside other phases.)
- Port native capture (`cidre`, NSPanel, mic/system-audio) to Windows (WASAPI) +
  Linux (PipeWire); gate per `cfg(target_os)`.
- `tauri build` matrix; signing/notarization; auto-update; first-run onboarding +
  connector OAuth.
**Acceptance:** signed installers run on clean macOS/Windows/Linux; capture works on
each; onboarding connects Jira + one Google service.

---

## 2.5 Connector UI — connecting tools from the app (client side)

The server phases handle *sync*; this is how a **user connects a tool from inside
the app**. It reuses two things we already have: the **Settings tab shell**
(`src/pages/SettingsPage.tsx` — `SettingsTab` union + sidebar + content switch) and
the **`wisprnote://` deep-link OAuth pattern** (`Auth.tsx` + `awsAuthService.ts`,
scheme already registered in `tauri.conf.json`). Each tool is reached through its
**MCP server** (server-side MCP client + `aws/api/src/mcp/registry.ts`); the UI's job is
only OAuth-connect + show status.

### Where it lives
- **New Settings tab:** add `'connections'` to the `SettingsTab` union + an item in
  `WORKSPACE_ITEMS` + a `TAB_TITLES` entry + render `<ConnectionsTab/>`
  (`src/pages/settings/ConnectionsTab.tsx`). Mirrors how `BillingTab` is wired —
  fully additive, existing tabs untouched.
- **Client catalog:** `src/config/connectors.ts` — config-driven list
  `{ id, name, icon, description, category, scopes, status: 'live'|'soon' }`. The
  `id` matches the server connector registry. (Same single-source-of-truth idea as
  the model registry.)
- **Service:** `src/services/connectorService.ts` — `listConnectors()`,
  `getOAuthUrl(id)`, `exchange(id, code)`, `disconnect(id)`, `setConfig(id, cfg)`.

### Connection lifecycle (per connector card)
```
not-connected ──Connect──► [OAuth] ──► connecting ──► connected ──Disconnect──► not-connected
                                              │
                                              └─ error → Reconnect
connected card shows: account · last synced · "syncing N…" badge · scope/config · Disconnect
```

### OAuth flow — reuse the deep-link pattern (no tokens in the client)
1. Card "Connect" → `connectorService.getOAuthUrl('jira')` → server
   `GET /connectors/jira/oauth-url` returns the provider URL (with a CSRF `state`).
2. Open it (Tauri opener / web redirect). Provider → `wisprnote://connector-callback?connector=jira&code=…&state=…`.
3. A deep-link listener (clone of `Auth.tsx`'s `onOpenUrl` effect, validating the
   `wisprnote://connector-callback` prefix + `state`) forwards the code to
   `POST /connectors/jira/exchange`.
4. Server exchanges the code and stores the token **via the broker**
   (`connector_credentials`, KMS-encrypted) — the raw token never reaches the client.
5. Status flips to connected; the `connector-sync` job (server Phase 0/1) starts the
   first backfill. Web path mirrors the existing `?code=` web-callback effect.

### Status + sync feedback
- `GET /connectors` → per-user states `{ id, connected, account, last_synced_at,
  item_count, syncing, error }`. The card shows live state; a **"syncing N items…"**
  pill reuses the brand pattern from the KG "Analysing on our servers…" badge
  (`app-panel` glass + accent spinner).
- Errors surface as a clean **Reconnect** affordance — reuse the `OAuthError` /
  no-raw-error messaging we built for sign-in.

### Per-connector config + disconnect
- Optional **scope modal** (e.g. Jira: which projects; Gmail: which labels) →
  `setConfig` → stored as the connector's `sync_state` scope. Keeps ingestion (and
  cost) bounded — ties to the plan-limit gating.
- **Disconnect** → `DELETE /connectors/{id}` revokes the token and (with a confirm
  dialog) optionally purges that source's `knowledge_item` rows + vectors.

### UI rollout sub-phases (track the server phases)
- **UI-0 (with server Phase 0):** Connections tab shell + catalog rendered as cards,
  everything **"Coming soon"**, no OAuth yet. Pure visual, zero risk — ship dark
  behind `VITE_CONNECTORS`.
- **UI-1 (with server Phase 1 / Jira):** wire real Connect/Disconnect + status for
  the **first** connector (Jira). Validates the whole OAuth→broker→sync loop.
- **UI-2 (with server Phase 2):** flip remaining connectors from "soon" → "live" as
  each server connector lands; add per-connector scope modals.
- **UI-3:** connection health, sync progress detail, and data-scope controls.

### Non-breaking + security
- New tab, new `/connectors/*` endpoints, new service/catalog — all additive, behind
  `VITE_CONNECTORS` (default off). Existing settings/auth flows untouched.
- Tokens live **only** server-side (broker); client holds connection *status*, never
  credentials. OAuth uses a `state` param (CSRF) and validates the deep-link prefix
  exactly like `Auth.tsx`. Reuse the clean-error messaging (no raw provider errors).
- Brand tokens + glass cards + connector logos; category grouping (Issue tracking /
  Email & calendar / Code / Chat). Light + dark via `app-*` tokens.

---

## 3. Sequencing & dependencies

```
Phase 0 (rails) ─┬─► Phase 1 (Jira read) ─► Phase 2 (more reads) ─► Phase 3 (proposals)
                 │                                                        │
                 └────────────────────────────────────────────────────► Phase 4 (execute + trust)
                                                                          │
                                                                          └─► Phase 5 (templates/team)
Phase 6 (packaging) — parallel, independent.
```

Read-before-write is deliberate: Phases 1–2 ship a strong, **low-risk** product
(cross-source cited answers) on their own. Do not start Phase 4 (real writes) until
Phase 3's approval/dry-run discipline and the trust layer are solid.

## 4. Definition of done (every phase)
1. Acceptance passes on **real data** (not mocks).
2. Idempotent + safe to re-run.
3. `tsc --noEmit` clean; new logic tested; existing endpoints unchanged.
4. Feature-flagged; fallback path intact; verified on the live Lambda.
5. CLAUDE.md + this doc updated if a decision changed.

*If a task doesn't advance the OS loop (CLAUDE.md §2) — capture → understand → act →
update → record — defer it.*
