import { useState } from 'react';
import { ChevronRight, Check, Loader2, ListChecks } from 'lucide-react';
import type { TodoItem } from '../services/agentLoopService';

/**
 * AGENT TIMELINE — renders the agentic loop's trace in Claude's tool-calling style:
 * a collapsible "Thought process" containing the assistant's narration, the plan (task rows),
 * and each tool call as a collapsible row exposing its Request + Response JSON.
 *
 * The trace is built by the chat surface from the loop's onStep events; this component is pure
 * presentation. It works both LIVE (streaming, expanded) and PERSISTED (after the answer, collapsed).
 */
export type TraceItem =
  | { kind: 'text'; text: string }
  | { kind: 'tool'; id: string; name: string; connector?: string; args: any; status: 'running' | 'done'; result?: string; ok?: boolean }
  | { kind: 'task'; todos: TodoItem[] };

function CodeBlock({ label, body }: { label: string; body: string }) {
  return (
    <div className="rounded-lg bg-app-canvas border border-app-divider overflow-hidden">
      <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold text-app-fg-subtle">{label}</div>
      <pre className="px-3 pb-2.5 text-[11.5px] font-mono text-app-fg whitespace-pre-wrap break-words max-h-56 overflow-y-auto">{body}</pre>
    </div>
  );
}

function ToolRow({ item }: { item: Extract<TraceItem, { kind: 'tool' }> }) {
  const [open, setOpen] = useState(false);
  // mcp__github__get_commit → get_commit
  const shortName = item.name.startsWith('mcp__') ? item.name.split('__').slice(2).join('__') : item.name;
  return (
    <div className="border-l border-app-divider pl-3 ml-1">
      <button onClick={() => setOpen((o) => !o)} className="flex items-center gap-2 py-1 w-full text-left text-app-fg-muted hover:text-app-fg">
        {item.status === 'running'
          ? <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0" />
          : <Check className={`w-3.5 h-3.5 flex-shrink-0 ${item.ok === false ? 'text-amber-500' : 'text-emerald-500'}`} strokeWidth={2.4} />}
        {item.connector && (
          <span className="w-4 h-4 rounded bg-app-chip text-[9px] font-semibold flex items-center justify-center flex-shrink-0 text-app-fg-muted">
            {item.connector[0].toUpperCase()}
          </span>
        )}
        <span className="font-mono text-[11.5px]">{shortName}</span>
        <ChevronRight className={`w-3.5 h-3.5 ml-auto transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="space-y-1.5 pb-2 pr-1">
          <CodeBlock label="Request" body={JSON.stringify(item.args ?? {}, null, 2)} />
          {item.result !== undefined && <CodeBlock label="Response" body={item.result.slice(0, 4000)} />}
        </div>
      )}
    </div>
  );
}

function TaskRows({ todos }: { todos: TodoItem[] }) {
  return (
    <div className="border-l border-app-divider pl-3 ml-1 space-y-0.5 py-1">
      {todos.map((t, i) => (
        <div key={i} className="flex items-center gap-2 text-[12.5px]">
          <ListChecks className="w-3.5 h-3.5 text-app-fg-subtle flex-shrink-0" />
          <span className="w-3 text-[11px] text-app-fg-subtle flex-shrink-0">
            {t.status === 'completed' ? '✓' : t.status === 'in_progress' ? '▶' : '○'}
          </span>
          <span className={t.status === 'completed' ? 'line-through text-app-fg-subtle' : t.status === 'in_progress' ? 'text-app-fg' : 'text-app-fg-muted'}>
            {t.content}
          </span>
        </div>
      ))}
    </div>
  );
}

export default function AgentTimeline({ trace, live }: { trace: TraceItem[]; live?: boolean }) {
  const [open, setOpen] = useState(true);
  if (!trace.length) return null;
  const toolCount = trace.filter((t) => t.kind === 'tool').length;

  return (
    <div className="mb-2">
      <button
        onClick={() => setOpen((o) => !o)}
        className="flex items-center gap-1.5 text-[12px] text-app-fg-subtle hover:text-app-fg-muted mb-1.5"
      >
        <ChevronRight className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-90' : ''}`} />
        {live ? 'Thought process' : `Thought process · ${toolCount} tool${toolCount === 1 ? '' : 's'}`}
      </button>
      {open && (
        <div className="space-y-2">
          {trace.map((it, i) => {
            if (it.kind === 'text') return it.text.trim() ? <p key={i} className="text-[13px] text-app-fg-muted leading-relaxed">{it.text}</p> : null;
            if (it.kind === 'task') return <TaskRows key={i} todos={it.todos} />;
            return <ToolRow key={it.id || i} item={it} />;
          })}
        </div>
      )}
    </div>
  );
}
