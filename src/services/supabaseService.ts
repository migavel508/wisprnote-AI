import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

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
  const { data, error } = await supabase
    .from('task_history')
    .insert([task])
    .select();
  
  if (error) {
    console.error('Error saving task:', error);
    throw error;
  }
  return data[0];
}

export async function getTasks() {
  const { data, error } = await supabase
    .from('task_history')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching tasks:', error);
    throw error;
  }
  return data as TaskHistory[];
}

export async function saveAsset(asset: GeneratedAsset) {
  const { data, error } = await supabase
    .from('generated_assets')
    .insert([asset])
    .select();
  
  if (error) {
    console.error('Error saving asset:', error);
    throw error;
  }
  return data[0];
}

export async function getAssets(taskId: string) {
  const { data, error } = await supabase
    .from('generated_assets')
    .select('*')
    .eq('task_id', taskId)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching assets:', error);
    throw error;
  }
  return data as GeneratedAsset[];
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
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('User not authenticated');

  // Upsert: insert or update if task_id already exists
  const { data, error } = await supabase
    .from('knowledge_graph')
    .upsert(
      {
        user_id: user.id,
        task_id: entry.task_id,
        meeting_title: entry.meeting_title,
        topics: entry.topics,
        decisions: entry.decisions,
        people: entry.people,
        action_items: entry.action_items,
        refs: entry.refs
      },
      { onConflict: 'task_id' }
    )
    .select();
  
  if (error) {
    console.error('Error saving knowledge graph:', error);
    throw error;
  }
  return data?.[0];
}

export async function saveKnowledgeGraphBatch(entries: KnowledgeGraphEntry[]) {
  // Get current user
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) throw new Error('User not authenticated');

  // Upsert multiple entries at once
  const records = entries.map(entry => ({
    user_id: user.id,
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
    .upsert(records, { onConflict: 'task_id' })
    .select();
  
  if (error) {
    console.error('Error saving knowledge graph batch:', error);
    throw error;
  }
  return data as KnowledgeGraphEntry[];
}

export async function getKnowledgeGraph() {
  const { data, error } = await supabase
    .from('knowledge_graph')
    .select('*')
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching knowledge graph:', error);
    throw error;
  }
  return data as KnowledgeGraphEntry[];
}

export async function getKnowledgeGraphForTask(taskId: string) {
  const { data, error } = await supabase
    .from('knowledge_graph')
    .select('*')
    .eq('task_id', taskId)
    .single();
  
  if (error && error.code !== 'PGRST116') { // PGRST116 = no rows found
    console.error('Error fetching knowledge graph for task:', error);
    throw error;
  }
  return data as KnowledgeGraphEntry | null;
}

export async function deleteKnowledgeGraph(taskId: string) {
  const { error } = await supabase
    .from('knowledge_graph')
    .delete()
    .eq('task_id', taskId);
  
  if (error) {
    console.error('Error deleting knowledge graph:', error);
    throw error;
  }
}
