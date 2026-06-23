import { useState } from 'react';
import { X, Plus, LayoutGrid, ChevronLeft, Sparkles, Link2, Check, Info } from 'lucide-react';
import { getBuiltInGems, getUserGems, createGem, type Gem } from '../services/gemsService';

interface Props {
  onClose: () => void;
  onRun: (gem: Gem) => void;
}

const GemIcon = ({ size = 18 }: { size?: number }) => (
  <span className="flex items-center justify-center rounded-lg bg-[#1a1a1a]/[0.05] dark:bg-app-chip text-zinc-500 dark:text-app-fg-subtle flex-shrink-0" style={{ width: size + 12, height: size + 12 }}>
    <span className="text-[13px] font-medium">/</span>
  </span>
);

export default function GemsModal({ onClose, onRun }: Props) {
  const [view, setView] = useState<'list' | 'detail' | 'create'>('list');
  const [selected, setSelected] = useState<Gem | null>(null);
  const [copied, setCopied] = useState(false);
  const [userGems, setUserGems] = useState<Gem[]>(() => getUserGems());
  const builtIns = getBuiltInGems();

  // create form
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');
  const [prompt, setPrompt] = useState('');
  const canCreate = name.trim() && prompt.trim();

  const open = (g: Gem) => { setSelected(g); setView('detail'); setCopied(false); };
  const run = (g: Gem) => { onRun(g); onClose(); };
  const submitCreate = () => {
    if (!canCreate) return;
    const g = createGem({ name, description: desc, prompt });
    setUserGems(getUserGems());
    setName(''); setDesc(''); setPrompt('');
    open(g);
  };

  const Row = ({ g }: { g: Gem }) => (
    <button onClick={() => open(g)} className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-[#1a1a1a]/[0.035] dark:hover:bg-app-chip/50 transition-colors text-left">
      <GemIcon />
      <div className="min-w-0 flex-1">
        <div className="text-[14px] font-medium text-app-fg truncate">{g.name}</div>
        <div className="text-[12.5px] text-app-fg-subtle truncate">{g.description}</div>
      </div>
      {g.author && g.author !== 'You' && <span className="text-[12.5px] text-app-fg-subtle flex-shrink-0">{g.author}</span>}
      <Info className="w-4 h-4 text-app-fg-subtle/60 flex-shrink-0" />
    </button>
  );

  return (
    <div className="fixed inset-0 z-[9999] flex items-start justify-center bg-black/20 backdrop-blur-sm font-sans p-6 overflow-y-auto" onClick={onClose}>
      <div
        className="bg-app-canvas rounded-[20px] border border-app-divider shadow-[0_24px_64px_-16px_rgba(0,0,0,0.3)] w-full max-w-[760px] my-6 overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-2 px-5 py-4 border-b border-app-divider">
          {view !== 'list' ? (
            <button onClick={() => setView('list')} className="p-1 -ml-1 rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><ChevronLeft size={18} /></button>
          ) : (
            <GemIcon size={14} />
          )}
          <span className="text-[15px] font-semibold text-app-fg">{view === 'create' ? 'Create a Gem' : 'Gems'}</span>
          <div className="ml-auto flex items-center gap-1.5">
            {view === 'list' && (
              <>
                <button onClick={() => setView('create')} className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12.5px] font-medium text-app-fg border border-app-divider hover:bg-app-nav-hover-bg transition-colors"><Plus size={13} /> Create Gem</button>
                <button className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-full text-[12.5px] font-medium text-app-fg border border-app-divider hover:bg-app-nav-hover-bg transition-colors"><LayoutGrid size={13} /> Browse all</button>
              </>
            )}
            <button onClick={onClose} className="p-1.5 rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg"><X size={17} /></button>
          </div>
        </div>

        {/* List */}
        {view === 'list' && (
          <div className="px-3 py-3 max-h-[60vh] overflow-y-auto">
            {userGems.length > 0 && (
              <>
                <div className="px-3 pt-1 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-app-fg-label">My Gems</div>
                {userGems.map((g) => <Row key={g.id} g={g} />)}
                <div className="px-3 pt-3 pb-1.5 text-[11px] font-medium uppercase tracking-wider text-app-fg-label">All Gems</div>
              </>
            )}
            {builtIns.map((g) => <Row key={g.id} g={g} />)}
          </div>
        )}

        {/* Detail */}
        {view === 'detail' && selected && (
          <div className="px-6 py-6 max-h-[64vh] overflow-y-auto">
            {/* Featured card */}
            <div className="rounded-2xl p-5 mb-5" style={{ background: 'linear-gradient(120deg, #cdd7e8 0%, #d6e2d0 45%, #e6dcc9 100%)' }}>
              {selected.featured && (
                <div className="flex items-center gap-1.5 text-[12.5px] text-[#3a4a2e] mb-4"><Check size={13} /> Featured Gem</div>
              )}
              <div className="flex items-center gap-2">
                <GemIcon size={16} />
                <span className="text-[18px] font-semibold text-[#1c1a17]">{selected.name}</span>
                {selected.author && <span className="ml-auto text-[12.5px] text-[#3a3a3a]/80">Gem by {selected.author}</span>}
              </div>
            </div>

            <p className="text-[15px] text-app-fg leading-relaxed mb-5">{selected.description}</p>

            <div className="flex items-center gap-2 mb-6">
              <button onClick={() => { navigator.clipboard?.writeText(selected.name).catch(() => {}); setCopied(true); }} className="flex items-center gap-1.5 px-3.5 py-2 rounded-full text-[13px] font-medium text-app-fg bg-app-nav-hover-bg hover:bg-app-nav-active-bg transition-colors">
                {copied ? <Check size={14} /> : <Link2 size={14} />} {copied ? 'Copied' : 'Copy link'}
              </button>
              <button
                onClick={() => run(selected)}
                className="ml-auto flex items-center gap-1.5 px-4 py-2 rounded-full text-[13px] font-medium bg-app-fg text-app-canvas hover:opacity-90 transition-opacity"
              >
                <Sparkles size={14} /> Try Gem
              </button>
            </div>

            {/* Prompt */}
            <div className="rounded-2xl border border-app-divider bg-app-panel p-5">
              <div className="text-[13px] font-semibold text-app-fg mb-2">Prompt</div>
              <pre className="text-[12.5px] text-app-fg-muted whitespace-pre-wrap font-sans leading-relaxed max-h-[280px] overflow-y-auto">{selected.prompt}</pre>
            </div>
          </div>
        )}

        {/* Create */}
        {view === 'create' && (
          <div className="px-6 py-6">
            <label className="block text-[13px] text-app-fg-subtle mb-1.5">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Coach me Matt" autoFocus
              className="w-full mb-4 px-3.5 py-2.5 rounded-xl bg-app-panel border border-app-divider focus:border-app-fg-subtle outline-none text-[14px] text-app-fg placeholder:text-app-fg-subtle" />
            <label className="block text-[13px] text-app-fg-subtle mb-1.5">Description</label>
            <input value={desc} onChange={(e) => setDesc(e.target.value)} placeholder="What does this Gem do?"
              className="w-full mb-4 px-3.5 py-2.5 rounded-xl bg-app-panel border border-app-divider focus:border-app-fg-subtle outline-none text-[14px] text-app-fg placeholder:text-app-fg-subtle" />
            <label className="block text-[13px] text-app-fg-subtle mb-1.5">Prompt</label>
            <textarea value={prompt} onChange={(e) => setPrompt(e.target.value)} rows={8} placeholder="The instructions sent to the AI, run against your meeting notes…"
              className="w-full mb-5 px-3.5 py-2.5 rounded-xl bg-app-panel border border-app-divider focus:border-app-fg-subtle outline-none text-[13.5px] text-app-fg placeholder:text-app-fg-subtle resize-none leading-relaxed" />
            <div className="flex items-center justify-end gap-2">
              <button onClick={() => setView('list')} className="px-4 py-2 rounded-full text-[13px] font-medium text-app-fg hover:bg-app-nav-hover-bg transition-colors">Cancel</button>
              <button onClick={submitCreate} disabled={!canCreate} className="px-4 py-2 rounded-full text-[13px] font-medium bg-app-fg text-app-canvas disabled:opacity-40 hover:opacity-90 transition-opacity">Create Gem</button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
