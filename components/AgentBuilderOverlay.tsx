
import React, { useState } from 'react';
import { VoiceAgent, Note } from '../types';
import { Icon } from './Icon';

interface AgentBuilderOverlayProps {
  initialAgent?: VoiceAgent;
  availableNotes: Note[];
  onSave: (agent: VoiceAgent) => void;
  onClose: () => void;
}

const AgentBuilderOverlay: React.FC<AgentBuilderOverlayProps> = ({ initialAgent, availableNotes, onSave, onClose }) => {
  const [name, setName] = useState(initialAgent?.name || '');
  const [rules, setRules] = useState(initialAgent?.rules || '');
  const [selectedNoteIds, setSelectedNoteIds] = useState<string[]>(initialAgent?.linkedNoteIds || []);
  const [color, setColor] = useState(initialAgent?.color || '#6366f1');

  const colors = ['#6366f1', '#10b981', '#f43f5e', '#f59e0b', '#8b5cf6', '#06b6d4'];

  const toggleNote = (id: string) => {
    setSelectedNoteIds(prev => 
      prev.includes(id) ? prev.filter(nid => nid !== id) : [...prev, id]
    );
  };

  const handleSave = () => {
    if (!name.trim()) return;
    onSave({
      id: initialAgent?.id || Date.now().toString(),
      name,
      rules,
      icon: 'sparkle',
      color,
      linkedNoteIds: selectedNoteIds,
      lastUsed: Date.now()
    });
  };

  return (
    <div className="fixed inset-0 z-50 bg-[#020617] flex flex-col p-6 overflow-y-auto no-scrollbar">
      <div className="flex justify-between items-center mb-8">
        <button onClick={onClose} className="p-3 bg-slate-900 rounded-2xl"><Icon name="back" /></button>
        <h2 className="text-xl font-black uppercase tracking-tighter italic text-indigo-100">Forge Agent</h2>
        <button onClick={handleSave} className="px-6 py-2.5 bg-indigo-600 rounded-xl font-black text-xs uppercase tracking-widest shadow-lg shadow-indigo-500/20">Save</button>
      </div>

      <div className="space-y-8 max-w-md mx-auto w-full">
        <div className="space-y-4">
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Identity</label>
          <input 
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Agent Name (e.g. Strategist)"
            className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 text-xl font-black focus:ring-2 focus:ring-indigo-500/50 outline-none"
          />
        </div>

        <div className="space-y-4">
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Agent Personality & Rules</label>
          <textarea 
            value={rules}
            onChange={(e) => setRules(e.target.value)}
            placeholder="How should this agent behave? (e.g. 'You are a decisive co-founder who prioritizes speed and scalability...')"
            className="w-full bg-slate-900 border border-slate-800 rounded-2xl p-4 h-40 font-medium text-slate-300 focus:ring-2 focus:ring-indigo-500/50 outline-none resize-none"
          />
        </div>

        <div className="space-y-4">
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Agent Vibe</label>
          <div className="flex gap-3">
            {colors.map(c => (
              <button 
                key={c}
                onClick={() => setColor(c)}
                className={`w-10 h-10 rounded-full transition-all ${color === c ? 'ring-4 ring-white ring-offset-4 ring-offset-[#020617] scale-110' : 'opacity-50'}`}
                style={{ backgroundColor: c }}
              />
            ))}
          </div>
        </div>

        <div className="space-y-4 pb-12">
          <label className="text-[10px] font-black text-slate-500 uppercase tracking-[0.2em]">Inject Knowledge Base ({selectedNoteIds.length})</label>
          <div className="space-y-2">
            {availableNotes.map(note => (
              <button 
                key={note.id}
                onClick={() => toggleNote(note.id)}
                className={`w-full flex items-center gap-4 p-4 rounded-2xl border transition-all text-left ${selectedNoteIds.includes(note.id) ? 'bg-indigo-600/10 border-indigo-500/50' : 'bg-slate-900/50 border-slate-800'}`}
              >
                <div className={`w-5 h-5 rounded-lg border-2 flex items-center justify-center ${selectedNoteIds.includes(note.id) ? 'bg-indigo-500 border-indigo-500' : 'border-slate-700'}`}>
                  {selectedNoteIds.includes(note.id) && <Icon name="check" className="w-3 h-3 text-white" />}
                </div>
                <div className="flex-1 overflow-hidden">
                  <p className="text-xs font-black truncate text-slate-200">{note.title || 'Untitled Note'}</p>
                  <p className="text-[10px] text-slate-500 font-bold uppercase tracking-tighter mt-0.5">{note.category}</p>
                </div>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default AgentBuilderOverlay;
