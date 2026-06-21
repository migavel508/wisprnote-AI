import { useState } from 'react';
import { ShieldAlert } from 'lucide-react';
import type { PendingApproval } from '../services/agentLoopService';

export type ApprovalDecision = 'once' | 'task' | 'deny';

/**
 * AGENT APPROVAL CARD — the in-chat HITL gate for the agentic loop (Phase 4), styled after Claude's
 * tool-permission prompt: "wants to use <tool> from <connector>", the Request JSON, a risk note, and
 * Allow for this task / Allow once / Deny.
 *
 * Unlike McpActionCard (which executes the write itself), this card only RESOLVES the loop's
 * onApprovalRequest decision: the loop then re-runs the tool through the gated/audited server
 * executor and feeds the result back. "Allow for this task" additionally tells the caller to stop
 * asking for this tool for the rest of the conversation.
 */
export default function AgentApprovalCard({ req, onDecide }: { req: PendingApproval; onDecide: (decision: ApprovalDecision) => void }) {
  const [decided, setDecided] = useState<null | ApprovalDecision>(null);
  const decide = (d: ApprovalDecision) => { if (decided !== null) return; setDecided(d); onDecide(d); };

  const tool = req.tool || req.name;
  const connector = req.connector || 'a connector';
  const argsJson = JSON.stringify(req.args ?? {}, null, 2);

  return (
    <div className="mt-2.5 rounded-xl border border-app-divider bg-app-raised/40 overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3">
        <span className="w-5 h-5 rounded-md bg-app-chip flex items-center justify-center flex-shrink-0 text-[11px] font-semibold text-app-fg-muted">
          {connector[0]?.toUpperCase() || '!'}
        </span>
        <span className="text-[13.5px] text-app-fg">
          Agent wants to run <span className="font-mono text-app-fg">{tool}</span> from <span className="font-medium">{connector}</span>
        </span>
      </div>

      <div className="px-4 pb-3">
        <div className="rounded-lg bg-app-canvas border border-app-divider overflow-hidden">
          <div className="px-3 pt-2.5 pb-1 text-[11px] font-semibold text-app-fg-subtle">Request</div>
          <pre className="px-3 pb-3 text-[12px] font-mono text-app-fg whitespace-pre-wrap break-words max-h-48 overflow-y-auto">{argsJson}</pre>
        </div>
      </div>

      <div className="flex items-start gap-2 px-4 pb-2.5 text-[12px] text-app-fg-subtle">
        <ShieldAlert className="w-4 h-4 text-amber-500 flex-shrink-0 mt-px" strokeWidth={2} />
        <span>Allowing this action comes with risks. Malicious instructions in files, emails, and web content could trick the agent into unintended actions.</span>
      </div>

      <div className="flex items-center gap-2 px-4 pb-3.5">
        {decided === null ? (
          <>
            <button
              onClick={() => decide('task')}
              className="px-3 py-1.5 rounded-lg bg-[#1a1a1a] text-white text-[12.5px] font-medium hover:bg-[#333] active:scale-95 transition-all"
            >
              Allow for this task
            </button>
            <button
              onClick={() => decide('once')}
              className="px-3 py-1.5 rounded-lg bg-app-chip text-app-fg text-[12.5px] font-medium hover:bg-app-raised active:scale-95 transition-all"
            >
              Allow once
            </button>
            <button
              onClick={() => decide('deny')}
              className="px-3 py-1.5 rounded-lg bg-app-chip text-app-fg-muted text-[12.5px] font-medium hover:bg-app-raised active:scale-95 transition-all"
            >
              Deny
            </button>
          </>
        ) : (
          <span className={`text-[12px] font-medium ${decided === 'deny' ? 'text-app-fg-subtle' : 'text-emerald-600 dark:text-emerald-400'}`}>
            {decided === 'deny' ? 'Denied.' : decided === 'task' ? 'Allowed for this task — running…' : 'Allowed — running…'}
          </span>
        )}
      </div>
    </div>
  );
}
