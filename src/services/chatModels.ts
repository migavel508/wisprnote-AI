/**
 * Chat model registry + runtime selection.
 *
 * The chat composer's model picker writes the chosen model here; the chat
 * services (geminiService.chatWithNotes / agentChatAllMeetings) read it to route
 * the FINAL answer generation to the selected provider.
 *
 * Routing model:
 *   - "Auto" and Gemini models  → Gemini (fast; also drives agentic retrieval).
 *   - Claude models             → Anthropic Messages API, proxied through the
 *                                 authed Lambda (`/ai/proxy` → api.anthropic.com),
 *                                 which injects the Anthropic key server-side. The
 *                                 key NEVER ships in the client bundle.
 *
 * For the all-meetings agentic chat, Gemini always runs the tool-calling
 * retrieval loop (it's the search engine); the selected Claude model only
 * AUTHORS the final answer from the retrieved evidence. This keeps retrieval
 * fast while letting the user pick the model that writes the response.
 */

export type ChatModelProvider = 'gemini' | 'anthropic';
export type ChatModelGroup = 'auto' | 'standard' | 'thinking';

export interface ChatModelDef {
  /** Stable UI id, persisted to localStorage. */
  id: string;
  /** Display label shown in the picker + composer chip. */
  label: string;
  provider: ChatModelProvider;
  /** Real provider model string (empty for "Auto" → Gemini default path). */
  providerModel: string;
  group: ChatModelGroup;
  /** Anthropic adaptive thinking (deeper reasoning). */
  thinking?: boolean;
  /** Optional badge, e.g. "NEW". */
  badge?: string;
  /**
   * Whether the model can actually be selected. Models whose provider key is
   * not configured server-side (e.g. OpenAI GPT) are shown locked/greyed.
   */
  available: boolean;
}

export const CHAT_MODELS: ChatModelDef[] = [
  { id: 'auto', label: 'Auto', provider: 'gemini', providerModel: '', group: 'auto', available: true },

  // ── Standard models ──────────────────────────────────────────────────────
  { id: 'sonnet-4-6', label: 'Sonnet 4.6', provider: 'anthropic', providerModel: 'claude-sonnet-4-6', group: 'standard', available: true },
  { id: 'gpt-5-4', label: 'GPT-5.4', provider: 'anthropic', providerModel: '', group: 'standard', available: false },
  { id: 'gpt-5-5', label: 'GPT-5.5', provider: 'anthropic', providerModel: '', group: 'standard', available: false },

  // ── Thinking models ──────────────────────────────────────────────────────
  { id: 'sonnet-4-6-thinking', label: 'Sonnet 4.6 Thinking', provider: 'anthropic', providerModel: 'claude-sonnet-4-6', group: 'thinking', thinking: true, available: true },
  { id: 'opus-4-8', label: 'Opus 4.8', provider: 'anthropic', providerModel: 'claude-opus-4-8', group: 'thinking', thinking: true, badge: 'NEW', available: true },
  { id: 'gpt-5-4-thinking', label: 'GPT-5.4 Thinking', provider: 'anthropic', providerModel: '', group: 'thinking', thinking: true, available: false },
  { id: 'gpt-5-5-thinking', label: 'GPT-5.5 Thinking', provider: 'anthropic', providerModel: '', group: 'thinking', thinking: true, available: false },
  { id: 'gemini-3-1-pro', label: 'Gemini 3.1 Pro', provider: 'gemini', providerModel: 'gemini-3.1-pro-preview', group: 'thinking', available: true },
];

const STORAGE_KEY = 'wisprnote.chatModelId';
const DEFAULT_ID = 'auto';

let current: string = (() => {
  try {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (saved && CHAT_MODELS.some(m => m.id === saved && m.available)) return saved;
  } catch { /* localStorage unavailable */ }
  return DEFAULT_ID;
})();

export function getChatModelId(): string {
  return current;
}

export function setChatModelId(id: string): void {
  const def = CHAT_MODELS.find(m => m.id === id);
  if (!def || !def.available) return;
  current = id;
  try { localStorage.setItem(STORAGE_KEY, id); } catch { /* ignore */ }
}

export function getChatModel(): ChatModelDef {
  return CHAT_MODELS.find(m => m.id === current) ?? CHAT_MODELS[0];
}
