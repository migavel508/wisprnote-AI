import React, { useState, useRef, useEffect } from 'react';
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
  PlayCircle
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
  extractKnowledgeGraph
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
import { Session } from '@supabase/supabase-js';

declare global {
  interface Window {
    aistudio: {
      hasSelectedApiKey: () => Promise<boolean>;
      openSelectKey: () => Promise<void>;
    };
  }
}

type View = 'process' | 'history' | 'notes' | 'assets' | 'agents' | 'knowledge';
type Status = 'idle' | 'splitting' | 'processing' | 'completed' | 'error';
type NoteTab = 'transcription' | 'summary' | 'notes' | 'chat';

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
  const [session, setSession] = useState<Session | null>(null);
  const [currentView, setCurrentView] = useState<View>('process');
  const [file, setFile] = useState<File | null>(null);
  const [prompt, setPrompt] = useState('Analyze this recording...');
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
      const data = await getTasks();
      setHistory(data);
      // We will sync KG data after both history and KG data are loaded, handled by a separate useEffect
    } catch (err) {
      console.error('Failed to fetch history:', err);
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

      // Generate summary and notes automatically
      const summary = await generateSummary(fullTranscription);
      const notes = await generateNotes(fullTranscription);

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

      // Save to Supabase
      const newTask: TaskHistory = {
        filename: file.name,
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
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0] flex flex-col">
      {/* Header */}
      <header className="border-b border-[#141414] p-4 flex flex-col sm:flex-row justify-between items-start sm:items-center gap-4 bg-white sticky top-0 z-50">
        <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-6 w-full sm:w-auto">
          <div className="flex items-center gap-2 cursor-pointer" onClick={() => setCurrentView('process')}>
            <Layers className="w-6 h-6" />
            <h1 className="text-xl font-bold tracking-tight uppercase">Wisprnote AI</h1>
          </div>
          
          <nav className="flex items-center gap-1 overflow-x-auto w-full sm:w-auto pb-2 sm:pb-0 no-scrollbar">
            <button 
              onClick={() => setCurrentView('process')}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors flex-shrink-0 ${currentView === 'process' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5'}`}
            >
              Process
            </button>
            <button 
              onClick={() => setCurrentView('history')}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors flex-shrink-0 ${currentView === 'history' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5'}`}
            >
              History
            </button>
            <button 
              onClick={() => {
                if (selectedTask) setCurrentView('notes');
                else setCurrentView('history');
              }}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors flex-shrink-0 ${currentView === 'notes' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5'}`}
            >
              Notes
            </button>
            <button 
              onClick={() => {
                if (selectedTask) setCurrentView('assets');
                else setCurrentView('history');
              }}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors flex-shrink-0 ${currentView === 'assets' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5'}`}
            >
              Assets
            </button>
            <button 
              onClick={() => setCurrentView('agents')}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors flex-shrink-0 ${currentView === 'agents' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5'}`}
            >
              Agents
            </button>
            <button 
              onClick={() => setCurrentView('knowledge')}
              className={`px-4 py-1.5 text-xs font-mono uppercase tracking-wider transition-colors flex-shrink-0 flex items-center gap-1.5 ${currentView === 'knowledge' ? 'bg-[#141414] text-[#E4E3E0]' : 'hover:bg-[#141414]/5'}`}
            >
              <Share2 className="w-3 h-3" />
              Knowledge
            </button>
          </nav>
        </div>
        
        <div className="flex items-center gap-4 ml-auto sm:ml-0">
          <div className="text-[10px] font-mono opacity-50 uppercase tracking-widest hidden sm:block">
            {status !== 'idle' ? `Status: ${status}` : 'Ready'}
          </div>
          <div className="w-8 h-8 rounded-full bg-[#141414] text-[#E4E3E0] flex items-center justify-center text-[10px] font-bold">
            {session?.user?.email?.substring(0, 2).toUpperCase() || 'AI'}
          </div>
          <button 
            onClick={() => supabase.auth.signOut()}
            className="text-[10px] font-mono uppercase opacity-50 hover:opacity-100 transition-opacity"
          >
            Sign Out
          </button>
        </div>
      </header>

      <div className="flex-1 flex overflow-hidden relative">
        {/* Sidebar for History/Notes */}
        <AnimatePresence initial={false}>
          {isSidebarOpen && (currentView === 'history' || currentView === 'notes') && (
            <motion.aside 
              initial={{ width: 0, opacity: 0 }}
              animate={{ width: window.innerWidth < 640 ? '100%' : 256, opacity: 1 }}
              exit={{ width: 0, opacity: 0 }}
              className={`border-r border-[#141414] bg-[#F5F5F5] flex flex-col overflow-hidden whitespace-nowrap z-40 ${window.innerWidth < 640 ? 'absolute inset-0' : 'relative'}`}
            >
              <div className="p-4 border-b border-[#141414] flex items-center justify-between">
                <span className="text-[10px] font-mono uppercase opacity-50">Recent Tasks</span>
                <Plus className="w-4 h-4 cursor-pointer opacity-50 hover:opacity-100" onClick={() => setCurrentView('process')} />
              </div>
              <div className="flex-1 overflow-y-auto">
                {history.map((task) => (
                  <div 
                    key={task.id}
                    onClick={() => {
                      setSelectedTask(task);
                      setCurrentView('notes');
                    }}
                    className={`p-3 border-b border-[#141414]/5 cursor-pointer hover:bg-white transition-colors group ${selectedTask?.id === task.id ? 'bg-white' : ''}`}
                  >
                    <div className="flex items-center gap-2 mb-1">
                      <FileAudio className="w-3 h-3 opacity-50" />
                      <span className="text-xs font-bold truncate block max-w-[180px]">{task.filename}</span>
                    </div>
                    <div className="text-[10px] opacity-40 font-mono">
                      {new Date(task.created_at!).toLocaleDateString()}
                    </div>
                  </div>
                ))}
              </div>
            </motion.aside>
          )}
        </AnimatePresence>

        {/* Sidebar Toggle Button */}
        {(currentView === 'history' || currentView === 'notes') && (
          <button 
            onClick={() => setIsSidebarOpen(!isSidebarOpen)}
            className="fixed sm:absolute left-0 top-1/2 -translate-y-1/2 z-50 bg-[#141414] text-white p-1 rounded-r-md shadow-lg hover:bg-[#333] transition-all"
            style={{ left: isSidebarOpen ? (window.innerWidth < 640 ? 'calc(100% - 32px)' : '256px') : '0' }}
          >
            {isSidebarOpen ? <ChevronLeft className="w-4 h-4" /> : <ChevronRight className="w-4 h-4" />}
          </button>
        )}

        <main className="flex-1 overflow-y-auto bg-[#E4E3E0] w-full">
          <AnimatePresence mode="wait">
            {currentView === 'process' && (
              <motion.div 
                key="process"
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                exit={{ opacity: 0, y: -10 }}
                className="max-w-4xl mx-auto p-4 sm:p-8"
              >
                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Left: Input Selection */}
                  <div className="space-y-6">
                    <section className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                      <div className="flex items-center justify-between mb-4">
                        <h2 className="font-serif italic text-sm uppercase opacity-50 tracking-wider">01. Input Source</h2>
                        
                        {/* Toggle Upload/Record */}
                        <div className="flex bg-[#F5F5F5] border border-[#141414]/10 rounded-md p-1">
                          <button
                            onClick={() => setInputMode('upload')}
                            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase tracking-widest rounded-sm transition-all ${inputMode === 'upload' ? 'bg-white shadow-sm font-bold text-[#141414]' : 'opacity-50 hover:opacity-100'}`}
                          >
                            <Upload className="w-3 h-3" /> File
                          </button>
                          <button
                            onClick={() => setInputMode('record')}
                            className={`flex items-center gap-2 px-3 py-1.5 text-xs font-mono uppercase tracking-widest rounded-sm transition-all ${inputMode === 'record' ? 'bg-white shadow-sm font-bold text-[#141414]' : 'opacity-50 hover:opacity-100'}`}
                          >
                            <Mic className="w-3 h-3" /> Record
                          </button>
                        </div>
                      </div>

                      {/* Content Area for Input */}
                      <div className="min-h-[220px] flex flex-col justify-center">
                        {inputMode === 'upload' ? (
                          <div 
                            onClick={() => fileInputRef.current?.click()}
                            className={`flex-1 border-2 border-dashed border-[#141414]/20 flex flex-col items-center justify-center p-8 text-center cursor-pointer hover:bg-[#F5F5F5] transition-colors mb-4 ${file && !isRecording ? 'bg-[#F5F5F5]' : ''}`}
                          >
                            <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="audio/*" />
                            {file && !isRecording ? (
                              <div className="flex flex-col items-center gap-2">
                                <FileAudio className="w-12 h-12 mb-2" />
                                <span className="font-mono text-sm font-bold">{file.name}</span>
                                <span className="text-xs opacity-50">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                              </div>
                            ) : (
                              <div className="flex flex-col items-center gap-2">
                                <Upload className="w-12 h-12 mb-2 opacity-30" />
                                <span className="text-sm font-medium">Drop audio file here or click to browse</span>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className={`flex-1 border-2 border-[#141414]/10 flex flex-col items-center justify-center p-8 text-center mb-4 transition-all ${isRecording ? 'bg-red-50/50 border-red-200' : 'bg-[#FAFAFA]'}`}>
                            {isRecording ? (
                              <div className="flex flex-col items-center gap-6 w-full">
                                <div className="text-3xl font-mono text-red-500 font-bold tracking-widest">
                                  {formatTime(recordingTime)}
                                </div>
                                
                                {/* Wave Animation */}
                                <div className="flex items-end justify-center gap-1 h-8 w-full max-w-[200px]">
                                  {[...Array(20)].map((_, i) => (
                                    <motion.div
                                      key={i}
                                      animate={{ height: isPaused ? '20%' : ['20%', '100%', '20%'] }}
                                      transition={isPaused ? { duration: 0.3 } : {
                                        duration: 0.8,
                                        repeat: Infinity,
                                        delay: i * 0.05,
                                        ease: "easeInOut"
                                      }}
                                      className={`w-1.5 rounded-t-sm opacity-80 ${isPaused ? 'bg-gray-400' : 'bg-red-500'}`}
                                    />
                                  ))}
                                </div>

                                <div className="flex items-center gap-4 mt-2">
                                  {isPaused ? (
                                    <button 
                                      onClick={resumeRecording}
                                      className="w-14 h-14 bg-[#141414] text-white rounded-full flex items-center justify-center hover:bg-[#333] hover:scale-105 transition-all shadow-md"
                                      title="Resume"
                                    >
                                      <PlayCircle className="w-7 h-7" />
                                    </button>
                                  ) : (
                                    <button 
                                      onClick={pauseRecording}
                                      className="w-14 h-14 bg-gray-200 text-gray-700 rounded-full flex items-center justify-center hover:bg-gray-300 hover:scale-105 transition-all shadow-md"
                                      title="Pause"
                                    >
                                      <PauseCircle className="w-7 h-7" />
                                    </button>
                                  )}
                                  
                                  <button 
                                    onClick={stopRecording}
                                    className="w-16 h-16 bg-red-500 text-white rounded-full flex items-center justify-center hover:bg-red-600 hover:scale-105 transition-all shadow-lg"
                                    title="Stop"
                                  >
                                    <StopCircle className="w-8 h-8" />
                                  </button>
                                </div>
                                
                                <span className={`text-xs font-mono uppercase tracking-widest font-bold ${isPaused ? 'text-gray-500' : 'text-red-500/70 animate-pulse'}`}>
                                  {isPaused ? 'Recording Paused' : 'Recording Live...'}
                                </span>
                              </div>
                            ) : file ? (
                              <div className="flex flex-col items-center gap-4 w-full">
                                <div className="p-4 bg-green-100 text-green-600 rounded-full mb-2">
                                  <CheckCircle2 className="w-8 h-8" />
                                </div>
                                <span className="font-mono text-sm font-bold text-green-700">Recording Saved</span>
                                <span className="text-xs opacity-50">{formatTime(recordingTime)}</span>
                                <button 
                                  onClick={() => { setFile(null); startRecording(); }}
                                  className="mt-2 text-xs font-mono uppercase border-b border-[#141414] pb-0.5 hover:opacity-70"
                                >
                                  Record Again
                                </button>
                              </div>
                            ) : (
                              <div className="flex flex-col items-center gap-6">
                                <div className="w-20 h-20 rounded-full bg-[#141414]/5 flex items-center justify-center">
                                  <Mic className="w-10 h-10 opacity-40" />
                                </div>
                                <button 
                                  onClick={startRecording}
                                  className="px-8 py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs rounded-full hover:bg-[#333] hover:scale-105 transition-all shadow-md flex items-center gap-2"
                                >
                                  <span className="w-2 h-2 rounded-full bg-red-500"></span>
                                  Start Recording
                                </button>
                              </div>
                            )}
                          </div>
                        )}
                      </div>

                      <div className="mt-auto">
                        <textarea 
                          value={prompt}
                          onChange={(e) => setPrompt(e.target.value)}
                          className="w-full border border-[#141414] p-3 text-sm font-mono focus:outline-none h-20 resize-none mb-4"
                          placeholder="Instructions (optional)..."
                        />
                        <button 
                          onClick={startProcessing}
                          disabled={!file || isRecording || status === 'processing' || status === 'splitting'}
                          className="w-full bg-[#141414] text-[#E4E3E0] py-4 font-bold uppercase tracking-widest hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                        >
                          {status === 'processing' || status === 'splitting' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                          Start Processing
                        </button>
                      </div>
                    </section>
                  </div>

                  {/* Right: Progress */}
                  <div className="space-y-6">
                    {batches.length > 0 && (
                      <section className="border border-[#141414] bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] overflow-hidden">
                        <div className="p-4 border-b border-[#141414] bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
                          <h2 className="font-serif italic text-sm uppercase tracking-wider">02. Queue</h2>
                          <span className="font-mono text-[10px]">{Math.round(totalProgress)}%</span>
                        </div>
                        <div className="max-h-[500px] overflow-y-auto">
                          {batches.map((batch, idx) => (
                            <div key={idx} className="p-4 border-b border-[#141414]/10 flex items-center justify-between">
                              <div className="flex items-center gap-3">
                                <div className={`w-6 h-6 rounded-full border border-[#141414] flex items-center justify-center text-[10px] font-mono ${batch.status === 'completed' ? 'bg-[#141414] text-[#E4E3E0]' : ''}`}>
                                  {idx + 1}
                                </div>
                                <span className="text-xs font-mono">Batch {idx + 1}</span>
                              </div>
                              {batch.status === 'processing' && <Loader2 className="w-3 h-3 animate-spin opacity-50" />}
                              {batch.status === 'completed' && <CheckCircle2 className="w-3 h-3 text-green-600" />}
                            </div>
                          ))}
                        </div>
                      </section>
                    )}
                  </div>
                </div>
              </motion.div>
            )}

            {currentView === 'history' && (
              <motion.div 
                key="history"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="p-4 sm:p-8 max-w-5xl mx-auto"
              >
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-8">
                  <h2 className="text-3xl font-serif italic font-bold">Transcription History</h2>
                  <div className="flex items-center gap-2 border border-[#141414] bg-white px-3 py-1.5 w-full sm:w-auto">
                    <Search className="w-4 h-4 opacity-50" />
                    <input type="text" placeholder="Search tasks..." className="bg-transparent border-none outline-none text-xs font-mono w-full sm:w-48" />
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
                  {history.map((task) => (
                    <motion.div 
                      key={task.id}
                      whileHover={{ y: -4 }}
                      onClick={() => {
                        setSelectedTask(task);
                        setCurrentView('notes');
                      }}
                      className="border border-[#141414] bg-white p-6 shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] cursor-pointer group"
                    >
                      <div className="flex justify-between items-start mb-4">
                        <div className="p-2 bg-[#141414]/5 rounded">
                          <FileAudio className="w-6 h-6" />
                        </div>
                        <span className="text-[10px] font-mono opacity-40 uppercase">{new Date(task.created_at!).toLocaleDateString()}</span>
                      </div>
                      <h3 className="font-bold text-sm mb-2 group-hover:underline truncate">{task.filename}</h3>
                      <p className="text-[10px] opacity-50 line-clamp-3 font-mono mb-4">
                        {task.summary || task.transcription.substring(0, 100) + '...'}
                      </p>
                      <div className="flex items-center gap-2 text-[10px] font-mono uppercase tracking-widest opacity-0 group-hover:opacity-100 transition-opacity">
                        View Details <ChevronRight className="w-3 h-3" />
                      </div>
                    </motion.div>
                  ))}
                </div>
              </motion.div>
            )}

            {currentView === 'notes' && selectedTask && (
              <motion.div 
                key="notes"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="min-h-full bg-white flex flex-col"
              >
                {/* Notion Style Header */}
                <div className="max-w-4xl mx-auto w-full px-4 sm:px-8 pt-8 sm:pt-16 pb-8">
                  <div className="flex items-center gap-4 mb-6 opacity-50 text-sm overflow-x-auto no-scrollbar whitespace-nowrap">
                    <BookOpen className="w-4 h-4 flex-shrink-0" />
                    <span>Library</span>
                    <span>/</span>
                    <span className="truncate">{selectedTask.filename}</span>
                  </div>
                  
                  <h1 className="text-3xl sm:text-5xl font-bold mb-8 tracking-tight break-words">{selectedTask.filename}</h1>
                  
                  <div className="flex flex-col sm:flex-row items-start sm:items-center gap-4 sm:gap-8 border-b border-[#141414]/10 mb-8 pb-4 sm:pb-0">
                    <div className="flex items-center gap-6 w-full sm:w-auto">
                      <div className="flex flex-col gap-1 pb-4 sm:pb-4">
                        <span className="text-[10px] font-mono uppercase opacity-40">Created</span>
                        <span className="text-xs font-medium">{new Date(selectedTask.created_at!).toLocaleString()}</span>
                      </div>
                      <div className="flex flex-col gap-1 pb-4 sm:pb-4">
                        <span className="text-[10px] font-mono uppercase opacity-40">Prompt</span>
                        <span className="text-xs font-medium truncate max-w-[120px] sm:max-w-[200px]">{selectedTask.prompt || 'Default Transcription'}</span>
                      </div>
                    </div>
                    <button 
                      onClick={() => setCurrentView('assets')}
                      className="w-full sm:w-auto sm:ml-auto flex items-center justify-center gap-2 px-4 py-2 border border-[#141414] text-xs font-mono uppercase tracking-widest hover:bg-[#141414] hover:text-white transition-all"
                    >
                      <FileBox className="w-4 h-4" />
                      Generate Assets
                    </button>
                  </div>

                  {/* UI Switcher (Image Inspired) */}
                  <div className="flex justify-center mb-12 overflow-x-auto no-scrollbar">
                    <div className="bg-[#141414]/5 p-1 rounded-xl flex items-center gap-1 min-w-max">
                      <button 
                        onClick={() => setNoteTab('transcription')}
                        className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${noteTab === 'transcription' ? 'bg-[#141414] text-white shadow-lg' : 'text-[#141414]/60 hover:text-[#141414]'}`}
                      >
                        Transcription
                      </button>
                      <button 
                        onClick={() => setNoteTab('summary')}
                        className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${noteTab === 'summary' ? 'bg-[#141414] text-white shadow-lg' : 'text-[#141414]/60 hover:text-[#141414]'}`}
                      >
                        Summary
                      </button>
                      <button 
                        onClick={() => setNoteTab('notes')}
                        className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${noteTab === 'notes' ? 'bg-[#141414] text-white shadow-lg' : 'text-[#141414]/60 hover:text-[#141414]'}`}
                      >
                        Notes
                      </button>
                      <button 
                        onClick={() => setNoteTab('chat')}
                        className={`px-4 sm:px-6 py-2 rounded-lg text-sm font-medium transition-all ${noteTab === 'chat' ? 'bg-[#141414] text-white shadow-lg' : 'text-[#141414]/60 hover:text-[#141414]'}`}
                      >
                        Chat
                      </button>
                    </div>
                  </div>

                  {/* Content Area */}
                  <div className="prose prose-lg max-w-none pb-32">
                    <AnimatePresence mode="wait">
                      <motion.div
                        key={noteTab}
                        initial={{ opacity: 0, x: 10 }}
                        animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -10 }}
                        transition={{ duration: 0.2 }}
                        className="markdown-body"
                      >
                        {noteTab === 'transcription' && (
                          <div className="space-y-4">
                            <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.transcription}</Markdown>
                          </div>
                        )}
                        {noteTab === 'summary' && (
                          <div className="bg-[#F5F5F5] p-4 sm:p-8 rounded-2xl border border-[#141414]/5">
                            <h3 className="text-xl font-serif italic mb-4">Key Summary</h3>
                            <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.summary || 'No summary generated.'}</Markdown>
                          </div>
                        )}
                        {noteTab === 'notes' && (
                          <div className="space-y-6">
                            <Markdown remarkPlugins={[remarkGfm]}>{selectedTask.notes || 'No structured notes generated.'}</Markdown>
                          </div>
                        )}
                        {noteTab === 'chat' && (
                          <div className="flex flex-col h-[600px] border border-[#141414] bg-[#F9F9F9] rounded-2xl overflow-hidden shadow-inner">
                            {/* Chat Header with history count */}
                            <div className="px-6 py-3 bg-white border-b border-[#141414]/10 flex items-center justify-between">
                              <div className="flex items-center gap-2">
                                <MessageSquare className="w-4 h-4 opacity-60" />
                                <span className="text-xs font-mono uppercase tracking-wider opacity-60">Chat with Notes</span>
                              </div>
                              {chatMessages.length > 0 && (
                                <span className="text-[10px] font-mono bg-[#141414] text-white px-2 py-0.5 rounded-full">
                                  {chatMessages.length} message{chatMessages.length !== 1 ? 's' : ''}
                                </span>
                              )}
                            </div>
                            <div className="flex-1 overflow-y-auto p-6 space-y-6">
                              {chatMessages.length === 0 && (
                                <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40">
                                  <MessageSquare className="w-12 h-12 mb-4" />
                                  <p className="text-sm font-mono uppercase tracking-widest">Start chatting with your notes</p>
                                  <p className="text-xs mt-2">Ask questions or request visualizations</p>
                                  <p className="text-[10px] mt-4 opacity-60">Your conversation will be saved automatically</p>
                                </div>
                              )}
                              {chatMessages.map((msg, i) => (
                                <motion.div 
                                  key={i}
                                  initial={{ opacity: 0, y: 5 }}
                                  animate={{ opacity: 1, y: 0 }}
                                  className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}
                                >
                                  <div className={`max-w-[80%] p-4 rounded-2xl ${msg.role === 'user' ? 'bg-[#141414] text-white' : 'bg-white border border-[#141414]/10 shadow-sm'}`}>
                                    <div className="text-sm leading-relaxed">
                                      <Markdown remarkPlugins={[remarkGfm]}>{msg.text}</Markdown>
                                    </div>
                                    {msg.image && (
                                      <div className="mt-4 rounded-lg overflow-hidden border border-[#141414]/10">
                                        <img src={msg.image} alt="Concept Visualization" className="w-full h-auto" />
                                      </div>
                                    )}
                                    {msg.role === 'model' && !msg.image && !isGeneratingImage && (
                                      <button 
                                        onClick={() => handleVisualize(msg.text.substring(0, 100))}
                                        className="mt-3 flex items-center gap-2 text-[10px] font-mono uppercase tracking-wider opacity-50 hover:opacity-100 transition-opacity"
                                      >
                                        <Sparkles className="w-3 h-3" /> Visualize Concept
                                      </button>
                                    )}
                                  </div>
                                </motion.div>
                              ))}
                              {isChatting && (
                                <div className="flex justify-start">
                                  <div className="bg-white border border-[#141414]/10 p-4 rounded-2xl shadow-sm">
                                    <Loader2 className="w-4 h-4 animate-spin opacity-40" />
                                  </div>
                                </div>
                              )}
                              <div ref={chatEndRef} />
                            </div>
                            
                            <div className="p-4 bg-white border-t border-[#141414]">
                              <div className="flex items-center gap-2">
                                <input 
                                  type="text" 
                                  value={chatInput}
                                  onChange={(e) => setChatInput(e.target.value)}
                                  onKeyDown={(e) => e.key === 'Enter' && handleSendMessage()}
                                  placeholder="Ask about your notes..."
                                  className="flex-1 bg-transparent border-none outline-none text-sm font-sans px-2"
                                />
                                <button 
                                  onClick={handleSendMessage}
                                  disabled={!chatInput.trim() || isChatting}
                                  className="p-2 bg-[#141414] text-white rounded-lg hover:bg-[#333] disabled:opacity-30 transition-colors"
                                >
                                  <Send className="w-4 h-4" />
                                </button>
                              </div>
                            </div>
                          </div>
                        )}
                      </motion.div>
                    </AnimatePresence>
                  </div>
                </div>
              </motion.div>
            )}

            {currentView === 'assets' && selectedTask && (
              <motion.div 
                key="assets"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="min-h-full bg-white p-4 sm:p-8"
              >
                <div className="max-w-5xl mx-auto">
                  <div className="flex items-center gap-4 mb-8 opacity-50 text-sm overflow-x-auto no-scrollbar whitespace-nowrap">
                    <FileBox className="w-4 h-4 flex-shrink-0" />
                    <span>Library</span>
                    <span>/</span>
                    <span className="truncate">{selectedTask.filename}</span>
                    <span>/</span>
                    <span>Assets</span>
                  </div>

                  <h1 className="text-3xl sm:text-4xl font-bold mb-12 tracking-tight">Content Assets</h1>

                  <div className="grid grid-cols-1 lg:grid-cols-3 gap-12">
                    <div className="lg:col-span-2 space-y-8">
                      {/* Generation Options */}
                      <section className="grid grid-cols-1 md:grid-cols-2 gap-6">
                        <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                          <div className="flex items-center gap-3 mb-6">
                            <div className="p-3 bg-orange-100 text-orange-600 rounded-xl">
                              <Presentation className="w-6 h-6" />
                            </div>
                            <div>
                              <h3 className="font-bold">Presentation</h3>
                              <p className="text-[10px] opacity-50 uppercase font-mono">PPTX Format</p>
                            </div>
                          </div>
                          
                          <div className="flex-1 space-y-4 mb-8">
                            <div className="flex flex-col gap-2">
                              <label className="text-[10px] font-mono uppercase opacity-50">Slide Count</label>
                              <input 
                                type="number" 
                                min="3" 
                                max="20" 
                                value={isNaN(slideCount) ? '' : slideCount}
                                onChange={(e) => {
                                  const val = parseInt(e.target.value);
                                  setSlideCount(isNaN(val) ? 0 : val);
                                }}
                                className="border border-[#141414] p-2 text-sm font-mono"
                              />
                            </div>
                            <p className="text-xs opacity-60">Generate a professional slide deck based on the transcription content.</p>
                          </div>

                          <button 
                            onClick={handleGeneratePPT}
                            disabled={isGeneratingAsset}
                            className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                          >
                            {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                            Generate PPT
                          </button>
                        </div>

                        <div className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
                          <div className="flex items-center gap-3 mb-6">
                            <div className="p-3 bg-blue-100 text-blue-600 rounded-xl">
                              <FileText className="w-6 h-6" />
                            </div>
                            <div>
                              <h3 className="font-bold">Formal Report</h3>
                              <p className="text-[10px] opacity-50 uppercase font-mono">DOCX Format</p>
                            </div>
                          </div>
                          
                          <div className="flex-1 mb-8">
                            <p className="text-xs opacity-60">Create a structured, professional document with executive summary and detailed sections.</p>
                          </div>

                          <button 
                            onClick={handleGenerateReport}
                            disabled={isGeneratingAsset}
                            className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                          >
                            {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Download className="w-4 h-4" />}
                            Generate DOCX
                          </button>
                        </div>
                      </section>

                      {/* Preview Area */}
                      <section className="border border-[#141414] bg-[#F5F5F5] p-4 sm:p-8 rounded-2xl min-h-[400px] flex flex-col">
                        {!selectedAsset ? (
                          <div className="flex-1 flex flex-col items-center justify-center text-center">
                            <Sparkles className="w-12 h-12 mb-4 opacity-10" />
                            <h3 className="text-lg font-serif italic opacity-30">Asset Preview</h3>
                            <p className="text-xs opacity-30 mt-2">Generate or select an asset to see its structure here</p>
                          </div>
                        ) : (
                          <div className="flex-1 overflow-y-auto">
                            <div className="flex items-center justify-between mb-6 border-b border-[#141414]/10 pb-4">
                              <div className="flex items-center gap-3">
                                {selectedAsset.type === 'ppt' ? <Presentation className="w-5 h-5 text-orange-600" /> : <FileText className="w-5 h-5 text-blue-600" />}
                                <h3 className="font-bold text-sm">{selectedAsset.filename}</h3>
                              </div>
                              <button 
                                onClick={() => downloadExistingAsset(selectedAsset)}
                                className="flex items-center gap-2 px-3 py-1.5 bg-[#141414] text-white text-[10px] font-mono uppercase tracking-widest hover:bg-[#333] transition-all"
                              >
                                <Download className="w-3 h-3" />
                                Download
                              </button>
                            </div>

                            <div className="bg-white p-6 sm:p-8 border border-[#141414]/5 shadow-sm rounded-xl">
                              {selectedAsset.type === 'ppt' ? (
                                <div className="space-y-8">
                                  <div className="text-center py-12 border-b border-[#141414]/5">
                                    <h2 className="text-3xl font-bold tracking-tight mb-2">{selectedAsset.content.title}</h2>
                                    <p className="text-xs font-mono opacity-40 uppercase tracking-widest">Title Slide</p>
                                  </div>
                                  {selectedAsset.content.slides.map((slide: any, idx: number) => (
                                    <div key={idx} className="space-y-4">
                                      <div className="flex items-center gap-4">
                                        <span className="text-[10px] font-mono opacity-30 uppercase">Slide {idx + 1}</span>
                                        <h4 className="font-bold text-lg">{slide.title}</h4>
                                      </div>
                                      <ul className="space-y-2 pl-4 border-l-2 border-[#141414]/5">
                                        {slide.content.map((bullet: string, bidx: number) => (
                                          <li key={bidx} className="text-sm opacity-70 flex items-start gap-2">
                                            <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-[#141414]/20 flex-shrink-0" />
                                            {bullet}
                                          </li>
                                        ))}
                                      </ul>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="space-y-8">
                                  <div className="border-b border-[#141414]/5 pb-6">
                                    <h2 className="text-3xl font-bold tracking-tight">{selectedAsset.content.title}</h2>
                                  </div>
                                  {selectedAsset.content.sections.map((section: any, idx: number) => (
                                    <div key={idx} className="space-y-3">
                                      <h4 className="font-bold text-lg uppercase tracking-tight">{section.heading}</h4>
                                      <p className="text-sm leading-relaxed opacity-70">{section.body}</p>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </div>
                          </div>
                        )}
                      </section>
                    </div>

                    {/* Asset History Sidebar */}
                    <div className="space-y-6">
                      <h3 className="text-xs font-mono uppercase tracking-widest opacity-50">Generated Assets</h3>
                      <div className="space-y-3">
                        {assetHistory.length === 0 && (
                          <div className="p-8 border border-dashed border-[#141414]/20 text-center rounded-xl">
                            <p className="text-[10px] font-mono opacity-40 uppercase">No assets yet</p>
                          </div>
                        )}
                        {assetHistory.map((asset) => (
                          <div 
                            key={asset.id}
                            onClick={() => setSelectedAsset(asset)}
                            className={`p-4 border border-[#141414] shadow-[2px_2px_0px_0px_rgba(20,20,20,1)] flex items-center justify-between group cursor-pointer transition-all ${selectedAsset?.id === asset.id ? 'bg-[#141414] text-white shadow-none translate-x-[2px] translate-y-[2px]' : 'bg-white hover:bg-[#F5F5F5]'}`}
                          >
                            <div className="flex items-center gap-3 overflow-hidden">
                              {asset.type === 'ppt' ? <Presentation className={`w-4 h-4 ${selectedAsset?.id === asset.id ? 'text-orange-400' : 'text-orange-600'}`} /> : <FileIcon className={`w-4 h-4 ${selectedAsset?.id === asset.id ? 'text-blue-400' : 'text-blue-600'}`} />}
                              <div className="overflow-hidden">
                                <p className="text-xs font-bold truncate">{asset.filename}</p>
                                <p className={`text-[8px] font-mono uppercase ${selectedAsset?.id === asset.id ? 'opacity-60' : 'opacity-40'}`}>{new Date(asset.created_at!).toLocaleDateString()}</p>
                              </div>
                            </div>
                            <button 
                              onClick={(e) => {
                                e.stopPropagation();
                                downloadExistingAsset(asset);
                              }}
                              className={`p-2 rounded-lg transition-all ${selectedAsset?.id === asset.id ? 'hover:bg-white/10' : 'hover:bg-[#141414] hover:text-white'}`}
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
              <motion.div 
                key="knowledge"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="h-full flex flex-col"
              >
                <div className="p-4 sm:p-6 border-b border-[#141414]/10 bg-white flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
                  <div>
                    <h2 className="text-xl font-bold tracking-tight flex items-center gap-2">
                      <Share2 className="w-5 h-5" />
                      Knowledge Graph
                    </h2>
                    <p className="text-xs opacity-50 mt-1">Cross-meeting memory — see how topics, decisions, and people connect across all your meetings</p>
                  </div>
                  <button 
                    onClick={buildKnowledgeGraph}
                    disabled={isLoadingKG || history.length === 0}
                    className="px-6 py-2.5 bg-[#141414] text-white text-xs font-mono uppercase tracking-widest hover:bg-[#333] disabled:opacity-30 flex items-center gap-2 rounded-lg transition-colors"
                  >
                    {isLoadingKG ? <Loader2 className="w-4 h-4 animate-spin" /> : <Network className="w-4 h-4" />}
                    {kgBuilt ? 'Rebuild Graph' : 'Build Graph'}
                  </button>
                </div>

                <div className="flex-1 flex relative overflow-hidden w-full">
                  {/* Background extraction indicator */}
                  {isExtractingNewKG && kgBuilt && (
                    <motion.div 
                      initial={{ opacity: 0, y: -20 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -20 }}
                      className="absolute top-4 left-1/2 transform -translate-x-1/2 z-50 bg-[#141414] text-white px-4 py-2 rounded-full shadow-lg flex items-center gap-3 text-xs font-mono"
                    >
                      <Loader2 className="w-3 h-3 animate-spin" />
                      <span>Extracting latest meeting data...</span>
                    </motion.div>
                  )}
                  
                  {!kgBuilt && !isExtractingNewKG ? (
                    <div className="flex-1 flex flex-col items-center justify-center text-center p-8">
                      {isLoadingKG ? (
                        <div className="w-full max-w-md flex flex-col items-center">
                          <Loader2 className="w-16 h-16 animate-spin opacity-20 mb-6" />
                          <h3 className="text-lg font-bold opacity-80 mb-2">
                            Analyzing Meeting {kgProgress.current} of {kgProgress.total}
                          </h3>
                          <div className="w-full bg-gray-200 rounded-full h-2.5 mb-4">
                            <motion.div 
                              className="bg-[#141414] h-2.5 rounded-full" 
                              initial={{ width: 0 }}
                              animate={{ width: `${(kgProgress.current / kgProgress.total) * 100}%` }}
                              transition={{ duration: 0.5 }}
                            />
                          </div>
                          <p className="text-xs opacity-50 mt-2">
                            Extracting topics, decisions, people, and action items to build a connected knowledge graph.
                            <br />
                            <span className="italic mt-1 block">(Processing sequentially to respect API limits)</span>
                          </p>
                        </div>
                      ) : (
                        <>
                          <Share2 className="w-16 h-16 opacity-10 mb-6" />
                          <h3 className="text-lg font-serif italic opacity-30">No Graph Built Yet</h3>
                          <p className="text-xs opacity-30 mt-2 max-w-md">
                            {history.length === 0 
                              ? 'Process some audio files first, then come back to build your knowledge graph.'
                              : `You have ${history.length} meeting${history.length !== 1 ? 's' : ''} ready. Click "Build Graph" to analyze and connect them.`
                            }
                          </p>
                        </>
                      )}
                    </div>
                  ) : (
                    <>
                      {/* Graph Canvas */}
                      <div ref={kgContainerRef} className="flex-1 bg-[#FAFAFA] relative h-full min-w-0">
                        {/* Graph Controls */}
                        <div className="absolute bottom-6 right-6 z-10 flex gap-2">
                          <button 
                            onClick={() => {
                              if (graphRef.current) {
                                graphRef.current.zoomToFit(400, 50);
                              }
                            }}
                            className="bg-white/90 backdrop-blur-sm border border-[#141414]/10 p-2 rounded-lg shadow-sm hover:bg-white text-gray-700 transition-colors flex items-center gap-2 group"
                            title="Reset View"
                          >
                            <Layout className="w-4 h-4" />
                            <span className="text-[10px] font-mono uppercase font-semibold hidden group-hover:block transition-all">Fit View</span>
                          </button>
                        </div>
                        <ForceGraph2D
                          ref={graphRef}
                          graphData={buildGraphData()}
                          width={kgDimensions.width}
                          height={kgDimensions.height}
                          nodeLabel={(node: any) => `${node.type.toUpperCase()}: ${node.label}`}
                          nodeColor={(node: any) => node.color}
                          nodeVal={(node: any) => node.size}
                          linkColor={() => '#ccc'}
                          linkWidth={(link: any) => link.dashed ? 2 : 1}
                          linkLineDash={(link: any) => link.dashed ? [5, 5] : undefined}
                          minZoom={0.5}
                          maxZoom={8}
                          onNodeClick={(node: any) => {
                            setSelectedNode(node);
                            if (graphRef.current) {
                              // Center and zoom on clicked node
                              graphRef.current.centerAt(node.x, node.y, 1000);
                              graphRef.current.zoom(2, 1000);
                            }
                          }}
                          // Optional: Add drag limits so users can't throw nodes out of bounds
                          onNodeDragEnd={(node: any) => {
                            // Keep nodes within reasonable bounds
                            const bounds = 2000;
                            node.fx = Math.max(-bounds, Math.min(bounds, node.x));
                            node.fy = Math.max(-bounds, Math.min(bounds, node.y));
                          }}
                          nodeCanvasObject={(node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
                            const label = node.label || '';
                            const fontSize = node.type === 'meeting' ? 14 / globalScale : 11 / globalScale;
                            ctx.font = `${node.type === 'meeting' ? 'bold ' : ''}${fontSize}px Sans-Serif`;
                            
                            // Draw node circle
                            const r = node.type === 'meeting' ? 8 : node.type === 'topic' ? 6 : 4;
                            ctx.beginPath();
                            ctx.arc(node.x, node.y, r, 0, 2 * Math.PI, false);
                            ctx.fillStyle = node.color || '#888';
                            ctx.fill();
                            
                            // Draw border for meeting nodes
                            if (node.type === 'meeting') {
                              ctx.strokeStyle = '#000';
                              ctx.lineWidth = 2 / globalScale;
                              ctx.stroke();
                            }
                            
                            // Draw label
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'top';
                            ctx.fillStyle = '#333';
                            const maxLen = node.type === 'meeting' ? 20 : 15;
                            const displayLabel = label.length > maxLen ? label.substring(0, maxLen) + '...' : label;
                            ctx.fillText(displayLabel, node.x, node.y + r + 2);
                          }}
                          cooldownTicks={100}
                          d3AlphaDecay={0.02}
                          d3VelocityDecay={0.3}
                        />
                      </div>

                      {/* Legend */}
                      <div className="absolute top-4 left-4 z-10 bg-white/90 backdrop-blur-sm border border-[#141414]/10 rounded-xl p-4 shadow-sm">
                        <h4 className="text-[10px] font-mono uppercase tracking-widest opacity-50 mb-3">Legend</h4>
                        <div className="space-y-2">
                          {[
                            { color: '#141414', label: 'Meeting', shape: 'large' },
                            { color: '#8b5cf6', label: 'New Topic', shape: 'medium' },
                            { color: '#3b82f6', label: 'Ongoing', shape: 'medium' },
                            { color: '#22c55e', label: 'Resolved', shape: 'medium' },
                            { color: '#f59e0b', label: 'Decision / Revisited', shape: 'small' },
                            { color: '#ef4444', label: 'Off-track', shape: 'medium' },
                            { color: '#06b6d4', label: 'Person', shape: 'small' },
                            { color: '#ec4899', label: 'Action Item', shape: 'small' }
                          ].map(item => (
                            <div key={item.label} className="flex items-center gap-2">
                              <span className={`rounded-full ${item.shape === 'large' ? 'w-3.5 h-3.5' : item.shape === 'medium' ? 'w-2.5 h-2.5' : 'w-2 h-2'}`} style={{ backgroundColor: item.color }} />
                              <span className="text-[10px] text-gray-600">{item.label}</span>
                            </div>
                          ))}
                        </div>
                      </div>

                      {/* Node Detail Panel */}
                      <AnimatePresence>
                        {selectedNode && (
                          <motion.div 
                            initial={{ x: 350, opacity: 0 }}
                            animate={{ x: 0, opacity: 1 }}
                            exit={{ x: 350, opacity: 0 }}
                            transition={{ type: "spring", damping: 25, stiffness: 200 }}
                            className="w-[350px] flex-shrink-0 bg-white/95 backdrop-blur-md border-l border-[#141414]/10 overflow-y-auto h-full p-6 shadow-[-15px_0_30px_-5px_rgba(0,0,0,0.1)] z-20 flex flex-col"
                          >
                          <div className="flex items-center justify-between mb-6 pb-4 border-b border-[#141414]/10">
                            <div className="flex items-center gap-3">
                              <span className={`w-3 h-3 rounded-full`} style={{ backgroundColor: selectedNode.color }} />
                              <span className="text-[10px] font-mono uppercase font-bold text-gray-500 tracking-wider">
                                {selectedNode.type} Node
                              </span>
                            </div>
                            <button 
                              onClick={() => setSelectedNode(null)} 
                              className="p-1.5 hover:bg-gray-100 rounded-lg text-gray-400 hover:text-gray-800 transition-colors"
                            >
                              <X className="w-4 h-4" />
                            </button>
                          </div>
                          
                          <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
                            <h3 className="font-bold text-lg mb-6 leading-tight text-gray-900">{selectedNode.label}</h3>
                            
                            {selectedNode.type === 'meeting' && selectedNode.data && (
                              <div className="space-y-6">
                                {/* This Meeting's Topics */}
                                <div>
                                  <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                                    <MessageSquare className="w-3 h-3" />
                                    Topics Discussed
                                  </h4>
                                  <div className="space-y-2">
                                    {(selectedNode.data.topics || []).map((t: any, i: number) => (
                                      <div key={i} className="p-3 bg-gray-50/80 rounded-xl border border-gray-100 hover:border-gray-200 transition-colors">
                                        <div className="flex items-start justify-between gap-3 mb-2">
                                          <span className="text-sm font-semibold text-gray-800 leading-tight">{t.name}</span>
                                          <span className={`text-[9px] px-2 py-1 rounded-md font-mono shrink-0 ${
                                            t.status === 'resolved' ? 'bg-green-100 text-green-700' :
                                            t.status === 'off-track' ? 'bg-red-100 text-red-700' :
                                            t.status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                                            t.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                          }`}>{t.status}</span>
                                        </div>
                                        <p className="text-xs text-gray-500 leading-relaxed">{t.summary}</p>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                                
                                {(selectedNode.data.decisions || []).length > 0 && (
                                  <div>
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                                      <CheckCircle2 className="w-3 h-3" />
                                      Decisions Made
                                    </h4>
                                    <ul className="space-y-2">
                                      {selectedNode.data.decisions.map((d: any, i: number) => (
                                        <li key={i} className="text-sm text-gray-700 flex items-start gap-3 bg-yellow-50/50 p-3 rounded-xl border border-yellow-100/50">
                                          <span className="w-1.5 h-1.5 rounded-full bg-yellow-500 mt-1.5 shrink-0 shadow-sm" />
                                          <span className="leading-snug">{d.decision}</span>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {(selectedNode.data.people || []).length > 0 && (
                                  <div>
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                                      <Users className="w-3 h-3" />
                                      People Involved
                                    </h4>
                                    <div className="flex flex-wrap gap-1.5">
                                      {selectedNode.data.people.map((p: string, i: number) => (
                                        <span key={i} className="px-3 py-1.5 bg-cyan-50/80 border border-cyan-100 text-cyan-800 text-[11px] rounded-lg font-medium shadow-sm">{p}</span>
                                      ))}
                                    </div>
                                  </div>
                                )}

                                {(selectedNode.data.actionItems || []).length > 0 && (
                                  <div>
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                                      <CheckCircle2 className="w-3 h-3" />
                                      Action Items
                                    </h4>
                                    <ul className="space-y-2">
                                      {selectedNode.data.actionItems.map((a: any, i: number) => (
                                        <li key={i} className="p-3 bg-pink-50/50 border border-pink-100/50 rounded-xl">
                                          <span className="text-sm font-medium text-pink-900 block mb-1.5">{a.task}</span>
                                          <div className="flex items-center gap-1.5">
                                            <span className="w-4 h-4 rounded-full bg-pink-200 flex items-center justify-center text-[8px] font-bold text-pink-700">{a.owner?.[0]?.toUpperCase()}</span>
                                            <span className="text-[10px] text-pink-600 font-medium">{a.owner}</span>
                                          </div>
                                        </li>
                                      ))}
                                    </ul>
                                  </div>
                                )}

                                {/* Related Meetings Section - Cross-Meeting Connections */}
                                {(() => {
                                  const relatedMeetings = findRelatedMeetings(selectedNode.data.meetingId);
                                  if (relatedMeetings.length === 0) return null;
                                  
                                  // Create a component for the expandable card to manage its own state
                                  const ExpandableMeetingCard = ({ related, idx }: { related: any, idx: number }) => {
                                    const [isExpanded, setIsExpanded] = useState(false);
                                    const relatedMeetingData = kgData.find(m => m.meetingId === related.meetingId);
                                    if (!relatedMeetingData) return null;
                                    
                                    return (
                                      <div key={idx} className="bg-gradient-to-br from-purple-50/80 to-blue-50/80 rounded-xl border border-purple-100/50 overflow-hidden transition-all duration-300 hover:shadow-md">
                                        {/* Collapsed Header (Always visible) */}
                                        <div 
                                          className="p-3.5 flex items-center justify-between cursor-pointer hover:bg-white/40 transition-colors group"
                                          onClick={() => setIsExpanded(!isExpanded)}
                                        >
                                          <div className="flex-1 min-w-0 pr-3">
                                            <div className="flex items-center gap-2 mb-1.5">
                                              <span className="text-sm font-bold text-gray-800 truncate group-hover:text-purple-700 transition-colors">
                                                {related.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
                                              </span>
                                              <span className="text-[9px] px-2 py-0.5 bg-purple-200/50 text-purple-800 rounded-md font-mono shrink-0 font-medium">
                                                {related.relevanceScore} pts
                                              </span>
                                            </div>
                                            <div className="text-[10px] text-gray-500 truncate flex items-center gap-1.5">
                                              {related.sharedTopics.length > 0 && (
                                                <span className="flex items-center gap-1 bg-white/60 px-1.5 py-0.5 rounded text-gray-600">
                                                  <MessageSquare className="w-3 h-3 text-purple-400" /> {related.sharedTopics.length}
                                                </span>
                                              )}
                                              {related.sharedPeople.length > 0 && (
                                                <span className="flex items-center gap-1 bg-white/60 px-1.5 py-0.5 rounded text-gray-600">
                                                  <Users className="w-3 h-3 text-cyan-400" /> {related.sharedPeople.length}
                                                </span>
                                              )}
                                            </div>
                                          </div>
                                          <div className={`shrink-0 p-1.5 bg-white/80 rounded-lg text-purple-600 shadow-sm transition-transform duration-300 ${isExpanded ? '-rotate-90 bg-purple-100' : 'rotate-90'}`}>
                                            <ChevronRight className="w-3.5 h-3.5" />
                                          </div>
                                        </div>

                                        {/* Expanded Content */}
                                      {isExpanded && (
                                        <div className="p-3 pt-0 border-t border-purple-100 bg-white/40">
                                          <div className="pt-3">
                                            {/* Why This Meeting is Connected */}
                                            <div className="mb-3 p-2 bg-white/70 rounded border border-purple-200">
                                              <span className="text-[9px] font-mono uppercase text-purple-700 block mb-1">🔗 Connection Details:</span>
                                              <div className="text-[10px] text-gray-700">
                                                {related.sharedTopics.length > 0 && (
                                                  <span className="block mb-1">
                                                    <strong>Topics:</strong> {related.sharedTopics.map((t:any) => t.name).join(', ')}
                                                  </span>
                                                )}
                                                {related.sharedPeople.length > 0 && (
                                                  <span className="block mb-1">
                                                    <strong>People:</strong> {related.sharedPeople.join(', ')}
                                                  </span>
                                                )}
                                              </div>
                                            </div>
                                            
                                            {/* What Was Discussed in That Meeting - All Topics */}
                                            {(relatedMeetingData.topics || []).length > 0 && (
                                              <div className="mb-3">
                                                <span className="text-[9px] font-mono uppercase text-indigo-700 block mb-2 flex items-center gap-1">
                                                  <MessageSquare className="w-3 h-3" />
                                                  What Was Discussed:
                                                </span>
                                                <div className="space-y-1.5">
                                                  {(relatedMeetingData.topics || []).map((topic: any, tIdx: number) => {
                                                    const isShared = related.sharedTopics.some((st:any) => 
                                                      calculateSimilarity(st.name, topic.name) >= 0.4
                                                    );
                                                    const sharedTopic = related.sharedTopics.find((st:any) => 
                                                      calculateSimilarity(st.name, topic.name) >= 0.4
                                                    );
                                                    
                                                    return (
                                                      <div key={tIdx} className={`p-2 rounded ${isShared ? 'bg-amber-50 border border-amber-200' : 'bg-white/80'}`}>
                                                        <div className="flex items-start justify-between gap-2 mb-1">
                                                          <span className="text-[10px] font-semibold text-gray-800 flex items-center gap-1">
                                                            {isShared && <span className="text-amber-600" title="Shared with current meeting">⭐</span>}
                                                            {topic.name}
                                                          </span>
                                                          <span className={`text-[8px] px-1 py-0.5 rounded font-mono shrink-0 ${
                                                            topic.status === 'resolved' ? 'bg-green-100 text-green-700' :
                                                            topic.status === 'off-track' ? 'bg-red-100 text-red-700' :
                                                            topic.status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                                                            topic.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                                          }`}>{topic.status}</span>
                                                        </div>
                                                        <p className="text-[9px] text-gray-600 leading-relaxed line-clamp-2 hover:line-clamp-none transition-all">"{topic.summary}"</p>
                                                        {isShared && sharedTopic && (
                                                          <div className="mt-1 pt-1 border-t border-amber-200/50">
                                                            <p className="text-[8px] text-amber-800">
                                                              Status: {sharedTopic.otherStatus} → {sharedTopic.currentStatus}
                                                            </p>
                                                          </div>
                                                        )}
                                                      </div>
                                                    );
                                                  })}
                                                </div>
                                              </div>
                                            )}
                                            
                                            {/* Decisions and Actions */}
                                            <div className="grid grid-cols-1 gap-2 mt-3">
                                              {(relatedMeetingData.decisions || []).length > 0 && (
                                                <div className="bg-yellow-50/50 rounded p-2 border border-yellow-100">
                                                  <span className="text-[9px] font-mono uppercase text-yellow-700 block mb-1">Decisions</span>
                                                  <ul className="space-y-1">
                                                    {(relatedMeetingData.decisions || []).slice(0, 2).map((dec: any, dIdx: number) => (
                                                      <li key={dIdx} className="text-[9px] text-yellow-900 truncate">• {dec.decision}</li>
                                                    ))}
                                                  </ul>
                                                </div>
                                              )}
                                              
                                              {(relatedMeetingData.actionItems || []).length > 0 && (
                                                <div className="bg-pink-50/50 rounded p-2 border border-pink-100">
                                                  <span className="text-[9px] font-mono uppercase text-pink-700 block mb-1">Actions</span>
                                                  <ul className="space-y-1">
                                                    {(relatedMeetingData.actionItems || []).slice(0, 2).map((action: any, aIdx: number) => (
                                                      <li key={aIdx} className="text-[9px] text-pink-900 truncate">
                                                        <span className="font-medium">{action.owner}:</span> {action.task}
                                                      </li>
                                                    ))}
                                                  </ul>
                                                </div>
                                              )}
                                            </div>
                                          </div>
                                        </div>
                                      )}
                                    </div>
                                  );
                                };

                                return (
                                  <div className="border-t border-gray-200 pt-5 mt-5">
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                                      <Share2 className="w-3 h-3" />
                                      Connected Meetings ({relatedMeetings.length})
                                    </h4>
                                    <div className="space-y-3">
                                      {relatedMeetings.slice(0, 5).map((related, idx) => (
                                        <ExpandableMeetingCard key={idx} related={related} idx={idx} />
                                      ))}
                                    </div>
                                    {relatedMeetings.length > 5 && (
                                      <button className="w-full mt-3 py-2 text-[10px] font-mono uppercase tracking-wider text-gray-400 hover:text-gray-600 bg-gray-50 hover:bg-gray-100 rounded-lg transition-colors">
                                        View {relatedMeetings.length - 5} More
                                      </button>
                                    )}
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {selectedNode.type === 'topic' && selectedNode.data && (
                            <div className="space-y-6">
                              <div className="bg-white/60 p-4 rounded-xl border border-gray-100 shadow-sm">
                                <div className={`px-2.5 py-1.5 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 mb-3 shadow-sm ${
                                  selectedNode.data.status === 'resolved' ? 'bg-green-100 text-green-700 border border-green-200' :
                                  selectedNode.data.status === 'off-track' ? 'bg-red-100 text-red-700 border border-red-200' :
                                  selectedNode.data.status === 'revisited' ? 'bg-yellow-100 text-yellow-700 border border-yellow-200' :
                                  selectedNode.data.status === 'ongoing' ? 'bg-blue-100 text-blue-700 border border-blue-200' : 'bg-purple-100 text-purple-700 border border-purple-200'
                                }`}>
                                  <span className="w-1.5 h-1.5 rounded-full bg-current" />
                                  Current Status: {selectedNode.data.status}
                                </div>
                                <p className="text-sm text-gray-700 leading-relaxed font-medium">{selectedNode.data.summary}</p>
                              </div>
                              
                              {/* Topic Evolution Timeline */}
                              {selectedNode.data.allStatuses && selectedNode.data.allStatuses.length > 1 && (
                                <div className="border-t border-gray-200 pt-5">
                                  <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                                    <Clock className="w-3 h-3" />
                                    Topic Evolution Timeline
                                  </h4>
                                  <div className="space-y-0 relative before:absolute before:inset-0 before:ml-[11px] before:-translate-x-px md:before:mx-auto md:before:translate-x-0 before:h-full before:w-0.5 before:bg-gradient-to-b before:from-transparent before:via-slate-200 before:to-transparent">
                                    {selectedNode.data.allStatuses.map((status: string, idx: number) => (
                                      <div key={idx} className="relative flex items-start gap-4 mb-4 group">
                                        <div className="flex flex-col items-center relative z-10 pt-1">
                                          <span className={`w-6 h-6 rounded-full flex items-center justify-center border-2 border-white shadow-sm transition-transform group-hover:scale-110 ${
                                            status === 'resolved' ? 'bg-green-500' :
                                            status === 'off-track' ? 'bg-red-500' :
                                            status === 'revisited' ? 'bg-yellow-500' :
                                            status === 'ongoing' ? 'bg-blue-500' : 'bg-purple-500'
                                          }`} />
                                        </div>
                                        <div className="flex-1 bg-white/60 p-3 rounded-xl border border-gray-100 shadow-sm group-hover:border-gray-200 transition-colors">
                                          <span className={`text-[9px] px-2 py-0.5 rounded-md font-mono inline-block mb-1.5 ${
                                            status === 'resolved' ? 'bg-green-100 text-green-700' :
                                            status === 'off-track' ? 'bg-red-100 text-red-700' :
                                            status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                                            status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                          }`}>{status}</span>
                                          <p className="text-xs text-gray-600 italic">
                                            "{selectedNode.data.allSummaries?.[idx] || 'No summary'}"
                                          </p>
                                        </div>
                                      </div>
                                    ))}
                                  </div>
                                </div>
                              )}

                              {/* Meetings where this topic was discussed */}
                              {(() => {
                                const meetingsWithTopic = kgData.filter(m => 
                                  (m.topics || []).some((t: any) => 
                                    t && t.name && (calculateSimilarity(t.name, selectedNode.label) >= 0.4 || 
                                    t.name.toLowerCase() === (selectedNode.label || '').toLowerCase())
                                  )
                                );
                                if (meetingsWithTopic.length === 0) return null;
                                return (
                                  <div className="border-t border-gray-200 pt-5">
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-3 flex items-center gap-2">
                                      <Share2 className="w-3 h-3" />
                                      Discussed in {meetingsWithTopic.length} Meeting{meetingsWithTopic.length !== 1 ? 's' : ''}
                                    </h4>
                                    <div className="space-y-3">
                                      {meetingsWithTopic.map((meeting, idx) => {
                                        const topicInMeeting = (meeting.topics || []).find((t: any) => 
                                          t && t.name && (calculateSimilarity(t.name, selectedNode.label) >= 0.4 || 
                                          t.name.toLowerCase() === (selectedNode.label || '').toLowerCase())
                                        );
                                        return (
                                          <div key={idx} className="p-3 bg-indigo-50/50 rounded-xl border border-indigo-100 hover:border-indigo-200 transition-colors group">
                                            <div className="flex items-center justify-between mb-2">
                                              <span className="text-sm font-semibold text-gray-800 truncate group-hover:text-indigo-700 transition-colors">
                                                {meeting.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
                                              </span>
                                              <span className={`text-[9px] px-2 py-0.5 rounded-md font-mono shrink-0 font-medium ${
                                                topicInMeeting?.status === 'resolved' ? 'bg-green-100 text-green-700' :
                                                topicInMeeting?.status === 'off-track' ? 'bg-red-100 text-red-700' :
                                                topicInMeeting?.status === 'revisited' ? 'bg-yellow-100 text-yellow-700' :
                                                topicInMeeting?.status === 'ongoing' ? 'bg-blue-100 text-blue-700' : 'bg-purple-100 text-purple-700'
                                              }`}>{topicInMeeting?.status}</span>
                                            </div>
                                            <div className="relative">
                                              <p className="text-xs text-gray-600 leading-relaxed italic line-clamp-2 hover:line-clamp-none transition-all cursor-pointer">"{topicInMeeting?.summary}"</p>
                                            </div>
                                          </div>
                                        );
                                      })}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {selectedNode.type === 'decision' && selectedNode.data && (
                            <div className="space-y-6">
                              <div className="p-4 bg-yellow-50/80 rounded-xl border border-yellow-200/50 shadow-sm relative overflow-hidden">
                                <div className="absolute top-0 right-0 p-2 opacity-10">
                                  <CheckCircle2 className="w-12 h-12" />
                                </div>
                                <h4 className="text-[10px] font-mono uppercase tracking-widest text-yellow-700 mb-2 relative z-10">Decision Made</h4>
                                <p className="text-sm text-yellow-900 font-medium leading-relaxed relative z-10">{selectedNode.data.decision}</p>
                              </div>
                              
                              <div className="flex items-center gap-3 p-3 bg-gray-50/80 rounded-xl border border-gray-100">
                                <span className="p-2 bg-white rounded-lg shadow-sm">
                                  <MessageSquare className="w-4 h-4 text-gray-400" />
                                </span>
                                <div>
                                  <span className="text-[10px] font-mono uppercase tracking-widest text-gray-400 block mb-0.5">Related Topic</span>
                                  <span className="text-xs font-semibold text-gray-700">{selectedNode.data.relatedTopic || 'General Discussion'}</span>
                                </div>
                              </div>
                              
                              {/* Meeting context */}
                              {selectedNode.data.meetingTitle && (
                                <div className="flex items-center gap-3 p-3 bg-gray-50/80 rounded-xl border border-gray-100">
                                  <span className="p-2 bg-white rounded-lg shadow-sm">
                                    <Presentation className="w-4 h-4 text-gray-400" />
                                  </span>
                                  <div>
                                    <span className="text-[10px] font-mono uppercase tracking-widest text-gray-400 block mb-0.5">Made in Meeting</span>
                                    <span className="text-xs font-semibold text-gray-700">
                                      {selectedNode.data.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
                                    </span>
                                  </div>
                                </div>
                              )}
                              
                              {/* Find similar decisions in other meetings */}
                              {(() => {
                                const similarDecisions: Array<{ meeting: string; decision: string }> = [];
                                kgData.forEach(m => {
                                  if (m.meetingId === selectedNode.data.meetingId) return;
                                  (m.decisions || []).forEach((d: any) => {
                                    if (calculateSimilarity(d.decision, selectedNode.data.decision) >= 0.3) {
                                      similarDecisions.push({ meeting: m.meetingTitle, decision: d.decision });
                                    }
                                  });
                                });
                                if (similarDecisions.length === 0) return null;
                                return (
                                  <div className="border-t border-gray-200 pt-5">
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-4 flex items-center gap-2">
                                      <Share2 className="w-3 h-3" />
                                      Similar Decisions ({similarDecisions.length})
                                    </h4>
                                    <div className="space-y-3">
                                      {similarDecisions.slice(0, 3).map((sd, idx) => (
                                        <div key={idx} className="p-3 bg-orange-50/50 rounded-xl border border-orange-100/50">
                                          <span className="text-[9px] font-mono uppercase text-orange-600 block mb-1.5 font-semibold tracking-wider">
                                            {sd.meeting?.replace(/\.[^.]+$/, '') || 'Meeting'}
                                          </span>
                                          <p className="text-xs text-orange-900 leading-relaxed">"{sd.decision}"</p>
                                        </div>
                                      ))}
                                    </div>
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {selectedNode.type === 'person' && selectedNode.data && (
                            <div className="space-y-6">
                              <div className="flex items-center gap-4 mb-2">
                                <div className="w-16 h-16 rounded-full bg-cyan-100 flex items-center justify-center border-4 border-cyan-50 shadow-sm text-cyan-600">
                                  <Users className="w-8 h-8" />
                                </div>
                                <div>
                                  <h3 className="font-bold text-xl text-gray-900">{selectedNode.label}</h3>
                                  <p className="text-xs text-gray-500 font-mono mt-1">Participant Profile</p>
                                </div>
                              </div>
                              
                              {/* Meetings where this person appears */}
                              {(() => {
                                const personName = (selectedNode.label || '').toLowerCase();
                                const meetingsWithPerson = kgData.filter(m => 
                                  (m.people || []).some((p: string) => p && p.toLowerCase() === personName)
                                );
                                if (meetingsWithPerson.length === 0) return null;
                                return (
                                  <div className="space-y-4 pt-2">
                                    <h4 className="text-[10px] font-mono uppercase tracking-widest text-gray-400 mb-2 flex items-center gap-2">
                                      <Presentation className="w-3 h-3" />
                                      Present in {meetingsWithPerson.length} Meeting{meetingsWithPerson.length !== 1 ? 's' : ''}
                                    </h4>
                                    {meetingsWithPerson.map((meeting, idx) => {
                                      // Find action items assigned to this person
                                      const assignedActions = (meeting.actionItems || []).filter((a: any) => 
                                        a.owner && a.owner.toLowerCase() === personName
                                      );
                                      return (
                                        <div key={idx} className="p-4 bg-cyan-50/30 rounded-xl border border-cyan-100 hover:border-cyan-200 transition-colors group">
                                          <span className="text-sm font-semibold text-gray-800 block mb-3 group-hover:text-cyan-700 transition-colors">
                                            {meeting.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
                                          </span>
                                          
                                          {/* Topics discussed in this meeting */}
                                          {(meeting.topics || []).length > 0 && (
                                            <div className="mb-3">
                                              <span className="text-[9px] font-mono uppercase text-cyan-600 block mb-1.5 tracking-wider">Topics Context:</span>
                                              <div className="flex flex-wrap gap-1.5">
                                                {(meeting.topics || []).slice(0, 3).map((t: any, tIdx: number) => (
                                                  <span key={tIdx} className="text-[10px] px-2 py-1 bg-white border border-cyan-100/50 rounded-md text-gray-600 shadow-sm">{t.name}</span>
                                                ))}
                                                {(meeting.topics || []).length > 3 && (
                                                  <span className="text-[10px] px-2 py-1 bg-gray-50 rounded-md text-gray-400">+{(meeting.topics || []).length - 3}</span>
                                                )}
                                              </div>
                                            </div>
                                          )}
                                          
                                          {/* Action items assigned to this person */}
                                          {assignedActions.length > 0 && (
                                            <div className="pt-2 border-t border-cyan-100/50">
                                              <span className="text-[9px] font-mono uppercase text-pink-600 block mb-2 tracking-wider flex items-center gap-1.5">
                                                <CheckCircle2 className="w-3 h-3" /> Assigned Tasks
                                              </span>
                                              <div className="space-y-1.5">
                                                {assignedActions.map((a: any, aIdx: number) => (
                                                  <div key={aIdx} className="text-[11px] text-pink-900 bg-pink-50/50 border border-pink-100/50 rounded-lg p-2.5 shadow-sm">
                                                    {a.task}
                                                  </div>
                                                ))}
                                              </div>
                                            </div>
                                          )}
                                        </div>
                                      );
                                    })}
                                  </div>
                                );
                              })()}
                            </div>
                          )}

                          {selectedNode.type === 'action' && selectedNode.data && (
                            <div className="space-y-4">
                              <div className="p-4 bg-pink-50/80 rounded-xl border border-pink-200/50 shadow-sm relative overflow-hidden">
                                <div className="absolute top-0 right-0 p-2 opacity-10">
                                  <CheckCircle2 className="w-12 h-12 text-pink-500" />
                                </div>
                                <h4 className="text-[10px] font-mono uppercase tracking-widest text-pink-700 mb-2 relative z-10">Action Item</h4>
                                <p className="text-sm text-pink-900 font-medium leading-relaxed relative z-10">{selectedNode.data.task}</p>
                              </div>
                              
                              <div className="grid grid-cols-2 gap-3">
                                <div className="p-3 bg-gray-50/80 rounded-xl border border-gray-100">
                                  <span className="text-[9px] font-mono uppercase tracking-widest text-gray-400 block mb-1">Owner</span>
                                  <div className="flex items-center gap-2">
                                    <span className="w-5 h-5 rounded-full bg-cyan-100 flex items-center justify-center text-[10px] font-bold text-cyan-700">
                                      {selectedNode.data.owner?.[0]?.toUpperCase()}
                                    </span>
                                    <span className="text-xs font-semibold text-gray-700 truncate">{selectedNode.data.owner}</span>
                                  </div>
                                </div>
                                <div className="p-3 bg-gray-50/80 rounded-xl border border-gray-100">
                                  <span className="text-[9px] font-mono uppercase tracking-widest text-gray-400 block mb-1">Related To</span>
                                  <span className="text-xs font-semibold text-gray-700 line-clamp-1">{selectedNode.data.relatedTopic || 'General'}</span>
                                </div>
                              </div>
                              
                              {/* Meeting context */}
                              {selectedNode.data.meetingTitle && (
                                <div className="flex items-center gap-3 p-3 bg-gray-50/80 rounded-xl border border-gray-100">
                                  <span className="p-2 bg-white rounded-lg shadow-sm">
                                    <Presentation className="w-4 h-4 text-gray-400" />
                                  </span>
                                  <div>
                                    <span className="text-[10px] font-mono uppercase tracking-widest text-gray-400 block mb-0.5">Assigned in Meeting</span>
                                    <span className="text-xs font-semibold text-gray-700">
                                      {selectedNode.data.meetingTitle?.replace(/\.[^.]+$/, '') || 'Meeting'}
                                    </span>
                                  </div>
                                </div>
                              )}
                            </div>
                          )}
                          </div>
                        </motion.div>
                        )}
                      </AnimatePresence>
                    </>
                  )}
                </div>
              </motion.div>
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
