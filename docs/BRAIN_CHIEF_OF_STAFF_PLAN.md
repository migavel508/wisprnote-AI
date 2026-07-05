# The Chief-of-Staff Brain — Critical Review & Next Architecture

> Where the brain stands after P0–P4, what's actually broken right now (verified against live data,
> 2026-07-03), and the architectural decisions that take it from "a connected graph with a ledger"
> to what the product promises: **a chief AI staff that knows what every meeting was, what's going
> on in the project from the codebase, the PM view from Jira, and everything else the user connects —
> all in one place.** Plan only.

---

## 1. Honest scorecard against the chief-of-staff bar

A real chief of staff does four things. Score today:

| Capability | Bar | Today | Grade |
|---|---|---|---|
| **Knows the facts** | every meeting, ticket, commit captured + connected | items sync, 33/33 meetings linked, claims bind at ingestion | **B+** |
| **Knows the state** | what's open / advancing / slipping / untracked | thread ledger + gap threads + hourly cron | **B** (dup bug, below) |
| **Understands meaning** | *why* work relates, does code match decisions, codebase awareness | verdict/enrich layers exist but are **credit-blocked**; semantic guesses re-inflating | **D** |
| **Tells you the story** | "here's what's going on" in one glance / one question | nothing — user must assemble it from map + threads + alerts + chat | **F — the missing product** |

The foundation (facts + state) is solid. The *product* — the narrative a chief of staff delivers —
does not exist yet. That's the headline of this plan.

### The accuracy problem (the deepest one) — the brain presents GUESSES as FACTS
A chief of staff who *confidently tells you wrong things* is worse than none. Right now the brain
does exactly that, and it's structural, not cosmetic:

- **94% of edges are unverified similarity.** POZ = 293 edges, only 18 are claim/verdict; 275 are
  `semantic` (embedding-nearest). A commit "linked" to a meeting at 0.4 cosine is usually NOT a
  real relationship — but the map draws it identically to a confirmed one.
- **Guesses are counted as evidence.** A thread's "7 linked commits" counts *any* edge, including
  semantic guesses — so the ledger's own facts ("someone started coding SCRUM-14") can be false.
  The brief and the chat answers would inherit this. **Confidence never propagates.**
- **I traded accuracy for coverage.** To kill isolated nodes I lowered the semantic floor to 0.40
  and forced 2 links/node. That *manufactured* connections. Coverage must come from more CLAIMS
  (accurate), never from a lower truth bar (inaccurate).
- **The layer that would VERIFY is off.** The LLM verdict validates whether a link is real — and
  it's credit-blocked, so nothing prunes the guesses.

**The accuracy principle for everything below:** the brain must separate CONFIRMED (provenance /
reference / entity / verdict) from POSSIBLE (semantic), **present confirmed as fact and possible as
hypothesis, count only confirmed as evidence, and ground every statement in citable data.** It must
never state a guess as a fact, and never inflate coverage by weakening the truth bar.

---

## 2. Critical fixes (verified live, fix before building up)

### CF-1 · Ghost threads from the sentinel bucket → duplicate ledger entries 🔴
Chat's `brain_threads` returned **SCRUM-14 and SCRUM-13 twice** (one copy with evidence, one with
none). Verified cause: **8 Jira issues still have duplicate rows in the sentinel bucket**
(`space-leak-report`: `dupAcrossSpaces: jira 8 items / 16 rows` — the "invisible leftover dups" we
deliberately deferred). `buildAllSpaceThreads` selects `DISTINCT space_id … WHERE source='jira'`
**including the sentinel**, so it builds a ghost ledger for a non-space; the chat tool reads by
`workspace_id` and returns both. Fix (3 parts): exclude `ACCOUNT_SCOPE` from thread building +
delete existing sentinel threads; sweep the 16 sentinel item rows (extend `brain-edge-cleanup`);
dedup any workspace-level ledger read by `(kind, anchor_source, anchor_source_id)` keeping the
best-evidenced row.

### CF-2 · Re-tier edges by TRUTH, not just de-dup — precision model 🔴
POZ is back to **293 edges: 275 semantic (94%) vs 18 claim/verdict**. This isn't only bloat, it's
*inaccuracy*. Root causes: (a) edges are **directional**, so A→B and B→A both insert — reciprocal
duplicates double-count; (b) per-run caps (`GH_XSRC_CAP=2`, connectivity `fb<2`) reset every relink
cycle, so cycles accumulate; (c) consolidation only supersedes semantic on the *same pair* — no
degree cap; (d) the **0.40 floor** manufactures weak links. Fix — a **precision model**:
- **Canonicalize direction** for semantic (order endpoint ids before insert) → no reciprocal dups.
- **Raise the semantic floor back to ~0.62** and **count existing** edges before adding (real cap).
- **Per-node semantic degree cap** in consolidation (keep strongest K, prune rest).
- **Tier every edge**: `class ∈ {confirmed, possible}` — provenance/reference/entity/verdict =
  *confirmed*; raw semantic = *possible*. This class is what downstream (evidence, brief, UI, chat)
  keys on. Coverage still comes from CLAIMS (CF handles isolation via bind, not a low floor).

### CF-5 · Confidence must PROPAGATE — count only confirmed as evidence/fact 🔴
Today a thread's evidence (`commits[]`, `meetings[]`) counts *any* edge, so "SCRUM-14 · 7 commits"
may be mostly semantic guesses — and the chief-of-staff answer built on it is then wrong. Fix:
- `buildSpaceThreads` counts evidence from **confirmed** edges only; a separate `related` field
  (clearly labelled "possibly related") holds the semantic ones. The state machine (advancing =
  "has commits") flips only on **confirmed** commits — no more false "someone started coding".
- The `brain_threads` chat tool + the Focus UI show confirmed evidence as fact and possible as a
  hedged hint ("~3 possibly-related commits"), never blended.
- Every claim edge already carries `confidence`; surface it end-to-end so nothing is presented
  more certainly than it is earned.

### CF-6 · Extraction / matching accuracy (garbage-in guard) 🟠
Downstream is only as accurate as the claims. Tighten the deterministic matchers: (a) **name/entity
normalization** — the misspelled-name + login↔display-name gap (the user's earlier fine-tuning
concern) makes entity-binding both miss and mis-match; a canonical people directory per space fixes
recall AND precision. (b) **Provenance back-reference guard** — matching a connector body against a
meeting TITLE false-positives on generic titles ("Project Planning"); require a distinctive title
(length + not-in-a-stoplist) or a stronger signal (the executed-proposal link). (c) **Multi-project
spaces** — gap-ticket project key is inferred from one prefix; handle >1 project per space or skip
rather than propose into the wrong project.

### CF-3 · Chat is workspace-scoped, not space-scoped 🟠
`agent-exec`/`buildAgentToolset`/`brain_threads` all key on `workspaceId` only. A user chatting
"in" POZ actually queries the whole workspace — blending spaces (against the isolation model we
enforced everywhere else) and producing cross-space noise like CF-1. Fix: thread the **active
space** through the chat request → toolset + every built-in tool filters by space (with workspace
as the explicit "all projects" mode, not the accidental default).

### CF-4 · The meaning layer fails silently (credits) 🟠
Verdict, commit enrichment, and the suggestion reasoner are all still credit-blocked and fail as
silent `catch {}` — the brain quietly stops *understanding* while appearing healthy. Fix: a tiny
**LLM health table** (provider → last status, checked by a scheduled `llm-probe`), surfaced in
`/brain/progress` as `meaning: degraded (provider credits)` and in the brain-map UI. Degradation
must be visible, never silent (this is also the enterprise trust story).

---

## 3. The powerful decisions — what makes it a chief of staff

### D-1 · THE SPACE BRIEF (the flagship — "all context in one place")
A **continuously-maintained executive digest per space** — the memo a chief of staff would hand
you: *what happened lately · what moved · what's open and slipping · what the code says is
happening · what's expected next.* Not a query the user runs — a **standing artifact** the brain
maintains.

- **Table:** `space_brief(space_id, generated_at, sections jsonb, narrative text)`.
- **Built in two tiers:** a **deterministic skeleton** (always available, $0) assembled from what
  we already compute — thread states, activity events, new items, gap threads, alert counts — and
  an **LLM polish** (budgeted, when credits exist) that turns the skeleton into 6–10 sentences of
  actual narrative with the "why".
- **Refreshed** by the hourly threads cron + after every on-demand sync (event-first, like bind).
- **Consumed everywhere:** brain-map header ("This week in POZ…"), the space home, a `brain_brief`
  chat tool (the answer to "what's going on?"), and the Slack digest the user already wants to post.
- This single artifact is what converts the graph from *inspectable* to *useful*.

### D-2 · Topic threads — the meeting-to-meeting story
Ticket threads track *work*; nothing tracks *conversations*. `kgExtract` already emits topics with
`status: new|ongoing|resolved|off-track` per meeting — promote **recurring topics across meetings**
into topic threads (same `brain_thread` table, `kind='topic'`, anchored on a normalized topic):
"SDLC planning — discussed in 6 meetings over 3 weeks, still unresolved." This is the
meeting↔meeting continuity the user keeps asking for, built from data we already extract, $0.

### D-3 · Codebase + PM awareness rolled INTO the brief
"Knows the project by looking at the codebase" = the enrichment we have, aggregated: commit diff
summaries (`brain-enrich`) + dev-session digests + advisory assessments roll up into the brief's
**engineering section** (what shipped, where risk was flagged); Jira thread states roll up into the
**PM section** (velocity of movement, stuck ratio). Each new connector type (Slack → discussions,
Calendar → upcoming commitments) adds a section via the same contract — connector-agnostic.

### D-4 · One understanding spine (execute P5 now)
Two extraction/embedding/linking pipelines (`kg*` vs `brain`) split every token of LLM budget and
every hour of maintenance across duplicate machinery. Folding `kg_edges`/namespace-1 into the brain
(one extraction → claims; one vector index; one edge model) halves the surface *and* the spend —
which is exactly what the credit fragility punishes.

### D-5 · Budget governance (the enterprise contract)
Per-space daily LLM/embedding budget (`space_budget`), tiered models per stage (extraction on the
cheap/fine-tuned tier — the user's fine-tuning plan slots here; verdict/brief-polish on premium),
hard stop at budget with visible "deferred" state. The deterministic layer (bind, threads, brief
skeleton) never stops; the meaning layer degrades **visibly**.

### D-7 · GROUNDED, cited output — accuracy the user can check
The brief (D-1) and every chat answer must be **generated only from confirmed evidence and must
cite it** — "SCRUM-14 is stalled (In Progress, 3 confirmed commits, last moved Jun 25)" with the
node ids behind each claim, so any statement is one click from its source. Rules baked into the
brief-polish + chat prompts: use only the confirmed skeleton as ground truth; mark anything from
the `possible` tier as "possibly / appears to"; if evidence is thin, say "insufficient signal"
rather than inventing. This bounds hallucination and makes the chief-of-staff *trustworthy*, which
for an enterprise buyer matters more than being comprehensive. (Pairs with the resilience+honesty
directive already shipped for tool use.)

### D-6 · Chat = the chief-of-staff interface ✅ (deployed 2026-07-03)
The chat agent now has the full builtin set: `brain_brief` (the narrative), `brain_threads` (deduped
work-state), `brain_search` (atom+graph-aware retrieval), and `brain_lineage` (a node's story: trace a
ticket/meeting/commit through brain_edge → what spawned it, what implements it WITH the verdict, its
work-state — confirmed lineage as fact, semantic as clearly-labeled "possibly related"). "What's going
on with the audit project?" is answered the chief-of-staff way — brief first, evidence on request —
instead of the model reassembling raw search hits. (Space-scoping of these tools = CF-3, client rebuild.)

---

## 4. Sequence (each step shippable, verified before the next)

1. ✅ **DONE (deployed 2026-07-03) — ACCURACY FIRST — CF-1 + CF-2 + CF-5** — swept sentinel dups +
   ghost threads; re-tiered edges (confirmed vs possible, canonical direction, higher floor, degree
   cap); confidence propagates so threads/UI/chat count only confirmed evidence. POZ verified: 293
   edges/94% semantic → 33 edges/55% confirmed; no dup threads; `dupAcrossSpaces` empty.
2. **CF-3 + CF-6** — space-scoped chat (CF-3 needs a client rebuild to send `spaceId` — DEFERRED);
   ✅ **CF-6 DONE (deployed 2026-07-03)**: multi-project gap guard + entity/name normalization
   (`nameLookupKeys` bridges display-name↔login: "John Smith"↔"jsmith"/"johnsmith") + provenance
   back-reference title guard (`isDistinctiveTitle` — a generic title like "Project Planning" no
   longer forges provenance). ALSO made the connectivity pass CROSS-SOURCE ONLY + a consolidate pass
   strips same-source semantic (meeting↔meeting is now TOPIC-thread territory, not map noise).
3. ✅ **DONE (deployed 2026-07-03) — D-1 skeleton + D-7** — `space_brief` table + deterministic tier
   generated from confirmed evidence, `brain_brief` chat tool, `brain-brief` job, auto-refresh on the
   threads cron. POZ narrative verified grounded. Brain-map-header surfacing needs the client rebuild.
4. ✅ **DONE (deployed 2026-07-03) — D-2** — topic threads from existing kg topics (`buildSpaceTopics`,
   deterministic $0, no new tokens): recurring topics (≥2 meetings) → `topic` threads with derived
   state; brief gained a `conversations` section + narrative; `brain_threads` renders `OPEN LOOP`.
   POZ verified: "Web Validation Layer Prototype (2 meetings, latest revisited)".
5. ✅ **DONE (deployed 2026-07-03) — CF-4 + D-5** — `budget.ts`: `llm_health` table + `checkBrainBudget`
   (per-user daily, env `BRAIN_DAILY_TOKEN_BUDGET`, default 3M); runBrainLink gates the premium verdict
   pass → over-budget = deterministic-only + visible `brain_budget_deferred`; `/brain/progress` returns
   `meaning:{status,providers,budget}`. Tiering already correct in the registry. Live probe revealed:
   **Anthropic key INVALID (401 auth, not credits); Gemini + embeddings WORK** — meaning layer is
   *degraded*, not dead. Once the Anthropic key is fixed (or via Gemini fallback), the verdict backfill
   VERIFIES the `possible` tier (promotes true, prunes false) and brief LLM-polish lights up.
6. **D-3** — engineering/PM sections enriched (needs credits for diff summaries).
7. **D-4 — fold the legacy KG pipeline (one spine)** — ◐ IN PROGRESS. Dependency map (2026-07-03):
   most of the legacy pipeline is LOAD-BEARING — `kg_edges` feeds the KnowledgePage force-graph UI via
   `/knowledge-graph/edges`; `knowledge_graph` (JSONB) is the SHARED claim source brainBind/threads/
   brief read; `kg_embeddings` meeting vectors + `lumina-kg-meetings` feed kgLink→kg_edges→UI. Full
   retirement needs the UI to move to `/brain/graph` (a CLIENT REBUILD) — DEFERRED with the other
   client-rebuild items. ✅ **SAFE FOLD SHIPPED (deployed 2026-07-03):** killed the dead per-topic
   embeddings in kgEmbed — `kind='topic'` vectors were WRITTEN but every reader filters `kind='meeting'`
   (never read), so each meeting was paying to embed all its topics for nothing (~80% of the kg embed
   pass was waste). Now meeting-vector only. **Remaining fold (server-side, needs care):** the meeting
   is embedded in 3 places (kgEmbed→kg_embeddings/lumina-kg-meetings; embed.ts→lumina-knowledge-items;
   brainLink query vectors) — unify to one embed with a shared vector (consistency-sensitive: query &
   stored vectors must derive from the same text). Then, post-UI-migration: disable kgLink, retire
   kg_edges + `lumina-kg-meetings`.

**The test of success** stays the north star's, now with accuracy as a gate: a user away for a week
opens a space (or asks chat "what's going on?") and gets — in one glance — what happened, what
moved, what's open, what's about to slip, **and every statement is TRUE and traceable to its
evidence** (confirmed shown as fact, uncertain shown as uncertain, nothing invented). A brilliant
narrative built on wrong facts is a net negative; correctness is the precondition for trust, and
trust is the product.
