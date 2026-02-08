
import { GoogleGenAI, Type, Modality } from "@google/genai";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Extracts specific tasks/action items from a block of text.
 */
export const extractTasks = async (content: string): Promise<{ text: string, priority: string }[]> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Identify all actionable tasks or to-do items from the following note content. 
    For each task, assign a priority (LOW, MEDIUM, HIGH, CRITICAL).
    Return ONLY a JSON array of objects with 'text' and 'priority' keys.
    
    Content: "${content}"`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            text: { type: Type.STRING },
            priority: { type: Type.STRING }
          },
          required: ["text", "priority"]
        }
      }
    }
  });
  try {
    return JSON.parse(response.text || '[]');
  } catch (e) {
    return [];
  }
};

/**
 * Specifically handles removing repetitions, fixing mistakes, and restructuring 
 * messy spoken notes into concise project tasks or summaries.
 */
export const autoCorrectAndRestructure = async (content: string): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Act as a professional editor. The following text is a transcription of spoken thoughts. 
    1. Remove all verbal fillers (um, ah, like).
    2. Remove all repetitions (if the user said the same thing multiple times, keep it once).
    3. Correct grammar and punctuation.
    4. Restructure into logical paragraphs or bullet points if appropriate.
    5. Maintain the original intent and detail, just make it professional and clean.
    
    Transcription: "${content}"`,
  });
  return response.text || content;
};

export const suggestUnifiedMetadata = async (content: string): Promise<{ 
  title: string, 
  tags: string[], 
  category: string, 
  vibeColor: string,
  priority: string,
  storyPoints: number,
  epic: string
}> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Analyze this content. Suggest: Title (5 words max), 3 tags, Category (Work, Personal, Creative, Idea), Vibe color (Tailwind hex), Priority (LOW, MEDIUM, HIGH, CRITICAL), Complexity (1, 2, 3, 5, 8), Theme/Epic. Return ONLY JSON:`,
    config: { 
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING },
          tags: { type: Type.ARRAY, items: { type: Type.STRING } },
          category: { type: Type.STRING },
          vibeColor: { type: Type.STRING },
          priority: { type: Type.STRING },
          storyPoints: { type: Type.NUMBER },
          epic: { type: Type.STRING }
        }
      }
    }
  });
  try {
    return JSON.parse(response.text || '{}');
  } catch (e) {
    return { title: "Draft Note", tags: [], category: "Other", vibeColor: "#334155", priority: 'MEDIUM', storyPoints: 1, epic: 'General' };
  }
};

export const verifyFacts = async (content: string): Promise<{ summary: string, sources: any[] }> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Verify claims: "${content}"`,
    config: { tools: [{ googleSearch: {} }] }
  });
  const sources = response.candidates?.[0]?.groundingMetadata?.groundingChunks
    ?.filter(chunk => chunk.web)
    ?.map(chunk => ({ title: chunk.web.title, uri: chunk.web.uri })) || [];
  return { summary: response.text || "No verification.", sources };
};

export const summarizeNote = async (text: string): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Summarize:\n\n${text}`,
  });
  return response.text || "No summary.";
};

// Fixed typo: responseModalities
export const generateAudioBrief = async (text: string): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: "gemini-2.5-flash-preview-tts",
    contents: [{ parts: [{ text: text }] }],
    config: {
      responseModalities: [Modality.AUDIO],
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: 'Kore' } } },
    },
  });
  return response.candidates?.[0]?.content?.parts?.[0]?.inlineData?.data || "";
};

export const askAboutNote = async (content: string, question: string, history: any[]): Promise<string> => {
  const ai = getAI();
  const chat = ai.chats.create({
    model: 'gemini-3-flash-preview',
    config: { systemInstruction: `Project Assistant. Context: "${content}".` }
  });
  const response = await chat.sendMessage({ message: question });
  return response.text || "...";
};

export const extractTextFromImage = async (imageBase64: string): Promise<string> => {
  const ai = getAI();
  const base64Data = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/png', data: base64Data } },
        { text: "Extract text." },
      ],
    },
  });
  return response.text || "";
};

export const editImageWithGemini = async (imageBase64: string, prompt: string): Promise<string> => {
  const ai = getAI();
  const base64Data = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { inlineData: { mimeType: 'image/png', data: base64Data } },
        { text: prompt },
      ],
    },
  });
  const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
  if (part?.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  throw new Error("Edit failed");
};

export const decodeAudio = (base64: string) => {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) bytes[i] = binaryString.charCodeAt(i);
  return bytes;
};

export const encodeAudio = (bytes: Uint8Array) => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
};

export async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
  }
  return buffer;
}
