import { createClient } from '@supabase/supabase-js';

const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || '';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || '';

export const supabase = createClient(supabaseUrl, supabaseAnonKey);

export interface TaskHistory {
  id?: string;
  created_at?: string;
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
  task_id: string;
  type: 'ppt' | 'report' | 'email' | 'wiki';
  filename: string;
  content: any; // JSON structure for slides or report sections
}

export async function saveTask(task: TaskHistory) {
  // Omit prompt from insert as it's not in the provided SQL schema
  const { prompt, ...insertData } = task;
  
  const { data, error } = await supabase
    .from('task_history')
    .insert([insertData])
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
