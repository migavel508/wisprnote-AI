
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { encodeAudio, decodeAudio, decodeAudioData } from './geminiService';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Icon } from './Icon';

interface VoiceLiveOverlayProps {
  onClose: (transcription: string) => void;
}

const VoiceLiveOverlay: React.FC<VoiceLiveOverlayProps> = ({ onClose }) => {
  const [isConnecting, setIsConnecting] = useState(true);
  const [isListening, setIsListening] = useState(false);
  const [transcription, setTranscription] = useState('');
  const [aiResponse, setAiResponse] = useState('');
  
  const audioContextRef = useRef<AudioContext | null>(null);
  const outputAudioContextRef = useRef<AudioContext | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const sessionRef = useRef<any>(null);
  const nextStartTimeRef = useRef(0);
  const sourcesRef = useRef<Set<AudioBufferSourceNode>>(new Set());

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      try { sessionRef.current.close(); } catch(e) {}
      sessionRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach(track => track.stop());
    }
    if (audioContextRef.current) audioContextRef.current.close();
    if (outputAudioContextRef.current) outputAudioContextRef.current.close();
    setIsListening(false);
  }, []);

  useEffect(() => {
    const startSession = async () => {
      try {
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        
        await audioContextRef.current.resume();
        await outputAudioContextRef.current.resume();

        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

        const sessionPromise = ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-12-2025',
          callbacks: {
            onopen: () => {
              setIsConnecting(false);
              setIsListening(true);
              
              const source = audioContextRef.current!.createMediaStreamSource(streamRef.current!);
              const scriptProcessor = audioContextRef.current!.createScriptProcessor(4096, 1, 1);
              
              scriptProcessor.onaudioprocess = (e) => {
                const inputData = e.inputBuffer.getChannelData(0);
                const l = inputData.length;
                const int16 = new Int16Array(l);
                for (let i = 0; i < l; i++) {
                  int16[i] = inputData[i] * 32768;
                }
                const pcmBlob = {
                  data: encodeAudio(new Uint8Array(int16.buffer)),
                  mimeType: 'audio/pcm;rate=16000',
                };
                
                sessionPromise.then(session => {
                  session.sendRealtimeInput({ media: pcmBlob });
                });
              };
              
              source.connect(scriptProcessor);
              scriptProcessor.connect(audioContextRef.current!.destination);
            },
            onmessage: async (message: LiveServerMessage) => {
              if (message.serverContent?.inputTranscription) {
                setTranscription(prev => prev + message.serverContent!.inputTranscription!.text);
              }
              if (message.serverContent?.outputTranscription) {
                setAiResponse(prev => prev + message.serverContent!.outputTranscription!.text);
              }

              const base64Audio = message.serverContent?.modelTurn?.parts[0]?.inlineData?.data;
              if (base64Audio && outputAudioContextRef.current) {
                const ctx = outputAudioContextRef.current;
                nextStartTimeRef.current = Math.max(nextStartTimeRef.current, ctx.currentTime);
                const audioBuffer = await decodeAudioData(decodeAudio(base64Audio), ctx, 24000, 1);
                const source = ctx.createBufferSource();
                source.buffer = audioBuffer;
                source.connect(ctx.destination);
                source.start(nextStartTimeRef.current);
                nextStartTimeRef.current += audioBuffer.duration;
                sourcesRef.current.add(source);
                source.onended = () => sourcesRef.current.delete(source);
              }

              if (message.serverContent?.interrupted) {
                sourcesRef.current.forEach(s => { try { s.stop(); } catch(e) {} });
                sourcesRef.current.clear();
                nextStartTimeRef.current = 0;
              }
            },
            onerror: (e) => {
              console.error('Live API Error:', e);
              setIsConnecting(false);
            },
            onclose: (e) => console.log('Live API Closed', e),
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: "You are Lumina, a real-time multilingual project assistant. Listen for a mix of Tamil and English. Transcribe BOTH languages accurately. Do not skip Tamil parts. If the user code-switches between Tamil and English, capture the flow verbatim. Be brief and supportive.",
          },
        });

        sessionRef.current = await sessionPromise;
      } catch (err) {
        console.error('Failed to start Live session:', err);
        setIsConnecting(false);
      }
    };

    startSession();
    return () => stopSession();
  }, [stopSession]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/98 flex flex-col items-center justify-between p-6 backdrop-blur-xl">
      <div className="w-full flex justify-between items-center px-2">
        <div>
          <h2 className="text-xl font-black text-indigo-400 uppercase tracking-tighter">Lumina Live</h2>
          <p className="text-[10px] text-slate-500 font-bold tracking-widest uppercase">Direct Neural Link Active</p>
        </div>
        <button onClick={() => onClose(transcription)} className="p-3 bg-slate-900 rounded-2xl hover:bg-slate-800 transition-colors border border-slate-800">
          <Icon name="back" className="w-5 h-5" />
        </button>
      </div>

      <div className="flex flex-col items-center justify-center flex-1 w-full space-y-12">
        <div className={`relative w-40 h-40 flex items-center justify-center ${isListening ? 'pulse-ring' : ''}`}>
           <div className="absolute inset-0 bg-indigo-500/10 rounded-full blur-[60px]"></div>
           <div className="relative p-10 bg-indigo-600 rounded-full shadow-[0_0_50px_rgba(79,70,229,0.4)]">
             <Icon name="mic" className="w-16 h-16 text-white" />
           </div>
        </div>

        <div className="w-full max-w-md bg-slate-900/50 border border-slate-800/80 rounded-[2.5rem] p-8 h-80 overflow-y-auto no-scrollbar space-y-6 shadow-inner relative">
           {isConnecting && (
             <div className="flex flex-col items-center justify-center h-full space-y-3">
               <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin"></div>
               <p className="text-slate-500 text-xs font-bold uppercase tracking-widest">Waking up Gemini...</p>
             </div>
           )}
           {!isConnecting && transcription.length === 0 && <p className="text-slate-500 text-center font-bold text-xs uppercase tracking-widest italic opacity-50">Listening to your thoughts (Tamil & English)...</p>}
           
           {transcription && (
             <div className="space-y-2 animate-in fade-in slide-in-from-bottom-2">
                <p className="text-[9px] font-black text-indigo-500 uppercase tracking-widest">Multilingual Transcription</p>
                <p className="text-slate-200 leading-relaxed text-base font-medium">{transcription}</p>
             </div>
           )}

           {aiResponse && (
             <div className="space-y-2 pt-4 border-t border-slate-800 animate-in fade-in">
                <p className="text-[9px] font-black text-emerald-500 uppercase tracking-widest">Lumina Response</p>
                <p className="text-slate-300 leading-relaxed text-sm italic font-medium">{aiResponse}</p>
             </div>
           )}
        </div>
      </div>

      <div className="w-full max-w-md space-y-4">
        <div className="flex items-center justify-center gap-3 py-2">
           <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
           <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Multilingual Neural Processing</span>
        </div>
        <button 
          onClick={() => onClose(transcription)}
          className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-5 rounded-[2rem] font-black text-sm uppercase tracking-widest shadow-2xl shadow-indigo-950 transition-all transform active:scale-[0.98]"
        >
          Finalize Capture
        </button>
      </div>
    </div>
  );
};

export default VoiceLiveOverlay;
