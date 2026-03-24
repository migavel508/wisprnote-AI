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
  FileBox,
  Presentation,
  FileSpreadsheet,
  File as FileIcon,
  Users,
  Bot,
  Mail,
  Layout,
  FileSearch,
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
import PptxGenJS from 'pptxgenjs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';
import ForceGraph2D from 'react-force-graph-2d';
import { splitAudio, AudioBatch } from './services/audioService';
import { 
  processAudioBatch, 
  generateSummary, 
  generateNotes, 
  chatWithNotes, 
  generateConceptImage,
  generatePPTContent,
  generateReportContent,
  generateEmailContent,
  generateWikiContent,
  generatePodcastScript,
  chatWithPodcast,
  extractKnowledgeGraph,
  generateMeetingTitle
} from './services/geminiService';
import { 
  supabase, 
  saveTask, 
  getTasks, 
  TaskHistory, 
  saveAsset, 
  getAssets, 
  GeneratedAsset,
  saveKnowledgeGraphBatch,
  getKnowledgeGraph,
  KnowledgeGraphEntry,
  saveChatMessage,
  getChatHistory,
  ChatMessage
} from './services/supabaseService';
import Auth from './components/Auth';
import ChatPage from './pages/ChatPage';
import NotesPage from './pages/NotesPage';
import AssetsPage from './pages/AssetsPage';
import HistoryPage from './pages/HistoryPage';
import KnowledgePage from './pages/KnowledgePage';
import ProcessPage from './pages/ProcessPage';
import MainSidebar from './components/MainSidebar';
import { Session } from '@supabase/supabase-js';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

type View = 'process' | 'history' | 'notes' | 'chat' | 'assets' | 'agents' | 'knowledge';
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
    if (path.startsWith('/assets')) return 'assets';
    if (path === '/agents') return 'agents';
    if (path === '/knowledge') return 'knowledge';
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
      case 'assets':
        navigate(taskId ? `/assets/${taskId}` : '/assets');
        break;
      case 'agents':
        navigate('/agents');
        break;
      case 'knowledge':
        navigate('/knowledge');
        break;
    }
  };

  const [session, setSession] = useState<Session | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('');
  const [status, setStatus] = useState<'idle' | 'splitting' | 'processing' | 'completed' | 'error'>('idle');
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [error, setError] = useState<string | null>(null);
  
  // Recording State
  const [inputMode, setInputMode] = useState<'upload' | 'record'>('upload');
  const [isRecording, setIsRecording] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const [recordingTime, setRecordingTime] = useState(0);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<NodeJS.Timeout | null>(null);

  const [history, setHistory] = useState<TaskHistory[]>([]);
  const [selectedTask, setSelectedTask] = useState<TaskHistory | null>(null);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true); // Start true, set false after first fetch
  
  // Extract task ID from URL and load the task
  useEffect(() => {
    const path = location.pathname;
    const match = path.match(/\/(notes|chat|assets)\/([^/]+)/);
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
  const [assetHistory, setAssetHistory] = useState<GeneratedAsset[]>([]);
  const [selectedAsset, setSelectedAsset] = useState<GeneratedAsset | null>(null);
  const [slideCount, setSlideCount] = useState(5);
  const [isGeneratingAsset, setIsGeneratingAsset] = useState(false);
  const [wikiStyle, setWikiStyle] = useState<'MECE' | 'PRD'>('MECE');
  const [agentAssetHistory, setAgentAssetHistory] = useState<GeneratedAsset[]>([]);
  const [selectedAgentAsset, setSelectedAgentAsset] = useState<GeneratedAsset | null>(null);
  
  // Podcast State
  const [podcastDialogue, setPodcastDialogue] = useState<any[]>([]);
  const [currentPodcastIndex, setCurrentPodcastIndex] = useState(-1);
  const [isPlayingPodcast, setIsPlayingPodcast] = useState(false);
  const [podcastInput, setPodcastInput] = useState('');
  const [isPodcastThinking, setIsPodcastThinking] = useState(false);
  
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
  const podcastEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (podcastEndRef.current) {
      podcastEndRef.current.scrollIntoView({ behavior: 'smooth' });
    }
  }, [podcastDialogue, currentPodcastIndex]);

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

  useEffect(() => {
    if (session) {
      fetchHistory();
    }
  }, [session]);


  useEffect(() => {
    if (selectedTask) {
      fetchAssets(selectedTask.id!);
      fetchChatHistory(selectedTask.id!);
    }
  }, [selectedTask]);

  const fetchAssets = async (taskId: string) => {
    try {
      const data = await getAssets(taskId);
      // Separate assets by type: ppt/report go to assetHistory, email/wiki go to agentAssetHistory
      const regularAssets = data.filter(a => a.type === 'ppt' || a.type === 'report');
      const agentAssets = data.filter(a => a.type === 'email' || a.type === 'wiki');
      setAssetHistory(regularAssets);
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

  const handleGeneratePPT = async () => {
    if (!selectedTask || isGeneratingAsset) return;
    setIsGeneratingAsset(true);
    try {
      const finalSlideCount = Math.max(3, Math.min(20, slideCount || 5));
      const content = await generatePPTContent(selectedTask.transcription, finalSlideCount);
      
      const pptx = new PptxGenJS();
      pptx.title = content.title;

      // Title Slide
      const titleSlide = pptx.addSlide();
      titleSlide.addText(content.title, { x: 1, y: 2, w: '80%', fontSize: 44, bold: true, align: 'center' });

      // Content Slides
      content.slides.forEach((slide: any) => {
        const s = pptx.addSlide();
        s.addText(slide.title, { x: 0.5, y: 0.5, w: '90%', fontSize: 32, bold: true, color: '363636' });
        s.addText(slide.content.join('\n'), { x: 0.5, y: 1.5, w: '90%', h: '70%', fontSize: 18, bullet: true });
      });

      const filename = `${selectedTask.filename.split('.')[0]}_Presentation.pptx`;
      await pptx.writeFile({ fileName: filename });

      const asset = await saveAsset({
        task_id: selectedTask.id!,
        type: 'ppt',
        filename,
        content
      });

      setAssetHistory([asset, ...assetHistory]);
      setSelectedAsset(asset);
    } catch (err) {
      console.error('PPT generation error:', err);
    } finally {
      setIsGeneratingAsset(false);
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

  const handleGenerateReport = async () => {
    if (!selectedTask || isGeneratingAsset) return;
    setIsGeneratingAsset(true);
    try {
      const content = await generateReportContent(selectedTask.transcription);
      
      const doc = new Document({
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              text: content.title,
              heading: HeadingLevel.TITLE,
            }),
            ...content.sections.flatMap((section: any) => [
              new Paragraph({
                text: section.heading,
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 400, after: 200 },
              }),
              new Paragraph({
                children: [new TextRun(section.body)],
              }),
            ]),
          ],
        }],
      });

      const blob = await Packer.toBlob(doc);
      const filename = `${selectedTask.filename.split('.')[0]}_Report.docx`;
      saveAs(blob, filename);

      const asset = await saveAsset({
        task_id: selectedTask.id!,
        type: 'report',
        filename,
        content
      });

      setAssetHistory([asset, ...assetHistory]);
      setSelectedAsset(asset);
    } catch (err) {
      console.error('Report generation error:', err);
    } finally {
      setIsGeneratingAsset(false);
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
        const missingTasks = history.filter(task => task.id && !kgTaskIds.has(task.id) && task.status === 'completed');
        
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
                await new Promise(resolve => setTimeout(resolve, 3000));
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
    setKgProgress({ current: 0, total: history.length });
    
    try {
      const results = [];
      // Process sequentially to avoid Gemini API 429 Too Many Requests rate limits
      for (let i = 0; i < history.length; i++) {
        const task = history[i];
        try {
          const result = await extractKnowledgeGraph(task.id!, task.filename, task.transcription);
          results.push(result);
        } catch (taskErr) {
          console.error(`Failed to extract KG for meeting ${task.id}:`, taskErr);
          // Push empty/fallback data so we don't drop the meeting entirely
          results.push({ meetingId: task.id!, meetingTitle: task.filename, topics: [], decisions: [], people: [], actionItems: [], refs: [] });
        }
        setKgProgress({ current: i + 1, total: history.length });
        
        // Wait 3 seconds between requests to respect free tier rate limits (~15 RPM)
        if (i < history.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 3000));
        }
      }
      
      // Persist to Supabase
      const entriesToSave: KnowledgeGraphEntry[] = results.map(r => ({
        task_id: r.meetingId,
        meeting_title: r.meetingTitle,
        topics: r.topics || [],
        decisions: r.decisions || [],
        people: r.people || [],
        action_items: r.actionItems || [],
        refs: r.references || []
      }));
      
      try {
        await saveKnowledgeGraphBatch(entriesToSave);
        console.log('Knowledge graph persisted to Supabase');
      } catch (saveErr) {
        console.error('Failed to persist KG to Supabase:', saveErr);
        // Continue anyway - we still have the data in memory
      }
      
      setKgData(results);
      setKgBuilt(true);
    } catch (err) {
      console.error('KG build error:', err);
      setError('Failed to build knowledge graph.');
    } finally {
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

  const playPodcastLine = (line: any) => {
    if (!('speechSynthesis' in window) || !line) return;
    
    // Stop any ongoing speech
    window.speechSynthesis.cancel();
    
    const utterance = new SpeechSynthesisUtterance(line.text);
    
    // Give them distinct voices (heuristic based on availability)
    const voices = window.speechSynthesis.getVoices();
    if (line.speaker === 'Alex') {
      utterance.voice = voices.find(v => v.name.includes('Male') || v.name.includes('Daniel') || v.name.includes('David')) || voices[0];
      utterance.pitch = 1.0;
      utterance.rate = 1.05;
    } else if (line.speaker === 'Sarah') {
      utterance.voice = voices.find(v => v.name.includes('Female') || v.name.includes('Samantha') || v.name.includes('Karen') || v.name.includes('Victoria')) || voices[0];
      utterance.pitch = 1.2;
      utterance.rate = 1.05;
    } else {
      // Guest voice
      utterance.voice = voices.find(v => v.name.includes('Google') || v.lang === 'en-GB') || voices[0];
      utterance.pitch = 0.9;
    }

    utterance.onend = () => {
      // Trigger the next line in the effect instead of directly to avoid stale state closures
      setCurrentPodcastIndex(prev => prev + 1);
    };

    window.speechSynthesis.speak(utterance);
  };

  // Effect to handle sequential podcast playback
  useEffect(() => {
    if (isPlayingPodcast && currentPodcastIndex >= 0 && currentPodcastIndex < podcastDialogue.length) {
      // Small delay between speakers
      const timer = setTimeout(() => {
        playPodcastLine(podcastDialogue[currentPodcastIndex]);
      }, 500);
      return () => clearTimeout(timer);
    } else if (currentPodcastIndex >= podcastDialogue.length) {
      setIsPlayingPodcast(false);
    }
  }, [currentPodcastIndex, isPlayingPodcast]);

  const handlePodcastInputSubmit = async () => {
    if (!podcastInput.trim() || !selectedTask) return;
    
    const userMsg = podcastInput;
    setPodcastInput('');
    setIsPodcastThinking(true);
    
    // Stop current playback to handle interruption
    window.speechSynthesis.cancel();
    setIsPlayingPodcast(false);
    
    // Add user message to dialogue
    const newDialogue = [
      ...podcastDialogue.slice(0, currentPodcastIndex + 1), // Keep history up to current point
      { speaker: 'Guest', text: userMsg, emotion: 'eager' }
    ];
    setPodcastDialogue(newDialogue);
    setCurrentPodcastIndex(newDialogue.length - 1);
    
    try {
      const responseLines = await chatWithPodcast(
        selectedTask.transcription,
        newDialogue,
        userMsg
      );
      
      const updatedDialogue = [...newDialogue, ...responseLines];
      setPodcastDialogue(updatedDialogue);
      setIsPodcastThinking(false);
      setIsPlayingPodcast(true);
      setCurrentPodcastIndex(newDialogue.length); // Start playing the first response line
    } catch (err) {
      console.error('Podcast chat error:', err);
      setIsPodcastThinking(false);
    }
  };

  const handleAgentAction = async (agentType: 'email' | 'wiki' | 'podcast') => {
    if (!selectedTask || isGeneratingAsset) {
      if (!selectedTask) {
        setCurrentView('history');
        setError('Please select a task from history first to use agents.');
      }
      return;
    }
    
    setIsGeneratingAsset(true);

    try {
      if (agentType === 'podcast') {
        const script = await generatePodcastScript(selectedTask.transcription);
        setPodcastDialogue(script.dialogue);
        setCurrentPodcastIndex(0);
        setIsPlayingPodcast(true);
        // We don't save podcast to DB yet, just play it
        setIsGeneratingAsset(false);
        playPodcastLine(script.dialogue[0]);
        return;
      }

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
    if (asset.type === 'ppt') {
      const pptx = new PptxGenJS();
      pptx.title = asset.content.title;
      const titleSlide = pptx.addSlide();
      titleSlide.addText(asset.content.title, { x: 1, y: 2, w: '80%', fontSize: 44, bold: true, align: 'center' });
      asset.content.slides.forEach((slide: any) => {
        const s = pptx.addSlide();
        s.addText(slide.title, { x: 0.5, y: 0.5, w: '90%', fontSize: 32, bold: true, color: '363636' });
        s.addText(slide.content.join('\n'), { x: 0.5, y: 1.5, w: '90%', h: '70%', fontSize: 18, bullet: true });
      });
      await pptx.writeFile({ fileName: asset.filename });
    } else if (asset.type === 'report') {
      const doc = new Document({
        sections: [{
          children: [
            new Paragraph({ text: asset.content.title, heading: HeadingLevel.TITLE }),
            ...asset.content.sections.flatMap((section: any) => [
              new Paragraph({ text: section.heading, heading: HeadingLevel.HEADING_1, spacing: { before: 400, after: 200 } }),
              new Paragraph({ children: [new TextRun(section.body)] }),
            ]),
          ],
        }],
      });
      const blob = await Packer.toBlob(doc);
      saveAs(blob, asset.filename);
    } else if (asset.type === 'email') {
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
      saveAs(blob, asset.filename);
    } else if (asset.type === 'wiki') {
      // Download as styled DOCX
      const doc = new Document({
        styles: {
          paragraphStyles: [
            {
              id: "Title",
              name: "Title",
              basedOn: "Normal",
              next: "Normal",
              run: { size: 56, bold: true, color: "141414" },
              paragraph: { spacing: { after: 300 } }
            },
            {
              id: "Subtitle",
              name: "Subtitle",
              basedOn: "Normal",
              next: "Normal",
              run: { size: 28, italics: true, color: "666666" },
              paragraph: { spacing: { after: 400 } }
            }
          ]
        },
        sections: [{
          properties: {},
          children: [
            new Paragraph({
              text: asset.content.title || 'Wiki Document',
              heading: HeadingLevel.TITLE,
              spacing: { after: 200 }
            }),
            new Paragraph({
              children: [
                new TextRun({ text: asset.content.subtitle || '', italics: true, color: "666666" })
              ],
              spacing: { after: 200 }
            }),
            new Paragraph({
              children: [
                new TextRun({ text: `Date: ${asset.content.date || new Date().toLocaleDateString()}`, size: 20, color: "999999" })
              ],
              spacing: { after: 400 }
            }),
            new Paragraph({
              children: [new TextRun({ text: "─".repeat(50), color: "CCCCCC" })],
              spacing: { after: 400 }
            }),
            ...(asset.content.sections || []).flatMap((section: any) => [
              new Paragraph({
                text: section.heading,
                heading: HeadingLevel.HEADING_1,
                spacing: { before: 400, after: 200 }
              }),
              new Paragraph({
                children: [new TextRun({ text: section.content, size: 24 })],
                spacing: { after: 200 }
              }),
              ...(section.bullets || []).map((bullet: string) => 
                new Paragraph({
                  children: [new TextRun({ text: `• ${bullet}`, size: 22 })],
                  spacing: { after: 100 },
                  indent: { left: 720 }
                })
              ),
              new Paragraph({ text: "", spacing: { after: 200 } })
            ]),
            new Paragraph({
              children: [new TextRun({ text: "─".repeat(50), color: "CCCCCC" })],
              spacing: { before: 400, after: 200 }
            }),
            new Paragraph({
              text: "Conclusion",
              heading: HeadingLevel.HEADING_1,
              spacing: { after: 200 }
            }),
            new Paragraph({
              children: [new TextRun({ text: asset.content.conclusion || '', size: 24, italics: true })],
              spacing: { after: 400 }
            })
          ]
        }]
      });
      const blob = await Packer.toBlob(doc);
      saveAs(blob, asset.filename);
    }
  };

  const handleSendMessage = async () => {
    if (!chatInput.trim() || !selectedTask || isChatting) return;

    const userMessage: Message = { role: 'user', text: chatInput };
    const userInput = chatInput;
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsChatting(true);

    try {
      // Save user message to Supabase
      await saveChatMessage({
        task_id: selectedTask.id!,
        role: 'user',
        text: userInput
      });

      const history = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      const response = await chatWithNotes(
        selectedTask.transcription + '\n\n' + (selectedTask.summary || '') + '\n\n' + (selectedTask.notes || ''),
        userInput,
        history
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
    // Update history array
    setHistory(prev => prev.map(task => 
      task.id === updatedTask.id ? updatedTask : task
    ));
    // Update selectedTask if it's the same task
    if (selectedTask?.id === updatedTask.id) {
      setSelectedTask(updatedTask);
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

  const startProcessing = async () => {
    if (!file) return;

    try {
      setStatus('splitting');
      setError(null);
      
      const audioBatches = await splitAudio(file, 15);
      const initialBatches: BatchStatus[] = audioBatches.map(b => ({ ...b, status: 'pending' }));
      setBatches(initialBatches);
      setStatus('processing');

      const results: BatchStatus[] = [...initialBatches];
      let fullTranscription = '';
      
      for (let i = 0; i < results.length; i++) {
        results[i].status = 'processing';
        setBatches([...results]);

        try {
          const result = await processAudioBatch(results[i], prompt);
          results[i].status = 'completed';
          results[i].result = result.text;
          fullTranscription += result.text + '\n\n';
        } catch (err: any) {
          results[i].status = 'error';
          results[i].error = err.message || 'Unknown error';
        }
        setBatches([...results]);
      }

      setStatus('completed');

      // Generate title, summary and notes automatically (run title generation in parallel)
      const [meetingTitle, summary, notes] = await Promise.all([
        generateMeetingTitle(fullTranscription),
        generateSummary(fullTranscription),
        generateNotes(fullTranscription)
      ]);

      // Get audio duration
      const getDuration = (): Promise<number> => {
        return new Promise((resolve) => {
          const audio = new Audio();
          audio.src = URL.createObjectURL(file);
          audio.onloadedmetadata = () => {
            URL.revokeObjectURL(audio.src);
            resolve(Math.round(audio.duration));
          };
          audio.onerror = () => resolve(0);
        });
      };
      const duration = await getDuration();

      // Save to Supabase with AI-generated title
      const newTask: TaskHistory = {
        filename: meetingTitle,
        transcription: fullTranscription,
        summary,
        notes,
        prompt,
        status: 'completed',
        duration
      };
      
      const savedTask = await saveTask(newTask);
      
      // Attempt to immediately process knowledge graph data in the background
      if (savedTask && savedTask.id) {
        setIsExtractingNewKG(true);
        // Run without blocking the main thread
        extractKnowledgeGraph(savedTask.id, savedTask.filename, savedTask.transcription)
          .then(async (result) => {
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
            
            // Update local state if we already have graph data loaded
            setKgData(prevData => {
              // If prevData is empty, we haven't built the graph yet, so no need to append
              if (prevData.length === 0) return prevData;
              
              // Remove if already exists (just in case), then append
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
              } else if (view === 'assets' && selectedTask) {
                setCurrentView('assets', selectedTask.id);
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
        <main className="flex-1 bg-white w-full relative overflow-y-auto">
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
                  onNavigateToAssets={() => setCurrentView('assets', selectedTask.id)}
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

            {currentView === 'assets' && (
              selectedTask ? (
                <AssetsPage
                  selectedTask={selectedTask}
                  slideCount={slideCount}
                  setSlideCount={setSlideCount}
                  isGeneratingAsset={isGeneratingAsset}
                  handleGeneratePPT={handleGeneratePPT}
                  handleGenerateReport={handleGenerateReport}
                  selectedAsset={selectedAsset}
                  setSelectedAsset={setSelectedAsset}
                  assetHistory={assetHistory}
                  downloadExistingAsset={downloadExistingAsset}
                />
              ) : (
                <HistoryPage
                  history={history}
                  onSelectTask={(task) => {
                    setSelectedTask(task);
                    setCurrentView('assets', task.id);
                  }}
                  onTaskUpdated={handleTaskUpdated}
                />
              )
            )}

            {currentView === 'agents' && (
              <motion.div 
                key="agents"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="min-h-full bg-white p-4 sm:p-8"
              >
                <div className="max-w-5xl mx-auto">
                  <div className="flex items-center gap-4 mb-8 opacity-50 text-sm overflow-x-auto no-scrollbar whitespace-nowrap">
                    <Bot className="w-4 h-4 flex-shrink-0" />
                    <span>Agents</span>
                    {selectedTask && (
                      <>
                        <span>/</span>
                        <span className="truncate">{selectedTask.filename}</span>
                      </>
                    )}
                  </div>

                  <h1 className="text-3xl sm:text-4xl font-bold mb-12 tracking-tight">AI Agents</h1>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
                    <div className="lg:col-span-2 space-y-8">
                      {/* Agent Options */}
                      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        {/* Follow-up Email Agent */}
                        <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                          <div className="flex items-center gap-3 mb-6">
                            <div className="p-3 bg-blue-100 text-blue-600 rounded-xl">
                              <Mail className="w-6 h-6" />
                            </div>
                            <div>
                              <h3 className="font-bold">Follow-up Email</h3>
                              <p className="text-[10px] opacity-50 uppercase font-mono">Markdown Format</p>
                            </div>
                          </div>
                          
                          <div className="flex-1 mb-8">
                            <p className="text-xs opacity-60">Drafts a professional follow-up email with tasks, owners, and next steps.</p>
                          </div>

                          <button 
                            onClick={() => handleAgentAction('email')}
                            disabled={isGeneratingAsset || !selectedTask}
                            className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                          >
                            {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                            Generate Email
                          </button>
                        </div>

                        {/* Wiki Agent */}
                        <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                          <div className="flex items-center gap-3 mb-6">
                            <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
                              <BookOpen className="w-6 h-6" />
                            </div>
                            <div>
                              <h3 className="font-bold">Wiki Report</h3>
                              <p className="text-[10px] opacity-50 uppercase font-mono">Markdown Format</p>
                            </div>
                          </div>
                          
                          <div className="flex-1 space-y-4 mb-8">
                            <div className="flex gap-2 p-1 bg-[#F5F5F5] rounded-lg border border-[#141414]/5">
                              <button 
                                onClick={() => setWikiStyle('MECE')}
                                className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest rounded-md transition-all ${wikiStyle === 'MECE' ? 'bg-white shadow-sm text-[#141414] font-bold' : 'opacity-40 hover:opacity-100'}`}
                              >
                                MECE
                              </button>
                              <button 
                                onClick={() => setWikiStyle('PRD')}
                                className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest rounded-md transition-all ${wikiStyle === 'PRD' ? 'bg-white shadow-sm text-[#141414] font-bold' : 'opacity-40 hover:opacity-100'}`}
                              >
                                PRD
                              </button>
                            </div>
                            <p className="text-xs opacity-60">
                              {wikiStyle === 'MECE' 
                                ? "MECE framework for logical grouping."
                                : "PRD with UI/UX, User Stories, Tasks."}
                            </p>
                          </div>

                          <button 
                            onClick={() => handleAgentAction('wiki')}
                            disabled={isGeneratingAsset || !selectedTask}
                            className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                          >
                            {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layout className="w-4 h-4" />}
                            Generate Wiki
                          </button>
                        </div>
                        
                        {/* Podcast Agent */}
                        <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col md:col-span-2">
                          <div className="flex items-center justify-between mb-6">
                            <div className="flex items-center gap-3">
                              <div className="p-3 bg-green-100 text-green-600 rounded-xl">
                                <Bot className="w-6 h-6" />
                              </div>
                              <div>
                                <h3 className="font-bold text-lg">Live Podcast Studio</h3>
                                <p className="text-[10px] opacity-50 uppercase font-mono mt-1">Interactive Audio Experience</p>
                              </div>
                            </div>
                            <div className="flex items-center gap-2">
                              <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                              <span className="text-xs font-mono opacity-60">Hosts: Alex & Sarah</span>
                            </div>
                          </div>
                          
                          <div className="flex-1 mb-8">
                            <p className="text-sm opacity-80 leading-relaxed max-w-2xl">
                              Transform your meeting notes into an engaging, dynamic podcast. Two AI hosts (Alex & Sarah) will discuss the key points, banter, and break down complex topics. You can even join the studio live to interact with them and steer the conversation.
                            </p>
                          </div>

                          <button 
                            onClick={() => handleAgentAction('podcast' as any)}
                            disabled={isGeneratingAsset || !selectedTask}
                            className="w-full sm:w-auto py-3 px-8 bg-green-600 text-white font-bold uppercase tracking-widest text-xs hover:bg-green-700 transition-colors disabled:opacity-30 flex items-center justify-center gap-3 rounded-lg shadow-sm"
                          >
                            {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4 fill-current" />}
                            Start Podcast Session
                          </button>
                        </div>
                      </section>

                      {/* Preview Area */}
                      <section className="border border-[#141414] bg-[#F5F5F5] p-4 sm:p-8 rounded-2xl min-h-[400px] flex flex-col">
                        {!selectedTask ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center">
                            <History className="w-12 h-12 mb-4 opacity-10" />
                            <h3 className="text-lg font-serif italic opacity-30">Select a Task First</h3>
                            <p className="text-xs opacity-30 mt-2">Go to History and select a task to use agents</p>
                            <button 
                              onClick={() => setCurrentView('history')}
                              className="mt-4 px-4 py-2 border border-[#141414] text-xs font-mono uppercase tracking-widest hover:bg-[#141414] hover:text-white transition-all"
                            >
                              Go to History
                            </button>
                          </div>
                        ) : podcastDialogue.length > 0 ? (
                          <div className="flex-1 flex flex-col h-[600px] bg-white border border-[#141414]/10 rounded-xl overflow-hidden shadow-sm">
                            <div className="bg-[#141414] text-white p-4 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <Bot className="w-5 h-5 text-green-400" />
                                <div>
                                  <h3 className="font-bold text-sm">Live Podcast Studio</h3>
                                  <p className="text-[10px] text-green-400 font-mono flex items-center gap-1">
                                    <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
                                    ON AIR
                                  </p>
                                </div>
                              </div>
                              <button 
                                onClick={() => {
                                  if (isPlayingPodcast) {
                                    window.speechSynthesis.cancel();
                                    setIsPlayingPodcast(false);
                                  } else {
                                    setIsPlayingPodcast(true);
                                  }
                                }}
                                className="p-2 rounded-full hover:bg-white/10 transition-colors"
                              >
                                {isPlayingPodcast ? <span className="w-4 h-4 block bg-red-500 rounded-sm" /> : <Play className="w-4 h-4 fill-current" />}
                              </button>
                            </div>
                            
                            <div className="flex-1 overflow-y-auto p-6 space-y-6 bg-[#FAFAFA]">
                              {podcastDialogue.map((line, idx) => (
                                <motion.div 
                                  key={idx}
                                  initial={{ opacity: 0, y: 10 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  className={`flex ${line.speaker === 'Guest' ? 'justify-end' : 'justify-start'}`}
                                >
                                  <div className={`flex max-w-[85%] gap-3 ${line.speaker === 'Guest' ? 'flex-row-reverse' : 'flex-row'}`}>
                                    <div className={`w-8 h-8 rounded-full flex items-center justify-center text-[10px] font-bold shadow-sm shrink-0 ${
                                      line.speaker === 'Alex' ? 'bg-blue-100 text-blue-700' :
                                      line.speaker === 'Sarah' ? 'bg-purple-100 text-purple-700' :
                                      'bg-[#141414] text-white'
                                    }`}>
                                      {line.speaker === 'Guest' ? 'ME' : line.speaker.substring(0, 1)}
                                    </div>
                                    <div className={`p-4 rounded-2xl shadow-sm ${
                                      line.speaker === 'Guest' ? 'bg-[#141414] text-white' : 
                                      idx === currentPodcastIndex && isPlayingPodcast ? 'bg-white border-2 border-green-400' : 'bg-white border border-[#141414]/5'
                                    }`}>
                                      <div className={`text-[10px] font-mono uppercase mb-1 ${line.speaker === 'Guest' ? 'text-gray-300' : 'text-gray-500'}`}>
                                        {line.speaker} {line.emotion && <span className="italic normal-case opacity-70">({line.emotion})</span>}
                                      </div>
                                      <p className="text-sm leading-relaxed">{line.text}</p>
                                    </div>
                                  </div>
                                </motion.div>
                              ))}
                              
                              {isPodcastThinking && (
                                <div className="flex justify-start">
                                  <div className="bg-white border border-[#141414]/10 p-4 rounded-2xl shadow-sm flex items-center gap-3">
                                    <Loader2 className="w-4 h-4 animate-spin opacity-40" />
                                    <span className="text-xs font-mono opacity-50">Alex & Sarah are thinking...</span>
                                  </div>
                                </div>
                              )}
                              
                              <div ref={podcastEndRef} />
                            </div>
                            
                            <div className="p-4 bg-white border-t border-[#141414]/10">
                              <div className="flex flex-col gap-2">
                                <label className="text-[10px] font-mono uppercase text-gray-500">Join the Conversation</label>
                                <div className="flex items-center gap-2">
                                  <input 
                                    type="text" 
                                    value={podcastInput}
                                    onChange={(e) => setPodcastInput(e.target.value)}
                                    onKeyDown={(e) => e.key === 'Enter' && handlePodcastInputSubmit()}
                                    placeholder="Ask a question or add a point..."
                                    className="flex-1 bg-gray-50 border border-gray-200 rounded-lg text-sm px-4 py-2 outline-none focus:border-[#141414] transition-colors"
                                  />
                                  <button 
                                    onClick={handlePodcastInputSubmit}
                                    disabled={!podcastInput.trim() || isPodcastThinking}
                                    className="p-2.5 bg-[#141414] text-white rounded-lg hover:bg-[#333] disabled:opacity-30 transition-colors"
                                  >
                                    <Send className="w-4 h-4" />
                                  </button>
                                </div>
                              </div>
                            </div>
                          </div>
                        ) : !selectedAgentAsset ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center">
                            <Sparkles className="w-12 h-12 mb-4 opacity-10" />
                            <h3 className="text-lg font-serif italic opacity-30">Agent Output Preview</h3>
                            <p className="text-xs opacity-30 mt-2">Generate or select an agent output to see it here</p>
                          </div>
                        ) : (
                          <div className="flex-1 overflow-y-auto">
                            <div className="flex items-center justify-between mb-6 border-b border-[#141414]/10 pb-4">
                              <div className="flex items-center gap-3">
                                {selectedAgentAsset.type === 'email' ? <Mail className="w-5 h-5 text-blue-600" /> : <BookOpen className="w-5 h-5 text-purple-600" />}
                                <h3 className="font-bold text-sm">{selectedAgentAsset.filename}</h3>
                              </div>
                              <button 
                                onClick={() => downloadExistingAsset(selectedAgentAsset)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-[#141414] text-white text-[10px] font-mono uppercase tracking-widest hover:bg-[#333] transition-all"
                              >
                                <Download className="w-3 h-3" />
                                Download
                              </button>
                            </div>

                            {selectedAgentAsset.type === 'email' ? (
                              <div className="bg-white border border-[#141414]/10 rounded-xl overflow-hidden">
                                {/* Email Header Actions */}
                                <div className="bg-gray-50 border-b border-gray-200 p-4 flex items-center justify-between">
                                  <div className="flex items-center gap-2 text-sm text-gray-500">
                                    <Mail className="w-4 h-4" />
                                    <span>Ready to send</span>
                                  </div>
                                  <a 
                                    href={`mailto:?subject=${encodeURIComponent(selectedAgentAsset.content.subject || 'Follow-up Email')}&body=${encodeURIComponent(
                                      `${selectedAgentAsset.content.greeting || 'Hi Team,'}\n\n` +
                                      `Meeting Objective:\n${selectedAgentAsset.content.meetingObjective || ''}\n\n` +
                                      (selectedAgentAsset.content.keyDecisions?.length ? `Key Decisions:\n${selectedAgentAsset.content.keyDecisions.map((d: string) => `• ${d}`).join('\n')}\n\n` : '') +
                                      (selectedAgentAsset.content.discussionPoints?.length ? `Discussion Points:\n${selectedAgentAsset.content.discussionPoints.map((p: any) => `${p.topic}:\n${p.details.map((d: string) => `  - ${d}`).join('\n')}`).join('\n\n')}\n\n` : '') +
                                      (selectedAgentAsset.content.tasks?.length ? `Action Items:\n${selectedAgentAsset.content.tasks.map((t: any) => `• [${t.priority}] ${t.task} (Owner: ${t.owner}, Due: ${t.deadline}) - ${t.notes}`).join('\n')}\n\n` : '') +
                                      `Next Steps:\n${selectedAgentAsset.content.nextMeeting || ''}\n\n` +
                                      `${selectedAgentAsset.content.closing || 'Best regards'}`
                                    )}`}
                                    className="flex items-center gap-2 px-4 py-2 bg-blue-600 text-white text-sm font-medium rounded-lg hover:bg-blue-700 transition-colors shadow-sm"
                                  >
                                    <Send className="w-4 h-4" />
                                    Open in Email Client
                                  </a>
                                </div>

                                {/* Email Content Preview */}
                                <div className="p-8 space-y-8 text-gray-800">
                                  <div>
                                    <h2 className="text-2xl font-bold text-gray-900 mb-2">{selectedAgentAsset.content.subject}</h2>
                                    <hr className="border-gray-200" />
                                  </div>
                                  
                                  <p className="text-base">{selectedAgentAsset.content.greeting}</p>
                                  
                                  {/* Objective */}
                                  {selectedAgentAsset.content.meetingObjective && (
                                    <div className="bg-gray-50 p-4 rounded-lg border-l-4 border-gray-400">
                                      <p className="text-sm font-medium text-gray-900 mb-1">Objective</p>
                                      <p className="text-sm text-gray-700">{selectedAgentAsset.content.meetingObjective}</p>
                                    </div>
                                  )}

                                  {/* Key Decisions */}
                                  {selectedAgentAsset.content.keyDecisions && selectedAgentAsset.content.keyDecisions.length > 0 && (
                                    <div>
                                      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 mb-3 border-b pb-2">Key Decisions</h3>
                                      <ul className="list-disc pl-5 space-y-2">
                                        {selectedAgentAsset.content.keyDecisions.map((decision: string, idx: number) => (
                                          <li key={idx} className="text-sm text-gray-700">{decision}</li>
                                        ))}
                                      </ul>
                                    </div>
                                  )}

                                  {/* Discussion Points */}
                                  {selectedAgentAsset.content.discussionPoints && selectedAgentAsset.content.discussionPoints.length > 0 && (
                                    <div>
                                      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 mb-3 border-b pb-2">Discussion Points</h3>
                                      <div className="space-y-4">
                                        {selectedAgentAsset.content.discussionPoints.map((point: any, idx: number) => (
                                          <div key={idx}>
                                            <h4 className="text-sm font-semibold text-gray-800 mb-2">{point.topic}</h4>
                                            <ul className="list-disc pl-5 space-y-1">
                                              {point.details.map((detail: string, didx: number) => (
                                                <li key={didx} className="text-sm text-gray-600">{detail}</li>
                                              ))}
                                            </ul>
                                          </div>
                                        ))}
                                      </div>
                                    </div>
                                  )}
                                  
                                  {/* Tasks Table */}
                                  {selectedAgentAsset.content.tasks && selectedAgentAsset.content.tasks.length > 0 && (
                                    <div>
                                      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 mb-3 border-b pb-2">Action Items</h3>
                                      <div className="border rounded-lg overflow-hidden">
                                        <table className="w-full text-sm text-left">
                                          <thead className="bg-gray-50 text-gray-700 border-b">
                                            <tr>
                                              <th className="px-4 py-3 font-semibold w-1/2">Task & Notes</th>
                                              <th className="px-4 py-3 font-semibold">Owner</th>
                                              <th className="px-4 py-3 font-semibold">Deadline</th>
                                              <th className="px-4 py-3 font-semibold text-center">Priority</th>
                                            </tr>
                                          </thead>
                                          <tbody className="divide-y divide-gray-200">
                                            {selectedAgentAsset.content.tasks.map((task: any, idx: number) => (
                                              <tr key={idx} className="hover:bg-gray-50">
                                                <td className="px-4 py-3">
                                                  <div className="font-medium text-gray-900">{task.task}</div>
                                                  {task.notes && <div className="text-xs text-gray-500 mt-1">{task.notes}</div>}
                                                </td>
                                                <td className="px-4 py-3">
                                                  <span className="inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium bg-gray-100 text-gray-800">
                                                    {task.owner}
                                                  </span>
                                                </td>
                                                <td className="px-4 py-3 text-gray-600">{task.deadline}</td>
                                                <td className="px-4 py-3 text-center">
                                                  <span className={`inline-flex items-center px-2 py-1 rounded text-xs font-bold border ${
                                                    task.priority?.toLowerCase() === 'high' ? 'bg-red-50 text-red-700 border-red-200' :
                                                    task.priority?.toLowerCase() === 'medium' ? 'bg-orange-50 text-orange-700 border-orange-200' :
                                                    'bg-green-50 text-green-700 border-green-200'
                                                  }`}>
                                                    {task.priority}
                                                  </span>
                                                </td>
                                              </tr>
                                            ))}
                                          </tbody>
                                        </table>
                                      </div>
                                    </div>
                                  )}
                                  
                                  {/* Next Steps */}
                                  {selectedAgentAsset.content.nextMeeting && (
                                    <div>
                                      <h3 className="text-sm font-bold uppercase tracking-wider text-gray-900 mb-3 border-b pb-2">Next Steps & Follow-up</h3>
                                      <p className="text-sm text-gray-700">{selectedAgentAsset.content.nextMeeting}</p>
                                    </div>
                                  )}
                                  
                                  {/* Closing */}
                                  <div className="pt-6">
                                    <p className="text-base text-gray-600">{selectedAgentAsset.content.closing}</p>
                                  </div>
                                </div>
                              </div>
                            ) : (
                              <div className="bg-white p-6 sm:p-8 border border-[#141414]/5 shadow-sm rounded-xl">
                                {/* Wiki Header */}
                                <div className="border-b border-gray-200 pb-6 mb-6">
                                  <h2 className="text-3xl font-bold tracking-tight">{selectedAgentAsset.content.title}</h2>
                                  {selectedAgentAsset.content.subtitle && (
                                    <p className="text-gray-500 italic mt-2">{selectedAgentAsset.content.subtitle}</p>
                                  )}
                                  <p className="text-xs text-gray-400 mt-2 font-mono">
                                    {selectedAgentAsset.content.date} • {selectedAgentAsset.content.style || 'MECE'} Format
                                  </p>
                                </div>
                                
                                {/* Wiki Sections */}
                                <div className="space-y-8">
                                  {(selectedAgentAsset.content.sections || []).map((section: any, idx: number) => (
                                    <div key={idx} className="space-y-3">
                                      <h3 className="text-lg font-bold text-[#141414] flex items-center gap-3">
                                        <span className="w-8 h-8 rounded-full bg-purple-100 text-purple-700 flex items-center justify-center text-sm font-mono">
                                          {idx + 1}
                                        </span>
                                        {section.heading}
                                      </h3>
                                      <p className="text-sm text-gray-600 leading-relaxed pl-11">{section.content}</p>
                                      {section.bullets && section.bullets.length > 0 && (
                                        <ul className="pl-11 space-y-2">
                                          {section.bullets.map((bullet: string, bidx: number) => (
                                            <li key={bidx} className="text-sm text-gray-700 flex items-start gap-2">
                                              <span className="w-1.5 h-1.5 rounded-full bg-purple-400 mt-2 flex-shrink-0" />
                                              {bullet}
                                            </li>
                                          ))}
                                        </ul>
                                      )}
                                    </div>
                                  ))}
                                </div>
                                
                                {/* Conclusion */}
                                {selectedAgentAsset.content.conclusion && (
                                  <div className="mt-8 pt-6 border-t border-gray-200">
                                    <h3 className="text-lg font-bold mb-3">Conclusion</h3>
                                    <p className="text-sm text-gray-600 italic">{selectedAgentAsset.content.conclusion}</p>
                                  </div>
                                )}
                              </div>
                            )}
                          </div>
                        )}
                      </section>
                    </div>

                    {/* Agent Asset History Sidebar */}
                    <div className="space-y-6">
                      <h3 className="text-xs font-mono uppercase tracking-widest opacity-50">Generated Outputs</h3>
                      <div className="space-y-3">
                        {agentAssetHistory.length === 0 && (
                          <div className="p-8 border border-dashed border-[#141414]/20 text-center rounded-xl">
                            <p className="text-[10px] font-mono opacity-40 uppercase">No outputs yet</p>
                          </div>
                        )}
                        {agentAssetHistory.map((asset) => (
                          <div 
                            key={asset.id}
                            onClick={() => setSelectedAgentAsset(asset)}
                            className={`p-4 border border-[#141414] shadow-[2px_2px_0px_0px_rgba(20,20,20,1)] flex items-center justify-between group cursor-pointer transition-all ${selectedAgentAsset?.id === asset.id ? 'bg-[#141414] text-white shadow-none translate-x-[2px] translate-y-[2px]' : 'bg-white hover:bg-[#F5F5F5]'}`}
                          >
                            <div className="flex items-center gap-3 overflow-hidden">
                              {asset.type === 'email' ? <Mail className={`w-4 h-4 ${selectedAgentAsset?.id === asset.id ? 'text-blue-400' : 'text-blue-600'}`} /> : <BookOpen className={`w-4 h-4 ${selectedAgentAsset?.id === asset.id ? 'text-purple-400' : 'text-purple-600'}`} />}
                              <div className="overflow-hidden">
                                <p className="text-xs font-bold truncate">{asset.filename}</p>
                                <p className={`text-[8px] font-mono uppercase ${selectedAgentAsset?.id === asset.id ? 'opacity-60' : 'opacity-40'}`}>{new Date(asset.created_at!).toLocaleDateString()}</p>
                              </div>
                            </div>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadExistingAsset(asset);
                              }}
                              className={`p-2 rounded-lg transition-all ${selectedAgentAsset?.id === asset.id ? 'hover:bg-white/10' : 'hover:bg-[#141414] hover:text-white'}`}
                            >
                              <Download className="w-4 h-4" />
                            </button>
                          </div>
                        ))}
                      </div>
                    </div>
                  </div>
                </div>
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

      {/* Global Progress Overlay */}
      {(status === 'processing' || status === 'splitting') && (
        <div className="fixed bottom-8 right-8 z-[100] bg-[#141414] text-[#E4E3E0] p-6 rounded-2xl shadow-2xl border border-white/10 w-80">
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-3">
              <Loader2 className="w-5 h-5 animate-spin" />
              <span className="text-xs font-mono uppercase tracking-widest">Processing Audio</span>
            </div>
            <span className="text-xs font-mono">{Math.round(totalProgress)}%</span>
          </div>
          <div className="w-full h-1 bg-white/10 rounded-full overflow-hidden">
            <motion.div 
              className="h-full bg-white"
              initial={{ width: 0 }}
              animate={{ width: `${totalProgress}%` }}
            />
          </div>
          <p className="text-[10px] opacity-50 mt-3 font-mono">
            {status === 'splitting' ? 'Decoding audio stream...' : `Processing batch ${batches.filter(b => b.status === 'completed').length + 1} of ${batches.length}`}
          </p>
        </div>
      )}
    </div>
  );
}
