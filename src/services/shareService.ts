import { supabase } from './supabaseService';
import { logger } from '../lib/logger';

const log = logger.scope('Share');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SharedMeeting {
  id: string;
  task_id: string;
  owner_id: string;
  share_token: string;
  access_type: 'public' | 'restricted';
  permissions: string[];
  is_active: boolean;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface SharedMeetingAccess {
  id: string;
  share_id: string;
  email: string;
  accessed_at: string | null;
  created_at: string;
}

export interface SharedMeetingData {
  filename: string;
  summary: string | null;
  notes: string | null;
  created_at: string | null;
  duration: number;
  permissions: string[];
  owner_name?: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function generateShareToken(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  const values = crypto.getRandomValues(new Uint8Array(22));
  return Array.from(values, v => chars[v % chars.length]).join('');
}

async function getAuthUserId(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.user) throw new Error('User not authenticated');
  return session.user.id;
}

// ---------------------------------------------------------------------------
// Owner Operations
// ---------------------------------------------------------------------------

export async function createShare(
  taskId: string,
  accessType: 'public' | 'restricted' = 'public',
  emails: string[] = [],
): Promise<SharedMeeting> {
  const ownerId = await getAuthUserId();
  const shareToken = generateShareToken();

  const { data, error } = await supabase
    .from('shared_meetings')
    .insert({
      task_id: taskId,
      owner_id: ownerId,
      share_token: shareToken,
      access_type: accessType,
    })
    .select()
    .single();

  if (error) {
    log.error('create_share_failed', { error });
    throw error;
  }

  if (accessType === 'restricted' && emails.length > 0) {
    await addShareEmails(data.id, emails);
  }

  log.info('share_created', { shareId: data.id, accessType });
  return data as SharedMeeting;
}

export async function getShareByTaskId(taskId: string): Promise<SharedMeeting | null> {
  const ownerId = await getAuthUserId();

  const { data, error } = await supabase
    .from('shared_meetings')
    .select('*')
    .eq('task_id', taskId)
    .eq('owner_id', ownerId)
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (error) {
    log.error('get_share_failed', { error });
    throw error;
  }
  return data as SharedMeeting | null;
}

export async function updateShareAccess(
  shareId: string,
  accessType: 'public' | 'restricted',
): Promise<SharedMeeting> {
  const { data, error } = await supabase
    .from('shared_meetings')
    .update({ access_type: accessType })
    .eq('id', shareId)
    .select()
    .single();

  if (error) {
    log.error('update_share_failed', { error });
    throw error;
  }
  log.info('share_updated', { shareId, accessType });
  return data as SharedMeeting;
}

export async function revokeShare(shareId: string): Promise<void> {
  const { error } = await supabase
    .from('shared_meetings')
    .update({ is_active: false })
    .eq('id', shareId);

  if (error) {
    log.error('revoke_share_failed', { error });
    throw error;
  }
  log.info('share_revoked', { shareId });
}

export async function reactivateShare(shareId: string): Promise<void> {
  const { error } = await supabase
    .from('shared_meetings')
    .update({ is_active: true })
    .eq('id', shareId);

  if (error) {
    log.error('reactivate_share_failed', { error });
    throw error;
  }
  log.info('share_reactivated', { shareId });
}

export async function deleteShare(shareId: string): Promise<void> {
  const { error } = await supabase
    .from('shared_meetings')
    .delete()
    .eq('id', shareId);

  if (error) {
    log.error('delete_share_failed', { error });
    throw error;
  }
  log.info('share_deleted', { shareId });
}

// ---------------------------------------------------------------------------
// Email Access Management
// ---------------------------------------------------------------------------

export async function addShareEmails(shareId: string, emails: string[]): Promise<void> {
  const rows = emails
    .map(e => e.trim().toLowerCase())
    .filter(Boolean)
    .map(email => ({ share_id: shareId, email }));

  if (rows.length === 0) return;

  const { error } = await supabase
    .from('shared_meeting_access')
    .upsert(rows, { onConflict: 'share_id,email' });

  if (error) {
    log.error('add_share_emails_failed', { error });
    throw error;
  }
}

export async function removeShareEmail(shareId: string, email: string): Promise<void> {
  const { error } = await supabase
    .from('shared_meeting_access')
    .delete()
    .eq('share_id', shareId)
    .eq('email', email.toLowerCase());

  if (error) {
    log.error('remove_share_email_failed', { error });
    throw error;
  }
}

export async function getShareEmails(shareId: string): Promise<SharedMeetingAccess[]> {
  const { data, error } = await supabase
    .from('shared_meeting_access')
    .select('*')
    .eq('share_id', shareId)
    .order('created_at', { ascending: true });

  if (error) {
    log.error('get_share_emails_failed', { error });
    throw error;
  }
  return (data || []) as SharedMeetingAccess[];
}

// ---------------------------------------------------------------------------
// Viewer Operations (called from /shared/:token)
// ---------------------------------------------------------------------------

export async function verifyShareAccess(
  shareToken: string,
  viewerEmail?: string | null,
): Promise<{ meeting: SharedMeetingData; share: SharedMeeting } | { denied: true; reason: string }> {
  // Fetch the share record by token
  const { data: share, error: shareErr } = await supabase
    .from('shared_meetings')
    .select('*')
    .eq('share_token', shareToken)
    .eq('is_active', true)
    .maybeSingle();

  if (shareErr || !share) {
    return { denied: true, reason: 'This shared link is invalid or has been revoked.' };
  }

  // Check expiry
  if (share.expires_at && new Date(share.expires_at) < new Date()) {
    return { denied: true, reason: 'This shared link has expired.' };
  }

  // For restricted shares, verify the viewer's email is in the access list
  if (share.access_type === 'restricted') {
    if (!viewerEmail) {
      return { denied: true, reason: 'sign_in_required' };
    }

    const { data: accessRow } = await supabase
      .from('shared_meeting_access')
      .select('id')
      .eq('share_id', share.id)
      .ilike('email', viewerEmail.toLowerCase())
      .maybeSingle();

    if (!accessRow) {
      return { denied: true, reason: 'You do not have access to this meeting. Ask the owner to add your email.' };
    }

    // Record first access timestamp
    await supabase
      .from('shared_meeting_access')
      .update({ accessed_at: new Date().toISOString() })
      .eq('id', accessRow.id)
      .is('accessed_at', null);
  }

  // Fetch the meeting data — only the fields allowed by permissions
  const selectFields = ['filename', 'created_at', 'duration'];
  if (share.permissions.includes('summary')) selectFields.push('summary');
  if (share.permissions.includes('notes')) selectFields.push('notes');

  const { data: task, error: taskErr } = await supabase
    .from('task_history')
    .select(selectFields.join(','))
    .eq('id', share.task_id)
    .single();

  if (taskErr || !task) {
    return { denied: true, reason: 'The shared meeting could not be found.' };
  }

  return {
    meeting: {
      filename: task.filename,
      summary: task.summary ?? null,
      notes: task.notes ?? null,
      created_at: task.created_at ?? null,
      duration: task.duration ?? 0,
      permissions: share.permissions,
    },
    share: share as SharedMeeting,
  };
}

// ---------------------------------------------------------------------------
// URL Helpers
// ---------------------------------------------------------------------------

export function getShareUrl(shareToken: string): string {
  return `${window.location.origin}/shared/${shareToken}`;
}

export function copyShareUrl(shareToken: string): void {
  const url = getShareUrl(shareToken);
  navigator.clipboard.writeText(url).catch(() => {
    // Fallback for environments without clipboard API
    const textarea = document.createElement('textarea');
    textarea.value = url;
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  });
}
