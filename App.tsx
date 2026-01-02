
import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Note, AppView, Todo, ChatMessage } from './types';
import { Icon } from './Icon';
import VoiceLiveOverlay from './VoiceLiveOverlay';
import ImageEditorOverlay from './ImageEditorOverlay';
import { summarizeNote, suggestMetadata, extractTasks, askAboutNote, extractTextFromImage } from './geminiService';

const App: React.FC = () => {
  const [view, setView] = useState<AppView>(AppView.LIST);
  const [notes, setNotes] = useState<Note[]>(() => {
    try {
      const saved = localStorage.getItem('lumina-notes-v2');
      return saved ? JSON.parse(saved) : [];
    } catch(e) { return []; }
  });
  const [activeNote, setActiveNote] = useState<Note | null>(null);
  const [searchTerm, setSearchTerm] = useState('');
  const [isAiLoading, setIsAiLoading] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [chatInput, setChatInput] = useState('');
  const chatEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    localStorage.setItem('lumina-notes-v2', JSON.stringify(notes));
  }, [notes]);

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
      chatHistory: []
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

  const handleDeleteNote = (id: string) => {
    setNotes(prev => prev.filter(n => n.id !== id));
    if (activeNote?.id === id) {
      setActiveNote(null);
      setView(AppView.LIST);
    }
  };

  const handleSmartRefine = async () => {
    if (!activeNote || !activeNote.content) return;
    setIsAiLoading(true);
    try {
      const meta = await suggestMetadata(activeNote.content);
      const tasks = await extractTasks(activeNote.content);
      const newTodos: Todo[] = tasks.map(t => ({ id: Math.random().toString(), text: t, completed: false }));
      handleUpdateNote({ 
        title: activeNote.title || meta.title, 
        tags: [...new Set([...activeNote.tags, ...meta.tags])],
        todos: [...activeNote.todos, ...newTodos]
      });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleExtractText = async () => {
    if (!activeNote?.imageUrl) return;
    setIsAiLoading(true);
    try {
      const text = await extractTextFromImage(activeNote.imageUrl);
      handleUpdateNote({ content: activeNote.content + "\n\n[Scanned Content]:\n" + text });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const handleSendChatMessage = async () => {
    if (!activeNote || !chatInput.trim()) return;
    const userMsg: ChatMessage = { role: 'user', text: chatInput };
    const newHistory = [...activeNote.chatHistory, userMsg];
    handleUpdateNote({ chatHistory: newHistory });
    setChatInput('');
    setIsAiLoading(true);

    try {
      const response = await askAboutNote(activeNote.content, chatInput, newHistory);
      const modelMsg: ChatMessage = { role: 'model', text: response };
      handleUpdateNote({ chatHistory: [...newHistory, modelMsg] });
    } catch (err) {
      console.error(err);
    } finally {
      setIsAiLoading(false);
    }
  };

  const toggleTodo = (todoId: string) => {
    if (!activeNote) return;
    const updatedTodos = activeNote.todos.map(t => t.id === todoId ? { ...t, completed: !t.completed } : t);
    handleUpdateNote({ todos: updatedTodos });
  };

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onloadend = () => handleUpdateNote({ imageUrl: reader.result as string });
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="flex flex-col h-screen bg-[#0f172a] text-slate-100 overflow-hidden max-w-lg mx-auto border-x border-slate-800 shadow-2xl relative">
      <header className="px-6 py-4 flex justify-between items-center border-b border-slate-800/50 bg-slate-900/40 backdrop-blur-xl sticky top-0 z-30 h-16">
        {view === AppView.LIST ? (
          <h1 className="text-xl font-black bg-gradient-to-r from-indigo-400 via-purple-400 to-cyan-400 bg-clip-text text-transparent tracking-tighter">LUMINA</h1>
        ) : (
          <button onClick={() => { setView(AppView.LIST); setShowChat(false); }} className="p-2 -ml-2 hover:bg-slate-800/50 rounded-full transition-colors">
            <Icon name="back" className="w-5 h-5" />
          </button>
        )}
        <div className="flex gap-2">
           {view === AppView.EDITOR && (
             <button onClick={() => setShowChat(!showChat)} className={`p-2 rounded-full transition-all ${showChat ? 'bg-indigo-600 text-white' : 'bg-slate-800 text-indigo-400'}`}>
               <Icon name="chat" className="w-5 h-5" />
             </button>
           )}
           <button onClick={() => setView(AppView.VOICE_LIVE)} className="p-2 bg-indigo-600/10 text-indigo-400 rounded-full hover:bg-indigo-600/20">
             <Icon name="mic" className="w-5 h-5" />
           </button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto no-scrollbar relative">
        {view === AppView.LIST && (
          <div className="p-6 space-y-6">
            <div className="relative group">
              <input 
                type="text" 
                placeholder="Search notes..." 
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)}
                className="w-full bg-slate-800/50 border border-slate-700/50 rounded-2xl py-3 px-12 focus:ring-2 focus:ring-indigo-500/50 text-sm transition-all"
              />
              <svg className="absolute left-4 top-3.5 w-5 h-5 text-slate-500" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" /></svg>
            </div>
            <div className="grid gap-4">
              {filteredNotes.map(note => (
                <div 
                  key={note.id}
                  onClick={() => { setActiveNote(note); setView(AppView.EDITOR); }}
                  className="group bg-slate-800/30 p-5 rounded-3xl border border-slate-700/30 hover:border-indigo-500/50 transition-all cursor-pointer flex gap-4 hover:translate-y-[-2px] active:scale-[0.98]"
                >
                  {note.imageUrl ? (
                    <img src={note.imageUrl} alt="" className="w-16 h-16 rounded-2xl object-cover bg-slate-700 shadow-lg" />
                  ) : (
                    <div className="w-16 h-16 rounded-2xl bg-indigo-600/10 flex items-center justify-center text-indigo-400 shadow-inner">
                      <Icon name="sparkle" className="w-6 h-6 opacity-40" />
                    </div>
                  )}
                  <div className="flex-1 min-w-0">
                    <h3 className="font-bold text-slate-100 text-sm truncate">{note.title || 'Untitled Thought'}</h3>
                    <p className="text-slate-400 text-xs line-clamp-1 mt-1 leading-relaxed">{note.content || 'Start writing...'}</p>
                    <div className="flex gap-1.5 mt-3">
                      {note.tags.map(tag => (
                        <span key={tag} className="text-[9px] px-2 py-0.5 rounded-full bg-slate-700/50 text-slate-300 font-bold uppercase tracking-wider">{tag}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {view === AppView.EDITOR && activeNote && (
          <div className="flex flex-col h-full p-6 space-y-6">
            <div className="space-y-2">
              <input 
                type="text" 
                value={activeNote.title}
                onChange={(e) => handleUpdateNote({ title: e.target.value })}
                className="w-full bg-transparent text-2xl font-black focus:outline-none placeholder-slate-800"
                placeholder="Title..."
              />
              <div className="flex flex-wrap gap-2">
                {activeNote.tags.map(tag => (
                  <span key={tag} className="text-[10px] bg-indigo-500/20 text-indigo-300 px-3 py-1 rounded-full font-bold border border-indigo-500/30">{tag}</span>
                ))}
              </div>
            </div>
            
            <textarea 
              value={activeNote.content}
              onChange={(e) => handleUpdateNote({ content: e.target.value })}
              className="w-full bg-transparent resize-none flex-1 focus:outline-none text-slate-300 text-sm leading-relaxed min-h-[150px]"
              placeholder="Your brilliance starts here..."
            />

            {activeNote.todos.length > 0 && (
              <div className="bg-slate-800/40 p-5 rounded-3xl border border-slate-700/30 space-y-3">
                <p className="text-[10px] font-black uppercase text-indigo-400 tracking-widest flex items-center gap-2">
                  <Icon name="list-check" className="w-3 h-3" /> Smart Tasks
                </p>
                {activeNote.todos.map(todo => (
                  <div key={todo.id} onClick={() => toggleTodo(todo.id)} className="flex items-center gap-3 cursor-pointer group">
                    <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center transition-all ${todo.completed ? 'bg-emerald-500 border-emerald-500' : 'border-slate-700 group-hover:border-indigo-500'}`}>
                      {todo.completed && <Icon name="check" className="w-3 h-3 text-white" />}
                    </div>
                    <span className={`text-sm ${todo.completed ? 'line-through text-slate-600' : 'text-slate-300'}`}>{todo.text}</span>
                  </div>
                ))}
              </div>
            )}

            {activeNote.imageUrl && (
              <div className="relative group rounded-3xl overflow-hidden border border-slate-800 shadow-2xl">
                <img src={activeNote.imageUrl} alt="Attached" className="w-full h-auto max-h-[300px] object-contain bg-slate-800/50 p-2" />
                <div className="absolute top-3 right-3 flex gap-2">
                  <button onClick={() => setView(AppView.IMAGE_EDIT)} className="p-2.5 bg-indigo-600 text-white rounded-2xl shadow-xl active:scale-90 transition-all"><Icon name="sparkle" className="w-4 h-4" /></button>
                  <button onClick={handleExtractText} className="p-2.5 bg-cyan-600 text-white rounded-2xl shadow-xl active:scale-90 transition-all"><Icon name="scan" className="w-4 h-4" /></button>
                  <button onClick={() => handleUpdateNote({ imageUrl: undefined })} className="p-2.5 bg-rose-600 text-white rounded-2xl shadow-xl active:scale-90 transition-all"><Icon name="trash" className="w-4 h-4" /></button>
                </div>
              </div>
            )}
            
            <div className="flex gap-3 pt-6 sticky bottom-0 bg-slate-900 pb-4 mt-auto">
               <label className="flex-1 cursor-pointer">
                 <div className="bg-slate-800 hover:bg-slate-750 text-slate-300 py-3.5 rounded-2xl flex items-center justify-center gap-2 text-xs font-black border border-slate-700/50 shadow-lg active:scale-95 transition-all">
                   <Icon name="image" className="w-4 h-4" />
                   ATTACH MEDIA
                 </div>
                 <input type="file" className="hidden" accept="image/*" onChange={handleFileUpload} />
               </label>
               <button 
                 onClick={handleSmartRefine}
                 disabled={isAiLoading}
                 className="flex-1 bg-indigo-600 hover:bg-indigo-500 text-white py-3.5 rounded-2xl flex items-center justify-center gap-2 text-xs font-black shadow-lg shadow-indigo-900/40 active:scale-95 transition-all disabled:opacity-50"
               >
                 <Icon name="sparkle" className={`w-4 h-4 ${isAiLoading ? 'animate-spin' : ''}`} />
                 AI REFINE
               </button>
            </div>
          </div>
        )}

        {/* AI Chat Drawer */}
        {showChat && activeNote && (
          <div className="absolute inset-x-0 bottom-0 top-0 z-40 bg-slate-900/95 backdrop-blur-xl flex flex-col animate-in slide-in-from-bottom duration-300">
            <div className="p-6 border-b border-slate-800 flex justify-between items-center">
              <div>
                <h3 className="font-black text-indigo-400">NOTE CO-PILOT</h3>
                <p className="text-[10px] text-slate-500 uppercase tracking-widest font-bold">In-context assistant</p>
              </div>
              <button onClick={() => setShowChat(false)} className="p-2 bg-slate-800 rounded-full"><Icon name="back" className="w-4 h-4 rotate-270" /></button>
            </div>
            
            <div className="flex-1 overflow-y-auto p-6 space-y-4 no-scrollbar">
              {activeNote.chatHistory.length === 0 && (
                <div className="text-center py-20 space-y-4">
                  <div className="inline-block p-4 bg-indigo-500/10 rounded-full"><Icon name="chat" className="w-8 h-8 text-indigo-400" /></div>
                  <p className="text-slate-500 text-xs font-bold leading-relaxed max-w-[200px] mx-auto">Ask anything about this specific note's content.</p>
                </div>
              )}
              {activeNote.chatHistory.map((msg, i) => (
                <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[85%] px-4 py-3 rounded-2xl text-sm font-medium ${msg.role === 'user' ? 'bg-indigo-600 text-white rounded-tr-none' : 'bg-slate-800 text-slate-200 rounded-tl-none'}`}>
                    {msg.text}
                  </div>
                </div>
              ))}
              {isAiLoading && (
                <div className="flex justify-start">
                  <div className="bg-slate-800 p-3 rounded-2xl rounded-tl-none animate-pulse">
                    <div className="flex gap-1">
                      <div className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce"></div>
                      <div className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce delay-100"></div>
                      <div className="w-1.5 h-1.5 bg-slate-600 rounded-full animate-bounce delay-200"></div>
                    </div>
                  </div>
                </div>
              )}
              <div ref={chatEndRef} />
            </div>

            <div className="p-6 bg-slate-900 border-t border-slate-800">
              <div className="relative flex gap-2">
                <input 
                  type="text" 
                  value={chatInput}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleSendChatMessage()}
                  placeholder="Ask a question..."
                  className="flex-1 bg-slate-800 border-none rounded-2xl py-3.5 px-5 text-sm focus:ring-2 focus:ring-indigo-500/50"
                />
                <button 
                  onClick={handleSendChatMessage}
                  className="bg-indigo-600 text-white w-12 h-12 rounded-2xl flex items-center justify-center shadow-lg active:scale-90 transition-all"
                >
                  <Icon name="send" className="w-5 h-5" />
                </button>
              </div>
            </div>
          </div>
        )}
      </main>

      {view === AppView.LIST && (
        <button 
          onClick={handleCreateNote}
          className="fixed bottom-8 right-8 w-16 h-16 bg-gradient-to-br from-indigo-600 to-purple-600 text-white rounded-[2rem] shadow-2xl shadow-indigo-500/30 flex items-center justify-center transform active:scale-90 transition-all z-40 hover:rotate-3"
        >
          <Icon name="plus" className="w-8 h-8" />
        </button>
      )}

      {view === AppView.VOICE_LIVE && (
        <VoiceLiveOverlay 
          onClose={(transcription) => {
            if (transcription) {
              if (activeNote) {
                handleUpdateNote({ content: (activeNote.content ? activeNote.content + "\n\n" : "") + transcription });
              } else {
                const newNote: Note = {
                  id: Date.now().toString(),
                  title: 'Voice Thought',
                  content: transcription,
                  createdAt: Date.now(),
                  updatedAt: Date.now(),
                  tags: ['voice'],
                  todos: [],
                  chatHistory: []
                };
                setNotes(prev => [newNote, ...prev]);
                setActiveNote(newNote);
              }
            }
            setView(activeNote ? AppView.EDITOR : AppView.LIST);
          }} 
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
