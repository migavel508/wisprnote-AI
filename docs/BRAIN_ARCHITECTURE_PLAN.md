# Brain Architecture Plan — Codebase Review → Enterprise Target

> Companion to `BRAIN_NORTH_STAR.md` (the vision). This is the engineering audit of what the
> brain actually is in code today, why it can't reach the vision on its current skeleton, and
> the architecture to evolve it into the product's core strategic layer: **a per-space brain
> that grows continuously as meetings happen, connectors join, and users collaborate.**
> Evidence from the live code, 2026-06-29. Plan only — no code changed.

---

## 1. What the brain IS today (2,938 lines, honestly assessed)

### 1.1 Two parallel knowledge systems that don't share a spine
The codebase contains **two** independently grown knowledge pipelines:

| | System A: "KG" (meeting-only) | System B: "Brain" (connectors) |
|---|---|---|
| Extraction | `kgExtract.ts` → topics/decisions/people/action_items | none (raw connector payloads) |
| Store | `knowledge_graph` JSONB per meeting | `knowledge_item` row per item |
| Embedding | `kgEmbed.ts` → turbopuffer ns #1 | `connectors/embed.ts` → turbopuffer ns #2 (`lumina-knowledge-items`) |
| Linking | `kgLink.ts` → `kg_edges` | `connectors/brainLink.ts` → `brain_edge` |
| Cron | kg-sweep (2 min) | connector-sync (15m) + brain-enrich (1h) + brain-link (15m) |

Two extraction philosophies, two vector namespaces, two edge tables, five crons. The meeting
understanding (System A) and the brain map (System B) are **siblings that don't talk**: the
richest signal we compute — decisions, action items with owners, referenced tools — never
becomes brain edges.

### 1.2 The critical waste: extraction claims are discarded at linking time
`kgExtract` already produces, for every meeting: **people**, **action items with owners and
related topics**, and **references** ("documents, tools, resources mentioned"). These are
exactly the *claims* the north star's "bind at ingestion" requires — person→task→tool→project
bindings, computed once, by an LLM, at understanding time.

Then `brainLink` throws all of that away and **re-derives** associations from raw text
embeddings + a second LLM verdict. We pay twice (extraction LLM, then verdict LLM) and link
worse (similarity instead of claims). This is the single biggest architectural miss — and the
cheapest to fix, because the claims already exist in `knowledge_graph`.

### 1.3 A new item crosses up to 5 asynchronous stages before it means anything
`sync (15m cron)` → `meetingIngest` → `embed (batch 96)` → `enrich/fingerprint (1h)` →
`brain-link (15m drain)` → `verdict (LLM)` → `suggestion reasoner (1h)`. Each stage has its own
cursor, cadence, and failure mode; nothing is event-driven. A user adds a connector and watches
orphan nodes for up to an hour. The pipeline is a **relay of crons**, not a nervous system.

### 1.4 The brain is per-USER, not per-SPACE (the enterprise blocker)
Every brain table is keyed `user_id` first; `knowledge_item`'s original unique key is
`(user_id, workspace_id, source, source_id, type)` — `space_id` was retro-fitted via ALTER.
`space_members` exists, but the brain never reads it: **two users in the same space each have
(or don't have) their own private copy of the brain.** "Any users connected within that space,
we build a brain around them" is not representable today. This is the deepest schema decision
to change, and everything else should be built on the corrected keying.

### 1.5 No thread/state primitive
`brain_edge` + `brain_event` + `brain_reasoning` record items, transitions, and verdicts — but
nothing represents "an unresolved piece of work moving through tools." Off-track alerts are SQL
heuristics recomputed per request, not state the brain holds. (North star: the open loop.)

### 1.6 Fragile economics
The whole pipeline hard-depends on two external APIs with no budget governance — when Gemini
credits ran out, embedding, linking, and suggestions all silently flatlined (verified via
`llm-probe`). Silent `catch {}` everywhere means the brain degrades invisibly. For an
enterprise product, the brain needs cost tiers, quotas per tenant, and loud degradation.

### Verdict on the current implementation
The parts are real (canonical item store, vector index, edge model, HITL rails, per-space
credentials). The wiring is immature: **duplicated pipelines, discarded claims, cron-relay
latency, per-user scoping, no state, no cost governance.** It maps context; it doesn't yet
understand, and it cannot yet be shared. Assessment: right ingredients, wrong skeleton.

---

## 2. Target architecture — "the space brain"

**One sentence:** every SPACE owns exactly one brain — a continuously-updated, shared,
stateful graph built from that space's meetings + that space's authorized connectors —
updated event-first at ingestion, refined by background reasoning, consolidated on a rhythm,
and consumed by every other feature (map, activity, suggestions, chat, agents).

### 2.1 The keying (fix first — everything sits on it)
- Brain tables re-keyed to **`(space_id)` as the owning scope**: `knowledge_item`,
  `brain_edge`, `brain_event`, `thread`, vectors (turbopuffer namespace or filter per space).
- **Membership, not ownership:** `space_members` decides who can see/query a space's brain.
  The creator's `user_id` becomes provenance ("who brought this item"), not the boundary.
- Connector authorization stays exactly as we enforced it: a credential belongs to one
  `(workspace, space)`; the brain of space S may only contain items synced by S's credentials.
- Tenancy: `user_id`/org checks enforced at the API boundary (as today), but reads resolve
  through membership. This unlocks the actual product promise: a team's shared brain.

### 2.2 One pipeline, event-first (merge System A into System B)
```
EVENT (meeting saved | connector webhook | sync tick)
  └► INGEST (normalize → knowledge_item, space-keyed)
      └► UNDERSTAND (ONE extraction pass: topics, decisions, action_items,
          people, references — the claims)                        [LLM once]
          └► BIND (claims → edges, deterministic, ZERO LLM):
              provenance (proposal→ticket)      confidence 1.0
              reference  (PROJ-3, repo#42)     0.95
              entity     (same people/tickets)  0.8
              temporal   (same thread window)   0.6
              semantic   (ANN nearest, capped)  weak prior only
              └► THREAD TEST: does this item advance/close an open thread?
                  └► REFINE (async, budgeted): LLM verdict colours edges;
                      suggestion reasoner proposes actions
                      └► CONSOLIDATE (nightly): merge, prune, promote, compress
```
- `kgExtract`'s output feeds BIND directly — extraction claims become edges the moment the
  item lands. **No item is ever visible as "no links yet" if any claim exists.**
- The relay of five crons collapses to: (1) an ingest worker (event-driven; the sync cron
  remains only as the poller for webhook-less connectors), (2) a budgeted refine worker,
  (3) a nightly consolidation. The drain guarantee we added stays as the refine worker's
  contract (pending → 0).

### 2.3 The thread ledger (the brain's working memory)
New first-class `thread` per space: `{state: open|advancing|resolved|stale, kind:
decision|question|commitment, title, opened_by (meeting), evidence[] (items+edges),
expected_next, last_advanced_at}`. Threads open at UNDERSTAND (a decision or open question
creates one), advance at BIND (a ticket/commit/message attaches), and close when evidence
resolves them. Off-track = expectation violations on threads, replacing the per-request SQL
heuristics. The map's default lens becomes threads; suggestions and agent sweeps read open
threads instead of re-scanning meetings.

### 2.4 Continuous evolution (the enterprise contract)
- **New connector added** → its items flow the same INGEST→BIND path; entity claims (ticket
  keys, people, repos) immediately weave them into existing threads. The brain visibly grows
  within seconds of authorization — no full-space relink.
- **New meeting** → UNDERSTAND emits claims; BIND attaches to open threads; the map updates
  live (progress endpoint already exists for visibility).
- **New member joins the space** → sees the same brain instantly (membership read).
- **Connector-agnostic contract:** a connector's only obligations are `normalize()` (→
  knowledge_item) and optional `entities()` (ticket keys, people, urls). Slack/Gmail/Calendar
  slot in with zero changes to the brain core.

### 2.5 Cost + reliability governance (enterprise-grade)
- **Model tiers:** deterministic BIND costs $0; extraction on a cheap/fine-tuned model
  (see the fine-tuning strategy — extraction is the #1 candidate); verdict on a budgeted
  premium tier; consolidation on cheap batch.
- **Budgets:** per-space daily LLM/embedding budgets; when exhausted, the brain keeps
  binding deterministically and marks refinement "deferred" — degradation is visible
  (`/brain/progress` already carries the signal), never silent.
- **Observability:** pipeline lag (event→linked p95), claims-per-item, thread counts by
  state, provider spend per stage — logged as structured metrics; the `llm-probe`,
  `brain-map-debug`, `space-leak-report` diagnostics we built become permanent health checks.
- **Loud failure:** replace silent `catch {}` in the pipeline with recorded stage errors
  surfaced in progress/health.

---

## 3. Migration path (each phase shippable, non-breaking)

- **P0 — Space keying + membership reads.** Add space-first keys/indexes; reads resolve via
  `space_members`; backfill current data (Pilot etc.). *Unlocks: shared team brain.*
- **P1 — Claims → edges (bind at ingestion).** Wire `knowledge_graph` output into edge
  creation (people/references/action-item claims); connector entities (ticket keys in commit
  messages already parsed) same path. Kill semantic-as-backbone; keep it as capped prior.
  *Unlocks: no orphans, meaningful links, ~half the LLM spend.*
- **P2 — Event-first ingest.** Meeting-save and connector webhooks trigger the pipeline for
  that item immediately; crons remain as pollers/sweepers only. *Unlocks: live brain.*
- **P3 — Thread ledger.** Table + open/advance/close logic + threads lens in the map +
  off-track from thread state; suggestion engine reads open threads. *Unlocks: the chief-of-
  staff answer (what's open, what's slipping).*
- **P4 — Consolidation + governance.** Nightly merge/prune/promote/compress; budgets, tiered
  models (incl. the fine-tuned extractor), health metrics. *Unlocks: enterprise scale + cost.*
- **P5 — Unify the KG legacy.** Fold `kg_edges`/namespace #1 into the space brain; one vector
  index, one edge model; retire duplicate pipeline. *Unlocks: one spine, half the surface.*

Ordering rationale: P0 is schema-level and everything else keys on it; P1 is the highest
user-visible payoff per unit risk and *reduces* cost; P2–P3 deliver the vision; P4–P5 harden.

---

## 4. Fit check against the north star

| North-star principle | Where it lands in this architecture |
|---|---|
| Binding at encoding | P1/P2 — UNDERSTAND→BIND at ingest, claims become edges immediately |
| Association by shared context, not resemblance | P1 — signal hierarchy, semantic demoted to capped prior |
| Open loops held, not filed | P3 — thread ledger |
| Consolidation (sleep) | P4 — nightly rhythm |
| Recall, not rendering | P3+ — threads lens; spreading-activation view on the map |
| Brain grows with the org | §2.4 — connector-agnostic contract + event-first + membership |
