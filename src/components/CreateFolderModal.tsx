import { useEffect, useRef, useState } from 'react';
import {
  X, Folder as FolderIcon, ChevronDown, Lock, Loader2,
  Star, Heart, Sparkles, Bookmark, Zap, Hash, FileText,
  Briefcase, ClipboardList, Archive, AlignLeft, Tag, Link as LinkIcon,
  MessageSquare, Mail, Phone, Mic, Video, Megaphone, Hand,
  User, Users, Smile, Frown, BriefcaseBusiness, Building2, Landmark,
  Presentation, BarChart3, TrendingUp, DollarSign, Clock, Calendar,
  Rocket, Code, Terminal, Cpu, Database, Server, ShieldCheck,
  Key, CheckCircle2, Paintbrush, PieChart, Pencil, Image as ImageIcon, Box,
  FlaskConical, Lightbulb, Target, Bell, Cog, Wrench, Globe, Globe2,
  Map, Package, Flame, Cloud, Sun, Flag, Gift, Music, Puzzle,
  Lock as LockIcon, Ticket, Trophy,
} from 'lucide-react';
import type { Workspace } from '../services/workspaceService';
import { isDefaultWorkspace } from '../services/workspaceService';
import { EMOJI_GROUPS } from '../data/emojiData';

export const ICON_COLORS = [
  { id: 'gray',   value: '#6b7280' },
  { id: 'black',  value: '#1f2937' },
  { id: 'purple', value: '#a78bfa' },
  { id: 'blue',   value: '#3b82f6' },
  { id: 'green',  value: '#65a30d' },
  { id: 'olive',  value: '#a3a14a' },
  { id: 'orange', value: '#f59e0b' },
  { id: 'red',    value: '#dc2626' },
];

export const ICON_LIBRARY: { name: string; Icon: typeof Star }[] = [
  { name: 'star', Icon: Star }, { name: 'heart', Icon: Heart }, { name: 'sparkles', Icon: Sparkles },
  { name: 'bookmark', Icon: Bookmark }, { name: 'zap', Icon: Zap }, { name: 'hash', Icon: Hash },
  { name: 'file', Icon: FileText }, { name: 'folder', Icon: FolderIcon }, { name: 'briefcase', Icon: Briefcase },
  { name: 'clipboard', Icon: ClipboardList }, { name: 'archive', Icon: Archive }, { name: 'align', Icon: AlignLeft },
  { name: 'tag', Icon: Tag }, { name: 'link', Icon: LinkIcon }, { name: 'message', Icon: MessageSquare },
  { name: 'mail', Icon: Mail }, { name: 'phone', Icon: Phone }, { name: 'mic', Icon: Mic },
  { name: 'video', Icon: Video }, { name: 'megaphone', Icon: Megaphone }, { name: 'hand', Icon: Hand },
  { name: 'user', Icon: User }, { name: 'users', Icon: Users }, { name: 'smile', Icon: Smile },
  { name: 'frown', Icon: Frown }, { name: 'biz', Icon: BriefcaseBusiness }, { name: 'building', Icon: Building2 },
  { name: 'landmark', Icon: Landmark }, { name: 'presentation', Icon: Presentation }, { name: 'bar-chart', Icon: BarChart3 },
  { name: 'trending', Icon: TrendingUp }, { name: 'dollar', Icon: DollarSign }, { name: 'clock', Icon: Clock },
  { name: 'calendar', Icon: Calendar }, { name: 'rocket', Icon: Rocket }, { name: 'code', Icon: Code },
  { name: 'terminal', Icon: Terminal }, { name: 'cpu', Icon: Cpu }, { name: 'database', Icon: Database },
  { name: 'server', Icon: Server }, { name: 'shield', Icon: ShieldCheck }, { name: 'key', Icon: Key },
  { name: 'check', Icon: CheckCircle2 }, { name: 'paint', Icon: Paintbrush }, { name: 'pie', Icon: PieChart },
  { name: 'pencil', Icon: Pencil }, { name: 'image', Icon: ImageIcon }, { name: 'box', Icon: Box },
  { name: 'flask', Icon: FlaskConical }, { name: 'lightbulb', Icon: Lightbulb }, { name: 'target', Icon: Target },
  { name: 'bell', Icon: Bell }, { name: 'cog', Icon: Cog }, { name: 'wrench', Icon: Wrench },
  { name: 'globe', Icon: Globe }, { name: 'globe2', Icon: Globe2 }, { name: 'map', Icon: Map },
  { name: 'package', Icon: Package }, { name: 'flame', Icon: Flame }, { name: 'cloud', Icon: Cloud },
  { name: 'sun', Icon: Sun }, { name: 'flag', Icon: Flag }, { name: 'gift', Icon: Gift },
  { name: 'music', Icon: Music }, { name: 'puzzle', Icon: Puzzle }, { name: 'lock', Icon: LockIcon },
  { name: 'ticket', Icon: Ticket }, { name: 'trophy', Icon: Trophy },
];

export interface FolderDraft {
  title: string;
  description: string;
  iconType: 'icon' | 'emoji';
  iconName: string;      // when iconType === 'icon'
  iconColor: string;     // hex when iconType === 'icon'
  emoji: string;         // when iconType === 'emoji'
  workspaceId: string;   // selected destination
}

interface Props {
  workspaces: Workspace[];
  defaultWorkspaceId?: string;
  onClose: () => void;
  onCreate: (draft: FolderDraft) => Promise<void>;
}

function IconPreview({ draft, size = 24 }: { draft: FolderDraft; size?: number }) {
  if (draft.iconType === 'emoji') {
    return <span style={{ fontSize: size * 0.85, lineHeight: 1 }}>{draft.emoji}</span>;
  }
  const item = ICON_LIBRARY.find(i => i.name === draft.iconName) || ICON_LIBRARY[7];
  const Icon = item.Icon;
  return <Icon size={size * 0.7} strokeWidth={1.7} style={{ color: draft.iconColor }} />;
}

export default function CreateFolderModal({ workspaces, defaultWorkspaceId, onClose, onCreate }: Props) {
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [iconType, setIconType] = useState<'icon' | 'emoji'>('icon');
  const [iconName, setIconName] = useState('folder');
  const [iconColor, setIconColor] = useState(ICON_COLORS[6].value);
  const [emoji, setEmoji] = useState('📁');
  const [workspaceId, setWorkspaceId] = useState(defaultWorkspaceId || workspaces[0]?.id || '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [destOpen, setDestOpen] = useState(false);
  const [emojiSearch, setEmojiSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const pickerRef = useRef<HTMLDivElement>(null);
  const destRef = useRef<HTMLDivElement>(null);

  useEffect(() => { titleRef.current?.focus(); }, []);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (pickerOpen && pickerRef.current && !pickerRef.current.contains(e.target as Node)) setPickerOpen(false);
      if (destOpen && destRef.current && !destRef.current.contains(e.target as Node)) setDestOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, [pickerOpen, destOpen]);

  const draft: FolderDraft = {
    title, description, iconType, iconName, iconColor, emoji, workspaceId,
  };

  const selectedWs = workspaces.find(w => w.id === workspaceId);
  const isPrivateDest = isDefaultWorkspace(selectedWs);

  const canCreate = title.trim().length > 0 && workspaceId && !saving;

  const handleCreate = async () => {
    if (!canCreate) return;
    setSaving(true);
    try { await onCreate(draft); } finally { setSaving(false); }
  };

  const emojiQuery = emojiSearch.trim().toLowerCase();
  const emojiGroups = emojiQuery
    ? (() => {
        const hits = EMOJI_GROUPS.flatMap(g => g.emojis).filter(e => e.n.includes(emojiQuery));
        return hits.length ? [{ name: 'Results', emojis: hits }] : [];
      })()
    : EMOJI_GROUPS;

  return (
    <div
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm font-sans"
      onClick={onClose}
    >
      <div
        className="bg-app-canvas rounded-2xl shadow-[0_24px_64px_-16px_rgba(0,0,0,0.3)] w-full max-w-[480px] mx-4 border border-app-divider overflow-visible"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 pt-5 pb-4">
          <div className="flex items-center gap-2">
            <div
              className="w-7 h-7 rounded-lg flex items-center justify-center flex-shrink-0"
              style={{ background: iconType === 'icon' ? `${iconColor}22` : 'transparent' }}
            >
              <IconPreview draft={draft} size={18} />
            </div>
            <h3 className="text-[15px] font-semibold text-app-fg tracking-[-0.01em]">Create private folder</h3>
          </div>
          <button onClick={onClose} className="p-1 rounded-md text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg transition-colors">
            <X size={16} strokeWidth={1.7} />
          </button>
        </div>

        {/* Title & icon */}
        <div className="px-5">
          <label className="block text-[12px] font-medium text-app-fg mb-1.5">Title and icon</label>
          <div className="relative flex items-center gap-2 px-2.5 py-2 rounded-xl bg-app-canvas border border-app-divider focus-within:border-app-fg-subtle transition-colors">
            <button
              onClick={() => setPickerOpen(v => !v)}
              className="w-9 h-9 rounded-lg flex items-center justify-center flex-shrink-0 hover:opacity-80 transition-opacity"
              style={{ background: iconType === 'icon' ? `${iconColor}22` : 'transparent' }}
            >
              <IconPreview draft={draft} size={22} />
            </button>
            <input
              ref={titleRef}
              value={title}
              onChange={e => setTitle(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && canCreate) handleCreate(); }}
              placeholder="Title"
              className="flex-1 bg-transparent outline-none text-[14px] text-app-fg placeholder:text-app-fg-subtle tracking-[-0.01em]"
            />

            {pickerOpen && (
              <div
                ref={pickerRef}
                className="absolute left-0 top-full mt-1 z-10 bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.2)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.6)] w-[360px] overflow-hidden"
              >
                {/* Tabs */}
                <div className="flex items-center gap-4 px-4 pt-3 border-b border-app-divider">
                  {(['icon', 'emoji'] as const).map(t => (
                    <button
                      key={t}
                      onClick={() => setIconType(t)}
                      className={`pb-2 text-[12.5px] font-medium border-b-2 -mb-px transition-colors ${
                        iconType === t ? 'border-app-fg text-app-fg' : 'border-transparent text-app-fg-subtle hover:text-app-fg'
                      }`}
                    >
                      {t === 'icon' ? 'Icons' : 'Emojis'}
                    </button>
                  ))}
                </div>

                {iconType === 'icon' ? (
                  <div className="p-3">
                    {/* Colors */}
                    <div className="flex gap-1.5 mb-3">
                      {ICON_COLORS.map(c => (
                        <button
                          key={c.id}
                          onClick={() => setIconColor(c.value)}
                          className={`w-6 h-6 rounded-full transition-all ${iconColor === c.value ? 'ring-2 ring-offset-1 ring-app-fg' : ''}`}
                          style={{ background: c.value }}
                        />
                      ))}
                    </div>
                    {/* Icon grid */}
                    <div className="grid grid-cols-9 gap-1 max-h-[220px] overflow-y-auto">
                      {ICON_LIBRARY.map(({ name, Icon }) => (
                        <button
                          key={name}
                          onClick={() => setIconName(name)}
                          className={`w-8 h-8 rounded-md flex items-center justify-center transition-colors ${
                            iconName === name ? 'bg-app-nav-active-bg' : 'hover:bg-app-nav-hover-bg'
                          }`}
                        >
                          <Icon size={16} strokeWidth={1.7} style={{ color: iconColor }} />
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
                                onClick={() => setEmoji(em.c)}
                                className={`w-8 h-8 rounded-md flex items-center justify-center text-[18px] transition-colors ${
                                  emoji === em.c ? 'bg-app-nav-active-bg' : 'hover:bg-app-nav-hover-bg'
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

        {/* Description */}
        <div className="px-5 mt-4">
          <label className="block text-[12px] font-medium text-app-fg mb-1.5">Description</label>
          <textarea
            value={description}
            onChange={e => setDescription(e.target.value)}
            placeholder="Describe the purpose of this folder"
            rows={3}
            className="w-full px-3 py-2 text-[13px] bg-app-canvas border border-app-divider focus:border-app-fg-subtle rounded-xl outline-none text-app-fg placeholder:text-app-fg-subtle resize-none tracking-[-0.01em] transition-colors"
          />
        </div>

        {/* Destination picker */}
        <div className="px-5 mt-4 pb-5" ref={destRef}>
          <div className="relative">
            <button
              onClick={() => setDestOpen(v => !v)}
              className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl hover:bg-app-nav-hover-bg transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0">
                {isPrivateDest ? <Lock size={14} strokeWidth={1.8} className="text-app-fg-muted" /> : (
                  <span className="text-[15px] leading-none">{selectedWs?.emoji ?? '📁'}</span>
                )}
              </div>
              <div className="flex-1 min-w-0 text-left">
                <div className="text-[13px] font-semibold text-app-fg leading-tight">{selectedWs?.name ?? '—'}</div>
                <div className="text-[11px] text-app-fg-subtle leading-tight mt-0.5">
                  {isPrivateDest ? (
                    <><span className="font-medium text-app-fg">Private</span> Only people added to the folder can view.</>
                  ) : (
                    <>Workspace — visible to all members.</>
                  )}
                </div>
              </div>
              <ChevronDown size={14} strokeWidth={1.7} className="text-app-fg-subtle flex-shrink-0" />
            </button>

            {destOpen && (
              <div className="absolute left-0 right-0 bottom-full mb-1 z-10 bg-app-canvas rounded-xl border border-app-divider shadow-[0_18px_48px_-12px_rgba(0,0,0,0.2)] dark:shadow-[0_18px_48px_-12px_rgba(0,0,0,0.55)] overflow-hidden py-1">
                {workspaces.map(ws => (
                  <button
                    key={ws.id}
                    onClick={() => { setWorkspaceId(ws.id); setDestOpen(false); }}
                    className="w-full flex items-center gap-2 px-3 py-2 hover:bg-app-nav-hover-bg transition-colors text-left"
                  >
                    {isDefaultWorkspace(ws)
                      ? <Lock size={13} strokeWidth={1.8} className="text-app-fg-muted flex-shrink-0" />
                      : <span className="text-[14px] leading-none flex-shrink-0">{ws.emoji}</span>}
                    <span className="text-[12.5px] text-app-fg flex-1 truncate">
                      {isDefaultWorkspace(ws) ? 'My notes' : `Move to ${ws.name}`}
                    </span>
                  </button>
                ))}
              </div>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-5 py-3 border-t border-app-divider bg-app-nav-hover-bg/40">
          <button
            onClick={onClose}
            className="px-3 py-1.5 rounded-lg text-[12.5px] font-medium text-app-fg hover:bg-app-nav-hover-bg transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={handleCreate}
            disabled={!canCreate}
            className="px-4 py-1.5 rounded-lg text-[12.5px] font-semibold bg-app-fg text-app-canvas disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-1.5"
          >
            {saving ? <Loader2 size={12} className="animate-spin" /> : null}
            Create
          </button>
        </div>
      </div>
    </div>
  );
}
