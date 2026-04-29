import { chatWithNotes, type ChatTaskData } from './geminiService';

const MAX_MESSAGES_PER_SESSION = 20;

interface SharedChatSession {
  history: { role: 'user' | 'model'; parts: { text: string }[] }[];
  messageCount: number;
}

const sessions = new Map<string, SharedChatSession>();

function getSession(shareToken: string): SharedChatSession {
  if (!sessions.has(shareToken)) {
    sessions.set(shareToken, { history: [], messageCount: 0 });
  }
  return sessions.get(shareToken)!;
}

export interface SharedChatMessage {
  role: 'user' | 'model';
  text: string;
}

export async function sendSharedChatMessage(
  shareToken: string,
  message: string,
  meetingData: { notes: string | null; summary: string | null; filename: string },
): Promise<{ reply: string; remaining: number }> {
  const session = getSession(shareToken);

  if (session.messageCount >= MAX_MESSAGES_PER_SESSION) {
    throw new Error('RATE_LIMITED');
  }

  const taskData: ChatTaskData = {
    transcription: '',
    notes: meetingData.notes || undefined,
    summary: meetingData.summary || undefined,
    title: meetingData.filename,
  };

  const reply = await chatWithNotes(taskData, message, session.history, false);

  session.history.push(
    { role: 'user', parts: [{ text: message }] },
    { role: 'model', parts: [{ text: reply }] },
  );
  session.messageCount++;

  return {
    reply,
    remaining: MAX_MESSAGES_PER_SESSION - session.messageCount,
  };
}

export function getSharedChatHistory(shareToken: string): SharedChatMessage[] {
  const session = sessions.get(shareToken);
  if (!session) return [];
  return session.history.map(h => ({
    role: h.role,
    text: h.parts.map(p => p.text).join(''),
  }));
}

export function getRemainingMessages(shareToken: string): number {
  const session = sessions.get(shareToken);
  return MAX_MESSAGES_PER_SESSION - (session?.messageCount ?? 0);
}
