# Scaling the All-Meetings Agent to 10k+ Meetings — Architecture Plan

> Goal: the all-meetings chat answers **any** prompt over **10k+ meetings (and growing)**
> without ever overflowing context, erroring mid-stream, or silently dropping data —
> with a proper agentic loop, sub-agent orchestration for complex tasks, and
> high-quality synthesized answers.
>
> Modeled on the reference agent architecture in `/Users/migavelaishwin/Downloads/src`
> (Claude Code): **retrieve don't enumerate · bounded loop + compaction · sub-agent
> fan-out · stream with graceful degradation.**

---

## 1. Non-negotiables

1. **Never enumerate everything into context.** No N-line meeting index in the prompt.
2. **Never break mid-response.** Overflow, a dead tool, a slow batch → graceful partial
   answer, never a stack trace in the chat.
3. **No silent caps.** Any bound (top-K, ceiling, sampling) is disclosed in the answer.
4. **Quality is not sacrificed for scale.** A 10k-meeting answer is as well-formed as a
   10-meeting one — because we answer from a pre-built index + a focused deep-read of the
   *relevant* subset, not a shallow skim of everything.
5. **Complex tasks fan out.** Broad/parallel work spawns bounded sub-agents; the parent
   holds only compact results.

---

## 2. Principles adopted from the reference (`/Downloads/src`)

| Reference pattern | Where in the reference | How we apply it |
|---|---|---|
| **Tools return content on demand** (Read/Grep), never the whole repo in context | `Tool.ts`, tool results | Meetings reached via `search`/`read` tools, never listed in the prompt |
| **Bounded turn loop** (`maxTurns`, `turnCount`) | `query.ts` | Keep `MAX_STEPS`, add a hard wall-clock + token budget per turn |
| **Compaction** — summarize/reset context when it grows (`turnCounter` reset on compact) | `query.ts` | Hierarchical reduce + rolling compaction of tool results in long loops |
| **Sub-agent Task fan-out** (`local_agent`, `in_process_teammate`) — child does a slice, returns a digest | `Task.ts`, `tasks/*` | `analyze_meetings` spawns batch sub-agents; parent gets one synthesis |
| **Stream events, degrade gracefully** | query event stream | Stream steps; on any failure emit a partial-result state, never throw to UI |

---

## 3. Current vs Proposed — the core of the plan

| # | Dimension | Current (today) | Proposed (10k-safe) | Why it scales / ref pattern |
|---|---|---|---|---|
| 1 | **Meeting discovery** | `getAllTaskIds()` — one request, `pageSize=10000`, **truncates >10k**, multi-MB each turn | A **router** that never lists all: counts + retrieval tools only; metadata paged/streamed and cached per session | Retrieve-not-enumerate (Tool.ts) |
| 2 | **Context the model sees** | Full meeting index (`N. Title (date) [id]`) injected into the **system prompt** → ~10k lines ≈ 200–400k tokens → **overflow** | Prompt holds only: total count + how to use `search`/`read`/`analyze`. Zero enumeration | Bounded context; tools on demand |
| 3 | **"List all my X" (global extraction)** | Live map-reduce, **read ≤150** in full, disclose rest | Answer from the **pre-built KG index** (`decisions`/`action_items` already extracted by `kgSweep`) → covers **all 10k**, no live reading | Offline pre-extraction; the KG is the index |
| 4 | **Targeted / topical queries** | turbopuffer hybrid search → top-K → read | Same, but **retrieval is the only entry**; deep-read only the K the index flags relevant (tens, not thousands) | ANN+BM25 retrieval, not scan |
| 5 | **Agentic loop bound** | `MAX_STEPS=10`, fixed | `MAX_STEPS` + **per-turn token & wall-clock budget**; loop compacts tool results when budget nears | `maxTurns` + compaction (query.ts) |
| 6 | **Sub-agent orchestration** | One `analyze_meetings` spawn, internal map-reduce, single ceiling (150) | **Coordinator → shard sub-agents**: scope is sharded into batches, each batch is a sub-agent returning a digest; a reducer sub-agent folds digests. Depth scales with work, not context | Task fan-out (Task.ts) |
| 7 | **Memory / context mgmt** | Hierarchical reduce (batch 30) | Hierarchical reduce **+ rolling compaction**: tool results older than K turns are summarized out of the live context | Compaction boundary (query.ts) |
| 8 | **Failure handling** | A bad batch → caught per-meeting; but a prompt overflow or provider error can **throw to the chat** | **Error boundary around the whole turn**: any failure → finalize with whatever was gathered + a "partial result" banner. Never an exception in the bubble | Graceful degradation |
| 9 | **Cost / latency at 10k** | Infeasible: overflow + 10k metadata + (if forced) 10k LLM calls | Bounded: 1 KG query (global) **or** top-K retrieval + ≤K deep-reads. Cost is O(relevant), not O(total) | O(retrieved), not O(all) |
| 10 | **Data model** | Per-meeting rows; KG separate; no unified index for chat | Canonical **`knowledge_item`** (already specced in `CLAUDE.md` §6) as the one retrieval target across sources | Single index, many sources |
| 11 | **Freshness** | Live read each turn (slow, redundant) | Scheduled `kgSweep` + incremental; chat reads the **fresh index**, not raw meetings | Pre-compute, query cheap |
| 12 | **Streaming UX** | Steps render, but can vanish if the turn throws | Durable streamed steps with explicit `running/done/partial/error` states; survive a failed turn | Stream + degrade |

---

## 4. Target architecture (layers + file map)

```
┌────────────────────────────────────────────────────────────────────┐
│ UI / STREAM    ChatPage steps: plan → retrieve → (fan-out) → synth   │
│                durable states: running·done·partial·error            │
│                src/pages/ChatPage.tsx · src/App.tsx (handlers)       │
├────────────────────────────────────────────────────────────────────┤
│ ORCHESTRATION  Router → Agentic loop (bounded + compaction)          │
│                → Coordinator → shard sub-agents → reducer            │
│                src/services/geminiService.ts (agentChatAllMeetings,  │
│                extractAcrossMeetings) + new chat/orchestrator.ts     │
├────────────────────────────────────────────────────────────────────┤
│ RETRIEVAL      KG index (global facts) + turbopuffer (relevance)     │
│                NO full enumeration. count + search + read + analyze  │
│                turbopufferService.ts · chatRetrievalService.ts ·     │
│                ragService.ts · (KG read) kgVector/knowledge_graph    │
├────────────────────────────────────────────────────────────────────┤
│ INDEX (offline) kgSweep pre-extracts decisions/action_items;         │
│                knowledge_item canonical rows; embeddings in tpuf     │
│                aws/api/src/kgSweep.ts · kgEmbed.ts · (new) ki sync   │
├────────────────────────────────────────────────────────────────────┤
│ STORE          AWS RDS (truth) + turbopuffer (vectors)              │
└────────────────────────────────────────────────────────────────────┘
```

**The decisive change:** the chat's entry point becomes **the index, not the meeting list.**
Discovery, global facts, and relevance all come from pre-built indexes; raw meetings are
touched only for the small relevant subset, on demand.

---

## 5. Orchestration model — loop + fan-out for complex tasks

**Router (first, cheap, deterministic + model-assisted):** classify the prompt →
- `global-extraction` ("all my action items / commitments / recap across everything") →
  **KG-index path** (read pre-extracted `action_items`/`decisions`; covers all 10k; no live reads).
- `topical / specific` ("what did we decide about X", "the rollout plan") →
  **retrieval path** (turbopuffer top-K → read those few in full).
- `broad-but-needs-reading` (nuanced synthesis the KG can't answer) →
  **fan-out path** (coordinator shards the *retrieved relevant* set, not all meetings).

**Fan-out (the sub-agent span for complex tasks), bounded like the reference's Task:**
```
coordinator
  ├─ shard 1 (≤30 relevant meetings) ─ sub-agent ─► digest 1
  ├─ shard 2                          ─ sub-agent ─► digest 2
  └─ shard k                          ─ sub-agent ─► digest k
                                   reducer sub-agent ─► answer
```
- Each sub-agent reads its shard, returns a **compact digest** (never raw transcripts up).
- The reducer folds digests (hierarchical, already built) → final synthesis.
- Parent context = digests only → **bounded regardless of total meetings.**
- Concurrency-capped; per-shard failure → that shard's digest = "unavailable", others proceed.

**Loop bounds (per the reference):** `MAX_STEPS` + a per-turn **token budget** and
**wall-clock budget**; when the budget nears, the loop **compacts** (summarizes older tool
results out of context) instead of overflowing.

---

## 6. Reliability — "never break mid-response"

1. **Turn-level error boundary** around `agentChatAllMeetings` / the orchestrator: any
   throw (overflow, provider 5xx, timeout) is caught and the turn **finalizes with what it
   has** + a visible "partial result — here's what I gathered" note. The chat never shows an
   exception.
2. **Pre-flight budgeting:** estimate tokens before each model call; if a context would
   exceed the window, **compact first** (never send an over-limit request).
3. **Per-unit isolation:** every per-meeting / per-shard call is independently try/caught →
   one bad meeting can't fail the answer (already true in the map-reduce; extend to shards).
4. **Disclosed bounds:** any top-K / ceiling / sampling is stated in the answer ("answered
   from your indexed commitments across all 10,212 meetings" or "deep-read the 40 most
   relevant of 312 matches").
5. **Idempotent, resumable:** "keep going" continues from a cursor (offset / next shard),
   not a restart.

---

## 7. Scale math (why it stays bounded)

| Meetings | Global-extraction (KG path) | Topical (retrieval) | Broad synthesis (fan-out) |
|---|---|---|---|
| 100 | 1 index query | 1 search + ~5 reads | 1 shard, ~1 reduce |
| 1,000 | 1 index query | 1 search + ~8 reads | 1–2 shards |
| 10,000 | 1 index query | 1 search + ~10 reads | top-K relevant → 1–4 shards |
| 100,000 | 1 index query (paged) | 1 search + ~10 reads | top-K relevant → bounded shards |

Cost is **O(relevant), never O(total)**. The prompt never carries the catalog. The only
O(total) work is the **offline** `kgSweep`, which already runs on a schedule server-side.

---

## 8. Phased rollout (non-breaking, each independently shippable)

**P0 — Stop the overflow (highest impact, lowest risk). ✅ DONE.** *Acceptance: a 10k-meeting
account answers without context overflow.*
- ✅ Bounded the in-prompt meeting index to the 40 most-recent + a disclosure that older
  meetings exist and must be reached via search/analyze (no full enumeration). (`geminiService.ts`)
- ✅ Session-cached `getAllTaskIds` (60s TTL, stale-but-usable on error); no longer
  re-fetched every turn. (`App.tsx`)
- ✅ Bounded the empty-query listing tool result (cap 60, disclosed remainder) so a global
  listing can't build thousands of sections. (`App.tsx`)
- ✅ Turn-level error boundary: any failure → calm, actionable message (suggest narrowing),
  never a raw error mid-response. (`App.tsx`)
- ⏭️ Deferred to P3: pre-flight token budgeting + rolling compaction inside the loop
  (true partial-result finalize). The bounds above remove the overflow trigger; P3 adds
  defense-in-depth.

**P1 — KG as ROUTER, notes as ANSWER (hybrid). ✅ DONE.** *Acceptance: global extraction
covers the right meetings at scale, but every item comes from the real notes (no
index-induced loss).*
- ⚠️ **Revised from "answer from the KG".** The KG is lossy — `action_items`/`decisions`
  are an extracted subset, not the notes/transcript — so answering from it alone drops
  informally-phrased commitments and nuance. Per that, the KG is now a **router only**.
- ✅ `kgExtractableFacet()` (action_items vs decisions) builds a **priority map** from the
  KG; the extract route orders meetings KG-priority-first, then recency, so a bounded read
  budget at scale is spent on the meetings most likely to contain relevant items.
- ✅ The answer is ALWAYS produced by the live map-reduce reading **actual notes** (full
  fidelity), via shared `foldAndReduceCards()`. Disclosure updated: "deep-read the actual
  notes of N meetings (prioritized by the index)…".
- ✅ Graceful: if the KG is unavailable, ordering falls back to pure recency; nothing breaks.
- ⏭️ Windowed / recent / nuanced (recap, themes, coaching) use the live path by design.
- ⏭️ Future: enrich `kgSweep` extraction (capture informal commitments) to shrink the
  index↔notes gap further. Optional "Fast (index-only)" mode can be re-added if wanted.

**P2 — Topic-aware retrieval routing (real notes stay the answer). ✅ DONE.** *Acceptance:
a topical broad request reads the RELEVANT meetings' real notes, not just recent ones.*
- ✅ `queryMentionsTopic()` (conservative — explicit topic marker only, so pure global
  requests aren't misrouted). When a topic is named, the extract route embeds the query →
  `queryHybrid` (wide net, 160) → relevance-ranked meeting ids → deep-reads THOSE real
  notes. Pure global → KG-priority + recency. (`App.tsx`)
- ✅ Coverage disclosed per mode ("most relevant to your topic" vs index-prioritized).
- Note: the answer is always read from real notes (transcript + summary + notes);
  retrieval/KG only choose WHICH notes to read.

**P3 — Fan-out + reducer + rolling-compaction safety. ✅ DONE.** *Acceptance: broad
synthesis over a large set stays bounded; the loop can't balloon.*
- ✅ The coordinator→shard→reducer is `extractAcrossMeetings`: per-meeting fan-out
  (concurrency-capped) + hierarchical `foldAndReduceCards` = a reducer hierarchy that
  bounds the synthesizer context at any scale.
- ✅ Agentic-loop guard: a per-turn `read_meeting_notes` budget (30) that nudges the model
  to `analyze_meetings` past the limit — prevents a huge read fan-out from growing context.
  (`App.tsx`)
- ⏭️ Deeper rolling compaction (summarize OLD tool results inside the provider loops) is
  still available as further defense-in-depth, but post-P0 the loop is already bounded.

**P5 — Resumability + freshness. ✅ DONE.** *Acceptance: "keep going" continues from a
cursor; the index stays fresh.*
- ✅ Resumable cursor (`extractCursorRef`, thread-scoped): a capped extract stores the
  ordered candidate ids + how many were covered; an affirmative follow-up ("keep going",
  "continue", "yes") reads the NEXT batch and advances the cursor — never restarts.
  Extracted a shared `deepReadExtract()` helper so the first pass and continuations share
  one code path. (`App.tsx`)
- ✅ Freshness: the full-index cache has a 60s TTL AND is invalidated the moment a new
  meeting is saved, so just-recorded meetings appear immediately. Server-side incremental
  freshness is already handled by the scheduled `kgSweep`.

**P4 — Canonical `knowledge_item` cross-source index. ⏸️ SEQUENCED WITH CONNECTORS (not
built now — deliberate).** *Acceptance: chat retrieves across meetings + connectors from
one index.* (Aligns with `CLAUDE.md` §6.)
- Rationale (reference takeaway: don't build an abstraction before it has ≥2 real
  consumers): today there is exactly ONE source (meetings). A `knowledge_item` table +
  sync workers with nothing but meetings to fill it adds schema/migration surface and a
  second write path for **zero** chat benefit right now — the meeting path already scales
  (P0–P3) and stays fresh (P5).
- It becomes the right move the moment the FIRST external connector lands (Jira, per
  `CLAUDE.md` Phase 1): at that point the chat genuinely needs one retrieval target across
  sources, and `knowledge_item` should be built **with** that connector's ingestion +
  turbopuffer indexing, reusing the `kgSweep` sync pattern. Building it then (not now)
  avoids a speculative migration and a table that drifts before it has users.

---

## 9. Definition of done

- 10k+ account answers any prompt with **no overflow, no mid-stream error**, disclosed
  coverage, and quality equal to small accounts.
- Global "all my X" is answered from the index (all meetings); topical from retrieval
  (relevant only); broad synthesis via bounded fan-out.
- `npm run lint` + `npm test` green; behavior verified on a large synthetic account.
