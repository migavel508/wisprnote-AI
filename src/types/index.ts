export interface TaskHistory {
  id: string;
  created_at: string;
  filename: string;
  transcription: string;
  summary: string | null;
  notes: string | null;
  audio_url: string | null;
  status: 'completed' | 'error';
  duration: number;
}
