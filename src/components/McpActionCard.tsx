import { useState } from 'react';
import { Check, X, Loader2, ExternalLink, AlertTriangle, Wrench } from 'lucide-react';
import { executeMcpWrite, type McpWriteProposal, type McpWriteResult } from '../services/jiraActionService';

/**
 * Generic HITL approval card for any MCP write the agent proposed (Confluence page/
 * comment, worklog, issue link, Compass component, custom field, …). Every argument is
 * editable; nothing is written until the user approves. Args render as labelled fields
 * (string/number/boolean inline; objects/arrays as JSON), so it adapts to any tool.
 */

// Friendly labels for the common Atlassian write tools.
const TOOL_LABEL: Record<string, string> = {
  addWorklogToJiraIssue: 'Add worklog', createIssueLink: 'Link issues',
  createConfluencePage: 'Create Confluence page', updateConfluencePage: 'Update Confluence page',
  createConfluenceFooterComment: 'Add Confluence comment', createConfluenceInlineComment: 'Add inline comment',
  createCompassComponent: 'Create Compass component', createComponentRelationship: 'Link components',
  createCustomFieldDefinition: 'Create custom field', addTeamworkGraphContext: 'Add Teamwork Graph context',
};

const fieldCls = 'w-full text-[12.5px] bg-app-panel border border-app-border rounded-lg px-2.5 py-1.5 text-app-fg outline-none focus:border-app-accent placeholder:text-app-fg-subtle';
const labelCls = 'text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] mb-1 block';

const isScalar = (v: unknown) => v === null || ['string', 'number', 'boolean'].includes(typeof v);

export default function McpActionCard({ proposal, workspaceId, onResolved }: { proposal: McpWriteProposal; workspaceId: string; onResolved?: (status: 'executed' | 'dismissed', result?: McpWriteResult) => void }) {
  const [args, setArgs] = useState<Record<string, unknown>>(() => ({ ...(proposal.args || {}) }));
  const [state, setState] = useState<'editing' | 'working' | 'done' | 'error' | 'dismissed'>('editing');
  const [result, setResult] = useState<McpWriteResult | null>(null);

  const setField = (k: string, v: unknown) => setArgs((p) => ({ ...p, [k]: v }));
  const label = TOOL_LABEL[proposal.tool] || proposal.tool;

  const approve = async () => {
    setState('working');
    const r = await executeMcpWrite(workspaceId, proposal.connector, proposal.tool, args)
      .catch((): McpWriteResult => ({ ok: false, message: 'Network error.' }));
    setResult(r);
    setState(r.ok ? 'done' : 'error');
    if (r.ok) onResolved?.('executed', r);   // clear it from the suggestion queue
  };

  const dismiss = () => { setState('dismissed'); onResolved?.('dismissed'); };

  if (state === 'dismissed') return <div className="mt-2 text-[11.5px] text-app-fg-subtle italic">Dismissed — nothing was written.</div>;
  if (state === 'done' && result) {
    return (
      <div className="mt-2 rounded-xl border border-kg-accent/40 bg-kg-accent/5 px-3.5 py-3 flex items-center gap-2 text-[13px] text-app-fg">
        <span className="w-5 h-5 rounded-full bg-kg-accent/20 flex items-center justify-center flex-shrink-0"><Check size={12} className="text-kg-accent" strokeWidth={2.5} /></span>
        <span>{result.message}</span>
        {result.url && <a href={result.url} target="_blank" rel="noreferrer" className="ml-auto inline-flex items-center gap-1 text-[12px] text-app-accent hover:underline">Open <ExternalLink size={11} /></a>}
      </div>
    );
  }

  return (
    <div className="mt-2 rounded-xl border border-app-border bg-app-status-bg overflow-hidden">
      <div className="flex items-center gap-2 px-3.5 py-2.5 border-b border-app-border">
        <Wrench size={14} className="text-app-fg-subtle" />
        <span className="text-[12px] font-semibold text-app-fg">{label}</span>
        <span className="text-[10px] text-app-fg-subtle font-mono">{proposal.tool}</span>
        <span className="ml-auto text-[10px] font-medium uppercase tracking-wide px-2 py-0.5 rounded-full bg-app-accent/15 text-app-accent border border-app-accent/30">Needs approval</span>
      </div>

      <div className="px-3.5 py-3 space-y-2.5">
        {Object.keys(args).length === 0 && <p className="text-[12px] text-app-fg-subtle">No parameters.</p>}
        {Object.entries(args).map(([k, v]) => (
          <div key={k}>
            <span className={labelCls}>{k}</span>
            {isScalar(v) ? (
              typeof v === 'boolean' ? (
                <select className={fieldCls} value={String(v)} onChange={(e) => setField(k, e.target.value === 'true')}>
                  <option value="true">true</option><option value="false">false</option>
                </select>
              ) : (
                <input
                  className={fieldCls}
                  value={v == null ? '' : String(v)}
                  onChange={(e) => setField(k, typeof v === 'number' ? Number(e.target.value) : e.target.value)}
                />
              )
            ) : (
              <textarea
                className={`${fieldCls} resize-none font-mono text-[11px]`} rows={3}
                value={JSON.stringify(v, null, 2)}
                onChange={(e) => { try { setField(k, JSON.parse(e.target.value)); } catch { /* keep typing */ } }}
              />
            )}
          </div>
        ))}
      </div>

      {state === 'error' && result && (
        <div className="px-3.5 pb-2 -mt-1 flex items-start gap-1.5 text-[11.5px] text-red-500">
          <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" /> {result.message}
        </div>
      )}

      <div className="flex items-center justify-end gap-2 px-3.5 py-2.5 border-t border-app-border bg-app-panel/40">
        <button onClick={dismiss} disabled={state === 'working'} className="px-3 py-1.5 rounded-lg text-[12px] text-app-fg-muted hover:bg-app-nav-hover-bg disabled:opacity-50 flex items-center gap-1.5"><X size={13} /> Dismiss</button>
        <button onClick={approve} disabled={state === 'working'} className="px-3.5 py-1.5 rounded-lg text-[12px] font-semibold bg-app-accent text-app-accent-fg hover:bg-app-accent-hover disabled:opacity-60 flex items-center gap-1.5">
          {state === 'working' ? <Loader2 size={13} className="animate-spin" /> : <Check size={13} strokeWidth={2.5} />}
          {state === 'working' ? 'Applying…' : state === 'error' ? 'Retry' : 'Approve & apply'}
        </button>
      </div>
    </div>
  );
}
