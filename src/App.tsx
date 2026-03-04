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
  generateReportContent
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
      setAssetHistory(data);
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

  const handleAgentAction = async (agentType: 'email' | 'wiki') => {
    if (!selectedTask || isGeneratingAsset) {
      if (!selectedTask) {
        setCurrentView('history');
        setError('Please select a task from history first to use agents.');
      }
      return;
    }
    
    setIsGeneratingAsset(true);
    setCurrentView('notes');
    setNoteTab('chat');
    setChatMessages(prev => [...prev, { role: 'model', text: `Agent is analyzing "${selectedTask.filename}"...` }]);

    try {
      let result = '';
      if (agentType === 'email') {
        const emailPrompt = "You are a professional project manager. Draft a professional follow-up email based on this transcript. Include a clear, bulleted list of all tasks, owners (if mentioned), and deadlines. The email should be concise and action-oriented.";
        result = await chatWithNotes(selectedTask.transcription, emailPrompt, []);
      } else {
        const wikiPrompt = wikiStyle === 'MECE' 
          ? "Generate a detailed end-to-end report of this meeting using the MECE (Mutually Exclusive, Collectively Exhaustive) framework. Ensure all points are logically grouped and exhaustive. Use professional formatting with clear headings."
          : "Generate a comprehensive Product Requirements Document (PRD) based on this meeting. Include detailed sections for: 1. UI/UX Requirements, 2. User Stories, 3. Developer Team Tasks, and 4. Competitor Analysis. The document must be well-structured and professional.";
        result = await chatWithNotes(selectedTask.transcription, wikiPrompt, []);
      }

      setChatMessages(prev => [
        ...prev.slice(0, -1), 
        { role: 'model', text: result }
      ]);
    } catch (err) {
      console.error('Agent error:', err);
      setChatMessages(prev => [
        ...prev.slice(0, -1), 
        { role: 'model', text: 'Sorry, the agent encountered an error processing your request.' }
      ]);
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
    } else {
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
                className="p-4 sm:p-8 max-w-6xl mx-auto"
              >
                <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 mb-12">
                  <div>
                    <h2 className="text-4xl font-serif italic font-bold mb-2">AI Agents</h2>
                    <p className="text-sm opacity-50 font-mono uppercase tracking-widest">Specialized intelligence for your audio data</p>
                  </div>
                  <div className="flex items-center gap-2 px-4 py-2 bg-[#141414] text-white rounded-full text-[10px] font-mono uppercase tracking-widest">
                    <Sparkles className="w-3 h-3" /> 2 Agents Available
                  </div>
                </div>

                <div className="grid grid-cols-1 md:grid-cols-2 gap-8">
                  {/* Follow-up Email Agent */}
                  <motion.div 
                    whileHover={{ scale: 1.01 }}
                    className="border border-[#141414] bg-white p-8 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] flex flex-col group"
                  >
                    <div className="flex items-center gap-4 mb-6">
                      <div className="p-4 rounded-2xl bg-blue-100 text-blue-700">
                        <Mail className="w-8 h-8" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold">Follow-up Email Generator</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                          <span className="text-[10px] font-mono uppercase opacity-40">Team Sync Ready</span>
                        </div>
                      </div>
                    </div>
                    
                    <p className="text-sm opacity-60 leading-relaxed mb-8 flex-1">
                      Drafts a professional follow-up email for your team, including a clear list of tasks, owners, and next steps extracted from the audio.
                    </p>

                    <div className="space-y-4">
                      <div className="p-4 bg-[#F5F5F5] rounded-xl border border-[#141414]/5">
                        <p className="text-[10px] font-mono uppercase opacity-40 mb-2">Core Directive</p>
                        <p className="text-[11px] italic opacity-70 line-clamp-2">"Draft a professional follow-up email with a bulleted list of tasks and owners."</p>
                      </div>
                      
                      <button 
                        onClick={() => handleAgentAction('email')}
                        disabled={isGeneratingAsset}
                        className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] transition-all flex items-center justify-center gap-2"
                      >
                        {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />}
                        {selectedTask ? 'Run on Current Notes' : 'Generate Email'}
                      </button>
                    </div>
                  </motion.div>

                  {/* Wiki Agent */}
                  <motion.div 
                    whileHover={{ scale: 1.01 }}
                    className="border border-[#141414] bg-white p-8 shadow-[8px_8px_0px_0px_rgba(20,20,20,1)] flex flex-col group"
                  >
                    <div className="flex items-center gap-4 mb-6">
                      <div className="p-4 rounded-2xl bg-purple-100 text-purple-700">
                        <BookOpen className="w-8 h-8" />
                      </div>
                      <div>
                        <h3 className="text-xl font-bold">Wiki Agent</h3>
                        <div className="flex items-center gap-2 mt-1">
                          <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
                          <span className="text-[10px] font-mono uppercase opacity-40">Knowledge Base Expert</span>
                        </div>
                      </div>
                    </div>
                    
                    <p className="text-sm opacity-60 leading-relaxed mb-8 flex-1">
                      Generates a comprehensive, end-to-end report of the meeting. Choose between structured MECE or detailed PRD formats.
                    </p>

                    <div className="space-y-4">
                      <div className="flex gap-2 p-1 bg-[#F5F5F5] rounded-lg border border-[#141414]/5">
                        <button 
                          onClick={() => setWikiStyle('MECE')}
                          className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest rounded-md transition-all ${wikiStyle === 'MECE' ? 'bg-white shadow-sm text-[#141414] font-bold' : 'opacity-40 hover:opacity-100'}`}
                        >
                          MECE Structure
                        </button>
                        <button 
                          onClick={() => setWikiStyle('PRD')}
                          className={`flex-1 py-2 text-[10px] font-mono uppercase tracking-widest rounded-md transition-all ${wikiStyle === 'PRD' ? 'bg-white shadow-sm text-[#141414] font-bold' : 'opacity-40 hover:opacity-100'}`}
                        >
                          PRD Style
                        </button>
                      </div>

                      <div className="p-4 bg-[#F5F5F5] rounded-xl border border-[#141414]/5">
                        <p className="text-[10px] font-mono uppercase opacity-40 mb-2">Structure Details</p>
                        <p className="text-[11px] opacity-70">
                          {wikiStyle === 'MECE' 
                            ? "Mutually Exclusive, Collectively Exhaustive framework for logical grouping."
                            : "Includes UI/UX, User Stories, Developer Tasks, and Competitor Analysis."}
                        </p>
                      </div>
                      
                      <button 
                        onClick={() => handleAgentAction('wiki')}
                        disabled={isGeneratingAsset}
                        className="w-full py-3 bg-[#141414] text-white font-bold uppercase tracking-widest text-xs hover:bg-[#333] transition-all flex items-center justify-center gap-2"
                      >
                        {isGeneratingAsset ? <Loader2 className="w-4 h-4 animate-spin" /> : <Layout className="w-4 h-4" />}
                        {selectedTask ? 'Run on Current Notes' : 'Generate Wiki Report'}
                      </button>
                    </div>
                  </motion.div>
                </div>

                <div className="mt-16 p-8 border border-dashed border-[#141414]/20 rounded-3xl text-center bg-white/50">
                  <Plus className="w-8 h-8 mx-auto mb-4 opacity-20" />
                  <h3 className="text-lg font-serif italic opacity-40">Custom Agent</h3>
                  <p className="text-xs opacity-40 mt-2 max-w-md mx-auto">Coming soon: Create your own specialized AI agents with custom prompts and knowledge bases.</p>
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
