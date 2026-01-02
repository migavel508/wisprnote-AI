
export interface Todo {
  id: string;
  text: string;
  completed: boolean;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
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
}

export enum AppView {
  LIST = 'LIST',
  EDITOR = 'EDITOR',
  IMAGE_EDIT = 'IMAGE_EDIT',
  VOICE_LIVE = 'VOICE_LIVE'
}
