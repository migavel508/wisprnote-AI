# Wisprnote AI - Project Documentation (Current State)

Last updated: 2026-04-25
Scope: `desktop/Lumina-AI-`

## 1) Project Overview

Wisprnote AI is a React + Tauri application for meeting capture, transcription, summarization, structured notes, chat, and knowledge graphing.

The desktop app supports:
- Audio upload transcription (Gemini batch or Gemini File API, based on size).
- Native system audio recording and realtime transcription in Tauri.
- Meeting history and note management in Supabase.
- AI chat with meeting context.
- Knowledge graph extraction and local 2D visualization.
- Manual notebooks with slash-editor blocks and image uploads.
- Agent actions in chat: generate follow-up email and wiki content.

## 2) Tech Stack

### Frontend
- React 19
- TypeScript
- Vite
- React Router DOM 7
- Tailwind CSS 4
- Motion (Framer Motion API)
- TipTap editor stack (starter kit + image/link/placeholder/etc.)

### AI
- Google GenAI (`@google/genai`) for transcription, summary, notes, title, chat, visualization prompting, and generation workflows.
- OpenRouter SDK for knowledge graph extraction path.

### Data + Auth
- Supabase (`@supabase/supabase-js`) for auth, tables, and storage.
- Row-level security expected on backend tables.

### Desktop
- Tauri 2 + Rust backend (`src-tauri`)
- Tray icon + tray menu integration
- Native audio + permission commands (macOS-focused)

## 3) Repository Structure (Desktop App)

```text
desktop/Lumina-AI-/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   ├── pages/
│   │   ├── ProcessPage.tsx
│   │   ├── HistoryPage.tsx
│   │   ├── NotesPage.tsx
│   │   ├── ChatPage.tsx
│   │   ├── KnowledgePage.tsx
│   │   └── AudioDevicesPage.tsx
│   ├── components/
│   │   ├── MainSidebar.tsx
│   │   ├── PermissionsGate.tsx
│   │   ├── AudioDevicePanel.tsx
│   │   └── ManualNotes/
│   ├── services/
│   │   ├── geminiService.ts
│   │   ├── supabaseService.ts
│   │   ├── audioService.ts
│   │   ├── nativeRecorderService.ts
│   │   ├── permissionService.ts
│   │   ├── audioDeviceService.ts
│   │   ├── progressStorage.ts
│   │   └── ragService.ts
│   └── lib/
│       └── knowledgeGraph.utils.ts
├── src-tauri/
│   ├── src/
│   │   ├── lib.rs
│   │   ├── main.rs
│   │   ├── system_audio.rs
│   │   ├── deepgram_transcriber.rs
│   │   ├── audio_device.rs
│   │   ├── device_monitor.rs
│   │   └── permissions.rs
│   ├── tauri.conf.json
│   └── Cargo.toml
├── mcp-server/
│   ├── src/index.ts
│   └── README.md
├── record_system_audio/ (auxiliary rust tooling/docs)
├── package.json
└── README.md
```

## 4) Routing and Navigation

`src/App.tsx` uses `react-router-dom` and derives current view from URL.

Current route families:
- `/` or `/process` -> process view
- `/history` -> meeting history
- `/notes` and `/notes/:taskId` -> notes view
- `/chat` and `/chat/:taskId` -> chat view
- `/knowledge` -> knowledge graph
- `/notebooks` -> manual notes notebooks
- `/audio-devices` -> audio devices and diagnostics

Internal `View` union in app:
- `'process' | 'history' | 'notes' | 'chat' | 'knowledge' | 'notebooks' | 'audio-devices'`

## 5) Core Functional Flows

### 5.1 Processing pipeline

Two paths are used:

1. **Gemini File API path** for large files (`audioService.shouldUseFileAPI`, threshold constant).
2. **Chunked batch path**:
   - Split audio into chunks.
   - Process in parallel with bounded concurrency.
   - Retry on transient failures.
   - Merge transcription and generate summary + notes + title.

Outputs are saved to `task_history`.

### 5.2 Native recording

`nativeRecorderService.ts` bridges frontend to Tauri commands:
- Batch mode:
  - `start_system_audio`
  - `stop_system_audio`
  - `is_system_audio_recording`
- Realtime mode:
  - `start_realtime_audio`
  - `stop_realtime_audio`
  - `is_realtime_recording`
  - listens on `realtime-transcript` event

### 5.3 Recovery and offline resilience

`progressStorage.ts` is used for resumable in-progress processing checkpoints.

`supabaseService.ts` has IndexedDB queue for pending tasks:
- `queuePendingTask`
- `flushPendingTasks`
- `getPendingTaskCount`

This supports temporary network loss and later sync.

### 5.4 AI chat and agent actions

Chat is stored in `chat_history`.

Agent action types currently implemented in app data model:
- `email`
- `wiki`

Generated agent assets are stored in `generated_assets` with type `'email' | 'wiki'`.

### 5.5 Knowledge graph

Knowledge graph extraction is generated from meeting text and stored in `knowledge_graph`.
Frontend visualization is handled in `KnowledgePage.tsx` and utility logic in `lib/knowledgeGraph.utils.ts`.

## 6) Data Model (from current TS interfaces)

### TaskHistory

Fields include:
- `id`, `created_at`, `user_id`
- `filename`, `transcription`
- `summary`, `notes`
- `audio_url`
- `status` (`'completed' | 'error'`)
- `duration`, `prompt`
- `personal_note`
- `visualization_image`

### GeneratedAsset

Current strict type:
- `type: 'email' | 'wiki'`

### ChatMessage

Core fields:
- `task_id`
- `role` (`user` or `model`)
- `content`
- optional media/image metadata if present in records

### Manual notes

Manual note editing and listing are implemented in `components/ManualNotes/*` and persisted via `saveManualNote`, `getManualNotes`, `deleteManualNote`.

## 7) Service Layer Inventory

### `services/geminiService.ts`
Key exported functions include:
- `processAudioBatch`
- `uploadAudioToFileAPI`
- `waitForFileActive`
- `deleteFromFileAPI`
- `transcribeViaFileAPI`
- `generateSummary`
- `generateMeetingTitle`
- `generateNotes`
- `chatWithNotes`
- `generateConceptImage`
- `generateNotesVisualization`
- `generateEmailContent`
- `extractKnowledgeGraph`
- `generateWikiContent`
- `generatePodcastScript`
- `chatWithPodcast`

### `services/supabaseService.ts`
Key exported functions include:
- Task lifecycle: `saveTask`, `getTasks`, `getTaskById`, `getTasksLightweight`, update helpers.
- Offline queue: `queuePendingTask`, `flushPendingTasks`, `getPendingTaskCount`.
- Assets: `saveAsset`, `getAssets`.
- Manual notes: `saveManualNote`, `getManualNotes`, `deleteManualNote`, `uploadNoteImage`.
- Knowledge graph: `saveKnowledgeGraph`, `saveKnowledgeGraphBatch`, `getKnowledgeGraph`, `getKnowledgeGraphForTask`, `deleteKnowledgeGraph`.
- Chat: `saveChatMessage`, `saveChatMessages`, `getChatHistory`, `deleteChatHistory`.

### `services/permissionService.ts`
- `checkPermissions`
- `requestMicrophonePermission`
- `openScreenRecordingSettings`
- `openMicrophoneSettings`

### `services/audioDeviceService.ts`
- `listAudioDevices`
- `listInputDevices`
- `listOutputDevices`
- `getDefaultInput`
- `getDefaultOutput`
- listeners for device changes/restart events

### `services/nativeRecorderService.ts`
- Native recording + realtime command bridge and transcript event listener.

## 8) Tauri Runtime and Native Commands

Tauri config (`src-tauri/tauri.conf.json`) highlights:
- Product: `Wisprnote AI`
- Dev URL: `http://localhost:3000`
- Tray icon id: `main-tray`
- Tray icon path: `icons/tray-icon.png`
- Tray tooltip: `Wisprnote AI`

Rust command surface in `src-tauri/src/lib.rs` includes:
- system audio availability/start/stop/status/size
- realtime audio start/stop/status
- audio device listing/default input/default output
- permission checks and settings openers

The tray menu is initialized in Rust and emits events like `tray-record` to frontend.

## 9) Environment Variables (Current Usage)

Observed in code:
- `VITE_SUPABASE_URL`
- `VITE_SUPABASE_ANON_KEY`
- `VITE_DEEPGRAM_API_KEY`
- `VITE_GEMINI_API_KEY` (fallback/read path)
- `GEMINI_API_KEY` (runtime fallback/read path in multiple services)

For MCP server (`mcp-server/README.md`):
- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`
- `WISPRNOTE_USER_ID`

## 10) Desktop Scripts and Commands

From `package.json`:
- `npm run dev`
- `npm run build`
- `npm run preview`
- `npm run lint` (TypeScript noEmit)
- `npm run tauri:dev`
- `npm run tauri:build`

## 11) Notes on Current Scope vs Legacy Docs

This document intentionally reflects current code state. In particular:
- Agent asset types in current app model are `email` and `wiki` (not the older multi-export matrix in some legacy docs).
- Audio devices view is part of active app routing.
- Offline queue + resumable processing are first-class implementation details.
- Tauri tray behavior and native commands are actively wired into app flow.

## 12) MCP Server Subproject

`mcp-server/` is a separate Node-based MCP server to expose user meeting data to MCP-compatible clients (Claude Desktop, Cursor, Windsurf, etc.), using Supabase service credentials scoped by user ID.

## 13) Recommended Documentation Maintenance Workflow

To keep this accurate:
- Update this file whenever route map, service exports, or data interfaces change.
- Keep README concise and user-focused; keep this file implementation-focused.
- Treat `src/App.tsx`, `src/services/*`, and `src-tauri/src/lib.rs` as primary sources of truth.

