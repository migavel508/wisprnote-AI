# Wisprnote AI → Operating System — Engineering Plan (CLAUDE.md)

> Master plan for evolving **Wisprnote AI** (`desktop/Lumina-AI-`) from a meeting
> notes taker + memory layer into a **company operating system**: it captures
> context, decides, **acts across the tools an org uses**, and keeps a track record.
>
> This is the source of truth for *what* we build, *why*, and *in what order*. Read it
> before any phase. Update it when a decision changes. See `PROJECT_DOCUMENTATION.md`
> and `AI_model.md` for the current state in detail.

---

## 1. Thesis

A notes taker **records**. A memory layer **recalls**. An operating system **acts**.

Wisprnote already records (capture + transcription), recalls (RAG chat + knowledge
graph), and even drafts (follow-up emails, wiki, PPT). The next leap is **acting**:
turning meeting decisions into real changes in Jira, Gmail, Calendar, GitHub, Slack —
with a trust layer so an agent can operate in real tools safely.

The workflow we own: **decide in a meeting → make it happen everywhere.**

> "The real question is who owns a workflow people repeat every day." And:
> "A bad answer annoys you. A bad action costs money and trust."

**Product evolution:** `notes taker (done) → company memory layer (mostly done) → operating system (this plan).`

---

## 2. The Operating System Loop (the spine)

If a feature doesn't advance this loop, it's out of scope.

```
  1. CAPTURE     meeting audio (✅ native Tauri/Deepgram/Gemini) + external signals (NEW)
  2. UNDERSTAND  decisions · action_items · people · topics  (✅ partial via knowledge_graph)
  3. ACT         write to Jira · Gmail · Calendar · GitHub · Slack   (NEW — the OS turn)
  4. UPDATE      reflect changes back into systems of record          (NEW)
  5. RECORD      decision ledger: who decided what, why, what was done (NEW)
       └────────── feeds back into memory; the brain compounds ──────────┐
   ▲                                                                       │
   └───────────────────────────────────────────────────────────────────────┘
```

✅ = already exists in the codebase. NEW = what this plan adds.

---

## 3. Current State (what already exists — build ON this, not over it)

| Capability | Where | Status |
|---|---|---|
| Native audio + system-audio capture | `src-tauri/src/*.rs` (`cpal`, `cidre`, `system_audio.rs`) | ✅ **macOS only** |
| Realtime transcription | `src-tauri/src/deepgram_transcriber.rs` | ✅ |
| Batch transcription / summary / notes | `src/services/geminiService.ts` (Gemini 3) | ✅ |
| Meetings / notes / history store | AWS RDS Postgres (`task_history`, notes tables; user_id-scoped in the Lambda) | ✅ |
| Vector search / RAG | `turbopufferService.ts`, `ragService.ts`, `chatRetrievalService.ts`, `meetingEvidence.ts` | ✅ |
| Chat with context | `ChatPage.tsx`, `chatModels.ts`, `sharedChatService.ts` | ✅ |
| Knowledge graph (decisions/action_items/people/topics) | `knowledge_graph` (RDS JSONB) + server pipeline `aws/api/src/kg{Extract,Embed,Link,Sweep}.ts` (EventBridge cron) + `geminiService.extractKnowledgeGraph` (client fallback) + force-graph UI | ✅ |
| Primitive "actions" (generate email / wiki / PPT / report) | chat agent actions, `pptxgenjs`, `docx` | ✅ (text only) |
| Auth / billing / sharing | AWS Cognito + Lambda (`wisprnote-api`) + API Gateway, Paddle, `awsShareService` | ✅ |
| Ledger pattern | `awsLedgerService.ts`, `userLedgerService.ts`, `lib/kgLedger.ts` | ✅ (reuse for audit) |
| Outbound MCP server | `mcp-server/src/index.ts` | ✅ (minimal — extend) |

**Key insight:** `knowledge_graph` already stores `decisions` and `action_items` as
JSONB per meeting, with cross-meeting linking computed server-side (Turbopuffer ANN → `kg_edges`).
The OS layer turns those extracted action_items into **real, executed actions** and
pulls in **external context** so decisions are well-informed. The KG **background sweep**
(`kgSweep` — EventBridge → Lambda → idempotent upsert → Turbopuffer) is already the
reusable **connector-sync engine** L1/L2 need; new connectors plug into that pattern.

---

## 4. Architecture — 6 Layers (mapped to this codebase)

```
┌──────────────────────────────────────────────────────────────────────┐
│ L6  TRUST & SAFETY   permissions · approvals · audit ledger · sandbox ·│
│                      evals · rollback        (NEW — differentiator)    │
├──────────────────────────────────────────────────────────────────────┤
│ L5  ACTION           execute writes across tools (broker-mediated) NEW │
├──────────────────────────────────────────────────────────────────────┤
│ L4  REASONING        context → decisions → proposed actions            │
│                      (extend geminiService / OpenRouter; Claude for    │
│                       agentic steps via OpenRouter)                    │
├──────────────────────────────────────────────────────────────────────┤
│ L3  MEMORY           AWS RDS Postgres (truth) + turbopuffer (vector)   │
│                      + canonical knowledge_item (NEW, unifies sources) │
├──────────────────────────────────────────────────────────────────────┤
│ L2  INGESTION        normalize every source → knowledge_item     NEW   │
├──────────────────────────────────────────────────────────────────────┤
│ L1  CAPTURE/CONNECTORS  meetings (✅) + external connectors (NEW)       │
└──────────────────────────────────────────────────────────────────────┘
```

- New code lives under `src/services/connectors/`, `src/services/actions/`,
  `src/services/trust/`, following the existing flat `src/services/*.ts` pattern.
- Sync workers that must run server-side (scheduled Jira/Gmail pulls, webhooks) run as
  EventBridge-scheduled `__job` routes in the AWS Lambda (`wisprnote-api`) + API Gateway
  webhook routes — reuse the proven `kgSweep` pattern; the desktop app stays a client.
- Tauri Rust (`src-tauri`) only for things needing native access (secure secret
  storage via keychain, local file capture). Business logic stays in TS.

---

## 5. Tech Stack (locked — matches the repo)

| Concern | Choice |
|---|---|
| Desktop shell | **Tauri 2 + Rust** (`src-tauri`), React 19 + TS + Vite 6 + Tailwind v4 + React Router 7 |
| Editor / viz | TipTap, `react-force-graph-2d`, Motion |
| Source-of-truth DB | **AWS RDS Postgres** (every table scoped by `user_id`/workspace, enforced in the Lambda) |
| Vector DB | **turbopuffer** (existing `turbopufferService.ts`) |
| Transcription | Deepgram (realtime, Rust) + Gemini batch |
| LLM | **Gemini 3** primary (transcribe/notes/chat); **OpenRouter** for multi-model — route **agentic decision/action steps to Claude** (`claude-opus-4-8` / `claude-sonnet-4-6`) via OpenRouter for reliability on tool-use reasoning. Model versions pinned in the registries (`src/config/models.ts`, `aws/api/src/models/registry.ts`) |
| Auth | AWS Cognito (JWT verified in the Lambda) |
| Billing | Paddle |
| Serverless | AWS Lambda (`wisprnote-api`) + API Gateway (HTTP) + EventBridge (scheduled sync); Vercel `api/` only for share-preview/OG |
| Outbound MCP | extend `mcp-server/` (`@modelcontextprotocol/sdk`) |
| Jira | **Atlassian Rovo MCP** (`mcp.atlassian.com/v1/mcp`, OAuth) — see the MCP registry |
| Other SaaS | **Official remote MCP servers** (GitHub, Slack, Google Workspace) — pinned in `aws/api/src/mcp/registry.ts` |
| Secrets | OS keychain via Tauri (desktop); AWS Secrets Manager for the Lambda |

---

## 6. Canonical Data Model (L3 — the unifier)

The KG today is meeting-scoped. To be a brain, **all sources normalize into one
table**. Add alongside existing tables (do not break `knowledge_graph`/`task_history`).

```sql
-- NEW: unified ingestion target for every source (scoped by user_id/workspace in the Lambda)
create table knowledge_item (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null,                -- scoped in the Lambda (no Supabase auth.users)
  workspace_id uuid,                       -- align with existing workspace model
  source       text not null,              -- 'meeting'|'jira'|'gmail'|'github'|'slack'|...
  source_id    text not null,              -- 'PROJ-123', gmail msg id, task_history.id...
  type         text not null,              -- 'issue'|'email'|'comment'|'transcript'|'decision'
  title        text,
  body         text,                       -- plain/markdown (converted from source format)
  people       jsonb,                      -- {author, assignee, participants[]}
  links        jsonb,                      -- {blocks[],relates[],parent,thread,url}
  raw          jsonb not null,             -- full original payload — never lose data
  occurred_at  timestamptz,
  synced_at    timestamptz default now(),
  unique (user_id, source, source_id, type)
);

create table sync_state (                   -- per-connector incremental cursor
  user_id uuid, source text, scope text,
  cursor text, last_synced_at timestamptz,
  primary key (user_id, source, scope)
);

-- L6 ledger (Phase 3+). Mirrors existing ledger pattern (kgLedger/userLedger).
create table decision ( id uuid primary key default gen_random_uuid(),
  user_id uuid, meeting_id uuid, summary text, rationale text,
  decided_by jsonb, decided_at timestamptz, status text );
create table action ( id uuid primary key default gen_random_uuid(),
  user_id uuid, decision_id uuid, kind text,           -- 'jira.create'|'gmail.send'|...
  payload jsonb, risk text,                             -- 'low'|'medium'|'high'
  state text,                                            -- 'proposed'|'approved'|'executed'|'failed'|'rolled_back'
  approved_by jsonb, executed_at timestamptz, result jsonb, rollback_token jsonb );
create table audit_log ( id uuid primary key default gen_random_uuid(),
  user_id uuid, actor text, action_id uuid, event text, detail jsonb, at timestamptz default now() );
```

**turbopuffer:** one vector per `knowledge_item` (+ per comment); payload mirrors
`{id, source, type, people, occurred_at, workspace_id}` for filtered hybrid search.
Reuse `turbopufferService.ts` patterns; extend RAG retrieval to query across sources.

> ⚠️ Source bodies need converters before embedding: **Jira ADF→markdown**, Gmail
> MIME→text, Slack blocks→text, GitHub markdown. Put these in
> `src/services/connectors/<source>/normalize.ts`.

---

## 7. Connector Map (L1) — official vs. custom

Rule: **everything is reached through MCP servers** — official remote MCP where it
exists, community/self-host otherwise. Endpoints/auth/scopes are pinned in the **MCP
registry** (`aws/api/src/mcp/registry.ts`). Build custom only where no MCP exists
(local Claude Code / Codex sessions). Each connector declares *read*, *write*, or both.

| Tool | Role | Connection | Custom? |
|---|---|---|---|
| Wisprnote meetings | Capture | in-app (✅) | reuse |
| **Jira** | Read **+ Write** | Atlassian Rovo MCP (remote, OAuth) | mcp |
| Gmail | Read + Write | Google Workspace MCP (remote, OAuth) | mcp |
| Google Calendar | Read + Write | Google Workspace MCP (remote, OAuth) | mcp |
| Google Drive | Read | Google Workspace MCP (remote, OAuth) | mcp |
| GitHub | Read + Write | GitHub remote MCP (OAuth 2.1) | mcp |
| Slack | Read + Write | Slack MCP (remote, OAuth) | mcp |
| Claude Code sessions | Read | local `~/.claude` `.jsonl` (Tauri fs) | ⚙️ local (not MCP) |
| GPT Codex (OpenAI) | Read + reasoning | OpenAI API / export | ⚙️ local (not MCP) |

**Connector interface** (every connector implements this; lives in `src/services/connectors/`):
```ts
interface Connector {
  id: string;                                              // 'jira'
  backfill(scope: string, cursor?: string): AsyncIterable<KnowledgeItem>;
  incremental(scope: string, since: Cursor): AsyncIterable<KnowledgeItem>;
  actions: ActionDef[];          // each: name, JSON schema, risk: 'low'|'medium'|'high'
  execute(action: string, payload: unknown): Promise<ActionResult>;
  rollback(token: RollbackToken): Promise<void>;
}
```

### Jira access logic — underlying REST (now reached via the Atlassian Rovo MCP server)
> Access is through the **Atlassian Rovo MCP** server (MCP registry). The REST shape
> below is the underlying API / self-host fallback for reference.
```
1. GET  /rest/api/3/project/search                  → discover projects
2. POST /rest/api/3/search/jql                       → bulk pull (loop nextPageToken)
        { jql, maxResults:100, fields:[...], expand:["renderedFields"] }
3. GET  /rest/api/3/issue/{key}/comment              → human context per issue
Sync   backfill: jql="project=X ORDER BY created ASC"
       incremental: jql="updated >= '<last_sync>' ORDER BY updated ASC"  (cron 15m via EventBridge → Lambda)
       + webhooks (jira:issue_updated, comment_created) for near-real-time
Write  POST /issue · PUT /issue/{key} · POST /issue/{key}/comment · POST /issue/{key}/transitions
Auth   Authorization: Basic base64(bot@co:API_TOKEN)   (dedicated service account)
```

---

## 8. Trust & Safety Layer (L6) — the differentiator, build early

- **Credential broker** — agents act *through* a broker that holds tokens (keychain / AWS Secrets Manager) and **never exposes raw credentials**; it validates each action
  against policy before firing.
- **Approval flows** — human-in-the-loop by default, risk-tiered:
  `low` (internal comment) → auto per policy · `medium` (create/edit ticket, draft
  email) → one approval · `high` (external send, prod transition, delete) → explicit.
- **Audit ledger** — every action attributed (meeting → decision → approver → result),
  timestamped, queryable. Reuse the existing ledger pattern (`kgLedger`/`userLedger`).
- **Sandbox + evals** — dry-run mode; new workflows must pass eval sets before running
  live (use Braintrust — already a sibling dependency).
- **Rollback** — every write stores a `rollback_token` to undo it.

---

## 9. Phased Roadmap

> **Execution detail:** see **`IMPLEMENTATION_PLAN.md`** — the concrete,
> codebase-grounded, non-breaking build sequence (file-level tasks, what each phase
> reuses, acceptance gates). This section is the vision-level summary.

Each phase is independently shippable and leaves the app working. Don't start a phase
until the previous **Acceptance** passes on real data. Track with TaskCreate/TaskUpdate.

### Phase 0 — OS Foundations
**Goal:** scaffolding the OS layers plug into, without disturbing current features.
- `knowledge_item` + `sync_state` tables (RDS; `ensure*Schema()`-style migration in the Lambda, like `kg_embeddings`), user_id-scoped.
- Connector framework + `Connector` interface + registry (`src/services/connectors/`).
- Secret/credential storage via Tauri keychain (desktop) + AWS Secrets Manager (server); broker stub.
- Lambda `__job` route + EventBridge schedule for sync, API Gateway route for webhook intake (reuse the `kg-sweep` pattern).
**Acceptance:** migrations apply; a no-op connector registers and runs end-to-end into
`knowledge_item`; existing app unaffected (`npm run lint`, `vitest` green).

### Phase 1 — First external connector: Jira (read)
**Goal:** prove external context flows into the existing brain.
- Jira direct-REST read connector (backfill + incremental + webhook, §7).
- Normalize ADF→markdown; upsert into `knowledge_item`; embed into turbopuffer.
- Surfaces in existing **ChatPage / RAG** — ask about Jira issues, get cited answers.
**Acceptance:** real Jira issues + comments are queryable in chat with citations;
re-sync is idempotent (`unique(user_id, source, source_id, type)`).

### Phase 2 — Context Fusion (remaining read connectors)
**Goal:** the company memory layer — answer across all sources.
- Read connectors: Gmail, Calendar, Drive, GitHub, Slack, Claude Code, Codex.
- Extend RAG retrieval to hybrid search across sources + rerank.
- Expose `brain.ask` / `brain.search` (read-only) via `mcp-server/`.
**Acceptance:** a cross-source question (meeting + Jira + email) returns a correct,
cited answer; scheduled incremental sync keeps sources fresh.

### Phase 3 — Decisions + Proposed Actions + Approvals (**the OS turn**)
**Goal:** meeting → proposed actions → human approves → recorded. No silent writes.
- Extend extraction (build on `knowledge_graph.decisions/action_items`) to produce
  concrete **action proposals** cross-referenced with systems of record
  (e.g. "create PROJ ticket, assign Alice, due Fri"; "draft follow-up email").
- `decision`/`action`/`audit_log` tables; **approval queue UI** (new page/panel);
  risk tiers; dry-run executors (no real writes yet).
**Acceptance:** from a real meeting, ≥3 correct actions land in an approval queue;
approve/reject is logged; nothing executes without approval.

### Phase 4 — Action Execution + full Trust & Safety
**Goal:** Brain completes work, safely.
- Real writes: Jira, Gmail, Calendar, GitHub, Slack (broker-mediated, §8).
- Credential broker + policy engine; idempotency keys; rollback per action kind.
- Braintrust eval gates + sandbox before any workflow may auto-run.
**Acceptance:** an approved action executes in the real tool, is auditable end-to-end,
and is reversible; high-risk actions can't bypass approval; evals pass.

### Phase 5 — Workflow Templates + Team Brain
**Goal:** encode repeated org workflows; shared multi-user brain.
- Templates (standup → ticket updates; sales call → CRM + follow-up).
- Auto-execute `low`-risk per policy; scheduled/triggered workflows.
- Team brain via existing **workspace** model + Lambda-enforced user_id/workspace
  scoping; per-user permissions = connector visibility.
**Acceptance:** ≥1 template runs trigger→recorded outcome with correct approvals; two
users share a workspace brain scoped to their permissions.

### Phase 6 — Cross-Platform Packaging & Hardening (macOS · Windows · Linux)
**Goal:** shippable, signed installers on all three OSes.
- ⚠️ **Biggest risk:** native capture (`cidre`, NSPanel, App Nap, macOS mic) is
  **macOS-only**. Port system-audio + mic capture to Windows (WASAPI) and Linux
  (PipeWire/PulseAudio); gate native code per `cfg(target_os)`.
- `tauri build` matrix; macOS signing+notarization, Windows signing, Linux AppImage/deb.
- Auto-update; crash reporting; first-run onboarding + connector OAuth.
**Acceptance:** signed installers install and run on clean macOS/Windows/Linux;
capture works on each; auto-update works; onboarding connects Jira + one Google service.

---

## 10. Cross-Platform & Security Notes
- Capture parity is the porting cost — design connectors/UI cross-platform from the
  start; isolate OS-specific Rust behind `cfg(target_os)`. Spot-check non-mac early.
- Secrets: keychain (desktop) / AWS Secrets Manager (server). Never commit or log raw
  tokens; `raw` payloads stay in user_id-scoped tables only (scoping enforced in the Lambda).
- Least privilege: each service account's visibility *is* the brain's visibility.
- No silent caps: if sync/search truncates (top-N, sampling, no-retry), `log()` it.

---

## 11. Dev Commands & Conventions
| Task | Command |
|---|---|
| Web dev | `npm run dev` |
| Desktop dev | `npm run tauri:dev` |
| Desktop build | `npm run tauri:build` |
| Typecheck (lint) | `npm run lint` (`tsc --noEmit`) |
| Tests | `npm test` (vitest) |
| MCP server | `cd mcp-server && npm run dev` |
| DB migrations | `ensure*Schema()` in the Lambda (e.g. `kgEmbed.ts`) + `aws/migration.sql` |

**Conventions**
- ESM + TS. Match existing `src/services/*.ts` flat-service style and naming.
- Connectors isolated + swappable (§7 interface); no connector logic leaks into L3/L4.
- **All writes go through L6** (broker + ledger) — never call a tool's write API from
  business logic directly.
- Idempotent ingestion everywhere (upsert on the unique key).
- Route agentic tool-use reasoning to Claude via OpenRouter; keep Gemini for
  transcription/notes/assets.

---

## 12. Definition of Done (every phase)
1. Acceptance criteria pass on real data (not mocks).
2. Idempotent + safe to re-run.
3. `npm run lint` + `npm test` clean; tests for new logic.
4. Works on macOS (primary); platform gaps noted for Phase 6.
5. This `CLAUDE.md` + `PROJECT_DOCUMENTATION.md` updated if a decision changed.

---

## 13. Glossary
- **knowledge_item** — canonical normalized record; one schema for all sources.
- **Connector** — module that pulls context and/or executes actions for one tool.
- **Decision ledger** — recorded chain: meeting → decision → action → outcome.
- **Broker** — trust-layer mediator; validates/executes actions, hides credentials.
- **Action system** — software that completes work and updates systems of record, vs.
  a chatbot that only suggests.

*When in doubt about scope, return to §2 (the OS Loop): if it doesn't advance the
loop, defer it.*
