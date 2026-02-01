
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Note, AppView, Todo, ChatMessage, NoteStatus, Priority, NoteCategory, VoiceAgent } from './types';
import { Icon } from './components/Icon';
import VoiceLiveOverlay from './components/VoiceLiveOverlay';
import ImageEditorOverlay from './components/ImageEditorOverlay';
import AgentBuilderOverlay from './components/AgentBuilderOverlay';
import { 
  summarizeNote, 
  suggestUnifiedMetadata, 
  askAboutNote, 
  extractTextFromImage, 
  verifyFacts, 
  generateAudioBrief, 
  decodeAudioData, 
  decodeAudio,
  autoCorrectAndRestructure,
  extractTasks
} from './services/geminiService';

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(AppView.LIST);
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const saved = localStorage.getItem('lumina-workspace-v1');
      return saved ? JSON.parse(saved) : [];
    } catch(e) { return []; }
  });
  const [agents, setAgents] = useState<VoiceAgent[]>(() => {
    try {
      const saved = localStorage.getItem('lumina-agents-v1');
      return saved ? JSON.parse(saved) : [{
        id: 'default',
        name: 'Brainstormer',
        rules: 'You are a brilliant startup co-founder. You focus on lean methodology and rapid iteration.',
        icon: 'sparkle',
        color: '#4f46e5',
        linkedNoteIds: [],
        lastUsed: Date.now()
      }];
    } catch(e) { return []; }
  });
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [activeAgent, setActiveAgent] = useState<VoiceAgent | null>(null);
  const [editingAgent, setEditingAgent] = useState<VoiceAgent | undefined>();
  const [searchTerm, setSearchTerm] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const [isPlaying, setIsPlaying] = useState(false);
  const [isAutoCorrectOn, setIsAutoCorrectOn] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const audioContextRef = useRef<AudioContext | null>(null);

  useEffect(() => {
    localStorage.setItem('lumina-workspace-v1', JSON.stringify(notes));
  }, [notes]);

  useEffect(() => {
    localStorage.setItem('lumina-agents-v1', JSON.stringify(agents));
  }, [agents]);

  useEffect(() => {
    if (showChat) chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [activeNote?.chatHistory, showChat]);

  const filteredNotes = useMemo(() => {
    return notes
      .filter(n => 
        (n.title?.toLowerCase() || '').includes(searchTerm.toLowerCase()) || 
        (n.content?.toLowerCase() || '').includes(searchTerm.toLowerCase())
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
  }, [notes, searchTerm]);

  const handleCreateNote = () => {
    const newNote: Note = {
      id: Date.now().toString(),
      title: '',
      content: '',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      tags: [],
      todos: [],
      chatHistory: [],
      category: 'Personal',
      vibeColor: '#4f46e5',
      status: 'TO_DO',
      priority: 'MEDIUM',
      epic: 'Backlog'
    };
    setNotes(prev => [newNote, ...prev]);
    setActiveNote(newNote);
    setView(AppView.EDITOR);
  };

  const handleUpdateNote = (updates: Partial<Note>) => {
    if (!activeNote) return;
    const updatedNote = { ...activeNote, ...updates, updatedAt: Date.now() };
    setActiveNote(updatedNote);
    setNotes(prev => prev.map(n => n.id === activeNote.id ? updatedNote : n));
  };

  // Fixed: Added missing handleSaveAgent function
  const handleSaveAgent = (agent: VoiceAgent) => {
    setAgents(prev => {
      const exists = prev.find(a => a.id === agent.id);
      if (exists) {
        return prev.map(a => a.id === agent.id ? agent : a);
      }
      return [...prev, agent];
    });
    setEditingAgent(undefined);
    setView(AppView.AGENTS);
  };

  const handleSmartClean = async () => {
    if (!activeNote || !activeNote.content) return;
    setIsAiLoading(true);
    try {
      const cleanedContent = await autoCorrectAndRestructure(activeNote.content);
      const extracted = await extractTasks(cleanedContent);
      const newTodos: Todo[] = extracted.map(t => ({
        id: Math.random().toString(),
        text: t.text,
        completed: false,
        priority: t.priority as Priority
      }));
      handleUpdateNote({ 
        content: cleanedContent,
        todos: [...activeNote.todos, ...newTodos]
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleSmartRefine = async () => {
    if (!activeNote || !activeNote.content) return;
    setIsAiLoading(true);
    try {
      const meta = await suggestUnifiedMetadata(activeNote.content);
      handleUpdateNote({ 
        title: activeNote.title || meta.title, 
        tags: [...new Set([...activeNote.tags, ...meta.tags])],
        category: meta.category as NoteCategory,
        vibeColor: meta.vibeColor,
        priority: meta.priority as Priority,
        storyPoints: meta.storyPoints,
        epic: meta.epic
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleFactCheck = async () => {
    if (!activeNote || !activeNote.content) return;
    setIsAiLoading(true);
    try {
      const check = await verifyFacts(activeNote.content);
      handleUpdateNote({ factCheck: check });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handlePlayBrief = async () => {
    if (!activeNote || isPlaying) return;
    setIsPlaying(true);
    try {
      const summary = await summarizeNote(activeNote.content);
      const base64Audio = await generateAudioBrief(summary);
      if (!audioContextRef.current) {
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)();
      }
      const ctx = audioContextRef.current;
      const buffer = await decodeAudioData(decodeAudio(base64Audio), ctx, 24000, 1);
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      source.connect(ctx.destination);
      source.onended = () => setIsPlaying(false);
      source.start();
    } catch (err) {
      console.error(err);
      setIsPlaying(false);
    }
  };

  const handleExtractText = async () => {
    if (!activeNote?.imageUrl) return;
    setIsAiLoading(true);
    try {
      const text = await extractTextFromImage(activeNote.imageUrl);
      handleUpdateNote({ content: activeNote.content + "\n\n[Scanned Context]:\n" + text });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleSendChatMessage = async () => {
    if (!chatInput.trim() || !activeNote) return;
    const userMsg: ChatMessage = { role: 'user', text: chatInput };
    const history = [...activeNote.chatHistory, userMsg];
    const currentInput = chatInput;
    setChatInput('');
    setIsAiLoading(true);
    handleUpdateNote({ chatHistory: history });
    try {
      const response = await askAboutNote(activeNote.content, currentInput, history);
      const aiMsg: ChatMessage = { role: 'model', text: response };
      handleUpdateNote({ chatHistory: [...history, aiMsg] });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const updateStatus = (id: string, newStatus: NoteStatus) => {
    setNotes(prev => prev.map(n => n.id === id ? { ...n, status: newStatus, updatedAt: Date.now() } : n));
    if (activeNote?.id === id) setActiveNote(prev => prev ? { ...prev, status: newStatus } : null);
  };

  const toggleTodo = (todoId: string) => {
    if (!activeNote) return;
    const updatedTodos = activeNote.todos.map(t => 
      t.id === todoId ? { ...t, completed: !t.completed } : t
    );
    handleUpdateNote({ todos: updatedTodos });
  };

  const removeTodo = (todoId: string) => {
    if (!activeNote) return;
    const updatedTodos = activeNote.todos.filter(t => t.id !== todoId);
    handleUpdateNote({ todos: updatedTodos });
  };

  const getStatusBadge = (status: NoteStatus) => {
    switch(status) {
      case 'TO_DO': return 'bg-slate-700 text-slate-300';
      case 'IN_PROGRESS': return 'bg-indigo-600/20 text-indigo-400 border-indigo-500/30';
      case 'DONE': return 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30';
    }
  };

  const renderBoardColumn = (status: NoteStatus, label: string) => {
    const columnNotes = filteredNotes.filter(n => n.status === status);
    return (
      <div className="flex-shrink-0 w-72 h-full flex flex-col gap-4">
        <h3 className="text-[10px] font-black uppercase tracking-widest text-slate-500 px-2">{label} • {columnNotes.length}</h3>
        <div className="flex-1 overflow-y-auto space-y-3 no-scrollbar pb-24">
          {columnNotes.map(note => (
            <div 
              key={note.id}
              onClick={() => { setActiveNote(note); setView(AppView.EDITOR); }}
              className="bg-slate-900/40 border border-slate-800 p-4 rounded-2xl hover:border-indigo-500/50 transition-all cursor-pointer shadow-xl active:scale-[0.97]"
            >
              <div className="flex justify-between items-start mb-2">
                <span className="text-[8px] font-black px-1.5 py-0.5 bg-slate-800 rounded text-slate-500 uppercase">{note.epic}</span>
                <div className={`w-1.5 h-1.5 rounded-full shadow-[0_0_8px] shadow-current ${note.priority === 'CRITICAL' ? 'bg-rose-500' : note.priority === 'HIGH' ? 'bg-amber-500' : 'bg-slate-600'}`}></div>
              </div>
              <h4 className="text-xs font-bold text-slate-200 mb-3 line-clamp-2">{note.title || 'Draft Issue'}</h4>
              <div className="flex items-center justify-between">
                <div className="flex gap-1">
                   <div className="w-5 h-5 rounded-full bg-indigo-600 flex items-center justify-center text-[8px] font-bold text-white border border-slate-950">AI</div>
                   <span className="text-[9px] font-bold text-slate-600 uppercase tracking-tighter">{note.category}</span>
                </div>
                {note.storyPoints && <span className="w-5 h-5 rounded-full bg-slate-800 border border-slate-700 flex items-center justify-center text-[8px] font-black text-slate-400">{note.storyPoints}</span>}
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  };

  return (
    <div className="flex flex-col h-screen bg-[#020617] text-slate-100 overflow-hidden max-w-lg mx-auto border-x border-slate-800/50 shadow-2xl relative">
      <header className="px-6 py-4 flex justify-between items-center border-b border-slate-800/40 bg-slate-900/60 backdrop-blur-2xl sticky top-0 z-30 h-16">
        <div className="flex items-center gap-4">
          {view === AppView.EDITOR || view === AppView.AGENT_BUILDER || view === AppView.AGENTS ? (
            <button onClick={() => setView(AppView.LIST)} className="p-2 -ml-2 hover:bg-slate-800/50 rounded-full transition-all">
              <Icon name="back" className="w-5 h-5" />
            </button>
          ) : (
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 bg-indigo-600 rounded-lg flex items-center justify-center shadow-lg shadow-indigo-500/20">
                <Icon name="sparkle" className="w-5 h-5 text-white" />
              </div>
              <h1 className="text-lg font-black tracking-tighter uppercase italic text-indigo-100">Lumina</h1>
            </div>
          )}
        </div>
        
        {view !== AppView.EDITOR && view !== AppView.AGENT_BUILDER && (
          <div className="flex gap-1.5 bg-slate-800/50 p-1 rounded-xl">
             <button onClick={() => setView(AppView.LIST)} className={`px-4 py-1.5 rounded-lg text-[9px] font-black transition-all ${view === AppView.LIST ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>NOTES</button>
             <button onClick={() => setView(AppView.BOARD)} className={`px-4 py-1.5 rounded-lg text-[9px] font-black transition-all ${view === AppView.BOARD ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>BOARD</button>
             <button onClick={() => setView(AppView.AGENTS)} className={`px-4 py-1.5 rounded-lg text-[9px] font-black transition-all ${view === AppView.AGENTS ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-500 hover:text-slate-300'}`}>AGENTS</button>
          </div>
        )}

        <div className="flex gap-2">
           {view === AppView.EDITOR && (
             <button onClick={handlePlayBrief} disabled={isPlaying} className={`p-2 rounded-full transition-all ${isPlaying ? 'bg-emerald-500 text-white animate-pulse' : 'bg-slate-800 text-emerald-400 hover:bg-slate-700'}`}>
               <Icon name="volume" className="w-5 h-5" />
             </button>
           )}
           <button onClick={() => { setActiveAgent(null); setView(AppView.VOICE_LIVE); }} className="p-2 bg-indigo-600 text-white rounded-full shadow-lg hover:scale-105 active:scale-95 transition-all">
             <Icon name="mic" className="w-5 h-5" />
           </button>
        </div>
      </header>

      <main className="flex-1 overflow-hidden relative">
        {view === AppView.LIST && (
          <div className="p-6 h-full flex flex-col space-y-6 overflow-y-auto no-scrollbar">
            <div className="relative group">
              <input 
                type="text" 
                placeholder="Search notes & issues..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-950 border border-slate-800/50 rounded-2xl py-3.5 px-12 focus:ring-1 focus:ring-indigo-500 text-sm shadow-inner transition-all"
              />
              <Icon name="search" className="absolute left-4 top-3.5 w-4 h-4 text-slate-500" />
            </div>
            
            <div className="grid gap-4 pb-24">
              {filteredNotes.length === 0 ? (
                <div className="py-20 flex flex-col items-center opacity-20 italic">
                  <Icon name="sparkle" className="w-12 h-12 mb-4" />
                  <p className="text-sm font-bold tracking-widest uppercase">The void is waiting...</p>
                </div>
              ) : (
                filteredNotes.map(note => (
                  <div 
                    key={note.id}
                    onClick={() => { setActiveNote(note); setView(AppView.EDITOR); }}
                    className="group bg-slate-900/40 p-5 rounded-[2rem] border border-slate-800/60 hover:border-indigo-500/30 transition-all cursor-pointer flex gap-4 hover:translate-y-[-2px] active:scale-[0.98] relative overflow-hidden"
                  >
                    <div className="absolute top-0 left-0 w-1.5 h-full" style={{ backgroundColor: note.vibeColor }}></div>
                    <div className="flex-1 min-w-0">
                      <div className="flex justify-between items-start mb-2">
                        <span className="text-[8px] font-black bg-slate-800 px-2 py-1 rounded text-slate-500 uppercase tracking-widest">{note.category}</span>
                        <span className={`text-[8px] font-black px-2 py-0.5 rounded uppercase tracking-tighter ${getStatusBadge(note.status)}`}>{note.status.replace('_', ' ')}</span>
                      </div>
                      <h3 className="font-black text-slate-100 text-sm truncate uppercase tracking-tight">{note.title || 'Untitled Thought'}</h3>
                      <p className="text-slate-400 text-xs line-clamp-1 mt-1 font-medium">{note.content || 'Drafting ideas...'}</p>
                      <div className="flex flex-wrap gap-1.5 mt-4">
                        {note.tags.slice(0, 3).map(tag => (
                          <span key={tag} className="text-[9px] px-2.5 py-1 rounded-lg bg-indigo-500/10 text-indigo-300 font-black uppercase tracking-tighter border border-indigo-500/20">#{tag}</span>
                        ))}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>
        )}

        {view === AppView.BOARD && (
          <div className="flex h-full gap-5 overflow-x-auto p-6 no-scrollbar snap-x snap-mandatory">
            <div className="snap-center">{renderBoardColumn('TO_DO', 'To Do')}</div>
            <div className="snap-center">{renderBoardColumn('IN_PROGRESS', 'In Progress')}</div>
            <div className="snap-center">{renderBoardColumn('DONE', 'Done')}</div>
          </div>
        )}

        {view === AppView.AGENTS && (
          <div className="p-6 h-full flex flex-col space-y-8 overflow-y-auto no-scrollbar">
            <div className="space-y-2">
               <h2 className="text-2xl font-black italic tracking-tighter uppercase text-indigo-100">Your Forge</h2>
               <p className="text-xs text-slate-500 font-bold uppercase tracking-widest">Select a specialized co-founder</p>
            </div>

            <div className="grid gap-4 pb-24">
              {agents.map(agent => (
                <div 
                  key={agent.id}
                  className="bg-slate-900/40 p-5 rounded-[2.5rem] border border-slate-800/60 flex items-center gap-5 hover:border-indigo-500/30 transition-all group"
                >
                  <div 
                    onClick={() => { setActiveAgent(agent); setView(AppView.VOICE_LIVE); }}
                    className="w-14 h-14 rounded-3xl flex items-center justify-center shadow-lg transition-transform hover:scale-110 active:scale-90 cursor-pointer"
                    style={{ backgroundColor: agent.color }}
                  >
                    <Icon name="mic" className="w-7 h-7 text-white" />
                  </div>
                  <div className="flex-1 cursor-pointer" onClick={() => { setActiveAgent(agent); setView(AppView.VOICE_LIVE); }}>
                    <h3 className="font-black text-slate-100 uppercase tracking-tight">{agent.name}</h3>
                    <p className="text-[10px] text-slate-500 font-bold uppercase tracking-widest mt-1">{agent.linkedNoteIds.length} Linked Notes</p>
                  </div>
                  <button 
                    onClick={() => { setEditingAgent(agent); setView(AppView.AGENT_BUILDER); }}
                    className="p-3 bg-slate-800 rounded-2xl opacity-0 group-hover:opacity-100 transition-opacity"
                  >
                    <Icon name="sparkle" className="w-4 h-4 text-slate-400" />
                  </button>
                </div>
              ))}
              
              <button 
                onClick={() => { setEditingAgent(undefined); setView(AppView.AGENT_BUILDER); }}
                className="w-full bg-indigo-600/10 border border-indigo-500/20 border-dashed p-6 rounded-[2.5rem] text-indigo-400 flex flex-col items-center justify-center gap-2 hover:bg-indigo-600/20 transition-all"
              >
                <Icon name="plus" className="w-8 h-8" />
                <span className="text-[10px] font-black uppercase tracking-widest">Forge New Co-Founder</span>
              </button>
            </div>
          </div>
        )}

        {view === AppView.EDITOR && activeNote && (
          <div className="flex flex-col h-full p-6 space-y-6 overflow-y-auto no-scrollbar">
            <div className="flex items-center justify-between">
               <div className="flex items-center gap-2">
                 <div className="w-3 h-3 rounded-full" style={{ backgroundColor: activeNote.vibeColor }}></div>
                 <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{activeNote.category}</span>
               </div>
               <div className="flex items-center gap-3">
                 <button 
                  onClick={() => setIsAutoCorrectOn(!isAutoCorrectOn)}
                  className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-[9px] font-black uppercase tracking-widest transition-all ${isAutoCorrectOn ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'bg-slate-800 text-slate-500 border-slate-700'}`}
                 >
                   <Icon name="sparkle" className="w-3 h-3" />
                   Smart-Fix {isAutoCorrectOn ? 'ON' : 'OFF'}
                 </button>
                 <select 
                   value={activeNote.status}
                   onChange={(e) => updateStatus(activeNote.id, e.target.value as NoteStatus)}
                   className={`text-[9px] font-black px-3 py-1.5 rounded-xl border focus:outline-none uppercase tracking-widest shadow-lg ${getStatusBadge(activeNote.status)}`}
                 >
                   <option value="TO_DO">TO DO</option>
                   <option value="IN_PROGRESS">IN PROGRESS</option>
                   <option value="DONE">DONE</option>
                 </select>
               </div>
            </div>

            <div className="space-y-4">
              <input 
                type="text" 
                value={activeNote.title}
                onChange={(e) => handleUpdateNote({ title: e.target.value })}
                className="w-full bg-transparent text-3xl font-black focus:outline-none placeholder-slate-900 tracking-tighter"
                placeholder="UNLEASH THOUGHTS..."
              />
              <div className="flex flex-wrap gap-2 items-center">
                <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 rounded-xl border border-slate-800">
                  <Icon name="flag" className={`w-3 h-3 ${activeNote.priority === 'CRITICAL' ? 'text-rose-500' : activeNote.priority === 'HIGH' ? 'text-amber-500' : 'text-slate-600'}`} />
                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">{activeNote.priority}</span>
                </div>
                {activeNote.storyPoints && (
                  <div className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-900 rounded-xl border border-slate-800">
                    <Icon name="sparkle" className="w-3 h-3 text-indigo-400" />
                    <span className="text-[9px] font-black text-slate-400 uppercase tracking-tighter">{activeNote.storyPoints} PTS</span>
                  </div>
                )}
                {activeNote.tags.map(tag => (
                  <span key={tag} className="text-[10px] bg-indigo-500/10 text-indigo-400 px-3 py-1.5 rounded-xl font-black border border-indigo-500/10">#{tag}</span>
                ))}
              </div>
            </div>
            
            <div className="relative">
              <textarea 
                value={activeNote.content}
                onChange={(e) => handleUpdateNote({ content: e.target.value })}
                className="w-full bg-transparent resize-none focus:outline-none text-slate-300 text-lg leading-relaxed min-h-[200px] font-medium placeholder-slate-800"
                placeholder="Start your narrative..."
              />
              {isAiLoading && (
                <div className="absolute inset-0 bg-slate-950/20 backdrop-blur-[2px] flex items-center justify-center rounded-2xl">
                  <div className="bg-slate-900 border border-indigo-500/30 px-6 py-3 rounded-full flex items-center gap-3 shadow-2xl">
                    <div className="w-4 h-4 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
                    <span className="text-xs font-black uppercase tracking-widest text-indigo-400">Processing...</span>
                  </div>
                </div>
              )}
            </div>

            {activeNote.todos && activeNote.todos.length > 0 && (
              <div className="space-y-4 pt-4 border-t border-slate-800/50">
                <div className="flex items-center justify-between">
                  <h4 className="text-[10px] font-black uppercase tracking-widest text-indigo-400">Identified Tasks</h4>
                  <button onClick={() => handleUpdateNote({ todos: [] })} className="text-[8px] font-black text-slate-600 hover:text-rose-500 uppercase tracking-tighter">Clear All</button>
                </div>
                <div className="space-y-2">
                  {activeNote.todos.map(todo => (
                    <div key={todo.id} className="group flex items-center gap-3 bg-slate-900/40 p-3 rounded-xl border border-slate-800/60 hover:border-indigo-500/30 transition-all">
                      <button 
                        onClick={() => toggleTodo(todo.id)}
                        className={`w-6 h-6 rounded-lg border-2 flex items-center justify-center transition-all ${todo.completed ? 'bg-indigo-500 border-indigo-500' : 'border-slate-700'}`}
                      >
                        {todo.completed && <Icon name="check" className="w-4 h-4 text-white" />}
                      </button>
                      <div className="flex-1">
                        <p className={`text-sm font-medium ${todo.completed ? 'text-slate-500 line-through' : 'text-slate-200'}`}>{todo.text}</p>
                        <div className="flex items-center gap-2 mt-1">
                           <span className={`text-[8px] font-black uppercase px-1.5 py-0.5 rounded ${todo.priority === 'CRITICAL' ? 'bg-rose-500/20 text-rose-400' : 'bg-slate-800 text-slate-500'}`}>{todo.priority}</span>
                        </div>
                      </div>
                      <button onClick={() => removeTodo(todo.id)} className="opacity-0 group-hover:opacity-100 p-2 text-slate-600 hover:text-rose-500 transition-all">
                        <Icon name="trash" className="w-4 h-4" />
                      </button>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {activeNote.factCheck && (
              <div className="bg-slate-900/80 p-5 rounded-[2rem] border border-cyan-500/20 space-y-4 animate-in fade-in slide-in-from-bottom-2">
                <div className="flex items-center gap-2">
                  <Icon name="search" className="w-4 h-4 text-cyan-400" />
                  <h4 className="text-[10px] font-black uppercase text-cyan-400 tracking-widest">Grounded Verify</h4>
                </div>
                <p className="text-sm text-slate-300 leading-relaxed italic">{activeNote.factCheck.summary}</p>
                <div className="flex flex-wrap gap-2">
                  {activeNote.factCheck.sources.map((src, i) => (
                    <a key={i} href={src.uri} target="_blank" rel="noopener noreferrer" className="flex items-center gap-2 bg-slate-800/50 px-3 py-2 rounded-xl border border-slate-700 hover:bg-indigo-500/20 text-[10px] font-bold text-slate-400">
                      <Icon name="link" className="w-3 h-3" /> {src.title.slice(0, 15)}...
                    </a>
                  ))}
                </div>
              </div>
            )}

            {activeNote.imageUrl && (
              <div className="relative group rounded-[2.5rem] overflow-hidden border border-slate-800 bg-slate-950">
                <img src={activeNote.imageUrl} alt="Attached" className="w-full h-auto max-h-[400px] object-contain p-4" />
                <div className="absolute top-4 right-4 flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-all scale-95 group-hover:scale-100">
                  <button onClick={() => setView(AppView.IMAGE_EDIT)} className="p-3 bg-indigo-600 text-white rounded-2xl shadow-xl hover:scale-105 active:scale-90 transition-all"><Icon name="sparkle" className="w-5 h-5" /></button>
                  <button onClick={handleExtractText} className="p-3 bg-cyan-600 text-white rounded-2xl shadow-xl hover:scale-105 active:scale-90 transition-all"><Icon name="scan" className="w-5 h-5" /></button>
                  <button onClick={() => handleUpdateNote({ imageUrl: undefined })} className="p-3 bg-rose-600 text-white rounded-2xl shadow-xl hover:scale-105 active:scale-90 transition-all"><Icon name="trash" className="w-5 h-5" /></button>
                </div>
              </div>
            )}
            
            <div className="grid grid-cols-4 gap-2 pt-8 sticky bottom-0 bg-[#020617] pb-6 mt-auto">
               <label className="cursor-pointer">
                 <div className="bg-slate-900/50 hover:bg-slate-800 text-slate-300 h-14 rounded-2xl flex items-center justify-center gap-2 text-[10px] font-black border border-slate-800 active:scale-95 transition-all uppercase tracking-widest">
                   <Icon name="image" className="w-4 h-4" />
                 </div>
                 <input type="file" className="hidden" accept="image/*" onChange={(e) => {
                    const file = e.target.files?.[0];
                    if (file) {
                      const reader = new FileReader();
                      reader.onloadend = () => handleUpdateNote({ imageUrl: reader.result as string });
                      reader.readAsDataURL(file);
                    }
                 }} />
               </label>
               <button 
                 onClick={handleSmartClean}
                 disabled={isAiLoading}
                 className="bg-slate-900/50 hover:bg-slate-800 text-indigo-400 h-14 rounded-2xl flex items-center justify-center gap-2 text-[10px] font-black border border-slate-800 active:scale-95 transition-all uppercase tracking-widest disabled:opacity-50"
               >
                 <Icon name="list-check" className={`w-4 h-4 ${isAiLoading ? 'animate-pulse' : ''}`} />
               </button>
               <button 
                 onClick={handleFactCheck}
                 disabled={isAiLoading}
                 className="bg-slate-900/50 hover:bg-slate-800 text-cyan-400 h-14 rounded-2xl flex items-center justify-center gap-2 text-[10px] font-black border border-slate-800 active:scale-95 transition-all uppercase tracking-widest disabled:opacity-50"
               >
                 <Icon name="search" className={`w-4 h-4 ${isAiLoading ? 'animate-pulse' : ''}`} />
               </button>
               <button 
                 onClick={handleSmartRefine}
                 disabled={isAiLoading}
                 className="bg-indigo-600 hover:bg-indigo-500 text-white h-14 rounded-2xl flex items-center justify-center gap-2 text-[10px] font-black shadow-2xl shadow-indigo-500/20 active:scale-95 transition-all uppercase tracking-widest disabled:opacity-50"
               >
                 <Icon name="sparkle" className={`w-4 h-4 ${isAiLoading ? 'animate-spin' : ''}`} />
               </button>
            </div>
          </div>
        )}
      </main>

      {view === AppView.LIST && (
        <button 
          onClick={handleCreateNote}
          className="fixed bottom-10 right-8 w-20 h-20 bg-indigo-600 text-white rounded-[2.5rem] shadow-2xl flex items-center justify-center transform active:scale-90 transition-all z-40"
        >
          <Icon name="plus" className="w-10 h-10" />
        </button>
      )}

      {showChat && activeNote && (
        <div className="absolute inset-0 z-50 bg-slate-950/98 backdrop-blur-3xl flex flex-col animate-in slide-in-from-bottom duration-500">
           <div className="p-8 border-b border-slate-800 flex justify-between items-center bg-slate-900/40">
             <div>
               <h3 className="font-black text-indigo-400 tracking-tighter uppercase">Thought Co-Pilot</h3>
               <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">Deep Workspace Context</p>
             </div>
             <button onClick={() => setShowChat(false)} className="p-3 bg-slate-800 rounded-2xl hover:bg-slate-700 transition-all"><Icon name="back" className="w-5 h-5 rotate-270" /></button>
           </div>
           
           <div className="flex-1 overflow-y-auto p-8 space-y-6 no-scrollbar">
             {activeNote.chatHistory.map((msg, i) => (
               <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                 <div className={`max-w-[85%] px-5 py-4 rounded-[1.5rem] text-sm font-bold leading-relaxed shadow-xl ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-slate-900 border border-slate-800 text-slate-100 rounded-tl-none'}`}>
                   {msg.text}
                 </div>
               </div>
             ))}
             <div ref={chatEndRef} />
           </div>

           <div className="p-8 bg-slate-900/60 border-t border-slate-800/50">
             <div className="relative flex gap-3">
               <input 
                 value={chatInput}
                 onChange={(e) => setChatInput(e.target.value)}
                 onKeyDown={(e) => e.key === 'Enter' && handleSendChatMessage()}
                 placeholder="Ask your assistant..."
                 className="flex-1 bg-slate-950/50 border border-slate-800 rounded-2xl py-4 px-6 text-sm font-bold focus:ring-2 focus:ring-indigo-500/30"
               />
               <button onClick={handleSendChatMessage} className="bg-indigo-600 text-white w-14 h-14 rounded-2xl flex items-center justify-center shadow-2xl active:scale-90 transition-all">
                 <Icon name="send" className="w-6 h-6" />
               </button>
             </div>
           </div>
        </div>
      )}

      {view === AppView.EDITOR && (
        <button 
          onClick={() => setShowChat(true)}
          className="fixed bottom-24 right-8 w-14 h-14 bg-emerald-600 text-white rounded-2xl shadow-2xl flex items-center justify-center z-40 transform active:scale-90 transition-all"
        >
          <Icon name="chat" className="w-6 h-6" />
        </button>
      )}

      {view === AppView.VOICE_LIVE && (
        <VoiceLiveOverlay 
          agent={activeAgent || undefined}
          notesContext={activeAgent ? notes.filter(n => activeAgent.linkedNoteIds.includes(n.id)) : []}
          onClose={async (transcription) => {
            if (transcription) {
              setIsAiLoading(true);
              let finalContent = transcription;
              let newTodos: Todo[] = [];
              
              if (isAutoCorrectOn) {
                try {
                  finalContent = await autoCorrectAndRestructure(transcription);
                  const extracted = await extractTasks(finalContent);
                  newTodos = extracted.map(t => ({
                    id: Math.random().toString(),
                    text: t.text,
                    completed: false,
                    priority: t.priority as Priority
                  }));
                } catch (e) {
                  console.error("Auto-correct failed:", e);
                }
              }

              const newNote: Note = {
                id: Date.now().toString(),
                title: activeAgent ? `Decisions with ${activeAgent.name}` : 'Voice Session',
                content: finalContent,
                createdAt: Date.now(),
                updatedAt: Date.now(),
                tags: ['voice', activeAgent?.name || 'session'],
                todos: newTodos,
                chatHistory: [],
                category: 'Idea',
                vibeColor: activeAgent?.color || '#8b5cf6',
                status: 'TO_DO',
                priority: 'MEDIUM',
                epic: 'Brainstorm'
              };
              setNotes(prev => [newNote, ...prev]);
              setActiveNote(newNote);
              setIsAiLoading(false);
            }
            setView(AppView.EDITOR);
          }} 
        />
      )}

      {view === AppView.AGENT_BUILDER && (
        <AgentBuilderOverlay 
          initialAgent={editingAgent}
          availableNotes={notes}
          onSave={handleSaveAgent}
          onClose={() => setView(AppView.AGENTS)}
        />
      )}

      {view === AppView.IMAGE_EDIT && activeNote?.imageUrl && (
        <ImageEditorOverlay 
          initialImageUrl={activeNote.imageUrl}
          onSave={(newUrl) => {
            handleUpdateNote({ imageUrl: newUrl });
            setView(AppView.EDITOR);
          }}
          onClose={() => setView(AppView.EDITOR)}
        />
      )}
    </div>
  );
};

export default App;
