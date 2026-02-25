import { supabase } from '../lib/supabase';
import { TaskHistory } from '../types';

export async function uploadAudioFile(file: File): Promise<string | null> {
  const fileExt = file.name.split('.').pop();
  const fileName = `${Date.now()}_${Math.random().toString(36).substring(2, 9)}.${fileExt}`;
  const filePath = `${fileName}`;

  const { error: uploadError } = await supabase.storage
    .from('audio_files')
    .upload(filePath, file);

  if (uploadError) {
    console.error('Error uploading audio file:', uploadError);
    return null;
  }

  const { data } = supabase.storage
    .from('audio_files')
    .getPublicUrl(filePath);

  return data.publicUrl;
}

export async function saveTaskHistory(task: Omit<TaskHistory, 'id' | 'created_at'>): Promise<TaskHistory> {
  const { data, error } = await supabase
    .from('task_history')
    .insert([task])
    .select()
    .single();

  if (error) {
    console.error('Error saving task history:', error);
    throw error;
  }

  return data;
}

export async function getTaskHistory(): Promise<TaskHistory[]> {
  const { data, error } = await supabase
    .from('task_history')
    .select('*')
    .order('created_at', { ascending: false });

  if (error) {
    console.error('Error fetching task history:', error);
    throw error;
  }

  return data || [];
}
