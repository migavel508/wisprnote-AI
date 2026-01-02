
import React, { useState } from 'react';
import { editImageWithGemini } from './geminiService';
import { Icon } from './Icon';

interface ImageEditorOverlayProps {
  initialImageUrl: string;
  onSave: (newImageUrl: string) => void;
  onClose: () => void;
}

const ImageEditorOverlay: React.FC<ImageEditorOverlayProps> = ({ initialImageUrl, onSave, onClose }) => {
  const [prompt, setPrompt] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [currentImageUrl, setCurrentImageUrl] = useState(initialImageUrl);
  const [error, setError] = useState('');

  const handleEdit = async () => {
    if (!prompt.trim()) return;
    setIsGenerating(true);
    setError('');
    try {
      const editedUrl = await editImageWithGemini(currentImageUrl, prompt);
      setCurrentImageUrl(editedUrl);
      setPrompt('');
    } catch (err: any) {
      setError(err.message || 'Editing failed. Try another prompt.');
      console.error(err);
    } finally {
      setIsGenerating(false);
    }
  };

  const suggestions = ["Vintage", "Watercolor", "Neon Glow", "Cyberpunk", "Black and White"];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900 flex flex-col p-4 animate-in fade-in duration-300">
      <div className="flex justify-between items-center mb-4">
        <button onClick={onClose} className="p-2 text-slate-400 hover:text-white transition-colors">
          <Icon name="back" />
        </button>
        <h2 className="text-lg font-bold tracking-tight">AI Image Refiner</h2>
        <button 
          onClick={() => onSave(currentImageUrl)} 
          className="bg-emerald-600 hover:bg-emerald-500 text-white px-5 py-2 rounded-xl text-sm font-bold shadow-lg shadow-emerald-900/20 transition-all active:scale-95"
        >
          Keep
        </button>
      </div>

      <div className="flex-1 flex flex-col gap-4 overflow-hidden">
        <div className="flex-1 bg-slate-800 rounded-3xl overflow-hidden relative border border-slate-700/50 shadow-inner">
          <img src={currentImageUrl} alt="Preview" className="w-full h-full object-contain p-2" />
          {isGenerating && (
            <div className="absolute inset-0 bg-slate-900/80 backdrop-blur-sm flex flex-col items-center justify-center">
              <div className="w-12 h-12 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
              <p className="text-indigo-400 text-sm font-medium animate-pulse">Lumina is reimagining...</p>
            </div>
          )}
        </div>

        <div className="bg-slate-800/80 backdrop-blur-md p-5 rounded-3xl border border-slate-700/50 space-y-4">
          <div className="space-y-2">
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="Tell Lumina what to change..."
              className="w-full bg-slate-900 border border-slate-700 rounded-2xl p-4 text-white text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500/50 h-28 resize-none transition-all"
            />
            {error && (
              <div className="bg-rose-500/10 border border-rose-500/20 p-3 rounded-xl">
                <p className="text-rose-400 text-xs leading-relaxed">{error}</p>
              </div>
            )}
          </div>

          <button
            onClick={handleEdit}
            disabled={isGenerating || !prompt.trim()}
            className="w-full bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-white py-4 rounded-2xl font-bold text-sm transition-all shadow-xl shadow-indigo-900/20 active:scale-[0.98]"
          >
            Refine Image
          </button>
          
          <div className="flex flex-wrap gap-2 pt-2">
            {suggestions.map((s, idx) => (
              <button 
                key={idx} 
                onClick={() => setPrompt(s)} 
                className="bg-slate-900 text-slate-400 text-[10px] px-4 py-2 rounded-full border border-slate-700 uppercase font-bold tracking-widest hover:text-indigo-400 hover:border-indigo-400/50 transition-all"
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageEditorOverlay;
