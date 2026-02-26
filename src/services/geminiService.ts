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
    Return ONLY a raw JSON object with the following structure:
    {
      "title": "Main Title",
      "slides": [
        { "title": "Slide Title", "content": ["Bullet 1", "Bullet 2"] }
      ]
    }
    
    Transcription: ${text}`,
  });
  
  const textResponse = response.text || "{}";
  try {
    // Attempt to extract JSON if model wraps it in markdown blocks
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : textResponse);
  } catch (e) {
    console.error("Failed to parse PPT JSON:", e);
    return { title: "Presentation", slides: [] };
  }
}

export async function generateReportContent(text: string): Promise<any> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following transcription, generate a structured professional report.
    Return ONLY a raw JSON object with the following structure:
    {
      "title": "Report Title",
      "sections": [
        { "heading": "Section Heading", "body": "Section body text..." }
      ]
    }
    
    Transcription: ${text}`,
  });

  const textResponse = response.text || "{}";
  try {
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : textResponse);
  } catch (e) {
    console.error("Failed to parse Report JSON:", e);
    return { title: "Report", sections: [] };
  }
}

export async function generateFollowUpEmail(text: string): Promise<any> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following meeting transcription, act as an AI Assistant and draft a professional follow-up email.
    Identify any action items, key decisions, and next steps.
    Return ONLY a raw JSON object with the following structure:
    {
      "subject": "Proposed Email Subject",
      "body": "The main email body text (use line breaks \\n for formatting, keep it professional and engaging)",
      "actionItems": ["Action item 1 (with assignee if mentioned)", "Action item 2"]
    }
    
    Transcription: ${text}`,
  });

  const textResponse = response.text || "{}";
  try {
    const jsonMatch = textResponse.match(/\{[\s\S]*\}/);
    return JSON.parse(jsonMatch ? jsonMatch[0] : textResponse);
  } catch (e) {
    console.error("Failed to parse Email JSON:", e);
    return { subject: "Follow up", body: "Could not generate email body.", actionItems: [] };
  }
}

export async function generateWikiPage(text: string): Promise<string> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following transcription, create a comprehensive, well-structured Knowledge Base / Wiki page in Markdown format.
    Include a descriptive title, overview, key architectural/business decisions made, blocked items (if any), and a structured summary of the discussion.
    Format it beautifully using markdown headers (##), bold text, and bullet points. Do not wrap the response in markdown code blocks, just return the raw markdown text.
    
    Transcription: ${text}`,
  });
  
  let result = response.text || "";
  if (result.startsWith("\`\`\`markdown")) {
    result = result.replace(/^\`\`\`markdown\n?/, "").replace(/\n?\`\`\`$/, "");
  } else if (result.startsWith("\`\`\`")) {
    result = result.replace(/^\`\`\`\n?/, "").replace(/\n?\`\`\`$/, "");
  }
  
  return result;
}
