import { GoogleGenAI, GenerateContentResponse, Type } from "@google/genai";
import { AudioBatch, blobToBase64 } from "./audioService";

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY || "" });

// Utility to try a model and fallback if it fails (e.g. 503 Service Unavailable)
async function generateWithFallback(
  requestOptions: any,
  fallbackModels: string[] = ["gemini-2.5-flash", "gemini-2.0-flash"]
): Promise<GenerateContentResponse> {
  let lastError;
  const modelsToTry = [requestOptions.model, ...fallbackModels];

  for (const model of modelsToTry) {
    try {
      return await ai.models.generateContent({
        ...requestOptions,
        model
      });
    } catch (error: any) {
      console.warn(`Model ${model} failed:`, error.message);
      lastError = error;
      // Only fallback on 503 or 429 (overloaded/unavailable)
      if (error.status !== 503 && error.status !== 429) {
        throw error;
      }
    }
  }
  throw lastError;
}

export interface ProcessResult {
  text: string;
  batchIndex: number;
  startTime: number;
  endTime: number;
}

export async function processAudioBatch(batch: AudioBatch, prompt: string): Promise<ProcessResult> {
  const base64Data = await blobToBase64(batch.blob);
  
  // Use a transcription-focused prompt to get clean transcription output
  const transcriptionPrompt = `You are a professional transcription service. Your ONLY task is to transcribe the spoken words in this audio accurately and verbatim.

IMPORTANT RULES:
- Output ONLY the exact words spoken in the audio
- Do NOT summarize, analyze, or interpret the content
- Do NOT add any commentary, notes, or explanations
- Do NOT use bullet points or formatting - just plain text paragraphs
- Include speaker labels if multiple speakers are detected (e.g., "Speaker 1:", "Speaker 2:")
- Preserve natural speech patterns including filler words (um, uh, etc.) if present
- If audio is unclear, use [inaudible] for unclear portions

This is part ${batch.index + 1} of ${batch.total} of the audio recording (from ${Math.floor(batch.startTime)}s to ${Math.floor(batch.endTime)}s).

${prompt ? `Additional context: ${prompt}` : ''}

Now transcribe the audio:`;

  const response = await generateWithFallback({
    model: "gemini-3-flash-preview",
    contents: [
      {
        parts: [
          {
            inlineData: {
              mimeType: batch.mimeType,
              data: base64Data,
            },
          },
          {
            text: transcriptionPrompt,
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
  const response = await generateWithFallback({
    model: "gemini-3-flash-preview",
    contents: `Please provide a concise summary of the following transcription:\n\n${text}`,
  });
  return response.text || "";
}

export async function generateNotes(text: string): Promise<string> {
  const response = await generateWithFallback({
    model: "gemini-3-flash-preview",
    contents: `Please transform the following transcription into a structured set of notes (Notion-style). Use headings, bullet points, and highlight key takeaways:\n\n${text}`,
  });
  return response.text || "";
}

export async function chatWithNotes(context: string, message: string, history: { role: 'user' | 'model', parts: { text: string }[] }[]): Promise<string> {
  const response = await generateWithFallback({
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

export async function extractKnowledgeGraph(meetingId: string, meetingTitle: string, text: string): Promise<any> {
  const geminiApiKey = import.meta.env.VITE_GEMINI_API_KEY || import.meta.env.GEMINI_API_KEY || "AIzaSyB1McBfQnEy2boqAHu5GrGYex5ZMzEpxCQ"; // Fallback to hardcoded key if env is not loaded properly in dev
  
  if (!geminiApiKey) {
    console.error('Gemini API key is not configured');
    return { meetingId, meetingTitle, topics: [], decisions: [], people: [], actionItems: [], references: [] };
  }
  
  const combinedPrompt = `You are a JSON-only API. You MUST respond with ONLY valid JSON, no text before or after. Never include explanations, greetings, or markdown. Output raw JSON only.

Extract knowledge graph data from this meeting transcription. For each topic discussed, carefully analyze the conversation to determine its status:

TOPIC STATUS RULES (you MUST use one of these exact values):
- "new" = Topic mentioned for the first time, just introduced, no prior discussion implied
- "ongoing" = Topic is actively being worked on, in progress, not yet finished. Look for phrases like "still working on", "in progress", "continuing", "we're looking into", "not done yet"
- "resolved" = Topic has been completed, finished, or a final decision was reached. Look for phrases like "done", "completed", "finished", "signed off", "approved", "wrapped up", "closed"
- "off-track" = Topic has problems, is delayed, blocked, or going wrong. Look for phrases like "delayed", "blocked", "issue with", "problem", "behind schedule", "stuck", "failing", "not working", "concerned about"
- "revisited" = Topic was discussed before and is being brought up again. Look for phrases like "coming back to", "revisiting", "as we discussed before", "following up on", "update on"

Return ONLY this JSON structure:
{"topics":[{"name":"short topic name","summary":"1-2 sentence summary of what was said about this topic","status":"new|ongoing|resolved|off-track|revisited"}],"decisions":[{"decision":"what was decided","relatedTopic":"related topic name"}],"people":["Person Name"],"actionItems":[{"task":"what needs to be done","owner":"who is responsible","relatedTopic":"related topic name"}],"references":["any documents, tools, or resources mentioned"]}

IMPORTANT: Do NOT default all statuses to "new". Carefully read the tone and context of the discussion for each topic. Most real meetings have a mix of statuses.

Meeting: ${meetingTitle}
Transcription: ${text.substring(0, 8000)}`;

  try {
    const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite-preview:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: combinedPrompt }] }
        ],
        generationConfig: {
          temperature: 0.1,
          responseMimeType: "application/json"
        }
      })
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error('Gemini API error:', errorText);
      throw new Error(`Gemini API error: ${response.status}`);
    }

    const data = await response.json();
    const content = data.candidates?.[0]?.content?.parts?.[0]?.text || '{}';
    
    // Extract and repair JSON from response
    let cleanContent = content.trim();
    
    // Remove markdown code blocks if Gemini ignores responseMimeType
    if (cleanContent.startsWith('```json')) {
      cleanContent = cleanContent.slice(7);
    } else if (cleanContent.startsWith('```')) {
      cleanContent = cleanContent.slice(3);
    }
    if (cleanContent.endsWith('```')) {
      cleanContent = cleanContent.slice(0, -3);
    }
    cleanContent = cleanContent.trim();
    
    // Try to find JSON object in the response if it starts with text
    const jsonMatch = cleanContent.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      cleanContent = jsonMatch[0];
    }

    // Attempt to repair common JSON issues
    const repairJson = (str: string): string => {
      let repaired = str;
      // Fix trailing commas before ] or }
      repaired = repaired.replace(/,\s*([}\]])/g, '$1');
      // Fix missing commas between array elements
      repaired = repaired.replace(/"\s*\n\s*"/g, '",\n"');
      repaired = repaired.replace(/}\s*\n\s*{/g, '},\n{');
      // Fix unescaped newlines in strings (replace with space)
      repaired = repaired.replace(/([^\\])\\n/g, '$1 ');
      return repaired;
    };

    // Try parsing, with repair fallback
    let parsed;
    try {
      parsed = JSON.parse(cleanContent);
    } catch {
      try {
        parsed = JSON.parse(repairJson(cleanContent));
      } catch {
        // Last resort: extract what we can manually
        console.warn("JSON repair failed, extracting partial data");
        parsed = {
          topics: [],
          decisions: [],
          people: [],
          actionItems: [],
          references: []
        };
        
        // Try to extract topics array
        const topicsMatch = cleanContent.match(/"topics"\s*:\s*\[([\s\S]*?)\]/);
        if (topicsMatch) {
          try {
            parsed.topics = JSON.parse(`[${topicsMatch[1]}]`.replace(/,\s*]/g, ']'));
          } catch { /* ignore */ }
        }
        
        // Try to extract people array
        const peopleMatch = cleanContent.match(/"people"\s*:\s*\[([\s\S]*?)\]/);
        if (peopleMatch) {
          try {
            parsed.people = JSON.parse(`[${peopleMatch[1]}]`.replace(/,\s*]/g, ']'));
          } catch { /* ignore */ }
        }
      }
    }
    
    return { meetingId, meetingTitle, ...parsed };
  } catch (e) {
    console.error("Failed to extract KG via Gemini API:", e);
    return { meetingId, meetingTitle, topics: [], decisions: [], people: [], actionItems: [], references: [] };
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
