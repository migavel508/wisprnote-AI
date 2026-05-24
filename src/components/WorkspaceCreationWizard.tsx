import { useEffect, useRef, useState } from 'react';
import { Search, Loader2, Link2, Check, User, Pencil, Trash2 } from 'lucide-react';
import {
  createWorkspace, addWorkspaceMember,
  setWorkspaceImage, getAvatarGradient,
  type Workspace,
} from '../services/workspaceService';
import { formatDisplayName } from '../lib/displayName';
import type { AuthSession } from '../services/awsAuthService';

interface Props {
  session: AuthSession | null;
  onClose: () => void;
  onCreated: (ws: Workspace) => void;
}

type Step = 'name' | 'invite';

function EditableAvatar({
  name, image, size = 68, onPick, onClear,
}: {
  name: string;
  image: string | null;
  size?: number;
  onPick: () => void;
  onClear: () => void;
}) {
  const initial = (name.trim() || '?').charAt(0).toUpperCase();
  const [c1, c2, c3] = getAvatarGradient(name || 'workspace');
  const gradient = `linear-gradient(135deg, ${c1} 0%, ${c2} 55%, ${c3} 100%)`;

  return (
    <div
      className="group relative rounded-2xl flex items-center justify-center text-white font-semibold shadow-sm overflow-hidden cursor-pointer transition-transform hover:scale-[1.03]"
      style={{ width: size, height: size, fontSize: size * 0.42, background: image ? 'transparent' : gradient }}
      onClick={onPick}
    >
      {image ? (
        <img src={image} alt="Workspace" className="w-full h-full object-cover" />
      ) : (
        <span style={{ fontSize: size * 0.45 }}>{initial}</span>
      )}

      {/* Hover edit overlay */}
      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center">
        <Pencil size={size * 0.28} strokeWidth={1.8} className="text-white" />
      </div>

      {/* Clear button when image is set */}
      {image && (
        <button
          onClick={(e) => { e.stopPropagation(); onClear(); }}
          title="Remove image"
          className="absolute -top-1 -right-1 w-5 h-5 rounded-full bg-app-canvas border border-app-divider text-app-fg-subtle hover:text-red-500 flex items-center justify-center shadow opacity-0 group-hover:opacity-100 transition-opacity"
        >
          <Trash2 size={10} strokeWidth={1.8} />
        </button>
      )}
    </div>
  );
}

function PaperPlane({ size = 110 }: { size?: number }) {
  return (
    <svg width={size} height={size * 0.85} viewBox="0 0 120 100" fill="none" xmlns="http://www.w3.org/2000/svg">
      <path d="M20 45 L100 15 L60 90 L50 60 Z" fill="#f5b7d3" stroke="#1f2937" strokeWidth="1.2" strokeLinejoin="round"/>
      <path d="M100 15 L50 60 L60 90 Z" fill="#f5c87d" stroke="#1f2937" strokeWidth="1.2" strokeLinejoin="round"/>
      <text x="65" y="50" fontSize="14" fontFamily="serif" fontStyle="italic" fill="#1f2937" transform="rotate(-12 65 50)">Hi</text>
    </svg>
  );
}

export default function WorkspaceCreationWizard({ session, onClose, onCreated }: Props) {
  const [step, setStep] = useState<Step>('name');
  const [name, setName] = useState(formatDisplayName(session?.user?.email, session?.user?.name, ''));
  const [image, setImage] = useState<string | null>(null);
  const [createdWs, setCreatedWs] = useState<Workspace | null>(null);
  const [creating, setCreating] = useState(false);
  const [emailInput, setEmailInput] = useState('');
  const [invitees, setInvitees] = useState<{ email: string; checked: boolean }[]>([]);
  const [inviting, setInviting] = useState(false);
  const [copied, setCopied] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (step === 'name') setTimeout(() => nameRef.current?.focus(), 50);
  }, [step]);

  const handlePickImage = () => fileRef.current?.click();

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      alert('Image must be under 2 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : null;
      if (result) setImage(result);
    };
    reader.readAsDataURL(file);
    // Reset so the same file can be re-selected later
    e.target.value = '';
  };

  const handleCreate = async () => {
    const trimmed = name.trim();
    if (!trimmed || creating) return;
    setCreating(true);
    try {
      const ws = await createWorkspace(trimmed);
      if (image) setWorkspaceImage(ws.id, image);
      setCreatedWs(ws);
      onCreated(ws);
      setStep('invite');
    } catch {
      // silently allow retry
    } finally {
      setCreating(false);
    }
  };

  const handleAddInvitee = () => {
    const v = emailInput.trim();
    if (!v) return;
    if (invitees.some(i => i.email.toLowerCase() === v.toLowerCase())) { setEmailInput(''); return; }
    setInvitees(prev => [...prev, { email: v, checked: true }]);
    setEmailInput('');
  };

  const handleInvite = async () => {
    if (!createdWs) return;
    const targets = invitees.filter(i => i.checked);
    if (targets.length === 0) return;
    setInviting(true);
    try {
      await Promise.all(
        targets.map(t => addWorkspaceMember(createdWs.id, t.email).catch(() => null))
      );
      onClose();
    } finally { setInviting(false); }
  };

  const handleCopyLink = async () => {
    if (!createdWs) return;
    try {
      await navigator.clipboard.writeText(`${window.location.origin}/workspace/${createdWs.id}`);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {}
  };

  return (
    <div className="fixed inset-0 z-[10000] bg-app-canvas font-sans flex flex-col">
      {/* Top bar with Cancel */}
      <div className="flex items-center justify-end px-6 pt-4 pb-2">
        <button
          onClick={onClose}
          className="text-[13px] text-app-fg-subtle hover:text-app-fg transition-colors"
        >
          Cancel
        </button>
      </div>

      {/* Body */}
      <div className="flex-1 overflow-y-auto flex flex-col items-center justify-center px-6">

        {step === 'name' && (
          <div className="w-full max-w-[560px] flex flex-col items-center text-center">
            <h1 className="font-serif text-[36px] leading-tight text-app-fg tracking-tight mb-10">Create a workspace</h1>

            <div className="w-full bg-app-canvas border border-app-divider rounded-2xl px-8 py-7 shadow-[0_4px_16px_-8px_rgba(0,0,0,0.05)]">
              <div className="flex justify-center mb-5">
                <EditableAvatar
                  name={name}
                  image={image}
                  size={72}
                  onPick={handlePickImage}
                  onClear={() => setImage(null)}
                />
                <input
                  ref={fileRef}
                  type="file"
                  accept="image/*"
                  onChange={handleFileChange}
                  className="hidden"
                />
              </div>
              <label className="block text-[12.5px] font-semibold text-app-fg mb-1.5 text-left">Workspace name</label>
              <input
                ref={nameRef}
                value={name}
                onChange={e => setName(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleCreate(); }}
                placeholder="e.g. Acme"
                className="w-full px-3 py-2 text-[14px] bg-app-nav-hover-bg/40 border border-app-divider rounded-lg outline-none text-app-fg placeholder:text-app-fg-subtle focus:border-app-fg-subtle transition-colors"
              />
            </div>

            <button
              onClick={handleCreate}
              disabled={!name.trim() || creating}
              className="mt-7 px-6 py-2.5 rounded-full bg-app-fg text-app-canvas text-[13.5px] font-semibold tracking-[-0.01em] disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-2"
            >
              {creating && <Loader2 size={13} className="animate-spin" />}
              Create workspace
            </button>
          </div>
        )}

        {step === 'invite' && (
          <div className="w-full max-w-[600px] flex flex-col items-center text-center">
            <PaperPlane size={120} />
            <h1 className="font-serif text-[36px] leading-tight text-app-fg tracking-tight mt-5">Invite teammates</h1>
            <p className="text-[13.5px] text-app-fg-muted mt-2 mb-8">Collaborate on meeting notes, share folders, and more.</p>

            <div className="w-full border border-app-divider rounded-2xl bg-app-canvas px-4 pt-3 pb-3">
              <div className="flex items-center gap-2 px-3 py-2 rounded-xl border border-app-divider mb-3 focus-within:border-app-fg-subtle transition-colors">
                <Search size={13} strokeWidth={1.7} className="text-app-fg-subtle" />
                <input
                  value={emailInput}
                  onChange={e => setEmailInput(e.target.value)}
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ',') { e.preventDefault(); handleAddInvitee(); } }}
                  onBlur={handleAddInvitee}
                  placeholder="Search by name or email"
                  className="flex-1 bg-transparent outline-none text-[13px] text-app-fg placeholder:text-app-fg-subtle"
                />
              </div>

              {invitees.length === 0 ? (
                <p className="text-[12.5px] text-app-fg-subtle py-4 text-center">Add emails above to invite your team.</p>
              ) : (
                <div className="space-y-1 mb-3">
                  {invitees.map((inv, i) => (
                    <div key={inv.email} className="flex items-center gap-3 px-3 py-2 rounded-lg hover:bg-app-nav-hover-bg transition-colors">
                      <div className="w-7 h-7 rounded-full bg-app-nav-hover-bg flex items-center justify-center flex-shrink-0">
                        <User size={13} strokeWidth={1.7} className="text-app-fg-subtle" />
                      </div>
                      <span className="flex-1 text-[13px] text-app-fg text-left truncate">{inv.email}</span>
                      <button
                        onClick={() => setInvitees(prev => prev.map((x, idx) => idx === i ? { ...x, checked: !x.checked } : x))}
                        className={`w-5 h-5 rounded flex items-center justify-center transition-all ${
                          inv.checked ? 'bg-emerald-600 text-white' : 'border border-app-divider'
                        }`}
                      >
                        {inv.checked && <Check size={12} strokeWidth={2.4} />}
                      </button>
                    </div>
                  ))}
                </div>
              )}

              <div className="flex items-center justify-between gap-2 pt-3 border-t border-app-divider">
                <button
                  onClick={handleCopyLink}
                  className="flex items-center gap-1.5 px-3 py-1.5 rounded-full border border-app-divider text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg transition-colors"
                >
                  <Link2 size={12} strokeWidth={1.7} />
                  {copied ? 'Copied!' : 'Copy link'}
                </button>
                <div className="flex items-center gap-1.5">
                  <button
                    onClick={onClose}
                    className="px-3 py-1.5 rounded-full border border-app-divider text-[12.5px] text-app-fg hover:bg-app-nav-hover-bg transition-colors"
                  >
                    Skip
                  </button>
                  <button
                    onClick={handleInvite}
                    disabled={inviting || invitees.filter(i => i.checked).length === 0}
                    className="px-4 py-1.5 rounded-full bg-app-fg text-app-canvas text-[12.5px] font-semibold disabled:opacity-40 disabled:cursor-not-allowed hover:opacity-90 transition-opacity flex items-center gap-1.5"
                  >
                    {inviting && <Loader2 size={11} className="animate-spin" />}
                    Invite {invitees.filter(i => i.checked).length > 0 ? invitees.filter(i => i.checked).length : ''}
                  </button>
                </div>
              </div>
            </div>

            <p className="text-[11.5px] text-app-fg-subtle mt-4 flex items-center gap-1.5">
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></svg>
              Your meetings stay private by default unless you share them.
            </p>
          </div>
        )}

      </div>

      {/* Progress dots */}
      <div className="flex items-center justify-center gap-1.5 py-6">
        {(['name', 'invite'] as Step[]).map(s => (
          <span
            key={s}
            className={`h-1 rounded-full transition-all ${
              s === step ? 'w-6 bg-app-fg' : 'w-3 bg-app-divider'
            }`}
          />
        ))}
      </div>
    </div>
  );
}
