
import React, { useState } from 'react';
import { editImageWithGemini } from '../services/geminiService';
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
    } catch (err) {
      setError('Editing failed. Please try a different prompt.');
      console.error(err);
    } finally {
      setIsGenerating(false);
    }
  };

  const suggestions = [
    "Add a retro vintage filter",
    "Change the background to a sunset",
    "Convert this to a watercolor painting",
    "Make it black and white",
    "Add a futuristic cyberpunk neon glow"
  ];

  return (
    <div className="fixed inset-0 z-50 bg-slate-900/98 flex flex-col p-4 md:p-8">
      <div className="flex justify-between items-center mb-6">
        <button onClick={onClose} className="p-2 text-slate-400 hover:text-white">
          <Icon name="back" className="w-8 h-8" />
        </button>
        <h2 className="text-xl font-bold text-white">AI Image Refiner</h2>
        <button 
          onClick={() => onSave(currentImageUrl)}
          className="bg-emerald-600 text-white px-4 py-2 rounded-lg font-semibold flex items-center gap-2"
        >
          <Icon name="check" className="w-5 h-5" />
          Keep
        </button>
      </div>

      <div className="flex-1 flex flex-col md:flex-row gap-8 overflow-hidden">
        <div className="flex-1 bg-slate-800 rounded-3xl overflow-hidden relative group">
          <img src={currentImageUrl} alt="Preview" className="w-full h-full object-contain" />
          {isGenerating && (
            <div className="absolute inset-0 bg-slate-900/60 backdrop-blur-sm flex flex-col items-center justify-center">
              <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin mb-4"></div>
              <p className="text-indigo-400 font-medium animate-pulse">Lumina is reimagining your image...</p>
            </div>
          )}
        </div>

        <div className="w-full md:w-96 flex flex-col gap-4">
          <div className="bg-slate-800 p-4 rounded-2xl border border-slate-700">
            <label className="text-xs font-bold text-slate-500 uppercase mb-2 block">Instruction for AI</label>
            <textarea
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="e.g. 'Add a retro filter' or 'Convert to 3D art'"
              className="w-full bg-slate-900 border border-slate-700 rounded-xl p-3 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500 h-32 resize-none"
            />
            <button
              onClick={handleEdit}
              disabled={isGenerating || !prompt.trim()}
              className="w-full mt-4 bg-indigo-600 hover:bg-indigo-500 disabled:bg-slate-700 text-white py-3 rounded-xl font-bold transition-colors flex items-center justify-center gap-2"
            >
              <Icon name="sparkle" className="w-5 h-5" />
              Refine Image
            </button>
            {error && <p className="text-rose-500 text-xs mt-2">{error}</p>}
          </div>

          <div className="flex flex-col gap-2">
            <p className="text-xs font-bold text-slate-500 uppercase px-2">Suggestions</p>
            <div className="flex flex-wrap gap-2">
              {suggestions.map((s, idx) => (
                <button
                  key={idx}
                  onClick={() => setPrompt(s)}
                  className="bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs px-3 py-2 rounded-full border border-slate-700 transition-colors"
                >
                  {s}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ImageEditorOverlay;
