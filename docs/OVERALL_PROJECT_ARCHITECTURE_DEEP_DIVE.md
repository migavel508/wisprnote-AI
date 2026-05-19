# Wisprnote Architecture Deep Dive

Last updated: 2026-05-18
Scope: `desktop/` with primary focus on `desktop/Lumina-AI-/`

## 1. Executive Summary

Wisprnote is not a single web SPA. It is a multi-surface product with one dominant runtime:

- a React + TypeScript application in `Lumina-AI-/src`
- packaged as a Tauri desktop app with native Rust capabilities in `Lumina-AI-/src-tauri`
- backed by AWS for auth, API, storage, email, and the primary application database
- augmented by external AI and retrieval services such as Gemini, OpenRouter, Deepgram, and Turbopuffer
- accompanied by a separate `website/` marketing/legal frontend and a Vercel share-preview layer

The current codebase shows an architecture transition:

- the active frontend CRUD/auth path is AWS-based (`awsAuthService`, `awsService`, `awsShareService`, `awsLedgerService`)
- a legacy/parallel Supabase service layer still exists in the repo (`supabaseService`, root SQL files, older docs)
- some internal docs and MCP setup text still describe the older Supabase-centered model and are no longer fully accurate

Operationally, the product is a meeting intelligence desktop system:

1. authenticate the user
2. capture or upload audio
3. transcribe and enrich it with AI
4. persist meetings, assets, notes, chat, and graph state
5. retrieve meeting evidence for chat
6. expose meeting sharing and external tool access

## 2. Repository Topology

At the workspace root:

```text
desktop/
├── Lumina-AI-/                     # primary product codebase
│   ├── src/                        # React frontend
│   ├── src-tauri/                  # Tauri + Rust native runtime
│   ├── aws/                        # AWS Lambda API package + RDS schema
│   ├── api/                        # Vercel functions for share preview HTML
│   ├── mcp-server/                 # MCP bridge for external AI tools
│   ├── record_system_audio/        # auxiliary Rust audio experiments/tools
│   ├── supabase/                   # older migration area
│   └── vercel.json                 # SPA/share-preview deployment routing
├── website/                        # separate marketing/legal website
├── PROJECT_DESCRIPTION.md          # high-level root overview
└── PROJECT_FULL_DOCUMENTATION.md   # broad inventory, partially ahead of older docs
```

For actual runtime behavior, `Lumina-AI-/` is the main application. `website/` is a separate public-facing site, not the core meeting workstation.

## 3. Runtime Layers

### 3.1 Presentation Layer

The UI is a React 19 application built with Vite and TypeScript.

Primary UI surfaces:

- `ProcessPage.tsx` for recording/upload and processing
- `HistoryPage.tsx` for meeting history
- `NotesPage.tsx` for transcript/summary/notes editing
- `ChatPage.tsx` for meeting and cross-meeting chat
- `KnowledgePage.tsx` for the knowledge graph
- `AssetsPage.tsx` for generated artifacts
- `SharedMeetingPage.tsx` for public/restricted share consumption
- `AudioDevicesPage.tsx` for audio device inspection and switching

The route/view model is mostly derived in `src/App.tsx`, where URL families are mapped to internal views such as `process`, `history`, `notes`, `chat`, `knowledge`, `notebooks`, `audio-devices`, and `shared`.

### 3.2 Native Desktop Layer

The desktop shell is Tauri 2, configured in `src-tauri/tauri.conf.json`.

Native responsibilities:

- system audio recording
- realtime transcription orchestration
- microphone/screen permission handling
- default input/output device inspection and mutation
- system tray integration
- deep-link handling with the `wisprnote://` scheme

The Rust entry point in `src-tauri/src/lib.rs` exposes commands such as:

- `start_system_audio`
- `stop_system_audio`
- `start_realtime_audio`
- `stop_realtime_audio`
- `list_audio_devices`
- `set_default_input_device`
- `check_permissions`

This keeps audio and OS integration outside the browser sandbox and gives the desktop build capabilities the web build cannot offer safely or reliably.

### 3.3 Application Service Layer

The frontend is service-heavy. The important service families are:

- `awsAuthService.ts`: Cognito auth/session/OAuth orchestration
- `awsService.ts`: primary CRUD gateway for meetings, assets, notes, graph, chat, storage presign, pending queue
- `awsShareService.ts`: share lifecycle and share verification
- `awsLedgerService.ts`: user ledger persistence for indexing and graph artifacts
- `geminiService.ts`: transcription and generative AI workflows
- `turbopufferService.ts`: vector indexing and hybrid search
- `chatRetrievalService.ts`: meeting-selection and evidence assembly
- `ragService.ts`: local chunking and BM25 fallback retrieval
- `nativeRecorderService.ts`: Tauri bridge for capture/transcription
- `audioService.ts`: browser-side audio preprocessing and batch splitting
- `audioDeviceService.ts`: device enumeration and default-device changes

### 3.4 Cloud/Backend Layer

The active backend path is AWS-centered:

- Cognito for identity
- API Gateway URL exposed to the frontend via `VITE_API_GATEWAY_URL`
- Lambda code in `aws/api/src/index.ts`
- PostgreSQL schema in `aws/migration.sql`
- S3 presigned uploads for note images
- SES for share invite emails

This is the primary persistence/auth/control plane used by the current UI.

## 4. End-to-End Product Flows

### 4.1 Authentication Flow

Current auth is implemented in `src/services/awsAuthService.ts`.

Supported paths:

- email/password sign-up and sign-in through Cognito user pools
- Google sign-in through Cognito Hosted UI with PKCE
- desktop deep-link callback via `wisprnote://auth-callback/`
- web callback using a configurable `VITE_WEB_OAUTH_REDIRECT_URI`

Important implementation traits:

- Cognito session data is stored via a custom storage adapter with localStorage fallback and in-memory backup
- stale Supabase browser storage is explicitly removed on load to avoid Tauri WebView quota pressure
- the app prefers Cognito ID tokens for downstream API authorization

### 4.2 Audio Ingestion Flow

There are two main ingestion modes:

1. Native recording path
2. File upload path

#### Native recording path

`nativeRecorderService.ts` calls Tauri commands to:

- record system + microphone audio in batch mode
- stream realtime audio into Deepgram-backed transcription
- emit interim/final transcript events back to the UI

This path is desktop-specific and depends on macOS-capable Rust modules such as:

- `system_audio.rs`
- `deepgram_transcriber.rs`
- `audio_device.rs`
- `device_monitor.rs`
- `permissions.rs`

#### File upload path

`audioService.ts` preprocesses uploaded audio.

Capabilities include:

- silence-aware splitting
- overlap between batches
- noise gating
- normalization
- fallback to raw file upload when browser decoding is unreliable

It also decides whether to:

- split locally into chunks
- or use the Gemini File API path for large files

The threshold constant is `FILE_API_THRESHOLD_MB = 25`.

### 4.3 Transcription and AI Enrichment Flow

`geminiService.ts` is the central AI orchestration layer.

Major operations:

- transcribe audio
- summarize meetings
- generate meeting titles
- produce structured notes
- generate concept images and note visualizations
- extract knowledge graph entries
- synthesize email/wiki/podcast-style outputs
- power chat synthesis on retrieved context

Provider model:

- default provider: Gemini
- alternative provider: OpenRouter

The code treats provider selection as runtime-configurable through `VITE_AI_PROVIDER`.

### 4.4 Persistence Flow

After AI enrichment, the app persists state through `awsService.ts`.

Persisted record families:

- `task_history`
- `generated_assets`
- `manual_notes`
- `knowledge_graph`
- `chat_history`
- `user_ledger_state`

This service is thin by design: it wraps HTTP calls to the AWS API and keeps the frontend decoupled from SQL.

### 4.5 Retrieval and Chat Flow

Retrieval is layered.

Primary path:

- chunk transcription
- embed chunks
- upsert/query them in Turbopuffer
- fuse ANN and BM25 ranking in `turbopufferService.ts`

Fallback path:

- local chunking
- local BM25-style scoring in `ragService.ts`

Coordination layer:

- `chatRetrievalService.ts` decides whether the query is single-meeting or cross-meeting
- constructs evidence blocks
- estimates token budgets
- returns structured retrieval plans and citations

This design gives the app a resilient retrieval strategy:

- better recall/precision when Turbopuffer is configured
- degraded but functional local retrieval when it is not

### 4.6 Knowledge Graph Flow

Knowledge extraction is performed in `geminiService.ts` and graph-building logic lives in `lib/knowledgeGraph.utils.ts`.

Pipeline stages:

1. extract topics, decisions, people, action items, and references from meetings
2. store per-meeting knowledge graph entries
3. embed topics/meetings
4. infer relationships across meetings
5. build a force-graph artifact for the UI
6. cache embeddings and built artifacts locally and remotely

Caching layers include:

- in-memory maps
- localStorage
- IndexedDB
- remote artifact/ledger persistence through `awsLedgerService.ts`

### 4.7 Sharing Flow

Sharing is split across three pieces:

- owner operations in `awsShareService.ts`
- public/restricted consumption in `SharedMeetingPage.tsx`
- preview metadata generation in `api/_sharePreview.ts` and `api/share-html.ts`

User-facing behavior:

- create a public or restricted share
- optionally add email-specific access records
- invite users by email
- verify access through a public backend route
- render a share page with OG tags for preview bots

## 5. Data Model

The current active AWS schema in `aws/migration.sql` defines eight primary tables.

### 5.1 `task_history`

Core meeting record:

- user_id-scoped
- transcription, summary, notes
- duration, prompt, personal note, visualization

This is the hub table for most downstream features.

### 5.2 `generated_assets`

Meeting-linked generated artifacts.

Current asset types in active TypeScript types:

- `email`
- `wiki`

### 5.3 `manual_notes`

Standalone notebook-style notes not tied directly to a single transcript lifecycle.

### 5.4 `knowledge_graph`

Per-meeting structured graph facts:

- topics
- decisions
- people
- action_items
- refs

Uniqueness is enforced per `(user_id, task_id)`.

### 5.5 `chat_history`

Stores user/model messages with:

- optional task binding
- thread identifiers
- citations
- retrieval metadata

### 5.6 `shared_meetings`

Stores share links and share policies:

- public vs restricted
- permissions array
- active/revoked status
- optional expiry

### 5.7 `shared_meeting_access`

Stores email allowlists and first-access timestamps for restricted shares.

### 5.8 `user_ledger_state`

Stores per-user system state that is not a meeting record:

- Turbopuffer-indexed meeting IDs
- KG-extracted meeting IDs
- optional serialized KG artifact snapshot

## 6. Integration Boundaries

### 6.1 Frontend to Native

Boundary mechanism:

- Tauri commands for request/response operations
- Tauri events for streaming or push-style updates

Examples:

- transcript streaming event: `realtime-transcript`
- audio device change event: `audio-device-change`
- tray-driven actions: `tray-record`

### 6.2 Frontend to AWS API

Boundary mechanism:

- JSON over HTTP
- Cognito ID token in the `Authorization` header
- Tauri HTTP plugin on desktop, `fetch` in browser contexts

This abstraction appears repeatedly in:

- `awsService.ts`
- `awsShareService.ts`
- `awsLedgerService.ts`

### 6.3 Frontend to AI Providers

The client directly calls:

- Google Generative Language APIs
- OpenRouter APIs
- Turbopuffer APIs

That means the frontend is not only a presentation layer; it also performs orchestration against third-party AI systems.

### 6.4 Backend to Data/Storage/Mail

The Lambda layer directly integrates with:

- PostgreSQL through `pg`
- S3 through `@aws-sdk/client-s3`
- SES through `@aws-sdk/client-ses`
- Cognito token verification through `aws-jwt-verify`

## 7. Deployment Surfaces

### 7.1 Desktop build

Built via:

- `npm run dev`
- `npm run tauri:dev`
- `npm run build`
- `npm run tauri:build`

Configured target surface:

- product name: `Wisprnote AI`
- identifier: `com.wisprnote.ai`
- minimum macOS version: `13.3`

### 7.2 Web build of the app

`Lumina-AI-/vercel.json` indicates the React app can also be deployed as a web build, especially for share pages.

Important behavior:

- `/shared/:token` rewrites to a Vercel function
- all other routes rewrite to `index.html`

### 7.3 Marketing/legal website

`website/` is a separate Vite React site. It contains:

- home/marketing content
- pricing
- privacy
- terms
- refund

It should be treated as a separate deployment unit from the desktop/web app runtime in `Lumina-AI-/`.

### 7.4 MCP server

`mcp-server/` is another deployable unit.

Purpose:

- expose Wisprnote data to Claude Desktop, Cursor, Windsurf, and other MCP clients

Current implementation:

- connects directly to the PostgreSQL database
- scopes results to a configured `WISPRNOTE_USER_ID`

## 8. Active Architecture vs Legacy/Parallel Code

This codebase contains architectural drift. That matters for anyone extending it.

### Active path

The active application shell is AWS-centric:

- `awsAuthService.ts`
- `awsService.ts`
- `awsShareService.ts`
- `awsLedgerService.ts`
- `aws/api/src/index.ts`
- `aws/migration.sql`

### Legacy/parallel path

These remain in the repo but are not the main current runtime path:

- `supabaseService.ts`
- root SQL files such as `supabase_chat_history.sql`
- some older docs referencing Supabase-first auth and storage
- `shareService.ts`, which mirrors share behavior outside the active AWS service naming

### Documentation drift

Examples of stale assumptions:

- `Lumina-AI-/PROJECT_DOCUMENTATION.md` still describes Supabase as the main auth/data backend
- `mcp-server/README.md` and `mcp-server/.env.example` still describe Supabase credentials, but `mcp-server/src/index.ts` now expects PostgreSQL credentials

Anyone making infrastructure decisions should trust the current code paths over older prose.

## 9. Strengths of the Current Design

- Clear separation between UI, native shell, and backend API
- Good degradation path for retrieval when vector search is unavailable
- Strong desktop affordances for recording and device control
- Share architecture cleanly separates owner operations from public verification
- Ledger/caching design avoids recomputation of expensive indexing and graph operations

## 10. Architectural Tensions and Risks

### 10.1 Multi-backend residue

The repo still carries Supabase-era services and docs. That increases onboarding cost and creates a real risk of extending the wrong layer.

### 10.2 Client-heavy orchestration

The frontend directly talks to multiple AI providers and retrieval systems. That keeps iteration fast, but it also means:

- more secrets/config are relevant at the client edge
- more runtime behavior lives outside the AWS API boundary
- web and desktop threat models differ

### 10.3 Mixed deployment story

The product spans:

- Tauri desktop
- Vercel web/share layer
- AWS API/data plane
- third-party AI services

That is workable, but operational ownership needs to be explicit because failures can appear in any one of those planes.

### 10.4 MCP drift

The MCP bridge has already moved from one backend assumption to another, but its docs have not kept up. That is an integration reliability risk.

## 11. Practical Mental Model for Contributors

If you need to reason about the system quickly, use this model:

```text
User action
  -> React page/component
  -> frontend service
     -> Tauri command/event        (desktop-specific work)
     -> AWS API                    (auth, persistence, share control, ledger)
     -> Gemini/OpenRouter          (AI generation/extraction)
     -> Turbopuffer                (vector indexing/retrieval)
  -> persisted meeting/graph/share state
  -> retrieval/chat/visualization surfaces
```

And if you need to decide which code is authoritative:

- auth/session: `awsAuthService.ts`
- data CRUD: `awsService.ts`
- share behavior: `awsShareService.ts` + `aws/api/src/index.ts`
- DB shape: `aws/migration.sql`
- native desktop capability: `src-tauri/src/*`
- legacy reference only: `supabaseService.ts` and older docs

## 12. Suggested Next Cleanup Targets

Not required for the product to run, but worth tracking:

1. retire or clearly label unused Supabase-first docs/services
2. align `mcp-server` README and `.env.example` with the current PostgreSQL implementation
3. centralize the authoritative architecture docs in one `docs/` area
4. decide which flows are supported for web-only vs desktop-only and document that boundary explicitly

