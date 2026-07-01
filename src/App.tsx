import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Routes, Route, useNavigate, useLocation, useParams } from 'react-router-dom';
import { 
  Upload, 
  FileAudio, 
  CheckCircle2, 
  Loader2, 
  AlertCircle, 
  ChevronRight,
  ChevronLeft,
  Play,
  Layers,
  FileText,
  History,
  BookOpen,
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  Send,
  Image as ImageIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Download,
  Users,
  Mail,
  Share2,
  Circle,
  X,
  Mic,
  StopCircle,
  PauseCircle,
  PlayCircle,
  House,
  PenLine,
} from 'lucide-react';
import ChatIcon from './components/ChatIcon';
import MeetingsIcon from './components/MeetingsIcon';
import GraphSparkleIcon from './components/GraphSparkleIcon';
import SpacesPage from './pages/SpacesPage';
import DictionaryPage from './pages/DictionaryPage';
import { loadDictionary, dictionaryKeyterms, dictionaryCorrections, dictionaryContext } from './services/dictionaryService';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ForceGraph2D from 'react-force-graph-2d';
import {
  processAudioBatch,
  generateSummary,
  generateNotes,
  chatWithNotes,
  chatWithLiveTranscript,
  agentChatAllMeetings,
  extractAcrossMeetings,
  generateConceptImage,
  generateEmailContent,
  generateWikiContent,
  extractKnowledgeGraph,
  generateMeetingTitle,
  uploadAudioToFileAPI,
  waitForFileActive,
  deleteFromFileAPI,
  transcribeViaFileAPI,
  isFileApiDisabledByFailures,
  resolveSpeakerNames,
  correctTranscriptWithDictionary,
} from './services/geminiService';
import { EXTRACT_DIRECTIVE } from './services/gemsService';
import { reconcileLeadingSpeaker, type AudioSourceKind } from './services/speakerLabeling';
import {
  retrieveForSingleMeeting,
  scoreMeetingCandidate,
  retrieveMeetingEvidence,
  formatEvidence,
  type MeetingDocument,
  type RetrievalEvidence,
} from './services/chatRetrievalService';
import {
  indexMeetingTranscription,
  backfillExistingMeetings,
  isTurbopufferConfigured,
  isAlreadyIndexed,
  embedQuery,
  queryHybrid,
} from './services/turbopufferService';
import { 
  saveTask, 
  queuePendingTask,
  flushPendingTasks,
  getPendingTaskCount,
  setPendingTaskUser,
  getTasks,
  getTasksLightweight,
  getBootstrap,
  getTaskById,
  getAllTaskIds,
  TaskHistory, 
  saveAsset,
  getAssets,
  GeneratedAsset,
  saveKnowledgeGraph,
  saveKnowledgeGraphBatch,
  getKnowledgeGraph,
  getKnowledgeGraphForTask,
  KnowledgeGraphEntry,
  saveChatMessage,
  getChatHistory,
  getChatHistoryByThread,
  getChatThreads,
  ChatMessage,
  ManualNote,
  getManualNotes,
  deleteManualNote,
  updateTaskSummary,
  updateTaskNotes,
} from './services/awsService';
import { buildMeetingCard, type KGLite } from './services/meetingEvidence';
import { cacheGet, cacheSet, cacheClearUser, type CachedHistoryPayload } from './services/appCache';
import { getContacts, type Contact } from './services/workspaceService';
import { getSession, onAuthStateChange, signOut, getUserId, type AuthSession } from './services/awsAuthService';
import { splitAudio, AudioBatch, shouldUseFileAPI, FILE_API_THRESHOLD_MB, BlobReadError } from './services/audioService';
import { 
  progressStorage, 
  generateProgressId,
  getMostRecentIncompleteProgress,
  setProgressUser,
  ProcessingProgress
} from './services/progressStorage';
import {
  checkSystemAudioAvailable,
  startSystemAudioRecording,
  stopSystemAudioRecording,
  deleteRecordingFile,
  sweepOldRecordings,
  isSystemAudioRecording,
  startRealtimeRecording,
  stopRealtimeRecording,
  pauseRealtimeRecording,
  resumeRealtimeRecording,
  isRealtimeRecording,
  listenForTranscripts,
  RecordingMode,
} from './services/nativeRecorderService';
import { getDeepgramToken, reportTranscriptionUsage } from './services/aiProxyService';
import { checkPermissions } from './services/permissionService';
import {
  listenForDeviceChanges,
  listenForDeviceRestart,
  getDefaultInput,
  getBrowserMicMediaStream,
  type DeviceChangeType,
} from './services/audioDeviceService';

import Auth from './components/Auth';
import WelcomeProfile from './components/WelcomeProfile';
import FreeLimitModal from './components/FreeLimitModal';
import {
  setDetectionPaused,
  setDetectionEnabled,
  setRecordingActive,
  setRecordingIndicator,
  emitRecordingIndicatorState,
  setMeetingPrompt,
  listenForMeetingPromptStart,
  listenForOpenChatFromIndicator,
  focusMainWindow,
} from './services/micDetectionService';
import type { Entitlements } from './services/awsService';
import ChatPage from './pages/ChatPage';
import NotesPage from './pages/NotesPage';
import HistoryPage from './pages/HistoryPage';
import { setWorkspaceSelection, getSelection as getWorkspaceSelection, useWorkspaceSelection } from './services/workspaceSelection';
import SharedMeetingPage from './pages/SharedMeetingPage';
import KnowledgePage from './pages/KnowledgePage';
import ProcessPage from './pages/ProcessPage';
import AudioDevicesPage from './pages/AudioDevicesPage';
import WorkspacePage from './pages/WorkspacePage';
import PeoplePage from './pages/PeoplePage';
import SettingsPage from './pages/SettingsPage';
import MainSidebar from './components/MainSidebar';
import { ManualNotesList } from './components/ManualNotes/ManualNotesList';
import { ManualNoteEditor } from './components/ManualNotes/ManualNoteEditor';
import { logger } from './lib/logger';
import { onVaultEvent } from './lib/vaultEvents';
import { readKGLedger, markKGExtracted, markKGExtractedBatch, clearKGLedger, reconcileKGLedger } from './lib/kgLedger';
import { clearArtifactCache } from './lib/kgArtifactCache';
import { mergePeopleWithAttendees } from './lib/peopleResolve';
import { MODELS } from './config/models';
import { clearAllEmbedCaches } from './lib/knowledgeGraph.utils';
import { loadUserLedgerState, resetUserLedgers } from './services/awsLedgerService';

const log = logger.scope('App');

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

type View = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks' | 'audio-devices' | 'shared' | 'workspace' | 'people' | 'settings' | 'spaces' | 'dictionary';
type Status = 'idle' | 'splitting' | 'processing' | 'finalizing' | 'completed' | 'error';
type NoteTab = 'transcription' | 'summary' | 'notes';

interface AgentStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
  type?: 'search-tool' | 'plan';
  searchKind?: 'notes' | 'people' | 'analyze' | 'read';
  searchQuery?: string;
  searchResults?: Array<{ meetingId: string; meetingTitle: string; score: number }>;
  planSteps?: string[];
  /** Live nested steps for a sub-agent spawn (analyze_meetings): each meeting read
   *  + the synthesis, streamed the way a Task streams its child tool calls.
   *  Non-recursive (own shape, not AgentStep) so Message stays structurally simple. */
  subSteps?: Array<{ id: string; label: string; status: 'pending' | 'running' | 'done' | 'error'; detail?: string }>;
}

/**
 * Deterministically recognize a BROAD per-meeting extraction request (list action
 * items / to-dos / commitments / a recap ACROSS meetings). These must read every
 * meeting in full, not synthesize from a partial listing — so we route them through
 * the deterministic map-reduce (visible read steps + full coverage) instead of
 * relying on the model to choose the deep path. Conservative: requires BOTH an
 * extraction-list intent AND a cross-meeting breadth signal, so single-meeting Q&A
 * ("what did we decide in my last meeting") is never mis-routed.
 */
function looksLikeBroadExtraction(text: string): boolean {
  const t = text.toLowerCase();
  const extraction =
    /\b(action items?|to-?dos?|commit(?:ment|ments|ted)?|follow[- ]?ups?|outstanding|deliverables?|recap)\b/.test(t) ||
    /\b(everything|what (?:have|did) i (?:commit|promis|agree|sign up))/.test(t);
  const breadth =
    /\b(all|every|each|across|entire|whole)\b/.test(t) ||
    /\b(my|the) meetings\b/.test(t) ||
    /\bevery meeting\b/.test(t);
  return extraction && breadth;
}

/**
 * Of the broad-extraction requests, which can be answered DIRECTLY from the
 * pre-built KG index (action_items / decisions already extracted by kgSweep) —
 * instantly, over ALL meetings, no live reading. This is the action-item /
 * commitment / to-do / decision facet the KG holds. Nuanced asks (recap, themes,
 * coaching, blind-spots) are intentionally excluded — those need the full notes,
 * so they stay on the live read-each-meeting path.
 */
function kgExtractableFacet(text: string): 'action_items' | 'decisions' | null {
  const t = text.toLowerCase();
  if (/\bdecisions?\b/.test(t) && !/\b(action items?|to-?dos?|tasks?|commit)/.test(t)) return 'decisions';
  if (/\b(action items?|to-?dos?|tasks?|commit(?:ment|ments|ted)?|follow[- ]?ups?|outstanding|deliverables?)\b/.test(t)
      || /\bwhat (?:have|did) i (?:commit|promis|agree|sign up)\b/.test(t)) return 'action_items';
  return null;
}

/**
 * Does a broad-extraction request also name an explicit TOPIC (e.g. "…about the
 * billing project", "…regarding the website")? Conservative on purpose — only an
 * explicit topic marker counts — so a pure global request ("everything I committed
 * to across all meetings") is NOT mistaken for a topical one and keeps reading by
 * KG-priority + recency. When a topic IS named, the extract route retrieves the
 * semantically-relevant meetings (turbopuffer) and deep-reads THOSE real notes.
 */
function queryMentionsTopic(text: string): boolean {
  return /\b(about|regarding|concerning|related to|involving|around the|on the topic of|to do with)\b/i.test(text)
    || /\b(?:the\s+)?[a-z0-9][\w-]+\s+project\b/i.test(text);
}

interface Message {
  role: 'user' | 'model';
  text: string;
  image?: string;
  agentStatus?: 'thinking' | 'planning' | 'executing' | 'done';
  agentPlan?: AgentStep[];
  citations?: Array<{
    meetingId: string;
    meetingTitle: string;
    chunkId: string;
    score: number;
  }>;
  retrievalMeta?: {
    scope?: 'single' | 'many';
    confidence?: number;
    selectedMeetingIds?: string[];
    tokenUsageTotal?: number;
    coveredMeetingsCount?: number;
    totalMeetingsCount?: number;
  };
}

interface BatchStatus extends AudioBatch {
  status: 'pending' | 'processing' | 'completed' | 'error';
  result?: string;
  error?: string;
}

// Shared parser: DB chat rows → Message[] (restores citations, retrieval meta,
// agent status AND the agent thought-steps). Module-level so every load path
// (initial fetch + thread switch) restores identical data — no field drops.
function parseChatMessagesShared(data: any[]): Message[] {
  return (data || []).map((msg: any) => ({
    role: msg.role,
    text: msg.text,
    image: msg.image,
    citations: msg.citations?.map((c: any) => ({
      meetingId: c.meeting_id,
      meetingTitle: c.meeting_title,
      chunkId: c.chunk_id,
      score: c.score,
    })),
    retrievalMeta: msg.retrieval_meta
      ? {
          scope: msg.retrieval_meta.scope,
          confidence: msg.retrieval_meta.confidence,
          selectedMeetingIds: msg.retrieval_meta.selected_meeting_ids,
          tokenUsageTotal: msg.retrieval_meta.token_usage_total,
          coveredMeetingsCount: msg.retrieval_meta.covered_meetings_count,
          totalMeetingsCount: msg.retrieval_meta.total_meetings_count,
        }
      : undefined,
    agentStatus: msg.agent_status,
    agentPlan: Array.isArray(msg.agent_plan)
      ? msg.agent_plan.map((s: any) => ({
          id: s.id,
          label: s.label,
          status: s.status,
          detail: s.detail,
          type: s.type,
          searchKind: s.search_kind,
          searchQuery: s.search_query,
          searchResults: Array.isArray(s.search_results)
            ? s.search_results.map((r: any) => ({ meetingId: r.meeting_id, meetingTitle: r.meeting_title, score: r.score }))
            : undefined,
          planSteps: Array.isArray(s.plan_steps) ? s.plan_steps : undefined,
        }))
      : undefined,
  }));
}

log.info('app_loaded', { timestamp: new Date().toISOString() });

type MobileView = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks' | 'audio-devices';

function MobileBottomNav({ currentView, onViewChange, status }: {
  currentView: View;
  onViewChange: (view: MobileView) => void;
  status: string;
}) {
  const tabs: { id: MobileView; label: string; icon: typeof House }[] = [
    { id: 'process', label: 'Home', icon: House },
    { id: 'notes', label: 'Notes', icon: PenLine },
    { id: 'chat', label: 'Chat', icon: ChatIcon },
    { id: 'history', label: 'History', icon: MeetingsIcon },
    { id: 'knowledge', label: 'Graph', icon: GraphSparkleIcon },
  ];

  return (
    <nav className="md:hidden flex-shrink-0 bg-app-canvas border-t border-app-border-strong px-1 pb-[env(safe-area-inset-bottom)] z-50">
      <div className="flex items-center justify-around h-14">
        {tabs.map((tab) => {
          const Icon = tab.icon;
          const isActive = currentView === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => onViewChange(tab.id)}
              className={`flex flex-col items-center justify-center gap-0.5 flex-1 py-1.5 rounded-lg transition-colors ${
                isActive
                  ? 'text-app-fg'
                  : 'text-app-fg-subtle'
              }`}
            >
              <div className="relative">
                <Icon size={20} strokeWidth={isActive ? 2 : 1.5} />
                {tab.id === 'process' && status !== 'idle' && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-amber-500 animate-pulse" />
                )}
              </div>
              <span className={`text-[10px] leading-tight ${isActive ? 'font-semibold' : 'font-medium'}`}>
                {tab.label}
              </span>
            </button>
          );
        })}
      </div>
    </nav>
  );
}

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Derive currentView from URL path
  const getCurrentView = (): View => {
    const path = location.pathname;
    if (path.startsWith('/shared/')) return 'shared';
    if (path === '/' || path === '/process') return 'process';
    if (path === '/history') return 'history';
    if (path.startsWith('/notes')) return 'notes';
    if (path.startsWith('/chat')) return 'chat';
    if (path === '/knowledge') return 'knowledge';
    if (path === '/audio-devices') return 'audio-devices';
    if (path === '/workspace') return 'workspace';
    if (path === '/people') return 'people';
    if (path.startsWith('/settings')) return 'settings';
    if (path.startsWith('/spaces')) return 'spaces';
    if (path.startsWith('/dictionary')) return 'dictionary';
    return 'process';
  };
  
  const currentView = getCurrentView();
  
  // Navigation helper that uses router
  const setCurrentView = (view: View, taskId?: string) => {
    switch (view) {
      case 'process':
        navigate('/');
        break;
      case 'history':
        navigate('/history');
        break;
      case 'notes':
        navigate(taskId ? `/notes/${taskId}` : '/notes');
        break;
      case 'chat':
        navigate(taskId ? `/chat/${taskId}` : '/chat');
        break;
      case 'knowledge':
        navigate('/knowledge');
        break;
      case 'audio-devices':
        navigate('/audio-devices');
        break;
      case 'workspace':
        navigate('/workspace');
        break;
      case 'people':
        navigate('/people');
        break;
      case 'settings':
        navigate('/settings');
        break;
      case 'spaces':
        navigate('/spaces');
        break;
      case 'dictionary':
        navigate('/dictionary');
        break;
    }
  };

  const ALL_MEETINGS_THREAD_ID = 'all-meetings';

  interface ChatThread {
    id: string;
    title: string;
    taskId: string | null;
    taskTitle?: string;
    createdAt: string;
    updatedAt: string;
    preview: string;
  }

  const [session, setSession] = useState<AuthSession | null>(null);
  // Plan entitlements (plan + meeting/batch quotas), primed from /bootstrap.
  const [entitlements, setEntitlements] = useState<Entitlements | null>(null);
  const [showLimitModal, setShowLimitModal] = useState(false);
  const [limitModalMsg, setLimitModalMsg] = useState<string | null>(null);
  // Show the post-login welcome/profile screen after an ACTIVE sign-in (not a
  // session restored on startup). Set true on the SIGNED_IN auth event.
  const [showWelcome, setShowWelcome] = useState(false);
  /** False until the first `getSession()` finishes — avoids flashing the login screen on cold start when Cognito already has tokens. */
  const [isAuthSessionResolved, setIsAuthSessionResolved] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  // Where the current `file` came from. Drives neutral-vs-channel speaker labeling
  // in batch transcription. All batch/upload sources label neutrally (Speaker N);
  // the enum is threaded so the policy stays explicit and centralised.
  const fileSourceRef = useRef<AudioSourceKind>('upload');
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<Status>('idle');
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [processingHeadline, setProcessingHeadline] = useState('Preparing your meeting intelligence…');
  const [processingSubtext, setProcessingSubtext] = useState('We will keep you posted at every step.');
  
  // Recovery state
  const [hasRecoverableProgress, setHasRecoverableProgress] = useState(false);
  const [recoverableProgress, setRecoverableProgress] = useState<ProcessingProgress | null>(null);
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false);
  const currentProgressIdRef = useRef<string | null>(null);
  
  // Network status
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);
  const [awaitingNetworkResume, setAwaitingNetworkResume] = useState(false);
  const [showReconnectingMessage, setShowReconnectingMessage] = useState(false);
  
  // Recording State
  const [inputMode, setInputMode] = useState<'upload' | 'record'>('record');
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  // True while a pause/resume/stop control op is running — used to disable the
  // pause button so rapid mashing can't kick off overlapping native operations.
  const [isControlBusy, setIsControlBusy] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);
  const realtimeBackupRecorderRef = useRef<MediaRecorder | null>(null);
  const realtimeBackupChunksRef = useRef<Blob[]>([]);
  const realtimeBackupStreamRef = useRef<MediaStream | null>(null);
  const [realtimeNetworkInterrupted, setRealtimeNetworkInterrupted] = useState(false);

  // Native Desktop Recording
  const [nativeServerAvailable, setNativeServerAvailable] = useState(false);
  const [desktopRecordingMode, setDesktopRecordingMode] = useState<RecordingMode>('batch');
  // Transcription language for realtime (Deepgram): 'en' (best accuracy, enables keyterm
  // biasing) or 'multi' (multilingual/code-switching). Persisted so it survives reloads and
  // is read by the native recorder. A ref mirrors it so the record-start closure (and the
  // ref-based tray/detection triggers) always pass the current value.
  const [transcriptionLanguage, setTranscriptionLanguageState] = useState<string>(() => {
    try { return localStorage.getItem('transcriptionLanguage') || 'en'; } catch { return 'en'; }
  });
  const transcriptionLanguageRef = useRef(transcriptionLanguage);
  const setTranscriptionLanguage = (v: string) => {
    transcriptionLanguageRef.current = v;
    setTranscriptionLanguageState(v);
    try { localStorage.setItem('transcriptionLanguage', v); } catch { /* ignore */ }
  };
  const [realtimeTranscript, setRealtimeTranscript] = useState<string[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const unlistenRef = useRef<(() => void) | null>(null);
  // Mirrors the live agent thought-process steps so it can be persisted reliably
  // (React setState updaters run async, so reading it back inline was racy and
  // dropped agent_plan from the saved message — making the steps vanish on reload).
  const liveAgentPlanRef = useRef<AgentStep[] | undefined>(undefined);
  // Session cache for the full meeting index (getAllTaskIds). Avoids re-fetching the
  // whole catalogue on every all-meetings turn; short TTL keeps it reasonably fresh.
  const allMetaCacheRef = useRef<{ data: import('./services/awsService').TaskMetadata[]; ts: number; workspaceId: string | null } | null>(null);
  // P5: resumable cursor for capped deep-extractions — lets "keep going" read the NEXT
  // batch of the ordered candidate set instead of restarting (the reference's resume).
  const extractCursorRef = useRef<{ threadId: string; instructions: string; orderedIds: string[]; covered: number } | null>(null);
  // W3: detect workspace (vault) switches to fully reload the app for the new vault.
  const activeWorkspaceSelection = useWorkspaceSelection();
  const prevWorkspaceIdRef = useRef<string | null>(null);
  const realtimeTranscriptRef = useRef<string[]>([]);
  // Mirror of the faded (not-yet-final) interim text, so stop/pause can COMMIT it instead of
  // dropping it if the user stops before Deepgram promotes it to a final.
  const interimTranscriptRef = useRef('');
  const isRealtimePausedRef = useRef(false);
  const pausedBatchSegmentsRef = useRef<File[]>([]);
  const pausedRealtimeTranscriptRef = useRef<string[]>([]);
  // Recording-control concurrency: pause/resume/stop all mutate the SAME native
  // recorder, so they must never overlap. recordingOpLockRef is a promise-chain
  // mutex every op runs through; controlBusyRef debounces rapid pause/resume
  // mashing; isStoppingRef makes stop idempotent and freezes pause/resume once a
  // stop begins; isPausedRef is the async-readable mirror of the isPaused state.
  const recordingOpLockRef = useRef<Promise<unknown>>(Promise.resolve());
  const controlBusyRef = useRef(false);
  const isStoppingRef = useRef(false);
  const isStartingRef = useRef(false);
  const isPausedRef = useRef(false);
  const realtimeEngineActiveRef = useRef(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [currentInputDevice, setCurrentInputDevice] = useState<string | null>(null);
  const [deviceRestartNotice, setDeviceRestartNotice] = useState(false);

  // Notebooks (manual notes) state
  const [activeNote, setActiveNote] = useState<ManualNote | null>(null);
  const [manualNotesList, setManualNotesList] = useState<ManualNote[]>([]);
  const [isLoadingManualNotes, setIsLoadingManualNotes] = useState(true);

  const [history, setHistory] = useState<TaskHistory[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [totalHistoryCount, setTotalHistoryCount] = useState(0);
  const historyPageRef = useRef(0);
  const HISTORY_PAGE_SIZE = 24;
  // Max WAV size per batch chunk. Batch audio is sent through the authed Lambda
  // proxy (for key security). The binding limit there is AWS LAMBDA's 6 MB
  // synchronous invocation payload — NOT API Gateway's 10 MB. The proxy receives
  // the audio base64-encoded inside a JSON body, and base64 inflates ~1.33×, so
  // the WAV must stay well under ~4.5 MB. We use 3 MB → ~4 MB base64 body,
  // comfortably under Lambda's 6 MB limit. (6 MB WAV → ~8 MB body → 413.)
  // MUST be identical at every splitAudio call site so resume / blob-eviction
  // re-split produce the same chunk boundaries.
  const BATCH_CHUNK_SIZE_MB = 3;
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [allMeetingsChatMessages, setAllMeetingsChatMessages] = useState<Message[]>([]);
  // Chat threads are scoped PER USER (keyed by user id) so one account's chat
  // history can never surface under another account on the same machine. They
  // start empty and are loaded for the signed-in user once auth resolves (see
  // the per-user load effect below). The old GLOBAL keys are purged on sign-out.
  const activeUserIdRef = useRef<string | null>(null);
  const [chatThreads, setChatThreads] = useState<ChatThread[]>([]);
  const [activeChatThreadId, setActiveChatThreadId] = useState<string | null>(null);
  useEffect(() => {
    const uid = activeUserIdRef.current;
    if (!uid) return;
    try {
      if (activeChatThreadId) localStorage.setItem(`lumina:activeChatThreadId:${uid}`, activeChatThreadId);
      else localStorage.removeItem(`lumina:activeChatThreadId:${uid}`);
    } catch {}
  }, [activeChatThreadId]);
  // Synchronous mirror of the active thread id. handleSendMessage reads/writes
  // this (not the async state) so consecutive messages reliably stay in the SAME
  // thread instead of each one racing setState and spawning a new chat.
  const activeThreadIdRef = useRef<string | null>(null);
  const setActiveThread = useCallback((id: string | null) => {
    activeThreadIdRef.current = id;
    setActiveChatThreadId(id);
  }, []);
  const [selectedTask, setSelectedTask] = useState<TaskHistory | null>(null);
  const [isLoadingTaskDetails, setIsLoadingTaskDetails] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);

  // Keep the custom-vocabulary (Dictionary) cache warm so realtime keyterms + batch
  // prompts + finalize corrections always see the latest terms. Refresh on edits.
  useEffect(() => {
    void loadDictionary();
    return onVaultEvent('dictionary:changed', () => { void loadDictionary(true); });
  }, []);

  // Pre-warm the Deepgram streaming token the moment the user is signed in, so the FIRST
  // realtime record doesn't pay a token network round-trip at click time (this was the
  // "very 1st time it's slow" latency — the token is then cached ~1h). Best-effort/silent.
  useEffect(() => {
    if (!session) return;
    void getDeepgramToken().catch(() => { /* falls back to lazy mint at record time */ });
  }, [session]);

  // Extract task ID from URL and select it immediately (full details load via effect below)
  useEffect(() => {
    const path = location.pathname;
    const match = path.match(/\/(notes|chat)\/([^/]+)/);
    if (match && history.length > 0) {
      const taskId = match[2];
      if (selectedTask?.id === taskId) return;
      const task = history.find(t => t.id === taskId);
      if (task) setSelectedTask(task);
    }
  }, [location.pathname, history]);

  // Auto-fetch full task details when a lightweight task is selected
  useEffect(() => {
    if (!selectedTask?.id || selectedTask.transcription) {
      setIsLoadingTaskDetails(false);
      return;
    }

    let cancelled = false;
    setIsLoadingTaskDetails(true);

    (async () => {
      try {
        const cached = await cacheGet<TaskHistory>(`task:${selectedTask.id}`);
        if (cached?.transcription?.trim() && !cancelled) {
          setHistory(prev => prev.map(t => t.id === cached.id ? { ...t, ...cached } : t));
          setSelectedTask(prev => prev?.id === cached.id ? { ...prev, ...cached } : prev);
          setIsLoadingTaskDetails(false);
          return;
        }

        // Retry with backoff so a stalled/slow fetch (cold start, flaky network,
        // large transcription) recovers on its own instead of leaving the
        // "Loading transcription…" spinner stuck forever.
        const MAX_ATTEMPTS = 3;
        let full: TaskHistory | null = null;
        for (let attempt = 1; attempt <= MAX_ATTEMPTS && !cancelled; attempt++) {
          try {
            full = await getTaskById(selectedTask.id!);
            break;
          } catch (err: any) {
            if (err?.status === 404) throw err; // genuinely missing — don't retry
            if (attempt === MAX_ATTEMPTS) throw err;
            log.warn('fetch_task_details_retry', { attempt, error: err instanceof Error ? err : undefined });
            await new Promise(r => setTimeout(r, 800 * attempt));
          }
        }

        if (cancelled || !full) return;
        setHistory(prev => prev.map(t => t.id === full!.id ? { ...t, ...full } : t));
        setSelectedTask(prev => prev?.id === full!.id ? { ...prev, ...full } : prev);
        if (full.id) await cacheSet(`task:${full.id}`, full);
      } catch (err) {
        log.error('fetch_task_details_failed', { error: err instanceof Error ? err : undefined });
      } finally {
        if (!cancelled) setIsLoadingTaskDetails(false);
      }
    })();

    return () => { cancelled = true; };
  }, [selectedTask?.id]);

  const [noteTab, setNoteTab] = useState<NoteTab>('transcription');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [isCompactMode, setIsCompactMode] = useState(
    typeof window !== 'undefined' && window.innerWidth < 900,
  );
  const prevWindowSizeRef = useRef<{ width: number; height: number } | null>(null);

  // Auto-enter compact mode when the OS window is narrow enough to only fit the sidebar.
  useEffect(() => {
    const update = () => setIsCompactMode(window.innerWidth < 900);
    update();
    window.addEventListener('resize', update);
    return () => window.removeEventListener('resize', update);
  }, []);

  // Track macOS fullscreen. In fullscreen the traffic lights are hidden, so the
  // space we reserve for them next to the sidebar toggle must collapse (otherwise
  // the toggle is left floating where the lights used to be instead of moving to
  // the top-left corner). macOS fullscreen enter/exit fires a window resize.
  const [isFullscreen, setIsFullscreen] = useState(false);
  useEffect(() => {
    const isTauri = typeof window !== 'undefined' && !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    (async () => {
      try {
        const { getCurrentWindow } = await import('@tauri-apps/api/window');
        const win = getCurrentWindow();
        const sync = async () => {
          try { const fs = await win.isFullscreen(); if (!cancelled) setIsFullscreen(fs); } catch { /* ignore */ }
        };
        await sync();
        unlisten = await win.onResized(() => { void sync(); });
      } catch { /* not in Tauri / API unavailable */ }
    })();
    return () => { cancelled = true; if (unlisten) unlisten(); };
  }, []);

  // macOS desktop draws native traffic-light controls over the top-left of the window
  // (tauri titleBarStyle "Overlay"), so the sidebar header must inset below them. Windows
  // (and the web build) have no such controls — their layout is left exactly as-is.
  // Seed from navigator synchronously (no first-paint flash on the common case), then confirm
  // with the AUTHORITATIVE Rust `get_os_platform` (compile-time OS) — navigator UA can't be relied on.
  const [isMacDesktop, setIsMacDesktop] = useState<boolean>(() =>
    typeof navigator !== 'undefined'
    && !!(window as any).__TAURI_INTERNALS__
    && /mac/i.test((navigator as any).userAgentData?.platform || navigator.platform || navigator.userAgent || ''),
  );
  useEffect(() => {
    if (!(window as any).__TAURI_INTERNALS__) { setIsMacDesktop(false); return; }
    let cancelled = false;
    (async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core');
        const os = await invoke<string>('get_os_platform');
        if (!cancelled) setIsMacDesktop(os === 'macos');
      } catch { /* keep the navigator-based seed */ }
    })();
    return () => { cancelled = true; };
  }, []);

  // Compact (narrow) window → default to the icon rail (closed); the user can
  // still tap the rail's toggle to float the full sidebar as an overlay.
  // Wide window → default to the full sidebar open.
  useEffect(() => {
    setIsSidebarOpen(!isCompactMode);
  }, [isCompactMode]);

  const toggleCompactMode = useCallback(async () => {
    try {
      const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
      const win = getCurrentWindow();
      if (window.innerWidth >= 520) {
        const size = await win.outerSize();
        const factor = await win.scaleFactor();
        prevWindowSizeRef.current = {
          width: Math.round(size.width / factor),
          height: Math.round(size.height / factor),
        };
        await win.setSize(new LogicalSize(560, 760));
      } else {
        const prev = prevWindowSizeRef.current ?? { width: 1400, height: 900 };
        await win.setSize(new LogicalSize(prev.width, prev.height));
      }
    } catch (err) {
      logger.error('toggleCompactMode failed', { error: err instanceof Error ? err : new Error(String(err)) });
    }
  }, []);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingAsset, setIsGeneratingAsset] = useState(false);
  const [wikiStyle, setWikiStyle] = useState<'MECE' | 'PRD'>('MECE');
  const [agentAssetHistory, setAgentAssetHistory] = useState<GeneratedAsset[]>([]);
  const [selectedAgentAsset, setSelectedAgentAsset] = useState<GeneratedAsset | null>(null);
  
  
  // Knowledge Graph State
  const [kgData, setKgData] = useState<any[]>([]);
  // People in the graph come from the transcript (which can mis-hear names). Fold
  // in each meeting's authoritative attendee mapping — correct spelling, and
  // misspelled extracted names collapse into the real attendee. See peopleResolve.
  const kgDataWithAttendees = useMemo(() => {
    const attendeesByTask = new Map<string, string[]>();
    for (const t of history) {
      if (t.id && Array.isArray(t.attendees) && t.attendees.length) attendeesByTask.set(t.id, t.attendees);
    }
    if (attendeesByTask.size === 0) return kgData;
    return kgData.map((m: any) => {
      const att = attendeesByTask.get(m.meetingId);
      if (!att) return m;
      return { ...m, attendees: att, people: mergePeopleWithAttendees(m.people, att) };
    });
  }, [kgData, history]);
  const [isLoadingKG, setIsLoadingKG] = useState(false);
  const [kgProgress, setKgProgress] = useState({ current: 0, total: 0 });
  const [isExtractingNewKG, setIsExtractingNewKG] = useState(false); // Track background extraction
  const [selectedNode, setSelectedNode] = useState<any>(null);
  const [kgBuilt, setKgBuilt] = useState(false);
  const kgContainerRef = useRef<HTMLDivElement>(null);
  const [kgDimensions, setKgDimensions] = useState({ width: 800, height: 600 });
  const graphRef = useRef<any>(null); // To control graph camera

  // Handle window resize for graph canvas using ResizeObserver
  useEffect(() => {
    if (!kgContainerRef.current) return;

    let animationFrameId: number;

    const observer = new ResizeObserver(entries => {
      // Use requestAnimationFrame to avoid "ResizeObserver loop limit exceeded" errors
      // and ensure layout is settled before reading width/height
      animationFrameId = requestAnimationFrame(() => {
        for (let entry of entries) {
          // Destructure to ensure we're copying the primitive values,
          // which avoids stale closures over the DOM element rect.
          const { width, height } = entry.contentRect;
          if (width > 0 && height > 0) {
            setKgDimensions({ width, height });
          }
        }
      });
    });

    observer.observe(kgContainerRef.current);
    
    return () => {
      observer.disconnect();
      cancelAnimationFrame(animationFrameId);
    };
  }, [currentView, kgBuilt, selectedNode]);
  
  const fileInputRef = useRef<HTMLInputElement>(null);
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (chatEndRef.current) {
      chatEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages]);

  const prevUserIdRef = useRef<string | null>(null);
  const lastChatFetchTaskIdRef = useRef<string | null>(null);
  const lastAssetsFetchTaskIdRef = useRef<string | null>(null);
  const autoSyncRanRef = useRef(false);

  const isNetworkRelatedError = (err: any): boolean => {
    if (!err) return !navigator.onLine;

    // Blob-read failures are NOT network issues — they mean the audio data
    // was evicted from memory.  Treating them as "network" errors would
    // trigger the offline-resume flow, which can never succeed because the
    // blob is gone.  Callers handle BlobReadError separately.
    if (err instanceof BlobReadError || err?.isBlobError) return false;

    const status = err.status ?? err.statusCode ?? err?.error?.code ?? err?.code ?? 0;
    const msg = String(err.message ?? err).toLowerCase();

    // Exclude WebKit blob-resource errors that masquerade as fetch failures
    if (msg.includes('webkitblobresource') || msg.includes('blob resource')) return false;

    const networkMarkers = [
      'network',
      'offline',
      'failed to fetch',
      'fetch failed',
      'timed out',
      'timeout',
      'etimedout',
      'econnreset',
      'eai_again',
      'enotfound',
      '503',
      '502',
      '504',
      // Rate-limit and quota errors are transient — treat as retryable, not fatal
      '429',
      'rate limit',
      'quota',
      'overloaded',
      'resource exhausted',
    ];
    return (
      !navigator.onLine ||
      status === 0 ||
      status === 429 ||
      status === 502 ||
      status === 503 ||
      status === 504 ||
      networkMarkers.some(marker => msg.includes(marker))
    );
  };

  // True if the user may create another meeting. Free users are capped; when
  // blocked it opens the upgrade modal and returns false. Checked BEFORE
  // recording/uploading so the user isn't surprised after the work is done.
  const requireMeetingQuota = useCallback((): boolean => {
    const e = entitlements;
    if (!e || e.unlimited) return true;
    if ((e.meetingsRemaining ?? 1) > 0) return true;
    setLimitModalMsg(null); // use the default meetings copy
    setShowLimitModal(true);
    return false;
  }, [entitlements]);

  const persistTaskWithOfflineQueue = async (task: TaskHistory): Promise<TaskHistory> => {
    try {
      const saved = await saveTask(task);
      // Keep the local quota in sync so the indicator + gate stay accurate.
      setEntitlements(prev =>
        prev && !prev.unlimited
          ? { ...prev, meetingCount: prev.meetingCount + 1, meetingsRemaining: Math.max(0, (prev.meetingsRemaining ?? 1) - 1) }
          : prev
      );
      return saved;
    } catch (err: any) {
      // 402 = free meeting limit hit (server-authoritative). Surface the upgrade
      // modal and stop — do NOT queue offline (it would just fail again).
      if (err?.status === 402) {
        setLimitModalMsg(typeof err?.message === 'string' ? err.message : null);
        setShowLimitModal(true);
        throw err;
      }
      if (!isNetworkRelatedError(err)) {
        throw err;
      }

      const pendingId = await queuePendingTask(task);
      return {
        ...task,
        id: pendingId,
        created_at: new Date().toISOString(),
      };
    }
  };

  // Wipe all user-scoped state so no data leaks between accounts
  const clearUserState = useCallback(() => {
    const uid = prevUserIdRef.current;
    if (uid) void cacheClearUser(uid);
    // Purge the known-people directory caches on sign-out so one account's
    // attendees can never surface under another account on the same machine.
    // Removes the legacy GLOBAL key (the source of the cross-account leak) plus
    // every per-user `lumina:knownPeople:<email>` key.
    try {
      localStorage.removeItem('lumina:knownPeople');
      for (let i = localStorage.length - 1; i >= 0; i--) {
        const k = localStorage.key(i);
        if (k && k.startsWith('lumina:knownPeople:')) localStorage.removeItem(k);
      }
      // Remove the legacy GLOBAL chat keys — the source of cross-account chat
      // leakage. Per-user `lumina:chatThreads:<uid>` keys are namespaced and safe.
      localStorage.removeItem('lumina:chatThreads');
      localStorage.removeItem('lumina:activeChatThreadId');
    } catch { /* non-fatal */ }
    lastChatFetchTaskIdRef.current = null;
    lastAssetsFetchTaskIdRef.current = null;
    setHistory([]);
    setSelectedTask(null);
    setKgData([]);
    setKgBuilt(false);
    setIsLoadingKG(false);
    setIsExtractingNewKG(false);
    setChatMessages([]);
    setAllMeetingsChatMessages([]);
    setChatThreads([]); // critical: never carry one account's threads into another
    setChatInput('');
    setActiveThread(null);
    setAgentAssetHistory([]);
    setSelectedAgentAsset(null);
    setFile(null);
    setStatus('idle');
    setError(null);
    setProcessingHeadline('Notes are warming up ✨');
    setProcessingSubtext('Hang tight, almost there 😄');
    setAwaitingNetworkResume(false);
    autoSyncRanRef.current = false;
    setManualNotesList([]);
    setIsLoadingManualNotes(true);
    setActiveNote(null);              // open manual note (prior user's content)
    setEntitlements(null);            // plan/usage — also closes a stale-plan race
    setSelectedNode(null);            // open KG node detail
    setKgProgress({ current: 0, total: 0 });
    setRecoverableProgress(null);     // "resume processing?" prompt held prior audio/transcript
    setHasRecoverableProgress(false);
    setShowRecoveryPrompt(false);
    currentProgressIdRef.current = null;
    setPrompt('');                    // upload prompt box
    setBatches([]);                   // prior job's per-chunk state
    setRealtimeTranscript([]);
    setInterimTranscript('');
    realtimeTranscriptRef.current = [];
    // Knowledge-graph caches are GLOBAL (keyed by content/fingerprint, not user)
    // and hold meeting-derived text/embeddings/graphs — purge on account switch.
    void clearAllEmbedCaches();
    void clearArtifactCache();
    resetUserLedgers();
  }, []);

  const upsertChatThread = useCallback((thread: ChatThread) => {
    setChatThreads(prev => {
      const idx = prev.findIndex(t => t.id === thread.id);
      const next = idx >= 0
        ? prev.map((t, i) => i === idx ? { ...t, ...thread } : t)
        : [thread, ...prev];
      const uid = activeUserIdRef.current;
      if (uid) { try { localStorage.setItem(`lumina:chatThreads:${uid}`, JSON.stringify(next)); } catch {} }
      return next;
    });
  }, []);

  // "New chat" → the chat home page (no active thread). The next message the user
  // sends starts ONE fresh thread and stays in it.
  const handleNewThread = useCallback(() => {
    setActiveThread(null);
    setChatMessages([]);
    setChatInput('');
  }, [setActiveThread]);

  const handleSwitchThread = useCallback(async (thread: ChatThread) => {
    setActiveThread(thread.id);
    const cacheKey = `chat:thread:${thread.id}`;
    // Cache-first: paint the conversation instantly, then refresh from backend.
    let painted = false;
    try {
      const cached = await cacheGet<ChatMessage[]>(cacheKey);
      if (cached?.length) { setChatMessages(parseChatMessagesShared(cached as any[])); painted = true; }
      else setChatMessages([]);
    } catch { setChatMessages([]); }
    try {
      const messages = await getChatHistoryByThread(thread.id);
      // SHARED parser → restores agent thought-steps + citations (the old inline map dropped them).
      setChatMessages(parseChatMessagesShared(messages as any[]));
      await cacheSet(cacheKey, messages);
    } catch { if (!painted) setChatMessages([]); }
  }, [setActiveThread]);

  // One-shot launch primer: a SINGLE /bootstrap request fills the caches the app
  // reads (history, workspace index, chat threads) so every surface paints
  // instantly on first navigation — instead of a cold fan-out of ~6 requests.
  const primeFromBootstrap = useCallback(async (uid: string) => {
    try {
      const bp = await getBootstrap();
      if (bp.entitlements) setEntitlements(bp.entitlements);
      await cacheSet(`tasks:${uid}`, {
        list: bp.history.data,
        hasMore: bp.history.hasMore,
        total: bp.history.total,
        pageLoaded: 0,
      });
      await cacheSet('ws-index', bp.workspaceIndex);
      const backendThreads: ChatThread[] = (bp.chatThreads || []).map((r) => ({
        id: r.thread_id,
        title: r.title || 'New chat',
        taskId: r.task_id ?? null,
        taskTitle: r.task_title || undefined,
        createdAt: r.created_at,
        updatedAt: r.updated_at,
        preview: r.preview || '',
      }));
      setChatThreads(prev => {
        const byId = new Map<string, ChatThread>();
        for (const t of backendThreads) byId.set(t.id, t);
        // Only keep prior local-only threads if they belong to THIS user (prev is
        // already per-user; the load effect resets it on account switch).
        for (const t of prev) if (!byId.has(t.id)) byId.set(t.id, t);
        const merged = Array.from(byId.values()).sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
        try { localStorage.setItem(`lumina:chatThreads:${uid}`, JSON.stringify(merged)); } catch { /* ignore */ }
        return merged;
      });
    } catch { /* non-fatal — per-feature loaders still work */ }
  }, []);

  // Point chat-thread persistence at the current user and load THEIR cached
  // threads. Runs before priming so writes are always keyed to the right user
  // and a previous account's threads are never shown. (Must run before prime.)
  useEffect(() => {
    const uid = session?.user?.id ?? null;
    activeUserIdRef.current = uid;
    // Scope per-user IndexedDB stores (offline queue, processing recovery) so
    // their records are only ever read/flushed under the account that made them.
    setPendingTaskUser(uid);
    setProgressUser(uid);
    if (!uid) { setChatThreads([]); setActiveChatThreadId(null); return; }
    try {
      const raw = localStorage.getItem(`lumina:chatThreads:${uid}`);
      setChatThreads(raw ? JSON.parse(raw) : []);
    } catch { setChatThreads([]); }
  }, [session?.user?.id]);

  useEffect(() => {
    const uid = session?.user?.id;
    if (uid) void primeFromBootstrap(uid);
  }, [session?.user?.id, primeFromBootstrap]);

  useEffect(() => {
    let cancelled = false;

    getSession()
      .then((authSession) => {
        if (cancelled) return;
        setSession(authSession);
        prevUserIdRef.current = authSession?.user?.id ?? null;
      })
      .catch(() => {
        if (cancelled) return;
        setSession(null);
      })
      .finally(() => {
        if (!cancelled) setIsAuthSessionResolved(true);
      });

    const { unsubscribe } = onAuthStateChange((event, authSession) => {
      const newUserId = authSession?.user?.id ?? null;
      const prevUserId = prevUserIdRef.current;

      if (!newUserId || (prevUserId && newUserId !== prevUserId)) {
        clearUserState();
      }

      prevUserIdRef.current = newUserId;
      setSession(authSession);
      // An active SIGNED_IN event (password or Google login) → show the welcome
      // profile screen before the app. A restored session (handled by getSession
      // above) does NOT fire this, so returning users aren't interrupted.
      if (event === 'SIGNED_IN' && authSession) {
        setShowWelcome(true);
      } else if (event === 'SIGNED_OUT') {
        setShowWelcome(false);
      }
      // Sign-in/out via Cognito callbacks can land before/without overlapping getSession; always unblock UI.
      setIsAuthSessionResolved(true);
    });

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [clearUserState]);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = async () => {
      setIsOnline(true);
      try {
        const pendingCount = await getPendingTaskCount();
        if (pendingCount > 0) {
          const syncedTasks = await flushPendingTasks();
          if (syncedTasks.length > 0) {
            await fetchHistory();
            setError(null);
          }
        }
      } catch (syncErr) {
        log.error('sync_pending_tasks_failed', { error: syncErr instanceof Error ? syncErr : undefined });
      }
      
      // If we were processing when we went offline (or hit a network failure), auto-resume
      if ((wasOffline || awaitingNetworkResume) && currentProgressIdRef.current) {
        setShowReconnectingMessage(true);
        try {
          const progress = await progressStorage.getProgress(currentProgressIdRef.current);
          if (progress && progress.completedBatches < progress.totalBatches) {
            log.info('network_reconnected_resuming');
            if (progress.stage === 'realtime-postprocess') {
              await processRealtimeTranscript(progress.transcription || '', progress);
            } else {
              await startProcessing(progress);
            }
          }
        } catch (err) {
          log.error('auto_resume_failed', { error: err instanceof Error ? err : undefined });
        } finally {
          setShowReconnectingMessage(false);
          setWasOffline(false);
          setAwaitingNetworkResume(false);
        }
      }
    };
    
    const handleOffline = () => {
      setIsOnline(false);
      if (isRecording && desktopRecordingMode === 'realtime') {
        setRealtimeNetworkInterrupted(true);
      }
      if (status === 'processing' || status === 'splitting' || status === 'finalizing') {
        setWasOffline(true);
      }
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [wasOffline, awaitingNetworkResume, status, isRecording, desktopRecordingMode]);

  // Check for recoverable progress on mount (only if not currently processing)
  useEffect(() => {
    const checkRecovery = async () => {
      try {
        await progressStorage.init();
        await progressStorage.clearOldProgress(24 * 60 * 60 * 1000);
        // Safety net: purge any orphaned recorded-audio blobs left by a crash so
        // they don't leak large files on disk.
        const orphans = await progressStorage.sweepOrphanedBlobs();
        if (orphans > 0) log.info('orphan_audio_swept', { count: orphans });
        // Also sweep orphaned native recording temp files (the on-disk WAVs).
        void sweepOldRecordings().then(n => { if (n > 0) log.info('orphan_recordings_swept', { count: n }); });
        const incomplete = await getMostRecentIncompleteProgress();
        if (incomplete && status === 'idle') {
          setRecoverableProgress(incomplete);
          setHasRecoverableProgress(true);
          setShowRecoveryPrompt(true);
        }
      } catch (err) {
        log.error('check_recovery_failed', { error: err instanceof Error ? err : undefined });
      }
    };
    if (session) {
      checkRecovery();
    }
  }, [session]);

  const fetchAgentAssets = async (taskId: string) => {
    try {
      const cached = await cacheGet<GeneratedAsset[]>(`assets:${taskId}`);
      if (cached?.length) {
        const agentCached = cached.filter((a: GeneratedAsset) => a.type === 'email' || a.type === 'wiki');
        setAgentAssetHistory(agentCached);
      }
      const data = await getAssets(taskId);
      const agentAssets = data.filter((a: GeneratedAsset) => a.type === 'email' || a.type === 'wiki');
      setAgentAssetHistory(agentAssets);
      await cacheSet(`assets:${taskId}`, data);
    } catch (err) {
      log.error('fetch_assets_failed', { error: err instanceof Error ? err : undefined });
    }
  };

  const parseChatMessages = (data: any[]): Message[] => parseChatMessagesShared(data);

  const persistChatThreadToCache = async (_taskId: string | null) => {
    try {
      const threadId = activeThreadIdRef.current;
      if (!threadId) return;
      const data = await getChatHistoryByThread(threadId);
      await cacheSet(`chat:thread:${threadId}`, data);
    } catch {
      /* non-fatal */
    }
  };

  useEffect(() => {
    if (!selectedTask?.id) {
      lastChatFetchTaskIdRef.current = null;
      lastAssetsFetchTaskIdRef.current = null;
      return;
    }
    const tid = selectedTask.id;
    if (lastChatFetchTaskIdRef.current !== tid) {
      lastChatFetchTaskIdRef.current = tid;
      // Entering a meeting → the chat starts at its HOME page (no auto-loaded
      // thread). Past chats for this meeting are reachable from the recents list;
      // typing starts ONE new thread. (No more auto-opening the last thread.)
      setActiveThread(null);
      setChatMessages([]);
    }
    if (lastAssetsFetchTaskIdRef.current !== tid) {
      lastAssetsFetchTaskIdRef.current = tid;
      void fetchAgentAssets(tid);
    }
  }, [selectedTask?.id, setActiveThread]);

  useEffect(() => {
    if (currentView === 'chat' && !selectedTask) {
      // Opening the standalone Chat → HOME page (recents + recipes), not the most
      // recent thread. Typing starts a fresh thread; tapping a recent opens it.
      setActiveThread(null);
      setChatMessages([]);
    }
  }, [currentView, selectedTask?.id, setActiveThread]);

  // Hydrate the thread index from the backend on login so chat history is
  // durable even if the client's localStorage thread list is missing/cleared
  // (the messages already live in the DB keyed by thread_id). Server threads are
  // authoritative; any local-only (not-yet-synced) threads are kept.
  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    let cancelled = false;
    getChatThreads()
      .then((rows) => {
        if (cancelled || !rows?.length) return;
        // Guard against a late response landing after an account switch.
        if (activeUserIdRef.current !== uid) return;
        const fromServer: ChatThread[] = rows.map((r) => ({
          id: r.thread_id,
          title: (r.title || 'New chat').slice(0, 80),
          taskId: r.task_id,
          taskTitle: r.task_title || undefined,
          createdAt: r.created_at,
          updatedAt: r.updated_at,
          preview: (r.preview || '').slice(0, 120),
        }));
        setChatThreads((prev) => {
          const byId = new Map<string, ChatThread>();
          for (const t of fromServer) byId.set(t.id, t);
          for (const t of prev) if (!byId.has(t.id)) byId.set(t.id, t);
          const merged = Array.from(byId.values())
            .sort((a, b) => (b.updatedAt ?? '').localeCompare(a.updatedAt ?? ''));
          try { localStorage.setItem(`lumina:chatThreads:${uid}`, JSON.stringify(merged)); } catch { /* ignore */ }
          return merged;
        });
      })
      .catch(() => { /* non-fatal — localStorage threads still work */ });
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  // Check if native system audio (Tauri) is available + permissions
  useEffect(() => {
    checkSystemAudioAvailable().then(setNativeServerAvailable);
    checkPermissions().then((status) => {
      if (status.microphone === 'authorized' && status.screen_recording === 'authorized') {
        setPermissionsGranted(true);
      }
    });
  }, []);

  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
      if (unlistenRef.current) {
        unlistenRef.current();
        unlistenRef.current = null;
      }
      if (realtimeBackupRecorderRef.current && realtimeBackupRecorderRef.current.state !== 'inactive') {
        realtimeBackupRecorderRef.current.stop();
      }
      if (realtimeBackupStreamRef.current) {
        realtimeBackupStreamRef.current.getTracks().forEach(track => track.stop());
        realtimeBackupStreamRef.current = null;
      }
    };
  }, []);

  // Refs to keep latest recording callbacks accessible from tray listener
  const startRecordingRef = useRef<() => Promise<void>>(undefined);
  const stopRecordingRef = useRef<() => Promise<void>>(undefined);
  const pauseRecordingRef = useRef<() => Promise<void>>(undefined);
  const resumeRecordingRef = useRef<() => Promise<void>>(undefined);

  // A user-provided meeting title from the "Are you in a meeting?" prompt. When
  // set, it seeds the saved meeting's title instead of the auto-generated one.
  // Consumed (and cleared) when processing computes the title.
  const pendingMeetingLabelRef = useRef<string | null>(null);
  // Forces the recording mode for a detection-triggered start, so startRecording
  // doesn't have to wait for setState to propagate (see its use site).
  const forcedRecordingModeRef = useRef<RecordingMode | null>(null);
  // The ACTUAL mode of the in-flight recording. pause/resume/stop read THIS (not
  // the `desktopRecordingMode` state, which can be stale/throttled for a
  // detection-triggered start) so they always take the correct branch.
  const activeRecordingModeRef = useRef<RecordingMode>('batch');

  // Triggered when the user accepts the meeting-detection prompt. Meetings need
  // both sides of the conversation, so prefer native system-audio (batch)
  // capture; fall back to realtime transcription when native isn't available.
  const startMeetingFromDetection = (label: string | null) => {
    pendingMeetingLabelRef.current = label;
    const mode: RecordingMode = nativeServerAvailable ? 'batch' : 'realtime';
    forcedRecordingModeRef.current = mode;
    setInputMode('record');
    setDesktopRecordingMode(mode);
    // Start immediately — the forced-mode ref means we don't need to wait a tick
    // for state to settle (which the backgrounded main window would throttle).
    void startRecordingRef.current?.();
  };

  // Latest gating values + handler for the once-registered detection listeners
  // below (avoids stale closures without re-subscribing on every render).
  const meetingDriverRef = useRef({ session, isRecording, start: startMeetingFromDetection });
  meetingDriverRef.current = { session, isRecording, start: startMeetingFromDetection };

  // Listen for tray menu actions (Record Standard / Multi-lingual / Stop)
  useEffect(() => {
    let unlistenTray: (() => void) | null = null;
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return;

    (async () => {
      const { listen } = await import('@tauri-apps/api/event');
      unlistenTray = await listen<string>('tray-record', (event) => {
        const payload = event.payload;
        if (payload === 'start-realtime') {
          setInputMode('record');
          setDesktopRecordingMode('realtime');
          // Small delay so state updates propagate before startRecording reads them
          setTimeout(() => startRecordingRef.current?.(), 100);
        } else if (payload === 'start-batch') {
          setInputMode('record');
          setDesktopRecordingMode('batch');
          setTimeout(() => startRecordingRef.current?.(), 100);
        } else if (payload === 'stop') {
          stopRecordingRef.current?.();
        } else if (payload === 'pause') {
          pauseRecordingRef.current?.();
        } else if (payload === 'resume') {
          resumeRecordingRef.current?.();
        }
      });
    })();

    return () => { unlistenTray?.(); };
  }, []);

  // Listen for audio device changes (Bluetooth/headphone connect/disconnect)
  useEffect(() => {
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return;

    let unlistenChange: (() => void) | null = null;
    let unlistenRestart: (() => void) | null = null;
    let unlistenError: (() => void) | null = null;

    (async () => {
      // Fetch initial default input device
      const device = await getDefaultInput();
      if (device) setCurrentInputDevice(device.name);

      // Listen for device changes — refresh current device info
      unlistenChange = await listenForDeviceChanges(async (changeType) => {
        log.info('audio_device_change', { changeType });
        const newDevice = await getDefaultInput();
        if (newDevice) {
          setCurrentInputDevice(newDevice.name);
          log.info('audio_device_new_default_input', { name: newDevice.name, transport: newDevice.transport_type, isHeadphone: newDevice.is_headphone });
        }
      });

      // Listen for device restart events (emitted when recording auto-restarts)
      unlistenRestart = await listenForDeviceRestart(() => {
        log.info('audio_device_recording_restart');
        setDeviceRestartNotice(true);
        setTimeout(() => setDeviceRestartNotice(false), 3000);
      });

      // Listen for fatal recording errors from the Rust backend
      const { listen } = await import('@tauri-apps/api/event');
      unlistenError = await listen<string>('recording-error', (event) => {
        log.error('recording_fatal_error', { message: event.payload });
        setError(event.payload || 'Recording failed. Please try again.');
        setIsRecording(false);
        setIsPaused(false);
        if (timerRef.current) clearInterval(timerRef.current);
        realtimeEngineActiveRef.current = false;
      });
    })();

    return () => {
      unlistenChange?.();
      unlistenRestart?.();
      unlistenError?.();
    };
  }, []);

  // Drive the floating recording indicator overlay window and pause mic
  // detection while we record (so our own capture never self-triggers a
  // prompt). Pushes live state to the indicator on every tick/pause change.
  // Heavy, main-thread-touching window/engine setup — ONLY on the recording
  // start/stop edge. Previously this whole block re-ran every second (because
  // `recordingTime` was a dep), re-issuing `show()` + `set_always_on_top` +
  // `set_visible_on_all_workspaces` on the indicator each tick — a flood of
  // main-thread NSWindow ops that fought the WebView IPC and made the main
  // window's pause/stop clicks lag. Keyed on `isRecording` only, it runs twice.
  useEffect(() => {
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return;
    if (isRecording) {
      void setRecordingActive(true); // disable App Nap → main window stays responsive
      void setDetectionPaused(true);
      void setMeetingPrompt(false);
      void setRecordingIndicator(true);
    } else {
      void setRecordingActive(false); // re-enable normal App Nap when idle
      void emitRecordingIndicatorState({ recording: false, paused: false, seconds: 0, label: null });
      void setRecordingIndicator(false);
      void setDetectionPaused(false);
    }
  }, [isRecording]);

  // Lightweight live state push to the indicator overlay — on tick / pause
  // change. This is just a Tauri event emit (no main-thread NSWindow work), so
  // it's cheap to run every second.
  useEffect(() => {
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri || !isRecording) return;
    const recent = realtimeTranscriptRef.current.slice(-5);
    const interim = interimTranscriptRef.current.trim();
    const transcript = [...recent, interim].filter(Boolean).join('\n');
    void emitRecordingIndicatorState({
      recording: true,
      paused: isPaused,
      seconds: recordingTime,
      label: pendingMeetingLabelRef.current,
      transcript,
    });
  }, [isRecording, isPaused, recordingTime, interimTranscript, realtimeTranscript]);

  // The indicator's hover panel can request "open chat" — focus the main window
  // and jump to the standalone all-meetings chat.
  useEffect(() => {
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    listenForOpenChatFromIndicator(() => {
      void focusMainWindow();
      setSelectedTask(null);
      setCurrentView('chat');
    }).then((fn) => { if (cancelled) fn(); else unlisten = fn; });
    return () => { cancelled = true; unlisten?.(); };
  }, []);

  // The meeting-detection prompt overlay is shown directly from Rust the moment
  // a meeting is detected (not throttled like a backgrounded WebView). Here we
  // only (1) toggle detection on/off with auth, and (2) handle the prompt's
  // "Yes" action by starting a recording.
  useEffect(() => {
    const isTauri = !!(window as any).__TAURI_INTERNALS__;
    if (!isTauri) return;
    let unlistenStart: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      const us = await listenForMeetingPromptStart((label) => {
        meetingDriverRef.current.start(label);
      });
      if (cancelled) us();
      else unlistenStart = us;
    })();
    return () => {
      cancelled = true;
      unlistenStart?.();
    };
  }, []);

  // Enable detection only while signed in (off on the auth screen).
  useEffect(() => {
    void setDetectionEnabled(!!session);
    return () => void setDetectionEnabled(false);
  }, [session]);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const extractDeepgramKeyterms = (rawPrompt: string): string[] => {
    if (!rawPrompt.trim()) return [];
    const delimiters = /[,\n;]/;
    const baseTerms = delimiters.test(rawPrompt)
      ? rawPrompt.split(delimiters)
      : rawPrompt.split(/\s+/);
    return baseTerms
      .map(term => term.trim())
      .filter(term => term.length >= 3)
      .slice(0, 25);
  };

  // ── Dictionary (custom vocabulary) → transcription accuracy ─────────────────
  // Merge the user's dictionary terms into the Deepgram keyterms (deduped, Deepgram caps at 50).
  // Dictionary terms go FIRST: they're the user's explicit vocabulary and must not be starved
  // out of the 50-slot cap by prompt-derived words when the dictionary is large.
  const buildKeyterms = (rawPrompt: string): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const t of [...dictionaryKeyterms(), ...extractDeepgramKeyterms(rawPrompt)]) {
      const k = t.toLowerCase();
      if (!t || seen.has(k)) continue;
      seen.add(k); out.push(t);
      if (out.length >= 50) break;
    }
    return out;
  };
  // Append the dictionary to a Gemini batch prompt so uploads spell names/terms right + apply corrections.
  const withDictionaryPrompt = (rawPrompt: string): string => {
    const terms = dictionaryKeyterms();
    const corrections = dictionaryCorrections();
    if (!terms.length && !corrections.length) return rawPrompt;
    const parts = [rawPrompt?.trim() || ''];
    if (terms.length) parts.push(`Custom vocabulary — spell these EXACTLY (names, emails, jargon): ${terms.join(', ')}.`);
    if (corrections.length) parts.push(`Corrections — wherever you hear the left form, write the right one: ${corrections.map(c => `${c.from} → ${c.to}`).join('; ')}.`);
    return parts.filter(Boolean).join('\n\n');
  };
  // Correct a NEWLY finalized transcript with the user's dictionary: exact known
  // corrections (deterministic) + fuzzy ASR mis-transcriptions of dictionary terms
  // (LLM, replace-only). Scales with the dictionary; non-fatal. Existing notes untouched.
  const applyDictionaryCorrections = async (text: string): Promise<string> => {
    const dict = dictionaryContext();
    if (!dict.terms.length && !dict.corrections.length) return text;
    try { return await correctTranscriptWithDictionary(text, dict); } catch { return text; }
  };

  const startRealtimeBackupCapture = async () => {
    try {
      const stream = await getBrowserMicMediaStream();
      const recorder = new MediaRecorder(stream);
      realtimeBackupChunksRef.current = [];
      realtimeBackupStreamRef.current = stream;
      realtimeBackupRecorderRef.current = recorder;
      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          realtimeBackupChunksRef.current.push(event.data);
        }
      };
      recorder.start(1000);
    } catch (err) {
      log.warn('realtime_backup_unavailable', { error: err instanceof Error ? err : undefined });
      realtimeBackupRecorderRef.current = null;
      realtimeBackupStreamRef.current = null;
      realtimeBackupChunksRef.current = [];
    }
  };

  const stopRealtimeBackupCapture = async (): Promise<File | null> => {
    const recorder = realtimeBackupRecorderRef.current;
    const stream = realtimeBackupStreamRef.current;
    if (!recorder) return null;

    return new Promise((resolve) => {
      recorder.onstop = () => {
        const blob = new Blob(realtimeBackupChunksRef.current, { type: 'audio/webm' });
        const backupFile = blob.size > 0
          ? new File([blob], `RealtimeBackup_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, { type: 'audio/webm' })
          : null;

        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }

        realtimeBackupRecorderRef.current = null;
        realtimeBackupStreamRef.current = null;
        realtimeBackupChunksRef.current = [];
        resolve(backupFile);
      };

      if (recorder.state !== 'inactive') {
        recorder.stop();
      } else {
        if (stream) {
          stream.getTracks().forEach(track => track.stop());
        }
        realtimeBackupRecorderRef.current = null;
        realtimeBackupStreamRef.current = null;
        realtimeBackupChunksRef.current = [];
        resolve(null);
      }
    });
  };

  const mergeAudioFilesToWav = async (segments: File[]): Promise<File> => {
    if (segments.length === 1) return segments[0];

    const audioContext = new AudioContext();
    try {
      const decodedBuffers = await Promise.all(
        segments.map(async (segment) => {
          const arrayBuffer = await segment.arrayBuffer();
          return await audioContext.decodeAudioData(arrayBuffer.slice(0));
        })
      );

      const sampleRate = decodedBuffers[0]?.sampleRate || 48000;
      const channelCount = Math.max(...decodedBuffers.map(b => b.numberOfChannels));
      const totalLength = decodedBuffers.reduce((sum, b) => sum + b.length, 0);
      const mergedBuffer = audioContext.createBuffer(channelCount, totalLength, sampleRate);

      let offset = 0;
      for (const buffer of decodedBuffers) {
        for (let channel = 0; channel < channelCount; channel++) {
          const sourceChannel = Math.min(channel, buffer.numberOfChannels - 1);
          mergedBuffer.getChannelData(channel).set(buffer.getChannelData(sourceChannel), offset);
        }
        offset += buffer.length;
      }

      const numChannels = mergedBuffer.numberOfChannels;
      const length = mergedBuffer.length * numChannels * 2 + 44;
      const wavBuffer = new ArrayBuffer(length);
      const view = new DataView(wavBuffer);

      const writeString = (offsetPos: number, str: string) => {
        for (let i = 0; i < str.length; i++) view.setUint8(offsetPos + i, str.charCodeAt(i));
      };

      writeString(0, 'RIFF');
      view.setUint32(4, 36 + mergedBuffer.length * numChannels * 2, true);
      writeString(8, 'WAVE');
      writeString(12, 'fmt ');
      view.setUint32(16, 16, true);
      view.setUint16(20, 1, true);
      view.setUint16(22, numChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, sampleRate * numChannels * 2, true);
      view.setUint16(32, numChannels * 2, true);
      view.setUint16(34, 16, true);
      writeString(36, 'data');
      view.setUint32(40, mergedBuffer.length * numChannels * 2, true);

      let writeOffset = 44;
      for (let i = 0; i < mergedBuffer.length; i++) {
        for (let channel = 0; channel < numChannels; channel++) {
          const sample = Math.max(-1, Math.min(1, mergedBuffer.getChannelData(channel)[i]));
          view.setInt16(writeOffset, sample < 0 ? sample * 0x8000 : sample * 0x7fff, true);
          writeOffset += 2;
        }
      }

      const mergedBlob = new Blob([wavBuffer], { type: 'audio/wav' });
      return new File(
        [mergedBlob],
        `MergedRecording_${new Date().toISOString().replace(/[:.]/g, '-')}.wav`,
        { type: 'audio/wav' }
      );
    } finally {
      await audioContext.close();
    }
  };

  // Commit a finalized line. If it merely EXTENDS the previous line — the normal interim→final
  // promotion, OR a stop/pause-committed interim later superseded by its fuller final — REPLACE
  // the last line instead of appending a near-duplicate. Comparison ignores the speaker label
  // prefix + trailing punctuation. This is what makes the faded text PERSIST (it becomes a line
  // and is only ever upgraded in place, never erased).
  const commitTranscriptLine = (raw: string) => {
    const trimmed = raw.trim();
    if (!trimmed) return;
    const norm = (s: string) => s.replace(/^[^:]{1,24}:\s*/, '').replace(/[\s.?!,]+$/, '').toLowerCase();
    const arr = realtimeTranscriptRef.current;
    const last = arr[arr.length - 1];
    if (last) {
      const nl = norm(last);
      const nt = norm(trimmed);
      if (nl === nt) { setInterimTranscript(''); return; }                 // exact duplicate
      if (nt.startsWith(nl) || nl.startsWith(nt)) {                        // one extends the other
        const keep = trimmed.length >= last.length ? trimmed : last;
        const next = [...arr.slice(0, -1), keep];
        realtimeTranscriptRef.current = next;
        setRealtimeTranscript(next);
        setInterimTranscript('');
        return;
      }
    }
    realtimeTranscriptRef.current = [...arr, trimmed];
    setRealtimeTranscript(prev => [...prev, trimmed]);
    setInterimTranscript('');
  };

  // Persist the current faded/interim text as a committed line so it NEVER vanishes when the
  // user pauses or stops mid-utterance. The drain's eventual final is deduped by commitTranscriptLine.
  const commitPendingInterim = () => {
    const pending = interimTranscriptRef.current.trim();
    interimTranscriptRef.current = '';
    if (pending) commitTranscriptLine(pending);
  };

  const attachRealtimeTranscriptListener = async () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const unlisten = await listenForTranscripts((text, isFinal) => {
      if (isRealtimePausedRef.current) return;
      if (isFinal) {
        interimTranscriptRef.current = '';   // a final replaced the interim
        commitTranscriptLine(text);
      } else {
        interimTranscriptRef.current = text;   // remember the faded text so stop/pause can keep it
        setInterimTranscript(text);
      }
    });
    unlistenRef.current = unlisten;
  };

  const safeStopRealtimeRecording = async (): Promise<string> => {
    try {
      const active = await isRealtimeRecording();
      if (!active) {
        realtimeEngineActiveRef.current = false;
        return '';
      }
      const result = await stopRealtimeRecording();
      realtimeEngineActiveRef.current = false;
      return result;
    } catch (err: any) {
      const message = String(err?.message ?? err).toLowerCase();
      if (message.includes('not recording') || message.includes('already stopped')) {
        realtimeEngineActiveRef.current = false;
        return '';
      }
      throw err;
    }
  };

  const startRecording = async () => {
    // Re-entrancy guard: a start can be triggered from the record button, the tray
    // menu, and the meeting-detection prompt — sometimes near-simultaneously, and the
    // optimistic UI leaves a window where React state hasn't flipped yet. Without this,
    // a second start locks the native recorder first, then every later call rejects with
    // "Already recording in realtime mode" (the repeating realtime_recording_error).
    // A synchronous ref latch is the only reliable gate across those async gaps.
    if (isStartingRef.current || realtimeEngineActiveRef.current || isRecording) {
      log.info('start_recording_ignored', { reason: 'already starting or active' });
      return;
    }
    isStartingRef.current = true;
    // Free-tier gate: block before recording if the meeting quota is exhausted.
    if (!requireMeetingQuota()) { isStartingRef.current = false; return; }
    // When started from the meeting-detection prompt the mode is forced via a
    // ref, so we don't depend on setDesktopRecordingMode having propagated yet
    // (the main window may be backgrounded and its state updates throttled).
    const activeMode: RecordingMode = forcedRecordingModeRef.current ?? desktopRecordingMode;
    forcedRecordingModeRef.current = null;
    activeRecordingModeRef.current = activeMode; // single source of truth for pause/resume/stop
    // Fresh recording → reset the control-concurrency latches from any prior session.
    isStoppingRef.current = false;
    controlBusyRef.current = false;
    isPausedRef.current = false;
    recordingOpLockRef.current = Promise.resolve();
    setIsControlBusy(false);
    if (nativeServerAvailable && activeMode === 'batch') {
      // ── Native Batch Recording (mic + system audio via Tauri) ──
      // Optimistic UI: flip to "recording" instantly; start the native capture
      // in the background and roll back if it fails.
      isRealtimePausedRef.current = false;
      pausedBatchSegmentsRef.current = [];
      pausedRealtimeTranscriptRef.current = [];
      setIsRecording(true);
      setIsPaused(false);
      setRecordingTime(0);
      setFile(null);
      setRealtimeTranscript([]);
      realtimeTranscriptRef.current = [];
      interimTranscriptRef.current = '';
      setInterimTranscript('');
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

      try {
        await startSystemAudioRecording();
      } catch (err: any) {
        log.error('native_recording_error', { error: err instanceof Error ? err : undefined });
        if (timerRef.current) clearInterval(timerRef.current);
        setIsRecording(false);
        setIsPaused(false);
        setError(err.message || 'Failed to start system audio recording.');
      }
    } else if (activeMode === 'realtime') {
      // ── Real-time mode: integrated Deepgram transcription via Tauri ──
      // Optimistic UI: flip to "recording" INSTANTLY so the button feels
      // immediate; the Deepgram engine spins up in the background and we roll
      // back if it fails. (Previously the UI only updated after ~1–2s of engine
      // startup, which is what made Record feel slow / unresponsive.)
      isRealtimePausedRef.current = false;
      setRealtimeNetworkInterrupted(false);
      pausedBatchSegmentsRef.current = [];
      pausedRealtimeTranscriptRef.current = [];
      setRealtimeTranscript([]);
      realtimeTranscriptRef.current = [];
      interimTranscriptRef.current = '';
      setInterimTranscript('');
      setIsRecording(true);
      setIsPaused(false);
      setRecordingTime(0);
      setFile(null);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);

      // The cold first start can fail transiently (token mint, engine spin-up) or leave a
      // half-open native session — which is what produced the single "1st time" error that
      // then worked. Try twice: on the retry, clear any half-open session first so it starts
      // clean. Only surface an error to the user if BOTH attempts fail.
      let started = false;
      for (let attempt = 0; attempt < 2 && !started; attempt++) {
        try {
          if (attempt > 0) {
            try { await safeStopRealtimeRecording(); } catch { /* clear any half-open session */ }
            await new Promise((r) => setTimeout(r, 400));
          }
          // Mint a short-lived Deepgram token (cached) — the real key lives in
          // Secrets Manager, never in the client bundle.
          const apiKey = await getDeepgramToken();
          await attachRealtimeTranscriptListener();
          await startRealtimeRecording(apiKey, buildKeyterms(prompt), transcriptionLanguageRef.current);
          realtimeEngineActiveRef.current = true;
          started = true;
        } catch (err: any) {
          // Tauri invoke rejections are often plain strings/objects, not Error — capture the
          // raw reason so failures like a rejected Deepgram handshake are diagnosable.
          const reason = String(err?.message ?? err);
          if (attempt === 0) {
            log.warn('realtime_recording_retry', { reason });
            continue; // silent retry — don't scare the user on a recoverable cold start
          }
          log.error('realtime_recording_error', { error: err instanceof Error ? err : undefined, reason });
          if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
          realtimeEngineActiveRef.current = false;
          // Roll back the optimistic UI.
          if (timerRef.current) clearInterval(timerRef.current);
          setIsRecording(false);
          setIsPaused(false);
          // Surface the ACTUAL reason in the panel (not a generic message) so a persistent
          // failure (e.g. a rejected Deepgram handshake) is visible without the console.
          setError(reason && reason !== 'undefined' ? `Recording couldn't start: ${reason}` : 'Failed to start integrated real-time recording.');
        }
      }
    } else {
      // ── Browser Recording (microphone only via MediaRecorder) ──
      try {
        const stream = await getBrowserMicMediaStream();
        const mediaRecorder = new MediaRecorder(stream);
        mediaRecorderRef.current = mediaRecorder;
        audioChunksRef.current = [];

        mediaRecorder.ondataavailable = (event) => {
          if (event.data.size > 0) {
            audioChunksRef.current.push(event.data);
          }
        };

        mediaRecorder.onstop = () => {
          const audioBlob = new Blob(audioChunksRef.current, { type: 'audio/webm' });
          const audioFile = new File([audioBlob], `Recording_${new Date().toISOString().replace(/[:.]/g, '-')}.webm`, { type: 'audio/webm' });
          fileSourceRef.current = 'mic-only';
          setFile(audioFile);
          stream.getTracks().forEach(track => track.stop());
        };

        mediaRecorder.start();
        setIsRecording(true);
        setIsPaused(false);
        setRecordingTime(0);
        setFile(null);

        timerRef.current = setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);

      } catch (err) {
        log.error('microphone_access_failed', { error: err instanceof Error ? err : undefined });
        setError('Could not access microphone. Please check permissions.');
      }
    }
    // Start attempt settled (engine active, or rolled back on failure). Release the
    // latch here — held across every await above so concurrent triggers can't slip
    // through the optimistic-UI gap. Steady-state re-entry is then blocked by
    // realtimeEngineActiveRef / isRecording.
    isStartingRef.current = false;
  };

  // Serialize a recording-control operation behind any in-flight one. The lock
  // never deadlocks — the next op runs whether the previous settled or threw.
  const runRecordingOp = <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = recordingOpLockRef.current.then(fn, fn);
    recordingOpLockRef.current = run.then(() => undefined, () => undefined);
    return run as Promise<T>;
  };

  const pauseRecording = async () => {
    // Debounce mashing and freeze once a stop is underway. isPausedRef keeps the
    // "already paused" check correct even before React flushes isPaused.
    if (!isRecording || isPausedRef.current || isStoppingRef.current || controlBusyRef.current) return;
    controlBusyRef.current = true;
    setIsControlBusy(true);
    isPausedRef.current = true;
    setIsPaused(true);
    setInterimTranscript('');
    if (timerRef.current) clearInterval(timerRef.current);

    const mode = activeRecordingModeRef.current;
    try {
      await runRecordingOp(async () => {
        if (nativeServerAvailable && mode === 'batch') {
          // Checkpoint a native segment — but only if the recorder is genuinely
          // running, so a desync can't trigger a "not recording" error.
          if (await isSystemAudioRecording()) {
            const segment = await stopSystemAudioRecording();
            if (segment) pausedBatchSegmentsRef.current.push(segment);
          }
        } else if (mode === 'realtime') {
          isRealtimePausedRef.current = true;
          // Commit the faded interim so the last words before the pause are kept.
          commitPendingInterim();
          // Warm pause: release the mic but keep the Deepgram socket alive — near-instant,
          // no teardown. The continuous transcript keeps accumulating via events, so there's
          // no per-pause partial to stash. Fall back to the old stop/start emulation on a
          // binary that predates the command.
          try {
            await pauseRealtimeRecording();
          } catch (cmdErr) {
            log.warn('realtime_warm_pause_unavailable', { error: cmdErr instanceof Error ? cmdErr : undefined });
            const partialTranscript = await safeStopRealtimeRecording();
            if (partialTranscript.trim()) {
              pausedRealtimeTranscriptRef.current.push(partialTranscript.trim());
            }
          }
        } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
          mediaRecorderRef.current.pause();
        }
      });
    } catch (err: any) {
      log.error('pause_recording_error', { error: err instanceof Error ? err : undefined });
      setError(err.message || 'Failed to pause recording.');
      // Roll back paused UI — unless a stop has since taken over.
      isPausedRef.current = false;
      isRealtimePausedRef.current = false;
      setIsPaused(false);
      if (!isStoppingRef.current && isRecording) {
        timerRef.current = setInterval(() => setRecordingTime(prev => prev + 1), 1000);
      }
    } finally {
      controlBusyRef.current = false;
      setIsControlBusy(false);
    }
  };

  const resumeRecording = async () => {
    if (!isRecording || !isPausedRef.current || isStoppingRef.current || controlBusyRef.current) return;
    controlBusyRef.current = true;
    setIsControlBusy(true);
    isPausedRef.current = false;
    setIsPaused(false);

    const mode = activeRecordingModeRef.current;
    try {
      await runRecordingOp(async () => {
        if (nativeServerAvailable && mode === 'batch') {
          // Resume only if the recorder isn't somehow already running.
          if (!(await isSystemAudioRecording())) {
            await startSystemAudioRecording();
          }
        } else if (mode === 'realtime') {
          // Warm resume: rebuild only the mic capture; the socket is still open — no token
          // re-fetch, no handshake, no reconnect gap. Fall back to a full re-start on a
          // binary without the command.
          try {
            await resumeRealtimeRecording();
          } catch (cmdErr) {
            log.warn('realtime_warm_resume_unavailable', { error: cmdErr instanceof Error ? cmdErr : undefined });
            // Short-lived token from the authed backend; real key never bundled.
            const apiKey = await getDeepgramToken();
            if (!unlistenRef.current) {
              await attachRealtimeTranscriptListener();
            }
            if (!realtimeEngineActiveRef.current && !(await isRealtimeRecording())) {
              await startRealtimeRecording(apiKey, buildKeyterms(prompt));
            }
            realtimeEngineActiveRef.current = true;
          }
          isRealtimePausedRef.current = false;
        } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
          mediaRecorderRef.current.resume();
        }
      });
      // Don't restart the clock if a stop slipped in while we were resuming.
      if (!isStoppingRef.current) {
        timerRef.current = setInterval(() => setRecordingTime(prev => prev + 1), 1000);
      }
    } catch (err: any) {
      log.error('resume_recording_error', { error: err instanceof Error ? err : undefined });
      setError(err.message || 'Failed to resume recording.');
      // Roll back to paused on failure.
      isPausedRef.current = true;
      setIsPaused(true);
      if (timerRef.current) clearInterval(timerRef.current);
    } finally {
      controlBusyRef.current = false;
      setIsControlBusy(false);
    }
  };

  // The actual stop work — runs exclusively through the lock (never overlapping a
  // pause/resume). Reads the recorder's REAL state rather than the (possibly stale
  // or paused) isPaused flag, which is what makes stop reliable after rapid clicks.
  const stopRecordingImpl = async () => {
    const mode = activeRecordingModeRef.current;

    if (nativeServerAvailable && mode === 'batch' && isRecording) {
      // ── Stop Native Batch Recording (Tauri) ──
      try {
        let finalSegment: File | null = null;
        // Authoritative: ask the recorder itself instead of trusting isPaused.
        if (await isSystemAudioRecording()) {
          finalSegment = await stopSystemAudioRecording();
        }
        const allSegments = [...pausedBatchSegmentsRef.current, ...(finalSegment ? [finalSegment] : [])];
        // Each native segment is ALREADY compressed in Rust at finalize (16 kHz
        // mono + silence cut), so we just merge them — no second JS compression
        // pass needed (that would re-decode the file for no benefit).
        const audioFile = allSegments.length > 0 ? await mergeAudioFilesToWav(allSegments) : null;
        if (audioFile) {
          log.info('recording_ready', { sizeMB: +(audioFile.size / 1048576).toFixed(1) });
        }
        // The compressed copy is now in memory (and gets persisted for the
        // batch); the raw on-disk temp recordings are no longer needed → delete
        // them immediately so they don't linger on the machine.
        for (const seg of allSegments) {
          const p = (seg as any).diskPath as string | undefined;
          if (p) void deleteRecordingFile(p);
        }
        setIsRecording(false);
        setIsPaused(false);
        isPausedRef.current = false;
        pausedBatchSegmentsRef.current = [];
        if (audioFile) {
          fileSourceRef.current = 'native-batch';
          setFile(audioFile);
        } else {
          setError('No audio captured.');
        }
      } catch (err: any) {
        log.error('stop_recording_error', { error: err instanceof Error ? err : undefined });
        setError(err.message || 'Failed to stop recording.');
        setIsRecording(false);
        setIsPaused(false);
        isPausedRef.current = false;
        pausedBatchSegmentsRef.current = [];
      }
    } else if (mode === 'realtime' && isRecording) {
      // ── Stop Real-time mode: stop integrated Tauri recording ──
      const backupAudioFile = await stopRealtimeBackupCapture();
      try {
        // Persist the faded text INSTANTLY so it never vanishes when stopping mid-utterance.
        // The drain's trailing final (below) is deduped/upgraded in place by commitTranscriptLine.
        commitPendingInterim();
        isRealtimePausedRef.current = false;
        // safeStopRealtimeRecording returns '' when the engine is already stopped
        // (e.g. we were paused), so this is correct without reading isPaused.
        const fullTranscript = await safeStopRealtimeRecording();

        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        setIsRecording(false);
        setIsPaused(false);
        isPausedRef.current = false;
        const pausedTranscript = pausedRealtimeTranscriptRef.current.join(' ').trim();
        // refTranscript now includes the committed interim (commitPendingInterim above), so the
        // last words are part of the saved transcript even when stopping mid-utterance.
        const refTranscript = realtimeTranscriptRef.current.join(' ').trim();
        const transcriptToUse = [pausedTranscript, fullTranscript.trim(), refTranscript].filter(Boolean).join(' ').trim();

        // Observability: the realtime stream goes client→Deepgram directly (not
        // through the traced proxy), so report this session's audio duration to
        // Braintrust + usage metering. Best-effort, fire-and-forget.
        if (transcriptToUse) {
          void reportTranscriptionUsage({
            mode: 'realtime',
            durationSeconds: recordingTime,
            model: MODELS.deepgram.primary,
            language: 'multi',
            words: transcriptToUse.split(/\s+/).filter(Boolean).length,
          });
        }

        if (realtimeNetworkInterrupted && backupAudioFile) {
          setError('Realtime network interruption detected. Switching to local backup transcription.');
          await startProcessing(undefined, backupAudioFile);
        } else if (transcriptToUse) {
          await processRealtimeTranscript(transcriptToUse);
        } else if (backupAudioFile) {
          await startProcessing(undefined, backupAudioFile);
        } else {
          setError('No speech detected during recording.');
        }
        setRealtimeNetworkInterrupted(false);
        pausedRealtimeTranscriptRef.current = [];
        realtimeEngineActiveRef.current = false;
      } catch (err: any) {
        log.error('stop_realtime_error', { error: err instanceof Error ? err : undefined });
        isRealtimePausedRef.current = false;
        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        setIsRecording(false);
        setIsPaused(false);
        isPausedRef.current = false;
        // If network drops while stopping the realtime stream, salvage any finalized transcript.
        const fallbackTranscript = realtimeTranscriptRef.current.join(' ').trim();
        if (fallbackTranscript) {
          await processRealtimeTranscript(fallbackTranscript);
        } else if (backupAudioFile) {
          await startProcessing(undefined, backupAudioFile);
        } else {
          setError(err.message || 'Failed to stop realtime recording.');
        }
        setRealtimeNetworkInterrupted(false);
        pausedRealtimeTranscriptRef.current = [];
        realtimeEngineActiveRef.current = false;
      }
    } else if (mediaRecorderRef.current && (mediaRecorderRef.current.state === 'recording' || mediaRecorderRef.current.state === 'paused')) {
      // ── Stop Browser Recording ──
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsPaused(false);
      isPausedRef.current = false;
    }
  };

  const stopRecording = async () => {
    // Idempotent: the first stop wins; later clicks (and any queued pause/resume)
    // are ignored via isStoppingRef. The work waits behind any in-flight
    // pause/resume through the lock, so native start/stop never overlap.
    if (isStoppingRef.current) return;
    isStoppingRef.current = true;
    setIsControlBusy(true);
    if (timerRef.current) clearInterval(timerRef.current);
    try {
      await runRecordingOp(stopRecordingImpl);
    } finally {
      setIsControlBusy(false);
    }
  };

  // Keep refs in sync so the tray listener always calls the latest functions
  startRecordingRef.current = startRecording;
  stopRecordingRef.current = stopRecording;
  pauseRecordingRef.current = pauseRecording;
  resumeRecordingRef.current = resumeRecording;

  // Process real-time transcript with step checkpointing for network-safe resume.
  const processRealtimeTranscript = async (
    transcript: string,
    resumeFromProgress?: ProcessingProgress
  ) => {
    if (!transcript.trim()) return;

    // Correct this newly finalized realtime transcript with the user's dictionary (exact +
    // fuzzy ASR mis-transcriptions) before summary/notes. Existing notes are untouched.
    transcript = await applyDictionaryCorrections(transcript);

    try {
      setStatus('processing');
      setError(null);
      setAwaitingNetworkResume(false);
      setProcessingHeadline('Story mode on 🎬');
      setProcessingSubtext('Good stuff coming up 😎');

      const progressId = resumeFromProgress?.id || generateProgressId(`realtime_${Date.now()}`);
      currentProgressIdRef.current = progressId;

      const initialCheckpointBatches = resumeFromProgress?.batches || [
        { index: 0, status: 'pending' as const, startTime: 0, endTime: 0 }, // summary
        { index: 1, status: 'pending' as const, startTime: 0, endTime: 0 }, // notes
        { index: 2, status: 'pending' as const, startTime: 0, endTime: 0 }, // title
        { index: 3, status: 'pending' as const, startTime: 0, endTime: 0 }, // save task
      ];

      let summary = resumeFromProgress?.batches?.find(b => b.index === 0)?.result || '';
      let notes = resumeFromProgress?.batches?.find(b => b.index === 1)?.result || '';
      let meetingTitle = resumeFromProgress?.batches?.find(b => b.index === 2)?.result || '';
      // If the user named the meeting in the detection prompt, use that title
      // instead of auto-generating one (consume it once).
      if (!meetingTitle && pendingMeetingLabelRef.current) {
        meetingTitle = pendingMeetingLabelRef.current;
        pendingMeetingLabelRef.current = null;
      }

      const updateRealtimeCheckpoint = async (
        updatedBatches: ProcessingProgress['batches'],
        durationToStore: number
      ) => {
        const completedCount = updatedBatches.filter(b => b.status === 'completed').length;
        await progressStorage.saveProgress({
          id: progressId,
          filename: `Realtime Meeting ${new Date().toLocaleString()}`,
          prompt,
          mode: 'realtime',
          stage: 'realtime-postprocess',
          transcription: transcript,
          duration: durationToStore,
          totalBatches: 4,
          completedBatches: completedCount,
          batches: updatedBatches,
          createdAt: resumeFromProgress?.createdAt || Date.now(),
          updatedAt: Date.now(),
        });
      };

      const checkpointBatches = [...initialCheckpointBatches];
      await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);

      if (!summary) {
        setStatus('finalizing');
        setProcessingHeadline('Cooking the summary 🍳');
        setProcessingSubtext('Crispy highlights incoming 🌟');
        checkpointBatches[0] = { ...checkpointBatches[0], status: 'processing', error: undefined };
        await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);
        summary = await generateSummary(transcript);
        checkpointBatches[0] = { ...checkpointBatches[0], status: 'completed', result: summary };
        await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);
      }

      if (!notes) {
        setStatus('finalizing');
        setProcessingHeadline('Notes getting fancy 📝');
        setProcessingSubtext('Clean, sharp, and cute ✨');
        checkpointBatches[1] = { ...checkpointBatches[1], status: 'processing', error: undefined };
        await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);
        notes = await generateNotes(transcript);
        checkpointBatches[1] = { ...checkpointBatches[1], status: 'completed', result: notes };
        await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);
      }

      if (!meetingTitle) {
        setStatus('finalizing');
        setProcessingHeadline('Title hunt begins 🏷️');
        setProcessingSubtext('Finding the perfect vibe 😌');
        checkpointBatches[2] = { ...checkpointBatches[2], status: 'processing', error: undefined };
        await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);
        meetingTitle = await generateMeetingTitle(transcript);
        checkpointBatches[2] = { ...checkpointBatches[2], status: 'completed', result: meetingTitle };
        await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);
      }

      checkpointBatches[3] = { ...checkpointBatches[3], status: 'processing', error: undefined };
      setStatus('finalizing');
      setProcessingHeadline('Final sparkle pass ✨');
      setProcessingSubtext('Packing it up nicely 🎁');
      await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);

      const newTask: TaskHistory = {
        filename: meetingTitle || 'Untitled Meeting',
        transcription: transcript,
        summary,
        notes,
        prompt,
        status: 'completed',
        duration: resumeFromProgress?.duration ?? recordingTime,
        source: 'realtime', // live recording — not counted against batch hours
      };

      const savedTask = await persistTaskWithOfflineQueue(newTask);
      checkpointBatches[3] = { ...checkpointBatches[3], status: 'completed', result: savedTask.id || '' };
      await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);

      await progressStorage.deleteProgress(progressId);
      currentProgressIdRef.current = null;

      if (savedTask && savedTask.id && !savedTask.id.startsWith('pending_')) {
        setIsExtractingNewKG(true);
        extractKnowledgeGraph(savedTask.id, savedTask.filename, savedTask.transcription!)
          .then(async (result) => {
            if (!result.meetingDate && savedTask.created_at) result.meetingDate = savedTask.created_at;
            const entryToSave: KnowledgeGraphEntry = {
              task_id: result.meetingId,
              meeting_title: result.meetingTitle,
              topics: result.topics || [],
              decisions: result.decisions || [],
              people: result.people || [],
              action_items: result.actionItems || [],
              refs: result.references || [],
            };
            await saveKnowledgeGraphBatch([entryToSave]);
            setKgData(prevData => {
              if (prevData.length === 0) return prevData;
              const filtered = prevData.filter(d => d.meetingId !== result.meetingId);
              return [...filtered, result];
            });
            log.info('kg_auto_extracted_realtime');
          })
          .catch(err => log.error('kg_background_extraction_failed', { error: err instanceof Error ? err : undefined }))
          .finally(() => setIsExtractingNewKG(false));

        indexMeetingTranscription(savedTask.id, savedTask.filename, savedTask.transcription!, { createdAt: savedTask.created_at, attendees: savedTask.attendees, workspaceId: getWorkspaceSelection().workspaceId ?? undefined })
          .then(() => log.info('turbopuffer_indexing_complete_realtime'))
          .catch(err => log.warn('turbopuffer_indexing_failed', { error: err instanceof Error ? err : undefined }));
      }

      setHistory(prev => [savedTask, ...prev.filter(t => t.id !== savedTask.id)]);
      allMetaCacheRef.current = null; // freshness: a newly saved meeting must appear in the all-meetings index next turn
      setSelectedTask(savedTask);
      setProcessingHeadline('Your notes are ready 🎉');
      setProcessingSubtext(savedTask.id?.startsWith('pending_') ? 'Saved locally. Will sync when internet is back.' : 'Opening the magic now 🚀');
      setCurrentView('notes');
      setNoteTab('notes');
      setStatus('completed');
      if (savedTask.id?.startsWith('pending_')) {
        setError('Connection dropped while saving. Notes are checkpointed locally and will auto-sync once online.');
      }
    } catch (err: any) {
      if (isNetworkRelatedError(err)) {
        setAwaitingNetworkResume(true);
        setWasOffline(true);
        setStatus('processing');
        setProcessingHeadline('Oops, internet took a nap 😴');
        setProcessingSubtext('We will bounce right back 🔄');
        setError('Network issue detected. Progress is saved and will resume automatically when you reconnect.');
        return;
      }
      setError(err.message || 'Failed to process realtime transcript.');
      setStatus('error');
    }
  };


  // Load persisted knowledge graph
  const fetchKnowledgeGraph = async () => {
    try {
      const uid = await getUserId().catch(() => null);
      if (uid) await loadUserLedgerState(uid);

      const data = await getKnowledgeGraph();
      if (uid) await cacheSet(`kg:${uid}`, data ?? []);

      if (data && data.length > 0) {
        // Transform DB format to app format — validate topics to prevent blank entries
        const transformed = data.map(entry => ({
          meetingId: entry.task_id,
          meetingTitle: entry.meeting_title,
          meetingDate: entry.created_at,
          topics: (entry.topics || []).filter(
            (t: any) => t && t.name && t.name.trim().length > 0
          ),
          decisions: (entry.decisions || []).filter(
            (d: any) => d && d.decision && d.decision.trim().length > 0
          ),
          people: (entry.people || []).filter(
            (p: any) => typeof p === 'string' && p.trim().length > 0
          ),
          actionItems: (entry.action_items || []).filter(
            (a: any) => a && a.task && a.task.trim().length > 0
          ),
          references: entry.refs || []
        }));
        setKgData(transformed);
        setKgBuilt(true);

        // Only mark meetings as "extracted" if they have meaningful data (valid topics).
        // Meetings with corrupt/empty topics should NOT be ledger-marked so they get re-extracted.
        const validIds: string[] = [];
        const corruptIds: string[] = [];
        for (const entry of data) {
          const hasValidTopics = (entry.topics || []).some(
            (t: any) => t && t.name && t.name.trim().length > 0
          );
          const hasAnyData = hasValidTopics ||
            (entry.decisions || []).some((d: any) => d?.decision?.trim()) ||
            (entry.people || []).length > 0 ||
            (entry.action_items || []).some((a: any) => a?.task?.trim());
          if (hasAnyData) {
            validIds.push(entry.task_id);
          } else {
            corruptIds.push(entry.task_id);
          }
        }
        markKGExtractedBatch(validIds);
        reconcileKGLedger(new Set(validIds));
        if (corruptIds.length > 0) {
          log.info('kg_corrupt_entries_detected', { count: corruptIds.length, ids: corruptIds.join(', ') });
        }
      }
    } catch (err) {
      log.error('fetch_knowledge_graph_failed', { error: err instanceof Error ? err : undefined });
    }
  };

  // Auto-sync Knowledge Graph: check if any meetings in history are missing from KG.
  // Uses a ref snapshot of kgData (not a dependency) to avoid re-triggering when
  // setKgData is called inside, and a session-level guard so it runs at most once.
  const kgDataRef = useRef(kgData);
  kgDataRef.current = kgData;

  useEffect(() => {
    if (history.length > 0 && kgBuilt && !isExtractingNewKG && !autoSyncRanRef.current) {
      const syncMissingMeetingsToKG = async () => {
        const ledger = readKGLedger();
        const currentKgData = kgDataRef.current;
        const kgTaskIds = new Set(currentKgData.map(kg => kg.meetingId));

        // Detect meetings already in KG but with corrupt/empty topics — need re-extraction
        const corruptKgIds = new Set(
          currentKgData
            .filter(kg => {
              const hasValidTopics = (kg.topics || []).some(
                (t: any) => t && t.name && t.name.trim().length > 0
              );
              const hasAnyMeaningfulData = hasValidTopics ||
                (kg.decisions || []).some((d: any) => d?.decision?.trim()) ||
                (kg.actionItems || []).some((a: any) => a?.task?.trim());
              return !hasAnyMeaningfulData;
            })
            .map(kg => kg.meetingId)
        );

        // Use lightweight metadata to find candidates, fetch full list for completeness
        let allMeta: TaskHistory[];
        try {
          const metaResult = await getAllTaskIds();
          allMeta = metaResult as TaskHistory[];
        } catch {
          allMeta = history;
        }

        const missingMeta = allMeta.filter(task =>
          task.id &&
          task.status === 'completed' &&
          (
            // Truly missing from KG
            (!kgTaskIds.has(task.id) && !ledger.has(task.id)) ||
            // In KG but with corrupt/empty data — needs re-extraction
            corruptKgIds.has(task.id)
          )
        );
        
        if (missingMeta.length === 0) return;
        
        autoSyncRanRef.current = true;
        log.info('kg_auto_sync_started', { missingCount: missingMeta.length, ledgerSize: ledger.size });
        setIsExtractingNewKG(true);
        
        try {
          for (let i = 0; i < missingMeta.length; i++) {
            const meta = missingMeta[i];
            
            try {
              // Fetch full task with transcription on demand
              const fullTask = meta.transcription ? meta : await getTaskById(meta.id!);
              if (!fullTask?.transcription?.trim()) continue;

              log.info('kg_auto_extracting', { filename: fullTask.filename });
              const result = await extractKnowledgeGraph(fullTask.id!, fullTask.filename, fullTask.transcription!);
              
              const entryToSave: KnowledgeGraphEntry = {
                task_id: result.meetingId,
                meeting_title: result.meetingTitle,
                topics: result.topics || [],
                decisions: result.decisions || [],
                people: result.people || [],
                action_items: result.actionItems || [],
                refs: result.references || []
              };
              
              // Only save if extraction produced meaningful data
              const hasExtractedData = (result.topics?.length > 0) || (result.decisions?.length > 0) || (result.people?.length > 0) || (result.actionItems?.length > 0);
              if (hasExtractedData) {
                await saveKnowledgeGraphBatch([entryToSave]);
                markKGExtracted(fullTask.id!);
              }
              if (!result.meetingDate && fullTask.created_at) result.meetingDate = fullTask.created_at;
              // Replace existing corrupt entry or append new
              setKgData(prevData => {
                const filtered = prevData.filter(d => d.meetingId !== result.meetingId);
                return [...filtered, result];
              });
              
              if (i < missingMeta.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            } catch (err) {
              log.error('kg_auto_extract_failed', { filename: meta.filename, error: err instanceof Error ? err : undefined });
            }
          }
        } finally {
          setIsExtractingNewKG(false);
        }
      };
      
      syncMissingMeetingsToKG();
    }
  }, [history, kgBuilt, isExtractingNewKG]);

  const buildKnowledgeGraph = async () => {
    if (history.length === 0 || isLoadingKG) return;
    setIsLoadingKG(true);
    setSelectedNode(null);

    // ── Force-clear all caches so we get a genuinely fresh rebuild ────────────
    clearKGLedger();
    await Promise.all([clearArtifactCache(), clearAllEmbedCaches()]);
    log.info('kg_rebuild_caches_cleared');

    // ── Shared rate limiter + concurrent worker pool ─────────────────────────
    const CONCURRENCY = 3;
    const SLOT_MS = 4200;
    let nextSlotAt = 0;
    const rateLimit = async () => {
      const wait = nextSlotAt - Date.now();
      if (wait > 0) await new Promise(r => setTimeout(r, wait));
      nextSlotAt = Date.now() + SLOT_MS;
    };

    // ── Determine which meetings still need extraction ────────────────────────
    // Load the latest snapshot from Supabase so a partial previous run is reused.
    let latestKgData = kgData;
    try {
      const fresh = await getKnowledgeGraph();
      if (fresh && fresh.length > 0) {
        latestKgData = fresh.map(entry => ({
          meetingId: entry.task_id,
          meetingTitle: entry.meeting_title,
          meetingDate: entry.created_at,
          topics: entry.topics || [],
          decisions: entry.decisions || [],
          people: entry.people || [],
          actionItems: entry.action_items || [],
          references: entry.refs || [],
        }));
      }
    } catch {
      // proceed with in-memory snapshot
    }

    const processedIds = new Set(latestKgData.map((k: any) => k.meetingId));
    // Use full task list from server for KG build (lightweight metadata is enough to identify candidates)
    let allCompleted: TaskHistory[];
    try {
      const allMeta = await getAllTaskIds();
      allCompleted = (allMeta as TaskHistory[]).filter(t => t.id && t.status === 'completed');
    } catch {
      allCompleted = history.filter(t => t.id && t.status === 'completed');
    }

    // Meetings not yet in the KG go first; already-processed ones are reused as-is
    const toExtract = allCompleted.filter(t => !processedIds.has(t.id!));
    const alreadyDone = allCompleted
      .filter(t => processedIds.has(t.id!))
      .map(t => latestKgData.find((k: any) => k.meetingId === t.id)!);

    // Re-populate ledger with meetings already persisted in Supabase
    if (alreadyDone.length > 0) {
      markKGExtractedBatch(alreadyDone.map(m => m.meetingId));
    }

    // Seed UI immediately with what we already have so the graph stays visible
    const accumulated = [...alreadyDone];
    setKgData([...accumulated]);
    setKgBuilt(alreadyDone.length > 0);
    setKgProgress({ current: 0, total: toExtract.length });

    log.info('kg_rebuild_started', { cached: alreadyDone.length, toExtract: toExtract.length });

    // Work-stealing queue: workers grab the next index atomically (safe in JS)
    let qi = 0;
    let doneCount = 0;

    const runWorker = async () => {
      while (qi < toExtract.length) {
        const i = qi++; // atomic in single-threaded JS
        if (i >= toExtract.length) break;

        const task = toExtract[i];
        // Fetch full transcription on demand if not already present
        let transcription = task.transcription;
        if (!transcription?.trim() && task.id) {
          try {
            const fullTask = await getTaskById(task.id);
            transcription = fullTask?.transcription;
          } catch { /* proceed without */ }
        }
        const hasTranscription = !!(transcription && transcription.trim().length > 0);

        let result: any;
        if (hasTranscription) {
          await rateLimit();
          try {
            result = await extractKnowledgeGraph(task.id!, task.filename, transcription!);
          } catch (err) {
            log.error('kg_extraction_failed', { filename: task.filename, error: err instanceof Error ? err : undefined });
            result = { meetingId: task.id!, meetingTitle: task.filename, meetingDate: task.created_at, topics: [], decisions: [], people: [], actionItems: [], references: [] };
          }
        } else {
          result = { meetingId: task.id!, meetingTitle: task.filename, meetingDate: task.created_at, topics: [], decisions: [], people: [], actionItems: [], references: [] };
        }

        // Attach the task creation date so sorting works immediately
        if (!result.meetingDate && task.created_at) {
          result.meetingDate = task.created_at;
        }

        // Only persist if extraction produced meaningful data — skip empty entries so they can be re-tried later
        const hasData = (result.topics?.length > 0) || (result.decisions?.length > 0) || (result.people?.length > 0) || (result.actionItems?.length > 0);
        if (hasData) {
          try {
            await saveKnowledgeGraph({
              task_id: result.meetingId,
              meeting_title: result.meetingTitle,
              topics: result.topics || [],
              decisions: result.decisions || [],
              people: result.people || [],
              action_items: result.actionItems || [],
              refs: result.references || [],
            });
            markKGExtracted(task.id!);
          } catch (saveErr) {
            log.error('kg_checkpoint_save_failed', { filename: task.filename, error: saveErr instanceof Error ? saveErr : undefined });
          }
        } else {
          log.warn('kg_extraction_empty', { filename: task.filename, meetingId: task.id });
        }

        accumulated.push(result);
        setKgData([...accumulated]);
        setKgBuilt(true);
        setKgProgress({ current: ++doneCount, total: toExtract.length });
      }
    };

    try {
      // Launch up to CONCURRENCY workers; they race to drain the queue
      await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, toExtract.length || 1) }, runWorker)
      );
    } finally {
      // Reset kgBuilt momentarily so KnowledgePage re-triggers the embedding pipeline
      // on the complete dataset (not needed if nothing new was extracted)
      if (toExtract.length > 0) {
        setKgBuilt(false);
        setKgData([...accumulated]);
        requestAnimationFrame(() => {
          setKgBuilt(true);
        });
      }
      setIsLoadingKG(false);
      setKgProgress({ current: 0, total: 0 });
    }
  };

  // Fuzzy string similarity using Jaccard index on word sets
  const calculateSimilarity = (str1: string, str2: string): number => {
    const normalize = (s: string) => s.toLowerCase().replace(/[^a-z0-9\s]/g, '').split(/\s+/).filter(w => w.length > 2);
    const words1 = new Set(normalize(str1));
    const words2 = new Set(normalize(str2));
    if (words1.size === 0 || words2.size === 0) return 0;
    
    const intersection = new Set([...words1].filter(x => words2.has(x)));
    const union = new Set([...words1, ...words2]);
    return intersection.size / union.size;
  };

  // Find or create canonical topic ID using similarity matching
  const findCanonicalTopicId = (topicName: string | undefined | null, existingTopics: Map<string, string>): string => {
    if (!topicName || typeof topicName !== 'string') {
      return `topic_unknown_${Math.random().toString(36).substring(7)}`;
    }
    
    const normalized = topicName.toLowerCase().replace(/\s+/g, '_');
    const directId = `topic_${normalized}`;
    
    // Check for exact match first
    if (existingTopics.has(directId)) {
      return directId;
    }
    
    // Check for similar topics (threshold: 0.5 Jaccard similarity)
    for (const [existingId, existingName] of existingTopics.entries()) {
      if (calculateSimilarity(topicName, existingName) >= 0.5) {
        return existingId;
      }
    }
    
    // No match found, create new
    existingTopics.set(directId, topicName);
    return directId;
  };

  // Find related meetings for a given meeting ID based on shared topics, people, decisions
  const findRelatedMeetings = (meetingId: string) => {
    const currentMeeting = kgData.find(m => m.meetingId === meetingId);
    if (!currentMeeting) return [];

    const relatedMeetings: Array<{
      meetingId: string;
      meetingTitle: string;
      sharedTopics: Array<{ name: string; currentStatus: string; otherStatus: string; currentSummary: string; otherSummary: string }>;
      sharedPeople: string[];
      sharedDecisionThemes: string[];
      relevanceScore: number;
    }> = [];

    const currentTopics = new Set((currentMeeting.topics || [])
      .filter((t: any) => t && t.name)
      .map((t: any) => t.name.toLowerCase()));
    const currentPeople = new Set((currentMeeting.people || [])
      .filter((p: string) => p)
      .map((p: string) => p.toLowerCase()));

    kgData.forEach(otherMeeting => {
      if (otherMeeting.meetingId === meetingId) return;

      const sharedTopics: Array<{ name: string; currentStatus: string; otherStatus: string; currentSummary: string; otherSummary: string }> = [];
      const sharedPeople: string[] = [];
      const sharedDecisionThemes: string[] = [];

      // Find shared topics with fuzzy matching
      (otherMeeting.topics || []).forEach((otherTopic: any) => {
        if (!otherTopic || !otherTopic.name) return;
        const otherName = otherTopic.name.toLowerCase();
        // Check for exact or similar match
        let matchedCurrentTopic: any = null;
        (currentMeeting.topics || []).forEach((currentTopic: any) => {
          if (!currentTopic || !currentTopic.name) return;
          const similarity = calculateSimilarity(currentTopic.name, otherTopic.name);
          if (similarity >= 0.4 || currentTopic.name.toLowerCase() === otherName) {
            matchedCurrentTopic = currentTopic;
          }
        });
        if (matchedCurrentTopic) {
          sharedTopics.push({
            name: otherTopic.name,
            currentStatus: matchedCurrentTopic.status,
            otherStatus: otherTopic.status,
            currentSummary: matchedCurrentTopic.summary,
            otherSummary: otherTopic.summary
          });
        }
      });

      // Find shared people
      (otherMeeting.people || []).forEach((person: string) => {
        if (person && currentPeople.has(person.toLowerCase())) {
          sharedPeople.push(person);
        }
      });

      // Find shared decision themes (fuzzy)
      (otherMeeting.decisions || []).forEach((otherDec: any) => {
        (currentMeeting.decisions || []).forEach((currentDec: any) => {
          if (calculateSimilarity(currentDec.decision, otherDec.decision) >= 0.3) {
            sharedDecisionThemes.push(otherDec.relatedTopic || 'General');
          }
        });
      });

      const relevanceScore = sharedTopics.length * 3 + sharedPeople.length * 2 + sharedDecisionThemes.length;
      
      if (relevanceScore > 0) {
        relatedMeetings.push({
          meetingId: otherMeeting.meetingId,
          meetingTitle: otherMeeting.meetingTitle,
          sharedTopics,
          sharedPeople: [...new Set(sharedPeople)],
          sharedDecisionThemes: [...new Set(sharedDecisionThemes)],
          relevanceScore
        });
      }
    });

    // Sort by relevance score descending
    return relatedMeetings.sort((a, b) => b.relevanceScore - a.relevanceScore);
  };

  // Build graph nodes and links from kgData with smart similarity matching
  const buildGraphData = () => {
    const nodes: any[] = [];
    const links: any[] = [];
    const topicMap: Record<string, { meetingIds: string[]; statuses: string[]; summaries: string[] }> = {};
    const existingTopics = new Map<string, string>(); // topicId -> displayName
    const personMeetings: Record<string, string[]> = {}; // personId -> meetingIds[]

    kgData.forEach((meeting) => {
      // Meeting node with enhanced data
      const meetingNodeId = `meeting_${meeting.meetingId}`;
      nodes.push({
        id: meetingNodeId,
        label: meeting.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting',
        type: 'meeting',
        data: meeting,
        color: '#141414',
        size: 20
      });

      // Topic nodes with similarity matching
      (meeting.topics || []).forEach((topic: any) => {
        const topicId = findCanonicalTopicId(topic.name, existingTopics);
        
        if (!nodes.find(n => n.id === topicId)) {
          const statusColor = 
            topic.status === 'resolved' ? '#22c55e' :
            topic.status === 'off-track' ? '#ef4444' :
            topic.status === 'revisited' ? '#f59e0b' :
            topic.status === 'ongoing' ? '#3b82f6' : '#8b5cf6';
          nodes.push({
            id: topicId,
            label: topic.name,
            type: 'topic',
            data: { ...topic, allStatuses: [topic.status], allSummaries: [topic.summary] },
            color: statusColor,
            size: 14
          });
        } else {
          // Update existing topic node with additional status info
          const existingNode = nodes.find(n => n.id === topicId);
          if (existingNode && existingNode.data) {
            existingNode.data.allStatuses = [...(existingNode.data.allStatuses || []), topic.status];
            existingNode.data.allSummaries = [...(existingNode.data.allSummaries || []), topic.summary];
            // Update color based on latest status or most critical
            if (topic.status === 'off-track') existingNode.color = '#ef4444';
            else if (topic.status === 'revisited' && existingNode.color !== '#ef4444') existingNode.color = '#f59e0b';
            // Increase size for topics appearing in multiple meetings
            existingNode.size = Math.min(existingNode.size + 3, 24);
          }
        }
        
        links.push({ source: meetingNodeId, target: topicId, type: 'meeting-topic' });
        
        // Track topic across meetings
        if (!topicMap[topicId]) topicMap[topicId] = { meetingIds: [], statuses: [], summaries: [] };
        topicMap[topicId].meetingIds.push(meeting.meetingId);
        topicMap[topicId].statuses.push(topic.status);
        topicMap[topicId].summaries.push(topic.summary);
      });

      // Decision nodes linked to topics
      (meeting.decisions || []).forEach((dec: any, idx: number) => {
        if (!dec || !dec.decision) return;
        const decId = `decision_${meeting.meetingId}_${idx}`;
        const decText = String(dec.decision);
        nodes.push({
          id: decId,
          label: decText.length > 40 ? decText.substring(0, 40) + '...' : decText,
          type: 'decision',
          data: { ...dec, meetingId: meeting.meetingId, meetingTitle: meeting.meetingTitle },
          color: '#f59e0b',
          size: 9
        });
        
        // Try to link to canonical topic
        const topicId = findCanonicalTopicId(dec.relatedTopic || '', existingTopics);
        if (nodes.find(n => n.id === topicId)) {
          links.push({ source: topicId, target: decId, type: 'topic-decision' });
        } else {
          links.push({ source: meetingNodeId, target: decId, type: 'meeting-decision' });
        }
      });

      // People nodes - shared across meetings
      (meeting.people || []).forEach((person: string) => {
        if (!person) return;
        const personId = `person_${person.toLowerCase().replace(/\s+/g, '_')}`;
        if (!nodes.find(n => n.id === personId)) {
          nodes.push({
            id: personId,
            label: person,
            type: 'person',
            data: { name: person, meetings: [meeting.meetingTitle] },
            color: '#06b6d4',
            size: 11
          });
        } else {
          // Track which meetings this person appears in
          const existingNode = nodes.find(n => n.id === personId);
          if (existingNode && existingNode.data) {
            existingNode.data.meetings = [...(existingNode.data.meetings || []), meeting.meetingTitle];
            existingNode.size = Math.min(existingNode.size + 2, 18);
          }
        }
        links.push({ source: meetingNodeId, target: personId, type: 'meeting-person' });
        
        // Track for cross-meeting person connections
        if (!personMeetings[personId]) personMeetings[personId] = [];
        personMeetings[personId].push(meeting.meetingId);
      });

      // Action item nodes
      (meeting.actionItems || []).forEach((item: any, idx: number) => {
        if (!item || !item.task) return;
        const itemId = `action_${meeting.meetingId}_${idx}`;
        const taskText = String(item.task);
        nodes.push({
          id: itemId,
          label: taskText.length > 35 ? taskText.substring(0, 35) + '...' : taskText,
          type: 'action',
          data: { ...item, meetingId: meeting.meetingId, meetingTitle: meeting.meetingTitle },
          color: '#ec4899',
          size: 8
        });
        
        const topicId = findCanonicalTopicId(item.relatedTopic || '', existingTopics);
        if (nodes.find(n => n.id === topicId)) {
          links.push({ source: topicId, target: itemId, type: 'topic-action' });
        } else {
          links.push({ source: meetingNodeId, target: itemId, type: 'meeting-action' });
        }
        
        // Link action to person if owner matches
        const ownerId = `person_${(item.owner || '').toLowerCase().replace(/\s+/g, '_')}`;
        if (item.owner && nodes.find(n => n.id === ownerId)) {
          links.push({ source: ownerId, target: itemId, type: 'person-action' });
        }
      });
    });

    // Cross-meeting links via shared canonical topics — ALL pairs, not just sequential
    Object.entries(topicMap).forEach(([topicId, data]) => {
      if (data.meetingIds.length > 1) {
        const uniqueMeetings = [...new Set(data.meetingIds)];
        for (let i = 0; i < uniqueMeetings.length; i++) {
          for (let j = i + 1; j < uniqueMeetings.length; j++) {
            const src = `meeting_${uniqueMeetings[i]}`;
            const tgt = `meeting_${uniqueMeetings[j]}`;
            const existingLink = links.find(l =>
              (l.source === src && l.target === tgt) ||
              (l.source === tgt && l.target === src)
            );
            if (!existingLink) {
              links.push({ source: src, target: tgt, type: 'cross-meeting', dashed: true, sharedTopic: topicId });
            }
          }
        }
      }
    });

    // Cross-meeting links via shared people — ALL pairs, not just sequential
    Object.entries(personMeetings).forEach(([personId, meetingIds]) => {
      if (meetingIds.length > 1) {
        const uniqueMeetings = [...new Set(meetingIds)];
        for (let i = 0; i < uniqueMeetings.length; i++) {
          for (let j = i + 1; j < uniqueMeetings.length; j++) {
            const src = `meeting_${uniqueMeetings[i]}`;
            const tgt = `meeting_${uniqueMeetings[j]}`;
            const existingLink = links.find(l =>
              (l.source === src && l.target === tgt) ||
              (l.source === tgt && l.target === src)
            );
            if (!existingLink) {
              links.push({
                source: src,
                target: tgt,
                type: 'cross-meeting-person',
                dashed: true,
                sharedPerson: personId
              });
            }
          }
        }
      }
    });

    // Content-similarity pass: catch meetings with relevant shared context whose topic NAMES
    // didn't match (e.g. "revenue strategy" vs "sales growth plan" — same domain, different words).
    // Compare each meeting's combined topic+summary text for a richer signal.
    const meetingContent = (m: any) =>
      (m.topics || []).filter((t: any) => t).map((t: any) => `${t.name || ''} ${t.summary || ''}`).join(' ');

    for (let i = 0; i < kgData.length; i++) {
      for (let j = i + 1; j < kgData.length; j++) {
        const srcId = `meeting_${kgData[i].meetingId}`;
        const tgtId = `meeting_${kgData[j].meetingId}`;
        // Skip if already connected by a topic or person link
        if (links.find(l =>
          (l.source === srcId && l.target === tgtId) ||
          (l.source === tgtId && l.target === srcId)
        )) continue;

        const contentSim = calculateSimilarity(meetingContent(kgData[i]), meetingContent(kgData[j]));
        // Also check if they share >= 2 people (strong signal regardless of topic names)
        const peopleA = new Set((kgData[i].people || []).map((p: string) => (p || '').toLowerCase()).filter(Boolean));
        const sharedPeopleCount = (kgData[j].people || []).filter((p: string) => p && peopleA.has(p.toLowerCase())).length;

        if (contentSim >= 0.12 || sharedPeopleCount >= 2) {
          links.push({ source: srcId, target: tgtId, type: 'cross-meeting', dashed: true });
        }
      }
    }

    return { nodes, links };
  };


  const handleAgentAction = async (agentType: 'email' | 'wiki') => {
    if (!selectedTask || isGeneratingAsset) {
      if (!selectedTask) {
        setCurrentView('history');
        setError('Please select a task from history first to use agents.');
      }
      return;
    }
    
    setIsGeneratingAsset(true);

    try {
      let content: any;
      let filename = '';
      
      if (agentType === 'email') {
        content = await generateEmailContent(selectedTask.transcription || '');
        filename = `${selectedTask.filename.split('.')[0]}_FollowUp_Email.html`;
      } else {
        content = await generateWikiContent(selectedTask.transcription || '', wikiStyle);
        content.style = wikiStyle;
        filename = `${selectedTask.filename.split('.')[0]}_Wiki_${wikiStyle}.docx`;
      }

      // Save to database like assets do
      const asset = await saveAsset({
        task_id: selectedTask.id!,
        type: agentType,
        filename,
        content
      });

      setAgentAssetHistory([asset, ...agentAssetHistory]);
      setSelectedAgentAsset(asset);
    } catch (err) {
      log.error('agent_error', { error: err instanceof Error ? err : undefined });
      setError('Agent encountered an error processing your request.');
    } finally {
      setIsGeneratingAsset(false);
    }
  };

  const downloadExistingAsset = async (asset: GeneratedAsset) => {
    if (asset.type === 'email') {
      // Download as clean HTML email (client-compatible)
      const emailHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>
    body { font-family: Arial, Helvetica, sans-serif; max-width: 800px; margin: 0 auto; padding: 20px; color: #333; line-height: 1.6; }
    h1 { color: #1a1a1a; border-bottom: 2px solid #eee; padding-bottom: 10px; margin-bottom: 20px; }
    h2 { color: #2c3e50; font-size: 18px; margin-top: 30px; margin-bottom: 15px; border-bottom: 1px solid #eee; padding-bottom: 5px; }
    h3 { color: #34495e; font-size: 16px; margin-top: 20px; margin-bottom: 10px; }
    .greeting { font-size: 16px; margin-bottom: 20px; }
    .objective { background: #f8f9fa; padding: 15px; border-left: 4px solid #6c757d; margin-bottom: 25px; }
    .tasks-table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
    .tasks-table th { background: #f4f6f8; color: #333; padding: 12px; text-align: left; border: 1px solid #ddd; font-weight: bold; }
    .tasks-table td { padding: 12px; border: 1px solid #ddd; vertical-align: top; }
    .priority-high { color: #d32f2f; font-weight: bold; }
    .priority-medium { color: #f57c00; font-weight: bold; }
    .priority-low { color: #388e3c; font-weight: bold; }
    ul { margin-top: 0; padding-left: 20px; }
    li { margin-bottom: 8px; }
    .closing { margin-top: 40px; padding-top: 20px; border-top: 1px solid #eee; }
  </style>
</head>
<body>
  <h1>${asset.content.subject || 'Meeting Notes & Action Items'}</h1>
  
  <p class="greeting">${asset.content.greeting || 'Hi Team,'}</p>
  
  ${asset.content.meetingObjective ? `
  <div class="objective">
    <strong>Meeting Objective:</strong><br>
    ${asset.content.meetingObjective}
  </div>` : ''}
  
  ${asset.content.keyDecisions?.length ? `
  <h2>Key Decisions</h2>
  <ul>
    ${asset.content.keyDecisions.map((d: string) => `<li>${d}</li>`).join('')}
  </ul>` : ''}
  
  ${asset.content.discussionPoints?.length ? `
  <h2>Discussion Points</h2>
  ${asset.content.discussionPoints.map((point: any) => `
    <h3>${point.topic}</h3>
    <ul>
      ${point.details.map((detail: string) => `<li>${detail}</li>`).join('')}
    </ul>
  `).join('')}` : ''}
  
  ${asset.content.tasks?.length ? `
  <h2>Action Items</h2>
  <table class="tasks-table">
    <thead>
      <tr>
        <th style="width: 45%;">Task Details</th>
        <th style="width: 20%;">Owner</th>
        <th style="width: 20%;">Deadline</th>
        <th style="width: 15%;">Priority</th>
      </tr>
    </thead>
    <tbody>
      ${asset.content.tasks.map((task: any) => `
        <tr>
          <td>
            <strong>${task.task}</strong>
            ${task.notes ? `<div style="font-size: 12px; color: #666; margin-top: 4px;">${task.notes}</div>` : ''}
          </td>
          <td>${task.owner}</td>
          <td>${task.deadline}</td>
          <td class="priority-${task.priority?.toLowerCase()}">${task.priority}</td>
        </tr>
      `).join('')}
    </tbody>
  </table>` : ''}
  
  ${asset.content.nextMeeting ? `
  <h2>Next Steps</h2>
  <p>${asset.content.nextMeeting}</p>` : ''}
  
  <div class="closing">
    <p>${asset.content.closing || 'Best regards'}</p>
  </div>
</body>
</html>`;
      const blob = new Blob([emailHtml], { type: 'text/html' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = asset.filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    } else if (asset.type === 'wiki') {
      const wikiText = [
        asset.content.title || 'Wiki Document',
        asset.content.subtitle ? `\n${asset.content.subtitle}` : '',
        asset.content.date ? `\nDate: ${asset.content.date}` : '',
        '\n' + '─'.repeat(60),
        ...(asset.content.sections || []).flatMap((section: any) => [
          `\n## ${section.heading}`,
          section.content || '',
          ...(section.bullets || []).map((b: string) => `  • ${b}`),
        ]),
        '\n' + '─'.repeat(60),
        '\n## Conclusion',
        asset.content.conclusion || '',
      ].join('\n');
      const blob = new Blob([wikiText], { type: 'text/plain' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = asset.filename.replace('.docx', '.txt');
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }
  };

  const handleSendMessage = async (overrideText?: string, displayText?: string) => {
    const inputText = overrideText ?? chatInput;
    if (!inputText.trim() || isChatting) return;

    if (selectedTask && !selectedTask.transcription) {
      setChatMessages(prev => [...prev, { role: 'model', text: 'Unable to chat: No transcription content available for this meeting.' }]);
      return;
    }

    // The engine reads `userInput` (may carry a routing directive + full Gem prompt);
    // the chat bubble + persisted history show `displayInput` (clean label, e.g. the
    // Gem name) so routing noise never appears in the conversation.
    const displayInput = (displayText ?? inputText).trim();
    const userMessage: Message = { role: 'user', text: displayInput };
    const userInput = inputText;
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsChatting(true);

    liveAgentPlanRef.current = undefined;
    const updateAgentMessage = (updater: (prev: Message) => Partial<Message>) => {
      setChatMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'model' && last.agentStatus) {
          const updated = { ...last, ...updater(last) };
          // Keep a synchronous mirror of the plan for reliable persistence.
          if (updated.agentPlan) liveAgentPlanRef.current = updated.agentPlan;
          return [...prev.slice(0, -1), updated];
        }
        return prev;
      });
    };

    const updateStep = (stepId: string, status: AgentStep['status'], detail?: string) => {
      updateAgentMessage(prev => ({
        agentPlan: prev.agentPlan?.map(s =>
          s.id === stepId ? { ...s, status, detail: detail ?? s.detail } : s
        ),
      }));
    };

    // Attach live nested sub-steps to the in-flight analyze_meetings spawn step, so
    // the UI streams each meeting the sub-agent reads (like a Task's child tool calls).
    const updateAnalyzeProgress = (subSteps: AgentStep[]) => {
      updateAgentMessage(prev => ({
        agentPlan: prev.agentPlan?.map(s =>
          s.searchKind === 'analyze' && s.status === 'running' ? { ...s, subSteps } : s
        ),
      }));
    };

    // Read the ACTIVE thread from the ref (synchronous) — not the async state —
    // so every message in a conversation appends to the SAME thread. A new thread
    // is created only when there's no active one (home page / after "New chat").
    let currentThreadId = activeThreadIdRef.current;

    try {
      const isNewConversation = !currentThreadId;
      if (isNewConversation) {
        currentThreadId = selectedTask
          ? `tm_${selectedTask.id}_${Date.now()}`
          : `allm_${Date.now()}`;
        setActiveThread(currentThreadId); // sets the ref synchronously → next msg continues here
      }
      // Save thread metadata
      if (isNewConversation || !chatThreads.find(t => t.id === currentThreadId)) {
        upsertChatThread({
          id: currentThreadId,
          title: displayInput.slice(0, 60),
          taskId: selectedTask?.id ?? null,
          taskTitle: selectedTask?.filename,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          preview: displayInput.slice(0, 120),
        });
      } else {
        upsertChatThread({
          ...chatThreads.find(t => t.id === currentThreadId)!,
          updatedAt: new Date().toISOString(),
          preview: displayInput.slice(0, 120),
        });
      }

      if (selectedTask && selectedTask.id) {
        await saveChatMessage({
          task_id: selectedTask.id,
          role: 'user',
          text: displayInput,
          thread_id: currentThreadId,
        });
      } else {
        setAllMeetingsChatMessages(prev => [...prev, userMessage]);
        saveChatMessage({
          role: 'user',
          text: displayInput,
          thread_id: currentThreadId,
        }).catch(err => log.warn('persist_all_meetings_user_msg_failed', { error: err instanceof Error ? err : undefined }));
      }

      const msgHistory = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      // ═══════════ PHASE 1: THINKING ═══════════
      const agentPlaceholder: Message = {
        role: 'model',
        text: '',
        agentStatus: 'thinking',
        agentPlan: [],
      };
      setChatMessages(prev => [...prev, agentPlaceholder]);

      const isSingleMeeting = !!selectedTask;
      // LIVE RECORDING chat: while a meeting is being recorded, the home/all-meetings
      // chat is scoped to ONLY that in-progress meeting's live transcript — not RAG
      // across all past notes. (anarlog's "current session" pattern.) A meeting open
      // in a tab (selectedTask) keeps its own single-meeting behavior.
      const isLiveRecording = isRecording && !selectedTask;
      // Built from the paginated `history` (first page). For the ALL-MEETINGS chat we
      // replace this below with the COMPLETE meeting set (getAllTaskIds), so the agent
      // never thinks the user only has the 24 most-recent meetings.
      let allMeetings: MeetingDocument[] = history
        .filter((task) => !!task.id)
        .map((task) => ({
          meetingId: task.id!,
          title: task.filename || 'Untitled Meeting',
          transcription: task.transcription || '',
          summary: task.summary || '',
          notes: task.notes || '',
        }));

      // ALL-MEETINGS chat: load the FULL meeting index (lightweight metadata for every
      // meeting, not just the loaded page). Content is hydrated on demand by the
      // read/analyze/listing paths via getTaskById — so coverage is complete without
      // pulling every transcript up front.
      let fullMeta: import('./services/awsService').TaskMetadata[] = [];
      if (!isSingleMeeting && !isLiveRecording) {
        const ALL_META_TTL_MS = 60_000;
        // W1: the full index is per-workspace — invalidate the cache when the active
        // workspace differs so a vault switch never shows the previous vault's meetings.
        const activeWs = getWorkspaceSelection().workspaceId;
        const cached = allMetaCacheRef.current;
        if (cached && cached.workspaceId === activeWs && Date.now() - cached.ts < ALL_META_TTL_MS) {
          fullMeta = cached.data;
        } else {
          try {
            fullMeta = await getAllTaskIds();
            allMetaCacheRef.current = { data: fullMeta, ts: Date.now(), workspaceId: activeWs };
          } catch (err) {
            log.warn('all_meetings_full_index_failed', { error: err instanceof Error ? err : undefined });
            if (cached && cached.workspaceId === activeWs) fullMeta = cached.data; // stale-but-usable beats empty
          }
        }
        if (fullMeta.length) {
          const loaded = new Map(history.filter(t => t.id).map(t => [t.id!, t]));
          allMeetings = fullMeta
            .filter(m => !!m.id && m.status !== 'error')
            .map(m => {
              const h = loaded.get(m.id);
              return {
                meetingId: m.id,
                title: m.filename || h?.filename || 'Untitled Meeting',
                transcription: h?.transcription || '',   // hydrated on demand
                summary: m.summary || h?.summary || '',
                notes: h?.notes || '',                     // hydrated on demand
              };
            });
          log.debug('all_meetings_full_index', { total: allMeetings.length, loaded: loaded.size });
        }
      }
      // ═══════════ PHASE 2: PLANNING + EXECUTING ═══════════
      let response: string;
      let responseCitations: Message['citations'] = undefined;
      let responseRetrievalMeta: Message['retrievalMeta'] = undefined;

      if (isLiveRecording) {
        // --- Live recording: chat ONLY with the in-progress meeting transcript ---
        // Re-read the live transcript fresh on each send (pull model) so the answer
        // reflects everything said up to this moment, including the faded interim line.
        const liveLines = realtimeTranscriptRef.current;
        const interim = interimTranscriptRef.current.trim();
        const liveText = [
          ...liveLines,
          interim ? `${interim}  …(still speaking)` : '',
        ].filter(Boolean).join('\n');

        const mm = Math.floor(recordingTime / 60);
        const ss = recordingTime % 60;
        const elapsedLabel = `${mm}:${ss.toString().padStart(2, '0')}`;

        const liveSteps: AgentStep[] = [
          { id: 'live', label: 'Reading live meeting transcript', status: 'pending' },
          { id: 'respond', label: 'Generate response', status: 'pending' },
        ];
        updateAgentMessage(() => ({ agentStatus: 'planning', agentPlan: liveSteps }));
        await new Promise(r => setTimeout(r, 120));
        updateAgentMessage(() => ({ agentStatus: 'executing' }));

        updateStep('live', 'running');
        const lineCount = liveLines.length + (interim ? 1 : 0);
        updateStep('live', 'done', lineCount ? `${lineCount} line${lineCount !== 1 ? 's' : ''} so far` : 'no speech yet');

        updateStep('respond', 'running');
        response = await chatWithLiveTranscript(liveText, userInput, msgHistory, {
          title: 'Current recording (in progress)',
          elapsedLabel,
        });
        updateStep('respond', 'done');

        responseRetrievalMeta = {
          scope: 'single',
          confidence: 1,
          selectedMeetingIds: [],
          coveredMeetingsCount: 1,
          totalMeetingsCount: 1,
        };

      } else if (isSingleMeeting) {
        // --- Single meeting: RAG retrieval + chatWithNotes ---
        const singleSteps: AgentStep[] = [
          { id: 'retrieve', label: 'Retrieve evidence', status: 'pending' },
          { id: 'analyze', label: 'Analyze context', status: 'pending' },
          { id: 'respond', label: 'Generate response', status: 'pending' },
        ];
        updateAgentMessage(() => ({ agentStatus: 'planning', agentPlan: singleSteps }));
        await new Promise(r => setTimeout(r, 200));
        updateAgentMessage(() => ({ agentStatus: 'executing' }));

        updateStep('retrieve', 'running');
        const meeting: MeetingDocument = {
          meetingId: selectedTask!.id || 'unknown',
          title: selectedTask!.filename || 'Untitled Meeting',
          transcription: selectedTask!.transcription || '',
          summary: selectedTask!.summary || '',
          notes: selectedTask!.notes || '',
        };
        const retrievalPlan = await retrieveForSingleMeeting({
          query: userInput,
          meeting,
          totalTokenBudget: 10000,
        });
        updateStep('retrieve', 'done', `${retrievalPlan.evidence.length} chunks`);

        updateStep('analyze', 'running');
        responseCitations = retrievalPlan.evidence.slice(0, 6).map((e) => ({
          meetingId: e.meetingId,
          meetingTitle: e.meetingTitle,
          chunkId: e.chunkId,
          score: e.score,
        }));
        responseRetrievalMeta = {
          scope: 'single',
          confidence: retrievalPlan.confidence,
          selectedMeetingIds: retrievalPlan.selectedMeetingIds,
          tokenUsageTotal: retrievalPlan.tokenUsage.totalTokens,
          coveredMeetingsCount: 1,
          totalMeetingsCount: 1,
        };
        updateStep('analyze', 'done');

        // Prepend a structured header (date / attendees / action items /
        // decisions / off-track topics) so single-meeting answers never drop
        // who/when/what — parity with the multi-meeting evidence cards.
        let kgLite: KGLite | null = null;
        try {
          const kg = await getKnowledgeGraphForTask(selectedTask!.id!);
          if (kg) kgLite = { topics: kg.topics, decisions: kg.decisions, action_items: kg.action_items, people: kg.people };
        } catch { /* non-fatal — header still carries date/attendees */ }
        const meetingHeader = buildMeetingCard({
          title: selectedTask!.filename || 'Untitled',
          createdAt: selectedTask!.created_at,
          attendees: selectedTask!.attendees,
          kg: kgLite,
          content: '',
        });

        updateStep('respond', 'running');
        response = await chatWithNotes(
          {
            transcription: '',
            title: selectedTask!.filename || '',
            preparedContext: `${meetingHeader}\n\n${retrievalPlan.context}`,
            retrievalMeta: {
              scope: retrievalPlan.scope,
              confidence: retrievalPlan.confidence,
              selectedMeetingIds: retrievalPlan.selectedMeetingIds,
              tokenUsage: { totalTokens: retrievalPlan.tokenUsage.totalTokens },
            },
          },
          userInput,
          msgHistory,
          true
        );
        updateStep('respond', 'done');

      } else {
        // --- All meetings: anarlog-style agentic tool-calling loop with turbopuffer search ---
        log.debug('agent_multi_meeting_agentic', { meetingCount: allMeetings.length });
        updateAgentMessage(() => ({ agentStatus: 'executing', agentPlan: [] }));

        // Dates for EVERY meeting (full index when available), not just the loaded page —
        // so date scoping and labels work across all meetings, not the first 24.
        const dateMap = new Map<string, string>(
          (fullMeta.length ? fullMeta.map(m => [m.id, m.created_at] as [string, string]) : [])
            .concat(history.map(h => [h.id ?? '', h.created_at ?? ''] as [string, string])),
        );

        const dateLabelFor = (meetingId: string): string | undefined => {
          const dateStr = dateMap.get(meetingId);
          return dateStr
            ? new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
            : undefined;
        };

        // Hydrate ONE meeting's full content on demand (server fetch when the
        // paginated history omitted notes/transcript). Shared by the extract route
        // and the analyze_meetings sub-agent. Mirrors readNotesFn.
        const loadMeetingFullContent = async (meetingId: string) => {
          const doc = allMeetings.find(m => m.meetingId === meetingId);
          let notes = (doc?.notes ?? '').trim();
          let summary = (doc?.summary ?? '').trim();
          let transcript = (doc?.transcription ?? '').trim();
          if (!notes && !summary && !transcript) {
            try {
              const full = await getTaskById(meetingId);
              if (full) { notes = (full.notes ?? '').trim(); summary = (full.summary ?? '').trim(); transcript = (full.transcription ?? '').trim(); }
            } catch { /* offline / not found */ }
          }
          return { notes, summary, transcript };
        };

        // Deep per-meeting analysis reads each meeting in FULL (one model call each),
        // so it must be bounded — but the bound is DISCLOSED, never silent (CLAUDE.md
        // §10). Up to this many most-recent meetings are read per request; anything
        // beyond is reported back with an offer to continue. (At true 10k-scale the
        // right tool is the background KG/turbopuffer index, not reading all live.)
        const DEEP_ANALYSIS_CEILING = 150;

        // Shared deep-read+synthesize step, used by the extract route AND "keep going"
        // continuation. Shows plan → live per-meeting reads → synth, reads the REAL
        // notes (transcript+summary+notes), returns the synthesized answer. The caller
        // owns candidate selection + the resumable cursor.
        const deepReadExtract = async (
          refs: { meetingId: string; title: string; dateLabel?: string }[],
          instr: string,
          planLabel: string,
        ): Promise<string> => {
          const n = refs.length;
          updateAgentMessage(() => ({
            agentStatus: 'planning',
            agentPlan: [{
              id: 'plan', type: 'plan' as const, status: 'done' as const, label: planLabel,
              planSteps: [
                `Load every meeting in scope (${n})`,
                'Read each meeting in full — one focused pass per meeting',
                'Extract the requested items from each',
                'Synthesize one grouped, deduplicated answer',
              ],
            }],
          }));
          await new Promise(r => setTimeout(r, 150));
          updateAgentMessage(prev => ({
            agentStatus: 'executing',
            agentPlan: [...(prev.agentPlan ?? []), { id: 'read-all', label: `Reading ${n} meeting${n !== 1 ? 's' : ''} in full`, status: 'running' as const, detail: `0 / ${n}` }],
          }));
          const setReadAllSub = (subSteps: AgentStep['subSteps'], detail: string, status: AgentStep['status']) => {
            updateAgentMessage(prev => ({ agentPlan: prev.agentPlan?.map(s => s.id === 'read-all' ? { ...s, status, detail, subSteps } : s) }));
          };
          const readDone: NonNullable<AgentStep['subSteps']> = [];
          const out = await extractAcrossMeetings({
            instructions: instr,
            meetings: refs,
            loadContent: loadMeetingFullContent,
            concurrency: 4,
            onProgress: (ev) => {
              if (ev.phase === 'map') {
                readDone.push({ id: `read-${readDone.length}`, label: ev.title, status: 'done', detail: ev.hadItems ? undefined : 'nothing relevant' });
                setReadAllSub(
                  ev.completed < ev.total
                    ? [...readDone, { id: 'reading', label: `Reading meetings in full… (${ev.completed}/${ev.total})`, status: 'running' }]
                    : [...readDone],
                  `${ev.completed} / ${ev.total}`,
                  'running',
                );
              } else if (ev.phase === 'reduce') {
                setReadAllSub([...readDone], `${n} / ${n}`, 'done');
                updateAgentMessage(prev => ({ agentPlan: [...(prev.agentPlan ?? []), { id: 'synth', label: 'Synthesizing answer', status: 'running' as const }] }));
              }
            },
          });
          setReadAllSub([...readDone], `${n} / ${n}`, 'done');
          updateStep('synth', 'done');
          return out;
        };

        // P5: "keep going" continuation. If the user affirms continuation and a capped
        // extract cursor is pending for THIS thread, read the NEXT batch of the ordered
        // candidate set (real notes) and advance the cursor — never restart.
        const continueCursor = extractCursorRef.current;
        const isContinue = !!continueCursor
          && continueCursor.threadId === (currentThreadId || '')
          && continueCursor.covered < continueCursor.orderedIds.length
          && /^\s*(yes|yep|yeah|sure|ok(ay)?|please( do)?|continue|keep going|go on|carry on|do the rest|the rest|more|next)\b/i.test(userInput.trim());

        // ── Route: per-meeting extraction (Gems with intent:'extract', OR a free-form
        //    "list X across all my meetings" request detected by looksLikeBroadExtraction)
        //    use a programmatic MAP-REDUCE instead of the agentic loop. Each meeting is
        //    read in FULL by its own focused call, so the parent context only ever holds
        //    COMPACT per-meeting findings — never raw transcripts. This makes the deep,
        //    visible read-every-meeting path DETERMINISTIC for these tasks (no reliance
        //    on the model choosing to spawn) and keeps huge histories bounded. ──
        const isExtractTask = userInput.includes(EXTRACT_DIRECTIVE) || looksLikeBroadExtraction(userInput);
        if (isContinue && continueCursor) {
          const slice = continueCursor.orderedIds.slice(continueCursor.covered, continueCursor.covered + DEEP_ANALYSIS_CEILING);
          const refs = slice
            .map(id => allMeetings.find(m => m.meetingId === id))
            .filter((m): m is MeetingDocument => !!m)
            .map(m => ({ meetingId: m.meetingId, title: m.title, dateLabel: dateLabelFor(m.meetingId) }));
          if (refs.length) {
            response = await deepReadExtract(refs, continueCursor.instructions, `Continue — read the next ${refs.length} meeting${refs.length !== 1 ? 's' : ''} in full`);
            const newCovered = continueCursor.covered + refs.length;
            const remaining = continueCursor.orderedIds.length - newCovered;
            if (remaining > 0) {
              extractCursorRef.current = { ...continueCursor, covered: newCovered };
              response += `\n\n---\n*Read ${refs.length} more (${newCovered} of ${continueCursor.orderedIds.length} total). ${remaining} still remaining — say "keep going" to continue.*`;
            } else {
              extractCursorRef.current = null;
              response += `\n\n---\n*That now covers all ${continueCursor.orderedIds.length} meetings.*`;
            }
            responseRetrievalMeta = {
              scope: 'many', confidence: 0.85,
              selectedMeetingIds: slice,
              coveredMeetingsCount: refs.length,
              totalMeetingsCount: allMeetings.length,
            };
          } else {
            extractCursorRef.current = null;
            response = "Those remaining meetings are no longer available — try your request again.";
          }
        } else if (isExtractTask) {
          const instructions = userInput.replace(EXTRACT_DIRECTIVE, '').trim();

          // ── P1 (HYBRID): the KG index decides WHICH meetings to deep-read; the
          //    ANSWER always comes from the real NOTES (full fidelity), never from the
          //    lossy index. The KG is a router, not the source of truth: for
          //    action-item / decision extraction we use it to PRIORITIZE meetings
          //    likely to contain what's asked, so a bounded read budget at scale is
          //    spent on the right meetings — but every item is extracted from the
          //    actual notes page, catching informal commitments the index would miss. ──
          const kgFacet = kgExtractableFacet(userInput);
          const kgPriority = new Map<string, number>();
          if (kgFacet) {
            try {
              const kg = await getKnowledgeGraph();
              for (const e of kg) {
                const n = kgFacet === 'decisions' ? (e.decisions?.length ?? 0) : (e.action_items?.length ?? 0);
                if (n > 0) kgPriority.set(e.task_id, n);
              }
            } catch (err) {
              log.warn('kg_priority_unavailable', { error: err instanceof Error ? err : undefined });
            }
          }

          // ── P2: candidate selection. If the request names an explicit TOPIC, RETRIEVE
          //    the semantically-relevant meetings (turbopuffer ANN+BM25, wide net) and
          //    deep-read THOSE real notes — so a capped budget covers the meetings that
          //    matter, not just the recent ones. A pure global request (no topic) orders
          //    by KG-priority then recency. Either way the ANSWER is read from real notes. ──
          let relevantRank: Map<string, number> | null = null;
          if (queryMentionsTopic(instructions) && isTurbopufferConfigured()) {
            try {
              const qVec = await embedQuery(instructions);
              const hits = await queryHybrid(qVec, instructions, 160); // wide net → many distinct meetings
              const rank = new Map<string, number>();
              let r = 0;
              for (const h of hits) if (!rank.has(h.meetingId)) rank.set(h.meetingId, r++);
              if (rank.size) relevantRank = rank;
            } catch (err) {
              log.warn('extract_topic_retrieval_failed', { error: err instanceof Error ? err : undefined });
            }
          }
          const selectionMode: 'topic' | 'global' = relevantRank ? 'topic' : 'global';

          const orderedCandidates = relevantRank
            ? allMeetings
                .filter(m => relevantRank!.has(m.meetingId))
                .sort((a, b) => relevantRank!.get(a.meetingId)! - relevantRank!.get(b.meetingId)!)
            : [...allMeetings].sort((a, b) => {
                const pa = kgPriority.get(a.meetingId) ?? 0;
                const pb = kgPriority.get(b.meetingId) ?? 0;
                if (pa !== pb) return pb - pa;
                const ta = new Date(dateMap.get(a.meetingId) || 0).getTime();
                const tb = new Date(dateMap.get(b.meetingId) || 0).getTime();
                return tb - ta;
              });
          const scopedMeetings = orderedCandidates.slice(0, DEEP_ANALYSIS_CEILING);
          const notCoveredCount = Math.max(0, orderedCandidates.length - scopedMeetings.length);
          if (notCoveredCount > 0) {
            log.debug('extract_scope_capped', { capped: DEEP_ANALYSIS_CEILING, total: orderedCandidates.length, mode: selectionMode });
          }

          const scopedRefs = scopedMeetings.map(m => ({
            meetingId: m.meetingId,
            title: m.title,
            dateLabel: dateLabelFor(m.meetingId),
          }));

          const total = scopedRefs.length;
          response = await deepReadExtract(
            scopedRefs,
            instructions,
            `Read all ${total} meeting${total !== 1 ? 's' : ''} in full and extract exactly what was asked`,
          );

          // P5: disclose the uncovered tail AND store a resumable cursor so "keep going"
          // reads the NEXT batch of the SAME ordered candidate set — never restarts.
          if (notCoveredCount > 0) {
            extractCursorRef.current = {
              threadId: currentThreadId || '',
              instructions,
              orderedIds: orderedCandidates.map(m => m.meetingId),
              covered: scopedRefs.length,
            };
            const how = selectionMode === 'topic'
              ? ' most relevant to your topic'
              : kgPriority.size > 0 ? ' (prioritized by the index toward the meetings most likely to contain relevant items)' : '';
            response += `\n\n---\n*Deep-read the actual notes of ${total} meetings${how}. ${notCoveredCount} other relevant meeting${notCoveredCount !== 1 ? 's were' : ' was'} not read this pass — say "keep going" and I'll read the next batch.*`;
          } else {
            extractCursorRef.current = null;
          }

          responseRetrievalMeta = {
            scope: 'many',
            confidence: 0.85,
            selectedMeetingIds: scopedRefs.map(r => r.meetingId),
            coveredMeetingsCount: total,
            totalMeetingsCount: allMeetings.length,
          };
        } else {

        let sharedKgCache: KnowledgeGraphEntry[] | null = null;
        const loadKG = async (): Promise<KnowledgeGraphEntry[]> => {
          if (sharedKgCache) return sharedKgCache;
          try {
            sharedKgCache = await getKnowledgeGraph();
          } catch (err) {
            log.error('kg_lookup_failed', { message: (err as Error)?.message });
            sharedKgCache = [];
          }
          return sharedKgCache;
        };

        const formatKGEntry = (entry: KnowledgeGraphEntry, maxTopicChars = 220): string => {
          const parts: string[] = [];
          if (entry.topics?.length) {
            parts.push(
              `Topics:\n${entry.topics
                .map(t => `  • ${t.name}${t.status ? ` (${t.status})` : ''}${t.summary ? ` — ${t.summary.slice(0, maxTopicChars)}` : ''}`)
                .join('\n')}`
            );
          }
          if (entry.decisions?.length) {
            parts.push(
              `Decisions:\n${entry.decisions.map(d => `  • ${d.decision}${d.relatedTopic ? ` [topic: ${d.relatedTopic}]` : ''}`).join('\n')}`
            );
          }
          if (entry.action_items?.length) {
            parts.push(
              `Action items:\n${entry.action_items.map(a => `  • ${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}${a.relatedTopic ? ` [topic: ${a.relatedTopic}]` : ''}`).join('\n')}`
            );
          }
          if (entry.people?.length) parts.push(`People: ${entry.people.join(', ')}`);
          if (entry.refs?.length) parts.push(`References: ${entry.refs.join(', ')}`);
          return parts.length ? parts.join('\n') : '(empty knowledge graph entry)';
        };

        const turbopufferSearchFn = async (
          query: string,
          filters?: { recent_days?: number; start_ms?: number; end_ms?: number; off_track?: boolean },
          limit?: number,
        ) => {
          // Self-heal a common model mistake: passing a task_id (UUID) as the search
          // QUERY. Keyword search can't match an id, so it would return "No results".
          // If the query IS a known meeting id, resolve it to that meeting's full
          // content (what the model actually wanted) instead of a dead search.
          const qTrim = query.trim();
          const idHit = qTrim ? allMeetings.find(m => m.meetingId === qTrim) : undefined;
          if (idHit) {
            const c = await loadMeetingFullContent(idHit.meetingId);
            const dateLabel = dateLabelFor(idHit.meetingId) ?? 'unknown date';
            const body = [
              c.notes ? `NOTES:\n${c.notes}` : '',
              c.summary ? `SUMMARY:\n${c.summary}` : '',
              c.transcript ? `TRANSCRIPT:\n${c.transcript.length > 6000 ? `${c.transcript.slice(0, 6000)}… [truncated — NOTES above are authoritative]` : c.transcript}` : '',
            ].filter(Boolean).join('\n\n');
            return {
              results: [{ meetingId: idHit.meetingId, meetingTitle: idHit.title, score: 1, date: dateMap.get(idHit.meetingId) }],
              contextText: `=== ${idHit.title} (${dateLabel}) [task_id: ${idHit.meetingId}] ===\n${body || '(No notes generated for this meeting.)'}`,
            };
          }

          // Deterministic absolute window (from the parsed query) takes precedence
          // over the model's relative recent_days, so "this month / last 3 days /
          // a specific date" filter reliably.
          const hasAbsRange = typeof filters?.start_ms === 'number' && typeof filters?.end_ms === 'number';
          const hasDateFilter = hasAbsRange || !!(filters?.recent_days && filters.recent_days > 0);
          let docsToSearch = allMeetings;
          if (hasAbsRange) {
            docsToSearch = allMeetings.filter(m => {
              const date = dateMap.get(m.meetingId);
              if (!date) return false;
              const t = new Date(date).getTime();
              return t >= filters!.start_ms! && t <= filters!.end_ms!;
            });
          } else if (filters?.recent_days && filters.recent_days > 0) {
            const cutoff = Date.now() - filters.recent_days * 24 * 60 * 60 * 1000;
            docsToSearch = allMeetings.filter(m => {
              const date = dateMap.get(m.meetingId);
              if (!date) return true;   // unknown date → keep, never silently drop a meeting
              return new Date(date).getTime() >= cutoff;
            });
          }
          // Robustness: if a date filter excluded EVERYTHING (a too-narrow recent_days,
          // or a clock/year mismatch between the device and the meeting timestamps),
          // fall back to ALL meetings so the tool never returns "No results found"
          // when meetings exist. The agent (which has the dated meeting index in its
          // prompt) then reasons about which days are relevant.
          if (docsToSearch.length === 0 && allMeetings.length > 0) {
            docsToSearch = allMeetings;
          }
          // Off-track intent → restrict to meetings whose knowledge graph flags an
          // off-track/blocked topic.
          if (filters?.off_track) {
            const kg = await loadKG();
            const OFF = new Set(['off-track', 'off track', 'blocked', 'stalled', 'at-risk', 'at risk']);
            const offIds = new Set(
              kg.filter(e => (e.topics ?? []).some(t => t.status && OFF.has(t.status.toLowerCase()))).map(e => e.task_id),
            );
            if (offIds.size) docsToSearch = docsToSearch.filter(m => offIds.has(m.meetingId));
          }

          // Intent-driven breadth: honour the LLM's requested limit (it knows whether
          // the ask is narrow or sweeping), floored at 8 so related meetings still
          // surface, and ceilinged generously at 40 so broad asks ("todos across all
          // my meetings", recaps) go WIDE instead of being truncated to 10. Total
          // context stays bounded by the per-meeting evidence budget below, NOT by a
          // small meeting cap — so huge histories are handled by relevance + budgeting.
          const maxCandidates = Math.min(Math.max(limit ?? 8, 8), 40);
          const trimmedQuery = query.trim();

          // ── Date-range listing mode (empty query) ─────────────────────────────────
          // When the LLM passes query="" with a recent_days filter, the user is asking
          // "show me everything in this window" — semantic/keyword scoring would just
          // throw away meetings whose text doesn't contain a buzzword. Return them all
          // sorted by date desc, with their notes/summaries as context.
          if (trimmedQuery.length === 0) {
            // A date-range listing means "everything in this window" (e.g. a
            // monthly recap). Return EVERY meeting in range — never cap at the
            // semantic top-N, which truncated long months to 10. Content length
            // per meeting scales down as the count grows so the total context
            // stays bounded.
            const sorted = docsToSearch
              .slice()
              .sort((a, b) => {
                const da = dateMap.get(a.meetingId) ?? '';
                const db = dateMap.get(b.meetingId) ?? '';
                return db.localeCompare(da);
              });

            // The paginated history list usually omits notes/transcription (they're
            // loaded lazily per meeting). Without hydrating them, action-item / recap
            // extraction sees empty content and wrongly reports "No notes generated".
            // Pull the real notes from the server for any listed meeting missing
            // content — bounded + parallel so it scales to large windows.
            // SCALE: a listing tool result must stay bounded. A windowed listing
            // ("this week/month") is naturally small, but a global empty-query
            // listing over thousands of meetings would build thousands of sections
            // and overflow. Cap the sections (most-recent-first) and DISCLOSE the
            // remainder so the model steers the user to a window or analyze_meetings.
            const LISTING_CAP = 60;
            const listed = sorted.slice(0, LISTING_CAP);
            const listingHidden = sorted.length - listed.length;

            await Promise.all(listed.slice(0, 25).map(async (m) => {
              if (m.summary?.trim() || m.notes?.trim() || m.transcription?.trim()) return;
              try {
                const full = await getTaskById(m.meetingId);
                if (full) {
                  m.summary = full.summary || m.summary;
                  m.notes = full.notes || m.notes;
                  m.transcription = full.transcription || m.transcription;
                }
              } catch { /* offline / not found — leave as-is */ }
            }));

            const perMeetingChars = listed.length > 24 ? 500 : listed.length > 12 ? 900 : 1800;
            const sections = listed.map((m, i) => {
              const dateStr = dateMap.get(m.meetingId);
              const dateLabel = dateStr
                ? new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                : 'unknown date';
              // Prefer the (compact) summary for recaps, then notes, then a transcript slice.
              const raw = (m.summary?.trim() || m.notes?.trim() || (m.transcription ?? '')).trim();
              const content = raw.length > perMeetingChars ? `${raw.slice(0, perMeetingChars)}…` : raw;
              return `${i + 1}. ${m.title} (${dateLabel})\n${content || '(no content available)'}`;
            });

            const coverageLine = listingHidden > 0
              ? `=== COVERAGE ===\nShowing the ${listed.length} most recent meetings in this scope; ${listingHidden} older meeting${listingHidden !== 1 ? 's are' : ' is'} NOT shown here. For a complete extraction across all of them, narrow to a time window or use analyze_meetings — and tell the user this listing is partial.`
              : `=== COVERAGE ===\nListed ALL ${listed.length} meetings in this date range (${allMeetings.length} total). This is the COMPLETE set — base your recap on every meeting below.`;
            const rangeContext = [
              coverageLine,
              `=== MEETINGS ===\n${sections.join('\n\n---\n\n')}`,
            ].join('\n\n');

            const rangeResults = listed.map(m => ({
              meetingId: m.meetingId,
              meetingTitle: m.title,
              score: 1,
              date: dateMap.get(m.meetingId),
            }));

            return { results: rangeResults, contextText: rangeContext };
          }
          const docsById = new Map(docsToSearch.map(m => [m.meetingId, m]));
          let candidateDocs: MeetingDocument[] = [];

          // ── Strategy 1: global turbopuffer ANN + BM25 hybrid (semantic-first) ──────
          // This is the primary path. ANN understands meaning (not just keywords), so
          // "SDLC offtracks" finds "project delays" and "Mowlish" finds his transcript
          // mentions even when titles/summaries don't contain his name.
          if (isTurbopufferConfigured()) {
            try {
              const qVec = await embedQuery(query);
              // Fetch a WIDE net of chunks (160) so many DISTINCT meetings surface
              // after the per-meeting dedup — essential for broad asks over large
              // histories, where the relevant meetings are spread across many chunks.
              const globalHits = await queryHybrid(qVec, query, 160);

              // Date-filter hits to respect filters.recent_days
              const validHits = filters?.recent_days
                ? globalHits.filter(hit => {
                    const date = dateMap.get(hit.meetingId);
                    if (!date) return true;
                    const cutoff = Date.now() - (filters.recent_days ?? 0) * 24 * 60 * 60 * 1000;
                    return new Date(date).getTime() >= cutoff;
                  })
                : globalHits;

              // Deduplicate by meeting, preserving highest score per meeting.
              const meetingHitMap = new Map<string, number>();
              for (const hit of validHits) {
                const existing = meetingHitMap.get(hit.meetingId) ?? 0;
                if (hit.score > existing) meetingHitMap.set(hit.meetingId, hit.score);
              }
              // Sort by score descending and resolve to MeetingDocument objects.
              const sortedMeetingIds = Array.from(meetingHitMap.entries())
                .sort((a, b) => b[1] - a[1])
                .map(([id]) => id);
              for (const id of sortedMeetingIds) {
                const doc = docsById.get(id);
                if (doc) candidateDocs.push(doc);
                if (candidateDocs.length >= maxCandidates) break;
              }
            } catch { /* fall through to keyword fallback */ }
          }

          // ── Strategy 2: keyword fallback (title + summary) when turbopuffer unavailable ──
          if (candidateDocs.length === 0) {
            const scored = docsToSearch
              .map(m => ({ doc: m, score: scoreMeetingCandidate(query, m) }))
              .sort((a, b) => b.score - a.score);
            const keywordMatches = scored.filter(s => s.score > 0).slice(0, maxCandidates).map(s => s.doc);
            candidateDocs = keywordMatches.length > 0
              ? keywordMatches
              : scored.slice(0, Math.min(3, maxCandidates)).map(s => s.doc);
          }

          // ── Strategy 3: per-meeting deep retrieval for each candidate ────────────
          // Turbopuffer with meetingIdFilter pulls the most relevant chunks from that
          // specific meeting. Falls back to local BM25 if chunks aren't indexed.
          // Scale the per-meeting evidence budget with the candidate count so the
          // TOTAL context stays bounded (~14k chars) no matter how many meetings we
          // cover, while never starving any single meeting below a useful floor.
          // Turbopuffer/BM25 picks only the relevant chunks per meeting — so we go
          // deep across many meetings without dragging in unwanted text.
          const perBudget = Math.max(280, Math.floor(14000 / Math.max(1, candidateDocs.length)));
          const allEvidence: RetrievalEvidence[] = [];
          for (const m of candidateDocs) {
            const { evidence } = await retrieveMeetingEvidence(query, m, perBudget);
            allEvidence.push(...evidence);
          }

          // ── Strategy 4: lazy-load fallback (meetings not yet indexed in turbopuffer) ──
          // Fetches the full transcription from the server for the top candidates and
          // runs local BM25 on it. Handles cold-start and unindexed meetings. Covers
          // more than a token 2 so broad cold-start asks aren't starved.
          if (allEvidence.length === 0 && candidateDocs.length > 0) {
            for (const m of candidateDocs.slice(0, 6)) {
              if (m.transcription?.trim()) continue;
              try {
                const full = await getTaskById(m.meetingId);
                if (full?.transcription?.trim()) {
                  const enriched = { ...m, transcription: full.transcription, summary: full.summary || m.summary, notes: full.notes || m.notes };
                  const { evidence: lazy } = await retrieveMeetingEvidence(query, enriched, perBudget);
                  allEvidence.push(...lazy);
                  const idx = candidateDocs.indexOf(m);
                  if (idx !== -1) candidateDocs[idx] = enriched;
                }
              } catch { /* ignore */ }
            }
          }

          const summaryBlocks = candidateDocs
            .filter(m => m.summary?.trim())
            .map(m => `- ${m.title}: ${(m.summary || '').slice(0, 300)}`);

          // Structured facts per candidate (date + attendees + KG action items /
          // decisions / topic status) so the answer never drops who/when/what,
          // even when transcript chunks miss them.
          const kgForCards = await loadKG();
          const kgById = new Map(kgForCards.map(e => [e.task_id, e]));
          const attendeesMap = new Map(history.map(h => [h.id ?? '', (h.attendees ?? []) as string[]]));
          const structuredBlocks = candidateDocs.map((m, i) => {
            const dateStr = dateMap.get(m.meetingId);
            const dateLabel = dateStr
              ? new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
              : 'unknown date';
            const att = attendeesMap.get(m.meetingId) ?? [];
            const kg = kgById.get(m.meetingId);
            return [
              `${i + 1}. ${m.title} — ${dateLabel}`,
              att.length ? `Attendees: ${att.join(', ')}` : '',
              kg ? formatKGEntry(kg) : '',
            ].filter(Boolean).join('\n');
          });

          const evidenceText = allEvidence
            .sort((a, b) => b.score - a.score)
            .slice(0, 30)
            .map((e, i) => formatEvidence(0, i, e))
            .join('\n\n');

          const contextText = [
            `=== COVERAGE ===\nSearched ${candidateDocs.length} of ${docsToSearch.length} meetings (Turbopuffer semantic + BM25 hybrid over transcript chunks)`,
            `=== SELECTED MEETINGS ===\n${candidateDocs.map((m, i) => `${i + 1}. ${m.title}`).join('\n')}`,
            structuredBlocks.length
              ? `=== STRUCTURED FACTS (date, attendees, action items, decisions, topic status — authoritative for who/when/what) ===\n${structuredBlocks.join('\n\n')}`
              : '',
            summaryBlocks.length
              ? `=== AI-GENERATED MEETING SUMMARIES (may contain errors — treat as hints only, not ground truth) ===\n${summaryBlocks.join('\n')}`
              : '',
            evidenceText
              ? `=== TRANSCRIPT EVIDENCE (authoritative — prefer this over summaries for specific facts, names, and roles) ===\n${evidenceText}`
              : `=== TRANSCRIPT EVIDENCE ===\nNo evidence found. Call search_notes again with a different or shorter query.`,
          ].filter(Boolean).join('\n\n');

          const meetingScoreMap = new Map<string, { title: string; score: number }>();
          for (const e of allEvidence) {
            const existing = meetingScoreMap.get(e.meetingId);
            if (!existing || e.score > existing.score) {
              meetingScoreMap.set(e.meetingId, { title: e.meetingTitle, score: e.score });
            }
          }
          // Always include every candidate so the UI step and citations list the full
          // scope, even when per-meeting deep retrieval returned no chunks.
          for (const c of candidateDocs) {
            if (!meetingScoreMap.has(c.meetingId)) {
              meetingScoreMap.set(c.meetingId, { title: c.title, score: 0 });
            }
          }
          const results = Array.from(meetingScoreMap.entries())
            .map(([meetingId, { title, score }]) => ({
              meetingId,
              meetingTitle: title,
              score,
              date: dateMap.get(meetingId),
            }))
            .sort((a, b) => b.score - a.score);

          return { results, contextText };
        };

        let contactsCache: Contact[] | null = null;
        const meetingByMeetingId = new Map(allMeetings.map(m => [m.meetingId, m]));
        const contentCache = new Map<string, { transcription: string; summary: string; notes: string }>();

        const loadMeetingContent = async (meetingId: string) => {
          const hit = contentCache.get(meetingId);
          if (hit) return hit;
          const inMemory = meetingByMeetingId.get(meetingId);
          let transcription = inMemory?.transcription ?? '';
          let summary = inMemory?.summary ?? '';
          let notes = inMemory?.notes ?? '';
          if (!transcription.trim() || !summary.trim() || !notes.trim()) {
            try {
              const full = await getTaskById(meetingId);
              if (full) {
                if (!transcription.trim() && full.transcription) transcription = full.transcription;
                if (!summary.trim() && full.summary) summary = full.summary;
                if (!notes.trim() && (full as any).notes) notes = (full as any).notes;
              }
            } catch (err) {
              log.warn?.('contacts_lazy_load_failed', { meetingId, message: (err as Error)?.message });
            }
          }
          const payload = { transcription, summary, notes };
          contentCache.set(meetingId, payload);
          return payload;
        };

        const extractTranscriptExcerpt = (transcription: string, name: string, maxChars = 1800): string => {
          if (!transcription.trim()) return '';
          const lowered = transcription.toLowerCase();
          const needle = name.toLowerCase();
          const idx = lowered.indexOf(needle);
          if (idx === -1) {
            return transcription.slice(0, maxChars);
          }
          const start = Math.max(0, idx - Math.floor(maxChars / 2));
          const end = Math.min(transcription.length, start + maxChars);
          return (start > 0 ? '…' : '') + transcription.slice(start, end) + (end < transcription.length ? '…' : '');
        };

        const contactsSearchFn = async (query: string, limit?: number) => {
          const [, kgEntries] = await Promise.all([
            (async () => {
              if (contactsCache) return;
              try { contactsCache = await getContacts(); }
              catch (err) {
                log.error('contacts_lookup_failed', { message: (err as Error)?.message });
                contactsCache = [];
              }
            })(),
            loadKG(),
          ]);

          const cap = Math.min(Math.max(limit ?? 5, 1), 10);
          const q = (query || '').trim().toLowerCase();
          const qEscaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

          const matchedContacts = (contactsCache ?? [])
            .map(c => {
              const hay = [c.name, c.email ?? '', c.role ?? '', c.company ?? ''].join('\n').toLowerCase();
              if (!q) return { c, score: c.meeting_count };
              if (!hay.includes(q)) return { c, score: 0 };
              const nameMatch = c.name.toLowerCase().includes(q) ? 10 : 0;
              return { c, score: nameMatch + (hay.match(new RegExp(qEscaped, 'g'))?.length ?? 0) };
            })
            .filter(s => s.score > 0)
            .sort((a, b) => b.score - a.score)
            .slice(0, cap)
            .map(s => s.c);

          const kgEntriesByTaskId = new Map<string, KnowledgeGraphEntry>();
          for (const entry of kgEntries) {
            if (entry.task_id) kgEntriesByTaskId.set(entry.task_id, entry);
          }

          const kgMentions = new Set<string>();
          if (q) {
            for (const entry of kgEntries) {
              const peopleArr = entry.people ?? [];
              const owners = (entry.action_items ?? []).map(a => a.owner ?? '');
              const haystack = [...peopleArr, ...owners].join('\n').toLowerCase();
              if (haystack.includes(q)) kgMentions.add(entry.task_id);
            }
          }

          const contacts = matchedContacts.map(c => ({
            name: c.name,
            role: c.role,
            company: c.company,
            email: c.email,
            meeting_count: c.meeting_count,
            task_ids: c.task_ids,
            last_seen: c.last_seen,
          }));

          const meetingIdUnion = new Set<string>();
          for (const c of matchedContacts) for (const id of c.task_ids) meetingIdUnion.add(id);
          for (const id of kgMentions) meetingIdUnion.add(id);

          if (matchedContacts.length === 0 && kgMentions.size === 0) {
            return {
              contacts,
              meetings: [],
              contextText: `No matches in the People directory or Knowledge Graph for "${query}". If you believe the user meant someone whose name only appears inside transcripts, you may fall back to search_notes. Otherwise tell the user no such person was found.`,
            };
          }

          const allMeetingsForQuery = Array.from(meetingIdUnion)
            .map(id => {
              const meta = meetingByMeetingId.get(id);
              const dateStr = dateMap.get(id);
              return {
                id,
                title: meta?.title ?? kgEntriesByTaskId.get(id)?.meeting_title ?? '',
                dateStr,
              };
            })
            .filter(m => !!m.title);

          // Full history (no 30-day cap): build deep evidence for the person's
          // most recent meetings (capped for token budget); the rest are listed
          // as titles. This fixes "you said X wasn't in any meetings" when the
          // person only appears in older meetings.
          const EVIDENCE_CAP = 15;
          const byRecency = allMeetingsForQuery
            .slice()
            .sort((a, b) => (b.dateStr ?? '').localeCompare(a.dateStr ?? ''));
          const last30 = byRecency.slice(0, EVIDENCE_CAP);
          const olderMeetings = byRecency.slice(EVIDENCE_CAP, EVIDENCE_CAP + 30);

          const surfacedMeetings = last30.map(m => ({
            meetingId: m.id,
            meetingTitle: m.title,
            score: 1,
            date: m.dateStr,
          }));

          const contactHeaders = matchedContacts.map(c => {
            const headerParts = [
              c.name,
              c.role ? `— ${c.role}` : '',
              c.company ? `at ${c.company}` : '',
              c.email ? `(${c.email})` : '',
            ].filter(Boolean).join(' ');
            const lastSeen = c.last_seen
              ? new Date(c.last_seen).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : 'unknown';
            return `- ${headerParts} • total meetings: ${c.meeting_count} • last seen: ${lastSeen}`;
          });

          const evidenceBlocks = await Promise.all(
            last30.map(async (m, idx) => {
              const [{ transcription, summary, notes }, kg] = [
                await loadMeetingContent(m.id),
                kgEntriesByTaskId.get(m.id),
              ];
              const dateLabel = m.dateStr
                ? new Date(m.dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                : 'unknown date';

              const fromContacts = matchedContacts.some(c => c.task_ids.includes(m.id));
              const fromKG = kgMentions.has(m.id);
              const sourceTag = fromContacts && fromKG
                ? 'attended (People directory) + mentioned (Knowledge Graph)'
                : fromContacts
                  ? 'attended (People directory)'
                  : 'mentioned (Knowledge Graph)';

              const kgBlock = kg
                ? [
                    kg.people?.length ? `Participants/mentions: ${kg.people.join(', ')}` : '',
                    kg.topics?.length
                      ? `Topics: ${kg.topics.map(t => `• ${t.name}${t.status ? ` (${t.status})` : ''}${t.summary ? ` — ${t.summary.slice(0, 240)}` : ''}`).join('\n')}`
                      : '',
                    kg.decisions?.length
                      ? `Decisions: ${kg.decisions.map(d => `• ${d.decision}${d.relatedTopic ? ` [topic: ${d.relatedTopic}]` : ''}`).join('\n')}`
                      : '',
                    kg.action_items?.length
                      ? `Action items: ${kg.action_items.map(a => `• ${a.task}${a.owner ? ` (owner: ${a.owner})` : ''}${a.relatedTopic ? ` [topic: ${a.relatedTopic}]` : ''}`).join('\n')}`
                      : '',
                  ].filter(Boolean).join('\n')
                : '(no Knowledge Graph entry available)';

              const notesBlock = notes.trim() ? `NOTES:\n${notes.slice(0, 1400)}` : '';
              const summaryBlock = summary.trim() ? `SUMMARY (AI-generated, may contain errors):\n${summary.slice(0, 1200)}` : '';
              const transcriptExcerpt = extractTranscriptExcerpt(transcription, query || matchedContacts[0]?.name || '', 1800);
              const transcriptBlock = transcriptExcerpt.trim() ? `TRANSCRIPT EXCERPT:\n${transcriptExcerpt}` : '';

              const bodyParts = [
                `KNOWLEDGE GRAPH:\n${kgBlock}`,
                notesBlock,
                summaryBlock,
                transcriptBlock,
              ].filter(Boolean);

              return `--- Meeting ${idx + 1}: "${m.title}" (${dateLabel}) [task_id: ${m.id}] [source: ${sourceTag}] ---\n${bodyParts.join('\n\n') || '(no content available for this meeting)'}`;
            })
          );

          const olderRows = olderMeetings.map(m => {
            const d = m.dateStr
              ? new Date(m.dateStr).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
              : 'unknown date';
            return `  - "${m.title}" (${d}) [task_id: ${m.id}]`;
          });

          const contextText = [
            `=== PERSON LOOKUP for "${query}" ===`,
            `Sources cross-referenced: People directory (AWS /contacts) AND Knowledge Graph (AWS /knowledge-graph).`,
            matchedContacts.length
              ? `People-directory matches (${matchedContacts.length}):\n${contactHeaders.join('\n')}`
              : `No exact People-directory match — fell back to Knowledge Graph mentions across meetings.`,
            `=== EVIDENCE: ${last30.length} most-recent meeting${last30.length !== 1 ? 's' : ''} across full history (union of attended + mentioned) ===`,
            last30.length ? evidenceBlocks.join('\n\n') : '(no meetings found for this person)',
            olderMeetings.length
              ? `=== OLDER MEETINGS (titles only) ===\n${olderRows.join('\n')}`
              : '',
            `Instruction: Answer the user's question DIRECTLY from the EVIDENCE above, covering ALL listed meetings. Do not call search_notes for this person — the union of People directory + Knowledge Graph is the authoritative scope.`,
          ].filter(Boolean).join('\n\n');

          return { contacts, meetings: surfacedMeetings, contextText };
        };

        // SUB-AGENT (P4): the parent agent delegates broad per-meeting work here.
        // We scope the meetings (explicit ids > recent_days > all), then run the
        // SAME map-reduce as the extract route — each meeting read in full by its
        // own focused call — and hand the parent ONE synthesized result. The parent
        // never pulls those transcripts into its own context window.
        const analyzeMeetingsFn = async (
          instructions: string,
          opts: { meetingIds?: string[]; recentDays?: number },
        ) => {
          let scoped = allMeetings;
          if (opts.meetingIds?.length) {
            const idset = new Set(opts.meetingIds);
            scoped = allMeetings.filter(m => idset.has(m.meetingId));
          } else if (opts.recentDays && opts.recentDays > 0) {
            const cutoff = Date.now() - opts.recentDays * 24 * 60 * 60 * 1000;
            scoped = allMeetings.filter(m => {
              const d = dateMap.get(m.meetingId);
              if (!d) return true; // unknown date → keep, never silently drop
              return new Date(d).getTime() >= cutoff;
            });
          }
          const sorted = [...scoped].sort((a, b) =>
            new Date(dateMap.get(b.meetingId) || 0).getTime() - new Date(dateMap.get(a.meetingId) || 0).getTime());
          const notCoveredCount = Math.max(0, sorted.length - DEEP_ANALYSIS_CEILING);
          if (notCoveredCount > 0) {
            log.debug('analyze_scope_capped', { capped: DEEP_ANALYSIS_CEILING, total: sorted.length });
          }
          const refs = sorted.slice(0, DEEP_ANALYSIS_CEILING).map(m => ({
            meetingId: m.meetingId,
            title: m.title,
            dateLabel: dateLabelFor(m.meetingId),
          }));
          if (!refs.length) {
            return { contextText: 'No meetings matched that scope.', results: [] };
          }
          // Stream each meeting the sub-agent reads as a nested sub-step, then the
          // synthesis — the way the reference's Task surfaces its child tool calls.
          const readDone: AgentStep[] = [];
          const synthesis = await extractAcrossMeetings({
            instructions,
            meetings: refs,
            loadContent: loadMeetingFullContent,
            concurrency: 4,
            onProgress: (ev) => {
              if (ev.phase === 'map') {
                readDone.push({
                  id: `analyze-read-${readDone.length}`,
                  label: ev.title,
                  status: 'done',
                  detail: ev.hadItems ? undefined : 'nothing relevant',
                });
                updateAnalyzeProgress(
                  ev.completed < ev.total
                    ? [...readDone, { id: 'analyze-reading', label: `Reading meetings in full… (${ev.completed}/${ev.total})`, status: 'running' }]
                    : [...readDone],
                );
              } else if (ev.phase === 'reduce') {
                updateAnalyzeProgress([
                  ...readDone,
                  { id: 'analyze-synth', label: `Synthesizing findings across ${ev.withItems} meeting${ev.withItems !== 1 ? 's' : ''}`, status: 'running' },
                ]);
              }
            },
          });
          // Finalize: every read done + synthesis done.
          updateAnalyzeProgress([...readDone, { id: 'analyze-synth', label: 'Synthesized findings', status: 'done' }]);
          // Disclose any uncovered tail back to the agent so it relays it (no silent cap).
          const contextText = notCoveredCount > 0
            ? `${synthesis}\n\n[COVERAGE: read the ${refs.length} most recent of ${sorted.length} meetings in this scope IN FULL. ${notCoveredCount} older meeting${notCoveredCount !== 1 ? 's were' : ' was'} NOT covered — tell the user this and offer to continue with the older ones.]`
            : synthesis;
          return {
            contextText,
            results: refs.map(r => ({
              meetingId: r.meetingId,
              meetingTitle: r.title,
              score: 1,
              date: dateMap.get(r.meetingId),
            })),
          };
        };

        // P3 (rolling compaction safety): bound how many single-meeting reads the
        // agentic loop may accumulate in one turn, so context can't balloon from a
        // huge read fan-out. Past the budget, nudge the model to analyze_meetings
        // (which fans out + folds into ONE compact result) instead of more reads.
        let agenticReadCount = 0;
        const AGENTIC_READ_BUDGET = 30;

        response = await agentChatAllMeetings(
          userInput,
          msgHistory,
          allMeetings.map(m => ({
            meetingId: m.meetingId,
            title: m.title,
            transcription: m.transcription,
            summary: m.summary,
            notes: m.notes,
            createdAt: dateMap.get(m.meetingId),
          })),
          {
            searchFn: turbopufferSearchFn,
            contactsFn: contactsSearchFn,
            // Read ONE meeting in FULL on demand (Read-style tool). Hydrates from
            // the server when the paginated history omitted notes/transcript, so
            // per-meeting extraction sees complete content, not a snippet.
            readNotesFn: async (meetingId: string) => {
              if (++agenticReadCount > AGENTIC_READ_BUDGET) {
                return {
                  title: undefined,
                  contextText: `Read budget reached for this turn (${AGENTIC_READ_BUDGET} meetings). For broader coverage, call analyze_meetings — it reads every meeting in scope in full and returns one synthesized result — instead of more individual read_meeting_notes calls.`,
                };
              }
              const doc = allMeetings.find(m => m.meetingId === meetingId);
              let notes = (doc?.notes ?? '').trim();
              let summary = (doc?.summary ?? '').trim();
              let transcription = (doc?.transcription ?? '').trim();
              if (!notes && !summary && !transcription) {
                try {
                  const full = await getTaskById(meetingId);
                  if (full) { notes = (full.notes ?? '').trim(); summary = (full.summary ?? '').trim(); transcription = (full.transcription ?? '').trim(); }
                } catch { /* offline / not found */ }
              }
              const title = doc?.title || 'Untitled meeting';
              const dateStr = dateMap.get(meetingId);
              const dateLabel = dateStr
                ? new Date(dateStr).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })
                : 'unknown date';
              // Compaction: keep NOTES + SUMMARY in full (they hold the action
              // items/decisions), but cap the verbose TRANSCRIPT so reading many
              // meetings in one extraction run stays within the context window.
              const body = [
                notes ? `NOTES:\n${notes}` : '',
                summary ? `SUMMARY:\n${summary}` : '',
                transcription ? `TRANSCRIPT:\n${transcription.length > 6000 ? `${transcription.slice(0, 6000)}… [transcript truncated — NOTES above are the authoritative source]` : transcription}` : '',
              ].filter(Boolean).join('\n\n');
              return {
                title,
                contextText: `=== ${title} (${dateLabel}) [task_id: ${meetingId}] ===\n${body || '(No notes generated for this meeting.)'}`,
              };
            },
            analyzeMeetingsFn,
            onPlan: ({ intent, steps }) => {
              updateAgentMessage(prev => ({
                agentStatus: 'planning',
                agentPlan: [
                  {
                    id: 'plan',
                    label: intent,
                    status: 'done' as const,
                    type: 'plan' as const,
                    planSteps: steps,
                  },
                  ...(prev.agentPlan ?? []),
                ],
              }));
            },
            onToolCallStart: (step) => {
              const isContacts = step.kind === 'contacts';
              const isAnalyze = step.kind === 'analyze';
              const isRead = step.kind === 'read';
              updateAgentMessage(prev => ({
                agentStatus: 'executing',
                agentPlan: [
                  ...(prev.agentPlan ?? []),
                  {
                    id: `search-${step.callId}`,
                    label: isAnalyze ? (step.query || 'Analyzing meetings in depth')
                      : isRead ? 'Reading meeting'
                      : isContacts ? 'Searching people' : 'Searching notes',
                    status: 'running' as const,
                    type: 'search-tool' as const,
                    searchKind: isAnalyze ? 'analyze' as const : isRead ? 'read' as const : isContacts ? 'people' as const : 'notes' as const,
                    // For a read, the query is a task_id at start; the human title arrives on done.
                    searchQuery: (isAnalyze || isRead) ? '' : (step.query || ''),
                  },
                ],
              }));
            },
            onToolCallDone: (step) => {
              if (step.results?.length) {
                responseCitations = step.results.map(r => ({
                  meetingId: r.meetingId,
                  meetingTitle: r.meetingTitle,
                  chunkId: '',
                  score: r.score,
                }));
                const topScore = step.results[0]?.score ?? 0;
                const avgScore = step.results.slice(0, 3).reduce((s, r) => s + r.score, 0) / Math.min(step.results.length, 3);
                const derivedConfidence = step.kind === 'contacts'
                  ? Math.min(0.95, 0.6 + step.results.length * 0.05)
                  : Math.min(0.95, Math.max(0.2, (topScore + avgScore) / 2));
                responseRetrievalMeta = {
                  scope: 'many',
                  confidence: derivedConfidence,
                  selectedMeetingIds: step.results.map(r => r.meetingId),
                  tokenUsageTotal: undefined,
                  coveredMeetingsCount: step.results.length,
                  totalMeetingsCount: allMeetings.length,
                };
              }
              updateAgentMessage(prev => ({
                agentPlan: prev.agentPlan?.map(s => {
                  if (s.id !== `search-${step.callId}`) return s;
                  if (step.kind === 'contacts') {
                    const foundPeople = step.contacts?.length ?? 0;
                    const foundMeetings = step.results?.length ?? 0;
                    const detail = foundPeople || foundMeetings
                      ? foundMeetings
                        ? `Found ${foundPeople} ${foundPeople === 1 ? 'person' : 'people'} across ${foundMeetings} meeting${foundMeetings !== 1 ? 's' : ''}`
                        : `Found ${foundPeople} ${foundPeople === 1 ? 'person' : 'people'} (no meetings in last 30 days)`
                      : 'No matching people';
                    return {
                      ...s,
                      status: 'done' as const,
                      detail,
                      searchResults: step.results?.map(r => ({
                        meetingId: r.meetingId,
                        meetingTitle: r.meetingTitle,
                        score: r.score,
                      })),
                    };
                  }
                  if (step.kind === 'analyze') {
                    return {
                      ...s,
                      status: 'done' as const,
                      detail: step.results?.length
                        ? `Read ${step.results.length} meeting${step.results.length !== 1 ? 's' : ''} in full`
                        : 'Analysis complete',
                      searchResults: step.results?.map(r => ({
                        meetingId: r.meetingId,
                        meetingTitle: r.meetingTitle,
                        score: r.score,
                      })),
                    };
                  }
                  if (step.kind === 'read') {
                    // The human-readable meeting title arrives as step.query on done.
                    return {
                      ...s,
                      status: 'done' as const,
                      label: step.query ? `Read ${step.query}` : 'Read meeting',
                    };
                  }
                  return {
                    ...s,
                    status: 'done' as const,
                    detail: step.results?.length
                      ? `Found ${step.results.length} meeting${step.results.length !== 1 ? 's' : ''}`
                      : 'No results found',
                    searchResults: step.results?.map(r => ({
                      meetingId: r.meetingId,
                      meetingTitle: r.meetingTitle,
                      score: r.score,
                    })),
                  };
                }),
              }));
            },
          }
        );
        } // end agentic (non-extract) path
      }

      // ═══════════ PHASE 4: DONE — replace agent placeholder with final response ═══════════
      // Build the final message lazily inside setChatMessages so we can carry agentPlan
      // from the in-flight placeholder (which accumulated search steps).
      let modelMessage: Message = {
        role: 'model',
        text: response,
        agentStatus: 'done',
        citations: responseCitations,
        retrievalMeta: responseRetrievalMeta,
      };
      // Read the plan from the synchronous ref — NOT from inside the setState
      // updater, which runs async and left agent_plan undefined at save time.
      const savedAgentPlan: AgentStep[] | undefined = liveAgentPlanRef.current;
      modelMessage = { ...modelMessage, agentPlan: savedAgentPlan };
      setChatMessages(prev => {
        return [...prev.filter(m => !(m.role === 'model' && m.agentStatus && m.agentStatus !== 'done')), modelMessage];
      });

      const chatSaveMeta = {
        citations: responseCitations?.map((c) => ({
          meeting_id: c.meetingId,
          meeting_title: c.meetingTitle,
          chunk_id: c.chunkId,
          score: c.score,
        })),
        retrieval_meta: responseRetrievalMeta
          ? {
              scope: responseRetrievalMeta.scope,
              confidence: responseRetrievalMeta.confidence,
              selected_meeting_ids: responseRetrievalMeta.selectedMeetingIds,
              token_usage_total: responseRetrievalMeta.tokenUsageTotal,
              covered_meetings_count: responseRetrievalMeta.coveredMeetingsCount,
              total_meetings_count: responseRetrievalMeta.totalMeetingsCount,
            }
          : undefined,
        agent_status: 'done' as const,
        agent_plan: savedAgentPlan?.map(s => ({
          id: s.id,
          label: s.label,
          status: s.status,
          detail: s.detail,
          type: s.type,
          search_kind: s.searchKind,
          search_query: s.searchQuery,
          search_results: s.searchResults?.map(r => ({
            meeting_id: r.meetingId,
            meeting_title: r.meetingTitle,
            score: r.score,
          })),
          plan_steps: s.planSteps,
        })),
      };

      if (!selectedTask) {
        setAllMeetingsChatMessages(prev => [...prev, modelMessage]);
        saveChatMessage({
          role: 'model',
          text: response,
          thread_id: currentThreadId ?? ALL_MEETINGS_THREAD_ID,
          ...chatSaveMeta,
        }).catch(err => log.warn('persist_all_meetings_model_msg_failed', { error: err instanceof Error ? err : undefined }));
      } else if (selectedTask && selectedTask.id) {
        await saveChatMessage({
          task_id: selectedTask.id,
          role: 'model',
          text: response,
          thread_id: currentThreadId ?? `task:${selectedTask.id}`,
          ...chatSaveMeta,
        });
      }
      void persistChatThreadToCache(selectedTask?.id ?? null);
    } catch (err) {
      // Turn-level error boundary: NEVER surface a raw error mid-response. Replace the
      // in-flight placeholder with a calm, actionable message and keep the chat usable.
      log.error('chat_error', { error: err instanceof Error ? err : undefined });
      const friendly = "I wasn't able to finish that one. If you were asking across a very large history, try narrowing it to a time window (e.g. “this month”) or a specific topic/person and I'll get it — or ask me to try again.";
      setChatMessages(prev => {
        const cleaned = prev.filter(m => !(m.role === 'model' && m.agentStatus && m.agentStatus !== 'done'));
        return [...cleaned, { role: 'model', text: friendly }];
      });
    } finally {
      setIsChatting(false);
    }
  };

  const handleVisualize = async (description: string) => {
    if (isGeneratingImage || !selectedTask) return;
    
    setIsGeneratingImage(true);
    setChatMessages(prev => [...prev, { role: 'model', text: `Generating visualization for: "${description}"...` }]);

    try {
      const imageUrl = await generateConceptImage(description);
      if (imageUrl) {
        const visualMessage = { role: 'model' as const, text: `Here is the visualization for: "${description}"`, image: imageUrl };
        setChatMessages(prev => [
          ...prev.slice(0, -1), 
          visualMessage
        ]);
        // Save visualization message to Supabase
        await saveChatMessage({
          task_id: selectedTask.id!,
          role: 'model',
          text: visualMessage.text,
          image: imageUrl,
          thread_id: activeThreadIdRef.current ?? `task:${selectedTask.id}`,
        });
        void persistChatThreadToCache(selectedTask.id ?? null);
      } else {
        setChatMessages(prev => [
          ...prev.slice(0, -1), 
          { role: 'model', text: 'Failed to generate visualization. Please try a different description.' }
        ]);
      }
    } catch (err) {
      log.error('image_generation_error', { error: err instanceof Error ? err : undefined });
      setChatMessages(prev => [
        ...prev.slice(0, -1), 
        { role: 'model', text: 'Error generating visualization.' }
      ]);
    } finally {
      setIsGeneratingImage(false);
    }
  };

  const refreshManualNotesFromCloud = async (opts?: { silent?: boolean }) => {
    try {
      if (!opts?.silent) setIsLoadingManualNotes(true);
      const notes = await getManualNotes();
      setManualNotesList(notes);
      const uid = await getUserId().catch(() => null);
      if (uid) await cacheSet(`notes:${uid}`, notes);
    } catch (err) {
      log.error('fetch_manual_notes_failed', { error: err instanceof Error ? err : undefined });
    } finally {
      if (!opts?.silent) setIsLoadingManualNotes(false);
    }
  };

  const fetchHistory = async (skipBlockingSpinner = false) => {
    try {
      if (!skipBlockingSpinner) setIsLoadingHistory(true);
      const uid = await getUserId().catch(() => null);
      if (uid) await loadUserLedgerState(uid);

      const result = await getTasksLightweight(0, HISTORY_PAGE_SIZE);
      setHistory(result.data as TaskHistory[]);
      setHasMoreHistory(result.hasMore);
      setTotalHistoryCount(result.total);
      historyPageRef.current = 0;

      if (uid) {
        await cacheSet(`tasks:${uid}`, {
          list: result.data as TaskHistory[],
          hasMore: result.hasMore,
          total: result.total,
          pageLoaded: 0,
        });
      }

      // Turbopuffer backfill is a background indexing chore — defer it until the
      // app is idle so it never competes with first render or the initial data
      // fetches. The ledger gate inside makes repeat runs essentially free.
      const runBackfill = () =>
        deferredBackfill().catch(err => log.warn('turbopuffer_backfill_error', { error: err instanceof Error ? err : undefined }));
      const ric = (window as any).requestIdleCallback as undefined | ((cb: () => void, opts?: { timeout: number }) => void);
      if (ric) ric(runBackfill, { timeout: 8000 });
      else setTimeout(runBackfill, 4000);
    } catch (err) {
      log.error('fetch_history_failed', { error: err instanceof Error ? err : undefined });
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // W3: switching the active workspace (vault) reloads the WHOLE app for that vault.
  // Every per-workspace cache + in-memory list is invalidated so the previous vault's
  // data can never bleed through, then the new vault's data is refetched and the user
  // lands back on Home — a clean context swap (like the reference's session switch).
  const switchWorkspaceReload = async () => {
    log.info('workspace_switch_reload');
    // 1. invalidate per-workspace caches + transient cursors
    allMetaCacheRef.current = null;
    extractCursorRef.current = null;
    lastChatFetchTaskIdRef.current = null;
    lastAssetsFetchTaskIdRef.current = null;
    // 2. clear per-workspace in-memory state (NOT user-level: plan/ledger/entitlements stay)
    setSelectedTask(null);
    setHistory([]);
    setChatMessages([]);
    setAllMeetingsChatMessages([]);
    setChatThreads([]);
    setActiveThread(null);
    setActiveChatThreadId(null);
    setKgData([]); setKgBuilt(false); setSelectedNode(null);
    setAgentAssetHistory([]); setSelectedAgentAsset(null);
    setManualNotesList([]);
    // 3. land on Home for the new vault
    setSelectedTask(null);
    setCurrentView('process');
    // 4. refetch the new vault's data (history state + chat threads, both workspace-scoped)
    const uid = await getUserId().catch(() => null);
    await Promise.all([
      fetchHistory(true),
      uid ? primeFromBootstrap(uid) : Promise.resolve(),
    ]);
  };

  // Fire the full reload whenever the active workspace id actually changes (not on the
  // initial selection, where the app is already loading).
  useEffect(() => {
    const cur = activeWorkspaceSelection.workspaceId;
    const prev = prevWorkspaceIdRef.current;
    if (prev === null) { prevWorkspaceIdRef.current = cur; return; } // initial selection — skip
    if (!cur || cur === prev) return;
    prevWorkspaceIdRef.current = cur;
    void switchWorkspaceReload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeWorkspaceSelection.workspaceId]);

  const loadMoreHistory = async () => {
    const nextPage = historyPageRef.current + 1;
    try {
      const uid = await getUserId().catch(() => null);
      const result = await getTasksLightweight(nextPage, HISTORY_PAGE_SIZE);
      setHistory(prev => {
        const merged = [...prev, ...(result.data as TaskHistory[])];
        if (uid) {
          void cacheSet(`tasks:${uid}`, {
            list: merged,
            hasMore: result.hasMore,
            total: result.total,
            pageLoaded: nextPage,
          });
        }
        return merged;
      });
      setHasMoreHistory(result.hasMore);
      setTotalHistoryCount(result.total);
      historyPageRef.current = nextPage;
    } catch (err) {
      log.error('load_more_history_failed', { error: err instanceof Error ? err : undefined });
    }
  };

  const deferredBackfill = async () => {
    try {
      // Nothing to index into Turbopuffer? Don't touch AWS at all.
      if (!isTurbopufferConfigured()) return;

      const allMeta = await getAllTaskIds();
      // Filter against the local index ledger FIRST so we never re-fetch the
      // (heavy) transcription of meetings we've already indexed. Previously this
      // pulled up to 50 full transcriptions from AWS on every launch, even when
      // everything was already indexed — the biggest source of needless calls.
      const candidates = allMeta.filter(
        t => t.id && t.status === 'completed' && !isAlreadyIndexed(t.id)
      );
      if (candidates.length === 0) return; // already fully indexed — skip all getTaskById calls

      const toBackfill: { id: string; title: string; transcription: string }[] = [];
      for (const meta of candidates.slice(0, 50)) {
        const full = await getTaskById(meta.id);
        if (full?.transcription?.trim()) {
          toBackfill.push({ id: full.id!, title: full.filename || 'Untitled', transcription: full.transcription });
        }
      }
      if (toBackfill.length > 0) {
        await backfillExistingMeetings(toBackfill);
      }
    } catch (err) {
      log.warn('deferred_backfill_error', { error: err instanceof Error ? err : undefined });
    }
  };

  // Handler to update a task in history (e.g., when title is regenerated)
  const handleTaskUpdated = (updatedTask: TaskHistory) => {
    setHistory(prev => {
      const next = prev.map(task =>
        task.id === updatedTask.id ? { ...task, ...updatedTask } : task
      );
      void getUserId().then(async uid => {
        if (!uid || !updatedTask.id) return;
        const merged = next.find(t => t.id === updatedTask.id);
        if (merged?.id) await cacheSet(`task:${merged.id}`, merged);
        const payload = await cacheGet<CachedHistoryPayload>(`tasks:${uid}`);
        if (payload) {
          await cacheSet(`tasks:${uid}`, {
            ...payload,
            list: next,
          });
        }
      });
      return next;
    });
    if (selectedTask?.id === updatedTask.id) {
      setSelectedTask(prev => prev ? { ...prev, ...updatedTask } : updatedTask);
    }
  };

  // GLOBAL SYNC: a note moved between spaces/folders ANYWHERE (note picker, history
  // row, space page) updates the shared history list + the open note + the cache, so
  // every page reflects the new location without a manual refresh or page visit.
  useEffect(() => {
    const off = onVaultEvent('notes:changed', ({ taskId, spaceId, folderId }) => {
      setHistory(prev => {
        const next = prev.map(t => t.id === taskId ? { ...t, space_id: spaceId, folder_id: folderId } : t);
        void getUserId().then(async uid => {
          if (!uid) return;
          const merged = next.find(t => t.id === taskId);
          if (merged?.id) await cacheSet(`task:${merged.id}`, merged);
          const payload = await cacheGet<CachedHistoryPayload>(`tasks:${uid}`);
          if (payload) await cacheSet(`tasks:${uid}`, { ...payload, list: next });
        });
        return next;
      });
      setSelectedTask(prev => prev && prev.id === taskId ? { ...prev, space_id: spaceId, folder_id: folderId } : prev);
    });
    return off;
  }, []);

  const handleDeleteManualNote = async (id: string) => {
    await deleteManualNote(id);
    setManualNotesList(prev => {
      const next = prev.filter(n => n.id !== id);
      void getUserId().then(uid => {
        if (uid) void cacheSet(`notes:${uid}`, next);
      });
      return next;
    });
  };

  useEffect(() => {
    const uid = session?.user?.id;
    if (!uid) return;
    let cancelled = false;

    const run = async () => {
      const userId = await getUserId().catch(() => null);
      if (!userId || userId !== uid || cancelled) return;

      let hadTaskCache = false;
      const cachedHist = await cacheGet<CachedHistoryPayload>(`tasks:${userId}`);
      if (cachedHist?.list?.length && !cancelled) {
        hadTaskCache = true;
        setHistory(cachedHist.list);
        setHasMoreHistory(!!cachedHist.hasMore);
        setTotalHistoryCount(cachedHist.total ?? cachedHist.list.length);
        historyPageRef.current = cachedHist.pageLoaded ?? 0;
        setIsLoadingHistory(false);
      }

      const cachedKg = await cacheGet<KnowledgeGraphEntry[]>(`kg:${userId}`);
      if (cachedKg?.length && !cancelled) {
        const transformed = cachedKg.map(entry => ({
          meetingId: entry.task_id,
          meetingTitle: entry.meeting_title,
          meetingDate: entry.created_at,
          topics: entry.topics || [],
          decisions: entry.decisions || [],
          people: entry.people || [],
          actionItems: entry.action_items || [],
          references: entry.refs || []
        }));
        setKgData(transformed);
        setKgBuilt(true);
        const supabaseIds = new Set(cachedKg.map(e => e.task_id));
        markKGExtractedBatch(Array.from(supabaseIds));
        reconcileKGLedger(supabaseIds);
      }

      const cachedNotes = await cacheGet<ManualNote[]>(`notes:${userId}`);
      if (cachedNotes !== null && !cancelled) {
        setManualNotesList(cachedNotes);
        setIsLoadingManualNotes(false);
      }

      await Promise.all([
        fetchHistory(hadTaskCache),
        fetchKnowledgeGraph(),
        refreshManualNotesFromCloud({ silent: cachedNotes !== null }),
      ]);
    };

    void run();
    return () => { cancelled = true; };
  }, [session?.user?.id]);

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
      // Free-tier gate: block uploading a new meeting once the quota is used up.
      if (!requireMeetingQuota()) { e.target.value = ''; return; }
      fileSourceRef.current = 'upload';
      setFile(selectedFile);
      setError(null);
      setStatus('idle');
      setBatches([]);
    }
  };

  // Helper function to deduplicate overlapping transcription chunks
  const deduplicateOverlappingTranscriptions = (transcriptions: string[]): string => {
    if (transcriptions.length <= 1) {
      return transcriptions.join('\n\n');
    }

    // Chunked path: speakers are numbered independently per chunk, so we reconcile
    // them at each seam (see reconcileLeadingSpeaker). Surface that we chunked so a
    // residual numbering wobble isn't mistaken for a silent failure.
    log.info('transcript_stitch_chunked', { chunks: transcriptions.length });

    const result: string[] = [transcriptions[0]];

    for (let i = 1; i < transcriptions.length; i++) {
      // Anchor against the transcript assembled so far (not the raw neighbour) so
      // speaker remappings chain consistently across multiple seams.
      const prev = result[result.length - 1];
      const curr = transcriptions[i];

      if (!prev || !curr) {
        result.push(curr || '');
        continue;
      }

      // Find overlapping content by looking for common phrases
      // Take the last ~200 chars of prev and first ~200 chars of curr
      const prevEnd = prev.slice(-300).toLowerCase();
      const currStart = curr.slice(0, 300).toLowerCase();

      // Find the longest common substring
      let bestOverlap = 0;

      // Look for phrases of at least 20 chars that appear in both
      for (let len = Math.min(100, currStart.length); len >= 20; len--) {
        const phrase = currStart.slice(0, len);
        const idx = prevEnd.lastIndexOf(phrase);
        if (idx !== -1) {
          bestOverlap = len;
          break;
        }
      }

      // Drop the duplicated overlap from the current chunk, then align its leading
      // speaker number to the numbering already established (overlap anchor).
      const trimmed = bestOverlap > 20 ? curr.slice(bestOverlap).trim() : curr;
      result.push(reconcileLeadingSpeaker(prev, trimmed));
    }

    return result.filter(t => t.trim()).join('\n\n');
  };

  const startProcessing = async (resumeFromProgress?: ProcessingProgress, explicitFile?: File) => {
    if (!file && !resumeFromProgress && !explicitFile) return;

    try {
      setAwaitingNetworkResume(false);
      const currentFile = explicitFile || file || (resumeFromProgress?.audioBlob ? new File([resumeFromProgress.audioBlob], resumeFromProgress.filename) : null);
      if (!currentFile) {
        throw new Error('No audio file available');
      }

      let fullTranscription: string = '';
      
      // ─── Large File Path: Use Gemini File API ───────────────────────────────
      // Skip if the File API has failed multiple times in this session — avoids
      // wasting time and creating WebKit memory pressure from repeated large uploads.
      if (shouldUseFileAPI(currentFile) && !resumeFromProgress && !isFileApiDisabledByFailures()) {
        setStatus('processing');
        setError(null);
        setProcessingHeadline('Sending audio upstairs ☁️');
        setProcessingSubtext('Quick trip, be right back 🛫');
        setBatches([{
          blob: currentFile,
          mimeType: currentFile.type || 'audio/mpeg',
          index: 0,
          total: 1,
          startTime: 0,
          endTime: 0,
          status: 'processing'
        }]);

        try {
          // Upload to Gemini File API
          const { uri, name } = await uploadAudioToFileAPI(
            currentFile,
            currentFile.type || 'audio/mpeg',
            currentFile.name
          );

          // Wait for file to be ready
          await waitForFileActive(name);

          // Transcribe via File API (single call for entire file)
          fullTranscription = await transcribeViaFileAPI(uri, currentFile.type || 'audio/mpeg', withDictionaryPrompt(prompt), fileSourceRef.current);

          // Clean up uploaded file
          await deleteFromFileAPI(name);

          setBatches([{
            blob: currentFile,
            mimeType: currentFile.type || 'audio/mpeg',
            index: 0,
            total: 1,
            startTime: 0,
            endTime: 0,
            status: 'completed',
            result: fullTranscription
          }]);

        } catch (fileApiError: any) {
          log.warn('file_api_fallback', { error: fileApiError instanceof Error ? fileApiError : undefined });
          // Give WebKit time to release internal blob resources from the
          // failed upload before we start batch processing.
          await new Promise(r => setTimeout(r, 1500));
          // Fall through to batch processing
          fullTranscription = '';
        }
      }

      // ─── Standard Path: Batch Processing with Overlap ───────────────────────
      if (!fullTranscription) {
        let progressId: string;
        let audioBatches: AudioBatch[];
        let results: BatchStatus[];

        if (resumeFromProgress) {
          // Resume from saved progress
          progressId = resumeFromProgress.id;
          currentProgressIdRef.current = progressId;
          
          setStatus('processing');
          setPrompt(resumeFromProgress.prompt);
          setProcessingHeadline('Back in action 💪');
          setProcessingSubtext('Picking up where we paused ⏯️');
          
          // Reconstruct batches from saved progress
          results = resumeFromProgress.batches.map(b => ({
            blob: new Blob(), // Will be regenerated if needed
            mimeType: 'audio/wav',
            index: b.index,
            total: resumeFromProgress.totalBatches,
            startTime: b.startTime,
            endTime: b.endTime,
            status: b.status,
            result: b.result,
            error: b.error,
          }));
          
          setBatches(results);
          
          // Re-split audio to get batch blobs
          audioBatches = await splitAudio(currentFile, BATCH_CHUNK_SIZE_MB);
          
          // Merge blob data back into results
          results = results.map((r, idx) => ({
            ...r,
            blob: audioBatches[idx]?.blob || r.blob,
            mimeType: audioBatches[idx]?.mimeType || r.mimeType,
            overlapStart: audioBatches[idx]?.overlapStart,
          }));
        } else {
          // Fresh start
          progressId = generateProgressId(currentFile.name);
          currentProgressIdRef.current = progressId;
          
          setStatus('splitting');
          setError(null);
          setProcessingHeadline('Audio prep party 🎧');
          setProcessingSubtext('Cutting it nice and neat ✂️');

          // Split with overlapping chunks for better boundary handling.
          // Use default processing (normalize/noise-gate OFF, silence-removal ON)
          // so this MATCHES the resume / blob-eviction re-split calls below —
          // identical settings keep chunk boundaries deterministic across calls.
          audioBatches = await splitAudio(currentFile, BATCH_CHUNK_SIZE_MB, {
            overlapSeconds: 10,
          });
          const initialBatches: BatchStatus[] = audioBatches.map(b => ({ ...b, status: 'pending' as const }));
          setBatches(initialBatches);
          
          results = [...initialBatches];
          
          // Save initial progress
          await progressStorage.saveProgress({
            id: progressId,
            filename: currentFile.name,
            prompt,
            mode: 'batch',
            stage: 'batch-transcription',
            totalBatches: results.length,
            completedBatches: 0,
            batches: results.map(b => ({
              index: b.index,
              status: b.status,
              startTime: b.startTime,
              endTime: b.endTime,
            })),
            audioBlob: currentFile,
            createdAt: Date.now(),
            updatedAt: Date.now(),
          });
        }

        setStatus('processing');
        setProcessingHeadline('Listening with big ears 👂');
        setProcessingSubtext('Turning talk into gold 🪄');
        // Now that chunks are small and upload reliably, push more through at once.
        // gemini-3-flash-preview has generous RPM limits and withRetry() self-heals
        // any occasional 429, so 5-wide with a short stagger is safe and far faster
        // than the old 3-wide / 2.5s-apart pacing (which dominated wall-clock).
        const CONCURRENCY = 5;
        // Max times we'll retry a wave of chunks due to transient failures before
        // handing off to the offline-resume flow.
        const MAX_WAVE_RETRIES = 8;

        // Rate-limiter: stagger individual API calls so a wave doesn't fire all at
        // once. 800ms × 5 ≈ 75 req/min peak — well under the model's limit.
        const STAGGER_MS = 800;
        let nextBatchSlotAt = 0;
        const acquireBatchSlot = async () => {
          const wait = nextBatchSlotAt - Date.now();
          if (wait > 0) await new Promise(r => setTimeout(r, wait));
          nextBatchSlotAt = Date.now() + STAGGER_MS;
        };

        // Process only pending/error batches
        const batchesToProcess = results
          .map((b, idx) => ({ batch: b, originalIndex: idx }))
          .filter(({ batch }) => batch.status === 'pending' || batch.status === 'error');

        for (let i = 0; i < batchesToProcess.length; i += CONCURRENCY) {
          if (!navigator.onLine) {
            throw new Error('NETWORK_RESUME_REQUIRED');
          }

          const chunkEnd = Math.min(i + CONCURRENCY, batchesToProcess.length);
          const chunk = batchesToProcess.slice(i, chunkEnd);

          let waveRetry = 0;

          // Inner retry loop: keeps retrying this wave until every chunk in it
          // completes, the device goes offline, or we exhaust MAX_WAVE_RETRIES.
          while (true) {
            // Only (re)process chunks in this wave that aren't completed yet.
            // Include both 'pending' (network error) and 'error' (e.g. exhausted
            // per-call retries) so no batch is silently abandoned.
            const toProcess = chunk.filter(({ originalIndex }) =>
              results[originalIndex].status !== 'completed'
            );

            if (toProcess.length === 0) break; // whole wave done — advance outer loop

            if (!navigator.onLine) {
              throw new Error('NETWORK_RESUME_REQUIRED');
            }

            // Mark as processing
            toProcess.forEach(({ originalIndex }) => {
              results[originalIndex] = { ...results[originalIndex], status: 'processing' };
            });
            setBatches([...results]);

            // Process in parallel but staggered: each request acquires a slot
            // before firing so they never all hit the API at the exact same moment.
            let blobEvicted = false;
            await Promise.allSettled(
              toProcess.map(async ({ batch, originalIndex }) => {
                await acquireBatchSlot();
                try {
                  const result = await processAudioBatch(batch, withDictionaryPrompt(prompt), fileSourceRef.current);
                  results[originalIndex] = { ...results[originalIndex], status: 'completed', result: result.text };
                } catch (err: any) {
                  if (err instanceof BlobReadError || err?.isBlobError) {
                    // Blob backing data was evicted — flag for re-split.
                    blobEvicted = true;
                    results[originalIndex] = { ...results[originalIndex], status: 'pending', error: 'Audio data evicted — will re-split' };
                  } else if (isNetworkRelatedError(err)) {
                    // Keep retryable failures as pending so the wave-retry loop picks them up.
                    results[originalIndex] = { ...results[originalIndex], status: 'pending', error: err.message || 'Network interruption' };
                  } else {
                    results[originalIndex] = { ...results[originalIndex], status: 'error', error: err.message || 'Unknown error' };
                  }
                }

                // Save progress after each batch completes (blob is stored
                // separately by progressStorage — no re-serialization here).
                const completedCount = results.filter(r => r.status === 'completed').length;
                await progressStorage.saveProgress({
                  id: progressId,
                  filename: currentFile.name,
                  prompt,
                  mode: 'batch',
                  stage: 'batch-transcription',
                  totalBatches: results.length,
                  completedBatches: completedCount,
                  batches: results.map(b => ({
                    index: b.index,
                    status: b.status,
                    result: b.result,
                    error: b.error,
                    startTime: b.startTime,
                    endTime: b.endTime,
                  })),
                  audioBlob: currentFile,
                  createdAt: resumeFromProgress?.createdAt || Date.now(),
                  updatedAt: Date.now(),
                });

                setBatches([...results]);
              })
            );

            // If blob data was evicted, re-split the audio to regenerate
            // fresh blob references for the remaining batches.
            if (blobEvicted) {
              log.warn('blob_evicted_resplitting');
              setProcessingSubtext('Regenerating audio chunks…');
              try {
                const freshBatches = await splitAudio(currentFile, BATCH_CHUNK_SIZE_MB);
                // Patch blob data back into all unfinished results
                for (const item of batchesToProcess) {
                  if (results[item.originalIndex].status !== 'completed') {
                    const fb = freshBatches[item.batch.index];
                    if (fb) {
                      results[item.originalIndex] = {
                        ...results[item.originalIndex],
                        blob: fb.blob,
                        mimeType: fb.mimeType,
                      };
                      item.batch = results[item.originalIndex];
                    }
                  }
                }
                // Also update the current wave's chunk references
                for (const c of chunk) {
                  if (results[c.originalIndex].status !== 'completed') {
                    c.batch = results[c.originalIndex];
                  }
                }
              } catch (resplitErr) {
                log.error('resplit_failed', { error: resplitErr instanceof Error ? resplitErr : undefined });
                throw new Error('Audio data was lost from memory and could not be regenerated. Please re-upload the file.');
              }
            }

            // Check how many chunks in this wave still need work.
            // Catch BOTH 'pending' (recognised network error) and 'error'
            // (any other failure that slipped through isNetworkRelatedError).
            const stillFailed = chunk.filter(({ originalIndex }) =>
              results[originalIndex].status === 'pending' ||
              results[originalIndex].status === 'error'
            );

            if (stillFailed.length === 0) break; // wave complete

            // If we've genuinely lost the connection, hand off to resume flow.
            if (!navigator.onLine) {
              throw new Error('NETWORK_RESUME_REQUIRED');
            }

            // If we've exhausted per-wave retries, hand off to resume flow so
            // the user isn't stuck forever on a stubborn wave.
            if (waveRetry >= MAX_WAVE_RETRIES) {
              throw new Error('NETWORK_RESUME_REQUIRED');
            }

            // Transient API failure (rate-limit, 503, brief drop) — back off and
            // retry just the failing chunks without abandoning the whole job.
            waveRetry++;
            const backoffMs = Math.min(5000 * Math.pow(1.8, waveRetry - 1), 90000);
            setProcessingSubtext(
              `Retrying ${stillFailed.length} chunk(s)… (attempt ${waveRetry}/${MAX_WAVE_RETRIES})`
            );
            await new Promise(r => setTimeout(r, backoffMs));
          }
        }

        if (results.some(r => r.status !== 'completed')) {
          throw new Error('BATCHES_REMAINING');
        }

        // Deduplicate overlapping transcriptions
        const sortedTranscriptions = results
          .filter(b => b.status === 'completed')
          .sort((a, b) => a.index - b.index)
          .map(b => b.result || '');
        
        fullTranscription = deduplicateOverlappingTranscriptions(sortedTranscriptions);
        
        // Clean up progress storage after successful completion
        await progressStorage.deleteProgress(progressId);
        currentProgressIdRef.current = null;
      }

      if (!fullTranscription.trim()) {
        throw new Error('Transcription returned empty — please check the audio file and try again.');
      }

      // Upgrade neutral "Speaker N" labels to real names ONLY where the audio
      // explicitly identifies a speaker. Conservative + non-fatal: on any failure
      // or uncertainty the neutral labels are kept, and it can never inject the
      // account user's name. (Realtime transcripts skip this — they're already
      // labeled by channel.)
      try {
        fullTranscription = await resolveSpeakerNames(fullTranscription);
      } catch (e) {
        log.warn('speaker_name_resolution_skipped', { error: e instanceof Error ? e : undefined });
      }

      // Correct this NEWLY finalized transcript with the user's dictionary (exact + fuzzy
      // ASR mis-transcriptions of dictionary terms). Only new transcripts — saved notes untouched.
      fullTranscription = await applyDictionaryCorrections(fullTranscription);

      // ── Post-processing with visible milestones ──────────────────────────────
      setStatus('finalizing');
      setProcessingHeadline('Almost at the finish 🏁');
      setProcessingSubtext('Final goodies loading 😍');

      const getDuration = (): Promise<number> =>
        new Promise(resolve => {
          const audioFile = file || (resumeFromProgress?.audioBlob ? new File([resumeFromProgress.audioBlob], 'audio') : null);
          if (!audioFile) { resolve(0); return; }
          const audio = new Audio();
          audio.src = URL.createObjectURL(audioFile);
          audio.onloadedmetadata = () => { URL.revokeObjectURL(audio.src); resolve(Math.round(audio.duration)); };
          audio.onerror = () => resolve(0);
        });

      setProcessingHeadline('Summary chef at work 👨‍🍳');
      setProcessingSubtext('Only juicy bits stay 🍒');
      const summary = await generateSummary(fullTranscription);

      setProcessingHeadline('Notes in glow-up mode ✨');
      setProcessingSubtext('Pretty, clear, and punchy 💫');
      const notes = await generateNotes(fullTranscription);

      setProcessingHeadline('Naming this masterpiece 🎨');
      setProcessingSubtext('One tiny sec more ⏳');
      // Prefer a user-provided title from the meeting-detection prompt.
      let meetingTitle: string;
      if (pendingMeetingLabelRef.current) {
        meetingTitle = pendingMeetingLabelRef.current;
        pendingMeetingLabelRef.current = null;
      } else {
        meetingTitle = await generateMeetingTitle(fullTranscription);
      }

      const duration = await getDuration();

      const newTask: TaskHistory = {
        filename: meetingTitle,
        transcription: fullTranscription,
        summary,
        notes,
        prompt,
        status: 'completed',
        duration,
        source: 'batch', // uploaded file — counts toward the plan's batch hours
      };

      const savedTask = await persistTaskWithOfflineQueue(newTask);

      if (savedTask && savedTask.id && !savedTask.id.startsWith('pending_')) {
        setIsExtractingNewKG(true);
        extractKnowledgeGraph(savedTask.id, savedTask.filename, savedTask.transcription!)
          .then(async (result) => {
            const entryToSave: KnowledgeGraphEntry = {
              task_id: result.meetingId,
              meeting_title: result.meetingTitle,
              topics: result.topics || [],
              decisions: result.decisions || [],
              people: result.people || [],
              action_items: result.actionItems || [],
              refs: result.references || [],
            };
            await saveKnowledgeGraphBatch([entryToSave]);
            if (!result.meetingDate && savedTask.created_at) result.meetingDate = savedTask.created_at;
            setKgData(prevData => {
              if (prevData.length === 0) return prevData;
              const filtered = prevData.filter(d => d.meetingId !== result.meetingId);
              return [...filtered, result];
            });
            log.info('kg_auto_extracted_upload');
          })
          .catch(err => log.error('kg_background_extraction_failed', { error: err instanceof Error ? err : undefined }))
          .finally(() => setIsExtractingNewKG(false));

        indexMeetingTranscription(savedTask.id, savedTask.filename, savedTask.transcription!, { createdAt: savedTask.created_at, attendees: savedTask.attendees, workspaceId: getWorkspaceSelection().workspaceId ?? undefined })
          .then(() => log.info('turbopuffer_indexing_complete_upload'))
          .catch(err => log.warn('turbopuffer_indexing_failed', { error: err instanceof Error ? err : undefined }));
      }

      setHistory(prev => [savedTask, ...prev.filter(t => t.id !== savedTask.id)]);
      allMetaCacheRef.current = null; // freshness: a newly saved meeting must appear in the all-meetings index next turn
      setSelectedTask(savedTask);
      setStatus('completed');
      setProcessingHeadline('All done, yay 🎉');
      setProcessingSubtext(savedTask.id?.startsWith('pending_') ? 'Saved locally. Syncing when internet is back.' : 'Taking you to notes 📘');
      setCurrentView('notes');
      setNoteTab('notes');
      if (savedTask.id?.startsWith('pending_')) {
        setError('Connection dropped while saving. Notes are stored locally and will auto-sync when online.');
      }

    } catch (err: any) {
      if (err?.message === 'NETWORK_RESUME_REQUIRED' || isNetworkRelatedError(err)) {
        setAwaitingNetworkResume(true);
        setWasOffline(true);
        setStatus('processing');
        setProcessingHeadline('Signal dipped, we got this 📶');
        setProcessingSubtext('Resuming super soon 🔁');
        setError('Network issue detected. Processing progress has been saved and will resume automatically when connection is restored.');
        return;
      }
      if (err?.message === 'BATCHES_REMAINING') {
        setAwaitingNetworkResume(true);
        setStatus('processing');
        setProcessingHeadline('Waiting for internet buddy 🌐');
        setProcessingSubtext('We continue in a snap ⚡');
        setError('Processing paused with unfinished batches. It will continue automatically once the network is stable.');
        return;
      }
      setError(err.message || 'Failed to process audio.');
      setStatus('error');
    }
  };

  const handleResumeProcessing = async () => {
    if (!recoverableProgress) return;
    setShowRecoveryPrompt(false);
    if (recoverableProgress.stage === 'realtime-postprocess') {
      await processRealtimeTranscript(recoverableProgress.transcription || '', recoverableProgress);
    } else {
      await startProcessing(recoverableProgress);
    }
    setRecoverableProgress(null);
    setHasRecoverableProgress(false);
  };

  const handleDiscardRecovery = async () => {
    if (!recoverableProgress) return;
    await progressStorage.deleteProgress(recoverableProgress.id);
    setShowRecoveryPrompt(false);
    setRecoverableProgress(null);
    setHasRecoverableProgress(false);
  };

  const totalProgress = batches.length > 0 
    ? (batches.filter(b => b.status === 'completed').length / batches.length) * 100 
    : 0;

  const processingProgress =
    status === 'splitting' ? 8 :
    status === 'finalizing' ? 92 :
    status === 'processing' && batches.length === 0 ? 35 :
    totalProgress;

  const combinedResult = batches
    .filter(b => b.status === 'completed')
    .map(b => b.result)
    .join('\n\n---\n\n');

  if (currentView === 'shared') {
    return <SharedMeetingPage />;
  }

  if (!isAuthSessionResolved) {
    return (
      <div className="min-h-screen w-full flex flex-col items-center justify-center gap-4 bg-app-canvas text-app-fg">
        <Loader2 className="w-9 h-9 animate-spin text-app-fg/35" aria-hidden />
        <p className="text-sm text-app-fg/45">Loading…</p>
      </div>
    );
  }

  if (!session) {
    return <Auth />;
  }

  // After an active sign-in, show the welcome/profile confirmation before the app.
  if (showWelcome) {
    return <WelcomeProfile session={session} onContinue={() => setShowWelcome(false)} />;
  }

  return (
    <div id="app-shell" className="h-full w-full bg-app-canvas text-app-fg selection:bg-app-fg selection:text-app-panel flex flex-col overflow-hidden relative">
      {/* Free-tier meeting limit → upgrade prompt (portal) */}
      <FreeLimitModal
        open={showLimitModal}
        onClose={() => setShowLimitModal(false)}
        limit={entitlements?.meetingLimit ?? 5}
        used={entitlements?.meetingCount ?? 0}
        planLabel={entitlements?.planLabel ?? 'Free'}
        message={limitModalMsg}
        session={session}
      />
      {/* Meeting detection — the "Are you in a meeting?" prompt is shown as an
          OS-level always-on-top overlay window (see the effect below), not an
          in-app card, so it floats over Zoom/Meet/Teams like anarlog's notification. */}
      {/* Network Status — floating pill toast (Apple-style) */}
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ y: -20, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -20, opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed top-3 left-1/2 -translate-x-1/2 z-[10000] bg-[#1a1a1a]/90 backdrop-blur-xl text-white/90 pl-3 pr-4 py-2 flex items-center gap-2.5 rounded-full shadow-lg shadow-black/10"
          >
            <div className="w-5 h-5 rounded-full bg-orange-400/20 flex items-center justify-center flex-shrink-0">
              <AlertCircle className="w-3 h-3 text-orange-400" />
            </div>
            <span className="text-[12px] font-medium tracking-[-0.01em]">Offline — processing paused</span>
          </motion.div>
        )}
        {showReconnectingMessage && (
          <motion.div
            initial={{ y: -20, opacity: 0, scale: 0.95 }}
            animate={{ y: 0, opacity: 1, scale: 1 }}
            exit={{ y: -20, opacity: 0, scale: 0.95 }}
            transition={{ type: 'spring', stiffness: 400, damping: 30 }}
            className="fixed top-3 left-1/2 -translate-x-1/2 z-[10000] bg-[#1a1a1a]/90 backdrop-blur-xl text-white/90 pl-3 pr-4 py-2 flex items-center gap-2.5 rounded-full shadow-lg shadow-black/10"
          >
            <div className="w-5 h-5 rounded-full bg-green-400/20 flex items-center justify-center flex-shrink-0">
              <Loader2 className="w-3 h-3 text-green-400 animate-spin" />
            </div>
            <span className="text-[12px] font-medium tracking-[-0.01em]">Reconnected — resuming</span>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Recovery Modal */}
      <AnimatePresence>
        {showRecoveryPrompt && recoverableProgress && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-[9999] flex items-center justify-center bg-black/50 backdrop-blur-sm"
            onClick={(e) => e.target === e.currentTarget && handleDiscardRecovery()}
          >
            <motion.div
              initial={{ scale: 0.95, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.95, opacity: 0 }}
              className="bg-app-panel rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden border border-app-card-border"
            >
              <div className="p-6 border-b border-zinc-200/80 dark:border-zinc-700/80">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-full bg-blue-100 dark:bg-blue-950/50 flex items-center justify-center">
                    <History className="w-5 h-5 text-blue-600 dark:text-blue-400" />
                  </div>
                  <h2 className="text-xl font-bold text-app-fg">Resume Processing?</h2>
                </div>
                <p className="text-sm text-zinc-600 dark:text-zinc-400 mt-2">
                  We found an interrupted transcription session. Would you like to continue where you left off?
                </p>
              </div>
              
              <div className="p-6 space-y-4">
                <div className="bg-zinc-50 dark:bg-app-raised rounded-lg p-4 space-y-2 border border-transparent dark:border-app-border">
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-600 dark:text-zinc-400">File:</span>
                    <span className="font-medium text-app-fg truncate ml-2 max-w-[200px]">{recoverableProgress.filename}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-zinc-600 dark:text-zinc-400">Progress:</span>
                    <span className="font-medium text-app-fg">
                      {recoverableProgress.completedBatches} / {recoverableProgress.totalBatches} {recoverableProgress.stage === 'realtime-postprocess' ? 'steps' : 'batches'}
                    </span>
                  </div>
                  <div className="w-full bg-zinc-200 dark:bg-zinc-700 rounded-full h-2 mt-2">
                    <div
                      className="bg-blue-600 dark:bg-blue-500 h-2 rounded-full transition-all"
                      style={{ width: `${(recoverableProgress.completedBatches / recoverableProgress.totalBatches) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-zinc-500 dark:text-zinc-500 mt-2">
                    Last updated: {new Date(recoverableProgress.updatedAt).toLocaleString()}
                  </p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={handleDiscardRecovery}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-zinc-300 dark:border-zinc-600 text-zinc-700 dark:text-zinc-300 hover:bg-zinc-50 dark:hover:bg-zinc-800 transition-colors font-medium"
                  >
                    Start Fresh
                  </button>
                  <button
                    onClick={handleResumeProcessing}
                    className="flex-1 px-4 py-2.5 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-colors font-medium flex items-center justify-center gap-2"
                  >
                    <PlayCircle className="w-4 h-4" />
                    Resume
                  </button>
                </div>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Top title bar — full-width strip holding the macOS traffic lights
          (overlaid by the OS at the left) and the panel toggle right beside them.
          Shown in BOTH wide and compact/minimized windows so the toggle always
          sits next to the traffic lights (reference layout). */}
      <div
        data-tauri-drag-region
        className={`absolute ${isSidebarOpen && !isCompactMode ? 'left-[200px]' : 'left-[52px]'} right-0 top-0 z-[80] flex h-[38px] items-center bg-transparent`}
        style={{ WebkitUserSelect: 'none', userSelect: 'none' }}
      >
      </div>

      {/* Full-window Settings — renders as a top-level overlay (its own nav +
          content), NOT inside the content panel, so it never sits next to the
          main sidebar ("sidebar inside a sidebar"). Its empty top drag-strip
          clears the macOS traffic lights. */}
      <AnimatePresence>
        {currentView === 'settings' && (
          <motion.div
            key="settings-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[90] bg-app-panel"
          >
            <SettingsPage
              session={session}
              onClose={() => setCurrentView('process')}
              onSignOut={() => { clearUserState(); signOut(); }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Full-window Spaces — workspace/space management, reached from the
          sidebar "Spaces" arrow. Renders as a top-level overlay like Settings. */}
      <AnimatePresence>
        {currentView === 'spaces' && (
          <motion.div
            key="spaces-overlay"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            className="fixed inset-0 z-[90] bg-app-panel"
          >
            <SpacesPage
              onClose={() => setCurrentView('process')}
              onOpenSpace={(space) => { setWorkspaceSelection(space.workspace_id ?? getWorkspaceSelection().workspaceId, space.id); setCurrentView('workspace'); }}
            />
          </motion.div>
        )}
      </AnimatePresence>

      {/* Body — sidebar + content row, sitting below the shared top bar. */}
      <div className="flex-1 flex flex-row min-h-0 overflow-hidden">

      {/* Sidebar — hidden on mobile, icon-rail or expanded on desktop.
          Force-shown in compact mode so the narrow desktop window shows the sidebar (Granola-style). */}
      <div className={isCompactMode ? 'block flex-shrink-0 w-[52px] h-full' : 'hidden md:block md:h-full'}>
        <MainSidebar
          currentView={currentView}
          onViewChange={(view) => {
            if (view === 'notes' && selectedTask) {
              setCurrentView('notes', selectedTask.id);
            } else if (view === 'chat') {
              // The standalone Chat is a single, static "all meetings" chat —
              // never scoped to a specific meeting (per-meeting chat lives in the
              // note's "Ask AI" tab).
              setSelectedTask(null);
              setCurrentView('chat');
            } else {
              setCurrentView(view);
            }
          }}
          isOpen={isSidebarOpen}
          onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
          session={session}
          onSignOut={() => { clearUserState(); signOut(); }}
          status={status}
          isCompactMode={isCompactMode}
          macInset={isMacDesktop && !isFullscreen}
        />
      </div>

      {/* Main Content Area — white rounded container.
          In compact mode the window is narrow (below the md breakpoint) but it is
          still a desktop window, so we force the full desktop chrome (top drag
          region, padding, rounded panel + border) instead of the bare mobile
          fallback — the inner layout looks identical to the wide window. */}
      <div className="flex-1 flex flex-col overflow-hidden relative min-h-0">
        <div className={`flex-1 flex overflow-hidden pr-2.5 pl-1.5 pb-2.5 ${isMacDesktop && !isFullscreen ? 'pt-[14px]' : 'pt-2.5'}`}>
        <main className={`flex-1 bg-app-panel w-full relative overflow-y-auto shadow-sm text-app-fg ${isCompactMode ? 'rounded-3xl border border-app-border' : 'rounded-3xl border border-app-border'}`}>
          <AnimatePresence mode="wait">
            {currentView === 'process' && (
              <motion.div 
                key="process"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                <ProcessPage
                  file={file}
                  setFile={setFile}
                  isRecording={isRecording}
                  isPaused={isPaused}
                  recordingTime={recordingTime}
                  startRecording={startRecording}
                  stopRecording={stopRecording}
                  pauseRecording={pauseRecording}
                  resumeRecording={resumeRecording}
                  isControlBusy={isControlBusy}
                  prompt={prompt}
                  setPrompt={setPrompt}
                  startProcessing={startProcessing}
                  status={status}
                  batches={batches}
                  totalProgress={processingProgress}
                  processingHeadline={processingHeadline}
                  processingSubtext={processingSubtext}
                  inputMode={inputMode}
                  setInputMode={setInputMode}
                  nativeServerAvailable={nativeServerAvailable}
                  desktopRecordingMode={desktopRecordingMode}
                  setDesktopRecordingMode={setDesktopRecordingMode}
                  transcriptionLanguage={transcriptionLanguage}
                  setTranscriptionLanguage={setTranscriptionLanguage}
                  realtimeTranscript={realtimeTranscript}
                  interimTranscript={interimTranscript}
                  permissionsGranted={permissionsGranted}
                  onPermissionsGranted={() => setPermissionsGranted(true)}
                  currentInputDevice={currentInputDevice}
                  deviceRestartNotice={deviceRestartNotice}
                  chatInput={chatInput}
                  setChatInput={setChatInput}
                  messages={chatMessages}
                  isChatting={isChatting}
                  onAskAnything={() => {
                    if (!chatInput.trim()) return;
                    setSelectedTask(null);
                    void handleSendMessage();   // all-meetings chat, rendered inline on Home
                  }}
                  onRunGem={(p, d) => { setSelectedTask(null); void handleSendMessage(p, d); }}
                  chatThreads={chatThreads}
                  onNewChat={handleNewThread}
                  onLoadThread={(id) => { const t = chatThreads.find((x) => x.id === id); if (t) void handleSwitchThread(t); }}
                  onOpenFullChat={() => { setSelectedTask(null); setCurrentView('chat'); }}
                  onOpenChatHistory={() => { setSelectedTask(null); setCurrentView('chat'); }}
                />
              </motion.div>
            )}

            {currentView === 'history' && (
              <HistoryPage
                history={history}
                onSelectTask={(task) => {
                  setSelectedTask(task);
                  setCurrentView('notes', task.id);
                }}
                onTaskUpdated={handleTaskUpdated}
                onLoadMore={loadMoreHistory}
                hasMoreFromServer={hasMoreHistory}
                totalCount={totalHistoryCount}
                onOpenWorkspace={(wsId) => { setWorkspaceSelection(wsId, null); setCurrentView('workspace'); }}
              />
            )}

            {currentView === 'notes' && (
              selectedTask ? (
                <NotesPage
                  selectedTask={selectedTask}
                  onTaskUpdated={handleTaskUpdated}
                  isLoadingDetails={isLoadingTaskDetails}
                  session={session}
                  allTasks={history}
                  chatPanel={
                    /* Inline "Ask AI" chat for THIS meeting — no meeting dropdown
                       (onSelectTask/history omitted), history preserved via threads. */
                    <ChatPage
                      selectedTask={selectedTask}
                      chatMessages={chatMessages}
                      chatInput={chatInput}
                      setChatInput={setChatInput}
                      isChatting={isChatting}
                      isGeneratingImage={isGeneratingImage}
                      handleSendMessage={handleSendMessage}
                      handleVisualize={handleVisualize}
                      isGeneratingAsset={isGeneratingAsset}
                      handleAgentAction={handleAgentAction}
                      wikiStyle={wikiStyle}
                      setWikiStyle={setWikiStyle}
                      agentAssetHistory={agentAssetHistory}
                      selectedAgentAsset={selectedAgentAsset}
                      setSelectedAgentAsset={setSelectedAgentAsset as (a: any) => void}
                      downloadExistingAsset={downloadExistingAsset}
                      chatThreads={chatThreads}
                      activeChatThreadId={activeChatThreadId}
                      onNewThread={handleNewThread}
                      onSwitchThread={handleSwitchThread}
                      session={session}
                      embedded
                    />
                  }
                />
              ) : (
                <HistoryPage
                  history={history}
                  onSelectTask={(task) => {
                    setSelectedTask(task);
                    setCurrentView('notes', task.id);
                  }}
                  onTaskUpdated={handleTaskUpdated}
                  onLoadMore={loadMoreHistory}
                  hasMoreFromServer={hasMoreHistory}
                  totalCount={totalHistoryCount}
                  onOpenWorkspace={(wsId) => { setWorkspaceSelection(wsId, null); setCurrentView('workspace'); }}
                />
              )
            )}

            {currentView === 'chat' && (
              <ChatPage
                /* Static all-meetings chat — no meeting selector. */
                selectedTask={null}
                chatMessages={chatMessages}
                chatInput={chatInput}
                setChatInput={setChatInput}
                isChatting={isChatting}
                isGeneratingImage={isGeneratingImage}
                handleSendMessage={handleSendMessage}
                handleVisualize={handleVisualize}
                isGeneratingAsset={isGeneratingAsset}
                handleAgentAction={handleAgentAction}
                wikiStyle={wikiStyle}
                setWikiStyle={setWikiStyle}
                agentAssetHistory={agentAssetHistory}
                selectedAgentAsset={selectedAgentAsset}
                setSelectedAgentAsset={setSelectedAgentAsset as (a: any) => void}
                downloadExistingAsset={downloadExistingAsset}
                chatThreads={chatThreads}
                activeChatThreadId={activeChatThreadId}
                onNewThread={handleNewThread}
                onSwitchThread={handleSwitchThread}
                session={session}
              />
            )}



            {currentView === 'knowledge' && (
              <KnowledgePage
                kgData={kgDataWithAttendees}
                isLoadingKG={isLoadingKG}
                kgProgress={kgProgress}
                isExtractingNewKG={isExtractingNewKG}
                kgBuilt={kgBuilt}
                buildKnowledgeGraph={buildKnowledgeGraph}
                historyLength={history.length}
                onReExtractMeeting={async (meetingId: string) => {
                  try {
                    const fullTask = await getTaskById(meetingId);
                    if (!fullTask?.transcription?.trim()) return;
                    const result = await extractKnowledgeGraph(fullTask.id!, fullTask.filename, fullTask.transcription!);
                    const hasData = (result.topics?.length > 0) || (result.decisions?.length > 0) || (result.people?.length > 0) || (result.actionItems?.length > 0);
                    if (hasData) {
                      await saveKnowledgeGraphBatch([{
                        task_id: result.meetingId,
                        meeting_title: result.meetingTitle,
                        topics: result.topics || [],
                        decisions: result.decisions || [],
                        people: result.people || [],
                        action_items: result.actionItems || [],
                        refs: result.references || [],
                      }]);
                      markKGExtracted(fullTask.id!);
                    }
                    if (!result.meetingDate && fullTask.created_at) result.meetingDate = fullTask.created_at;
                    setKgData(prev => {
                      const filtered = prev.filter(d => d.meetingId !== result.meetingId);
                      return [...filtered, result];
                    });
                  } catch (err) {
                    log.error('manual_re_extract_failed', { meetingId, error: err instanceof Error ? err : undefined });
                  }
                }}
              />
            )}

            {currentView === 'audio-devices' && (
              <motion.div
                key="audio-devices"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                <AudioDevicesPage
                  isRecording={isRecording}
                  currentInputDevice={currentInputDevice}
                  deviceRestartNotice={deviceRestartNotice}
                />
              </motion.div>
            )}

            {currentView === 'workspace' && (
              <motion.div
                key="workspace"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                <WorkspacePage
                  allTasks={history}
                  onSelectTask={(task) => {
                    // Set the task directly so the note opens even when it isn't
                    // in the loaded (paginated) history — the detail-fetch effect
                    // hydrates transcription/notes from its id. Relying on the URL
                    // effect alone left workspace meetings stuck "loading".
                    setSelectedTask(task);
                    setCurrentView('notes', task.id);
                  }}
                />
              </motion.div>
            )}

            {currentView === 'people' && (
              <motion.div
                key="people"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                <PeoplePage
                  allTasks={history}
                  onSelectTask={(task) => setCurrentView('notes', task.id)}
                />
              </motion.div>
            )}
            {currentView === 'dictionary' && (
              <motion.div
                key="dictionary"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                <DictionaryPage />
              </motion.div>
            )}
            {/* Settings now renders as a full-window overlay (see above), not here. */}
          </AnimatePresence>
        </main>
        </div>
      </div>
      </div>{/* /Body */}

      {/* Mobile Bottom Navigation — visible only on mobile, hidden in compact desktop window */}
      {!isCompactMode && (
        <MobileBottomNav
          currentView={currentView}
          onViewChange={(view) => {
            if (view === 'notes' && selectedTask) {
              setCurrentView('notes', selectedTask.id);
            } else if (view === 'chat') {
              // The standalone Chat is a single, static "all meetings" chat —
              // never scoped to a specific meeting (per-meeting chat lives in the
              // note's "Ask AI" tab).
              setSelectedTask(null);
              setCurrentView('chat');
            } else {
              setCurrentView(view);
            }
          }}
          status={status}
        />
      )}
    </div>
  );
}
