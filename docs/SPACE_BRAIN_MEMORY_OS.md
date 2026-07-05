# The Space Brain as a Knowledge-Graph Memory OS

> Target architecture for the space brain map: **one canonical memory store, indexed once,
> retrieved graph-aware, and measured with a benchmark (MemScore).** Grounded in the current code
> (verified 2026-07-03) — this is an *incremental* re-architecture that builds on the deterministic
> spine already shipped (accuracy fixes, threads, topics, brief, budget governance), not a rewrite.
>
> Goal, in the user's words: *a brain that knows and connects every end-to-end thing about a space —
> meetings and connectors — with better quality, better performance, and redundant cost cut down.*

---

## 1. The problem with today's storage (why this plan exists)

The D-4 dependency map found the brain's memory is **fragmented and paid for more than once**:

- **Two vector indexes.** `lumina-kg-meetings` (meetings only) + `lumina-knowledge-items` (all
  sources). Two schemas, two query paths, two things to keep fresh.
- **A meeting is embedded up to 3×** per cycle (kgEmbed → `kg_embeddings`+`lumina-kg-meetings`;
  `embed.ts` → `lumina-knowledge-items`; brainLink → ephemeral query vectors). Triple embedding spend
  for one meeting.
- **One vector per whole item.** A 60-minute transcript is compressed into a *single* 3072-dim
  vector. Retrieval can't find "the decision about pricing" inside it — the vector is an average of
  the entire meeting, so precision is poor.
- **Retrieval is vector-only.** We have a rich graph (`brain_edge`: provenance/reference/verdict)
  but retrieval doesn't *use* it — it returns top-K nearest vectors and stops. The "knowledge graph"
  isn't in the loop at answer time.
- **No measurement.** We improve accuracy by inspection, not by a number. There's no MemScore, so
  "is the brain better?" is a vibe, not a fact.

The benchmark pipeline you shared — **Ingest → Index → Search → Answer → Evaluate → Report → MemScore** —
is exactly the shape a memory OS should have. Below, each stage becomes a concrete piece of our
architecture.

---

## 2. Target architecture — one memory spine, graph-aware retrieval

```
INGEST         every source → ONE canonical knowledge_item (✅ exists)
   │             meetings · jira · github · slack · local sessions → normalized
   ▼
INDEX          embed ONCE into ONE namespace, at the RIGHT granularity
   │             • item CHUNKS (transcript split by topic/decision, not one blob)
   │             • DERIVED atoms (decisions, action_items, topics) as first-class memories
   │             • rich metadata {space, source, type, people, occurred_at, entity, thread}
   │             • content-hash → embed only what CHANGED (idempotent, no re-embed)
   ▼
SEARCH         GRAPH-AWARE retrieval = vector seed + graph expansion + filters
   │             1. vector ANN over the unified index → seed memories
   │             2. walk brain_edge (CONFIRMED edges) from seeds → pull the connected
   │                lineage (meeting→ticket→commits), multi-hop  ← the "knowledge graph" part
   │             3. metadata + thread-state filters (space scope, recency, open/slipping)
   │             4. rerank by confidence · graph centrality · recency
   ▼
ANSWER         grounded generation over retrieved memory + graph context (brief/chat, ✅ partial)
   ▼
EVALUATE       MemScore harness — golden Q&A over a space → retrieval + answer + cost scores
   ▼
REPORT         accuracy · latency · tokens · MemScore  (regression-tested over time)
```

The shift in one line: **from "nearest-K vectors" to "seed-and-expand over a typed graph of
multi-granularity memories, then measure it."**

---

## 3. INDEX — the unified memory store (the core change)

### D-1 · One namespace, one embed
Collapse to a single turbopuffer namespace (`lumina-knowledge-items` becomes THE index). Retire
`lumina-kg-meetings`; `kgLink` reads meeting vectors from the unified index. **Each memory unit is
embedded exactly once**, keyed by a stable id + `content_hash` — re-sync/re-run never re-embeds
unchanged content. This alone removes the triple-embed and the dead second namespace.

### D-2 · Multi-granularity memory units (the quality unlock)
Index at the granularity retrieval actually needs:
- **Item chunks** — a meeting transcript is split into semantic chunks (by topic boundary /
  decision / ~500-token window). Each chunk is its own vector with `parent_item` metadata. Now
  "what did we decide about pricing" hits the *pricing chunk*, not an averaged whole-meeting vector.
- **Derived atoms** — every `decision`, `action_item`, and `topic` (already extracted in
  `knowledge_graph`) becomes its own indexed memory. These are the highest-signal units: a query
  about a decision retrieves the decision text directly, with a back-edge to its meeting.
- **Thread/brief summaries** — the work-state (thread ledger, space brief) is indexed too, so
  "what's the status of X" can retrieve a *derived-state* memory, not just raw text.

This is the episodic (raw chunks) + semantic (derived atoms) + working (threads) memory split of a
real memory system — all in one index, distinguished by a `unit_type` field.

### D-3 · Rich, filterable metadata
Every unit carries `{space_id, source, type, unit_type, parent_item, people[], entities[],
occurred_at, thread_id, confidence}` so retrieval can pre-filter by space (isolation), time, source,
and work-state before ranking — cheaper and more precise than post-filtering.

---

## 4. SEARCH — graph-aware retrieval (what makes it a *knowledge-graph* memory)

Retrieval fuses three signals instead of one:

1. **Vector** — ANN over the unified index → the semantically relevant seed memories.
2. **Graph expansion** — from each seed, traverse `brain_edge` along **confirmed** edges (1–2 hops)
   to pull the connected lineage: the meeting that spawned a ticket, the commits that implement it,
   the topic thread it belongs to. This is GraphRAG: the answer sees the *whole chain*, not isolated
   snippets. Semantic ("possible") edges are followed only as a last resort and clearly de-weighted.
3. **Structured** — metadata + thread-state filters (this space only; open/slipping; last 30 days).

Then **rerank** by a blend of vector score × edge confidence × graph centrality × recency, and
assemble a token-budgeted context pack. Retrieval stays accuracy-first: confirmed lineage leads,
possible links are labeled, nothing is fabricated (the CF-5/D-7 discipline extends to retrieval).

---

## 5. Cost — cut redundancy, pay once (the constraint you keep raising)

| Redundancy today | Fix | Saving |
|---|---|---|
| Meeting embedded 3× | One embed → one namespace (§3 D-1) | ~2/3 of meeting embed spend |
| Dead per-topic kg vectors | ✅ already cut (2026-07-03) | ~80% of the kg embed pass |
| Re-embed unchanged items every run | `content_hash` gate — embed only on change | most re-sync embed spend |
| Whole-item embed of huge transcripts | chunk once; only re-chunk changed items | bounded, predictable |
| Premium LLM on easy cases | tiered models (cheap embed + Flash; Sonnet only for hard verdict/answer) — ✅ registry already tiered | steady |
| Unbounded meaning-layer spend | ✅ per-user daily budget + visible health (D-5/CF-4) | hard ceiling |

Principle: **embed once, on change, at the cheapest tier that holds quality; the deterministic
retrieval + graph layers stay $0.** Every expensive call is metered (`usage_events feature='brain'`)
and shows up in MemScore's cost column, so quality gains are always weighed against spend.

---

## 6. EVALUATE — MemScore (turn quality from a vibe into a number)

Build the benchmark harness from your diagram as a first-class `__job` + Braintrust eval (Braintrust
is already a dependency):

- **Golden set per space** — a set of `question → {expected answer, expected source citations}`
  drawn from the space's own history (seeded manually + auto-generated from decisions/threads).
- **Run the pipeline** — Ingest → Index → Search → Answer → Evaluate, headless.
- **Score** (the MemScore composite):
  - **Retrieval** — did SEARCH surface the memory units that actually contain the answer?
    (recall@k, precision, MRR)
  - **Answer** — LLM-judge the generated answer vs ground truth (correct / partial / wrong /
    hallucinated).
  - **Latency** — end-to-end ms.
  - **Cost** — tokens + embeddings spent.
  - **MemScore** = weighted blend (accuracy-dominant, cost/latency as guardrails).
- **Report + regression-test** — every architecture change (new chunking, new rerank weights, model
  swap) is A/B'd against the last MemScore. No change ships if MemScore drops. This is how we
  *prove* "better than current" instead of asserting it.

MemScore makes the whole plan self-correcting: it's the feedback loop that tells us which of these
changes actually helped.

---

## 7. Phased sequence (incremental, each step measured, grounded in current code)

Nothing here is a big-bang; each phase is shippable and the deterministic spine keeps running.

1. ✅ **DONE (deployed 2026-07-03) — MemScore harness FIRST** *(so every later change is measured)* —
   `connectors/memscore.ts` + `mem-score` job: `mem_benchmark` + `mem_score_run` tables, deterministic
   `seedGoldenSet` (golden Q&A from the space's own tickets/decisions/topics, $0), `runMemScore`
   (retrieval scored deterministically = recall@k + MRR; `useGraph` A/Bs brain_edge expansion;
   `withAnswer` adds a Flash answer+judge layer, metered). **Pilot baseline (37 Qs): vector-only recall
   0.78 / MemScore 75; graph-aware recall 0.87 / MemScore 81** — graph expansion proven +8pts recall /
   +6 MemScore for ~20ms. This is the number every phase below must beat.
2. ◐ **content-hash + synced_at root fix SHIPPED (deployed 2026-07-03)** *(cost)* — `sync.ts` now bumps
   `synced_at` ONLY on real content change (title/body/status/raw), so embed + link + threads all skip
   unchanged items; `embed.ts` adds an `embedded_hash` gate (skip re-embed when embed-text is
   byte-identical). **Verified live:** a connector-sync re-pulled 24 items → embedded 0, linked 0 (was
   24 + 24 every 15 min); MemScore held at 81 (quality untouched). STILL TODO in this phase: retire
   `lumina-kg-meetings` + collapse the cross-pipeline triple-embed (the riskier kgLink rewiring, P2b).
3. ✅ **Multi-granularity indexing DONE + PROVEN (2026-07-03/04)** — atoms (below) + **item chunks**
   (`buildSpaceChunks`, deployed 2026-07-04): long bodies split into ~1400-char windows, indexed into
   the SAME namespace (unit_type='chunk'), retrieval resolves chunk→parent. Chunks measured via a new
   PASSAGE golden set (questions answerable only from a specific passage): **A/B WITHOUT chunks 89 →
   WITH chunks 94 (recall .96→1.00, MRR .72→.81)** — chunks are measured-positive on passage retrieval
   (neutral on decision/topic where atoms already max). The unified turbopuffer index now holds item
   vectors + atoms + chunks, PROVEN across both query types.
3. ◐ **Derived-atom indexing SHIPPED (deployed 2026-07-03)** *(quality)* — `memunits.ts` + `mem_unit`
   table + `mem-units` job: every knowledge_graph decision/action-item/topic indexed as its own memory
   unit (`id=${'${parentItemId}'}~d0`, `unit_type`+`parent_id`), hash-gated; `semanticSearchItems` resolves
   atom hits to their parent item. **MemScore jumped 81 → 99 on Pilot (recall 0.865→1.00, MRR 0.67→0.97,
   latency flat).** Biggest lever by far. STILL TODO: item CHUNKING (split long transcripts) — the other
   half of multi-granularity. (Caveat: the golden set is auto-generated from the same decisions/topics,
   so 99 proves "extracted knowledge is now directly retrievable" — the goal — but a held-out /
   paraphrased question set is the next hardening step to keep the metric honest.)
4. ✅ **Graph-aware retrieval — DEFAULT in chat (deployed 2026-07-03)** — `brain_search` now runs
   vector-seed → atom-resolution → `expandWithNeighbours` (brain_edge lineage). A/B on MemScore proved
   +6 (75→81) before atoms; atoms then took it to 99. Now the default retrieval path for chat.
5. ◐ **Chat wired to the new retriever (deployed 2026-07-03)** — `brain_search` surfaces the exact
   matched ATOM (decision/action/topic) as the grounding snippet + a `↳ linked:` lineage line, so the
   agent answers from the precise decision, not an averaged transcript slice. Atoms auto-refresh on the
   sync tail (`buildActiveSpaceThreads` → `buildSpaceUnits`, hash-gated). STILL TODO: point the
   `brain_brief` engineering/PM sections at retrieved evidence (D-3, credit-gated).
6. **Retire the legacy KG pipeline** — once MemScore proves the unified retriever ≥ the old kg graph,
   migrate KnowledgePage UI to `/brain/graph` (client rebuild) and drop `kg_edges` / kgLink /
   `lumina-kg-meetings`.

**Gating:** phases 1–4 are server-side/$0-to-cheap and can proceed now; phase 5's answer-quality
work benefits from LLM credits (available now); phase 6 needs a client rebuild.

**HELD-OUT BASELINE (deployed 2026-07-03) — the honest number.** The auto golden set reuses indexed
atom text, so its 99 was inflated. A paraphrased set (LLM-reworded, no ticket keys, same expected
source) is the held-out test. Pilot, 33 paraphrased Qs: **recall 0.91, MRR 0.62, MemScore 82** (graph ==
vector — graph didn't recover the misses). Reading: atom indexing GENERALIZES (0.91 recall on reworded
queries — not just lexical overlap), but RANKING is the measured weakness (MRR 0.97→0.62). So the next
lever is RERANKING (confidence · centrality · recency), not more recall. **82 is the trustworthy
baseline every future change is judged against.**

**RERANK — MEASURED NEGATIVE RESULT (2026-07-03).** Built a deterministic reranker (vector sim + atom
boost + lexical overlap + recency) to lift the held-out MRR. A/B on the 33 paraphrased Qs: no-rerank 83
(recall .912, mrr .628) → rerank v1 (with lexical) 56 (recall .68!) → rerank v2 (sim-dominant, no
lexical) 61 (recall .71). BOTH HURT — deviating from turbopuffer's native ANN order demotes correct
items out of top-k; the reconstructed similarity + hand-weights are a worse signal than the raw ANN
rank. Lexical overlap actively misleads on REWORDED queries (correct item shares few words by design).
CONCLUSION: shipped nothing (rerank stays behind an OFF flag; brain_search never used it). The honest
83 stands. Real MRR gains need a proper CROSS-ENCODER / LLM reranker (cost) or better query→atom
matching — not hand-tuned deterministic weights. The held-out harness earned its keep: it caught a
"felt-like-progress" regression before it shipped.

**Definition of done:** a user asks any question about a space's history and gets a correct,
graph-grounded, cited answer in one hop — and the MemScore for that space is measured, tracked, and
monotonically improving as we tune. That is the memory operating system.
