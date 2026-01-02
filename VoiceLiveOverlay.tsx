
import React, { useEffect, useRef, useState, useCallback } from 'react';
// Fixed: Removed getAI as it is not exported from geminiService.ts
import { encodeAudio, decodeAudio, decodeAudioData } from './geminiService';
// Fixed: Added GoogleGenAI to imports to follow guidelines and avoid dynamic imports
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
        // Fixed: Initialized GoogleGenAI using the standard import and named parameter with process.env.API_KEY
        const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
        audioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 16000 });
        outputAudioContextRef.current = new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: 24000 });
        
        await audioContextRef.current.resume();
        await outputAudioContextRef.current.resume();

        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

        const sessionPromise = ai.live.connect({
          model: 'gemini-2.5-flash-native-audio-preview-09-2025',
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
            onerror: (e) => console.error('Live API Error:', e),
            onclose: (e) => console.log('Live API Closed', e),
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction: "You are a helpful AI note-taking assistant. Listen and respond to help the user brainstorm or record ideas.",
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
    <div className="fixed inset-0 z-50 bg-slate-900/95 flex flex-col items-center justify-between p-6 backdrop-blur-md">
      <div className="w-full flex justify-between items-center">
        <h2 className="text-xl font-bold text-indigo-400">AI Voice Assistant</h2>
        <button onClick={() => onClose(transcription)} className="p-2 bg-slate-800 rounded-full hover:bg-slate-700 transition-colors">
          <Icon name="back" className="w-6 h-6" />
        </button>
      </div>
      <div className="flex flex-col items-center justify-center flex-1 w-full space-y-12">
        <div className={`relative w-32 h-32 flex items-center justify-center ${isListening ? 'pulse-ring' : ''}`}>
           <div className="absolute inset-0 bg-indigo-500/20 rounded-full blur-2xl"></div>
           <div className="relative p-8 bg-indigo-600 rounded-full shadow-2xl shadow-indigo-500/50">
             <Icon name="mic" className="w-12 h-12 text-white" />
           </div>
        </div>
        <div className="w-full max-w-md bg-slate-800/50 border border-slate-700/50 rounded-2xl p-6 h-64 overflow-y-auto no-scrollbar space-y-4">
           {isConnecting && <p className="text-slate-400 animate-pulse text-center font-medium">Connecting to Gemini...</p>}
           {!isConnecting && transcription.length === 0 && <p className="text-slate-400 text-center">I'm listening. Speak freely...</p>}
           {transcription && (
             <div className="space-y-1">
                <p className="text-[10px] font-bold text-indigo-400 uppercase tracking-widest">You</p>
                <p className="text-slate-200 leading-relaxed text-sm">{transcription}</p>
             </div>
           )}
           {aiResponse && (
             <div className="space-y-1 pt-3 border-t border-slate-700/50">
                <p className="text-[10px] font-bold text-emerald-400 uppercase tracking-widest">Lumina</p>
                <p className="text-slate-200 leading-relaxed text-sm italic">{aiResponse}</p>
             </div>
           )}
        </div>
      </div>
      <button onClick={() => onClose(transcription)} className="w-full bg-indigo-600 hover:bg-indigo-500 text-white py-4 rounded-xl font-bold shadow-xl shadow-indigo-900/40 transition-all transform active:scale-95">
        Save & Close
      </button>
    </div>
  );
};

export default VoiceLiveOverlay;
