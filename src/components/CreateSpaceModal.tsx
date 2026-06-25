import { useEffect, useRef, useState } from 'react';
import { X, Loader2 } from 'lucide-react';
import type { Space } from '../services/workspaceService';
import { createSpace } from '../services/workspaceService';
import { ICON_COLORS, ICON_LIBRARY } from './CreateFolderModal';
import { EMOJI_GROUPS } from '../data/emojiData';

interface Props {
  onClose: () => void;
  onCreated: (space: Space) => void;
}

// "Create a space" modal — name + icon/emoji picker + members, matching the
// Spaces settings page. Workspaces store emoji + color; an icon selection keeps
// its colour (the avatar falls back to the name initial, as elsewhere).
export default function CreateSpaceModal({ onClose, onCreated }: Props) {
  const [title, setTitle] = useState('');
  const [iconType, setIconType] = useState<'icon' | 'emoji'>('icon');
  const [iconName, setIconName] = useState('star');
  const [iconColor, setIconColor] = useState(ICON_COLORS[0].value);
  const [emoji, setEmoji] = useState('😀');
  const [iconChosen, setIconChosen] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState('');
  const [members, setMembers] = useState<string[]>([]);
  const [memberInput, setMemberInput] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (pickerOpen && pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pickerOpen]);

  const initial = (title.trim().charAt(0) || 'S').toUpperCase();
  const canCreate = title.trim().length > 0 && !saving;
  const PreviewIcon = ICON_LIBRARY.find(i => i.name === iconName)?.Icon ?? ICON_LIBRARY[0].Icon;
  const emojiQuery = emojiSearch.trim().toLowerCase();
  const emojiGroups = emojiQuery
    ? (() => {
        const hits = EMOJI_GROUPS.flatMap(g => g.emojis).filter(e => e.n.includes(emojiQuery));
        return hits.length ? [{ name: 'Results', emojis: hits }] : [];
      })()
    : EMOJI_GROUPS;

  const addMember = (raw: string) => {
    const v = raw.trim().replace(/,+$/, '').trim();
    if (v && !members.includes(v)) setMembers(m => [...m, v]);
    setMemberInput('');
  };

  const handleCreate = async () => {
    if (!canCreate) return;
    setSaving(true);
    try {
      // Create a SPACE (inside the active workspace), with its members. A space with
      // members is shared; with none it's private ("Just you").
      const space = await createSpace(title.trim(), {
        emoji: iconChosen && iconType === 'emoji' ? emoji : undefined,
        color: iconColor,
        members,
      });
      onCreated(space);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm font-sans"
      onClick={onClose}
    >
      <div
        className="bg-app-canvas rounded-2xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.3)] w-full max-w-[520px] mx-4 border border-app-divider overflow-visible"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-4">
          <h3 className="text-[18px] font-semibold text-app-fg tracking-[-0.01em]">Create a space</h3>
          <button onClick={onClose} className="p-1 rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors">
            <X size={18} strokeWidth={1.7} />
          </button>
        </div>

        {/* Title and icon */}
        <div className="px-6">
          <label className="block text-[13px] text-app-fg-subtle mb-2">Title and icon</label>
          <div className="relative flex items-center gap-2.5 px-2.5 py-2 rounded-xl bg-app-panel border border-app-divider focus-within:border-[#819C1F] focus-within:ring-2 focus-within:ring-[#819C1F]/25 transition-colors">
            <button
              type="button"
              onClick={() => setPickerOpen(v => !v)}
              className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 hover:opacity-80 transition-opacity"
              style={{ background: iconChosen && iconType === 'icon' ? `${iconColor}22` : 'var(--color-app-nav-hover-bg)' }}
            >
              {iconChosen ? (
                iconType === 'emoji'
                  ? <span style={{ fontSize: 19, lineHeight: 1 }}>{emoji}</span>
                  : <PreviewIcon size={18} strokeWidth={1.8} style={{ color: iconColor }} />
              ) : (
                <span className="text-[15px] font-medium text-app-fg-subtle">{initial}</span>
              )}
            </button>
            <input
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canCreate) handleCreate(); }}
              placeholder="Choose a helpful name"
              className="flex-1 bg-transparent outline-none text-[15px] text-app-fg placeholder:text-app-fg-subtle tracking-[-0.01em]"
            />

            {pickerOpen && (
              <div
                ref={pickerRef}
                className="absolute left-0 top-full mt-1.5 z-10 bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.2)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.6)] w-[380px] overflow-hidden"
              >
                <div className="flex items-center gap-5 px-4 pt-3 border-b border-app-divider">
                  {(['icon', 'emoji'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setIconType(t)}
                      className={`pb-2 text-[13px] font-medium border-b-2 -mb-px transition-colors ${
                        iconType === t ? 'border-app-fg text-app-fg' : 'border-transparent text-app-fg-subtle hover:text-app-fg'
                      }`}
                    >
                      {t === 'icon' ? 'Icons' : 'Emojis'}
                    </button>
                  ))}
                </div>

                {iconType === 'icon' ? (
                  <div className="p-3">
                    <div className="flex gap-1.5 mb-3 pb-3 border-b border-app-divider">
                      {ICON_COLORS.map(c => (
                        <button
                          key={c.id}
                          onClick={() => { setIconColor(c.value); setIconChosen(true); }}
                          className={`w-6 h-6 rounded-full transition-all ${iconColor === c.value ? 'ring-2 ring-offset-1 ring-app-fg' : ''}`}
                          style={{ background: c.value }}
                        />
                      ))}
                    </div>
                    <div className="grid grid-cols-10 gap-1 max-h-[220px] overflow-y-auto">
                      {ICON_LIBRARY.map(({ name, Icon }) => (
                        <button
                          key={name}
                          onClick={() => { setIconName(name); setIconChosen(true); }}
                          className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                            iconChosen && iconType === 'icon' && iconName === name ? 'bg-app-nav-active-bg' : 'hover:bg-app-nav-hover-bg'
                          }`}
                        >
                          <Icon size={17} strokeWidth={1.7} style={{ color: iconColor }} />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="p-3">
                    <input
                      value={emojiSearch}
                      onChange={e => setEmojiSearch(e.target.value)}
                      placeholder="Search emoji…"
                      className="w-full px-2.5 py-1.5 mb-2 text-[12px] bg-app-nav-hover-bg rounded-lg outline-none text-app-fg placeholder:text-app-fg-subtle"
                    />
                    <div className="max-h-[230px] overflow-y-auto pr-0.5">
                      {emojiGroups.map(g => (
                        <div key={g.name} className="mb-2">
                          <div className="text-[10px] font-mono uppercase tracking-wider text-app-fg-subtle px-1 mb-1 sticky top-0 bg-app-canvas py-0.5">{g.name}</div>
                          <div className="grid grid-cols-9 gap-1">
                            {g.emojis.map(em => (
                              <button
                                key={em.c}
                                title={em.n}
                                onClick={() => { setEmoji(em.c); setIconChosen(true); }}
                                className={`w-8 h-8 rounded-md flex items-center justify-center text-[18px] transition-colors ${
                                  iconChosen && iconType === 'emoji' && emoji === em.c ? 'bg-app-nav-active-bg' : 'hover:bg-app-nav-hover-bg'
                                }`}
                              >
                                {em.c}
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                      {emojiGroups.length === 0 && (
                        <div className="text-[12px] text-app-fg-subtle px-1 py-4 text-center">No emojis found</div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>

        {/* Members */}
        <div className="px-6 mt-5">
          <label className="block text-[13px] text-app-fg-subtle mb-2">Members</label>
          <div className="flex flex-wrap items-center gap-1.5 px-2.5 py-2 rounded-xl bg-app-nav-hover-bg/60 border border-transparent focus-within:border-app-divider min-h-[42px]">
            {members.map(m => (
              <span key={m} className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-app-canvas border border-app-divider text-[12.5px] text-app-fg">
                {m}
                <button onClick={() => setMembers(list => list.filter(x => x !== m))} className="text-app-fg-subtle hover:text-app-fg">
                  <X size={11} strokeWidth={2} />
                </button>
              </span>
            ))}
            <input
              value={memberInput}
              onChange={e => setMemberInput(e.target.value)}
              onKeyDown={e => {
                if ((e.key === 'Enter' || e.key === ',') && memberInput.trim()) { e.preventDefault(); addMember(memberInput); }
                if (e.key === 'Backspace' && !memberInput && members.length) setMembers(list => list.slice(0, -1));
              }}
              onBlur={() => { if (memberInput.trim()) addMember(memberInput); }}
              placeholder={members.length ? '' : 'Search people or enter emails'}
              className="flex-1 min-w-[140px] bg-transparent outline-none text-[14px] text-app-fg placeholder:text-app-fg-subtle py-0.5"
            />
          </div>
          <p className="text-[13px] text-app-fg-subtle mt-3">Everyone added to a space can see the notes and folders inside.</p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-2 px-6 py-5">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-full text-[14px] font-medium text-app-fg hover:bg-app-nav-hover-bg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className="px-4 py-2 rounded-full text-[14px] font-medium bg-app-fg text-app-canvas disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-1.5"
          >
            {saving ? <Loader2 size={13} className="animate-spin" /> : null}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
