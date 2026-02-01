
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { encodeAudio, decodeAudio, decodeAudioData } from '../services/geminiService';
import { GoogleGenAI, Modality, LiveServerMessage } from '@google/genai';
import { Icon } from './Icon';
import { VoiceAgent, Note } from '../types';

interface VoiceLiveOverlayProps {
  agent?: VoiceAgent;
  notesContext?: Note[];
  onClose: (transcription: string) => void;
}

const VoiceLiveOverlay: React.FC<VoiceLiveOverlayProps> = ({ agent, notesContext, onClose }) => {
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

  const currentInputTranscription = useRef('');
  const currentOutputTranscription = useRef('');

  const stopSession = useCallback(() => {
    if (sessionRef.current) {
      sessionRef.current.close();
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
        streamRef.current = await navigator.mediaDevices.getUserMedia({ audio: true });

        // Build the system instruction from Agent rules and linked notes
        const knowledgeBase = notesContext?.map(n => `NOTE: ${n.title}\nCONTENT: ${n.content}`).join('\n\n') || "No prior notes linked.";
        const systemInstruction = `
          PERSONALITY & RULES:
          ${agent?.rules || "You are Lumina, a generic AI co-founder. Be helpful and decisive."}

          YOUR KNOWLEDGE BASE (CONTEXT):
          ${knowledgeBase}

          GOAL: Brainstorm and make decisive decisions. Refer to specific notes in your knowledge base when relevant. Speak naturally and concisely.
        `;

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
                for (let i = 0; i < l; i++) int16[i] = inputData[i] * 32768;
                const pcmBlob = { data: encodeAudio(new Uint8Array(int16.buffer)), mimeType: 'audio/pcm;rate=16000' };
                sessionPromise.then(session => session.sendRealtimeInput({ media: pcmBlob }));
              };
              source.connect(scriptProcessor);
              scriptProcessor.connect(audioContextRef.current!.destination);
            },
            onmessage: async (message: LiveServerMessage) => {
              if (message.serverContent?.inputTranscription) {
                currentInputTranscription.current += message.serverContent.inputTranscription.text;
                setTranscription(prev => prev + message.serverContent!.inputTranscription!.text);
              }
              if (message.serverContent?.outputTranscription) {
                currentOutputTranscription.current += message.serverContent.outputTranscription.text;
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
            onclose: () => console.log('Live API Closed'),
          },
          config: {
            responseModalities: [Modality.AUDIO],
            speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Charon' } } }, // Deeper co-founder voice
            inputAudioTranscription: {},
            outputAudioTranscription: {},
            systemInstruction,
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
  }, [stopSession, agent, notesContext]);

  return (
    <div className="fixed inset-0 z-50 bg-[#020617]/95 flex flex-col items-center justify-between p-6 backdrop-blur-2xl">
      <div className="w-full flex justify-between items-center px-2">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center" style={{ backgroundColor: agent?.color || '#4f46e5' }}>
            <Icon name="sparkle" className="text-white w-6 h-6" />
          </div>
          <div>
            <h2 className="text-xl font-black text-white uppercase tracking-tighter">{agent?.name || 'Lumina Assistant'}</h2>
            <p className="text-[10px] text-slate-500 font-black tracking-widest uppercase">Decisive Co-Founder Protocol</p>
          </div>
        </div>
        <button onClick={() => onClose(transcription)} className="p-3 bg-slate-900 rounded-2xl hover:bg-slate-800 transition-all border border-slate-800">
          <Icon name="back" className="w-5 h-5" />
        </button>
      </div>

      <div className="flex flex-col items-center justify-center flex-1 w-full space-y-12">
        <div className={`relative w-40 h-40 flex items-center justify-center ${isListening ? 'pulse-ring' : ''}`}>
           <div className="absolute inset-0 bg-indigo-500/10 rounded-full blur-[60px]"></div>
           <div className="relative p-10 rounded-full shadow-2xl transition-all" style={{ backgroundColor: agent?.color || '#4f46e5' }}>
             <Icon name="mic" className="w-16 h-16 text-white" />
           </div>
        </div>

        <div className="w-full max-w-md bg-slate-900/50 border border-slate-800/80 rounded-[2.5rem] p-8 h-80 overflow-y-auto no-scrollbar space-y-6 shadow-inner relative">
           {isConnecting && <p className="text-slate-500 text-center font-bold text-xs uppercase tracking-widest animate-pulse">Establishing Secure Neural Link...</p>}
           {!isConnecting && transcription.length === 0 && <p className="text-slate-500 text-center font-bold text-xs uppercase tracking-widest italic opacity-50">Brainstorming enabled...</p>}
           
           {transcription && (
             <div className="space-y-2">
                <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">You</p>
                <p className="text-slate-200 leading-relaxed font-medium">{transcription}</p>
             </div>
           )}

           {aiResponse && (
             <div className="space-y-2 pt-4 border-t border-slate-800">
                <p className="text-[9px] font-black uppercase tracking-widest" style={{ color: agent?.color || '#4f46e5' }}>{agent?.name || 'Lumina'}</p>
                <p className="text-slate-300 leading-relaxed text-sm italic font-medium">{aiResponse}</p>
             </div>
           )}
        </div>
      </div>

      <div className="w-full max-w-md">
        <button 
          onClick={() => onClose(transcription)}
          className="w-full bg-white text-[#020617] py-5 rounded-[2rem] font-black text-sm uppercase tracking-widest shadow-2xl active:scale-95 transition-all"
        >
          Finalize Session
        </button>
      </div>
    </div>
  );
};

export default VoiceLiveOverlay;
