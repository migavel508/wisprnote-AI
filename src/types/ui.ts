export type TabType = 'transcription' | 'summary' | 'notes';

export interface TabOption {
  id: TabType;
  label: string;
}

export const TABS: TabOption[] = [
  { id: 'transcription', label: 'Transcription' },
  { id: 'summary', label: 'Summary' },
  { id: 'notes', label: 'Notes' }
];
