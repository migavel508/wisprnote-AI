import { useMemo, useState } from 'react';
import { Check, X, Loader2, ExternalLink, AlertTriangle, Ticket, Undo2 } from 'lucide-react';
import {
  executeJiraAction, undoJiraAction, type JiraActionProposal, type JiraMeta, type JiraActionResult, type JiraOp,
} from '../services/jiraActionService';

/**
 * Human-in-the-loop approval card for a single Jira write. Rendered inline in chat
 * whenever the agent proposes an action. Every field is editable; nothing is written
 * until the user clicks "Approve & apply", which calls the server executor once.
 */

const OP_LABEL: Record<JiraOp, string> = {
  create: 'Create issue', update: 'Update issue', assign: 'Assign issue',
  comment: 'Add comment', transition: 'Change status', close: 'Close issue',
};
const ISSUE_TYPES = ['Task', 'Bug', 'Story', 'Epic'];
const PRIORITIES = ['Highest', 'High', 'Medium', 'Low', 'Lowest'];

const fieldCls =
  'w-full text-[12.5px] bg-app-panel border border-app-border rounded-lg px-2.5 py-1.5 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle';
const labelCls = 'text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] mb-1 block';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><span className={labelCls}>{label}</span>{children}</div>;
}

export default function JiraActionCard({
  proposal, meta, workspaceId, rationale, sourceTitle, onResolved,
}: {
  proposal: JiraActionProposal;
  meta?: JiraMeta;
  workspaceId: string;
  /** Provenance shown when this card comes from the autonomous agent's queue. */
  rationale?: string | null;
  sourceTitle?: string | null;
  /** Called after the user approves (executed) or dismisses — lets a queue update the ledger. */
  onResolved?: (status: 'executed' | 'dismissed', result?: JiraActionResult) => void;
}) {
  const [p, setP] = useState<JiraActionProposal>(proposal);
  const [state, setState] = useState<'editing' | 'working' | 'done' | 'error' | 'dismissed'>('editing');
  const [result, setResult] = useState<JiraActionResult | null>(null);

  const set = <K extends keyof JiraActionProposal>(k: K, v: JiraActionProposal[K]) => setP((prev) => ({ ...prev, [k]: v }));

  const projects = meta?.projects ?? [];
  const issueTypes = useMemo(() => {
    const proj = projects.find((x) => x.key === p.projectKey);
    return proj?.issueTypes?.length ? proj.issueTypes : ISSUE_TYPES;
  }, [projects, p.projectKey]);

  const isCreate = p.operation === 'create';
  const needsKey = !isCreate;

  const approve = async () => {
    setState('working');
    const r = await executeJiraAction(workspaceId, p).catch((): JiraActionResult => ({ ok: false, operation: p.operation, message: 'Network error.' }));
    setResult(r);
    setState(r.ok ? 'done' : 'error');
    if (r.ok) onResolved?.('executed', r);
  };

  const dismiss = () => { setState('dismissed'); onResolved?.('dismissed'); };

  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  const undo = async () => {
    if (!result?.auditId) return;
    setUndoing(true);
    const r = await undoJiraAction(workspaceId, result.auditId).catch((): JiraActionResult => ({ ok: false, operation: p.operation, message: 'Undo failed.' }));
    setUndoing(false);
    if (r.ok) setUndone(true);
  };

  // ── Result states ──────────────────────────────────────────────────────────
  if (state === 'dismissed') {
    return <div className="mt-2 text-[11.5px] text-app-fg-subtle italic">Action dismissed — nothing was written to Jira.</div>;
  }
  if (state === 'done' && result) {
    return (
      <div className="mt-2 rounded-xl border border-kg-accent/40 bg-kg-accent/5 px-3.5 py-3">
        <div className="flex items-center gap-2 text-[13px] text-app-fg flex-wrap">
          <span className="w-5 h-5 rounded-full bg-kg-accent/20 flex items-center justify-center flex-shrink-0">
            <Check size={12} className="text-kg-accent" strokeWidth={2.5} />
          </span>
          <span>{undone ? 'Undone — the change was reverted in Jira.' : result.message}</span>
          <span className="ml-auto inline-flex items-center gap-2.5">
            {result.url && (
              <a href={result.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-[12px] text-app-accent hover:underline">
                Open {result.issueKey} <ExternalLink size={11} />
              </a>
            )}
            {result.undoable && !undone && (
              <button onClick={undo} disabled={undoing} className="inline-flex items-center gap-1 text-[12px] text-app-fg-muted hover:text-app-fg disabled:opacity-50">
                {undoing ? <Loader2 size={11} className="animate-spin" /> : <Undo2 size={11} />} Undo
              </button>
            )}
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-app-border bg-app-status-bg overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-app-border">
        <Ticket size={14} className="text-app-fg-subtle" />
        <span className="text-[12px] font-semibold text-app-fg">{OP_LABEL[p.operation]}</span>
        {p.issueKey && <span className="text-[11px] text-app-fg-subtle font-mono">{p.issueKey}</span>}
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full bg-app-accent/15 text-app-accent border border-app-accent/30">
          Needs approval
        </span>
      </div>

      {(rationale || sourceTitle) && (
        <div className="px-3.5 pt-2.5 -mb-0.5 text-[11px] text-app-fg-subtle">
          {rationale}{sourceTitle ? <span className="text-app-fg-muted"> · from “{sourceTitle}”</span> : null}
        </div>
      )}

      <div className="px-3.5 py-3 grid grid-cols-2 gap-2.5">
        {needsKey && (
          <Field label="Issue key">
            <input className={fieldCls} value={p.issueKey ?? ''} onChange={(e) => set('issueKey', e.target.value.toUpperCase())} placeholder="SCRUM-12" />
          </Field>
        )}
        {isCreate && (
          <>
            <Field label="Project">
              <select className={fieldCls} value={p.projectKey ?? ''} onChange={(e) => set('projectKey', e.target.value)}>
                <option value="">Select…</option>
                {projects.map((pr) => <option key={pr.key} value={pr.key}>{pr.key} · {pr.name}</option>)}
              </select>
            </Field>
            <Field label="Type">
              <select className={fieldCls} value={p.issueType ?? 'Task'} onChange={(e) => set('issueType', e.target.value)}>
                {issueTypes.map((t) => <option key={t} value={t}>{t}</option>)}
              </select>
            </Field>
          </>
        )}
        {(isCreate || p.operation === 'update' || p.operation === 'assign') && (
          <Field label="Summary">
            <input className={fieldCls} value={p.summary ?? ''} onChange={(e) => set('summary', e.target.value)} placeholder="Short title" />
          </Field>
        )}
        {(isCreate || p.operation === 'update' || p.operation === 'assign') && (
          <Field label="Assignee">
            <input className={fieldCls} value={p.assigneeName ?? ''} onChange={(e) => set('assigneeName', e.target.value)} placeholder="Name (resolved to Jira user)" />
          </Field>
        )}
        {(isCreate || p.operation === 'update') && (
          <>
            <Field label="Due date">
              <input type="date" className={fieldCls} value={p.dueDate ?? ''} onChange={(e) => set('dueDate', e.target.value)} />
            </Field>
            <Field label="Priority">
              <select className={fieldCls} value={p.priority ?? ''} onChange={(e) => set('priority', e.target.value || undefined)}>
                <option value="">—</option>
                {PRIORITIES.map((pr) => <option key={pr} value={pr}>{pr}</option>)}
              </select>
            </Field>
          </>
        )}
        {(p.operation === 'transition' || p.operation === 'close' || p.operation === 'update') && (
          <Field label="Status">
            <input className={fieldCls} value={p.status ?? ''} onChange={(e) => set('status', e.target.value)} placeholder="In Progress / Done" />
          </Field>
        )}
        {(isCreate || p.operation === 'update') && (
          <div className="col-span-2">
            <Field label="Description">
              <textarea className={`${fieldCls} resize-none`} rows={3} value={p.description ?? ''} onChange={(e) => set('description', e.target.value)} placeholder="Details (markdown)" />
            </Field>
          </div>
        )}
        {p.operation === 'comment' && (
          <div className="col-span-2">
            <Field label="Comment">
              <textarea className={`${fieldCls} resize-none`} rows={3} value={p.comment ?? ''} onChange={(e) => set('comment', e.target.value)} placeholder="Comment to post" />
            </Field>
          </div>
        )}
      </div>

      {state === 'error' && result && (
        <div className="px-3.5 pb-2 -mt-1 flex items-start gap-1.5 text-[11.5px] text-red-500">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {result.message}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-3.5 py-2.5 border-t border-app-border bg-app-panel/40">
        <button
          onClick={dismiss}
          disabled={state === 'working'}
          className="px-3 py-1.5 rounded-lg text-[12px] text-app-fg-muted hover:bg-app-nav-hover-bg disabled:opacity-50 flex items-center gap-1.5"
        >
          <X size={13} /> Dismiss
        </button>
        <button
          onClick={approve}
          disabled={state === 'working'}
          className="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-60 flex items-center gap-1.5"
        >
          {state === 'working' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.5} />}
          {state === 'working' ? 'Applying…' : state === 'error' ? 'Retry' : 'Approve & apply'}
        </button>
      </div>
    </div>
  );
}
