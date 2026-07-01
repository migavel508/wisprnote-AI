import { useEffect, useMemo, useState } from 'react';
import { Plus, X, Search, ArrowUpDown, RefreshCw, Trash2, Info, ArrowRight, Loader2 } from 'lucide-react';
import {
  DictionaryEntry, getDictionary, createDictionaryEntry, deleteDictionaryEntry, invalidateDictionaryCache, loadDictionary,
} from '../services/dictionaryService';
import { onVaultEvent } from '../lib/vaultEvents';

type Tab = 'all' | 'personal' | 'shared';

function Toggle({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative w-11 h-6 rounded-full transition-colors flex-shrink-0 ${on ? 'bg-app-fg' : 'bg-app-chip'}`}
      aria-pressed={on}
    >
      <span className={`absolute top-0.5 left-0.5 w-5 h-5 rounded-full bg-white shadow transition-transform ${on ? 'translate-x-5' : ''}`} />
    </button>
  );
}

export default function DictionaryPage() {
  const [entries, setEntries] = useState<DictionaryEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [tab, setTab] = useState<Tab>('all');
  const [search, setSearch] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [showAdd, setShowAdd] = useState(false);
  const [bannerOpen, setBannerOpen] = useState(true);

  const load = () => {
    getDictionary()
      .then((rows) => { setEntries(rows); invalidateDictionaryCache(); void loadDictionary(true); })
      .catch(() => {})
      .finally(() => setLoading(false));
  };
  useEffect(load, []);
  useEffect(() => onVaultEvent('dictionary:changed', load), []);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return entries.filter((e) => {
      if (tab === 'personal' && e.shared) return false;
      if (tab === 'shared' && !e.shared) return false;
      if (!q) return true;
      return (e.term || '').toLowerCase().includes(q) || (e.misspelling || '').toLowerCase().includes(q);
    });
  }, [entries, tab, search]);

  const remove = async (id: string) => {
    setEntries((prev) => prev.filter((e) => e.id !== id));
    await deleteDictionaryEntry(id).catch(() => load());
  };

  const TABS: Array<{ id: Tab; label: string }> = [
    { id: 'all', label: 'All' },
    { id: 'personal', label: 'Personal' },
    { id: 'shared', label: 'Shared with team' },
  ];

  return (
    <div className="h-full flex flex-col bg-app-panel text-app-fg font-sans overflow-y-auto">
      <div className="max-w-[1080px] w-full mx-auto px-10 pt-8 pb-20">
        {/* Header */}
        <div className="flex items-start justify-between gap-6">
          <h1 className="text-[30px] font-serif tracking-[-0.02em] leading-tight">Dictionary</h1>
          <button
            onClick={() => setShowAdd(true)}
            className="flex-shrink-0 px-4 py-2.5 rounded-full text-[13.5px] font-medium bg-app-fg text-app-canvas hover:opacity-90 transition-opacity"
          >
            Add new
          </button>
        </div>

        {/* Tabs + tools */}
        <div className="mt-6 flex items-center border-b border-app-divider">
          <div className="flex items-center gap-6">
            {TABS.map((t) => (
              <button
                key={t.id}
                onClick={() => setTab(t.id)}
                className={`relative pb-2.5 text-[14px] transition-colors ${tab === t.id ? 'text-app-fg font-medium' : 'text-app-fg-subtle hover:text-app-fg'}`}
              >
                {t.label}
                {tab === t.id && <span className="absolute left-0 right-0 -bottom-px h-0.5 bg-app-fg rounded-full" />}
              </button>
            ))}
          </div>
          <div className="ml-auto flex items-center gap-1 pb-1.5">
            {showSearch ? (
              <input
                autoFocus
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                onBlur={() => { if (!search) setShowSearch(false); }}
                placeholder="Search"
                className="w-40 text-[13px] bg-app-chip/60 rounded-lg px-2.5 py-1 outline-none text-app-fg placeholder:text-app-fg-subtle"
              />
            ) : (
              <button onClick={() => setShowSearch(true)} className="w-8 h-8 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg" title="Search"><Search size={15} /></button>
            )}
            <button className="w-8 h-8 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg" title="Sort"><ArrowUpDown size={15} /></button>
            <button onClick={load} className="w-8 h-8 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg" title="Refresh"><RefreshCw size={15} /></button>
          </div>
        </div>

        {/* Promo banner */}
        {bannerOpen && (
          <div className="mt-6 relative rounded-2xl overflow-hidden bg-gradient-to-br from-[#7a5c3a] to-[#3a2c1c] text-white px-7 py-6">
            <button onClick={() => setBannerOpen(false)} className="absolute top-3 right-3 w-7 h-7 flex items-center justify-center rounded-full text-white/80 hover:bg-white/15"><X size={15} /></button>
            <h2 className="text-[26px] font-serif tracking-tight">Flow spells the way <span className="italic">you</span> do.</h2>
            <p className="text-[13.5px] text-white/85 mt-2 max-w-[760px] leading-relaxed">
              We learn your unique words and names — add <span className="font-semibold text-white">personal terms, company jargon, client names, or industry-specific lingo</span>, and every recording spells them right. Share them with your team so everyone stays on the same page.
            </p>
            <div className="mt-4">
              <button onClick={() => setShowAdd(true)} className="px-4 py-2 rounded-lg text-[13px] font-medium bg-white/90 text-[#3a2c1c] hover:bg-white transition-colors">Add new word</button>
            </div>
          </div>
        )}

        {/* List */}
        <div className="mt-7 rounded-xl border border-app-divider divide-y divide-app-divider overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16"><Loader2 className="animate-spin text-app-fg-subtle" size={18} /></div>
          ) : filtered.length === 0 ? (
            <div className="text-center py-16 text-[13px] text-app-fg-subtle">
              {search ? 'No matching words.' : 'No words yet — add names, jargon, or corrections to improve your transcriptions.'}
            </div>
          ) : (
            filtered.map((e) => (
              <div key={e.id} className="group flex items-center gap-3 px-5 py-4 hover:bg-app-nav-hover-bg/40 transition-colors">
                <div className="min-w-0 flex-1 flex items-center gap-2 text-[15px] text-app-fg">
                  {e.misspelling ? (
                    <><span className="truncate">{e.misspelling}</span><ArrowRight size={14} className="text-app-fg-subtle flex-shrink-0" /><span className="truncate font-medium">{e.term}</span></>
                  ) : (
                    <span className="truncate">{e.term}</span>
                  )}
                  {e.shared && <span className="text-[10px] px-1.5 py-0.5 rounded-full bg-app-chip text-app-fg-subtle flex-shrink-0">Shared</span>}
                </div>
                <button onClick={() => remove(e.id)} title="Delete" className="opacity-0 group-hover:opacity-100 w-8 h-8 flex items-center justify-center rounded-lg text-app-fg-subtle hover:bg-red-500/10 hover:text-red-500 transition-all"><Trash2 size={15} /></button>
              </div>
            ))
          )}
        </div>
      </div>

      {showAdd && <AddWordModal onClose={() => setShowAdd(false)} onAdded={(entry) => { setEntries((p) => [entry, ...p]); setShowAdd(false); }} />}
    </div>
  );
}

function AddWordModal({ onClose, onAdded }: { onClose: () => void; onAdded: (e: DictionaryEntry) => void }) {
  const [isCorrection, setIsCorrection] = useState(false);
  const [shared, setShared] = useState(false);
  const [word, setWord] = useState('');           // the term (or correct spelling)
  const [misspelling, setMisspelling] = useState('');
  const [saving, setSaving] = useState(false);

  const canSave = isCorrection ? (misspelling.trim() && word.trim()) : word.trim();

  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    try {
      const entry = await createDictionaryEntry(word.trim(), {
        misspelling: isCorrection ? misspelling.trim() : null,
        shared,
      });
      onAdded(entry);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-app-canvas rounded-2xl border border-app-divider shadow-xl w-[560px] max-w-[92vw] p-6" onClick={(e) => e.stopPropagation()}>
        <h3 className="text-[18px] font-semibold text-app-fg mb-4">Add to vocabulary</h3>

        <div className="flex items-center justify-between py-2">
          <span className="flex items-center gap-1.5 text-[14px] text-app-fg">Correct a misspelling <Info size={13} className="text-app-fg-subtle" /></span>
          <Toggle on={isCorrection} onClick={() => setIsCorrection((v) => !v)} />
        </div>
        <div className="flex items-center justify-between py-2">
          <span className="flex items-center gap-1.5 text-[14px] text-app-fg">Share with team <Info size={13} className="text-app-fg-subtle" /></span>
          <Toggle on={shared} onClick={() => setShared((v) => !v)} />
        </div>

        {isCorrection ? (
          <div className="mt-3 flex items-center gap-2">
            <input autoFocus value={misspelling} onChange={(e) => setMisspelling(e.target.value)} placeholder="Misspelling"
              className="flex-1 text-[14px] bg-app-panel border border-app-border rounded-xl px-3.5 py-2.5 outline-none text-app-fg placeholder:text-app-fg-subtle focus:border-app-fg-subtle" />
            <ArrowRight size={16} className="text-app-fg-subtle flex-shrink-0" />
            <input value={word} onChange={(e) => setWord(e.target.value)} placeholder="Correct spelling"
              onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
              className="flex-1 text-[14px] bg-app-panel border border-app-border rounded-xl px-3.5 py-2.5 outline-none text-app-fg placeholder:text-app-fg-subtle focus:border-app-fg-subtle" />
          </div>
        ) : (
          <input autoFocus value={word} onChange={(e) => setWord(e.target.value)} placeholder="Add a new word"
            onKeyDown={(e) => { if (e.key === 'Enter') save(); }}
            className="mt-3 w-full text-[14px] bg-app-panel border border-app-border rounded-xl px-3.5 py-2.5 outline-none text-app-fg placeholder:text-app-fg-subtle focus:border-app-fg-subtle" />
        )}

        <div className="flex justify-end gap-2 mt-5">
          <button onClick={onClose} className="px-4 py-2 rounded-full text-[13.5px] font-medium bg-app-chip text-app-fg hover:opacity-90">Cancel</button>
          <button onClick={save} disabled={!canSave || saving} className="px-4 py-2 rounded-full text-[13.5px] font-medium bg-app-fg text-app-canvas hover:opacity-90 disabled:opacity-40 flex items-center gap-1.5">
            {saving && <Loader2 size={13} className="animate-spin" />} Add word
          </button>
        </div>
      </div>
    </div>
  );
}
