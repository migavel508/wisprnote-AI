import React, { useState, useRef, useEffect } from 'react';
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
  Sidebar as SidebarIcon
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
  supabase, 
  saveTask, 
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

import Auth from './components/Auth';
import ChatPage from './pages/ChatPage';
import NotesPage from './pages/NotesPage';
import HistoryPage from './pages/HistoryPage';
import KnowledgePage from './pages/KnowledgePage';
import ProcessPage from './pages/ProcessPage';
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

type View = 'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks';
type Status = 'idle' | 'splitting' | 'processing' | 'completed' | 'error';
type NoteTab = 'transcription' | 'summary' | 'notes';

interface Message {
  role: 'user' | 'model';
  text: string;
  image?: string;
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
    }
  };

  const [session, setSession] = useState<Session | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'splitting' | 'processing' | 'completed' | 'error'>('idle');
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Recovery state
  const [hasRecoverableProgress, setHasRecoverableProgress] = useState(false);
  const [recoverableProgress, setRecoverableProgress] = useState<ProcessingProgress | null>(null);
  const [showRecoveryPrompt, setShowRecoveryPrompt] = useState(false);
  const currentProgressIdRef = useRef<string | null>(null);
  
  // Network status
  const [isOnline, setIsOnline] = useState(navigator.onLine);
  const [wasOffline, setWasOffline] = useState(false);
  const [showReconnectingMessage, setShowReconnectingMessage] = useState(false);
  
  // Recording State
  const [inputMode, setInputMode] = useState<'upload' | 'record'>('upload');
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  // Notebooks (manual notes) state
  const [activeNote, setActiveNote] = useState<ManualNote | null>(null);
  const [notebookRefreshKey, setNotebookRefreshKey] = useState(0);

  const [history, setHistory] = useState<TaskHistory[]>([]);
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
  const [chatMessages, setChatMessages] = useState<Message[]>([]);
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

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
    });

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange((_event, session) => {
      setSession(session);
    });

    return () => subscription.unsubscribe();
  }, []);

  // Network status monitoring
  useEffect(() => {
    const handleOnline = async () => {
      setIsOnline(true);
      
      // If we were processing when we went offline, auto-resume
      if (wasOffline && currentProgressIdRef.current) {
        setShowReconnectingMessage(true);
        try {
          const progress = await progressStorage.getProgress(currentProgressIdRef.current);
          if (progress && progress.completedBatches < progress.totalBatches) {
            console.log('Network reconnected - auto-resuming processing');
            await startProcessing(progress);
          }
        } catch (err) {
          console.error('Failed to auto-resume:', err);
        } finally {
          setShowReconnectingMessage(false);
          setWasOffline(false);
        }
      }
    };
    
    const handleOffline = () => {
      setIsOnline(false);
      if (status === 'processing') {
        setWasOffline(true);
      }
    };
    
    window.addEventListener('online', handleOnline);
    window.addEventListener('offline', handleOffline);
    
    return () => {
      window.removeEventListener('online', handleOnline);
      window.removeEventListener('offline', handleOffline);
    };
  }, [wasOffline, status]);

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
    }
  }, [selectedTask]);

  const fetchAgentAssets = async (taskId: string) => {
    try {
      const data = await getAssets(taskId);
      const agentAssets = data.filter((a: GeneratedAsset) => a.type === 'email' || a.type === 'wiki');
      setAgentAssetHistory(agentAssets);
    } catch (err) {
      console.error('Failed to fetch assets:', err);
    }
  };

  const fetchChatHistory = async (taskId: string) => {
    try {
      const data = await getChatHistory(taskId);
      // Transform to Message format
      const messages: Message[] = data.map(msg => ({
        role: msg.role,
        text: msg.text,
        image: msg.image
      }));
      setChatMessages(messages);
    } catch (err) {
      console.error('Failed to fetch chat history:', err);
      setChatMessages([]);
    }
  };


  // Cleanup recording on unmount
  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
        mediaRecorderRef.current.stop();
      }
    };
  }, []);

  const formatTime = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  };

  const startRecording = async () => {
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
  };

  const pauseRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      mediaRecorderRef.current.pause();
      setIsPaused(true);
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
    }
  };

  const resumeRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      mediaRecorderRef.current.resume();
      setIsPaused(false);
      timerRef.current = setInterval(() => {
        setRecordingTime(prev => prev + 1);
      }, 1000);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && (mediaRecorderRef.current.state === 'recording' || mediaRecorderRef.current.state === 'paused')) {
      mediaRecorderRef.current.stop();
      setIsRecording(false);
      setIsPaused(false);
      if (timerRef.current) {
        clearInterval(timerRef.current);
      }
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

  // Auto-sync Knowledge Graph: check if any meetings in history are missing from KG
  useEffect(() => {
    // Only run if both history and kgData are loaded, and we're not already extracting
    if (history.length > 0 && kgBuilt && !isExtractingNewKG) {
      const syncMissingMeetingsToKG = async () => {
        // Find tasks in history that don't have a corresponding entry in kgData
        const kgTaskIds = new Set(kgData.map(kg => kg.meetingId));
        const missingTasks = history.filter(task => task.id && !kgTaskIds.has(task.id) && task.status === 'completed' && task.transcription && task.transcription.trim().length > 0);
        
        if (missingTasks.length === 0) return;
        
        console.log(`Found ${missingTasks.length} meetings missing from Knowledge Graph. Starting auto-sync...`);
        setIsExtractingNewKG(true);
        
        try {
          // Process missing tasks one by one
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
              
              // Save to Supabase
              await saveKnowledgeGraphBatch([entryToSave]);
              
              // Update local state
              setKgData(prevData => [...prevData, result]);
              
              // Respect API rate limits
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
  }, [history, kgData, kgBuilt, isExtractingNewKG]);

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
    if (!chatInput.trim() || !selectedTask || !selectedTask.id || isChatting) return;

    // Ensure we have transcription content
    if (!selectedTask.transcription) {
      setChatMessages(prev => [...prev, { role: 'model', text: 'Unable to chat: No transcription content available for this meeting.' }]);
      return;
    }

    const userMessage: Message = { role: 'user', text: chatInput };
    const userInput = chatInput;
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsChatting(true);

    try {
      // Save user message to Supabase
      await saveChatMessage({
        task_id: selectedTask.id,
        role: 'user',
        text: userInput
      });

      const history = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      // Pass all available sources for richer RAG context
      const response = await chatWithNotes(
        {
          transcription: selectedTask.transcription,
          notes: selectedTask.notes || '',
          summary: selectedTask.summary || '',
          title: selectedTask.filename || '',
        },
        userInput,
        history,
        true
      );

      const modelMessage: Message = { role: 'model', text: response };
      setChatMessages(prev => [...prev, modelMessage]);

      // Save model response to Supabase
      await saveChatMessage({
        task_id: selectedTask.id!,
        role: 'model',
        text: response
      });
    } catch (err) {
      console.error('Chat error:', err);
      setChatMessages(prev => [...prev, { role: 'model', text: 'Sorry, I encountered an error while processing your request.' }]);
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
          image: imageUrl
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
      // We will sync KG data after both history and KG data are loaded, handled by a separate useEffect
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

  const startProcessing = async (resumeFromProgress?: ProcessingProgress) => {
    if (!file && !resumeFromProgress) return;

    try {
      const currentFile = file || (resumeFromProgress?.audioBlob ? new File([resumeFromProgress.audioBlob], resumeFromProgress.filename) : null);
      if (!currentFile) {
        throw new Error('No audio file available');
      }

      let fullTranscription: string;
      
      // ─── Large File Path: Use Gemini File API ───────────────────────────────
      if (shouldUseFileAPI(currentFile) && !resumeFromProgress) {
        setStatus('processing');
        setError(null);
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
        const CONCURRENCY = 3;

        // Process only pending/error batches
        const batchesToProcess = results
          .map((b, idx) => ({ batch: b, originalIndex: idx }))
          .filter(({ batch }) => batch.status === 'pending' || batch.status === 'error');

        for (let i = 0; i < batchesToProcess.length; i += CONCURRENCY) {
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
                results[originalIndex] = { ...results[originalIndex], status: 'error', error: err.message || 'Unknown error' };
              }
              
              // Save progress after each batch completes
              const completedCount = results.filter(r => r.status === 'completed').length;
              await progressStorage.saveProgress({
                id: progressId,
                filename: currentFile.name,
                prompt,
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

      setStatus('completed');

      if (!fullTranscription.trim()) {
        throw new Error('Transcription returned empty — please check the audio file and try again.');
      }

      // ── Post-processing: run summary, notes, title & duration all in parallel ─
      const getDuration = (): Promise<number> =>
        new Promise(resolve => {
          const audioFile = file || (resumeFromProgress?.audioBlob ? new File([resumeFromProgress.audioBlob], 'audio') : null);
          if (!audioFile) { resolve(0); return; }
          const audio = new Audio();
          audio.src = URL.createObjectURL(audioFile);
          audio.onloadedmetadata = () => { URL.revokeObjectURL(audio.src); resolve(Math.round(audio.duration)); };
          audio.onerror = () => resolve(0);
        });

      const [summary, notes, meetingTitle, duration] = await Promise.all([
        generateSummary(fullTranscription),
        generateNotes(fullTranscription),
        generateMeetingTitle(fullTranscription),
        getDuration(),
      ]);

      const newTask: TaskHistory = {
        filename: meetingTitle,
        transcription: fullTranscription,
        summary,
        notes,
        prompt,
        status: 'completed',
        duration,
      };

      const savedTask = await saveTask(newTask);

      if (savedTask && savedTask.id) {
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
      }

      setHistory([savedTask, ...history]);
      setSelectedTask(savedTask);
      setCurrentView('notes');
      setNoteTab('notes');

    } catch (err: any) {
      setError(err.message || 'Failed to process audio.');
      setStatus('error');
    }
  };

  const handleResumeProcessing = async () => {
    if (!recoverableProgress) return;
    setShowRecoveryPrompt(false);
    await startProcessing(recoverableProgress);
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

  const combinedResult = batches
    .filter(b => b.status === 'completed')
    .map(b => b.result)
    .join('\n\n---\n\n');

  if (!session) {
    return <Auth />;
  }

  return (
    <div className="h-screen bg-[#faf9f7] text-[#1a1a1a] font-[system-ui] selection:bg-[#1a1a1a] selection:text-white flex overflow-hidden">
      {/* Network Status Banner */}
      <AnimatePresence>
        {!isOnline && (
          <motion.div
            initial={{ y: -100 }}
            animate={{ y: 0 }}
            exit={{ y: -100 }}
            className="fixed top-0 left-0 right-0 z-[10000] bg-orange-500 text-white px-4 py-3 flex items-center justify-center gap-2 shadow-lg"
          >
            <AlertCircle className="w-5 h-5" />
            <span className="font-medium">No internet connection - Processing paused</span>
          </motion.div>
        )}
        {showReconnectingMessage && (
          <motion.div
            initial={{ y: -100 }}
            animate={{ y: 0 }}
            exit={{ y: -100 }}
            className="fixed top-0 left-0 right-0 z-[10000] bg-green-500 text-white px-4 py-3 flex items-center justify-center gap-2 shadow-lg"
          >
            <Loader2 className="w-5 h-5 animate-spin" />
            <span className="font-medium">Reconnected - Resuming processing...</span>
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
                      {recoverableProgress.completedBatches} / {recoverableProgress.totalBatches} batches
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

      {/* Main Sidebar Navigation */}
      <AnimatePresence initial={false}>
        {isSidebarOpen && (
          <MainSidebar
            currentView={currentView}
            onViewChange={(view) => {
              if (view === 'notes' && selectedTask) {
                setCurrentView('notes', selectedTask.id);
              } else if (view === 'chat' && selectedTask) {
                setCurrentView('chat', selectedTask.id);
              } else {
                setCurrentView(view);
              }
            }}
            isOpen={isSidebarOpen}
            onToggle={() => setIsSidebarOpen(!isSidebarOpen)}
            session={session}
            onSignOut={() => supabase.auth.signOut()}
            status={status}
          />
        )}
      </AnimatePresence>

      {/* Sidebar Toggle when closed - floating button */}
      {!isSidebarOpen && (
        <button 
          onClick={() => setIsSidebarOpen(true)}
          className="fixed top-4 left-4 z-50 text-[#595959] hover:text-[#1a1a1a] transition-colors rounded-[8px] p-2 border border-[#e3e3e0] bg-white hover:bg-[#f5f5f5] shadow-sm"
        >
          <SidebarIcon className="w-4 h-4" strokeWidth={2} />
        </button>
      )}

      {/* Main Content Area */}
      <div className="flex-1 flex overflow-hidden relative">
        <main className="flex-1 bg-[#faf9f7] w-full relative overflow-y-auto">
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
                  totalProgress={totalProgress}
                  inputMode={inputMode}
                  setInputMode={setInputMode}
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
              selectedTask ? (
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
                />
              ) : (
                <HistoryPage
                  history={history}
                  onSelectTask={(task) => {
                    setSelectedTask(task);
                    setCurrentView('chat', task.id);
                  }}
                  onTaskUpdated={handleTaskUpdated}
                />
              )
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
          </AnimatePresence>
        </main>
      </div>

    </div>
  );
}
