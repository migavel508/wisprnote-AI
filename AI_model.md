Overall, this application uses a mix of models depending on the specific task. The primary engine driving almost all the intelligence is the new **Gemini 3 family**.

Here is the breakdown of the models used across the application:

1. **Audio Transcription & Core Text Processing**: `gemini-3-flash-preview`
   - Used for transcribing uploaded audio batches.
   - Generating meeting summaries and structured notes.
   - Powering the "Chat with Notes" AI assistant.
   - Generating all text-based assets (Reports, Emails, PPT content, Wiki pages/PRDs).
   - Generating the AI Podcast scripts and live chat.

2. **Concept Image Generation**: `gemini-2.5-flash-image`
   - Used exclusively when you request a visual flowchart, diagram, or concept image from your notes.

3. **Knowledge Graph Extraction**: `openrouter/free` (or whatever specific model is configured via OpenRouter)
   - Used specifically in the [extractKnowledgeGraph](cci:1://file:///Users/migavelaishwin/Downloads/wisprnote_web/Lumina-AI-/src/services/geminiService.ts:280:0-404:1) function to parse the meeting transcript into structured JSON nodes and links for the visual Knowledge Graph UI. It uses the OpenRouter API for this specific background extraction task.

*(Note: The live transcription feature we were just working on also used `gemini-3-flash-preview` along with a fallback chain to older models (`gemini-2.5-flash`, `gemini-2.0-flash`, `gemini-1.5-flash`) before it was removed.)*