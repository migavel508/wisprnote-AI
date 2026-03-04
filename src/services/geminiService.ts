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

export async function generateEmailContent(text: string): Promise<any> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are an expert executive assistant. Based on the following meeting transcription, generate a highly detailed, professional follow-up email.
    DO NOT MISS ANY DETAILS. Capture every single decision, discussion point, and task mentioned in the meeting.
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          subject: { type: Type.STRING, description: "Email subject line (e.g., 'Meeting Notes & Action Items: [Topic]')" },
          greeting: { type: Type.STRING, description: "Email greeting (e.g., 'Hi Team,')" },
          meetingObjective: { type: Type.STRING, description: "The main purpose or objective of the meeting" },
          keyDecisions: { 
            type: Type.ARRAY, 
            items: { type: Type.STRING },
            description: "List of all major decisions made during the meeting"
          },
          discussionPoints: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                topic: { type: Type.STRING, description: "Topic discussed" },
                details: { 
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                  description: "Detailed bullet points capturing EVERYTHING discussed about this topic"
                }
              },
              required: ["topic", "details"]
            },
            description: "Exhaustive breakdown of all topics discussed"
          },
          tasks: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                task: { type: Type.STRING, description: "Detailed description of the action item" },
                owner: { type: Type.STRING, description: "Person responsible (use 'Unassigned' if not explicitly stated)" },
                deadline: { type: Type.STRING, description: "Due date or timeframe (use 'TBD' if not stated)" },
                priority: { type: Type.STRING, description: "Priority level: High, Medium, or Low based on context" },
                notes: { type: Type.STRING, description: "Any additional context or dependencies for the task" }
              },
              required: ["task", "owner", "deadline", "priority", "notes"]
            },
            description: "Comprehensive list of all action items and next steps"
          },
          nextMeeting: { type: Type.STRING, description: "Details about the next sync/meeting if mentioned, or proposed next steps" },
          closing: { type: Type.STRING, description: "Professional closing statement" }
        },
        required: ["subject", "greeting", "meetingObjective", "keyDecisions", "discussionPoints", "tasks", "nextMeeting", "closing"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Email JSON:", e);
    return { subject: "Follow-up", greeting: "Hi Team,", meetingObjective: "", keyDecisions: [], discussionPoints: [], tasks: [], nextMeeting: "", closing: "Best regards" };
  }
}

export async function generateWikiContent(text: string, style: 'MECE' | 'PRD'): Promise<any> {
  const prompt = style === 'MECE' 
    ? `Generate a detailed end-to-end report using the MECE (Mutually Exclusive, Collectively Exhaustive) framework. Ensure all points are logically grouped and exhaustive.`
    : `Generate a comprehensive Product Requirements Document (PRD). Include detailed sections for UI/UX Requirements, User Stories, Developer Team Tasks, and Competitor Analysis.`;

  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `Based on the following meeting transcription, ${prompt}
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Document title" },
          subtitle: { type: Type.STRING, description: "Document subtitle or description" },
          date: { type: Type.STRING, description: "Document date" },
          sections: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                heading: { type: Type.STRING, description: "Section heading" },
                content: { type: Type.STRING, description: "Section content (detailed paragraph)" },
                bullets: { 
                  type: Type.ARRAY, 
                  items: { type: Type.STRING },
                  description: "Key bullet points for this section"
                }
              },
              required: ["heading", "content", "bullets"]
            }
          },
          conclusion: { type: Type.STRING, description: "Conclusion or summary" }
        },
        required: ["title", "subtitle", "date", "sections", "conclusion"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Wiki JSON:", e);
    return { title: "Wiki Document", subtitle: "", date: new Date().toLocaleDateString(), sections: [], conclusion: "" };
  }
}

export async function generatePodcastScript(text: string): Promise<any> {
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are two engaging podcast hosts, Alex and Sarah. Based on the following meeting transcription or notes, create an engaging, dynamic podcast script.
    - Alex is the lead host, energetic and curious.
    - Sarah is the analytical co-host, insightful and witty.
    - They should banter, occasionally joke or laugh, and break down the complex topics from the meeting into easy-to-understand conversational bites.
    - Ensure the script flows naturally like a real audio podcast.
    
    Transcription: ${text}`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          title: { type: Type.STRING, description: "Catchy title for this podcast episode" },
          dialogue: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                speaker: { type: Type.STRING, description: "Must be exactly 'Alex' or 'Sarah'" },
                text: { type: Type.STRING, description: "The spoken dialogue" },
                emotion: { type: Type.STRING, description: "Optional emotion cue (e.g., 'laughing', 'serious', 'excited')" }
              },
              required: ["speaker", "text"]
            },
            description: "The sequential script of the podcast"
          }
        },
        required: ["title", "dialogue"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}");
  } catch (e) {
    console.error("Failed to parse Podcast JSON:", e);
    return { title: "Meeting Breakdown", dialogue: [{ speaker: "Alex", text: "Welcome to the podcast! We had some issues processing the notes, but we'll try again later." }] };
  }
}

export async function chatWithPodcast(context: string, currentDialogue: any[], userMessage: string): Promise<any> {
  // Format the history for the model
  const dialogueHistory = currentDialogue.map(d => `${d.speaker}: ${d.text}`).join('\n');
  
  const response: GenerateContentResponse = await ai.models.generateContent({
    model: "gemini-3-flash-preview",
    contents: `You are two engaging podcast hosts, Alex and Sarah, currently mid-recording. 
    A special guest (the User) has just joined the studio live and said something.
    Based on the meeting context, the ongoing dialogue, and the user's input, generate the next few lines of dialogue where Alex and Sarah react to the user and continue the conversation.
    Keep the same energetic, witty podcast tone. The hosts should directly address the "Guest".
    
    Original Meeting Context:
    ${context}
    
    Recent Dialogue:
    ${dialogueHistory.slice(-1000)} // Last ~1000 chars of dialogue
    
    Guest (User) just said:
    "${userMessage}"
    
    Generate 2-4 new lines of dialogue responding to the guest.`,
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          dialogue: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                speaker: { type: Type.STRING, description: "Must be exactly 'Alex' or 'Sarah'" },
                text: { type: Type.STRING, description: "The spoken dialogue responding to the guest" },
                emotion: { type: Type.STRING, description: "Optional emotion cue" }
              },
              required: ["speaker", "text"]
            }
          }
        },
        required: ["dialogue"]
      }
    }
  });

  try {
    return JSON.parse(response.text || "{}").dialogue || [];
  } catch (e) {
    console.error("Failed to parse Podcast Chat JSON:", e);
    return [{ speaker: "Alex", text: "Wow, great point from our guest!" }, { speaker: "Sarah", text: "Absolutely, thanks for joining us." }];
  }
}
