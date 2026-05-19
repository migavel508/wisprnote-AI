import { useState, useEffect, useRef } from 'react';
import {
  Plus, Folder, ChevronRight, MoreHorizontal, Trash2, Pencil,
  X, Loader2, FileText, Mic,
  Search,
} from 'lucide-react';
import {
  Workspace, Folder as FolderType, WorkspaceMeeting,
  getWorkspaces, createWorkspace, updateWorkspace, deleteWorkspace,
  getFolders, createFolder, deleteFolder,
  getWorkspaceMeetings, getFolderMeetings,
  addMeetingToWorkspace, removeMeetingFromWorkspace,
} from '../services/workspaceService';
import type { TaskHistory } from '../services/awsService';

const PALETTE = [
  '#f06060', '#f59e0b', '#10b981', '#3b82f6',
  '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16',
];
const EMOJIS = ['🗂️', '💼', '🚀', '🎯', '📊', '🔬', '🏗️', '🌱', '⚡', '🎨'];

// ── Date helpers ──────────────────────────────────────────────────────────────

function groupByDate(meetings: WorkspaceMeeting[]) {
  const groups: { label: string; items: WorkspaceMeeting[] }[] = [];
  const map = new Map<string, WorkspaceMeeting[]>();

  for (const m of meetings) {
    const d = new Date(m.created_at);
    const today = new Date();
    const yesterday = new Date(today);
    yesterday.setDate(today.getDate() - 1);

    let label: string;
    if (d.toDateString() === today.toDateString()) {
      label = 'Today';
    } else if (d.toDateString() === yesterday.toDateString()) {
      label = 'Yesterday';
    } else {
      label = d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
    }

    if (!map.has(label)) map.set(label, []);
    map.get(label)!.push(m);
  }

  map.forEach((items, label) => groups.push({ label, items }));
  return groups;
}

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true });
}

function formatDuration(sec: number) {
  if (!sec) return '';
  const m = Math.floor(sec / 60);
  const h = Math.floor(m / 60);
  return h > 0 ? `${h}h ${m % 60}m` : `${m}m`;
}

// ── Create workspace modal ────────────────────────────────────────────────────

function CreateWorkspaceModal({ onClose, onCreated }: { onClose: () => void; onCreated: (ws: Workspace) => void }) {
  const [name, setName] = useState('');
  const [emoji, setEmoji] = useState('🗂️');
  const [color, setColor] = useState('#f06060');
  const [saving, setSaving] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => { inputRef.current?.focus(); }, []);

  const handleCreate = async () => {
    if (!name.trim()) return;
    setSaving(true);
    try {
      const ws = await createWorkspace(name.trim(), emoji, color);
      onCreated(ws);
    } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-app-panel rounded-2xl shadow-2xl w-full max-w-sm mx-4 p-6 border border-app-border" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-[15px] font-semibold text-app-fg">New Space</h3>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-app-nav-hover-bg text-app-fg-subtle"><X size={15} /></button>
        </div>

        <div className="flex items-center gap-2 mb-4">
          <div className="text-2xl w-10 h-10 flex items-center justify-center rounded-xl bg-app-status-bg border border-app-border">{emoji}</div>
          <input
            ref={inputRef}
            value={name}
            onChange={e => setName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleCreate(); if (e.key === 'Escape') onClose(); }}
            placeholder="Space name…"
            className="flex-1 px-3 py-2 text-[13px] bg-app-status-bg border border-app-border rounded-xl outline-none focus:ring-2 focus:ring-[#f06060]/30 text-app-fg placeholder:text-app-fg-subtle"
          />
        </div>

        <div className="flex gap-1.5 flex-wrap mb-4">
          {EMOJIS.map(e => (
            <button key={e} onClick={() => setEmoji(e)}
              className={`w-8 h-8 rounded-lg text-lg flex items-center justify-center transition-all ${emoji === e ? 'bg-app-nav-active-bg shadow-sm scale-110' : 'hover:bg-app-nav-hover-bg'}`}>
              {e}
            </button>
          ))}
        </div>

        <div className="flex gap-2 mb-6">
          {PALETTE.map(c => (
            <button key={c} onClick={() => setColor(c)}
              className={`w-5 h-5 rounded-full transition-all ${color === c ? 'ring-2 ring-offset-1 ring-app-fg scale-110' : ''}`}
              style={{ background: c }} />
          ))}
        </div>

        <button
          onClick={handleCreate}
          disabled={!name.trim() || saving}
          className="w-full py-2.5 rounded-xl bg-app-fg text-app-canvas text-[13px] font-semibold disabled:opacity-40 hover:opacity-80 transition-all"
        >
          {saving ? <Loader2 size={14} className="animate-spin mx-auto" /> : 'Create Space'}
        </button>
      </div>
    </div>
  );
}

// ── Meeting row ───────────────────────────────────────────────────────────────

function MeetingRow({ meeting, onSelect, onRemove }: {
  meeting: WorkspaceMeeting;
  onSelect: () => void;
  onRemove: () => void;
}) {
  return (
    <div
      onClick={onSelect}
      className="group flex items-center gap-3 px-4 py-3 hover:bg-app-nav-hover-bg rounded-xl cursor-pointer transition-all"
    >
      <div className="w-8 h-8 rounded-lg bg-app-status-bg border border-app-border flex items-center justify-center flex-shrink-0">
        <FileText size={13} className="text-app-fg-subtle" />
      </div>
      <div className="flex-1 min-w-0">
        <p className="text-[13px] font-medium text-app-fg truncate leading-snug">{meeting.filename}</p>
        <p className="text-[11px] text-app-fg-subtle mt-0.5">Me</p>
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {meeting.duration > 0 && (
          <span className="text-[11px] text-app-fg-subtle">{formatDuration(meeting.duration)}</span>
        )}
        <span className="text-[11px] text-app-fg-subtle">{formatTime(meeting.created_at)}</span>
        <button
          onClick={e => { e.stopPropagation(); onRemove(); }}
          className="opacity-0 group-hover:opacity-100 p-1 rounded-lg hover:bg-red-50 dark:hover:bg-red-950/30 hover:text-red-500 text-app-fg-subtle transition-all"
        >
          <X size={12} />
        </button>
      </div>
    </div>
  );
}

// ── Main WorkspacePage ────────────────────────────────────────────────────────

interface WorkspacePageProps {
  allTasks: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
}

export default function WorkspacePage({ allTasks, onSelectTask }: WorkspacePageProps) {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWs, setSelectedWs] = useState<Workspace | null>(null);
  const [folders, setFolders] = useState<FolderType[]>([]);
  const [meetings, setMeetings] = useState<WorkspaceMeeting[]>([]);
  const [selectedFolder, setSelectedFolder] = useState<FolderType | null>(null);
  const [activeTab, setActiveTab] = useState<'notes' | 'files'>('notes');
  const [loading, setLoading] = useState(true);
  const [loadingContent, setLoadingContent] = useState(false);
  const [showCreate, setShowCreate] = useState(false);
  const [wsMenuOpen, setWsMenuOpen] = useState(false);
  const [editingName, setEditingName] = useState(false);
  const [nameInput, setNameInput] = useState('');
  const [newFolderName, setNewFolderName] = useState('');
  const [addingFolder, setAddingFolder] = useState(false);
  const [addMeetingOpen, setAddMeetingOpen] = useState(false);
  const [addSearch, setAddSearch] = useState('');
  const [addingTaskId, setAddingTaskId] = useState<string | null>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const wsMenuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    getWorkspaces().then(ws => {
      setWorkspaces(ws);
      if (ws.length > 0) setSelectedWs(ws[0]);
    }).finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    if (!selectedWs) { setFolders([]); setMeetings([]); setSelectedFolder(null); return; }
    setLoadingContent(true);
    setSelectedFolder(null);
    Promise.all([getFolders(selectedWs.id), getWorkspaceMeetings(selectedWs.id)])
      .then(([f, m]) => { setFolders(f); setMeetings(m); })
      .finally(() => setLoadingContent(false));
  }, [selectedWs]);

  useEffect(() => {
    if (!selectedFolder) return;
    setLoadingContent(true);
    getFolderMeetings(selectedFolder.id).then(setMeetings).finally(() => setLoadingContent(false));
  }, [selectedFolder]);

  useEffect(() => {
    if (editingName) nameRef.current?.focus();
  }, [editingName]);

  const handleRename = async () => {
    if (!selectedWs || !nameInput.trim()) { setEditingName(false); return; }
    const updated = await updateWorkspace(selectedWs.id, { name: nameInput.trim() }).catch(() => null);
    if (updated) {
      setWorkspaces(prev => prev.map(w => w.id === updated.id ? updated : w));
      setSelectedWs(updated);
    }
    setEditingName(false);
  };

  const handleDelete = async () => {
    if (!selectedWs) return;
    await deleteWorkspace(selectedWs.id).catch(() => {});
    const remaining = workspaces.filter(w => w.id !== selectedWs.id);
    setWorkspaces(remaining);
    setSelectedWs(remaining[0] || null);
    setWsMenuOpen(false);
  };

  const handleCreateFolder = async () => {
    if (!selectedWs || !newFolderName.trim()) return;
    setAddingFolder(true);
    const f = await createFolder(selectedWs.id, newFolderName.trim()).catch(() => null);
    if (f) setFolders(prev => [...prev, f]);
    setNewFolderName('');
    setAddingFolder(false);
  };

  const handleDeleteFolder = async (f: FolderType) => {
    await deleteFolder(f.id).catch(() => {});
    setFolders(prev => prev.filter(x => x.id !== f.id));
    if (selectedFolder?.id === f.id) setSelectedFolder(null);
  };

  const handleAddMeeting = async (taskId: string) => {
    if (!selectedWs) return;
    setAddingTaskId(taskId);
    await addMeetingToWorkspace(selectedWs.id, taskId).catch(() => {});
    const updated = await getWorkspaceMeetings(selectedWs.id).catch(() => meetings);
    setMeetings(updated);
    setAddingTaskId(null);
  };

  const handleRemoveMeeting = async (taskId: string) => {
    if (!selectedWs) return;
    await removeMeetingFromWorkspace(selectedWs.id, taskId).catch(() => {});
    setMeetings(prev => prev.filter(m => m.id !== taskId));
  };

  const meetingIds = new Set(meetings.map(m => m.id));
  const filteredTasks = allTasks.filter(t =>
    !meetingIds.has(t.id!) &&
    (addSearch === '' || t.filename.toLowerCase().includes(addSearch.toLowerCase()))
  );

  const dateGroups = groupByDate(meetings);

  if (loading) {
    return (
      <div className="h-full flex items-center justify-center">
        <Loader2 className="animate-spin text-app-fg-subtle" size={20} />
      </div>
    );
  }

  if (!selectedWs && workspaces.length === 0) {
    return (
      <div className="h-full flex flex-col items-center justify-center gap-4 px-8 text-center">
        <div className="w-16 h-16 rounded-2xl bg-app-status-bg border border-app-border flex items-center justify-center text-3xl">🗂️</div>
        <div>
          <p className="text-[15px] font-semibold text-app-fg mb-1">No spaces yet</p>
          <p className="text-[13px] text-app-fg-subtle max-w-xs">Spaces help you organise meetings by team, project, or topic.</p>
        </div>
        <button
          onClick={() => setShowCreate(true)}
          className="px-5 py-2.5 rounded-xl bg-app-fg text-app-canvas text-[13px] font-semibold hover:opacity-80 transition-all flex items-center gap-2"
        >
          <Plus size={14} /> Create your first space
        </button>
        {showCreate && (
          <CreateWorkspaceModal
            onClose={() => setShowCreate(false)}
            onCreated={ws => { setWorkspaces([ws]); setSelectedWs(ws); setShowCreate(false); }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col overflow-hidden">

      {/* ── Space switcher (horizontal tabs) ────────────────────────── */}
      <div className="flex items-center gap-1 px-5 pt-4 pb-0 border-b border-app-border flex-shrink-0 overflow-x-auto">
        {workspaces.map(ws => (
          <button
            key={ws.id}
            onClick={() => setSelectedWs(ws)}
            className={`flex items-center gap-1.5 px-3 py-2 rounded-t-xl text-[12.5px] whitespace-nowrap transition-all border-b-2 -mb-px ${
              selectedWs?.id === ws.id
                ? 'border-app-fg text-app-fg font-medium bg-app-nav-active-bg'
                : 'border-transparent text-app-fg-subtle hover:text-app-fg hover:bg-app-nav-hover-bg'
            }`}
          >
            <span className="text-sm leading-none">{ws.emoji}</span>
            <span>{ws.name}</span>
          </button>
        ))}
        <button
          onClick={() => setShowCreate(true)}
          className="flex items-center gap-1 px-2.5 py-2 rounded-t-xl text-[12px] text-app-fg-subtle hover:text-app-fg hover:bg-app-nav-hover-bg transition-all border-b-2 border-transparent -mb-px whitespace-nowrap"
        >
          <Plus size={13} strokeWidth={2} /> New space
        </button>
      </div>

      {/* ── Content area ────────────────────────────────────────────── */}
      {selectedWs ? (
        <div className="flex-1 flex flex-col overflow-hidden">

          {/* Header */}
          <div className="px-8 pt-7 pb-5 flex-shrink-0">
            <div className="flex items-start justify-between mb-1">
              <div className="flex items-center gap-3">
                <span className="text-3xl">{selectedWs.emoji}</span>
                <div>
                  {editingName ? (
                    <input
                      ref={nameRef}
                      value={nameInput}
                      onChange={e => setNameInput(e.target.value)}
                      onKeyDown={e => { if (e.key === 'Enter') handleRename(); if (e.key === 'Escape') setEditingName(false); }}
                      onBlur={handleRename}
                      className="text-[22px] font-bold text-app-fg bg-transparent border-b-2 border-[#f06060] outline-none tracking-tight"
                    />
                  ) : (
                    <h1
                      className="text-[22px] font-bold text-app-fg tracking-tight cursor-default hover:text-app-fg-muted transition-colors"
                      onClick={() => { setNameInput(selectedWs.name); setEditingName(true); }}
                    >
                      {selectedWs.name}
                    </h1>
                  )}
                  <p className="text-[13px] text-app-fg-subtle mt-0.5">
                    {meetings.length} meeting{meetings.length !== 1 ? 's' : ''} · {folders.length} folder{folders.length !== 1 ? 's' : ''}
                  </p>
                </div>
              </div>

              {/* Top-right actions */}
              <div className="flex items-center gap-2" ref={wsMenuRef as any}>
                <button
                  onClick={() => setAddMeetingOpen(true)}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border text-app-fg text-[12px] font-medium hover:bg-app-nav-hover-bg transition-colors"
                >
                  <Plus size={13} /> Add meeting
                </button>
                <div className="relative">
                  <button
                    onClick={() => setWsMenuOpen(v => !v)}
                    className="p-2 rounded-lg border border-app-border hover:bg-app-nav-hover-bg text-app-fg-subtle transition-colors"
                  >
                    <MoreHorizontal size={15} />
                  </button>
                  {wsMenuOpen && (
                    <div className="absolute right-0 top-full mt-1 z-50 bg-app-panel rounded-xl border border-app-border shadow-xl py-1 w-44">
                      <button
                        onClick={() => { setNameInput(selectedWs.name); setEditingName(true); setWsMenuOpen(false); }}
                        className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg"
                      >
                        <Pencil size={13} /> Rename space
                      </button>
                      <div className="h-px bg-app-border mx-2 my-1" />
                      <button
                        onClick={handleDelete}
                        className="w-full flex items-center gap-2 px-3 py-2 text-[12.5px] text-red-500 hover:bg-red-50 dark:hover:bg-red-950/30"
                      >
                        <Trash2 size={13} /> Delete space
                      </button>
                    </div>
                  )}
                </div>
              </div>
            </div>

            {/* AI query bar */}
            <div className="mt-5 flex items-center gap-3 px-4 py-3 bg-app-status-bg border border-app-border rounded-2xl hover:border-app-fg-subtle transition-colors cursor-text group">
              <Search size={14} className="text-app-fg-subtle flex-shrink-0" />
              <span className="flex-1 text-[13px] text-app-fg-subtle">Ask about this space…</span>
              <Mic size={14} className="text-app-fg-subtle group-hover:text-app-fg transition-colors" />
            </div>

            {/* Quick chips */}
            <div className="flex items-center gap-2 mt-3 flex-wrap">
              {['List recent todos', 'Summarize this space', 'Show in-flight projects', 'All topics'].map(chip => (
                <button
                  key={chip}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg border border-app-border bg-app-status-bg text-[11.5px] text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg hover:border-app-fg-subtle transition-all"
                >
                  <ChevronRight size={11} className="opacity-50" />
                  {chip}
                </button>
              ))}
            </div>

            {/* Folder filter row */}
            {folders.length > 0 && (
              <div className="flex items-center gap-1.5 mt-4 flex-wrap">
                <button
                  onClick={() => setSelectedFolder(null)}
                  className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] border transition-all ${
                    !selectedFolder
                      ? 'bg-app-fg text-app-canvas border-app-fg'
                      : 'border-app-border text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg'
                  }`}
                >
                  <FileText size={11} /> All
                </button>
                {folders.map(f => (
                  <div key={f.id} className="group flex items-center">
                    <button
                      onClick={() => setSelectedFolder(f)}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[11.5px] border transition-all ${
                        selectedFolder?.id === f.id
                          ? 'bg-app-fg text-app-canvas border-app-fg'
                          : 'border-app-border text-app-fg-subtle hover:bg-app-nav-hover-bg hover:text-app-fg'
                      }`}
                    >
                      <Folder size={11} /> {f.name}
                    </button>
                    <button
                      onClick={() => handleDeleteFolder(f)}
                      className="opacity-0 group-hover:opacity-100 -ml-1 p-1 text-app-fg-subtle hover:text-red-500 transition-all"
                    >
                      <X size={10} />
                    </button>
                  </div>
                ))}
                {/* New folder inline */}
                <div className="flex items-center gap-1">
                  <input
                    id="new-folder-input"
                    value={newFolderName}
                    onChange={e => setNewFolderName(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setNewFolderName(''); }}
                    placeholder="+ New folder"
                    className="text-[11.5px] px-3 py-1.5 bg-transparent border border-dashed border-app-border rounded-lg outline-none text-app-fg placeholder:text-app-fg-subtle focus:border-app-fg-subtle w-28"
                  />
                  {newFolderName.trim() && (
                    <button
                      onClick={handleCreateFolder}
                      disabled={addingFolder}
                      className="p-1.5 rounded-lg bg-app-fg text-app-canvas disabled:opacity-30"
                    >
                      {addingFolder ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                    </button>
                  )}
                </div>
              </div>
            )}
            {folders.length === 0 && (
              <div className="flex items-center gap-1 mt-4">
                <input
                  id="new-folder-input"
                  value={newFolderName}
                  onChange={e => setNewFolderName(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter') handleCreateFolder(); if (e.key === 'Escape') setNewFolderName(''); }}
                  placeholder="+ New folder"
                  className="text-[11.5px] px-3 py-1.5 bg-transparent border border-dashed border-app-border rounded-lg outline-none text-app-fg placeholder:text-app-fg-subtle focus:border-app-fg-subtle w-28"
                />
                {newFolderName.trim() && (
                  <button
                    onClick={handleCreateFolder}
                    disabled={addingFolder}
                    className="p-1.5 rounded-lg bg-app-fg text-app-canvas disabled:opacity-30"
                  >
                    {addingFolder ? <Loader2 size={10} className="animate-spin" /> : <Plus size={10} />}
                  </button>
                )}
              </div>
            )}
          </div>

          {/* Notes / Files tab bar */}
          <div className="px-8 flex items-center gap-1 border-b border-app-border flex-shrink-0">
            {(['notes', 'files'] as const).map(tab => (
              <button
                key={tab}
                onClick={() => setActiveTab(tab)}
                className={`px-4 py-2.5 text-[13px] font-medium border-b-2 transition-all -mb-px ${
                  activeTab === tab
                    ? 'border-app-fg text-app-fg'
                    : 'border-transparent text-app-fg-subtle hover:text-app-fg-muted'
                }`}
              >
                {tab === 'notes' ? 'Notes' : 'Files'}
              </button>
            ))}
          </div>

          {/* Meeting / file content */}
          <div className="flex-1 overflow-y-auto">
            {activeTab === 'notes' ? (
              loadingContent ? (
                <div className="flex items-center justify-center py-16">
                  <Loader2 className="animate-spin text-app-fg-subtle" size={18} />
                </div>
              ) : meetings.length === 0 ? (
                <div className="text-center py-20">
                  <p className="text-[13px] text-app-fg-subtle mb-3">No meetings in this space yet.</p>
                  <button
                    onClick={() => setAddMeetingOpen(true)}
                    className="text-[12.5px] font-medium text-app-fg border border-app-border px-4 py-2 rounded-xl hover:bg-app-nav-hover-bg transition-colors"
                  >
                    + Add a meeting
                  </button>
                </div>
              ) : (
                <div className="px-4 py-2">
                  {dateGroups.map(({ label, items }) => (
                    <div key={label} className="mb-2">
                      <div className="px-4 py-2 text-[11px] font-semibold text-app-fg-label uppercase tracking-[0.08em]">
                        {label}
                      </div>
                      {items.map(m => {
                        const task = allTasks.find(t => t.id === m.id);
                        return (
                          <MeetingRow
                            key={m.id}
                            meeting={m}
                            onSelect={() => task && onSelectTask(task)}
                            onRemove={() => handleRemoveMeeting(m.id)}
                          />
                        );
                      })}
                    </div>
                  ))}
                </div>
              )
            ) : (
              <div className="px-8 py-6">
                <div className="border border-dashed border-app-border rounded-2xl px-6 py-8 text-center mb-4 hover:border-app-fg-subtle transition-colors cursor-pointer">
                  <p className="text-[12.5px] text-app-fg-subtle">Click to add or drag & drop files</p>
                </div>
                <p className="text-[12px] text-app-fg-subtle text-center mt-8">No files uploaded yet.</p>
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <p className="text-[14px] font-medium text-app-fg mb-1">Select a space</p>
            <p className="text-[12px] text-app-fg-subtle">Choose a space from the tabs above</p>
          </div>
        </div>
      )}

      {/* Add meeting modal */}
      {addMeetingOpen && (
        <div className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/30 backdrop-blur-sm" onClick={() => setAddMeetingOpen(false)}>
          <div className="bg-app-panel rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden border border-app-border" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between px-5 pt-5 pb-3 border-b border-app-border">
              <h3 className="text-[14px] font-semibold text-app-fg">Add to "{selectedWs?.name}"</h3>
              <button onClick={() => setAddMeetingOpen(false)} className="p-1 rounded-lg hover:bg-app-nav-hover-bg text-app-fg-subtle"><X size={14} /></button>
            </div>
            <div className="p-4">
              <input
                autoFocus
                value={addSearch}
                onChange={e => setAddSearch(e.target.value)}
                placeholder="Search meetings…"
                className="w-full px-3 py-2 text-[12.5px] bg-app-status-bg border border-app-border rounded-xl outline-none text-app-fg placeholder:text-app-fg-subtle focus:ring-2 focus:ring-app-fg/20 mb-3"
              />
              <div className="space-y-0.5 max-h-64 overflow-y-auto">
                {filteredTasks.slice(0, 40).map(t => (
                  <button
                    key={t.id}
                    onClick={() => handleAddMeeting(t.id!)}
                    disabled={addingTaskId === t.id}
                    className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-app-nav-hover-bg text-left transition-colors disabled:opacity-50 group"
                  >
                    <div className="w-7 h-7 rounded-lg bg-app-status-bg border border-app-border flex items-center justify-center flex-shrink-0">
                      <FileText size={12} className="text-app-fg-subtle" />
                    </div>
                    <span className="flex-1 text-[12.5px] text-app-fg truncate">{t.filename}</span>
                    {addingTaskId === t.id
                      ? <Loader2 size={12} className="animate-spin text-app-fg-subtle" />
                      : <Plus size={12} className="text-app-fg-subtle opacity-0 group-hover:opacity-100 transition-opacity" />
                    }
                  </button>
                ))}
                {filteredTasks.length === 0 && (
                  <p className="text-center text-[12px] text-app-fg-subtle py-6">No meetings found</p>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Create workspace modal */}
      {showCreate && (
        <CreateWorkspaceModal
          onClose={() => setShowCreate(false)}
          onCreated={ws => { setWorkspaces(prev => [...prev, ws]); setSelectedWs(ws); setShowCreate(false); }}
        />
      )}

      {wsMenuOpen && <div className="fixed inset-0 z-40" onClick={() => setWsMenuOpen(false)} />}
    </div>
  );
}
