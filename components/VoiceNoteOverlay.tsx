
import React, { useState, useRef, useEffect } from 'react';
import { Icon } from './Icon';
import { processAudioFile } from '../services/geminiService';

interface VoiceNoteOverlayProps {
  onComplete: (data: { transcription: string, summary: string, todos: any[] }) => void;
  onClose: () => void;
}

const VoiceNoteOverlay: React.FC<VoiceNoteOverlayProps> = ({ onComplete, onClose }) => {
  const [isRecording, setIsRecording] = useState(false);
  const [duration, setDuration] = useState(0);
  const [isProcessing, setIsProcessing] = useState(false);
  
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const animationFrameRef = useRef<number | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const startRecording = async () => {
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const recorder = new MediaRecorder(stream);
      mediaRecorderRef.current = recorder;
      chunksRef.current = [];

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      recorder.onstop = async () => {
        setIsProcessing(true);
        const audioBlob = new Blob(chunksRef.current, { type: 'audio/webm' });
        const reader = new FileReader();
        reader.onloadend = async () => {
          const base64 = (reader.result as string).split(',')[1];
          try {
            const result = await processAudioFile(base64, 'audio/webm');
            onComplete(result);
          } catch (err) {
            console.error(err);
            alert("Failed to process your voice note.");
          } finally {
            setIsProcessing(false);
          }
        };
        reader.readAsDataURL(audioBlob);
        stream.getTracks().forEach(t => t.stop());
      };

      recorder.start();
      setIsRecording(true);
      
      // Start Timer
      timerRef.current = window.setInterval(() => {
        setDuration(prev => prev + 1);
      }, 1000);

      // Start Visualizer
      setupVisualizer(stream);

    } catch (err) {
      console.error(err);
      alert("Microphone access denied.");
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current) {
      mediaRecorderRef.current.stop();
    }
    setIsRecording(false);
    if (timerRef.current) clearInterval(timerRef.current);
    if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
  };

  const setupVisualizer = (stream: MediaStream) => {
    const audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
    const analyser = audioContext.createAnalyser();
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    analyser.fftSize = 256;
    analyserRef.current = analyser;
    audioContextRef.current = audioContext;

    const bufferLength = analyser.frequencyBinCount;
    const dataArray = new Uint8Array(bufferLength);
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      animationFrameRef.current = requestAnimationFrame(draw);
      analyser.getByteFrequencyData(dataArray);
      
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      const barWidth = (canvas.width / bufferLength) * 2.5;
      let x = 0;

      for (let i = 0; i < bufferLength; i++) {
        const barHeight = (dataArray[i] / 255) * canvas.height;
        ctx.fillStyle = `rgba(99, 102, 241, ${dataArray[i] / 255})`;
        ctx.fillRect(x, canvas.height - barHeight, barWidth, barHeight);
        x += barWidth + 1;
      }
    };
    draw();
  };

  const formatDuration = (seconds: number) => {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
  };

  useEffect(() => {
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      if (audioContextRef.current) audioContextRef.current.close();
    };
  }, []);

  return (
    <div className="fixed inset-0 z-[70] bg-[#020617]/95 backdrop-blur-3xl flex flex-col p-8 items-center justify-between">
      <div className="w-full flex justify-between items-center">
        <div>
          <h2 className="text-xl font-black text-white uppercase tracking-tighter">Voice Note</h2>
          <p className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">High Fidelity Dictation</p>
        </div>
        {!isProcessing && (
          <button onClick={onClose} className="p-3 bg-slate-900 rounded-2xl border border-slate-800">
            <Icon name="back" className="w-5 h-5" />
          </button>
        )}
      </div>

      <div className="flex-1 w-full flex flex-col items-center justify-center space-y-12">
        <canvas ref={canvasRef} className="w-full h-32 opacity-50" width={600} height={200} />
        
        <div className="text-center space-y-2">
          <p className="text-5xl font-black text-white tracking-tighter tabular-nums">{formatDuration(duration)}</p>
          <p className={`text-[10px] font-black uppercase tracking-[0.2em] ${isRecording ? 'text-rose-500 animate-pulse' : 'text-slate-500'}`}>
            {isRecording ? 'Capturing Neural Audio' : 'Ready to Dictate'}
          </p>
        </div>

        <button 
          onClick={isRecording ? stopRecording : startRecording}
          disabled={isProcessing}
          className={`w-32 h-32 rounded-full flex items-center justify-center transition-all transform active:scale-90 shadow-2xl ${isRecording ? 'bg-rose-600 shadow-rose-900/40' : 'bg-indigo-600 shadow-indigo-900/40'} ${isProcessing ? 'opacity-50 scale-95' : 'hover:scale-105'}`}
        >
          {isProcessing ? (
            <div className="w-8 h-8 border-4 border-white border-t-transparent rounded-full animate-spin"></div>
          ) : (
            <Icon name={isRecording ? 'check' : 'mic'} className="w-12 h-12 text-white" />
          )}
        </button>
      </div>

      <div className="w-full max-w-sm bg-slate-900/40 p-6 rounded-[2rem] border border-slate-800/60 text-center space-y-2">
        <p className="text-[10px] font-black text-indigo-400 uppercase tracking-widest">Multilingual Mode Active</p>
        <p className="text-xs text-slate-500 font-medium">Lumina will transcribe English and Tamil verbatim and extract all tasks automatically.</p>
      </div>

      {isProcessing && (
        <div className="absolute inset-0 z-10 bg-slate-950/80 backdrop-blur-md flex flex-col items-center justify-center space-y-4">
           <div className="w-16 h-16 border-4 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
           <p className="text-indigo-400 font-black uppercase tracking-widest text-xs animate-pulse">Deep Neural Processing...</p>
        </div>
      )}
    </div>
  );
};

export default VoiceNoteOverlay;
