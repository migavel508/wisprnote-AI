# WisprNote AI — End-to-End Product Documentation

A comprehensive technical reference for the Lumina-AI- desktop app (productized as **WisprNote AI**): an AI meeting-notes platform that records, transcribes, summarizes, indexes, and lets you converse with your meetings.

This document reflects the **current** state of the codebase only. Anything removed has been excluded.

---

## 1. Product Overview

WisprNote AI is a cross-platform desktop application (Tauri + web) that turns spoken meetings into structured, searchable knowledge.

Core capabilities:
- Record system audio + microphone (macOS native via Tauri) or upload audio files.
- Real-time transcription mode via Deepgram, or batch transcription via Gemini.
- AI-generated meeting **titles, summaries, structured notes**, follow-up **emails**, and concept **sketchnote images**.
- **Chat with Notes** — single-meeting RAG conversation with grounded answers.
- **Agentic chat across all meetings** with tool-calling search.
- **Knowledge Graph** — extracted topics, decisions, people, action items, and cross-meeting relationships visualized as a force-directed graph.
- **Workspaces & folders** for organizing meetings, with sharing & invitations.
- **MCP server** exposing meeting data to Claude / external AI tools over stdio.

---

## 2. High-Level Architecture

```
┌──────────────────────────────────────────────────────────────────────┐
│                       Client (Tauri + React 19)                      │
│  ┌─────────────────────────────────────────────────────────────────┐ │
│  │  React UI (Vite, Tailwind v4, Framer Motion, Tiptap, ForceGraph)│ │
│  └────────────┬────────────────────────────────────────────────────┘ │
│               │                                                      │
│  ┌────────────┴───────────────┐    ┌────────────────────────────┐    │
│  │ Service layer (src/services)│    │  Rust core (src-tauri/src)│    │
│  │  • geminiService            │    │  • system_audio (macOS)   │    │
│  │  • turbopufferService       │    │  • deepgram_transcriber   │    │
│  │  • chatRetrievalService     │    │  • mic_cpal               │    │
│  │  • ragService               │    │  • device_monitor         │    │
│  │  • awsService / Auth/Ledger │    │  • permissions            │    │
│  │  • supabaseService          │    └────────────┬───────────────┘    │
│  │  • audioService             │                 │ Tauri IPC          │
│  └────────────┬───────────────┘                  ▼                   │
└───────────────┼──────────────────────────────────┴───────────────────┘
                │
                ▼
   ┌───────────────────────────────────────────────────────────────┐
   │                         External Services                     │
   │                                                               │
   │  Google Gemini API   ──► LLM, vision-text, embeddings, images │
   │  OpenRouter API      ──► Alternative LLM/embed provider       │
   │  Deepgram WS         ──► Realtime speech-to-text              │
   │  Turbopuffer (GCP)   ──► Vector store for hybrid RAG          │
   │  AWS API Gateway     ──► Lambda backend (Postgres on RDS)     │
   │  AWS Cognito         ──► Identity (email + Google federation) │
   │  AWS S3              ──► Audio + image storage (presigned)    │
   │  AWS SES / Resend    ──► Share invitation emails              │
   │  Supabase            ──► Legacy/secondary persistence path    │
   │  Vercel              ──► OG/share preview edge functions      │
   └───────────────────────────────────────────────────────────────┘
```

The app is **client-heavy**: most AI orchestration runs in the browser/Tauri webview; AWS Lambda is a stateless CRUD + presign layer; the Rust core handles privileged audio capture.

---

## 3. Repository Layout

```
desktop/Lumina-AI-/
├── src/                 React app (entry: main.tsx → App.tsx)
│   ├── components/      Shared UI (Sidebar, Auth, ShareModal, ManualNotes, ui/*)
│   ├── pages/           Top-level views (Process, History, Notes, Chat, Knowledge,
│   │                    Workspace, People, Settings, AudioDevices, SharedMeeting)
│   ├── services/        All I/O — AI, AWS, Supabase, audio, RAG, vector store
│   ├── lib/             Pure helpers (logger, knowledgeGraph utils, KG caches)
│   └── theme/           ThemeProvider + design tokens
├── src-tauri/           Rust desktop shell
│   └── src/             audio_device, system_audio, mic_cpal, deepgram_transcriber,
│                        device_monitor, permissions, logger, lib.rs (Tauri commands)
├── aws/                 Backend code & schema
│   ├── api/             AWS Lambda (Node 20, esbuild bundle) — REST API
│   └── *.sql            RDS Postgres migrations
├── api/                 Vercel serverless functions (share preview / OG tags)
├── mcp-server/          MCP server exposing meetings to Claude over stdio
├── supabase/            Legacy Supabase SQL & client paths
├── public/, assets/     Static assets
└── docs/                Architecture & reference docs (this file)
```

Important top-level configs: [package.json](../package.json), [vite.config.ts](../vite.config.ts), [src-tauri/tauri.conf.json](../src-tauri/tauri.conf.json), [src-tauri/Cargo.toml](../src-tauri/Cargo.toml).

---

## 4. Frontend Application

### 4.1 Entry & shell
- [src/main.tsx](../src/main.tsx) — boots React 19 inside `ThemeProvider` and `BrowserRouter`.
- [src/App.tsx](../src/App.tsx) — single 4000+ LOC root component that owns: authentication state, recording state, meeting history, processing pipeline, and a `currentView` enum that switches between feature pages (`process`, `history`, `notes`, `chat`, `notebooks`, `knowledge`, `audio-devices`, `workspace`, `people`, `settings`, `shared`).

### 4.2 Pages
| Page | File | Purpose |
|---|---|---|
| Process | [pages/ProcessPage.tsx](../src/pages/ProcessPage.tsx) | Upload audio / start recording / progress UI |
| History | [pages/HistoryPage.tsx](../src/pages/HistoryPage.tsx) | Searchable, paginated meeting list with relevance scoring |
| Notes | [pages/NotesPage.tsx](../src/pages/NotesPage.tsx) | Per-meeting summary, notes, transcript, asset generation |
| Chat | [pages/ChatPage.tsx](../src/pages/ChatPage.tsx) | Single-meeting + cross-meeting chat UI |
| Knowledge | [pages/KnowledgePage.tsx](../src/pages/KnowledgePage.tsx) | ForceGraph2D knowledge-graph visualization & exploration |
| Assets | [pages/AssetsPage.tsx](../src/pages/AssetsPage.tsx) | Generated emails, wikis,
| Workspace | [pages/WorkspacePage.tsx](../src/pages/WorkspacePage.tsx) | Workspaces, folders, member management |
| People | [pages/PeoplePage.tsx](../src/pages/PeoplePage.tsx) | Person aggregations across meetings |
| AudioDevices | [pages/AudioDevicesPage.tsx](../src/pages/AudioDevicesPage.tsx) | Input device selector + permissions gate |
| Settings | [pages/SettingsPage.tsx](../src/pages/SettingsPage.tsx) | Account, preferences, sign-out |
| Shared | [pages/SharedMeetingPage.tsx](../src/pages/SharedMeetingPage.tsx) | Public/restricted shared-meeting viewer |

### 4.3 Components
- [components/Auth.tsx](../src/components/Auth.tsx) — Cognito sign-in/up + Google federation entry.
- [components/MainSidebar.tsx](../src/components/MainSidebar.tsx), [Sidebar.tsx](../src/components/Sidebar.tsx) — primary navigation.
- [components/WorkspaceSwitcher.tsx](../src/components/WorkspaceSwitcher.tsx), [WorkspaceCreationWizard.tsx](../src/components/WorkspaceCreationWizard.tsx), [CreateFolderModal.tsx](../src/components/CreateFolderModal.tsx) — workspace/folder management.
- [components/ShareModal.tsx](../src/components/ShareModal.tsx) — share-link creation + email invitations.
- [components/PermissionsGate.tsx](../src/components/PermissionsGate.tsx), [AudioDevicePanel.tsx](../src/components/AudioDevicePanel.tsx) — recording prerequisites.
- [components/ManualNotes/*](../src/components/ManualNotes/) — Tiptap-based rich-text manual-notes editor, image resize, slash-command menu, tabs.
- [components/Skeleton.tsx](../src/components/Skeleton.tsx), [components/ui/*](../src/components/ui/) — loading skeletons, toggles, shining text effect.

### 4.4 Theme & logger
- [theme/ThemeProvider.tsx](../src/theme/ThemeProvider.tsx), [theme/constants.ts](../src/theme/constants.ts) — light/dark theme tokens.
- [lib/logger/](../src/lib/logger/) — scoped logger with console + Tauri transports.

---

## 5. Rust Desktop Core (Tauri)

The Rust side ([src-tauri/](../src-tauri/)) packages the React build into a native macOS/Windows app and provides privileged audio capabilities.

Crates in use (see [Cargo.toml](../src-tauri/Cargo.toml)):
- `tauri` v2 with `devtools`, `tray-icon`
- `tauri-plugin-shell`, `tauri-plugin-deep-link`, `tauri-plugin-http`
- `tokio`, `tokio-tungstenite` (Deepgram WebSocket)
- macOS-only: `cidre` (AVFoundation/CoreAudio bindings), `ringbuf`, `cpal`

Source modules ([src-tauri/src/](../src-tauri/src/)):
| Module | Purpose |
|---|---|
| `lib.rs` | Tauri command registrations + global `AppState` |
| `system_audio.rs` | macOS system-audio capture (`SystemAudioRecorder`, `RealtimeRecorder`) — uses `cidre` Core Audio APIs |
| `mic_cpal.rs` | Microphone capture via CPAL |
| `device_monitor.rs` | Tracks input-device changes & emits events |
| `audio_device.rs` | Enumerates devices for the AudioDevices page |
| `deepgram_transcriber.rs` | Streams PCM frames to `wss://api.deepgram.com/v1/listen` via tokio-tungstenite |
| `permissions.rs` | macOS mic + screen recording permission probes |
| `logger.rs` | Bridges Rust logs to the JS-side logger |
| `main.rs` | Standard Tauri bootstrap |

Exposed Tauri commands (invoked from [nativeRecorderService.ts](../src/services/nativeRecorderService.ts)):
- `is_system_audio_available` / `is_system_audio_recording`
- `start_system_audio` / `stop_system_audio` (returns base64 WAV)
- `start_realtime_audio(apiKey, keyterms)` / `stop_realtime_audio` (Deepgram streaming)

Tauri window config ([tauri.conf.json](../src-tauri/tauri.conf.json)): 1400×900 default, transparent + overlay titlebar, tray-icon enabled.

---

## 6. AI Models & Providers

The app uses **three external AI providers**: Google Gemini (LLM + vision + embeddings), OpenRouter (drop-in alternative for Gemini), and Deepgram (real-time speech-to-text). LLM provider selection is via `VITE_AI_PROVIDER`:

| Provider | Env value | Required key |
|---|---|---|
| Google Gemini (direct) | `gemini` *(default)* | `VITE_GEMINI_API_KEY` |
| OpenRouter (proxy) | `openrouter` | `VITE_OPENROUTER_API_KEY` |
| Deepgram (always direct, realtime only) | n/a | `DEEPGRAM_API_KEY` |

Provider selection: [geminiService.ts:11-16](../src/services/geminiService.ts#L11-L16). Gemini model IDs are auto-prefixed to `google/<model>` when routing through OpenRouter via `toOpenRouterModel()`.

### 6.1 Master matrix — which model does what

The complete mapping of every product feature to the exact model that runs it.

| # | Product feature / function | Model | Call site |
|---|---|---|---|
| 1 | **Real-time live transcription** (Tauri streaming mode) | `nova-3` (Deepgram) | [deepgram_transcriber.rs:151](../src-tauri/src/deepgram_transcriber.rs#L151) |
| 2 | **Batch audio transcription** — chunked recordings (`processAudioBatch`) | `gemini-3-flash-preview` | [geminiService.ts:395](../src/services/geminiService.ts#L395) |
| 3 | **Large-file transcription via Gemini File API** (`transcribeViaFileAPI`, >25 MB) | `gemini-3-flash-preview` | [geminiService.ts:589](../src/services/geminiService.ts#L589) |
| 4 | **Meeting title generation** (`generateMeetingTitle`) — whole-meeting head+middle+tail sampling, `maxOutputTokens: 24` | `gemini-3.1-flash-lite` | [geminiService.ts:625-647](../src/services/geminiService.ts#L625) |
| 5 | **Meeting summary** (`generateSummary`) | `gemini-3-flash-preview` | [geminiService.ts:602](../src/services/geminiService.ts#L602) |
| 6 | **Structured notes** (`generateNotes`) | `gemini-3-flash-preview` | [geminiService.ts:651](../src/services/geminiService.ts#L651) |
| 7 | **Follow-up email content** (`generateEmailContent`) | `gemini-3-flash-preview` | [geminiService.ts:1677](../src/services/geminiService.ts#L1677) |
| 8 | **Free-form "ask AI" against a transcript** (Assets tab) | `gemini-3-flash-preview` | [geminiService.ts:2066](../src/services/geminiService.ts#L2066) |

| 11 | **Single-meeting Chat with Notes** (`chatWithNotes`) | `gemini-3-flash-preview` | [geminiService.ts:1066](../src/services/geminiService.ts#L1066) |
| 12 | **Cross-meeting evidence synthesis** (`agentSynthesizeFromEvidence`) | `gemini-3-flash-preview` | [geminiService.ts:1122](../src/services/geminiService.ts#L1122) |
| 13 | **Intent classifier for agentic chat** (`agentPlanQuery`) | `gemini-3-flash-preview` | [geminiService.ts:932](../src/services/geminiService.ts#L932) |
| 14 | **Agentic tool-calling loop — Gemini path** (`agentChatAllMeetings`) | `gemini-2.5-flash` | [geminiService.ts:1454](../src/services/geminiService.ts#L1454) |
| 15 | **Agentic tool-calling loop — OpenRouter path** | `google/gemini-3.1-flash-lite` | [geminiService.ts:1378](../src/services/geminiService.ts#L1378) |
| 16 | **Grounding / hallucination-check pass** (`enforceGroundedAnswer`) — `maxOutputTokens: 1200` | `gemini-3.1-flash-lite` | [geminiService.ts:898](../src/services/geminiService.ts#L898) |
| 17 | **Knowledge graph extraction** (topics, decisions, people, action items) | `gemini-3-flash-preview` | [geminiService.ts:1810](../src/services/geminiService.ts#L1810), [knowledgeGraph.utils.ts:85](../src/lib/knowledgeGraph.utils.ts#L85) |
| 18 | **KG extraction retry pass** (simpler prompt when zero topics extracted) | `gemini-3-flash-preview` | [geminiService.ts:1983](../src/services/geminiService.ts#L1983) |
| 19 | **Concept diagram image generation** (`generateConceptImage`) | `gemini-3.1-flash-image-preview` | [geminiService.ts:1529](../src/services/geminiService.ts#L1529) |
| 20 | **Hand-drawn sketchnote visualization** (`generateNotesVisualization`) | `gemini-3.1-flash-image-preview` | [geminiService.ts:1654](../src/services/geminiService.ts#L1654) |
| 21 | **Image fallback (Gemini path)** | `gemini-2.5-flash-image-preview` | [geminiService.ts:1532,1656](../src/services/geminiService.ts#L1532) |
| 22 | **Image fallback (OpenRouter path)** | `google/gemini-2.5-flash-image` → `google/gemini-2.0-flash-exp` | [geminiService.ts:32,237-238](../src/services/geminiService.ts#L237) |
| 23 | **Knowledge page direct semantic query** | `gemini-3-flash-preview` (or `google/gemini-3-flash-preview`) | [KnowledgePage.tsx:538,561](../src/pages/KnowledgePage.tsx#L538) |
| 24 | **Embedding generation** (KG topics, meeting summaries, chunks for Turbopuffer) | `gemini-embedding-001` | [knowledgeGraph.utils.ts:83](../src/lib/knowledgeGraph.utils.ts#L83) |
| 25 | **Embedding Gemini fallback** | `text-embedding-004` | [knowledgeGraph.utils.ts:84](../src/lib/knowledgeGraph.utils.ts#L84) |
| 26 | **Embedding OpenRouter equivalent** | `openai/text-embedding-3-large` | [knowledgeGraph.utils.ts:115](../src/lib/knowledgeGraph.utils.ts#L115) |
| 27 | **LLM fallback chain — single fallback** | `gemini-3.1-flash-lite` | [geminiService.ts:302](../src/services/geminiService.ts#L302) |

### 6.2 Deepgram — real-time speech-to-text (`nova-3`)

WebSocket endpoint: `wss://api.deepgram.com/v1/listen` ([deepgram_transcriber.rs:8](../src-tauri/src/deepgram_transcriber.rs#L8)).

The Tauri process opens a WebSocket per recording session and streams 16-bit linear PCM frames from the macOS Core Audio capture loop. The React layer just calls `start_realtime_audio(apiKey, keyterms)` / `stop_realtime_audio`. The model **`nova-3`** is hard-pinned with this exact query string ([deepgram_transcriber.rs:151](../src-tauri/src/deepgram_transcriber.rs#L151)):

| Parameter | Value | Purpose |
|---|---|---|
| `model` | `nova-3` | Deepgram's latest English-tuned streaming model |
| `language` | `en` | English |
| `encoding` | `linear16` | 16-bit PCM samples |
| `sample_rate` | matches the recorder (typically 16 kHz / 48 kHz) | |
| `channels` | `1` | Mono mixdown of mic + system audio |
| `interim_results` | `true` | Stream partial hypotheses as the speaker talks |
| `smart_format` | `true` | Capitalization, punctuation, dates, currency |
| `punctuate` | `true` | Adds punctuation |
| `numerals` | `true` | Converts "twenty twenty four" → "2024" |
| `diarize` | `true` | Per-speaker labels |
| `utterances` | `true` | Emits stable per-utterance chunks |
| `filler_words` | `false` | Strips "um/uh" noise |
| `endpointing` | `400` | Faster cut-off detection (ms) for low-latency feel |
| `utterance_end_ms` | `1200` | Finalize an utterance after 1.2 s silence |
| `vad_events` | `true` | Emit voice-activity start/stop events |
| `no_delay` | `true` | Skip server-side buffering |
| `keyterm` | up to 50 user-supplied terms | Domain vocabulary / proper-noun boosting |

Keyterm prompting is wired so users (or higher layers) can pass meeting-specific names and jargon — the Rust code URL-encodes each term and appends `&keyterm=…` ([deepgram_transcriber.rs:154-164](../src-tauri/src/deepgram_transcriber.rs#L154-L164)).

### 6.3 Gemini text/reasoning models — detail

| Model | Where it's used | Role |
|---|---|---|
| `gemini-3-flash-preview` | All transcription, summary, notes, email, KG extraction, single-meeting chat, cross-meeting synthesis, intent classifier, Knowledge Page direct query | Workhorse text model — strongest reasoning + transcription quality |
| `gemini-3.1-flash-lite` | Title gen, grounding verifier, OpenRouter agentic loop, **only** fallback in the chain | Cheap/fast model — every cost-sensitive call site uses this now |
| `gemini-2.5-flash` | Gemini-native agentic tool-calling loop (`agentChatAllMeetings`) | Stable native tool-calling; preview model not used here to keep tool-call schema reliable |

Fallback chain (`generateWithFallback` at [geminiService.ts:300-360](../src/services/geminiService.ts#L300)):

```
primary model (8 retries with exp. backoff)
   ↓ if all retries fail
gemini-3.1-flash-lite (4 retries)
   ↓
throw
```

### 6.4 Gemini image models — detail

| Model | Where it's used | Role |
|---|---|---|
| `gemini-3.1-flash-image-preview` | `generateConceptImage`, `generateNotesVisualization` | Primary — produces architecture diagrams + hand-drawn sketchnotes |
| `gemini-2.5-flash-image-preview` | Image fallback inside Gemini path | Used if the preview image model errors |
| `google/gemini-2.5-flash-image` | OpenRouter image default | Configurable via `VITE_OPENROUTER_IMAGE_MODEL` |
| `google/gemini-2.0-flash-exp` | OpenRouter image fallback | |

Image fallback chain is kept **inside Gemini** even when `VITE_AI_PROVIDER=openrouter` for the Gemini call sites; the OpenRouter image path is taken separately when the provider toggle is OpenRouter and image generation is requested.

### 6.5 Embedding models — detail

| Model | Where it's used | Role |
|---|---|---|
| `gemini-embedding-001` | KG topic embeddings, meeting-summary embeddings, Turbopuffer chunk vectors | Primary — pinned because vector dim must match the Turbopuffer namespace |
| `text-embedding-004` | Gemini fallback when `embedding-001` errors | Same family, dim-compatible |
| `openai/text-embedding-3-large` | OpenRouter equivalent | Chosen specifically because dim matches `gemini-embedding-001` so Turbopuffer + caches stay consistent across provider toggles |

Embedding helpers: [lib/knowledgeGraph.utils.ts](../src/lib/knowledgeGraph.utils.ts) — `batchEmbed`, `buildTopicEmbedText`, `buildMeetingEmbedText`, `findCanonicalTopicIdByEmbedding`.

### 6.6 Provider routing summary

```
                  ┌─────────────────────────────┐
                  │  VITE_AI_PROVIDER selector  │
                  └──────────────┬──────────────┘
                                 │
                ┌────────────────┴────────────────┐
                ▼                                 ▼
        ┌───────────────┐                ┌─────────────────┐
        │  Gemini API   │                │   OpenRouter    │
        └───────┬───────┘                └────────┬────────┘
                │                                 │
    ┌───────────┼──────────┐               ┌──────┴───────┐
    ▼           ▼          ▼               ▼              ▼
  TEXT       IMAGE    EMBEDDINGS       TEXT/TOOLS         EMBEDDINGS
3-flash-pv  3.1-img   embed-001        google/3-pv        openai/3-large
3.1-lite    2.5-img   text-embed-004   google/3.1-lite
2.5-flash                              google/2.5-img

                  (independent path, no provider toggle)
                                 │
                                 ▼
                  ┌─────────────────────────────┐
                  │   Deepgram WS — nova-3      │
                  │   Realtime STT only         │
                  └─────────────────────────────┘
```

---

## 7. Service Layer (src/services)

| Service | Lines | Role |
|---|---|---|
| [geminiService.ts](../src/services/geminiService.ts) | 2201 | All AI calls — transcription, generation, chat, KG extraction, image generation, File API uploads |
| [audioService.ts](../src/services/audioService.ts) | 416 | Audio batching, silence-aware splitting, WAV encoding, MIME normalization |
| [nativeRecorderService.ts](../src/services/nativeRecorderService.ts) | 100 | Thin wrapper over Tauri invoke commands for native recording |
| [audioDeviceService.ts](../src/services/audioDeviceService.ts) | 162 | Input-device enumeration & persistence |
| [permissionService.ts](../src/services/permissionService.ts) | 41 | Mic / screen-recording permission probes |
| [awsAuthService.ts](../src/services/awsAuthService.ts) | 444 | Cognito user pool (sign-in/up, refresh, Hosted UI, Google federation) |
| [awsService.ts](../src/services/awsService.ts) | 423 | REST client for the AWS Lambda API (tasks, assets, notes, chat, KG, contacts, workspaces, folders) |
| [awsLedgerService.ts](../src/services/awsLedgerService.ts) | 266 | Persists per-user "indexed" sets (Turbopuffer + KG) to Lambda; debounced batch writer |
| [awsShareService.ts](../src/services/awsShareService.ts) | 172 | Share creation, verification, invitation emails |
| [supabaseService.ts](../src/services/supabaseService.ts) | 725 | Legacy/secondary persistence path mirroring `awsService` |
| [chatRetrievalService.ts](../src/services/chatRetrievalService.ts) | 673 | RAG orchestrator — combines lexical + vector retrieval, builds chat context |
| [ragService.ts](../src/services/ragService.ts) | 248 | BM25 retrieval, speaker-aware chunking, phrase matching, query expansion |
| [turbopufferService.ts](../src/services/turbopufferService.ts) | 306 | Hybrid (BM25 + vector) search via Turbopuffer; upserts meeting chunks |
| [workspaceService.ts](../src/services/workspaceService.ts) | 293 | CRUD for workspaces, folders, membership |
| [workspaceSelection.ts](../src/services/workspaceSelection.ts) | 48 | Active-workspace state in localStorage |
| [shareService.ts](../src/services/shareService.ts) | 316 | Public share URL generation |
| [sharedChatService.ts](../src/services/sharedChatService.ts) | 68 | Chat on a shared meeting (no auth) |
| [appCache.ts](../src/services/appCache.ts) | 124 | In-memory + IndexedDB caches for lightweight task metadata |
| [progressStorage.ts](../src/services/progressStorage.ts) | 218 | Persistent recording/processing progress (recover on reload) |
| [userLedgerService.ts](../src/services/userLedgerService.ts) | 283 | Per-user processed-set helpers used by KG and Turbopuffer |

### 7.1 Gemini orchestration — key exports
- `processAudioBatch(batch, prompt)` — transcribe a single chunk with retry/fallback.
- `uploadAudioToFileAPI`, `waitForFileActive`, `transcribeViaFileAPI`, `deleteFromFileAPI` — File API path for >25 MB audio.
- `generateMeetingTitle`, `generateSummary`, `generateNotes`, `generateEmailContent`, `generateWikiContent`, `, .
- `chatWithNotes` (single-meeting) — with `enforceGroundedAnswer` verification pass.
- `agentPlanQuery` + `agentSynthesizeFromEvidence` + `agentChatAllMeetings` — multi-meeting agentic loop with `search_notes` tool.
- `extractKnowledgeGraph` — pulls topics/decisions/people/action items as JSON.
- `generateConceptImage`, `generateNotesVisualization` — image generation paths.

### 7.2 Retrieval pipeline
1. **Chunking** ([ragService.ts](../src/services/ragService.ts)): speaker-aware, overlapping windows, with stop-word filtering and pre-computed BM25 term vectors.
2. **Lexical scoring**: BM25 + phrase matching + query intent detection (`detectQueryIntent`).
3. **Vector search** ([turbopufferService.ts](../src/services/turbopufferService.ts)): chunks embedded via `embedQuery` and stored in the `lumina-meetings` namespace; queries return hybrid (BM25 + vector) results combined with Reciprocal Rank Fusion (`RRF_K = 60`).
4. **Fusion** ([chatRetrievalService.ts](../src/services/chatRetrievalService.ts)): merges lexical and Turbopuffer results, builds a token-budgeted evidence pack with cite-ready chunks, and assembles the system context for the LLM.

### 7.3 Knowledge graph
[lib/knowledgeGraph.utils.ts](../src/lib/knowledgeGraph.utils.ts) (1463 lines) handles:
- Per-meeting topic extraction (`extractKnowledgeGraph` → `gemini-3-flash-preview`).
- Topic canonicalization via embedding cosine similarity (`findCanonicalTopicIdByEmbedding`).
- Heuristic relationships (`computeHeuristicRelationships`) + LLM-extracted contextual relationships (`extractContextualRelationships`).
- Meeting-to-meeting edge matrix (`buildMeetingEdgeMatrix`) and final graph data for ForceGraph2D (`buildGraphData`).
- Embedding + relationship caches in `localStorage` ([lib/kgEmbedCache.ts](../src/lib/kgEmbedCache.ts), [lib/kgArtifactCache.ts](../src/lib/kgArtifactCache.ts), [lib/kgLedger.ts](../src/lib/kgLedger.ts)).

---

## 8. AWS Backend

### 8.1 API Lambda
- Path: [aws/api/](../aws/api/) — Node 20 Lambda packaged with esbuild.
- Single handler in [aws/api/src/index.ts](../aws/api/src/index.ts) (914 LOC) routes by URL segments using a `switch (resource)` block.
- Auth: every authenticated route verifies a Cognito ID token with `aws-jwt-verify` ([CognitoJwtVerifier](../aws/api/src/index.ts#L31-L35)).
- DB: Postgres on RDS via `pg.Pool` in [aws/api/src/db.ts](../aws/api/src/db.ts) (5 connections, SSL, 60s idle).
- Cold-start idempotent migrations: ensures `task_history.attendees` column + GIN index exist ([index.ts:14-21](../aws/api/src/index.ts#L14-L21)).

#### REST surface (all under `${VITE_API_GATEWAY_URL}`)

| Route prefix | Handler | Purpose |
|---|---|---|
| `GET /shares/verify/:token` | `handleShareVerify` | **Public** route — share-link validation, drives Vercel OG previews |
| `tasks` | `handleTasks` | CRUD on meetings; paginated GET with filters |
| `assets` | `handleAssets` | Generated emails / wikis stored per task |
| `notes` | `handleNotes` | Manual notes (Tiptap docs) |
| `knowledge-graph` | `handleKnowledgeGraph` | Persisted KG entries per task |
| `chat` | `handleChat` | Chat-history persistence (thread-aware, citations & retrieval metadata) |
| `shares` | `handleShares` | Create / list / revoke shared meetings + invitation emails |
| `ledger` | `handleLedger` | Persists per-user "already indexed" sets and KG artifact blob |
| `storage/presign` | `handleStorage` | Issues S3 PUT presigned URLs (10-min expiry) for audio uploads |
| `workspaces` | `handleWorkspaces` | Workspace CRUD + member management |
| `folders` | `handleFolders` | Folder CRUD + meeting↔folder pinning |
| `contacts` | `handleContacts` | Derived contact list aggregated from meetings |

Invitation email delivery: tries Resend (`RESEND_API_KEY`) and falls back to SES; templated HTML at [index.ts:76-153](../aws/api/src/index.ts#L76).

### 8.2 RDS PostgreSQL schema
Migrations live in [aws/](../aws/):

| File | Tables |
|---|---|
| [migration.sql](../aws/migration.sql) | `task_history`, `generated_assets`, `manual_notes`, `knowledge_graph`, `chat_history`, `shared_meetings`, `shared_meeting_access`, `user_ledger_state` |
| [workspace_migration.sql](../aws/workspace_migration.sql) | `workspaces`, `workspace_members`, `folders`, `task_workspaces`, `task_folders` |
| [workspace_metadata_migration.sql](../aws/workspace_metadata_migration.sql) | Extra workspace metadata columns |
| [attendees_migration.sql](../aws/attendees_migration.sql) | `task_history.attendees` JSONB |

Key design notes:
- All tables UUID-keyed (`gen_random_uuid()` via `pgcrypto`).
- User scoping is enforced at the Lambda layer (no Postgres RLS).
- `task_history` is the central table; nearly everything references it `ON DELETE CASCADE`.
- `user_ledger_state` stores: `turbopuffer_indexed_ids` (JSONB), `kg_extracted_ids` (JSONB), `kg_artifact_fingerprint`, `kg_artifact_data` — lets the client skip already-processed meetings.
- `updated_at` columns auto-maintained by an `update_updated_at_column()` trigger on `manual_notes`, `knowledge_graph`, `shared_meetings`, `workspaces`.

### 8.3 S3
- Bucket: `VITE_S3_BUCKET` in `VITE_AWS_REGION` (default `us-east-1`).
- Audio files uploaded directly from the client via Lambda-issued presigned PUT URLs (`POST /storage/presign`).
- `task_history.audio_url` stores the S3 key; downloads use presigned GETs (handled per-feature where needed).

### 8.4 Cognito
- User pool: `VITE_COGNITO_USER_POOL_ID` + `VITE_COGNITO_CLIENT_ID` (+ optional secret).
- Hosted UI: domain resolved by [awsAuthService.ts:49-74](../src/services/awsAuthService.ts#L49-L74) from `VITE_COGNITO_AUTH_ORIGIN` or `VITE_COGNITO_DOMAIN`.
- Google federation: identity-provider name from `VITE_COGNITO_IDENTITY_PROVIDER` (default `Google`).
- OAuth redirect: `VITE_WEB_OAUTH_REDIRECT_URI` in production; `window.location.origin` locally.
- PKCE verifier stored under localStorage key `wisprnote_cognito_pkce_verifier`.
- Custom `ICognitoStorage` impl bridges Tauri's secure storage when running natively.

### 8.5 SES / Resend
- From-address: `SES_FROM_EMAIL` (default `noreply@wisprnote.com`).
- Public site URL for share links: `WISPRNOTE_PUBLIC_URL` (default `https://www.wisprnote.com`).
- Resend used when `RESEND_API_KEY` present; otherwise SES SDK.

---

## 9. Supabase (Secondary Path)

[src/services/supabaseService.ts](../src/services/supabaseService.ts) (725 LOC) mirrors the AWS service surface against Supabase — tasks, assets, manual notes, KG entries, chat history. SQL migrations sit at the repo root (`supabase_*.sql`). The Supabase path is used for some legacy/shared-chat flows where Cognito auth isn't in play; the primary persistence is AWS RDS via Lambda.

---

## 10. Turbopuffer Vector Store

- SDK: `@turbopuffer/turbopuffer` v1.22.
- Region: `gcp-us-central1`, namespace: `lumina-meetings`.
- Auth: `VITE_TURBOPUFFER_API_KEY`.
- Indexing flow: each chunk gets `chunkIndex`, `text`, `speakers`, and a vector from `gemini-embedding-001` (1536-dim). Upserted by [`upsertMeetingChunks`](../src/services/turbopufferService.ts#L56).
- Query flow: `queryHybrid` performs BM25 + vector search, fuses with RRF (`k=60`), returns top-N chunks with metadata.
- Indexing state is tracked per-user in `user_ledger_state.turbopuffer_indexed_ids` so re-runs are idempotent.
- Backfill: [`backfillExistingMeetings`](../src/services/turbopufferService.ts) walks the user's meetings and indexes any not yet present in the ledger.

---

## 11. Recording & Transcription Pipeline

End-to-end flow when a user records and processes a meeting:

```
1.  User picks input device (audioDeviceService) and accepts permissions
2.  Recording starts:
    a. Batch mode  → MediaRecorder in browser OR Tauri start_system_audio
    b. Realtime    → Tauri start_realtime_audio → Deepgram WS
3.  Audio is staged:
    - Batch:  audioService chunks into overlapping windows (silence-aware)
    - File:   if total >25 MB → uploadAudioToFileAPI (Gemini File API)
4.  Transcription:
    - processAudioBatch per chunk OR transcribeViaFileAPI for big files
    - Both use gemini-3-flash-preview (with fallback chain)
5.  Post-processing (parallel):
    - generateMeetingTitle (gemini-3.1-flash-lite, whole-meeting context)
    - generateSummary, generateNotes (gemini-3-flash-preview)
    - extractKnowledgeGraph → saveKnowledgeGraph (Lambda)
    - chunkTranscription → Turbopuffer upsertMeetingChunks
6.  Persistence: saveTask → POST /tasks (audio_url already in S3)
7.  UI navigates to Notes view
```

If the client crashes mid-process, [progressStorage.ts](../src/services/progressStorage.ts) restores partial state on reload.

---

## 12. Knowledge Graph Pipeline

```
1. extractKnowledgeGraph (gemini-3-flash-preview)
   → JSON: {topics, decisions, people, actionItems, references}
2. batchEmbed all topic texts + meeting summaries (gemini-embedding-001)
   → cached in localStorage (kgEmbedCache) keyed by content hash
3. Topic canonicalization (findCanonicalTopicIdByEmbedding)
   → cosine similarity threshold groups synonymous topics across meetings
4. Relationships:
   - computeHeuristicRelationships (people-overlap, action-item references)
   - extractContextualRelationships (LLM call across meeting summaries)
5. buildMeetingEdgeMatrix + buildGraphData
   → nodes/links payload for react-force-graph-2d on KnowledgePage
6. KGBuildArtifact persisted to user_ledger_state.kg_artifact_data
   so subsequent loads skip re-extraction unless fingerprint changes
```

---

## 13. Chat & Agentic Search

### 13.1 Single-meeting chat (`chatWithNotes`)
1. `chatRetrievalService` builds a `RetrievalPlan` from BM25 + Turbopuffer.
2. System prompt is constructed from summary + notes + ranked chunks.
3. `gemini-3-flash-preview` answers with `temperature=0.15`.
4. `enforceGroundedAnswer` (`gemini-3.1-flash-lite`) verifies every claim against context and rewrites unsupported ones.

### 13.2 All-meetings agentic chat (`agentChatAllMeetings`)
A tool-calling loop with up to 5 steps:
- Gemini path uses `gemini-2.5-flash` + a `search_notes` function tool ([geminiService.ts:1454](../src/services/geminiService.ts#L1454)).
- OpenRouter path uses `google/gemini-3.1-flash-lite` with OpenAI-compatible `tool_choice` ([geminiService.ts:1378](../src/services/geminiService.ts#L1378)).
- On the second-to-last step, a synthesis nudge is injected forcing the model to commit to an answer.
- Final step removes tools entirely so the model must produce text.

---

## 14. Sharing & Public Previews

- Owner creates a share via `POST /shares` → row in `shared_meetings` with a 22-char random token, `access_type` (`public` | `restricted`), `permissions` (subset of `notes`, `summary`, `chat`), optional `expires_at`.
- Restricted shares enumerate invitee emails in `shared_meeting_access`; invites are emailed via Resend/SES.
- Share URL: `https://www.wisprnote.com/shared/{token}` ([shareService.ts:302](../src/services/shareService.ts#L302)).
- Vercel edge functions in [api/](../api/) generate Open Graph previews:
  - [api/share-html.ts](../api/share-html.ts) renders an OG-tagged HTML shell.
  - [api/_sharePreview.ts](../api/_sharePreview.ts) fetches title/description from `GET /shares/verify/:token`.
- In-app view: [pages/SharedMeetingPage.tsx](../src/pages/SharedMeetingPage.tsx) renders the shared meeting; [sharedChatService.ts](../src/services/sharedChatService.ts) powers chat on shared meetings without requiring Cognito sign-in (when the share permits `chat`).

---

## 15. MCP Server

Path: [mcp-server/](../mcp-server/) — a standalone Node binary that exposes WisprNote data to Claude / other MCP-compatible clients over stdio.

- Transport: `StdioServerTransport` from `@modelcontextprotocol/sdk` v1.
- Connects directly to the same RDS Postgres (env: `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`, `WISPRNOTE_USER_ID`).
- Tools exposed (in [mcp-server/src/index.ts](../mcp-server/src/index.ts)):
  - `list_meetings` — paginated meeting metadata
  - `get_meeting_details` — full task row
  - `search_meetings` — keyword search across transcripts/summaries
  - `get_knowledge_graph` — per-task or all KG entries
  - `get_meeting_assets` — generated emails/wikis
  - `get_action_items` — flattened action items from KG
  - `get_people` — aggregated people across meetings

Install via `npm run build` inside `mcp-server/`, then add to Claude Desktop's `claude_desktop_config.json` with the env vars above.

---

## 16. Environment Variables (Authoritative)

Read from `.env.local` at build time via Vite's `import.meta.env`. See [.env.example](../.env.example).

| Var | Required when | Purpose |
|---|---|---|
| `VITE_AI_PROVIDER` | optional | `gemini` (default) or `openrouter` |
| `VITE_GEMINI_API_KEY` / `GEMINI_API_KEY` | provider=gemini | Gemini API calls |
| `VITE_OPENROUTER_API_KEY` | provider=openrouter | OpenRouter calls |
| `VITE_OPENROUTER_IMAGE_MODEL` | optional | Image-model override for OR path |
| `VITE_OPENROUTER_EMBED_MODEL` | optional | Embedding-model override for OR path |
| `DEEPGRAM_API_KEY` | realtime mode | Passed into `start_realtime_audio` |
| `VITE_TURBOPUFFER_API_KEY` | RAG enabled | Turbopuffer client |
| `VITE_API_GATEWAY_URL` | always (AWS path) | Lambda REST base URL |
| `VITE_S3_BUCKET` | audio uploads | S3 bucket name |
| `VITE_AWS_REGION` | always | Defaults to `us-east-1` |
| `VITE_COGNITO_USER_POOL_ID` | auth | Cognito pool |
| `VITE_COGNITO_CLIENT_ID` | auth | App client |
| `VITE_COGNITO_CLIENT_SECRET` | optional | Confidential client secret |
| `VITE_COGNITO_DOMAIN` | auth | Hosted-UI domain prefix or full origin |
| `VITE_COGNITO_AUTH_ORIGIN` | optional | Custom-domain origin |
| `VITE_COGNITO_IDENTITY_PROVIDER` | optional | Defaults `Google` |
| `VITE_WEB_OAUTH_REDIRECT_URI` | production | OAuth callback (no trailing slash) |
| `VITE_SUPABASE_URL` + `VITE_SUPABASE_ANON_KEY` | shared/legacy paths | Supabase client |
| (Lambda-side) `DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD` | always | RDS connection |
| (Lambda-side) `COGNITO_USER_POOL_ID`, `COGNITO_CLIENT_ID` | always | JWT verification |
| (Lambda-side) `S3_BUCKET`, `AWS_REGION` | always | Presign endpoint |
| (Lambda-side) `SES_FROM_EMAIL`, `RESEND_API_KEY`, `WISPRNOTE_PUBLIC_URL` | sharing | Invite emails |

---

## 17. Build, Run, Deploy

### Frontend (web)
```bash
npm install
npm run dev          # vite dev server on :3000
npm run build        # vite build → dist/
npm run preview      # serve built bundle
npm run lint         # tsc --noEmit
npm test             # vitest run
```

### Desktop (Tauri)
```bash
npm run tauri:dev    # native dev window (auto-runs vite)
npm run tauri:build  # produces signed .app/.dmg/.exe per platform
```

### AWS Lambda API
```bash
cd aws/api
npm install
npm run build        # esbuild bundle → dist/index.js
npm run deploy       # zips and updates the wisprnote-api Lambda (profile wisprnote)
```

### MCP server
```bash
cd mcp-server
npm install
npm run build        # tsc → dist/index.js
# then point Claude Desktop at dist/index.js
```

### Vercel edge (share previews)
[vercel.json](../vercel.json) routes `/shared/:token` to [api/share-html.ts](../api/share-html.ts). Deployed automatically on Vercel.

---

## 18. Operational Notes

- **Idempotency**: Turbopuffer and KG extraction both consult `user_ledger_state` to skip already-processed meetings; the artifact blob is fingerprint-checked.
- **Cost controls**: Title generation, grounding verifier, and the OpenRouter agentic loop all use the cheap `gemini-3.1-flash-lite`; the title call samples beginning + middle + end of the transcript and caps output at 24 tokens; KG extraction has a single retry path with a simplified prompt; embeddings are cached in `localStorage` keyed by content hash.
- **Failure handling**: `generateWithFallback` retries the primary model 8× then drops down the fallback chain (4× each). File API uploads have their own retry with `isFileApiDisabledByFailures` circuit breaker.
- **Tauri vs web**: AWS service calls switch between `@tauri-apps/plugin-http` and `globalThis.fetch` based on `window.__TAURI_INTERNALS__` detection — this avoids the browser CORS preflight when running natively.
- **Logging**: Every service uses a scoped logger (`logger.scope('AWSAuth')`, `'Turbopuffer'`, `'Gemini'`, …) so log filtering is consistent across console + Tauri sinks.

---

## 19. Related Documents

- [AI_MODELS_AND_EXTERNAL_SOURCES.md](AI_MODELS_AND_EXTERNAL_SOURCES.md) — model-by-model call-site index.
- [AWS_CLOUD_SERVICES_ARCHITECTURE_DEEP_DIVE.md](AWS_CLOUD_SERVICES_ARCHITECTURE_DEEP_DIVE.md) — AWS deep dive.
- [OVERALL_PROJECT_ARCHITECTURE_DEEP_DIVE.md](OVERALL_PROJECT_ARCHITECTURE_DEEP_DIVE.md) — broader architecture deep dive.
- [../AI_model.md](../AI_model.md) — original short-form model summary.
- [../PROJECT_DOCUMENTATION.md](../PROJECT_DOCUMENTATION.md) — older project doc.
- [../README.md](../README.md) — public-facing readme.
