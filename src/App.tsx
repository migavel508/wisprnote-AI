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
  FileSearch
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import PptxGenJS from 'pptxgenjs';
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from 'docx';
import { saveAs } from 'file-saver';
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
  chatWithPodcast
} from './services/geminiService';
import { 
  supabase, 
  saveTask, 
  getTasks, 
  TaskHistory, 
  saveAsset, 
  getAssets, 
  GeneratedAsset 
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

type View = 'process' | 'history' | 'notes' | 'assets' | 'agents';
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
  const [status, setStatus] = useState<Status>('idle');
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [prompt, setPrompt] = useState('Please provide a detailed transcription of this audio.');
  const [error, setError] = useState<string | null>(null);
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
    setChatMessages(prev => [...prev, userMessage]);
    setChatInput('');
    setIsChatting(true);

    try {
      const history = chatMessages.map(m => ({
        role: m.role,
        parts: [{ text: m.text }]
      }));

      const response = await chatWithNotes(
        selectedTask.transcription + '\n\n' + (selectedTask.summary || '') + '\n\n' + (selectedTask.notes || ''),
        chatInput,
        history
      );

      setChatMessages(prev => [...prev, { role: 'model', text: response }]);
    } catch (err) {
      console.error('Chat error:', err);
      setChatMessages(prev => [...prev, { role: 'model', text: 'Sorry, I encountered an error while processing your request.' }]);
    } finally {
      setIsChatting(false);
    }
  };

  const handleVisualize = async (description: string) => {
    if (isGeneratingImage) return;
    
    setIsGeneratingImage(true);
    setChatMessages(prev => [...prev, { role: 'model', text: `Generating visualization for: "${description}"...` }]);

    try {
      const imageUrl = await generateConceptImage(description);
      if (imageUrl) {
        setChatMessages(prev => [
          ...prev.slice(0, -1), 
          { role: 'model', text: `Here is the visualization for: "${description}"`, image: imageUrl }
        ]);
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
                      setChatMessages([]);
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
                  {/* Left: Upload */}
                  <div className="space-y-6">
                    <section className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
                      <h2 className="font-serif italic text-sm uppercase opacity-50 mb-4 tracking-wider">01. Input</h2>
                      <div 
                        onClick={() => fileInputRef.current?.click()}
                        className={`border-2 border-dashed border-[#141414]/20 p-12 text-center cursor-pointer hover:bg-[#F5F5F5] transition-colors mb-4 ${file ? 'bg-[#F5F5F5]' : ''}`}
                      >
                        <input type="file" ref={fileInputRef} onChange={handleFileChange} className="hidden" accept="audio/*" />
                        {file ? (
                          <div className="flex flex-col items-center gap-2">
                            <FileAudio className="w-12 h-12 mb-2" />
                            <span className="font-mono text-sm font-bold">{file.name}</span>
                            <span className="text-xs opacity-50">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                          </div>
                        ) : (
                          <div className="flex flex-col items-center gap-2">
                            <Upload className="w-12 h-12 mb-2 opacity-30" />
                            <span className="text-sm font-medium">Drop audio file here</span>
                          </div>
                        )}
                      </div>
                      <textarea 
                        value={prompt}
                        onChange={(e) => setPrompt(e.target.value)}
                        className="w-full border border-[#141414] p-3 text-sm font-mono focus:outline-none h-24 resize-none"
                        placeholder="Instructions..."
                      />
                      <button 
                        onClick={startProcessing}
                        disabled={!file || status === 'processing' || status === 'splitting'}
                        className="w-full mt-6 bg-[#141414] text-[#E4E3E0] py-4 font-bold uppercase tracking-widest hover:bg-[#333] disabled:opacity-30 flex items-center justify-center gap-2"
                      >
                        {status === 'processing' || status === 'splitting' ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5 fill-current" />}
                        Start Processing
                      </button>
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
                            <div className="flex-1 overflow-y-auto p-6 space-y-6">
                              {chatMessages.length === 0 && (
                                <div className="h-full flex flex-col items-center justify-center text-center p-8 opacity-40">
                                  <MessageSquare className="w-12 h-12 mb-4" />
                                  <p className="text-sm font-mono uppercase tracking-widest">Start chatting with your notes</p>
                                  <p className="text-xs mt-2">Ask questions or request visualizations</p>
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
