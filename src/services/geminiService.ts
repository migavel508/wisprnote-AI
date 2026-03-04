import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { AudioBatch, blobToBase64 } from "./audioService";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

export interface ProcessResult {
  text: string;
  batchIndex: number;
  startTime: number;
  endTime: number;
}

export async function processAudioBatch(batch: AudioBatch, prompt: string): Promise<ProcessResult> {
  const base64Data = await blobToBase64(batch.blob);
  
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: "audio/wav",
              data: base64Data,
            },
          },
          {
            text: `${prompt}\n\nThis is part ${batch.index + 1} of ${batch.total} of the audio recording (from ${Math.floor(batch.startTime)}s to ${Math.floor(batch.endTime)}s).`,
          },
        ],
      },
    ],
  });

  return {
    text: response.text || "",
    batchIndex: batch.index,
    startTime: batch.startTime,
    endTime: batch.endTime,
  };
}

export async function generateSummary(text: string): Promise<string> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Please provide a concise summary of the following transcription:\n\n${text}`,
  });
  return response.text || "";
}

export async function generateNotes(text: string): Promise<string> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Please transform the following transcription into a structured set of notes (Notion-style). Use headings, bullet points, and highlight key takeaways:\n\n${text}`,
  });
  return response.text || "";
}

export async function chatWithNotes(context: string, message: string, history: { role: 'user' | 'model', parts: { text: string }[] }[]): Promise<string> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: [
      ...history,
      {
        role: 'user',
        parts: [{ text: message }]
      }
    ],
    config: {
      systemInstruction: `You are an AI assistant helping a user understand their audio transcription and notes. 
      Context of the transcription:
      ${context}
      
      Answer questions based on this context. Be concise and helpful.`
    }
  });
  return response.text || "";
}

export async function generateConceptImage(description: string): Promise<string | null> {
  // Use gemini-2.5-flash-image for free tier visualizations
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        {
          text: `Create a highly detailed, professional, and accurate concept visualization for: "${description}". 
          The visualization should be a clean, modern architecture diagram, flowchart, or technical map.
          Style: Minimalist, tech-focused, high-contrast, suitable for an executive dashboard.
          Ensure all elements are clearly defined and the layout is logically structured.`,
        },
      ],
    },
    config: {
      imageConfig: {
        aspectRatio: "16:9",
      },
    },
  });

  for (const part of response.candidates?.[0]?.content?.parts || []) {
    if (part.inlineData) {
      return `data:image/png;base64,${part.inlineData.data}`;
    }
  }
  return null;
}

export async function generatePPTContent(text: string, slideCount: number = 5): Promise<any> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following transcription, generate content for a ${slideCount}-slide PowerPoint presentation. 
    Include a title slide and content slides.
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "The main title of the presentation" },
          slides: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                title: { type: Type.STRING, description: "The title of the slide" },
                content: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING },
                  description: "Bullet points for the slide"
                }
              },
              required: ["title", "content"]
            }
          }
        },
        required: ["title", "slides"]
      }
    }
  });
  
  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse PPT JSON:", e);
    return { title: "Presentation", slides: [] };
  }
}

export async function generateReportContent(text: string): Promise<any> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following transcription, generate a structured professional report.
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "The title of the report" },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING, description: "The heading of the section" },
                body: { type: Type.STRING, description: "The detailed content of the section" }
              },
              required: ["heading", "body"]
            }
          }
        },
        required: ["title", "sections"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Report JSON:", e);
    return { title: "Report", sections: [] };
  }
}
