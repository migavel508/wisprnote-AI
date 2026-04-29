import { useState, useEffect, useRef, useCallback } from 'react';
import {
  X, Link2, Copy, Check, Globe, Lock, UserPlus,
  Trash2, Loader2, ToggleLeft, ToggleRight,
} from 'lucide-react';
import {
  createShare, getShareByTaskId, updateShareAccess, revokeShare,
  reactivateShare, addShareEmails, removeShareEmail, getShareEmails,
  copyShareUrl, getShareUrl,
  type SharedMeeting, type SharedMeetingAccess,
} from '../services/shareService';

interface ShareModalProps {
  taskId: string;
  taskName: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function ShareModal({ taskId, taskName, isOpen, onClose }: ShareModalProps) {
  const [share, setShare] = useState<SharedMeeting | null>(null);
  const [emails, setEmails] = useState<SharedMeetingAccess[]>([]);
  const [emailInput, setEmailInput] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);

  const loadShare = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const existing = await getShareByTaskId(taskId);
      setShare(existing);
      if (existing) {
        const accessList = await getShareEmails(existing.id);
        setEmails(accessList);
      }
    } catch {
      setError('Failed to load sharing settings.');
    } finally {
      setLoading(false);
    }
  }, [taskId]);

  useEffect(() => {
    if (isOpen) loadShare();
  }, [isOpen, loadShare]);

  useEffect(() => {
    if (!isOpen) {
      setCopied(false);
      setEmailInput('');
      setError(null);
    }
  }, [isOpen]);

  // Close on Escape
  useEffect(() => {
    const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    if (isOpen) window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  const handleCreateShare = async (accessType: 'public' | 'restricted') => {
    setSaving(true);
    setError(null);
    try {
      const created = await createShare(taskId, accessType);
      setShare(created);
    } catch {
      setError('Failed to create share link.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleAccess = async () => {
    if (!share) return;
    setSaving(true);
    setError(null);
    try {
      const newType = share.access_type === 'public' ? 'restricted' : 'public';
      const updated = await updateShareAccess(share.id, newType);
      setShare(updated);
    } catch {
      setError('Failed to update access type.');
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async () => {
    if (!share) return;
    setSaving(true);
    setError(null);
    try {
      if (share.is_active) {
        await revokeShare(share.id);
        setShare({ ...share, is_active: false });
      } else {
        await reactivateShare(share.id);
        setShare({ ...share, is_active: true });
      }
    } catch {
      setError('Failed to update share status.');
    } finally {
      setSaving(false);
    }
  };

  const handleAddEmail = async () => {
    if (!share) return;
    const raw = emailInput.trim().toLowerCase();
    if (!raw || !raw.includes('@')) return;
    if (emails.some(e => e.email === raw)) {
      setEmailInput('');
      return;
    }
    setSaving(true);
    try {
      await addShareEmails(share.id, [raw]);
      const updated = await getShareEmails(share.id);
      setEmails(updated);
      setEmailInput('');
    } catch {
      setError('Failed to add email.');
    } finally {
      setSaving(false);
    }
  };

  const handleRemoveEmail = async (email: string) => {
    if (!share) return;
    try {
      await removeShareEmail(share.id, email);
      setEmails(prev => prev.filter(e => e.email !== email));
    } catch {
      setError('Failed to remove email.');
    }
  };

  const handleCopy = () => {
    if (!share) return;
    copyShareUrl(share.share_token);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const handleEmailKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' || e.key === ',') {
      e.preventDefault();
      handleAddEmail();
    }
  };

  return (
    <div
      ref={backdropRef}
      className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/40 backdrop-blur-sm"
      onClick={(e) => { if (e.target === backdropRef.current) onClose(); }}
    >
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md mx-4 overflow-hidden animate-in fade-in zoom-in-95 duration-200">
        {/* Header */}
        <div className="flex items-center justify-between px-6 pt-5 pb-3">
          <div className="flex-1 min-w-0">
            <h2 className="text-[16px] font-semibold text-[#1a1a1a] tracking-tight">Share Meeting</h2>
            <p className="text-[12px] text-[#1a1a1a]/40 truncate mt-0.5">{taskName}</p>
          </div>
          <button onClick={onClose} className="p-1.5 rounded-lg hover:bg-[#f5f0eb] transition-colors -mr-1">
            <X className="w-4 h-4 text-[#1a1a1a]/40" />
          </button>
        </div>

        <div className="px-6 pb-6">
          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="w-5 h-5 animate-spin text-[#1a1a1a]/20" />
            </div>
          ) : !share ? (
            /* No share exists — creation UI */
            <div className="space-y-3 pt-2">
              <p className="text-[13px] text-[#1a1a1a]/60">Choose who can access this meeting:</p>
              <button
                onClick={() => handleCreateShare('public')}
                disabled={saving}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-[#e8e2da] hover:border-[#c4bab0] hover:bg-[#faf8f6] transition-all text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center flex-shrink-0">
                  <Globe className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-[#1a1a1a]">Anyone with the link</div>
                  <div className="text-[11px] text-[#1a1a1a]/40 mt-0.5">No sign-in required to view</div>
                </div>
              </button>
              <button
                onClick={() => handleCreateShare('restricted')}
                disabled={saving}
                className="w-full flex items-center gap-3 p-3.5 rounded-xl border border-[#e8e2da] hover:border-[#c4bab0] hover:bg-[#faf8f6] transition-all text-left"
              >
                <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center flex-shrink-0">
                  <Lock className="w-4 h-4 text-amber-600" />
                </div>
                <div>
                  <div className="text-[13px] font-semibold text-[#1a1a1a]">Specific people</div>
                  <div className="text-[11px] text-[#1a1a1a]/40 mt-0.5">Only invited emails can view</div>
                </div>
              </button>
            </div>
          ) : (
            /* Share exists — management UI */
            <div className="space-y-4 pt-1">
              {/* Link + copy */}
              <div className="flex items-center gap-2">
                <div className="flex-1 flex items-center gap-2 px-3 py-2 bg-[#f5f0eb] rounded-lg min-w-0">
                  <Link2 className="w-3.5 h-3.5 text-[#a89888] flex-shrink-0" />
                  <span className="text-[12px] text-[#1a1a1a]/60 truncate font-mono">
                    {getShareUrl(share.share_token)}
                  </span>
                </div>
                <button
                  onClick={handleCopy}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-[12px] font-semibold transition-all flex-shrink-0 ${
                    copied
                      ? 'bg-emerald-50 text-emerald-700'
                      : 'bg-[#1a1a1a] text-white hover:bg-[#333]'
                  }`}
                >
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copied ? 'Copied' : 'Copy'}
                </button>
              </div>

              {/* Access type toggle */}
              <div className="flex items-center justify-between p-3 rounded-xl bg-[#faf8f6] border border-[#e8e2da]/60">
                <div className="flex items-center gap-2.5">
                  {share.access_type === 'public' ? (
                    <Globe className="w-4 h-4 text-emerald-600" />
                  ) : (
                    <Lock className="w-4 h-4 text-amber-600" />
                  )}
                  <div>
                    <div className="text-[12.5px] font-semibold text-[#1a1a1a]">
                      {share.access_type === 'public' ? 'Anyone with the link' : 'Restricted access'}
                    </div>
                    <div className="text-[11px] text-[#1a1a1a]/40">
                      {share.access_type === 'public' ? 'No sign-in needed' : 'Only invited emails'}
                    </div>
                  </div>
                </div>
                <button
                  onClick={handleToggleAccess}
                  disabled={saving}
                  className="text-[11px] font-semibold text-[#a89888] hover:text-[#5c5147] transition-colors"
                >
                  Switch
                </button>
              </div>

              {/* Email invites (for restricted) */}
              {share.access_type === 'restricted' && (
                <div className="space-y-2.5">
                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <UserPlus className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[#a89888]" />
                      <input
                        ref={emailRef}
                        type="email"
                        placeholder="Add email address…"
                        value={emailInput}
                        onChange={e => setEmailInput(e.target.value)}
                        onKeyDown={handleEmailKeyDown}
                        className="w-full pl-9 pr-3 py-2 text-[12.5px] bg-[#f5f0eb] rounded-lg border-none outline-none placeholder:text-[#b5a99a] focus:ring-2 focus:ring-[#c4bab0]/50 transition-all"
                      />
                    </div>
                    <button
                      onClick={handleAddEmail}
                      disabled={saving || !emailInput.trim()}
                      className="px-3 py-2 text-[12px] font-semibold bg-[#1a1a1a] text-white rounded-lg hover:bg-[#333] disabled:opacity-30 transition-all"
                    >
                      Add
                    </button>
                  </div>

                  {emails.length > 0 && (
                    <div className="space-y-1 max-h-32 overflow-y-auto">
                      {emails.map(entry => (
                        <div key={entry.id} className="flex items-center justify-between px-3 py-1.5 rounded-lg hover:bg-[#faf8f6] group transition-colors">
                          <div className="flex items-center gap-2 min-w-0">
                            <div className="w-6 h-6 rounded-full bg-[#e8e2da] flex items-center justify-center flex-shrink-0">
                              <span className="text-[10px] font-bold text-[#5c5147] uppercase">
                                {entry.email[0]}
                              </span>
                            </div>
                            <span className="text-[12px] text-[#1a1a1a]/70 truncate">{entry.email}</span>
                            {entry.accessed_at && (
                              <span className="text-[9px] text-emerald-600 bg-emerald-50 px-1.5 py-0.5 rounded-full font-medium flex-shrink-0">
                                Viewed
                              </span>
                            )}
                          </div>
                          <button
                            onClick={() => handleRemoveEmail(entry.email)}
                            className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-red-50 transition-all"
                          >
                            <Trash2 className="w-3 h-3 text-red-400" />
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {/* Active toggle + danger zone */}
              <div className="pt-2 border-t border-[#e8e2da]/60">
                <button
                  onClick={handleToggleActive}
                  disabled={saving}
                  className="flex items-center gap-2 text-[12px] text-[#1a1a1a]/50 hover:text-[#1a1a1a]/70 transition-colors"
                >
                  {share.is_active ? (
                    <ToggleRight className="w-5 h-5 text-emerald-500" />
                  ) : (
                    <ToggleLeft className="w-5 h-5 text-[#c4bab0]" />
                  )}
                  <span className="font-medium">
                    {share.is_active ? 'Link is active' : 'Link is disabled'}
                  </span>
                </button>
              </div>

              {error && (
                <p className="text-[11px] text-red-500 font-medium">{error}</p>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
