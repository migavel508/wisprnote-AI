import React, { useState, useRef, useEffect, useCallback } from 'react';
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
  Clock,
  FileText,
  History,
  BookOpen,
  Plus,
  Search,
  MoreHorizontal,
  Trash2,
  ExternalLink,
  MessageSquare,
  Send,
  Image as ImageIcon,
  PanelLeftClose,
  PanelLeftOpen,
  Sparkles,
  Download,
  Users,
  Mail,
  Share2,
  Network,
  Circle,
  X,
  Mic,
  StopCircle,
  PauseCircle,
  PlayCircle,
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import ForceGraph2D from 'react-force-graph-2d';
import { 
  processAudioBatch, 
  generateSummary, 
  generateNotes, 
  chatWithNotes,
  agentPlanQuery,
  agentSynthesizeFromEvidence,
  generateConceptImage,
  generateEmailContent,
  generateWikiContent,
  extractKnowledgeGraph,
  generateMeetingTitle,
  uploadAudioToFileAPI,
  waitForFileActive,
  deleteFromFileAPI,
  transcribeViaFileAPI,
} from './services/geminiService';
import {
  retrieveForSingleMeeting,
  retrieveCrossMeeting,
  retrieveForManyMeetings,
  type MeetingDocument,
} from './services/chatRetrievalService';
import { indexMeetingTranscription, backfillExistingMeetings } from './services/turbopufferService';
import { 
  supabase, 
  saveTask, 
  queuePendingTask,
  flushPendingTasks,
  getPendingTaskCount,
  getTasks, 
  TaskHistory, 
  saveAsset,
  getAssets,
  GeneratedAsset,
  saveKnowledgeGraph,
  saveKnowledgeGraphBatch,
  getKnowledgeGraph,
  KnowledgeGraphEntry,
  saveChatMessage,
  getChatHistory,
  getChatHistoryByThread,
  ChatMessage,
  ManualNote,
  updateTaskSummary,
  updateTaskNotes,
} from './services/supabaseService';
import { Session } from '@supabase/supabase-js';
import { splitAudio, AudioBatch, shouldUseFileAPI, FILE_API_THRESHOLD_MB } from './services/audioService';
import { 
  progressStorage, 
  generateProgressId, 
  getMostRecentIncompleteProgress,
  ProcessingProgress 
} from './services/progressStorage';
import {
  checkSystemAudioAvailable,
  startSystemAudioRecording,
  stopSystemAudioRecording,
  isSystemAudioRecording,
  startRealtimeRecording,
  stopRealtimeRecording,
  isRealtimeRecording,
  listenForTranscripts,
  RecordingMode,
} from './services/nativeRecorderService';
import { checkPermissions } from './services/permissionService';
import {
  listenForDeviceChanges,
  listenForDeviceRestart,
  getDefaultInput,
  type DeviceChangeType,
} from './services/audioDeviceService';

import Auth from './components/Auth';
import ChatPage from './pages/ChatPage';
import NotesPage from './pages/NotesPage';
import HistoryPage from './pages/HistoryPage';
import KnowledgePage from './pages/KnowledgePage';
import ProcessPage from './pages/ProcessPage';
import AudioDevicesPage from './pages/AudioDevicesPage';
import MainSidebar from './components/MainSidebar';
import { ManualNotesList } from './components/ManualNotes/ManualNotesList';
import { ManualNoteEditor } from './components/ManualNotes/ManualNoteEditor';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

type View = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks' | 'audio-devices';
type Status = 'idle' | 'splitting' | 'processing' | 'finalizing' | 'completed' | 'error';
type NoteTab = 'transcription' | 'summary' | 'notes';

interface AgentStep {
  id: string;
  label: string;
  status: 'pending' | 'running' | 'done' | 'error';
  detail?: string;
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

export default function App() {
  const navigate = useNavigate();
  const location = useLocation();
  
  // Derive currentView from URL path
  const getCurrentView = (): View => {
    const path = location.pathname;
    if (path === '/' || path === '/process') return 'process';
    if (path === '/history') return 'history';
    if (path.startsWith('/notes')) return 'notes';
    if (path.startsWith('/chat')) return 'chat';
    if (path === '/knowledge') return 'knowledge';
    if (path === '/notebooks') return 'notebooks';
    if (path === '/audio-devices') return 'audio-devices';
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
      case 'notebooks':
        navigate('/notebooks');
        break;
      case 'audio-devices':
        navigate('/audio-devices');
        break;
    }
  };

  const [session, setSession] = useState<Session | null>(null);
  const [file, setFile] = useState<File | null>(null);
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
  const [inputMode, setInputMode] = useState<'upload' | 'record'>('upload');
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
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
  const [realtimeTranscript, setRealtimeTranscript] = useState<string[]>([]);
  const [interimTranscript, setInterimTranscript] = useState('');
  const unlistenRef = useRef<(() => void) | null>(null);
  const realtimeTranscriptRef = useRef<string[]>([]);
  const isRealtimePausedRef = useRef(false);
  const pausedBatchSegmentsRef = useRef<File[]>([]);
  const pausedRealtimeTranscriptRef = useRef<string[]>([]);
  const pauseResumeInFlightRef = useRef(false);
  const realtimeEngineActiveRef = useRef(false);
  const [permissionsGranted, setPermissionsGranted] = useState(false);
  const [currentInputDevice, setCurrentInputDevice] = useState<string | null>(null);
  const [deviceRestartNotice, setDeviceRestartNotice] = useState(false);

  // Notebooks (manual notes) state
  const [activeNote, setActiveNote] = useState<ManualNote | null>(null);
  const [notebookRefreshKey, setNotebookRefreshKey] = useState(0);

  const [history, setHistory] = useState<TaskHistory[]>([]);
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
  const [allMeetingsChatMessages, setAllMeetingsChatMessages] = useState<Message[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskHistory | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true); // Start true, set false after first fetch
  
  // Extract task ID from URL and load the task
  useEffect(() => {
    const path = location.pathname;
    const match = path.match(/\/(notes|chat)\/([^/]+)/);
    if (match && history.length > 0) {
      const taskId = match[2];
      const task = history.find(t => t.id === taskId);
      if (task && (!selectedTask || selectedTask.id !== taskId)) {
        setSelectedTask(task);
      }
    }
  }, [location.pathname, history]);
  const [noteTab, setNoteTab] = useState<NoteTab>('transcription');
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);
  const [chatInput, setChatInput] = useState('');
  const [isChatting, setIsChatting] = useState(false);
  const [isGeneratingImage, setIsGeneratingImage] = useState(false);
  const [isGeneratingAsset, setIsGeneratingAsset] = useState(false);
  const [wikiStyle, setWikiStyle] = useState<'MECE' | 'PRD'>('MECE');
  const [agentAssetHistory, setAgentAssetHistory] = useState<GeneratedAsset[]>([]);
  const [selectedAgentAsset, setSelectedAgentAsset] = useState<GeneratedAsset | null>(null);
  
  
  // Knowledge Graph State
  const [kgData, setKgData] = useState<any[]>([]);
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
  const autoSyncRanRef = useRef(false);

  const isNetworkRelatedError = (err: any): boolean => {
    if (!err) return !navigator.onLine;
    const status = err.status ?? err.statusCode ?? err?.error?.code ?? err?.code ?? 0;
    const msg = String(err.message ?? err).toLowerCase();
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
    ];
    return !navigator.onLine || status === 0 || status === 502 || status === 503 || status === 504 || networkMarkers.some(marker => msg.includes(marker));
  };

  const persistTaskWithOfflineQueue = async (task: TaskHistory): Promise<TaskHistory> => {
    try {
      return await saveTask(task);
    } catch (err: any) {
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
    setHistory([]);
    setSelectedTask(null);
    setKgData([]);
    setKgBuilt(false);
    setIsLoadingKG(false);
    setIsExtractingNewKG(false);
    setChatMessages([]);
    setAllMeetingsChatMessages([]);
    setChatInput('');
    setAgentAssetHistory([]);
    setSelectedAgentAsset(null);
    setFile(null);
    setStatus('idle');
    setError(null);
    setProcessingHeadline('Notes are warming up ✨');
    setProcessingSubtext('Hang tight, almost there 😄');
    setAwaitingNetworkResume(false);
    autoSyncRanRef.current = false;
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      prevUserIdRef.current = session?.user?.id ?? null;
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      const newUserId = session?.user?.id ?? null;
      const prevUserId = prevUserIdRef.current;

      // Clear state on sign-out OR user switch
      if (!newUserId || (prevUserId && newUserId !== prevUserId)) {
        clearUserState();
      }

      prevUserIdRef.current = newUserId;
      setSession(session);
    });

    return () => subscription.unsubscribe();
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
        console.error('Failed to sync pending tasks:', syncErr);
      }
      
      // If we were processing when we went offline (or hit a network failure), auto-resume
      if ((wasOffline || awaitingNetworkResume) && currentProgressIdRef.current) {
        setShowReconnectingMessage(true);
        try {
          const progress = await progressStorage.getProgress(currentProgressIdRef.current);
          if (progress && progress.completedBatches < progress.totalBatches) {
            console.log('Network reconnected - auto-resuming processing');
            if (progress.stage === 'realtime-postprocess') {
              await processRealtimeTranscript(progress.transcription || '', progress);
            } else {
              await startProcessing(progress);
            }
          }
        } catch (err) {
          console.error('Failed to auto-resume:', err);
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
        const incomplete = await getMostRecentIncompleteProgress();
        if (incomplete && status === 'idle') {
          setRecoverableProgress(incomplete);
          setHasRecoverableProgress(true);
          setShowRecoveryPrompt(true);
        }
      } catch (err) {
        console.error('Failed to check recovery:', err);
      }
    };
    if (session) {
      checkRecovery();
    }
  }, [session]);

  useEffect(() => {
    if (session) {
      fetchHistory();
    }
  }, [session]);


  useEffect(() => {
    if (selectedTask) {
      fetchAgentAssets(selectedTask.id!);
      fetchChatHistory(selectedTask.id!);
    } else if (currentView === 'chat' && !selectedTask) {
      fetchChatHistory(null);
    }
  }, [selectedTask, currentView]);

  const fetchAgentAssets = async (taskId: string) => {
    try {
      const data = await getAssets(taskId);
      const agentAssets = data.filter((a: GeneratedAsset) => a.type === 'email' || a.type === 'wiki');
      setAgentAssetHistory(agentAssets);
    } catch (err) {
      console.error('Failed to fetch assets:', err);
    }
  };

  const ALL_MEETINGS_THREAD_ID = 'all-meetings';

  const parseChatMessages = (data: any[]): Message[] =>
    data.map(msg => ({
      role: msg.role,
      text: msg.text,
      image: msg.image,
      citations: (msg as any).citations?.map((c: any) => ({
        meetingId: c.meeting_id,
        meetingTitle: c.meeting_title,
        chunkId: c.chunk_id,
        score: c.score,
      })),
      retrievalMeta: (msg as any).retrieval_meta
        ? {
            scope: (msg as any).retrieval_meta.scope,
            confidence: (msg as any).retrieval_meta.confidence,
            selectedMeetingIds: (msg as any).retrieval_meta.selected_meeting_ids,
            tokenUsageTotal: (msg as any).retrieval_meta.token_usage_total,
            coveredMeetingsCount: (msg as any).retrieval_meta.covered_meetings_count,
            totalMeetingsCount: (msg as any).retrieval_meta.total_meetings_count,
          }
        : undefined,
    }));

  const fetchChatHistory = async (taskId: string | null) => {
    try {
      const data = taskId
        ? await getChatHistory(taskId)
        : await getChatHistoryByThread(ALL_MEETINGS_THREAD_ID);
      const messages = parseChatMessages(data);
      setChatMessages(messages);
      if (!taskId) {
        setAllMeetingsChatMessages(messages);
      }
    } catch (err) {
      console.error('Failed to fetch chat history:', err);
      setChatMessages([]);
    }
  };


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

    (async () => {
      // Fetch initial default input device
      const device = await getDefaultInput();
      if (device) setCurrentInputDevice(device.name);

      // Listen for device changes — refresh current device info
      unlistenChange = await listenForDeviceChanges(async (changeType) => {
        console.log('[audio-device] change detected:', changeType);
        const newDevice = await getDefaultInput();
        if (newDevice) {
          setCurrentInputDevice(newDevice.name);
          console.log('[audio-device] new default input:', newDevice.name,
            '| transport:', newDevice.transport_type,
            '| headphone:', newDevice.is_headphone);
        }
      });

      // Listen for device restart events (emitted when recording auto-restarts)
      unlistenRestart = await listenForDeviceRestart(() => {
        console.log('[audio-device] recording restarting due to device change');
        setDeviceRestartNotice(true);
        setTimeout(() => setDeviceRestartNotice(false), 3000);
      });
    })();

    return () => {
      unlistenChange?.();
      unlistenRestart?.();
    };
  }, []);

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

  const startRealtimeBackupCapture = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
      console.warn('Realtime backup capture unavailable:', err);
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

  const attachRealtimeTranscriptListener = async () => {
    if (unlistenRef.current) {
      unlistenRef.current();
      unlistenRef.current = null;
    }
    const unlisten = await listenForTranscripts((text, isFinal) => {
      if (isRealtimePausedRef.current) return;
      if (isFinal) {
        const trimmed = text.trim();
        if (!trimmed) return;
        if (realtimeTranscriptRef.current[realtimeTranscriptRef.current.length - 1] === trimmed) {
          setInterimTranscript('');
          return;
        }
        realtimeTranscriptRef.current = [...realtimeTranscriptRef.current, trimmed];
        setRealtimeTranscript(prev => [...prev, trimmed]);
        setInterimTranscript('');
      } else {
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
    if (nativeServerAvailable && desktopRecordingMode === 'batch') {
      // ── Native Batch Recording (mic + system audio via Tauri) ──
      try {
        await startSystemAudioRecording();
        isRealtimePausedRef.current = false;
        pausedBatchSegmentsRef.current = [];
        pausedRealtimeTranscriptRef.current = [];
        setIsRecording(true);
        setIsPaused(false);
        setRecordingTime(0);
        setFile(null);
        setRealtimeTranscript([]);
        realtimeTranscriptRef.current = [];
        setInterimTranscript('');

        timerRef.current = setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);
      } catch (err: any) {
        console.error('Native recording error:', err);
        setError(err.message || 'Failed to start system audio recording.');
      }
    } else if (desktopRecordingMode === 'realtime') {
      // ── Real-time mode: integrated Deepgram transcription via Tauri ──
      try {
        const apiKey = (import.meta as any).env?.VITE_DEEPGRAM_API_KEY as string | undefined;
        if (!apiKey) {
          setError('VITE_DEEPGRAM_API_KEY not set in .env.local');
          return;
        }

        // Reset buffers before listener/stream starts to avoid dropping early words.
        isRealtimePausedRef.current = false;
        setRealtimeNetworkInterrupted(false);
        pausedBatchSegmentsRef.current = [];
        pausedRealtimeTranscriptRef.current = [];
        setRealtimeTranscript([]);
        realtimeTranscriptRef.current = [];
        setInterimTranscript('');

        // Start listening for transcript events BEFORE starting recording
        await attachRealtimeTranscriptListener();

        await startRealtimeRecording(apiKey, extractDeepgramKeyterms(prompt));
        realtimeEngineActiveRef.current = true;

        setIsRecording(true);
        setIsPaused(false);
        setRecordingTime(0);
        setFile(null);

        timerRef.current = setInterval(() => {
          setRecordingTime(prev => prev + 1);
        }, 1000);
      } catch (err: any) {
        console.error('Realtime recording error:', err);
        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        realtimeEngineActiveRef.current = false;
        setError(err.message || 'Failed to start integrated real-time recording.');
      }
    } else {
      // ── Browser Recording (microphone only via MediaRecorder) ──
      try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
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
        console.error('Error accessing microphone:', err);
        setError('Could not access microphone. Please check permissions.');
      }
    }
  };

  const pauseRecording = async () => {
    if (!isRecording || isPaused || pauseResumeInFlightRef.current) return;
    pauseResumeInFlightRef.current = true;
    setIsPaused(true);
    setInterimTranscript('');
    if (timerRef.current) clearInterval(timerRef.current);

    try {
      if (nativeServerAvailable && desktopRecordingMode === 'batch') {
        // Emulate pause by checkpointing a finished native segment.
        const segment = await stopSystemAudioRecording();
        if (segment) pausedBatchSegmentsRef.current.push(segment);
      } else if (desktopRecordingMode === 'realtime') {
        isRealtimePausedRef.current = true;
        // Emulate pause by stopping realtime stream and retaining transcript so far.
        const partialTranscript = await safeStopRealtimeRecording();
        if (partialTranscript.trim()) {
          pausedRealtimeTranscriptRef.current.push(partialTranscript.trim());
        }
      } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.pause();
      } else {
        return;
      }
    } catch (err: any) {
      console.error('Pause recording error:', err);
      setError(err.message || 'Failed to pause recording.');
      // Roll back paused UI state if pause fails.
      setIsPaused(false);
      isRealtimePausedRef.current = false;
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } finally {
      pauseResumeInFlightRef.current = false;
    }
  };

  const resumeRecording = async () => {
    if (!isRecording || !isPaused || pauseResumeInFlightRef.current) return;
    pauseResumeInFlightRef.current = true;
    setIsPaused(false);

    try {
      if (nativeServerAvailable && desktopRecordingMode === 'batch') {
        await startSystemAudioRecording();
      } else if (desktopRecordingMode === 'realtime') {
        const apiKey = (import.meta as any).env?.VITE_DEEPGRAM_API_KEY as string | undefined;
        if (!apiKey) {
          setError('VITE_DEEPGRAM_API_KEY not set in .env.local');
          return;
        }
        if (!unlistenRef.current) {
          await attachRealtimeTranscriptListener();
        }
        if (!realtimeEngineActiveRef.current) {
          await startRealtimeRecording(apiKey, extractDeepgramKeyterms(prompt));
          realtimeEngineActiveRef.current = true;
        }
        isRealtimePausedRef.current = false;
      } else if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
        mediaRecorderRef.current.resume();
      } else {
        return;
      }

      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    } catch (err: any) {
      console.error('Resume recording error:', err);
      setError(err.message || 'Failed to resume recording.');
      // Roll back resumed UI state if resume fails.
      setIsPaused(true);
      if (timerRef.current) clearInterval(timerRef.current);
    } finally {
      pauseResumeInFlightRef.current = false;
    }
  };

  const stopRecording = async () => {
    if (timerRef.current) clearInterval(timerRef.current);

    if (nativeServerAvailable && desktopRecordingMode === 'batch' && isRecording) {
      // ── Stop Native Batch Recording (Tauri) ──
      try {
        let finalSegment: File | null = null;
        if (!isPaused) {
          finalSegment = await stopSystemAudioRecording();
        }
        const allSegments = [...pausedBatchSegmentsRef.current, ...(finalSegment ? [finalSegment] : [])];
        const audioFile = allSegments.length > 0 ? await mergeAudioFilesToWav(allSegments) : null;
        setIsRecording(false);
        setIsPaused(false);
        pausedBatchSegmentsRef.current = [];
        if (audioFile) {
          setFile(audioFile);
        } else {
          setError('No audio captured.');
        }
      } catch (err: any) {
        console.error('Stop recording error:', err);
        setError(err.message || 'Failed to stop recording.');
        setIsRecording(false);
        setIsPaused(false);
        pausedBatchSegmentsRef.current = [];
      }
    } else if (desktopRecordingMode === 'realtime' && isRecording) {
      // ── Stop Real-time mode: stop integrated Tauri recording ──
      const backupAudioFile = await stopRealtimeBackupCapture();
      try {
        isRealtimePausedRef.current = false;
        const fullTranscript = isPaused ? '' : await safeStopRealtimeRecording();

        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        setIsRecording(false);
        setIsPaused(false);
        const pausedTranscript = pausedRealtimeTranscriptRef.current.join(' ').trim();
        const refTranscript = realtimeTranscriptRef.current.join(' ').trim();
        const transcriptToUse = [pausedTranscript, fullTranscript.trim(), refTranscript].filter(Boolean).join(' ').trim();

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
        console.error('Stop realtime error:', err);
        isRealtimePausedRef.current = false;
        if (unlistenRef.current) { unlistenRef.current(); unlistenRef.current = null; }
        setIsRecording(false);
        setIsPaused(false);
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
    }
  };

  // Keep refs in sync so the tray listener always calls the latest functions
  startRecordingRef.current = startRecording;
  stopRecordingRef.current = stopRecording;

  // Process real-time transcript with step checkpointing for network-safe resume.
  const processRealtimeTranscript = async (
    transcript: string,
    resumeFromProgress?: ProcessingProgress
  ) => {
    if (!transcript.trim()) return;

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
      };

      const savedTask = await persistTaskWithOfflineQueue(newTask);
      checkpointBatches[3] = { ...checkpointBatches[3], status: 'completed', result: savedTask.id || '' };
      await updateRealtimeCheckpoint(checkpointBatches, resumeFromProgress?.duration ?? recordingTime);

      await progressStorage.deleteProgress(progressId);
      currentProgressIdRef.current = null;

      if (savedTask && savedTask.id && !savedTask.id.startsWith('pending_')) {
        setIsExtractingNewKG(true);
        extractKnowledgeGraph(savedTask.id, savedTask.filename, savedTask.transcription)
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
            setKgData(prevData => {
              if (prevData.length === 0) return prevData;
              const filtered = prevData.filter(d => d.meetingId !== result.meetingId);
              return [...filtered, result];
            });
            console.log('Auto-extracted KG for realtime meeting');
          })
          .catch(err => console.error('Background KG extraction failed:', err))
          .finally(() => setIsExtractingNewKG(false));

        indexMeetingTranscription(savedTask.id, savedTask.filename, savedTask.transcription)
          .then(() => console.log('Turbopuffer indexing complete for realtime meeting'))
          .catch(err => console.warn('Background Turbopuffer indexing failed:', err));
      }

      setHistory(prev => [savedTask, ...prev.filter(t => t.id !== savedTask.id)]);
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


  // Load persisted knowledge graph from Supabase
  const fetchKnowledgeGraph = async () => {
    try {
      const data = await getKnowledgeGraph();
      if (data && data.length > 0) {
        // Transform DB format to app format
        const transformed = data.map(entry => ({
          meetingId: entry.task_id,
          meetingTitle: entry.meeting_title,
          topics: entry.topics || [],
          decisions: entry.decisions || [],
          people: entry.people || [],
          actionItems: entry.action_items || [],
          references: entry.refs || []
        }));
        setKgData(transformed);
        setKgBuilt(true);
      }
    } catch (err) {
      console.error('Failed to fetch knowledge graph:', err);
    }
  };

  // Load KG on mount
  useEffect(() => {
    if (session) {
      fetchKnowledgeGraph();
    }
  }, [session]);

  // Auto-sync Knowledge Graph: check if any meetings in history are missing from KG.
  // Uses a ref snapshot of kgData (not a dependency) to avoid re-triggering when
  // setKgData is called inside, and a session-level guard so it runs at most once.
  const kgDataRef = useRef(kgData);
  kgDataRef.current = kgData;

  useEffect(() => {
    if (history.length > 0 && kgBuilt && !isExtractingNewKG && !autoSyncRanRef.current) {
      const syncMissingMeetingsToKG = async () => {
        const currentKgData = kgDataRef.current;
        const kgTaskIds = new Set(currentKgData.map(kg => kg.meetingId));
        const missingTasks = history.filter(task => task.id && !kgTaskIds.has(task.id) && task.status === 'completed' && task.transcription && task.transcription.trim().length > 0);
        
        if (missingTasks.length === 0) return;
        
        autoSyncRanRef.current = true;
        console.log(`Found ${missingTasks.length} meetings missing from Knowledge Graph. Starting auto-sync...`);
        setIsExtractingNewKG(true);
        
        try {
          for (let i = 0; i < missingTasks.length; i++) {
            const task = missingTasks[i];
            console.log(`Auto-extracting KG for: ${task.filename}`);
            
            try {
              const result = await extractKnowledgeGraph(task.id!, task.filename, task.transcription);
              
              const entryToSave: KnowledgeGraphEntry = {
                task_id: result.meetingId,
                meeting_title: result.meetingTitle,
                topics: result.topics || [],
                decisions: result.decisions || [],
                people: result.people || [],
                action_items: result.actionItems || [],
                refs: result.references || []
              };
              
              await saveKnowledgeGraphBatch([entryToSave]);
              setKgData(prevData => [...prevData, result]);
              
              if (i < missingTasks.length - 1) {
                await new Promise(resolve => setTimeout(resolve, 5000));
              }
            } catch (err) {
              console.error(`Failed to auto-extract KG for ${task.filename}:`, err);
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

    // ── Shared rate limiter + concurrent worker pool ─────────────────────────
    // Free-tier Gemini = 15 RPM → 1 token every 4.2 s.
    // JS is single-threaded so nextSlotAt++ is race-free across workers.
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
    const allCompleted = history.filter(t => t.id && t.status === 'completed');

    // Meetings not yet in the KG go first; already-processed ones are reused as-is
    const toExtract = allCompleted.filter(t => !processedIds.has(t.id!));
    const alreadyDone = allCompleted
      .filter(t => processedIds.has(t.id!))
      .map(t => latestKgData.find((k: any) => k.meetingId === t.id)!);

    // Seed UI immediately with what we already have so the graph stays visible
    const accumulated = [...alreadyDone];
    setKgData([...accumulated]);
    setKgBuilt(alreadyDone.length > 0);
    setKgProgress({ current: 0, total: toExtract.length });

    console.log(`KG rebuild: ${alreadyDone.length} cached, ${toExtract.length} to extract`);

    // Work-stealing queue: workers grab the next index atomically (safe in JS)
    let qi = 0;
    let doneCount = 0;

    const runWorker = async () => {
      while (qi < toExtract.length) {
        const i = qi++; // atomic in single-threaded JS
        if (i >= toExtract.length) break;

        const task = toExtract[i];
        const hasTranscription = !!(task.transcription && task.transcription.trim().length > 0);

        let result: any;
        if (hasTranscription) {
          await rateLimit(); // serialise API slots across all workers
          try {
            result = await extractKnowledgeGraph(task.id!, task.filename, task.transcription);
          } catch (err) {
            console.error(`KG extraction failed for "${task.filename}":`, err);
            result = { meetingId: task.id!, meetingTitle: task.filename, topics: [], decisions: [], people: [], actionItems: [], references: [] };
          }
        } else {
          result = { meetingId: task.id!, meetingTitle: task.filename, topics: [], decisions: [], people: [], actionItems: [], references: [] };
        }

        // Checkpoint-save immediately — progress is durable even if interrupted
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
        } catch (saveErr) {
          console.error(`Checkpoint save failed for "${task.filename}":`, saveErr);
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
        content = await generateEmailContent(selectedTask.transcription);
        filename = `${selectedTask.filename.split('.')[0]}_FollowUp_Email.html`;
      } else {
        content = await generateWikiContent(selectedTask.transcription, wikiStyle);
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
      console.error('Agent error:', err);
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

  const handleSendMessage = async () => {
    if (!chatInput.trim() || isChatting) return;

    if (selectedTask && !selectedTask.transcription) {
      setChatMessages(prev => [...prev, { role: 'model', text: 'Unable to chat: No transcription content available for this meeting.' }]);
      return;
    }

    const userMessage: Message = { role: 'user', text: chatInput };
    const userInput = chatInput;
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsChatting(true);

    const updateAgentMessage = (updater: (prev: Message) => Partial<Message>) => {
      setChatMessages(prev => {
        const last = prev[prev.length - 1];
        if (last?.role === 'model' && last.agentStatus) {
          const updated = { ...last, ...updater(last) };
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

    try {
      if (selectedTask && selectedTask.id) {
        await saveChatMessage({
          task_id: selectedTask.id,
          role: 'user',
          text: userInput,
          thread_id: `task:${selectedTask.id}`,
        });
      } else {
        setAllMeetingsChatMessages(prev => [...prev, userMessage]);
        saveChatMessage({
          role: 'user',
          text: userInput,
          thread_id: ALL_MEETINGS_THREAD_ID,
        }).catch(err => console.warn('Failed to persist all-meetings user msg:', err));
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
      const allMeetings: MeetingDocument[] = history
        .filter((task) => !!task.id && !!task.transcription?.trim())
        .map((task) => ({
          meetingId: task.id!,
          title: task.filename || 'Untitled Meeting',
          transcription: task.transcription || '',
          summary: task.summary || '',
          notes: task.notes || '',
        }));
      const meetingTitles = isSingleMeeting
        ? [selectedTask!.filename || 'This meeting']
        : allMeetings.map(m => m.title);

      const plan = await agentPlanQuery(userInput, meetingTitles, isSingleMeeting);

      // ═══════════ PHASE 2: PLANNING ═══════════
      const singleSteps: AgentStep[] = [
        { id: 'retrieve', label: 'Retrieve evidence', status: 'pending' },
        { id: 'analyze', label: 'Analyze context', status: 'pending' },
        { id: 'respond', label: 'Generate response', status: 'pending' },
      ];
      const multiSteps: AgentStep[] = [
        { id: 'classify', label: `Understanding: ${plan.intent.slice(0, 50)}`, status: 'done' },
        { id: 'search', label: `Searching across ${allMeetings.length} meetings`, status: 'pending' },
        { id: 'synthesize', label: 'Compiling findings', status: 'pending' },
      ];
      const planSteps = isSingleMeeting ? singleSteps : multiSteps;
      updateAgentMessage(() => ({
        agentStatus: 'planning',
        agentPlan: planSteps,
      }));
      await new Promise(r => setTimeout(r, 300));

      // ═══════════ PHASE 3: EXECUTING ═══════════
      updateAgentMessage(() => ({ agentStatus: 'executing' }));

      let response: string;
      let responseCitations: Message['citations'] = undefined;
      let responseRetrievalMeta: Message['retrievalMeta'] = undefined;

      if (isSingleMeeting) {
        // --- Single meeting path ---
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
          totalTokenBudget: 3000,
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

        updateStep('respond', 'running');
        response = await chatWithNotes(
          {
            transcription: '',
            title: selectedTask!.filename || '',
            preparedContext: retrievalPlan.context,
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
        // --- Many meetings: single cross-meeting Turbopuffer query ---
        updateStep('search', 'running');
        console.log(`[Agent] Multi-meeting path: isBroad=${plan.isBroad}, intent="${plan.intent}", ${allMeetings.length} meetings`);

        const topK = plan.isBroad ? 50 : 20;
        const meetingTitleMap = new Map(allMeetings.map(m => [m.meetingId, m.title]));
        const meetingSummaryMap = new Map(
          allMeetings.filter(m => m.summary).map(m => [m.meetingId, m.summary || ''])
        );

        const crossResult = await retrieveCrossMeeting({
          query: userInput,
          topK,
          isBroad: plan.isBroad,
          totalMeetingsCount: allMeetings.length,
          meetingTitleMap,
          meetingSummaryMap,
        });

        let contextForSynthesis: string;
        let coveredCount: number;
        let coveredIds: string[];
        let confidence: number;

        if (crossResult && crossResult.evidence.length > 0) {
          const evidenceMeetingCount = crossResult.meetingGroups.length;
          console.log(`[Agent] Turbopuffer returned ${crossResult.evidence.length} chunks from ${evidenceMeetingCount} meetings, covering ${crossResult.coveredMeetingIds.length} total`);
          contextForSynthesis = crossResult.context;
          coveredCount = crossResult.coveredMeetingIds.length;
          coveredIds = crossResult.coveredMeetingIds;
          confidence = crossResult.confidence;

          responseCitations = crossResult.evidence.slice(0, 8).map(e => ({
            meetingId: e.meetingId,
            meetingTitle: e.meetingTitle,
            chunkId: e.chunkId,
            score: e.score,
          }));

          updateStep('search', 'done',
            plan.isBroad
              ? `Covering all ${coveredCount} meetings (deep evidence from ${evidenceMeetingCount})`
              : `Found evidence in ${evidenceMeetingCount} meetings`
          );
        } else {
          console.log(`[Agent] Turbopuffer returned null/empty, falling back to BM25 for ${allMeetings.length} meetings (broad=${plan.isBroad})`);
          updateStep('search', 'done', `Using summaries from ${allMeetings.length} meetings`);

          const fallbackResult = await retrieveForManyMeetings({
            query: userInput,
            meetings: allMeetings,
            totalTokenBudget: plan.isBroad ? 6000 : 3200,
          });

          contextForSynthesis = fallbackResult.context;
          coveredCount = fallbackResult.coveredMeetingsCount;
          coveredIds = fallbackResult.selectedMeetingIds;
          confidence = fallbackResult.confidence;

          responseCitations = fallbackResult.evidence.slice(0, 8).map(e => ({
            meetingId: e.meetingId,
            meetingTitle: e.meetingTitle,
            chunkId: e.chunkId,
            score: e.score,
          }));
        }

        responseRetrievalMeta = {
          scope: 'many',
          confidence,
          selectedMeetingIds: coveredIds,
          tokenUsageTotal: 0,
          coveredMeetingsCount: coveredCount,
          totalMeetingsCount: allMeetings.length,
        };

        updateStep('synthesize', 'running',
          plan.isBroad
            ? `Synthesizing across all ${coveredCount} meetings...`
            : `Compiling findings from ${coveredCount} meetings...`
        );

        response = await agentSynthesizeFromEvidence({
          userQuery: userInput,
          intent: plan.intent,
          context: contextForSynthesis,
          history: msgHistory,
          meetingsVisited: coveredCount,
          totalMeetings: allMeetings.length,
        });

        updateStep('synthesize', 'done');
      }

      // ═══════════ PHASE 4: DONE — replace agent placeholder with final response ═══════════
      const modelMessage: Message = {
        role: 'model',
        text: response,
        agentStatus: 'done',
        citations: responseCitations,
        retrievalMeta: responseRetrievalMeta,
      };

      setChatMessages(prev => {
        const withoutPlaceholder = prev.filter(m => !(m.role === 'model' && m.agentStatus && m.agentStatus !== 'done'));
        return [...withoutPlaceholder, modelMessage];
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
      };

      if (!selectedTask) {
        setAllMeetingsChatMessages(prev => [...prev, modelMessage]);
        saveChatMessage({
          role: 'model',
          text: response,
          thread_id: ALL_MEETINGS_THREAD_ID,
          ...chatSaveMeta,
        }).catch(err => console.warn('Failed to persist all-meetings model msg:', err));
      } else if (selectedTask && selectedTask.id) {
        await saveChatMessage({
          task_id: selectedTask.id,
          role: 'model',
          text: response,
          thread_id: `task:${selectedTask.id}`,
          ...chatSaveMeta,
        });
      }
    } catch (err) {
      console.error('Chat error:', err);
      setChatMessages(prev => {
        const cleaned = prev.filter(m => !(m.role === 'model' && m.agentStatus && m.agentStatus !== 'done'));
        return [...cleaned, { role: 'model', text: 'Sorry, I encountered an error while processing your request.' }];
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
          thread_id: `task:${selectedTask.id}`,
        });
      } else {
        setChatMessages(prev => [
          ...prev.slice(0, -1), 
          { role: 'model', text: 'Failed to generate visualization. Please try a different description.' }
        ]);
      }
    } catch (err) {
      console.error('Image generation error:', err);
      setChatMessages(prev => [
        ...prev.slice(0, -1), 
        { role: 'model', text: 'Error generating visualization.' }
      ]);
    } finally {
      setIsGeneratingImage(false);
    }
  };

  const fetchHistory = async () => {
    try {
      setIsLoadingHistory(true);
      const data = await getTasks();
      setHistory(data);

      backfillExistingMeetings(
        data
          .filter(t => t.id && t.status === 'completed' && t.transcription?.trim())
          .map(t => ({ id: t.id!, title: t.filename || 'Untitled', transcription: t.transcription! }))
      ).catch(err => console.warn('Turbopuffer backfill error:', err));
    } catch (err) {
      console.error('Failed to fetch history:', err);
    } finally {
      setIsLoadingHistory(false);
    }
  };

  // Handler to update a task in history (e.g., when title is regenerated)
  const handleTaskUpdated = (updatedTask: TaskHistory) => {
    // Update history array - merge with existing data to preserve all fields
    setHistory(prev => prev.map(task => 
      task.id === updatedTask.id ? { ...task, ...updatedTask } : task
    ));
    // Update selectedTask if it's the same task - merge to preserve all fields
    if (selectedTask?.id === updatedTask.id) {
      setSelectedTask(prev => prev ? { ...prev, ...updatedTask } : updatedTask);
    }
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const selectedFile = e.target.files?.[0];
    if (selectedFile) {
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

    const result: string[] = [transcriptions[0]];
    
    for (let i = 1; i < transcriptions.length; i++) {
      const prev = transcriptions[i - 1];
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
      
      if (bestOverlap > 20) {
        // Skip the overlapping portion from the current chunk
        result.push(curr.slice(bestOverlap).trim());
      } else {
        // No significant overlap found, just append
        result.push(curr);
      }
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
      if (shouldUseFileAPI(currentFile) && !resumeFromProgress) {
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
          fullTranscription = await transcribeViaFileAPI(uri, currentFile.type || 'audio/mpeg', prompt);

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
          console.warn('File API failed, falling back to batch processing:', fileApiError);
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
          audioBatches = await splitAudio(currentFile, 15);
          
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

          // Split with overlapping chunks for better boundary handling
          audioBatches = await splitAudio(currentFile, 15, {
            overlapSeconds: 10,
            enableNoiseGate: true,
            enableNormalization: true,
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
        const CONCURRENCY = 3;

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

          // Mark as processing
          chunk.forEach(({ originalIndex }) => {
            results[originalIndex] = { ...results[originalIndex], status: 'processing' };
          });
          setBatches([...results]);

          // Process in parallel
          await Promise.allSettled(
            chunk.map(async ({ batch, originalIndex }) => {
              try {
                const result = await processAudioBatch(batch, prompt);
                results[originalIndex] = { ...results[originalIndex], status: 'completed', result: result.text };
              } catch (err: any) {
                if (isNetworkRelatedError(err)) {
                  // Keep retryable network failures pending so reconnect resumes seamlessly.
                  results[originalIndex] = { ...results[originalIndex], status: 'pending', error: err.message || 'Network interruption' };
                } else {
                  results[originalIndex] = { ...results[originalIndex], status: 'error', error: err.message || 'Unknown error' };
                }
              }
              
              // Save progress after each batch completes
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

          if (results.some(r => r.status === 'pending')) {
            throw new Error('NETWORK_RESUME_REQUIRED');
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
      const meetingTitle = await generateMeetingTitle(fullTranscription);

      const duration = await getDuration();

      const newTask: TaskHistory = {
        filename: meetingTitle,
        transcription: fullTranscription,
        summary,
        notes,
        prompt,
        status: 'completed',
        duration,
      };

      const savedTask = await persistTaskWithOfflineQueue(newTask);

      if (savedTask && savedTask.id && !savedTask.id.startsWith('pending_')) {
        setIsExtractingNewKG(true);
        extractKnowledgeGraph(savedTask.id, savedTask.filename, savedTask.transcription)
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
            setKgData(prevData => {
              if (prevData.length === 0) return prevData;
              const filtered = prevData.filter(d => d.meetingId !== result.meetingId);
              return [...filtered, result];
            });
            console.log('Automatically extracted and saved knowledge graph for new meeting');
          })
          .catch(err => console.error('Background KG extraction failed:', err))
          .finally(() => setIsExtractingNewKG(false));

        indexMeetingTranscription(savedTask.id, savedTask.filename, savedTask.transcription)
          .then(() => console.log('Turbopuffer indexing complete for uploaded meeting'))
          .catch(err => console.warn('Background Turbopuffer indexing failed:', err));
      }

      setHistory(prev => [savedTask, ...prev.filter(t => t.id !== savedTask.id)]);
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

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="h-screen bg-[#f5f0eb] text-[#1a1a1a] font-[system-ui] selection:bg-[#1a1a1a] selection:text-white flex overflow-hidden">
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
              className="bg-white rounded-2xl shadow-2xl max-w-md w-full mx-4 overflow-hidden"
            >
              <div className="p-6 border-b border-gray-100">
                <div className="flex items-center gap-3 mb-2">
                  <div className="w-10 h-10 rounded-full bg-blue-100 flex items-center justify-center">
                    <History className="w-5 h-5 text-blue-600" />
                  </div>
                  <h2 className="text-xl font-bold">Resume Processing?</h2>
                </div>
                <p className="text-sm text-gray-600 mt-2">
                  We found an interrupted transcription session. Would you like to continue where you left off?
                </p>
              </div>
              
              <div className="p-6 space-y-4">
                <div className="bg-gray-50 rounded-lg p-4 space-y-2">
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">File:</span>
                    <span className="font-medium truncate ml-2 max-w-[200px]">{recoverableProgress.filename}</span>
                  </div>
                  <div className="flex justify-between text-sm">
                    <span className="text-gray-600">Progress:</span>
                    <span className="font-medium">
                      {recoverableProgress.completedBatches} / {recoverableProgress.totalBatches} {recoverableProgress.stage === 'realtime-postprocess' ? 'steps' : 'batches'}
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-2 mt-2">
                    <div
                      className="bg-blue-600 h-2 rounded-full transition-all"
                      style={{ width: `${(recoverableProgress.completedBatches / recoverableProgress.totalBatches) * 100}%` }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 mt-2">
                    Last updated: {new Date(recoverableProgress.updatedAt).toLocaleString()}
                  </p>
                </div>

                <div className="flex gap-3">
                  <button
                    onClick={handleDiscardRecovery}
                    className="flex-1 px-4 py-2.5 rounded-lg border border-gray-300 text-gray-700 hover:bg-gray-50 transition-colors font-medium"
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

      {/* Sidebar — always visible (collapsed icon-rail or expanded) */}
      <MainSidebar
        currentView={currentView}
        onViewChange={(view) => {
          if (view === 'notes' && selectedTask) {
            setCurrentView('notes', selectedTask.id);
          } else if (view === 'chat') {
            setCurrentView('chat', selectedTask?.id);
          } else {
            setCurrentView(view);
          }
        }}
        isOpen={isSidebarOpen}
        onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
        session={session}
        onSignOut={() => { clearUserState(); supabase.auth.signOut(); }}
        status={status}
      />

      {/* Main Content Area — white rounded container */}
      <div className="flex-1 flex flex-col overflow-hidden relative">
        {/* Top drag region — enables double-click to zoom (macOS native behavior) */}
        <div data-tauri-drag-region className="w-full h-10 flex-shrink-0 cursor-default" style={{ WebkitUserSelect: 'none', userSelect: 'none' }} />
        <div className="flex-1 flex overflow-hidden pr-2.5 pl-1.5 pb-2.5 pt-0">
        <main className="flex-1 bg-white w-full relative overflow-y-auto rounded-tl-2xl rounded-tr-2xl rounded-bl-2xl rounded-br-2xl shadow-sm border border-[#e8e0d8]/50">
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
                  realtimeTranscript={realtimeTranscript}
                  interimTranscript={interimTranscript}
                  permissionsGranted={permissionsGranted}
                  onPermissionsGranted={() => setPermissionsGranted(true)}
                  currentInputDevice={currentInputDevice}
                  deviceRestartNotice={deviceRestartNotice}
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
              />
            )}

            {currentView === 'notes' && (
              selectedTask ? (
                <NotesPage
                  selectedTask={selectedTask}
                  onNavigateToAssets={() => {}}
                  onTaskUpdated={handleTaskUpdated}
                />
              ) : (
                <HistoryPage
                  history={history}
                  onSelectTask={(task) => {
                    setSelectedTask(task);
                    setCurrentView('notes', task.id);
                  }}
                  onTaskUpdated={handleTaskUpdated}
                />
              )
            )}

            {currentView === 'chat' && (
              <ChatPage
                selectedTask={selectedTask}
                history={history}
                onSelectTask={(task) => {
                  if (task) {
                    // Resolve from canonical history type to avoid cross-component type drift.
                    const resolvedTask = history.find(h => h.id === task.id) ?? (task as TaskHistory);
                    setSelectedTask(resolvedTask);
                    fetchChatHistory(resolvedTask.id!);
                  } else {
                    setSelectedTask(null);
                    fetchChatHistory(null);
                  }
                }}
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
              />
            )}



            {currentView === 'notebooks' && (
              <motion.div
                key="notebooks"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full"
              >
                {activeNote !== undefined && activeNote !== null ? (
                  <ManualNoteEditor
                    note={activeNote}
                    onSave={(saved) => setActiveNote(saved)}
                    onBack={() => {
                      setActiveNote(null);
                      setNotebookRefreshKey(k => k + 1);
                    }}
                  />
                ) : (
                  <ManualNotesList
                    key={notebookRefreshKey}
                    onSelectNote={(note) => setActiveNote(note)}
                    onCreateNote={() => setActiveNote({ title: 'Untitled', content: '' })}
                  />
                )}
              </motion.div>
            )}

            {currentView === 'knowledge' && (
              <KnowledgePage
                kgData={kgData}
                isLoadingKG={isLoadingKG}
                kgProgress={kgProgress}
                isExtractingNewKG={isExtractingNewKG}
                kgBuilt={kgBuilt}
                buildKnowledgeGraph={buildKnowledgeGraph}
                historyLength={history.length}
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
          </AnimatePresence>
        </main>
        </div>
      </div>
    </div>
  );
}
