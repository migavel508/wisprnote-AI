
import { GoogleGenAI, Type } from "@google/genai";

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

export const summarizeNote = async (text: string): Promise<string> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Summarize the following note into a concise summary with bullet points:\n\n${text}`,
  });
  return response.text || "No summary generated.";
};

export const suggestMetadata = async (content: string): Promise<{ title: string, tags: string[] }> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Analyze this note and suggest a short catchy title (max 5 words) and exactly 3 relevant tags. Return ONLY a JSON object with keys "title" and "tags":\n\n${content}`,
    config: { responseMimeType: "application/json" }
  });
  try {
    return JSON.parse(response.text || '{}');
  } catch (e) {
    return { title: "New Note", tags: ["General"] };
  }
};

export const extractTasks = async (content: string): Promise<string[]> => {
  const ai = getAI();
  const response = await ai.models.generateContent({
    model: 'gemini-3-flash-preview',
    contents: `Identify all actionable tasks or to-do items from this note. Return them as a simple list of strings in JSON format. Return only the array:\n\n${content}`,
    config: { responseMimeType: "application/json" }
  });
  try {
    return JSON.parse(response.text || '[]');
  } catch (e) {
    return [];
  }
};

export const askAboutNote = async (content: string, question: string, history: any[]): Promise<string> => {
  const ai = getAI();
  const chat = ai.chats.create({
    model: 'gemini-3-flash-preview',
    config: {
      systemInstruction: `You are an AI assistant helping a user with their personal note. The content of the note is: "${content}". Answer the user's questions accurately based on this content.`
    }
  });
  const response = await chat.sendMessage({ message: question });
  return response.text || "I'm sorry, I couldn't process that.";
};

export const extractTextFromImage = async (imageBase64: string): Promise<string> => {
  const ai = getAI();
  const mimeTypeMatch = imageBase64.match(/^data:([^;]+);base64,/);
  const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/png';
  const base64Data = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: "Accurately transcribe all text found in this image. Do not add descriptions, just the text content." },
      ],
    },
  });
  return response.text || "";
};

export const editImageWithGemini = async (imageBase64: string, prompt: string): Promise<string> => {
  const ai = getAI();
  const mimeTypeMatch = imageBase64.match(/^data:([^;]+);base64,/);
  const mimeType = mimeTypeMatch ? mimeTypeMatch[1] : 'image/png';
  const base64Data = imageBase64.replace(/^data:image\/(png|jpeg|jpg);base64,/, "");
  
  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { inlineData: { mimeType, data: base64Data } },
        { text: `Apply this edit to the image: "${prompt}". Return ONLY the modified image data.` },
      ],
    },
    config: { systemInstruction: "Modify the image as requested and return only the resulting image data." }
  });

  const part = response.candidates?.[0]?.content?.parts.find(p => p.inlineData);
  if (part?.inlineData) return `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`;
  throw new Error("Failed to edit image");
};

export const decodeAudio = (base64: string) => {
  const binaryString = atob(base64);
  const len = binaryString.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes;
};

export const encodeAudio = (bytes: Uint8Array) => {
  let binary = '';
  const len = bytes.byteLength;
  for (let i = 0; i < len; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
};

export async function decodeAudioData(data: Uint8Array, ctx: AudioContext, sampleRate: number, numChannels: number): Promise<AudioBuffer> {
  const dataInt16 = new Int16Array(data.buffer);
  const frameCount = dataInt16.length / numChannels;
  const buffer = ctx.createBuffer(numChannels, frameCount, sampleRate);
  for (let channel = 0; channel < numChannels; channel++) {
    const channelData = buffer.getChannelData(channel);
    for (let i = 0; i < frameCount; i++) {
      channelData[i] = dataInt16[i * numChannels + channel] / 32768.0;
    }
  }
  return buffer;
}
