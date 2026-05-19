import { useState, useEffect, useMemo } from 'react';
import { Search, Users, Briefcase, Mail, Calendar, Loader2, ChevronRight } from 'lucide-react';
import { getContacts, type Contact } from '../services/workspaceService';
import type { TaskHistory } from '../services/awsService';

function formatDate(iso: string) {
  return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function initials(name: string) {
  return name.split(/\s+/).slice(0, 2).map(w => w[0]?.toUpperCase() || '').join('');
}

function avatarColor(name: string) {
  const colors = [
    'bg-red-100 text-red-700',
    'bg-amber-100 text-amber-700',
    'bg-emerald-100 text-emerald-700',
    'bg-blue-100 text-blue-700',
    'bg-purple-100 text-purple-700',
    'bg-pink-100 text-pink-700',
    'bg-cyan-100 text-cyan-700',
  ];
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) & 0xffffffff;
  return colors[Math.abs(h) % colors.length];
}

interface ContactCardProps {
  contact: Contact;
  allTasks: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
}

function ContactCard({ contact, allTasks, onSelectTask }: ContactCardProps) {
  const [expanded, setExpanded] = useState(false);
  const relatedTasks = useMemo(
    () => allTasks.filter(t => contact.task_ids.includes(t.id!)),
    [allTasks, contact.task_ids]
  );

  return (
    <div className="bg-app-status-bg border border-app-border rounded-2xl overflow-hidden transition-all hover:border-app-fg-subtle">
      <button
        onClick={() => setExpanded(e => !e)}
        className="w-full flex items-center gap-4 p-4 text-left"
      >
        {/* Avatar */}
        <div className={`w-10 h-10 rounded-full flex items-center justify-center flex-shrink-0 text-[13px] font-semibold ${avatarColor(contact.name)}`}>
          {initials(contact.name)}
        </div>

        <div className="flex-1 min-w-0">
          <p className="text-[14px] font-semibold text-app-fg truncate">{contact.name}</p>
          <div className="flex items-center gap-3 mt-0.5 flex-wrap">
            {contact.role && (
              <span className="text-[11px] text-app-fg-subtle flex items-center gap-1">
                <Briefcase size={10} /> {contact.role}
              </span>
            )}
            {contact.company && (
              <span className="text-[11px] text-app-fg-subtle">{contact.company}</span>
            )}
            {contact.email && (
              <span className="text-[11px] text-app-fg-subtle flex items-center gap-1">
                <Mail size={10} /> {contact.email}
              </span>
            )}
          </div>
        </div>

        <div className="flex items-center gap-3 flex-shrink-0">
          <div className="text-right">
            <p className="text-[12px] font-semibold text-app-fg">{contact.meeting_count}</p>
            <p className="text-[10px] text-app-fg-subtle">{contact.meeting_count === 1 ? 'meeting' : 'meetings'}</p>
          </div>
          <ChevronRight
            size={14}
            className={`text-app-fg-subtle transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          />
        </div>
      </button>

      {expanded && (
        <div className="border-t border-app-border px-4 pb-4 pt-3">
          <p className="text-[10px] font-mono font-medium text-app-fg-label uppercase tracking-[0.1em] mb-2">
            Appeared in {relatedTasks.length} meeting{relatedTasks.length !== 1 ? 's' : ''}
          </p>
          <div className="space-y-1.5">
            {relatedTasks.map(t => (
              <button
                key={t.id}
                onClick={() => onSelectTask(t)}
                className="w-full flex items-center gap-2.5 px-3 py-2 rounded-xl bg-app-panel hover:bg-app-nav-hover-bg text-left transition-colors border border-app-border/50"
              >
                <div className="w-6 h-6 rounded-lg bg-[#f06060]/10 flex items-center justify-center flex-shrink-0">
                  <Calendar size={11} className="text-[#f06060]" />
                </div>
                <span className="flex-1 text-[12px] text-app-fg truncate">{t.filename}</span>
                {t.created_at && (
                  <span className="text-[10px] text-app-fg-subtle flex-shrink-0">
                    {formatDate(t.created_at)}
                  </span>
                )}
              </button>
            ))}
            {relatedTasks.length === 0 && (
              <p className="text-[12px] text-app-fg-subtle">Meeting notes not loaded yet.</p>
            )}
          </div>
          {contact.last_seen && (
            <p className="text-[10px] text-app-fg-subtle mt-3">
              Last seen {formatDate(contact.last_seen)}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

interface PeoplePageProps {
  allTasks: TaskHistory[];
  onSelectTask: (task: TaskHistory) => void;
}

export default function PeoplePage({ allTasks, onSelectTask }: PeoplePageProps) {
  const [contacts, setContacts] = useState<Contact[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getContacts()
      .then(setContacts)
      .catch(() => setError('Failed to load contacts. Make sure you have processed meetings with people mentioned.'))
      .finally(() => setLoading(false));
  }, []);

  const filtered = useMemo(() => {
    if (!search.trim()) return contacts;
    const q = search.toLowerCase();
    return contacts.filter(c =>
      c.name.toLowerCase().includes(q) ||
      c.role?.toLowerCase().includes(q) ||
      c.company?.toLowerCase().includes(q) ||
      c.email?.toLowerCase().includes(q)
    );
  }, [contacts, search]);

  return (
    <div className="h-full flex flex-col overflow-hidden">
      {/* Header */}
      <div className="px-6 pt-6 pb-4 border-b border-app-border flex-shrink-0">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-8 h-8 rounded-xl bg-blue-50 dark:bg-blue-950/30 flex items-center justify-center">
            <Users size={16} className="text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <h2 className="text-[16px] font-semibold text-app-fg tracking-tight">People</h2>
            <p className="text-[11px] text-app-fg-subtle">Auto-extracted from your meeting notes</p>
          </div>
        </div>
        <div className="relative">
          <Search size={13} className="absolute left-3 top-1/2 -translate-y-1/2 text-app-fg-subtle" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Search people, roles, companies…"
            className="w-full pl-8 pr-3 py-2 text-[12.5px] bg-app-status-bg border border-app-border rounded-xl outline-none focus:ring-2 focus:ring-[#f06060]/30 text-app-fg placeholder:text-app-fg-subtle transition-all"
          />
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-5">
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="animate-spin text-app-fg-subtle" size={20} />
          </div>
        ) : error ? (
          <div className="text-center py-16">
            <p className="text-[13px] text-app-fg-subtle max-w-sm mx-auto">{error}</p>
          </div>
        ) : filtered.length === 0 ? (
          <div className="text-center py-16">
            {contacts.length === 0 ? (
              <>
                <div className="w-14 h-14 rounded-2xl bg-app-status-bg border border-app-border flex items-center justify-center mx-auto mb-3">
                  <Users size={22} className="text-app-fg-subtle" />
                </div>
                <p className="text-[14px] font-medium text-app-fg mb-1">No contacts yet</p>
                <p className="text-[12px] text-app-fg-subtle max-w-xs mx-auto">
                  People mentioned in your meetings will automatically appear here once meetings are processed.
                </p>
              </>
            ) : (
              <p className="text-[13px] text-app-fg-subtle">No people match "{search}"</p>
            )}
          </div>
        ) : (
          <>
            <p className="text-[11px] text-app-fg-subtle mb-3 font-mono">
              {filtered.length} {filtered.length === 1 ? 'person' : 'people'}
              {search && ` matching "${search}"`}
            </p>
            <div className="space-y-2">
              {filtered.map(c => (
                <ContactCard
                  key={`${c.name}-${c.email}`}
                  contact={c}
                  allTasks={allTasks}
                  onSelectTask={onSelectTask}
                />
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
