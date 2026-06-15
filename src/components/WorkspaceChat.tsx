import { useEffect, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { ChevronDown, Paperclip, Mic, Send, X, Check, Loader2, Sparkles, History, Plus, LayoutGrid, FileText } from 'lucide-react';
import { assistantMarkdownComponents } from './chatMarkdown';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { CHAT_MODELS, getChatModel, setChatModelId, type ChatModelDef } from '../services/chatModels';
import { agentChatAllMeetings, type SearchableMeeting, type AgentSearchStep } from '../services/geminiService';
import { embedQuery, queryHybridScoped } from '../services/turbopufferService';
import { buildMeetingCard, hasOffTrackTopic } from '../services/meetingEvidence';
import { saveChatMessage, getWorkspaceChatThreads, getChatHistoryByThread, type ChatThreadRow } from '../services/awsService';
import { serverChat, isServerChatEnabled } from '../services/aiProxyService';

type SearchFilters = { recent_days?: number; start_ms?: number; end_ms?: number; off_track?: boolean };

/** A meeting's content as a structured evidence card (date/attendees/KG + body). */
const card = (m: SearchableMeeting, content: string) =>
  buildMeetingCard({ title: m.title, createdAt: m.createdAt, attendees: m.attendees, kg: m.kg, content });

interface Msg { role: 'user' | 'model'; text: string }

// Workspace-oriented quick prompts (the reference's recipe chips).
const RECIPES: { label: string; prompt: string }[] = [
  { label: 'Catch me up', prompt: 'Catch me up on what has been happening across this workspace.' },
  { label: 'List key decisions', prompt: 'What key decisions were made across this workspace’s meetings?' },
  { label: 'Show in-flight projects', prompt: 'What projects are currently in flight based on these meetings?' },
];

const newThreadId = (): string => {
  try { return crypto.randomUUID(); } catch { return `t_${Date.now()}_${Math.floor(performance.now())}`; }
};

/**
 * Workspace-scoped chat — the "Ask anything" surface on the workspace home.
 * Answers ONLY from the meetings/notes that belong to the workspace + its
 * folders (passed in as `scopedMeetings`); reuses the product's existing chat
 * backend (agentChatAllMeetings, model routing, voice, durable threads).
 */
export default function WorkspaceChat({
  workspaceId,
  workspaceName,
  scopedMeetings,
  session,
}: {
  workspaceId: string;
  workspaceName: string;
  scopedMeetings: SearchableMeeting[];
  session?: { user: { id: string; email: string; name?: string } } | null;
}) {
  const [messages, setMessages] = useState<Msg[]>([]);
  const [input, setInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [threadId, setThreadId] = useState<string>(() => newThreadId());
  const [threads, setThreads] = useState<ChatThreadRow[]>([]);
  const [modelMenuOpen, setModelMenuOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [activeModel, setActiveModel] = useState<ChatModelDef>(() => getChatModel());
  // Live agent "thought process" — the plan + each retrieval tool call, shown in
  // the UI as steps while the answer is being assembled.
  const [plan, setPlan] = useState<string[]>([]);
  const [steps, setSteps] = useState<AgentSearchStep[]>([]);

  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const modelRef = useRef<HTMLDivElement>(null);
  const historyRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);

  const voice = useVoiceInput((t) => setInput((prev) => (prev ? `${prev} ${t}` : t)), isChatting);

  // Load this workspace's durable thread list.
  useEffect(() => {
    let cancelled = false;
    getWorkspaceChatThreads(workspaceId)
      .then((rows) => { if (!cancelled) setThreads(rows); })
      .catch(() => { /* non-fatal */ });
    return () => { cancelled = true; };
  }, [workspaceId]);

  // Close popovers on outside click.
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (modelRef.current && !modelRef.current.contains(e.target as Node)) setModelMenuOpen(false);
      if (historyRef.current && !historyRef.current.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages, isChatting, steps]);

  const upsertStep = (prev: AgentSearchStep[], s: AgentSearchStep): AgentSearchStep[] => {
    const i = prev.findIndex((x) => x.callId === s.callId);
    if (i === -1) return [...prev, s];
    const next = prev.slice();
    next[i] = s;
    return next;
  };

  // Scoped retrieval over ONLY this workspace's meetings: Turbopuffer semantic
  // (restoring the quality lost when this was keyword-only) with a keyword
  // fallback, structured evidence cards, and the deterministic date/off-track
  // scope the agent passes in. It can never reach meetings outside the workspace.
  const scopedSearchFn = async (query: string, filters?: SearchFilters, limit?: number) => {
    const byId = new Map(scopedMeetings.map((m) => [m.meetingId, m]));
    let pool = scopedMeetings;
    if (typeof filters?.start_ms === 'number' && typeof filters?.end_ms === 'number') {
      pool = pool.filter((m) => {
        const t = m.createdAt ? new Date(m.createdAt).getTime() : NaN;
        return t >= filters.start_ms! && t <= filters.end_ms!;
      });
    }
    if (filters?.off_track) {
      const flagged = pool.filter((m) => hasOffTrackTopic(m.kg));
      if (flagged.length) pool = flagged;
    }
    const poolIds = new Set(pool.map((m) => m.meetingId));
    const topK = Math.min(Math.max(limit ?? 5, 1), 8);
    const q = query.trim();
    const body = (m: SearchableMeeting) => m.notes?.trim() || m.summary?.trim() || m.transcription.slice(0, 2000);

    // Listing mode (empty query, e.g. "this month") → every in-scope meeting.
    if (!q) {
      const sorted = pool.slice().sort((a, b) => (b.createdAt ?? '').localeCompare(a.createdAt ?? ''));
      return {
        results: sorted.map((m) => ({ meetingId: m.meetingId, meetingTitle: m.title, score: 1, date: m.createdAt })),
        contextText: sorted.map((m) => card(m, body(m))).join('\n\n---\n\n') || 'No meetings in scope.',
      };
    }

    // Semantic search constrained to the in-scope meeting set.
    try {
      const vec = await embedQuery(q);
      const hits = await queryHybridScoped(vec, q, topK, poolIds);
      if (hits.length) {
        const chunksByMeeting = new Map<string, string[]>();
        for (const h of hits) {
          const arr = chunksByMeeting.get(h.meetingId) ?? [];
          arr.push(h.text);
          chunksByMeeting.set(h.meetingId, arr);
        }
        return {
          results: hits.map((h) => ({ meetingId: h.meetingId, meetingTitle: h.meetingTitle, score: h.score, date: byId.get(h.meetingId)?.createdAt })),
          contextText: [...chunksByMeeting.entries()]
            .map(([mid, texts]) => card(byId.get(mid) ?? ({ title: '' } as SearchableMeeting), texts.join('\n…\n')))
            .join('\n\n---\n\n'),
        };
      }
    } catch { /* fall through to keyword */ }

    // Keyword fallback (still scoped, still carded).
    const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 2);
    const scored = pool
      .map((m) => {
        const owners = (m.kg?.action_items ?? []).map((a) => a.owner ?? '').join(' ');
        const hay = `${m.title} ${(m.attendees ?? []).join(' ')} ${owners} ${m.notes || ''} ${m.summary || ''} ${m.transcription}`.toLowerCase();
        let s = 0; for (const t of terms) if (hay.includes(t)) s++;
        return { m, s };
      })
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .slice(0, topK);
    return {
      results: scored.map(({ m, s }) => ({ meetingId: m.meetingId, meetingTitle: m.title, score: s, date: m.createdAt })),
      contextText: scored.length ? scored.map(({ m }) => card(m, body(m))).join('\n\n---\n\n') : 'No matching meetings found.',
    };
  };

  const send = async (raw?: string) => {
    const text = (raw ?? input).trim();
    if (!text || isChatting) return;
    const tid = threadId;
    setMessages((prev) => [...prev, { role: 'user', text }]);
    setInput('');
    setIsChatting(true);
    setPlan([]);
    setSteps([]);
    void saveChatMessage({ role: 'user', text, thread_id: tid, workspace_id: workspaceId }).catch(() => {});

    const history = messages.map((m) => ({ role: m.role, parts: [{ text: m.text }] }));
    try {
      let answer: string;
      if (isServerChatEnabled()) {
        // SERVER-SIDE agent: retrieval + synthesis run in the Lambda, tenant-
        // isolated and bounded (the corpus never leaves the server).
        setPlan([`Searching ${workspaceName} on the server…`]);
        const res = await serverChat({
          query: text,
          scope: 'workspace',
          workspaceId,
          history: messages.map((m) => ({ role: m.role, text: m.text })),
          model: activeModel.provider === 'anthropic' ? 'claude' : 'gemini',
        });
        answer = res.answer;
      } else {
        // Client-side fallback: scoped semantic search (structured cards) over
        // ONLY this workspace's meetings; retrieval reflected live in the UI.
        answer = await agentChatAllMeetings(text, history, scopedMeetings, {
          searchFn: scopedSearchFn,
          onPlan: (p) => setPlan(p.steps),
          onToolCallStart: (s) => setSteps((prev) => upsertStep(prev, s)),
          onToolCallDone: (s) => setSteps((prev) => upsertStep(prev, s)),
        });
      }
      setMessages((prev) => [...prev, { role: 'model', text: answer }]);
      void saveChatMessage({ role: 'model', text: answer, thread_id: tid, workspace_id: workspaceId }).catch(() => {});
      // Refresh the durable thread list so this conversation appears in History.
      getWorkspaceChatThreads(workspaceId).then(setThreads).catch(() => {});
    } catch {
      setMessages((prev) => [...prev, { role: 'model', text: 'Sorry — something went wrong answering that. Please try again.' }]);
    } finally {
      setIsChatting(false);
    }
  };

  const startNewChat = () => {
    setMessages([]);
    setThreadId(newThreadId());
    setHistoryOpen(false);
    setInput('');
  };

  const openThread = async (t: ChatThreadRow) => {
    setHistoryOpen(false);
    setThreadId(t.thread_id);
    try {
      const msgs = await getChatHistoryByThread(t.thread_id);
      setMessages(msgs.map((m) => ({ role: m.role, text: m.text })));
    } catch { /* non-fatal */ }
  };

  const pickModel = (m: ChatModelDef) => {
    if (!m.available) return;
    setChatModelId(m.id);
    setActiveModel(m);
    setModelMenuOpen(false);
  };

  const isEmpty = messages.length === 0;
  const greetingName = session?.user?.name?.split(' ')[0] || 'there';

  return (
    <div className="rounded-2xl border border-app-divider bg-app-panel">
      {/* Conversation (only once there are messages) */}
      {!isEmpty && (
        <div ref={scrollRef} className="max-h-[44vh] overflow-y-auto px-4 sm:px-6 py-5 space-y-5">
          {messages.map((m, i) =>
            m.role === 'user' ? (
              <div key={i} className="flex justify-end">
                <div className="max-w-[85%] bg-[#f5f2ef] dark:bg-app-chip text-zinc-900 dark:text-app-fg px-4 py-2.5 rounded-3xl rounded-tr-md text-[13.5px]">
                  {m.text}
                </div>
              </div>
            ) : (
              <div key={i} className="flex justify-start">
                <div className="max-w-[88%] w-full">
                  <div className="flex items-center gap-2.5 mb-2.5">
                    <div className="w-6 h-6 rounded-full bg-[#1a1a1a] flex items-center justify-center flex-shrink-0">
                      <Sparkles className="w-3 h-3 text-white" />
                    </div>
                    <span className="text-[12.5px] font-semibold text-zinc-800 dark:text-zinc-200">WisprNote AI</span>
                  </div>
                  <div className="pl-[34px] min-w-0">
                    <Markdown remarkPlugins={[remarkGfm]} components={assistantMarkdownComponents as any}>{m.text}</Markdown>
                  </div>
                </div>
              </div>
            ),
          )}
          {isChatting && (
            <div className="rounded-xl bg-app-raised/50 px-3.5 py-3 text-[12px]">
              <div className="flex items-center gap-2 text-app-fg-muted font-medium mb-1.5">
                <Loader2 className="w-3.5 h-3.5 animate-spin" /> Working on it…
              </div>
              {plan.map((p, i) => (
                <div key={`p${i}`} className="flex items-start gap-2 pl-0.5 py-0.5 text-app-fg-subtle">
                  <span className="mt-[3px] w-1 h-1 rounded-full bg-app-fg-subtle flex-shrink-0" /> {p}
                </div>
              ))}
              {steps.map((s) => (
                <div key={s.callId} className="flex items-start gap-2 pl-0.5 py-0.5 text-app-fg-subtle">
                  {s.status === 'done'
                    ? <Check className="w-3.5 h-3.5 text-emerald-500 flex-shrink-0 mt-px" strokeWidth={2.4} />
                    : <Loader2 className="w-3.5 h-3.5 animate-spin flex-shrink-0 mt-px" />}
                  <span>
                    {s.kind === 'contacts' ? 'Looking up' : 'Searching notes for'}{' '}
                    <span className="text-app-fg">{s.query?.trim() ? `“${s.query.trim()}”` : 'all meetings'}</span>
                    {s.status === 'done' && s.results ? <span className="text-app-fg-subtle"> · {s.results.length} found</span> : null}
                  </span>
                </div>
              ))}
            </div>
          )}
          {/* Say more */}
          {!isChatting && messages.length > 0 && messages[messages.length - 1].role === 'model' && (
            <button
              onClick={() => void send('Say more about that.')}
              className="ml-[34px] px-3 py-1.5 rounded-full bg-zinc-100 dark:bg-app-raised hover:bg-zinc-200 dark:hover:bg-app-chip text-[12px] font-medium text-zinc-700 dark:text-zinc-300 transition-colors"
            >
              Say more
            </button>
          )}
        </div>
      )}

      {/* Input bar */}
      <div className="p-3 sm:p-4">
        <div className="rounded-2xl border border-app-divider bg-app-canvas">
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(); } }}
            placeholder={voice.isTranscribing ? 'Transcribing…' : 'Ask anything'}
            disabled={voice.isTranscribing}
            rows={1}
            autoComplete="off"
            autoCorrect="off"
            autoCapitalize="off"
            spellCheck={false}
            name="workspace-chat"
            className="w-full bg-transparent border-none outline-none px-4 py-3 text-[14px] text-app-fg placeholder:text-app-fg-subtle resize-none max-h-32 min-h-[44px]"
          />
          <div className="flex items-center gap-1 px-2.5 pb-2.5">
            {/* Model selector */}
            <div className="relative" ref={modelRef}>
              <button
                onClick={() => setModelMenuOpen((v) => !v)}
                className="flex items-center gap-1 px-2 py-1 rounded-lg text-[12.5px] text-app-fg-muted hover:bg-app-nav-hover-bg transition-colors"
              >
                {activeModel.label} <ChevronDown className={`w-3.5 h-3.5 transition-transform ${modelMenuOpen ? 'rotate-180' : ''}`} />
              </button>
              {modelMenuOpen && (
                <div className="absolute top-full left-0 mt-2 w-[240px] z-50 rounded-xl bg-app-panel border border-app-divider shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28)] ring-1 ring-black/[0.03] py-1.5 max-h-[320px] overflow-y-auto">
                  {(['auto', 'standard', 'thinking'] as const).map((group) => {
                    const items = CHAT_MODELS.filter((m) => m.group === group);
                    if (!items.length) return null;
                    return (
                      <div key={group}>
                        {group !== 'auto' && (
                          <div className="px-3 pt-2 pb-1 text-[10.5px] font-semibold uppercase tracking-wide text-app-fg-subtle">
                            {group === 'standard' ? 'Standard Models' : 'Thinking Models'}
                          </div>
                        )}
                        {items.map((m) => (
                          <button
                            key={m.id}
                            onClick={() => pickModel(m)}
                            disabled={!m.available}
                            className={`w-full flex items-center gap-2 px-3 py-1.5 text-left text-[13px] transition-colors ${
                              m.available ? 'text-app-fg hover:bg-app-nav-hover-bg' : 'text-app-fg-subtle/60 cursor-not-allowed'
                            }`}
                          >
                            <span className="flex-1 truncate">{m.label}</span>
                            {m.badge && <span className="text-[9px] font-semibold text-app-accent">{m.badge}</span>}
                            {activeModel.id === m.id && <Check className="w-3.5 h-3.5 text-app-fg" />}
                          </button>
                        ))}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <div className="flex-1" />

            {/* History */}
            <div className="relative" ref={historyRef}>
              <button
                onClick={() => setHistoryOpen((v) => !v)}
                title="Chat history"
                className="p-1.5 rounded-lg text-app-fg-subtle hover:text-app-fg hover:bg-app-nav-hover-bg transition-colors"
              >
                <History className="w-[17px] h-[17px]" strokeWidth={1.8} />
              </button>
              {historyOpen && (
                <div className="absolute top-full right-0 mt-2 w-[280px] z-50 rounded-xl bg-app-panel border border-app-divider shadow-[0_20px_50px_-12px_rgba(0,0,0,0.28)] ring-1 ring-black/[0.03] py-1.5">
                  <button onClick={startNewChat} className="w-full flex items-center gap-2 px-3 py-2 text-left text-[13px] text-app-fg hover:bg-app-nav-hover-bg transition-colors">
                    <Plus className="w-3.5 h-3.5" /> New chat
                  </button>
                  <div className="my-1 h-px bg-app-divider" />
                  {threads.length === 0 ? (
                    <div className="px-3 py-2 text-[12px] text-app-fg-subtle">No conversations yet.</div>
                  ) : (
                    <div className="max-h-[220px] overflow-y-auto">
                      {threads.map((t) => (
                        <button
                          key={t.thread_id}
                          onClick={() => void openThread(t)}
                          className={`w-full text-left px-3 py-1.5 hover:bg-app-nav-hover-bg transition-colors ${t.thread_id === threadId ? 'bg-app-nav-hover-bg' : ''}`}
                        >
                          <p className="text-[12.5px] text-app-fg truncate">{t.title || 'New chat'}</p>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>

            <button title="Attach" className="p-1.5 rounded-lg text-app-fg-subtle hover:text-app-fg hover:bg-app-nav-hover-bg transition-colors">
              <Paperclip className="w-[17px] h-[17px]" strokeWidth={1.7} />
            </button>

            {/* Voice / send */}
            {voice.isRecording ? (
              <div className="flex items-center gap-2">
                <canvas ref={voice.canvasRef} className="w-[140px] h-7" />
                <span className="text-[12px] tabular-nums text-app-fg-muted">{voice.fmtRec(voice.recSeconds)}</span>
                <button onClick={voice.cancelVoice} className="w-8 h-8 rounded-full bg-[#1a1a1a] text-white flex items-center justify-center hover:bg-[#333] active:scale-95 transition-all">
                  <X className="w-3.5 h-3.5" strokeWidth={2.4} />
                </button>
                <button onClick={voice.confirmVoice} className="w-8 h-8 rounded-full bg-[#4b4b4b] text-white flex items-center justify-center hover:bg-[#333] active:scale-95 transition-all">
                  <Check className="w-3.5 h-3.5" strokeWidth={2.6} />
                </button>
              </div>
            ) : voice.isTranscribing ? (
              <div className="w-8 h-8 flex items-center justify-center"><Loader2 className="w-4 h-4 animate-spin text-app-fg-subtle" /></div>
            ) : input.trim() ? (
              <button onClick={() => void send()} disabled={isChatting} className="w-8 h-8 rounded-full bg-[#1a1a1a] text-white flex items-center justify-center hover:bg-[#333] active:scale-95 disabled:opacity-20 transition-all">
                <Send className="w-4 h-4" />
              </button>
            ) : (
              <button onClick={voice.startVoice} title="Voice input" className="w-8 h-8 rounded-full bg-app-chip text-app-fg-muted flex items-center justify-center hover:bg-app-raised active:scale-95 transition-all">
                <Mic className="w-[17px] h-[17px]" strokeWidth={1.8} />
              </button>
            )}
          </div>
        </div>

        {/* Recipe chips */}
        <div className="flex items-center gap-2 mt-2.5 flex-wrap">
          {RECIPES.map((r) => (
            <button
              key={r.label}
              onClick={() => void send(r.prompt)}
              disabled={isChatting}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded-full text-[12px] font-medium text-app-fg-muted hover:bg-app-nav-hover-bg transition-colors disabled:opacity-50"
            >
              <FileText className="w-3 h-3 text-app-fg-subtle" /> {r.label}
            </button>
          ))}
          <div className="flex-1" />
          <button className="flex items-center gap-1.5 px-2 py-1.5 rounded-full text-[12px] font-medium text-app-fg-muted hover:bg-app-nav-hover-bg transition-colors">
            <LayoutGrid className="w-3.5 h-3.5" /> All recipes
          </button>
        </div>

        {isEmpty && scopedMeetings.length === 0 && (
          <p className="mt-3 text-center text-[11.5px] text-app-fg-subtle">
            Add notes to <span className="font-medium text-app-fg-muted">{workspaceName}</span> and ask anything about them, {greetingName}.
          </p>
        )}
      </div>
    </div>
  );
}
