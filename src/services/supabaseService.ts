import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    // Disable the Navigator LockManager entirely.
    // The lock is only needed for cross-tab auth sync; this single-tab SPA
    // does not need it and concurrent getUser() calls cause 10s timeout errors.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    lock: (_name: string, _acquireTimeout: number, fn: () => Promise<any>) => fn(),
  },
});

/**
 * Use getSession() instead of getUser() everywhere.
 * getSession() reads from localStorage directly — no Navigator LockManager needed.
 * getUser() acquires an exclusive lock which causes timeouts on concurrent calls.
 */
async function getAuthUserId(): Promise<string> {
  const { data: { session }, error } = await supabase.auth.getSession();
  if (error || !session?.user) throw new Error('User not authenticated');
  return session.user.id;
}

export interface TaskHistory {
  id?: string;
  created_at?: string;
  user_id?: string;
  filename: string;
  transcription: string;
  summary?: string;
  notes?: string;
  audio_url?: string;
  status: 'completed' | 'error';
  duration: number;
  prompt?: string;
  personal_note?: string;
  visualization_image?: string;
}

export interface GeneratedAsset {
  id?: string;
  created_at?: string;
  user_id?: string;
  task_id: string;
  type: 'ppt' | 'report' | 'email' | 'wiki';
  filename: string;
  content: any; // JSON structure for slides or report sections
}

export async function saveTask(task: TaskHistory) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .insert([{ ...task, user_id: userId }])
    .select();
  
  if (error) {
    console.error('Error saving task:', error);
    throw error;
  }
  return data[0];
}

export async function updatePersonalNote(taskId: string, content: string): Promise<void> {
  const userId = await getAuthUserId();

  const { error } = await supabase
    .from('task_history')
    .update({ personal_note: content })
    .eq('id', taskId)
    .eq('user_id', userId);

  if (error) throw error;
}

export async function updateTaskTitle(taskId: string, newTitle: string): Promise<TaskHistory> {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .update({ filename: newTitle })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id, created_at, filename, transcription, summary, notes, prompt, status, duration, personal_note, visualization_image')
    .single();
  
  if (error) {
    console.error('Error updating task title:', error);
    throw error;
  }
  return data as TaskHistory;
}

export async function updateTaskSummary(taskId: string, newSummary: string): Promise<TaskHistory> {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .update({ summary: newSummary })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id, created_at, filename, transcription, summary, notes, prompt, status, duration, personal_note, visualization_image')
    .single();
  
  if (error) {
    console.error('Error updating task summary:', error);
    throw error;
  }
  return data as TaskHistory;
}

export async function updateTaskNotes(taskId: string, newNotes: string): Promise<TaskHistory> {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .update({ notes: newNotes })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id, created_at, filename, transcription, summary, notes, prompt, status, duration, personal_note, visualization_image')
    .single();
  
  if (error) {
    console.error('Error updating task notes:', error);
    throw error;
  }
  return data as TaskHistory;
}

export async function updateTaskVisualization(taskId: string, imageBase64: string): Promise<TaskHistory> {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .update({ visualization_image: imageBase64 })
    .eq('id', taskId)
    .eq('user_id', userId)
    .select('id, created_at, filename, transcription, summary, notes, prompt, status, duration, personal_note, visualization_image')
    .single();
  
  if (error) {
    console.error('Error updating task visualization:', error);
    throw error;
  }
  return data as TaskHistory;
}

// Lightweight task metadata for list views (no heavy transcription/notes)
export interface TaskMetadata {
  id: string;
  created_at: string;
  filename: string;
  summary?: string;
  status: 'completed' | 'error';
  duration: number;
}

// Get tasks with pagination - lightweight version for list views
export async function getTasksLightweight(page: number = 0, pageSize: number = 20): Promise<{ data: TaskMetadata[], hasMore: boolean, total: number }> {
  const userId = await getAuthUserId();

  // Get total count first
  const { count } = await supabase
    .from('task_history')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId);

  // Fetch only essential fields for list view (no transcription, notes)
  const { data, error } = await supabase
    .from('task_history')
    .select('id, created_at, filename, summary, status, duration')
    .eq('user_id', userId)
    .order('created_at', { ascending: false })
    .range(page * pageSize, (page + 1) * pageSize - 1);
  
  if (error) {
    console.error('Error fetching tasks:', error);
    throw error;
  }
  
  return {
    data: data as TaskMetadata[],
    hasMore: (count || 0) > (page + 1) * pageSize,
    total: count || 0
  };
}

// Get full task details by ID (for when user clicks on a task)
export async function getTaskById(taskId: string): Promise<TaskHistory | null> {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .select('*')
    .eq('id', taskId)
    .eq('user_id', userId)
    .single();
  
  if (error) {
    if (error.code === 'PGRST116') return null; // Not found
    console.error('Error fetching task:', error);
    throw error;
  }
  return data as TaskHistory;
}

// Legacy function - fetches all tasks (use sparingly)
export async function getTasks() {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('task_history')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching tasks:', error);
    throw error;
  }
  return data as TaskHistory[];
}

export async function saveAsset(asset: GeneratedAsset) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('generated_assets')
    .insert([{ ...asset, user_id: userId }])
    .select();
  
  if (error) {
    console.error('Error saving asset:', error);
    throw error;
  }
  return data[0];
}

export async function getAssets(taskId: string) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('generated_assets')
    .select('*')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching assets:', error);
    throw error;
  }
  return data as GeneratedAsset[];
}

export interface ManualNote {
  id?: string;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  title: string;
  content: string; // HTML or JSON string from TipTap
}

export async function saveManualNote(note: ManualNote) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('manual_notes')
    .upsert({
      id: note.id,
      user_id: userId,
      title: note.title,
      content: note.content,
      updated_at: new Date().toISOString()
    })
    .select();

  if (error) {
    console.error('Error saving manual note:', error);
    throw error;
  }
  return data[0] as ManualNote;
}

export async function getManualNotes() {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('manual_notes')
    .select('*')
    .eq('user_id', userId)
    .order('updated_at', { ascending: false });

  if (error) {
    console.error('Error fetching manual notes:', error);
    throw error;
  }
  return data as ManualNote[];
}

export async function deleteManualNote(noteId: string) {
  const userId = await getAuthUserId();

  const { error } = await supabase
    .from('manual_notes')
    .delete()
    .eq('id', noteId)
    .eq('user_id', userId);

  if (error) {
    console.error('Error deleting manual note:', error);
    throw error;
  }
}

export async function uploadNoteImage(file: File): Promise<string> {
  const userId = await getAuthUserId();

  const fileExt = file.name.split('.').pop();
  const fileName = `${Math.random()}.${fileExt}`;
  const filePath = `${userId}/${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from('note_images')
    .upload(filePath, file);


  if (uploadError) {
    console.error('Error uploading image:', uploadError);
    throw uploadError;
  }

  const { data } = supabase.storage
    .from('note_images')
    .getPublicUrl(filePath);

  return data.publicUrl;
}

// =====================================================
// KNOWLEDGE GRAPH FUNCTIONS
// =====================================================

export interface KnowledgeGraphEntry {
  id?: string;
  created_at?: string;
  updated_at?: string;
  user_id?: string;
  task_id: string;
  meeting_title: string;
  topics: Array<{ name: string; summary: string; status: string }>;
  decisions: Array<{ decision: string; relatedTopic: string }>;
  people: string[];
  action_items: Array<{ task: string; owner: string; relatedTopic: string }>;
  refs: string[];
}

export async function saveKnowledgeGraph(entry: KnowledgeGraphEntry) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('knowledge_graph')
    .upsert(
      {
        user_id: userId,
        task_id: entry.task_id,
        meeting_title: entry.meeting_title,
        topics: entry.topics,
        decisions: entry.decisions,
        people: entry.people,
        action_items: entry.action_items,
        refs: entry.refs
      },
      { onConflict: 'user_id,task_id' }
    )
    .select();
  
  if (error) {
    console.error('Error saving knowledge graph:', error);
    throw error;
  }
  return data?.[0];
}

export async function saveKnowledgeGraphBatch(entries: KnowledgeGraphEntry[]) {
  const userId = await getAuthUserId();

  const records = entries.map(entry => ({
    user_id: userId,
    task_id: entry.task_id,
    meeting_title: entry.meeting_title,
    topics: entry.topics,
    decisions: entry.decisions,
    people: entry.people,
    action_items: entry.action_items,
    refs: entry.refs
  }));

  const { data, error } = await supabase
    .from('knowledge_graph')
    .upsert(records, { onConflict: 'user_id,task_id' })
    .select();
  
  if (error) {
    console.error('Error saving knowledge graph batch:', error);
    throw error;
  }
  return data as KnowledgeGraphEntry[];
}

export async function getKnowledgeGraph() {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('knowledge_graph')
    .select('*')
    .eq('user_id', userId)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching knowledge graph:', error);
    throw error;
  }
  return data as KnowledgeGraphEntry[];
}

export async function getKnowledgeGraphForTask(taskId: string) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('knowledge_graph')
    .select('*')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    console.error('Error fetching knowledge graph for task:', error);
    throw error;
  }
  return data as KnowledgeGraphEntry | null;
}

export async function deleteKnowledgeGraph(taskId: string) {
  const userId = await getAuthUserId();

  const { error } = await supabase
    .from('knowledge_graph')
    .delete()
    .eq('task_id', taskId)
    .eq('user_id', userId);
  
  if (error) {
    console.error('Error deleting knowledge graph:', error);
    throw error;
  }
}

// =====================================================
// CHAT HISTORY FUNCTIONS
// =====================================================

export interface ChatMessage {
  id?: string;
  created_at?: string;
  user_id?: string;
  task_id: string;
  role: 'user' | 'model';
  text: string;
  image?: string;
}

export async function saveChatMessage(message: ChatMessage) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('chat_history')
    .insert({
      user_id: userId,
      task_id: message.task_id,
      role: message.role,
      text: message.text,
      image: message.image
    })
    .select()
    .single();
  
  if (error) {
    console.error('Error saving chat message:', error);
    throw error;
  }
  return data as ChatMessage;
}

export async function saveChatMessages(messages: ChatMessage[]) {
  const userId = await getAuthUserId();

  const records = messages.map(msg => ({
    user_id: userId,
    task_id: msg.task_id,
    role: msg.role,
    text: msg.text,
    image: msg.image
  }));

  const { data, error } = await supabase
    .from('chat_history')
    .insert(records)
    .select();
  
  if (error) {
    console.error('Error saving chat messages:', error);
    throw error;
  }
  return data as ChatMessage[];
}

export async function getChatHistory(taskId: string) {
  const userId = await getAuthUserId();

  const { data, error } = await supabase
    .from('chat_history')
    .select('*')
    .eq('task_id', taskId)
    .eq('user_id', userId)
    .order('created_at', { ascending: true });
  
  if (error) {
    console.error('Error fetching chat history:', error);
    throw error;
  }
  return data as ChatMessage[];
}

export async function deleteChatHistory(taskId: string) {
  const userId = await getAuthUserId();

  const { error } = await supabase
    .from('chat_history')
    .delete()
    .eq('task_id', taskId)
    .eq('user_id', userId);
  
  if (error) {
    console.error('Error deleting chat history:', error);
    throw error;
  }
}
