import React, { useState, useRef } from 'react';
import { 
  Upload, 
  FileAudio, 
  CheckCircle2, 
  Loader2, 
  AlertCircle, 
  ChevronRight,
  Play,
  Layers,
  Clock,
  FileText
} from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import Markdown from 'react-markdown';
import { splitAudio, AudioBatch } from './services/audioService';
import { processAudioBatch, ProcessResult } from './services/geminiService';

type Status = 'idle' | 'splitting' | 'processing' | 'completed' | 'error';

interface BatchStatus extends AudioBatch {
  status: 'pending' | 'processing' | 'completed' | 'error';
  result?: string;
  error?: string;
}

export default function App() {
  const [file, setFile] = useState<File | null>(null);
  const [status, setStatus] = useState<Status>('idle');
  const [batches, setBatches] = useState<BatchStatus[]>([]);
  const [prompt, setPrompt] = useState('Please provide a detailed transcription of this audio.');
  const [error, setError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

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
      
      // Split audio into batches (max 15MB each to stay safe under 20MB limit)
      const audioBatches = await splitAudio(file, 15);
      
      const initialBatches: BatchStatus[] = audioBatches.map(b => ({
        ...b,
        status: 'pending'
      }));
      
      setBatches(initialBatches);
      setStatus('processing');

      // Process batches sequentially to avoid hitting rate limits too hard
      const results: BatchStatus[] = [...initialBatches];
      
      for (let i = 0; i < results.length; i++) {
        results[i].status = 'processing';
        setBatches([...results]);

        try {
          const result = await processAudioBatch(results[i], prompt);
          results[i].status = 'completed';
          results[i].result = result.text;
        } catch (err: any) {
          console.error(`Error processing batch ${i}:`, err);
          results[i].status = 'error';
          results[i].error = err.message || 'Unknown error';
        }
        
        setBatches([...results]);
      }

      setStatus('completed');
    } catch (err: any) {
      console.error('Processing failed:', err);
      setError(err.message || 'Failed to process audio. Make sure the file is a valid audio format.');
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

  return (
    <div className="min-h-screen bg-[#E4E3E0] text-[#141414] font-sans selection:bg-[#141414] selection:text-[#E4E3E0]">
      {/* Header */}
      <header className="border-b border-[#141414] p-6 flex justify-between items-center">
        <div className="flex items-center gap-3">
          <Layers className="w-8 h-8" />
          <h1 className="text-2xl font-bold tracking-tight uppercase">AudioBatch AI</h1>
        </div>
        <div className="text-xs font-mono opacity-50 uppercase tracking-widest">
          Status: {status}
        </div>
      </header>

      <main className="max-w-6xl mx-auto p-6 grid grid-cols-1 lg:grid-cols-12 gap-8">
        {/* Left Column: Controls & Batches */}
        <div className="lg:col-span-5 space-y-6">
          {/* Upload Section */}
          <section className="border border-[#141414] p-6 bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)]">
            <h2 className="font-serif italic text-sm uppercase opacity-50 mb-4 tracking-wider">01. Input Configuration</h2>
            
            <div 
              onClick={() => fileInputRef.current?.click()}
              className={`border-2 border-dashed border-[#141414]/20 p-8 text-center cursor-pointer hover:bg-[#F5F5F5] transition-colors mb-4 ${file ? 'bg-[#F5F5F5]' : ''}`}
            >
              <input 
                type="file" 
                ref={fileInputRef} 
                onChange={handleFileChange} 
                className="hidden" 
                accept="audio/*"
              />
              {file ? (
                <div className="flex flex-col items-center gap-2">
                  <FileAudio className="w-10 h-10 mb-2" />
                  <span className="font-mono text-sm font-bold">{file.name}</span>
                  <span className="text-xs opacity-50">{(file.size / (1024 * 1024)).toFixed(2)} MB</span>
                </div>
              ) : (
                <div className="flex flex-col items-center gap-2">
                  <Upload className="w-10 h-10 mb-2 opacity-30" />
                  <span className="text-sm font-medium">Click or drag audio file to upload</span>
                  <span className="text-xs opacity-50">Supports MP3, M4A, WAV, etc.</span>
                </div>
              )}
            </div>

            <div className="space-y-2">
              <label className="text-[10px] font-mono uppercase opacity-50">Instruction / Prompt</label>
              <textarea 
                value={prompt}
                onChange={(e) => setPrompt(e.target.value)}
                className="w-full border border-[#141414] p-3 text-sm font-mono focus:outline-none focus:ring-1 focus:ring-[#141414] resize-none h-24"
                placeholder="What should the AI do with this audio?"
              />
            </div>

            <button 
              onClick={startProcessing}
              disabled={!file || status === 'processing' || status === 'splitting'}
              className="w-full mt-6 bg-[#141414] text-[#E4E3E0] py-4 font-bold uppercase tracking-widest hover:bg-[#333] disabled:opacity-30 disabled:cursor-not-allowed transition-all flex items-center justify-center gap-2"
            >
              {(status === 'processing' || status === 'splitting') ? (
                <>
                  <Loader2 className="w-5 h-5 animate-spin" />
                  Processing...
                </>
              ) : (
                <>
                  <Play className="w-5 h-5 fill-current" />
                  Start Batch Process
                </>
              )}
            </button>

            {error && (
              <div className="mt-4 p-3 bg-red-50 border border-red-200 text-red-600 text-xs flex items-center gap-2">
                <AlertCircle className="w-4 h-4 shrink-0" />
                {error}
              </div>
            )}
          </section>

          {/* Batch List */}
          <AnimatePresence>
            {batches.length > 0 && (
              <motion.section 
                initial={{ opacity: 0, y: 20 }}
                animate={{ opacity: 1, y: 0 }}
                className="border border-[#141414] bg-white shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] overflow-hidden"
              >
                <div className="p-4 border-b border-[#141414] bg-[#141414] text-[#E4E3E0] flex justify-between items-center">
                  <h2 className="font-serif italic text-sm uppercase tracking-wider">02. Batch Queue</h2>
                  <span className="font-mono text-[10px]">{Math.round(totalProgress)}% Complete</span>
                </div>
                
                <div className="max-h-[400px] overflow-y-auto">
                  {batches.map((batch, idx) => (
                    <div 
                      key={idx} 
                      className={`p-4 border-b border-[#141414]/10 flex items-center justify-between hover:bg-[#F9F9F9] transition-colors ${batch.status === 'processing' ? 'bg-[#F9F9F9]' : ''}`}
                    >
                      <div className="flex items-center gap-3">
                        <div className={`w-8 h-8 rounded-full border border-[#141414] flex items-center justify-center text-xs font-mono ${batch.status === 'completed' ? 'bg-[#141414] text-[#E4E3E0]' : ''}`}>
                          {idx + 1}
                        </div>
                        <div>
                          <div className="text-xs font-bold font-mono">Batch {idx + 1}</div>
                          <div className="text-[10px] opacity-50 flex items-center gap-1">
                            <Clock className="w-3 h-3" />
                            {Math.floor(batch.startTime)}s - {Math.floor(batch.endTime)}s
                          </div>
                        </div>
                      </div>
                      
                      <div>
                        {batch.status === 'pending' && <div className="w-2 h-2 rounded-full bg-[#141414]/20" />}
                        {batch.status === 'processing' && <Loader2 className="w-4 h-4 animate-spin opacity-50" />}
                        {batch.status === 'completed' && <CheckCircle2 className="w-4 h-4 text-green-600" />}
                        {batch.status === 'error' && <AlertCircle className="w-4 h-4 text-red-600" />}
                      </div>
                    </div>
                  ))}
                </div>
              </motion.section>
            )}
          </AnimatePresence>
        </div>

        {/* Right Column: Results */}
        <div className="lg:col-span-7">
          <section className="border border-[#141414] bg-white h-full min-h-[600px] shadow-[4px_4px_0px_0px_rgba(20,20,20,1)] flex flex-col">
            <div className="p-4 border-b border-[#141414] flex justify-between items-center bg-[#F5F5F5]">
              <div className="flex items-center gap-2">
                <FileText className="w-5 h-5" />
                <h2 className="font-serif italic text-sm uppercase tracking-wider">03. Output Analysis</h2>
              </div>
              <div className="flex items-center gap-4">
                {status === 'processing' && (
                  <div className="flex items-center gap-2 text-[10px] font-mono animate-pulse">
                    <span className="w-2 h-2 rounded-full bg-blue-500" />
                    Synthesizing...
                  </div>
                )}
                {status === 'completed' && (
                  <button 
                    onClick={() => {
                      navigator.clipboard.writeText(combinedResult);
                      alert('Copied to clipboard!');
                    }}
                    className="text-[10px] font-mono uppercase underline hover:no-underline"
                  >
                    Copy All
                  </button>
                )}
              </div>
            </div>

            <div className="flex-1 p-8 overflow-y-auto prose prose-sm max-w-none prose-headings:font-serif prose-headings:italic prose-p:font-sans prose-p:leading-relaxed">
              {status === 'idle' && !file && (
                <div className="h-full flex flex-col items-center justify-center opacity-20 grayscale">
                  <FileText className="w-20 h-20 mb-4" />
                  <p className="font-serif italic text-lg">Waiting for input...</p>
                </div>
              )}

              {status === 'splitting' && (
                <div className="h-full flex flex-col items-center justify-center">
                  <Loader2 className="w-10 h-10 animate-spin mb-4" />
                  <p className="font-mono text-xs uppercase tracking-widest">Decoding & Splitting Audio...</p>
                  <p className="text-[10px] opacity-50 mt-2">Preparing batches for processing</p>
                </div>
              )}

              {batches.length > 0 && (
                <div className="space-y-8">
                  {batches.map((batch, idx) => (
                    <div key={idx} className={batch.status === 'completed' ? 'opacity-100' : 'opacity-30'}>
                      <div className="flex items-center gap-2 mb-4">
                        <span className="text-[10px] font-mono bg-[#141414] text-[#E4E3E0] px-2 py-0.5">BATCH {idx + 1}</span>
                        <span className="text-[10px] font-mono opacity-50">{Math.floor(batch.startTime)}s - {Math.floor(batch.endTime)}s</span>
                      </div>
                      {batch.status === 'completed' ? (
                        <div className="markdown-body">
                          <Markdown>{batch.result}</Markdown>
                        </div>
                      ) : batch.status === 'processing' ? (
                        <div className="space-y-2">
                          <div className="h-4 bg-[#141414]/5 w-full animate-pulse" />
                          <div className="h-4 bg-[#141414]/5 w-3/4 animate-pulse" />
                          <div className="h-4 bg-[#141414]/5 w-5/6 animate-pulse" />
                        </div>
                      ) : batch.status === 'error' ? (
                        <div className="text-red-500 text-xs font-mono italic">
                          Error: {batch.error}
                        </div>
                      ) : (
                        <div className="text-[10px] font-mono opacity-30 italic">Pending processing...</div>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>
        </div>
      </main>

      {/* Footer */}
      <footer className="mt-12 border-t border-[#141414] p-6 text-center">
        <p className="text-[10px] font-mono uppercase opacity-50 tracking-widest">
          Built with Gemini 3.1 & Web Audio API • No file size limits
        </p>
      </footer>
    </div>
  );
}
