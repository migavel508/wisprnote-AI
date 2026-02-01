
export type NoteStatus = 'TO_DO' | 'IN_PROGRESS' | 'DONE';
export type Priority = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type NoteCategory = 'Work' | 'Personal' | 'Creative' | 'Idea' | 'Other';

export interface Todo {
  id: string;
  text: string;
  completed: boolean;
  priority?: Priority;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export interface GroundingSource {
  title: string;
  uri: string;
}

export interface Note {
  id: string;
  title: string;
  content: string;
  createdAt: number;
  updatedAt: number;
  imageUrl?: string;
  transcription?: string;
  tags: string[];
  todos: Todo[];
  chatHistory: ChatMessage[];
  category: NoteCategory;
  vibeColor: string;
  status: NoteStatus;
  priority: Priority;
  storyPoints?: number;
  epic?: string;
  factCheck?: {
    summary: string;
    sources: GroundingSource[];
  };
}

export interface VoiceAgent {
  id: string;
  name: string;
  rules: string;
  icon: string;
  color: string;
  linkedNoteIds: string[];
  lastUsed: number;
}

export enum AppView {
  LIST = 'LIST',
  BOARD = 'BOARD',
  EDITOR = 'EDITOR',
  IMAGE_EDIT = 'IMAGE_EDIT',
  VOICE_LIVE = 'VOICE_LIVE',
  AGENTS = 'AGENTS',
  AGENT_BUILDER = 'AGENT_BUILDER'
}
