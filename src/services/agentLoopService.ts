import { fetch as tauriFetch } from '@tauri-apps/plugin-http';
import { getIdToken } from './awsAuthService';

/**
 * AGENT LOOP — the client-orchestrated agentic chat loop (Phase 2, read-only).
 *
 * Mirrors Claude Code's query loop (studied in /Users/migavelaishwin/Downloads/src):
 *   plan → the model selects a tool → execute (gated) → feed the result back → loop → final answer.
 *
 * Why the loop lives on the CLIENT (not the Lambda): each model turn (`/ai/agent-turn`) and each
 * tool execution (`/ai/agent-exec`) is a SEPARATE short request, so a multi-step conversation never
 * hits API Gateway's ~29s ceiling — and, critically, a future human-approval PAUSE (Phase 4) can
 * span minutes between requests without holding a Lambda open. The provider key, the tool catalog,
 * and the permission gate all stay server-side; the client only sequences the steps.
 *
 * Phase 2 is READ-ONLY: read-class tools the user allows execute automatically; anything that can
 * change data comes back as `requiresApproval` and is surfaced (the real HITL card is Phase 4).
 */

const API_BASE = import.meta.env.VITE_API_GATEWAY_URL || '';
const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
const baseFetch: typeof globalThis.fetch = isTauri
  ? (tauriFetch as unknown as typeof globalThis.fetch)
  : globalThis.fetch;

// ── Normalized turn contract (matches aws/api/src/chat/agentTurn.ts) ──
export type AgentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: any; signature?: string }
  | { type: 'tool_result'; tool_use_id: string; content: string; is_error?: boolean };
export interface AgentMessage { role: 'user' | 'assistant'; content: AgentBlock[] }
export interface AgentToolCall { id: string; name: string; args: any; signature?: string }

interface TurnResult { text: string; toolCalls: AgentToolCall[]; stopReason: string; usage?: { input?: number; output?: number }; model: string; provider: string }
interface ExecResult { ok: boolean; content: string; isError?: boolean; requiresApproval?: boolean; behavior?: string; klass?: string }

export interface TodoItem { content: string; activeForm?: string; status: 'pending' | 'in_progress' | 'completed' }

export type AgentLoopEvent =
  | { kind: 'assistant_text'; text: string; step: number }
  | { kind: 'plan'; todos: TodoItem[]; step: number }     // model wrote/updated its plan (todo_write)
  | { kind: 'tool_call'; id: string; name: string; connector?: string; args: any; step: number }
  | { kind: 'tool_result'; id: string; name: string; ok: boolean; requiresApproval?: boolean; content: string; step: number }
  | { kind: 'done'; text: string; steps: number };

/** A write/ask tool the model wants to run — the UI renders an approval card from this. */
export interface PendingApproval { id: string; name: string; connector?: string; tool?: string; args: any; behavior?: string; klass?: string }

export interface AgentLoopOptions {
  workspaceId: string;
  model?: string;                 // omitted → server default (agentChat = Claude direct)
  provider?: 'anthropic' | 'openai' | 'gemini' | 'openrouter';
  system?: string;
  maxSteps?: number;
  onStep?: (ev: AgentLoopEvent) => void;
  // Called when a tool that can change data wants to run. Resolve true to execute it, false to skip.
  // The UI implements this by rendering a HITL card and resolving when the user clicks — the await
  // can span minutes (nothing server-side is held open). If omitted, such tools are NOT run and are
  // reported in `pendingApproval` (the read-only Phase-2 behaviour).
  onApprovalRequest?: (req: PendingApproval) => Promise<boolean>;
}

export interface AgentLoopResult {
  text: string;
  steps: number;
  messages: AgentMessage[];                       // full transcript (for a follow-up turn)
  pendingApproval?: { name: string; args: any }[]; // tools the model wanted but that need approval
}

const MAX_STEPS = 14;         // hard ceiling on model turns (multi-step "find → act" tasks need room)
const MAX_TOOL_CALLS = 20;    // total tool-call budget → then a synthesis turn is forced
const PER_TOOL_CAP = 5;       // max calls to the SAME tool before nudging the model to move on

const DEFAULT_SYSTEM = [
  "You are Wisprnote's assistant. The user runs their work through a connected brain — meetings,",
  'Jira, GitHub, local code sessions, and the decisions/action-items extracted from them.',
  'Ground answers in their actual work: use brain_search to find context, and the connector read',
  'tools for live details. Search efficiently — issue ONE focused brain_search per distinct',
  'question and do NOT repeat near-identical searches; once you have enough context, answer.',
  'For any multi-step task, call todo_write first to lay out a short plan, then work through it.',
  'Cite what you used and be concise. Actions that change data in a connected tool require the',
  'user’s approval before they run — propose them clearly.',
].join(' ');

/** `mcp__<connector>__<tool>` → { connector, tool } (for labelling the approval card). */
function splitToolName(name: string): { connector?: string; tool?: string } {
  if (!name.startsWith('mcp__')) return {};
  const rest = name.slice(5);
  const i = rest.indexOf('__');
  return i < 0 ? {} : { connector: rest.slice(0, i), tool: rest.slice(i + 2) };
}

async function postAI<T>(path: string, body: any): Promise<T> {
  const token = await getIdToken();
  const resp = await baseFetch(`${API_BASE}/ai/${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token },
    body: JSON.stringify(body),
  });
  if (!resp.ok) throw new Error(`/ai/${path} failed: ${resp.status} ${(await resp.text().catch(() => '')).slice(0, 200)}`);
  return resp.json() as Promise<T>;
}

/**
 * Run the agentic loop for one user message. `priorMessages` carries an existing conversation
 * (the normalized transcript returned by a previous call) so follow-ups keep context.
 */
export async function runAgentLoop(
  userMessage: string,
  opts: AgentLoopOptions,
  priorMessages: AgentMessage[] = [],
): Promise<AgentLoopResult> {
  const messages: AgentMessage[] = [...priorMessages, { role: 'user', content: [{ type: 'text', text: userMessage }] }];
  const maxSteps = opts.maxSteps ?? MAX_STEPS;
  const baseSystem = opts.system ?? DEFAULT_SYSTEM;
  const pendingApproval: { name: string; args: any }[] = [];
  const seen = new Map<string, string>();    // dedup identical tool calls within this run
  const perTool = new Map<string, number>(); // per-tool-name call counter (cap repeats)
  let toolCallCount = 0;                      // hard budget across the whole run
  let forceSynthesis = false;                 // set when the model is genuinely stuck
  let noProgressStreak = 0;                   // consecutive steps with no NEW info (single ones are fine)
  let anySuccess = false;                     // did any real tool (read/write) succeed? drives the ending

  const finish = (text: string, steps: number): AgentLoopResult => {
    opts.onStep?.({ kind: 'done', text, steps });
    return { text, steps, messages, pendingApproval: pendingApproval.length ? pendingApproval : undefined };
  };
  const FALLBACK = "I couldn't find enough in your connected sources to answer that confidently. Try rephrasing, or point me at a specific meeting, project, or ticket.";
  // The right ending when the model produces no closing text: if the agent actually DID work
  // (a tool succeeded — e.g. a Slack message sent), never claim we "couldn't find" anything.
  const ending = (text?: string) => text || (anySuccess ? 'Done — I completed the requested actions.' : FALLBACK);

  for (let step = 0; step < maxSteps; step++) {
    // SYNTHESIS step: the last step, OR once the model is spinning / has spent its tool budget. We
    // withhold tools (exposeConnectorTools:false → server attaches none) AND, crucially, return the
    // model's text REGARDLESS of what it emits — so the loop ALWAYS ends with an answer, never a
    // "step limit" dead-end, even if the model tries to keep calling tools.
    const synth = step === maxSteps - 1 || forceSynthesis || toolCallCount >= MAX_TOOL_CALLS;
    const turn = await postAI<TurnResult>('agent-turn', {
      workspaceId: opts.workspaceId,
      model: opts.model,
      provider: opts.provider,
      system: synth
        ? `${baseSystem} You have gathered enough context. Do NOT call any tools now — write the best complete answer you can for the user from what you already have. If something is missing, say what you found and what's missing.`
        : baseSystem,
      messages,
      exposeConnectorTools: !synth,
    });
    if (turn.text) opts.onStep?.({ kind: 'assistant_text', text: turn.text, step });

    // Record the assistant turn (text + any tool_use) so the next turn sees its own actions.
    const assistantBlocks: AgentBlock[] = [];
    if (turn.text) assistantBlocks.push({ type: 'text', text: turn.text });
    for (const tc of turn.toolCalls) assistantBlocks.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.args, signature: tc.signature });
    if (assistantBlocks.length) messages.push({ role: 'assistant', content: assistantBlocks });

    // HARD STOP: on a synthesis step we take the answer and return, ignoring any tool calls the
    // model may still have emitted. This is the guarantee that the loop cannot dead-end.
    if (synth) return finish(ending(turn.text), step + 1);

    // Model answered with no tools → done.
    if (!turn.toolCalls.length) return finish(ending(turn.text), step + 1);

    // PASS 1 — run every tool in parallel. Reads/built-ins execute; write/ask come back as
    // requiresApproval (gate). Repeat / over-used / budget-exceeded calls are short-circuited with a
    // nudge instead of re-running, so an over-eager model converges fast. Each call gets a
    // loop-unique uid (Gemini reuses tool ids across turns, which would otherwise alias the UI).
    const first = await Promise.all(turn.toolCalls.map(async (tc, idx) => {
      const uid = `${step}-${idx}-${tc.name}`;
      const isTodo = tc.name === 'todo_write';
      if (isTodo && Array.isArray(tc.args?.todos)) opts.onStep?.({ kind: 'plan', todos: tc.args.todos as TodoItem[], step });
      opts.onStep?.({ kind: 'tool_call', id: uid, name: tc.name, connector: splitToolName(tc.name).connector, args: tc.args, step });

      const key = `${tc.name}:${JSON.stringify(tc.args ?? {})}`;
      const used = perTool.get(tc.name) ?? 0;
      let r: ExecResult; let progressed = false;
      if (!isTodo && seen.has(key)) {
        r = { ok: true, content: `(You already ran ${tc.name} with these exact arguments — reuse that result. Do NOT repeat it; answer now if you can.)` };
      } else if (!isTodo && used >= PER_TOOL_CAP) {
        r = { ok: true, content: `(You've already called ${tc.name} ${used} times — you have enough from it. Do NOT call it again. PROCEED to the next step of the task now: if the user asked you to take an action (e.g. send a Slack message, create a ticket), call that tool with what you found; otherwise give your final answer.)` };
      } else {
        r = await postAI<ExecResult>('agent-exec', { workspaceId: opts.workspaceId, toolName: tc.name, args: tc.args })
          .catch((e): ExecResult => ({ ok: false, isError: true, content: `tool transport error: ${String(e?.message || e)}` }));
        if (r.ok && !isTodo) { seen.set(key, r.content); progressed = true; anySuccess = true; }
      }
      if (!isTodo) { perTool.set(tc.name, used + 1); toolCallCount++; }
      return { tc, uid, progressed, r };
    }));

    // Track no-progress steps, but DON'T kill the loop on a single one — the model often makes a
    // redundant search and then legitimately moves to the ACTION step (e.g. send the message). Only
    // force synthesis after TWO consecutive no-progress steps (genuinely stuck). A step that made
    // progress resets the streak.
    if (first.every((x) => !x.progressed)) { noProgressStreak++; if (noProgressStreak >= 2) forceSynthesis = true; }
    else noProgressStreak = 0;

    // PASS 2 — resolve approvals SERIALLY (the human decides one at a time); the await can span
    // minutes with nothing server-side held open. On approve, re-run via the gated write executor.
    const resultBlocks: AgentBlock[] = [];
    for (const { tc, uid, r } of first) {
      let res = r;
      if (r.requiresApproval) {
        if (opts.onApprovalRequest) {
          const req: PendingApproval = { id: tc.id, name: tc.name, args: tc.args, ...splitToolName(tc.name), behavior: r.behavior, klass: r.klass };
          const approved = await opts.onApprovalRequest(req).catch(() => false);
          res = approved
            ? await postAI<ExecResult>('agent-exec', { workspaceId: opts.workspaceId, toolName: tc.name, args: tc.args, approved: true })
                .catch((e): ExecResult => ({ ok: false, isError: true, content: `tool transport error: ${String(e?.message || e)}` }))
            : { ok: false, isError: true, content: 'You declined this action, so it was not run.' };
        } else {
          pendingApproval.push({ name: tc.name, args: tc.args });
        }
      }
      if (res.ok && tc.name !== 'todo_write') anySuccess = true;   // an approved write that executed counts
      opts.onStep?.({ kind: 'tool_result', id: uid, name: tc.name, ok: res.ok, requiresApproval: res.requiresApproval, content: res.content, step });
      resultBlocks.push({ type: 'tool_result', tool_use_id: tc.id, content: res.content, is_error: res.isError || res.requiresApproval });
    }
    messages.push({ role: 'user', content: resultBlocks });
  }

  // Unreachable in practice (the synthesis step always returns), but keep a graceful final answer.
  return finish(ending(), maxSteps);
}
