# Agentic Chat Loop — Architecture & Phased Plan

> **Goal.** Turn Lumina's chat from one-shot RAG Q&A into a real **agentic loop** — the
> interactive front-end to the orchestration plane we already built. The model **plans
> (todos) → selects tools by intent → executes them (permission-gated) → updates the plan →
> responds**, exactly like Claude Code's loop (reference: `/Users/migavelaishwin/Downloads/src`).
>
> It **reuses everything we shipped**: the tool catalog (`connector_tool`), the permission
> engine (`resolvePermission`), the gated executors (`executeMcpWrite` / `executeJiraAction`),
> the HITL card (`McpActionCard`), the brain (RAG), and the audit/rollback ledger. The only
> net-new pieces are: a **model-turn provider abstraction**, the **loop**, a **todo/plan tool**,
> and the **chat surfacing** of tool cards + the plan.

---

## 0. Principles (do not compromise)

1. **The model selects tools — we never hand-map intent→tool.** We expose the discovered tool
   catalog as function/tool definitions (name + description + input schema); the LLM picks.
2. **One chokepoint.** Every tool call crosses `resolvePermission` server-side: `allow` runs,
   `ask` shows a card (loop pauses), `deny` is invisible to the model. Keys never leave the server.
3. **Provider-agnostic loop.** The loop is written once against a **normalized turn interface**;
   provider differences (Claude / OpenAI / Gemini direct / Gemini-via-OpenRouter) live behind one
   server adapter. Claude (direct Anthropic API) is the default tool-use model; the user can switch.
4. **Non-breaking + incremental.** Plain RAG chat keeps working; the agentic loop is additive and
   gated behind a feature flag until each phase's acceptance passes.
5. **Bounded + safe.** Max-steps cap, deny-by-default for destructive tools, audit + rollback on
   every write, no silent truncation.

---

## 1. Reference grounding (what we're replicating, from `/Downloads/src`)

| Mechanic | Reference (file) | What it does |
|---|---|---|
| The loop | `query.ts` → `queryLoop` `while(true)` | model → detect `tool_use` (by content, **not** `stop_reason`) → run tools → append `tool_result` → loop → stop when no tool_use |
| Tool assembly | `services/mcp/client.ts` `fetchToolsForClient`, `services/api/claude.ts` | `[...builtins, ...mcp]` → filter deny/`isEnabled` → `{name, description, input_schema}` to the model |
| Selection | the model | function-calling from names/descriptions; **no hand-mapping** |
| Gate | `hooks/useCanUseTool.tsx`, `toolOrchestration.ts runTools` | `allow` (read-only parallel ≤10 / writes serial) · `ask` (suspend → confirm → resume; "always allow" persists a rule) · `deny` (`is_error` result); zod-validate input first; errors → `is_error` tool_result |
| Plan | `tools/TodoWriteTool/*` | todo = `{content, activeForm, status: pending\|in_progress\|completed}`; replace whole list; exactly one `in_progress`; complete immediately; verification nudge |
| Sub-agents | `tools/AgentTool/*` | delegate to a nested `query()` (sync/async) — **deferred** for us |
| Event stream | `query.ts` yields | `stream_request_start`, assistant (text/tool_use), `tool_result`, progress, todos, summaries → UI cards/plan/output |

---

## 2. Target architecture

**Client-orchestrated loop + a server provider-abstraction turn endpoint.** The client owns the
control flow (so no single request hits the 29 s API-Gateway limit, and chat UX/cards/plan render
natively); the server owns keys, the provider SDKs, the tool catalog, and the gate.

```
ChatPage ── user prompt
   │
   ▼  (client agentChat loop — bounded N steps)
┌──────────────────────────────────────────────────────────────────────────┐
│ 1. MODEL TURN   POST /chat/agent/turn { model, system, messages, tools }    │
│      server picks provider by model → official SDK → returns NORMALIZED     │
│      { text, toolCalls:[{id,name,args}], stopReason, usage }                │
│ 2. PLAN         if toolCall == todo_write → update PLAN PANEL (client state) │
│ 3. VALIDATE     args vs the tool's input_schema (from the catalog)          │
│ 4. EXECUTE      POST /chat/agent/exec { connector, tool, args }             │
│      server: resolvePermission →                                            │
│         allow → executeMcpWrite/executeJiraAction (audited, reversible)      │
│         ask   → return {behavior:'ask'} → client shows McpActionCard,       │
│                 awaits approve → re-POST with approved:true → execute        │
│         deny  → return {behavior:'deny'} → client feeds is_error to model    │
│ 5. RESULT       append tool_result (or is_error) to messages → step 1       │
│ 6. RESPOND      no toolCalls → final assistant text (citations + actions)   │
└──────────────────────────────────────────────────────────────────────────┘
        ▲ tool defs                         ▲ keys + SDKs (server only)
        │ GET /connectors/tools (all)       │ /chat/agent/turn provider adapter
        │ + brain_search + todo_write        │ Anthropic · OpenAI · Gemini · OpenRouter
```

- **Why client-orchestrated:** each `/chat/agent/turn` and `/chat/agent/exec` is one short request
  (< 29 s); the multi-round loop is spread across many of them. Keys stay server-side (the turn
  endpoint holds them). Cards + plan render in the existing chat UI.
- **Security boundary unchanged:** writes still flow `resolvePermission` → gated executor → audit →
  rollback. `deny` tools are filtered out of the tool list AND blocked at exec (defense in depth).

---

## 3. Model / provider abstraction (the multi-model core)

The loop calls **one normalized endpoint**; the server routes by the selected model's provider and
uses each vendor's **official SDK with its own direct key** (per the user's setup).

### 3.1 Provider matrix

| Provider | Models (examples) | Transport / key | Tool-use shape (server adapter normalizes) |
|---|---|---|---|
| **Anthropic (Claude) — DIRECT** | `claude-opus-4-8`, `claude-sonnet-4-6` | `@anthropic-ai/sdk`, **Anthropic API key** (NOT OpenRouter) | Messages API `tools` (`input_schema`), `tool_use`/`tool_result` blocks, adaptive thinking |
| **OpenAI — DIRECT** | `gpt-…` | `openai` SDK, **OpenAI API key** (direct) | `tools` (function), `tool_calls`, `role:"tool"` results |
| **Gemini — DIRECT** | `gemini-3-pro`, `gemini-3-flash-…` | `@google/genai`, **Gemini key** | `functionDeclarations`, `functionCall` / `functionResponse` |
| **Gemini / others — via OpenRouter** | `google/gemini-…` | OpenRouter (OpenAI-compatible), **OpenRouter key** | OpenAI-style `tools` / `tool_calls` |

> Claude is the **default agentic-loop model** (strongest tool-use reasoning). The other providers
> are first-class: the user picks via `chatModels.ts`; the server adapter translates tool defs and
> parses tool calls per provider, so the **loop code is identical regardless of model**.

### 3.2 The normalized turn contract (single source of truth)
```ts
// request
{ model: string,                       // resolved id; provider inferred from registry
  system: string,
  messages: AgentMessage[],            // normalized (Anthropic-shaped): text + tool_use + tool_result
  tools: AgentToolDef[],               // {name, description, inputSchema(JSON Schema)}
  maxOutputTokens?, thinking?: 'adaptive'|'off' }
// response
{ text: string,
  toolCalls: { id, name, args }[],     // empty array = final turn
  stopReason: 'end_turn'|'tool_use'|'max_tokens'|...,
  usage: { input, output } }
```
- **`/ai/proxy` reuse:** the proxy already injects keys for `api.anthropic.com`, `openrouter.ai`,
  Gemini. **Add `api.openai.com`** to its allowlist for the OpenAI direct key. The turn endpoint can
  call providers via the proxy or call SDKs directly inside the Lambda (keys from Secrets Manager).
- **Registries:** add an `agentChat` entry to `aws/api/src/models/registry.ts` (default
  `{ provider:'anthropic', primary:'claude-opus-4-8'|'claude-sonnet-4-6' }`) and a matching
  selectable entry in `src/services/chatModels.ts` so the picker offers Claude / Gemini / OpenAI.
- **claude-api skill:** for the Anthropic adapter use the official SDK shape, adaptive thinking, and
  streaming per `shared/` guidance (do not hand-roll the HTTP).

---

## 4. The loop specification (client `agentChatService`)

```
run(prompt, { model, workspaceId }):
  messages = [...history, user(prompt)]
  tools    = await getAgentTools(workspaceId)          // catalog (allow+ask) + brain_search + todo_write
  for step in 1..MAX_STEPS (e.g., 24):
    turn = POST /chat/agent/turn { model, system, messages, tools }
    emit(turn.text)                                     // stream/append assistant text
    if turn.toolCalls is empty: return final(turn.text) // RESPOND
    for call in turn.toolCalls:                          // (read-only may run in parallel; writes serial)
      if call.name == 'todo_write':   updatePlanPanel(call.args.todos); result = ack
      elif call.name == 'brain_search': result = await brainSearch(call.args)        // RAG, read → allow
      else:
        validate(call.args, schemaOf(call.name))         // zod / JSON-schema; bad → is_error
        exec = POST /chat/agent/exec { connector, tool, args, approved:false }
        if exec.behavior == 'deny':  result = is_error("blocked by policy")
        elif exec.behavior == 'ask': result = await showCardAndAwait(call) // McpActionCard inline; on approve re-POST approved:true
        else:                        result = exec.result                  // allow → ran
      messages.push(tool_result(call.id, result))
    // loop
  emit("Reached the step limit — here's what I did so far …")  // no silent stop
```
- **Tool-call detection** mirrors the reference: act on returned tool calls, not on `stopReason`.
- **Errors** (validation, exec failure, deny) become `is_error` tool_results fed back to the model —
  it recovers or explains, never crashes the turn.
- **Bounded:** `MAX_STEPS` cap; surfaced to the user if hit (no silent truncation).

---

## 5. Plan / todo (the "plan" stage)

- **Tool:** `todo_write({ todos: [{content, activeForm, status}] })` — replaces the whole list
  (matches the reference). System-prompt rules baked into the agent system prompt: plan when ≥3
  steps; **exactly one `in_progress`**; mark complete **immediately**; never complete if blocked;
  add a **verification** todo for multi-step work.
- **UI:** a **plan panel** in `ChatPage` (pending / in-progress ⟳ / done ✓), updated from each
  `todo_write` call. Client-side state only (no new table needed for v1).

---

## 6. Trust integration (reuse, don't rebuild)

- **Tool list** = `listConnectorTools` across connected connectors, **`deny` filtered out**, mapped
  to `AgentToolDef` (name = `connector__tool`, description, `input_schema`). Plus `brain_search`
  (read) and `todo_write`.
- **Gate** = `resolvePermission(connector, tool)` inside `/chat/agent/exec`: `allow` → run now;
  `ask` → return to client for the card; `deny` → blocked. (Same engine the autonomous reconcile
  sweep uses — the chat and the sweeps share one trust plane.)
- **Execute** = `executeMcpWrite` / `executeJiraAction` (already audited + reversible).
- **HITL** = `McpActionCard` rendered inline in the chat for `ask` tools; approve → resume.

---

## 7. Surfaces to build / touch

**Server (`aws/api`):**
- `chat/agent/turn` route → `aws/api/src/chat/agentTurn.ts` (the provider abstraction; adapters:
  `providers/anthropic.ts`, `providers/openai.ts`, `providers/gemini.ts`, `providers/openrouter.ts`).
- `chat/agent/exec` route → thin wrapper over `resolvePermission` + `executeMcpWrite`/`executeJiraAction`.
- `chat/agent/tools` (or reuse a cross-connector variant of `GET /connectors/tools`) → the agent tool list.
- `models/registry.ts` → add `agentChat`; `secrets` → add `OPENAI_API_KEY`; `/ai/proxy` allowlist → add `api.openai.com`.

**Client (`src`):**
- `services/agentChatService.ts` — the loop (turn → tools → loop), normalized message accumulation, bounded steps.
- `services/agentTools.ts` — fetch catalog → `AgentToolDef[]`; define `brain_search` + `todo_write`.
- `services/chatModels.ts` — add the agentic models (Claude default + Gemini + OpenAI) to the picker.
- `pages/ChatPage.tsx` — agentic mode toggle, render tool cards + the plan panel + "actions taken".
- reuse `components/McpActionCard.tsx` for inline `ask` approvals.

---

## 8. Phased build (each shippable, non-breaking, with an acceptance gate)

### Phase 0 — Provider abstraction + model turn endpoint
**Goal:** one normalized `/chat/agent/turn` that does ONE tool-capable model turn across Claude
(direct), OpenAI (direct), Gemini (direct), Gemini-via-OpenRouter.
- Build the 4 adapters (official SDKs); normalize tool defs in + tool calls out.
- `agentChat` registry entry (default Claude); `OPENAI_API_KEY` in Secrets; OpenAI host in `/ai/proxy`.
- **Acceptance:** a turn with a trivial tool def returns a correct normalized `toolCalls` from
  **each** provider (verified via a temp probe); no key in the client bundle.

### Phase 1 — Tool exposure
**Goal:** the chat can see every connected connector's tools as LLM tool defs.
- `getAgentTools(workspaceId)` = `listConnectorTools` (all connectors, `deny` filtered) + `brain_search` + `todo_write`.
- **Acceptance:** GET returns correct tool defs (names/descriptions/schemas) for Jira/GitHub/custom; deny tools absent.

### Phase 2 — The loop (read-only first)
**Goal:** end-to-end agentic loop using **read-only tools only** (search, get) — no writes yet.
- `agentChatService` loop: turn → tool_use → validate → exec (allow path) → tool_result → loop → respond.
- Bounded steps; errors → is_error.
- **Acceptance:** "summarize the open Jira tickets touching the auth refactor" runs multiple read
  tools + `brain_search` and answers with citations; loop terminates cleanly; step cap respected.

### Phase 3 — Plan / todo
**Goal:** the model plans multi-step work and the plan renders + updates.
- `todo_write` tool + system-prompt planning rules + the ChatPage plan panel.
- **Acceptance:** a ≥3-step request produces a todo list, exactly one `in_progress`, items complete
  as work proceeds, and a verification step appears for multi-step tasks.

### Phase 4 — Writes with in-chat HITL
**Goal:** the loop can take **gated write actions** with inline approval.
- `/chat/agent/exec` returns `ask` → `McpActionCard` inline → approve → re-exec `approved:true` →
  resume; `deny` blocked; everything audited + reversible.
- **Acceptance:** "create a Jira ticket for the decision in today's standup" → the loop drafts it,
  shows the card, executes only on approval, and the action appears in the audit log with rollback.

### Phase 5 — Multi-model + polish
**Goal:** model picker (Claude/Gemini/OpenAI), streaming, "actions taken" summary, verification nudge.
- Wire `chatModels.ts` picker through the loop; stream assistant text; final summary of tools used.
- **Acceptance:** the same agentic task runs on Claude, a Gemini model, and an OpenAI model with
  identical loop behavior (tool selection + gating); streaming + summary render.

### Deferred (explicitly, with reason)
- **Sub-agents (`AgentTool`)** — a whole subsystem; the single loop delivers the value first.
- **Tool-search deferral / microcompaction / streaming-tool-executor** — solve *scale* (hundreds of
  tools, very long turns); we have few tools + short turns, so bounded steps + our context limits suffice.

---

## 9. Security & cost notes
- **Keys server-side only** — Anthropic / OpenAI / Gemini / OpenRouter keys live in Secrets Manager;
  the client never sees them (the turn endpoint / `/ai/proxy` inject them).
- **Every write crosses the gate + audit + rollback**; `deny`/destructive tools are filtered from the
  model's tool list *and* blocked at exec.
- **Cost:** tool-use turns are the expensive part — bound `MAX_STEPS`, prefer the cheapest capable
  model per task (Claude for hard agentic reasoning; Gemini Flash for light turns), and reuse the
  brain (RAG) instead of re-fetching via tools where possible.

## 10. Definition of done (per phase)
1. Acceptance passes on real data (not mocks).
2. `npm run lint` (tsc) + server `tsc` clean; idempotent + safe to re-run.
3. Plain RAG chat unaffected (feature-flagged until GA).
4. No key in the client bundle; every write audited + reversible.
5. This doc updated if a decision changes.
