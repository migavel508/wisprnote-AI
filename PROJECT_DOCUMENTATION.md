# Wisprnote AI - Complete Project Documentation

## Table of Contents
1. [Project Overview](#project-overview)
2. [Architecture & Tech Stack](#architecture--tech-stack)
3. [Project Structure](#project-structure)
4. [Core Features](#core-features)
5. [Services & APIs](#services--apis)
6. [Components & Pages](#components--pages)
7. [Database Schema](#database-schema)
8. [Environment Configuration](#environment-configuration)
9. [Setup & Installation](#setup--installation)
10. [Development Workflow](#development-workflow)
11. [Deployment](#deployment)
12. [AI Models Used](#ai-models-used)
13. [Key Workflows](#key-workflows)
14. [Security & Authentication](#security--authentication)
15. [Performance Optimizations](#performance-optimizations)

---

## Project Overview

**Wisprnote AI** is an intelligent meeting transcription and knowledge management platform that transforms audio recordings into actionable insights. The application leverages Google's Gemini AI models to provide real-time transcription, automated summarization, structured note generation, knowledge graph extraction, and AI-powered asset creation.

### Key Capabilities
- Audio transcription with speaker detection
- AI-powered meeting summaries and structured notes
- Interactive knowledge graph visualization
- Multi-format asset generation (PPT, Reports, Emails, Wiki/PRD)
- AI chat assistant for meeting notes
- AI podcast generation from meetings
- Notion-like manual note-taking with slash commands
- Personal meeting annotations

### Target Users
- Business professionals conducting meetings
- Researchers and academics
- Content creators and podcasters
- Teams requiring meeting documentation
- Knowledge workers managing information

---

## Architecture & Tech Stack

### Frontend Framework
- **React 19.0.0** - UI library with hooks and functional components
- **TypeScript 5.8.2** - Type-safe development
- **Vite 6.2.0** - Build tool and dev server
- **React Router DOM 7.13.1** - Client-side routing

### UI & Styling
- **Tailwind CSS 4.1.14** - Utility-first CSS framework
- **Motion 12.23.24** (Framer Motion) - Animation library
- **Lucide React 0.546.0** - Icon library

### AI & ML Services
- **Google Gemini AI** (`@google/genai` 1.29.0)
  - Primary: `gemini-3-flash-preview`
  - Image: `gemini-2.5-flash-image`
  - Fallbacks: `gemini-3.1-flash-lite-preview`
- **OpenRouter SDK 0.9.11** - Knowledge graph extraction

### Backend & Database
- **Supabase 2.97.0** - PostgreSQL database, authentication, storage
- **Row-Level Security (RLS)** - Data isolation per user

### Rich Text Editing
- **TipTap 3.21.0** - Headless rich text editor
  - Extensions: StarterKit, Image, Link, Placeholder, Suggestion
  - Custom slash command system (Notion-like)

### Document Generation
- **PptxGenJS 4.0.1** - PowerPoint generation
- **docx 9.6.0** - Word document generation
- **file-saver 2.0.5** - Client-side file downloads

### Data Visualization
- **react-force-graph-2d 1.29.1** - Knowledge graph visualization
- **react-markdown 10.1.0** - Markdown rendering
- **remark-gfm 4.0.1** - GitHub Flavored Markdown support

### Audio Processing
- **Web Audio API** - Browser-native audio decoding
- **Custom downsampling** - 16kHz optimization for Gemini API
- **Batch processing** - Parallel transcription with concurrency limits

---

## Project Structure

```
Lumina-AI-/
├── src/
│   ├── App.tsx                    # Main application orchestrator (2294 lines)
│   ├── main.tsx                   # React entry point
│   ├── index.css                  # Global styles
│   ├── types.ts                   # Global TypeScript interfaces
│   │
│   ├── components/
│   │   ├── Auth.tsx               # Supabase authentication UI
│   │   ├── MainSidebar.tsx        # Primary navigation sidebar
│   │   ├── Sidebar.tsx            # Secondary sidebar (legacy)
│   │   ├── Skeleton.tsx           # Loading state components
│   │   └── ManualNotes/
│   │       ├── SlashEditor.tsx    # Notion-like slash command editor
│   │       ├── ManualNoteEditor.tsx   # Standalone note editor
│   │       ├── ManualNotesList.tsx    # Notes list view
│   │       └── MeetingNoteTab.tsx     # Inline meeting note tab
│   │
│   ├── pages/
│   │   ├── ProcessPage.tsx       # Audio upload & transcription
│   │   ├── HistoryPage.tsx       # Meeting history list
│   │   ├── NotesPage.tsx         # Meeting notes viewer (4 tabs)
│   │   ├── ChatPage.tsx          # AI chat with notes
│   │   ├── AssetsPage.tsx        # Generated assets viewer
│   │   └── KnowledgePage.tsx     # Knowledge graph visualization
│   │
│   └── services/
│       ├── geminiService.ts      # Gemini AI API integration (754 lines)
│       ├── supabaseService.ts    # Database & auth operations (504 lines)
│       └── audioService.ts       # Audio processing utilities (192 lines)
│
├── supabase_rls_migration.sql    # Database RLS policies
├── supabase_knowledge_graph.sql  # Knowledge graph schema
├── supabase_chat_history.sql     # Chat history schema
├── package.json                  # Dependencies
├── vite.config.ts                # Vite configuration
├── tsconfig.json                 # TypeScript configuration
├── .env.local                    # Environment variables
└── .env.example                  # Environment template
```

---

## Core Features

### 1. Audio Transcription Pipeline

**Upload Methods:**
- File upload (drag-and-drop or file picker)
- Live microphone recording with pause/resume

**Processing Flow:**
1. Audio file validation and MIME type normalization
2. Audio downsampling to 16kHz (reduces batch count by ~60%)
3. Split into 15MB chunks (~491 seconds per chunk at 16kHz)
4. Parallel batch processing (3 concurrent batches)
5. Exponential backoff retry logic for API failures
6. Real-time progress tracking with batch status

**Transcription Features:**
- Speaker detection and labeling
- Filler word preservation (um, uh, etc.)
- Inaudible section marking
- Verbatim transcription mode
- Custom prompt support for context

**Technical Implementation:**
```typescript
// Audio downsampling (audioService.ts)
- Original: 44.1kHz → 15MB = ~178 seconds
- Downsampled: 16kHz → 15MB = ~491 seconds
- Result: 30-min meeting = 4 batches instead of 11

// Parallel processing (App.tsx)
const BATCH_CONCURRENCY = 3;
const batchPromises = [];
for (let i = 0; i < batches.length; i += BATCH_CONCURRENCY) {
  const chunk = batches.slice(i, i + BATCH_CONCURRENCY);
  await Promise.all(chunk.map(processWithRetry));
}
```

### 2. AI-Powered Insights

**Summary Generation:**
- Executive summary with key points
- Action items extraction
- Decision tracking
- Participant identification

**Structured Notes:**
- Hierarchical organization
- Topic segmentation
- Timestamp references
- Markdown formatting

**Meeting Title Generation:**
- Context-aware title suggestions
- One-click regeneration
- Automatic filename updates

### 3. Knowledge Graph

**Extraction Process:**
- Automatic background extraction for new meetings
- 3-second delay between API calls (rate limit protection)
- Auto-sync system comparing history vs. existing graph data
- Persistent storage in Supabase

**Visualization:**
- Force-directed graph layout (react-force-graph-2d)
- Node click → auto-center and zoom (2x, 1000ms animation)
- ResizeObserver for responsive canvas sizing
- Color-coded node types
- Interactive exploration

**Data Structure:**
```typescript
interface KnowledgeGraphEntry {
  id?: string;
  user_id?: string;
  task_id: string;
  node_id: string;
  node_label: string;
  node_type: string;
  connections: string[];  // Array of connected node IDs
  created_at?: string;
}
```

### 4. Asset Generation

**Supported Formats:**

**PowerPoint (PPT):**
- Title slide with meeting metadata
- Content slides with bullet points
- Summary slide
- Automatic layout and styling
- Download as .pptx

**Report (DOCX):**
- Executive summary section
- Detailed findings
- Action items
- Recommendations
- Download as .docx

**Email:**
- Professional email template
- Meeting recap
- Action items
- Next steps
- Copy to clipboard

**Wiki/PRD:**
- Structured documentation
- Technical specifications
- Requirements breakdown
- Markdown format
- Copy to clipboard

**Implementation:**
```typescript
// Asset generation flow
1. User selects asset type
2. AI generates structured content via Gemini
3. Content formatted into document/template
4. File generated client-side (pptxgenjs/docx)
5. Saved to Supabase with task_id reference
6. Available for download/view in Assets page
```

### 5. AI Chat Assistant

**Capabilities:**
- Context-aware responses using meeting transcription
- Multi-turn conversations
- Image upload support (vision model)
- Chat history persistence per meeting
- Markdown rendering of responses

**Technical Details:**
- Model: `gemini-3-flash-preview`
- Context injection: Full transcription + chat history
- Streaming responses (optional)
- Supabase storage for conversation threads

### 6. AI Podcast Generation

**Features:**
- Script generation from meeting content
- Host/Guest dialogue format
- Natural conversation flow
- Interactive chat with podcast script
- Real-time script refinement

**Workflow:**
1. Generate podcast script from transcription
2. Review and edit script
3. Chat with AI to refine content
4. Export final script

### 7. Notion-Like Manual Notes

**Slash Command System:**
- Type `/` to open command menu
- 10 block types: Text, H1, H2, H3, Bullet List, Numbered List, Quote, Code, Divider, Image
- Fuzzy search filtering
- Keyboard navigation (arrows, enter, escape)
- No static toolbar (pure slash commands)

**Features:**
- Rich text editing with TipTap
- Image upload to Supabase storage
- Auto-save (1.5s debounce)
- Title + content structure
- Standalone notebooks page
- Inline meeting notes (4th tab)

**Two Use Cases:**

**Standalone Notebooks:**
- Accessible via sidebar → Notebooks
- Create/edit/delete independent notes
- Full-page editor experience
- Stored in `manual_notes` table

**Meeting Personal Notes:**
- 4th tab in meeting notes view ("My Note")
- Private annotations per meeting
- Linked to `task_history.personal_note`
- Auto-saves to meeting record

### 8. Meeting Notes Viewer

**Four Tabs:**
1. **Transcription** - Raw verbatim transcription with speaker labels
2. **Summary** - AI-generated executive summary
3. **Notes** - Structured notes with topics and key points
4. **My Note** - Personal annotations with slash editor (NEW)

**Features:**
- Tab-based navigation
- Markdown rendering for AI-generated content
- Rich text editing for personal notes
- Generate AI title button
- Navigate to assets
- Responsive layout

---

## Services & APIs

### geminiService.ts (754 lines)

**Core Functions:**

```typescript
// Retry utility with exponential backoff
withRetry<T>(fn, maxRetries=5, baseDelayMs=2000): Promise<T>
- Retries on: 429, 500, 502, 503, 504, network errors
- Exponential delay: baseDelay * 2^attempt + random jitter
- Logs retry attempts with status codes

// Model fallback system
generateWithFallback(requestOptions, fallbackModels): Promise<GenerateContentResponse>
- Primary: gemini-3-flash-preview
- Fallbacks: gemini-3.1-flash-lite-preview, gemini-3-flash-preview
- Automatic model switching on 503/429 errors

// Audio transcription
processAudioBatch(batch, prompt): Promise<ProcessResult>
- Converts audio blob to base64
- Sends to Gemini with transcription prompt
- Returns verbatim text with speaker labels

// Content generation
generateSummary(transcription): Promise<string>
generateNotes(transcription): Promise<string>
generateMeetingTitle(transcription): Promise<string>

// Asset generation
generatePPTContent(transcription): Promise<PPTSlide[]>
generateReportContent(transcription): Promise<ReportSection[]>
generateEmailContent(transcription): Promise<EmailContent>
generateWikiContent(transcription): Promise<string>

// Interactive features
chatWithNotes(transcription, chatHistory, userMessage, imageBase64?): Promise<string>
generatePodcastScript(transcription): Promise<PodcastScript>
chatWithPodcast(script, chatHistory, userMessage): Promise<string>

// Knowledge graph
extractKnowledgeGraph(transcription): Promise<KnowledgeGraphData>
- Uses OpenRouter API
- Extracts nodes and relationships
- Returns structured JSON

// Image generation
generateConceptImage(prompt): Promise<string>
- Model: gemini-2.5-flash-image
- Returns base64 image data
```

**Error Handling:**
- Comprehensive retry logic for transient failures
- Status code extraction from nested error objects
- Graceful degradation with fallback models
- Detailed error logging

### supabaseService.ts (504 lines)

**Database Operations:**

```typescript
// Authentication
supabase.auth.getUser()
supabase.auth.signOut()

// Task (Meeting) Management
saveTask(task: TaskHistory): Promise<TaskHistory>
getTasks(): Promise<TaskHistory[]>
getTasksLightweight(page, pageSize): Promise<{data, hasMore, total}>
updateTaskTitle(taskId, newTitle): Promise<TaskHistory>
updatePersonalNote(taskId, content): Promise<void>
deleteTask(taskId): Promise<void>

// Asset Management
saveAsset(asset: GeneratedAsset): Promise<GeneratedAsset>
getAssets(taskId): Promise<GeneratedAsset[]>
deleteAsset(assetId): Promise<void>

// Knowledge Graph
saveKnowledgeGraphBatch(entries: KnowledgeGraphEntry[]): Promise<void>
getKnowledgeGraph(): Promise<KnowledgeGraphEntry[]>

// Chat History
saveChatMessage(message: ChatMessage): Promise<ChatMessage>
getChatHistory(taskId): Promise<ChatMessage[]>

// Manual Notes
saveManualNote(note: ManualNote): Promise<ManualNote>
getManualNotes(): Promise<ManualNote[]>
deleteManualNote(noteId): Promise<void>
uploadNoteImage(file: File): Promise<string>
```

**Data Interfaces:**

```typescript
interface TaskHistory {
  id?: string;
  created_at?: string;
  user_id?: string;
  filename: string;
  transcription: string;
  summary?: string;
  notes?: string;
  audio_url?: string;
  status: 'completed' | 'error';
  duration: number;
  prompt?: string;
  personal_note?: string;  // NEW: Personal annotations
}

interface GeneratedAsset {
  id?: string;
  created_at?: string;
  user_id?: string;
  task_id: string;
  type: 'ppt' | 'report' | 'email' | 'wiki';
  filename: string;
  content: any;  // JSON structure
}

interface KnowledgeGraphEntry {
  id?: string;
  user_id?: string;
  task_id: string;
  node_id: string;
  node_label: string;
  node_type: string;
  connections: string[];
  created_at?: string;
}

interface ChatMessage {
  id?: string;
  user_id?: string;
  task_id: string;
  role: 'user' | 'model';
  content: string;
  image_url?: string;
  created_at?: string;
}

interface ManualNote {
  id?: string;
  user_id?: string;
  title: string;
  content: string;
  created_at?: string;
  updated_at?: string;
}
```

### audioService.ts (192 lines)

**Audio Processing:**

```typescript
// Audio batch interface
interface AudioBatch {
  blob: Blob;
  mimeType: string;
  index: number;
  total: number;
  startTime: number;
  endTime: number;
}

// Main splitting function
splitAudio(file: File, maxChunkSizeMB=15): Promise<AudioBatch[]>
- Decodes audio using AudioContext
- Downsamples to 16kHz (linear interpolation)
- Splits into time-based chunks
- Encodes each chunk as WAV
- Fallback: returns single batch if decode fails

// Utility functions
normalizeMimeType(raw: string): string
encodeWAV(samples: Float32Array, sampleRate: number): Blob
blobToBase64(blob: Blob): Promise<string>
```

**Downsampling Algorithm:**
```typescript
// Linear interpolation downsampling
const targetRate = 16000;
const ratio = audioBuffer.sampleRate / targetRate;
const downsampled = new Float32Array(Math.floor(samples.length / ratio));

for (let i = 0; i < downsampled.length; i++) {
  const srcIndex = i * ratio;
  const srcIndexFloor = Math.floor(srcIndex);
  const srcIndexCeil = Math.min(srcIndexFloor + 1, samples.length - 1);
  const t = srcIndex - srcIndexFloor;
  downsampled[i] = samples[srcIndexFloor] * (1 - t) + samples[srcIndexCeil] * t;
}
```

---

## Components & Pages

### Components

**Auth.tsx** - Supabase authentication
- Email/password login
- Magic link authentication
- Sign up flow
- Session management

**MainSidebar.tsx** - Primary navigation
- 8 navigation items: Process, Notes, Chat, Assets, Notebooks, Agents, Knowledge, History
- Status indicator (idle/processing)
- User profile display
- Sign out functionality
- Responsive mobile overlay

**SlashEditor.tsx** - Notion-like editor (NEW)
- 10 slash commands with icons
- Fuzzy search filtering
- Keyboard navigation
- Image upload support
- Auto-save integration
- Reusable across app

**ManualNoteEditor.tsx** - Standalone note editor
- Title input field
- SlashEditor integration
- Auto-save with debounce
- Save status indicator
- Back navigation

**ManualNotesList.tsx** - Notes list view
- Search functionality
- Create new note button
- Note selection
- Delete confirmation
- Empty state

**MeetingNoteTab.tsx** - Inline meeting note editor
- SlashEditor for personal notes
- Linked to task_id
- Auto-save to task_history.personal_note
- Save status indicator

**Skeleton.tsx** - Loading states
- NotesPageSkeleton
- HistoryPageSkeleton
- Shimmer animations
- Responsive layouts

### Pages

**ProcessPage.tsx** (26,405 bytes)
- Audio upload interface
- Live recording controls
- Batch processing visualization
- Progress tracking
- Error handling
- Custom prompt input

**HistoryPage.tsx** (12,946 bytes)
- Meeting list with pagination
- Search and filter
- Delete confirmation
- Task selection
- Metadata display
- Empty state

**NotesPage.tsx** (7,278 bytes)
- 4-tab interface (Transcription, Summary, Notes, My Note)
- Generate AI title button
- Navigate to assets
- Markdown rendering
- SlashEditor for personal notes
- Responsive layout

**ChatPage.tsx** (13,533 bytes)
- Chat interface with AI
- Message history
- Image upload support
- Context injection
- Markdown rendering
- Auto-scroll

**AssetsPage.tsx** (12,348 bytes)
- Asset type selection (PPT, Report, Email, Wiki)
- Generation interface
- Asset history list
- Download functionality
- Preview/copy options
- Loading states

**KnowledgePage.tsx** (57,284 bytes)
- Force-directed graph visualization
- Build/rebuild controls
- Auto-sync system
- Node interaction
- Progress tracking
- Responsive canvas

---

## Database Schema

### Supabase Tables

**task_history**
```sql
CREATE TABLE public.task_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  transcription TEXT NOT NULL,
  summary TEXT,
  notes TEXT,
  audio_url TEXT,
  status TEXT NOT NULL CHECK (status IN ('completed', 'error')),
  duration INTEGER NOT NULL,
  prompt TEXT,
  personal_note TEXT,  -- NEW: Personal annotations
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_task_history_user_id ON task_history(user_id);
CREATE INDEX idx_task_history_created_at ON task_history(created_at DESC);

-- RLS Policies
ALTER TABLE task_history ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own tasks"
  ON task_history FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own tasks"
  ON task_history FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own tasks"
  ON task_history FOR UPDATE
  USING (auth.uid() = user_id);

CREATE POLICY "Users can delete own tasks"
  ON task_history FOR DELETE
  USING (auth.uid() = user_id);
```

**generated_assets**
```sql
CREATE TABLE public.generated_assets (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('ppt', 'report', 'email', 'wiki')),
  filename TEXT NOT NULL,
  content JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_assets_task_id ON generated_assets(task_id);
CREATE INDEX idx_assets_user_id ON generated_assets(user_id);

-- RLS Policies (similar to task_history)
```

**knowledge_graph**
```sql
CREATE TABLE public.knowledge_graph (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  node_id TEXT NOT NULL,
  node_label TEXT NOT NULL,
  node_type TEXT NOT NULL,
  connections TEXT[] NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(user_id, task_id, node_id)
);

-- Indexes
CREATE INDEX idx_kg_user_task ON knowledge_graph(user_id, task_id);
CREATE INDEX idx_kg_node_id ON knowledge_graph(node_id);

-- RLS Policies (similar to task_history)
```

**chat_history**
```sql
CREATE TABLE public.chat_history (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  task_id UUID NOT NULL REFERENCES task_history(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('user', 'model')),
  content TEXT NOT NULL,
  image_url TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Indexes
CREATE INDEX idx_chat_task_id ON chat_history(task_id, created_at);
CREATE INDEX idx_chat_user_id ON chat_history(user_id);

-- RLS Policies (similar to task_history)
```

**manual_notes**
```sql
CREATE TABLE public.manual_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Auto-update trigger
CREATE OR REPLACE FUNCTION public.set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

CREATE TRIGGER manual_notes_updated_at
  BEFORE UPDATE ON public.manual_notes
  FOR EACH ROW EXECUTE PROCEDURE public.set_updated_at();

-- Indexes
CREATE INDEX idx_manual_notes_user_id ON manual_notes(user_id);
CREATE INDEX idx_manual_notes_updated_at ON manual_notes(updated_at DESC);

-- RLS Policies (similar to task_history)
```

### Supabase Storage

**note_images** bucket
```sql
-- Storage bucket for note images
INSERT INTO storage.buckets (id, name, public)
VALUES ('note_images', 'note_images', true)
ON CONFLICT DO NOTHING;

-- Policies
CREATE POLICY "Auth users can upload note images"
  ON storage.objects FOR INSERT
  TO authenticated
  WITH CHECK (bucket_id = 'note_images');

CREATE POLICY "Public can read note images"
  ON storage.objects FOR SELECT
  USING (bucket_id = 'note_images');

CREATE POLICY "Auth users can delete note images"
  ON storage.objects FOR DELETE
  TO authenticated
  USING (bucket_id = 'note_images');
```

---

## Environment Configuration

### Required Environment Variables

**.env.local**
```bash
# Gemini AI API Key (REQUIRED)
GEMINI_API_KEY=your_gemini_api_key_here

# Supabase Configuration (REQUIRED)
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key_here

# OpenRouter API Key (REQUIRED for Knowledge Graph)
VITE_OPENROUTER_API_KEY=sk-or-v1-your_openrouter_key_here

# Optional: Deepgram API Key (for future features)
VITE_DEEPGRAM_API_KEY=your_deepgram_key_here

# App URL (auto-injected in AI Studio)
APP_URL=http://localhost:3000
```

### Configuration Files

**vite.config.ts**
```typescript
export default defineConfig(({mode}) => {
  const env = loadEnv(mode, '.', '');
  return {
    plugins: [react(), tailwindcss()],
    define: {
      'process.env.GEMINI_API_KEY': JSON.stringify(env.GEMINI_API_KEY),
    },
    resolve: {
      alias: {
        '@': path.resolve(__dirname, '.'),
      },
    },
    server: {
      hmr: process.env.DISABLE_HMR !== 'true',
    },
  };
});
```

**tsconfig.json**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "lib": ["ES2022", "DOM", "DOM.Iterable"],
    "jsx": "react-jsx",
    "moduleResolution": "bundler",
    "types": ["vite/client"],
    "paths": {
      "@/*": ["./*"]
    },
    "skipLibCheck": true,
    "allowImportingTsExtensions": true,
    "noEmit": true
  }
}
```

---

## Setup & Installation

### Prerequisites
- Node.js 18+ (recommended: 20+)
- npm or yarn
- Supabase account
- Google Gemini API key
- OpenRouter API key

### Step-by-Step Setup

**1. Clone the repository**
```bash
git clone <repository-url>
cd Lumina-AI-
```

**2. Install dependencies**
```bash
npm install
```

**3. Configure environment variables**
```bash
cp .env.example .env.local
# Edit .env.local with your API keys
```

**4. Set up Supabase**

Create a new Supabase project, then run these SQL migrations in order:

```bash
# 1. RLS policies
psql -h your-db-host -U postgres -d postgres -f supabase_rls_migration.sql

# 2. Knowledge graph schema
psql -h your-db-host -U postgres -d postgres -f supabase_knowledge_graph.sql

# 3. Chat history schema
psql -h your-db-host -U postgres -d postgres -f supabase_chat_history.sql

# 4. Manual notes table (run in SQL Editor)
CREATE TABLE public.manual_notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT 'Untitled',
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

# 5. Personal note column (run in SQL Editor)
ALTER TABLE public.task_history
  ADD COLUMN IF NOT EXISTS personal_note TEXT;

# 6. Create storage bucket (run in SQL Editor)
INSERT INTO storage.buckets (id, name, public)
VALUES ('note_images', 'note_images', true)
ON CONFLICT DO NOTHING;
```

**5. Start development server**
```bash
npm run dev
```

Application will be available at `http://localhost:3000`

**6. Build for production**
```bash
npm run build
npm run preview  # Test production build locally
```

---

## Development Workflow

### Running Locally
```bash
npm run dev          # Start dev server on port 3000
npm run build        # Build for production
npm run preview      # Preview production build
npm run lint         # TypeScript type checking
npm run clean        # Remove dist folder
```

### Code Organization

**Component Structure:**
- Functional components with hooks
- TypeScript interfaces for props
- Separated concerns (UI, logic, data)
- Reusable components in `/components`
- Page-level components in `/pages`

**State Management:**
- React useState for local state
- useRef for mutable values
- useEffect for side effects
- Props drilling for simple cases
- Context API not used (app size manageable)

**Styling Approach:**
- Tailwind utility classes
- Inline styles for dynamic values
- No CSS modules
- Motion library for animations
- Responsive design (mobile-first)

### Key Development Patterns

**Error Handling:**
```typescript
try {
  const result = await withRetry(() => apiCall());
  // Handle success
} catch (error) {
  console.error('Operation failed:', error);
  setError(error.message);
  // Show user-friendly error
}
```

**Async Operations:**
```typescript
// Parallel processing
const results = await Promise.all(
  batches.map(batch => processAudioBatch(batch, prompt))
);

// Sequential with concurrency limit
for (let i = 0; i < items.length; i += CONCURRENCY) {
  const chunk = items.slice(i, i + CONCURRENCY);
  await Promise.all(chunk.map(processItem));
}
```

**Auto-save Pattern:**
```typescript
const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

const scheduleSave = () => {
  if (saveTimerRef.current) clearTimeout(saveTimerRef.current);
  saveTimerRef.current = setTimeout(() => handleSave(), 1500);
};

useEffect(() => { scheduleSave(); }, [content, title]);
```

---

## Deployment

### AI Studio Deployment
The application is designed for deployment on Google AI Studio.

**Automatic Configuration:**
- `GEMINI_API_KEY` injected from user secrets
- `APP_URL` injected with Cloud Run service URL
- HMR disabled via `DISABLE_HMR=true`

**Deployment Steps:**
1. Push code to AI Studio
2. Configure secrets in AI Studio UI
3. Deploy via AI Studio interface
4. Application auto-deployed to Cloud Run

### Manual Deployment (Vercel/Netlify)

**Vercel:**
```bash
npm install -g vercel
vercel --prod
```

**Netlify:**
```bash
npm install -g netlify-cli
netlify deploy --prod
```

**Environment Variables:**
Set all required variables in deployment platform dashboard.

### Docker Deployment (Optional)

**Dockerfile:**
```dockerfile
FROM node:20-alpine
WORKDIR /app
COPY package*.json ./
RUN npm ci --only=production
COPY . .
RUN npm run build
EXPOSE 3000
CMD ["npm", "run", "preview"]
```

**Build & Run:**
```bash
docker build -t wisprnote-ai .
docker run -p 3000:3000 --env-file .env.local wisprnote-ai
```

---

## AI Models Used

### Primary Models

**1. gemini-3-flash-preview**
- Audio transcription (batch processing)
- Meeting summaries
- Structured notes generation
- Chat assistant responses
- Asset content generation (PPT, Reports, Emails, Wiki)
- Podcast script generation
- Meeting title generation

**2. gemini-2.5-flash-image**
- Concept image generation
- Visual flowcharts and diagrams
- Image-based explanations

**3. OpenRouter (via OpenRouter SDK)**
- Knowledge graph extraction
- Structured JSON parsing
- Node and relationship identification

### Fallback Chain

```typescript
Primary: gemini-3-flash-preview
  ↓ (on 503/429 error)
Fallback 1: gemini-3.1-flash-lite-preview
  ↓ (on 503/429 error)
Fallback 2: gemini-3-flash-preview (retry)
```

### Model Selection Rationale

**gemini-3-flash-preview:**
- Fast response times
- High accuracy for text tasks
- Cost-effective for high-volume processing
- Multimodal support (audio, text, images)

**gemini-2.5-flash-image:**
- Specialized for image generation
- Better visual quality than text-only models
- Consistent styling

**OpenRouter:**
- Flexible model selection
- Free tier available
- Good for structured data extraction

---

## Key Workflows

### 1. Audio Transcription Workflow

```
User uploads audio file
  ↓
Validate file (MIME type, size)
  ↓
Decode audio with AudioContext
  ↓
Downsample to 16kHz (linear interpolation)
  ↓
Split into 15MB chunks (~491s each)
  ↓
Process batches in parallel (3 concurrent)
  ↓
Each batch: Convert to base64 → Send to Gemini → Parse response
  ↓
Combine batch results into full transcription
  ↓
Generate summary, notes, title in parallel
  ↓
Save to Supabase (task_history)
  ↓
Navigate to Notes page
```

### 2. Knowledge Graph Extraction Workflow

```
User opens Knowledge page
  ↓
Check if graph exists for any meetings
  ↓
If missing: Auto-sync system activates
  ↓
For each meeting without graph:
  - Wait 3 seconds (rate limit)
  - Extract graph via OpenRouter
  - Parse JSON response
  - Save to knowledge_graph table
  ↓
Load all graph data from Supabase
  ↓
Render force-directed graph
  ↓
User interactions:
  - Click node → center and zoom
  - Resize window → canvas adapts
```

### 3. Asset Generation Workflow

```
User selects asset type (PPT/Report/Email/Wiki)
  ↓
Click "Generate" button
  ↓
Send transcription to Gemini with specific prompt
  ↓
Parse structured response (JSON)
  ↓
Format into document:
  - PPT: pptxgenjs → .pptx file
  - Report: docx → .docx file
  - Email: HTML template → clipboard
  - Wiki: Markdown → clipboard
  ↓
Save asset metadata to generated_assets table
  ↓
Download file or copy to clipboard
  ↓
Show in asset history list
```

### 4. Manual Note Creation Workflow

```
User navigates to Notebooks page
  ↓
Click "New Note" button
  ↓
Editor opens with empty title and content
  ↓
User types title
  ↓
User types "/" in content area
  ↓
Slash command menu appears
  ↓
User selects command (e.g., "Heading 1")
  ↓
Block inserted into editor
  ↓
User continues editing
  ↓
Auto-save triggers after 1.5s of inactivity
  ↓
Save to manual_notes table
  ↓
Show "Saved" indicator
  ↓
User clicks "Back" → return to notes list
```

### 5. Meeting Personal Note Workflow

```
User opens meeting from history
  ↓
Navigate to Notes page
  ↓
Click "My Note" tab (4th tab)
  ↓
Slash editor loads with existing personal_note content
  ↓
User edits with slash commands
  ↓
Auto-save triggers after 1.5s
  ↓
Update task_history.personal_note column
  ↓
Show "Saved" indicator
  ↓
Note persists with meeting record
```

---

## Security & Authentication

### Supabase Authentication

**Supported Methods:**
- Email/password
- Magic link (passwordless)
- OAuth providers (configurable)

**Session Management:**
```typescript
// Check session on app load
useEffect(() => {
  supabase.auth.getSession().then(({ data: { session } }) => {
    setSession(session);
  });

  // Listen for auth changes
  const { data: { subscription } } = supabase.auth.onAuthStateChange(
    (_event, session) => {
      setSession(session);
    }
  );

  return () => subscription.unsubscribe();
}, []);
```

### Row-Level Security (RLS)

**All tables enforce RLS:**
```sql
-- Example policy
CREATE POLICY "Users can select own tasks"
  ON task_history FOR SELECT
  USING (auth.uid() = user_id);
```

**Benefits:**
- Data isolation per user
- No data leakage between users
- Database-level security (not just app-level)
- Automatic filtering of queries

### API Key Security

**Best Practices:**
- API keys stored in environment variables
- Never committed to version control
- Server-side injection in production
- Client-side keys for Supabase (anon key is safe)

**Gemini API Key:**
```typescript
// Injected at build time
const ai = new GoogleGenAI({ 
  apiKey: process.env.GEMINI_API_KEY || "" 
});
```

### Storage Security

**note_images bucket:**
- Public read access (for <img> tags)
- Authenticated write access
- User can only delete own uploads
- No sensitive data in image URLs

---

## Performance Optimizations

### 1. Audio Processing

**Downsampling:**
- 44.1kHz → 16kHz reduces batch count by 60%
- 30-min meeting: 11 batches → 4 batches
- Faster processing, lower API costs

**Parallel Processing:**
- 3 concurrent batches instead of sequential
- ~3x faster for multi-batch files
- Controlled concurrency prevents rate limits

**Retry Logic:**
- Exponential backoff prevents API hammering
- Automatic recovery from transient failures
- Preserves user data on errors

### 2. Database Queries

**Pagination:**
```typescript
getTasksLightweight(page, pageSize)
- Fetches only metadata (no transcription/notes)
- Reduces payload size by ~90%
- Faster list rendering
```

**Lazy Loading:**
- Full task data loaded only when selected
- Chat history loaded per meeting
- Assets loaded on-demand

**Indexes:**
```sql
CREATE INDEX idx_task_history_user_id ON task_history(user_id);
CREATE INDEX idx_task_history_created_at ON task_history(created_at DESC);
```

### 3. Frontend Optimizations

**Code Splitting:**
- React.lazy for route-based splitting
- Vite automatic chunking
- Smaller initial bundle

**Memoization:**
```typescript
const memoizedValue = useMemo(() => 
  expensiveComputation(data), 
  [data]
);
```

**Debouncing:**
```typescript
// Auto-save with 1.5s debounce
const scheduleSave = () => {
  if (timerRef.current) clearTimeout(timerRef.current);
  timerRef.current = setTimeout(handleSave, 1500);
};
```

**Virtual Scrolling:**
- Not yet implemented (future optimization)
- Would benefit large meeting lists

### 4. Asset Generation

**Client-Side Processing:**
- PPT/DOCX generated in browser
- No server round-trip for file creation
- Instant downloads

**Caching:**
- Generated assets stored in Supabase
- Regeneration only on user request
- Reduces redundant API calls

### 5. Knowledge Graph

**Auto-Sync Optimization:**
- 3-second delay between extractions
- Background processing (non-blocking)
- Only extracts missing graphs
- Incremental updates

**Canvas Performance:**
- ResizeObserver instead of window resize
- Debounced resize handler
- Efficient force simulation

---

## Future Enhancements

### Planned Features
1. Real-time collaborative editing
2. Audio playback with timestamp sync
3. Export to more formats (PDF, CSV)
4. Advanced search across all meetings
5. Meeting templates and presets
6. Integration with calendar apps
7. Mobile app (React Native)
8. Voice commands for note-taking
9. Multi-language transcription
10. Speaker diarization improvements

### Technical Improvements
1. Implement virtual scrolling for large lists
2. Add service worker for offline support
3. Optimize bundle size with tree shaking
4. Add E2E testing (Playwright/Cypress)
5. Implement GraphQL for complex queries
6. Add Redis caching layer
7. Migrate to monorepo structure
8. Add CI/CD pipeline
9. Implement feature flags
10. Add analytics and monitoring

---

## Troubleshooting

### Common Issues

**1. Transcription fails with 503 error**
- Cause: Gemini API overloaded
- Solution: Retry logic automatically handles this
- Manual: Wait a few minutes and retry

**2. Audio upload fails**
- Cause: Unsupported format or file too large
- Solution: Convert to supported format (WAV, MP3, WebM)
- Check: File size < 100MB recommended

**3. Knowledge graph not building**
- Cause: OpenRouter API key missing or invalid
- Solution: Check VITE_OPENROUTER_API_KEY in .env.local
- Verify: API key has credits/quota

**4. Images not uploading in notes**
- Cause: Supabase storage bucket not configured
- Solution: Run storage bucket SQL migration
- Check: Bucket policies allow authenticated uploads

**5. Personal notes not saving**
- Cause: personal_note column missing
- Solution: Run ALTER TABLE migration
- Verify: Column exists in task_history table

**6. Build fails with TypeScript errors**
- Cause: Type mismatches or missing imports
- Solution: Run `npm run lint` to see all errors
- Fix: Update types or add missing imports

### Debug Mode

**Enable verbose logging:**
```typescript
// In geminiService.ts
console.log('[Gemini] Request:', requestOptions);
console.log('[Gemini] Response:', response);

// In App.tsx
console.log('[App] Current state:', { status, batches, error });
```

**Check Supabase logs:**
- Go to Supabase Dashboard → Logs
- Filter by table or function
- Check for RLS policy violations

**Network inspection:**
- Open browser DevTools → Network tab
- Filter by "gemini" or "supabase"
- Check request/response payloads

---

## Contributing

### Code Style
- Use TypeScript for all new code
- Follow existing naming conventions
- Add comments for complex logic
- Keep functions small and focused
- Write self-documenting code

### Commit Messages
```
feat: Add slash command for code blocks
fix: Resolve auto-save race condition
docs: Update setup instructions
refactor: Extract audio processing logic
perf: Optimize knowledge graph rendering
```

### Pull Request Process
1. Create feature branch from main
2. Implement changes with tests
3. Update documentation
4. Submit PR with description
5. Address review feedback
6. Merge after approval

---

## License

This project is proprietary software. All rights reserved.

---

## Support

For issues, questions, or feature requests:
- GitHub Issues: [repository-url]/issues
- Email: support@wisprnote.ai
- Documentation: [docs-url]

---

## Acknowledgments

- Google Gemini AI team for powerful models
- Supabase team for excellent backend platform
- TipTap team for extensible editor
- React and Vite communities
- All open-source contributors

---

**Last Updated:** March 30, 2026
**Version:** 1.0.0
**Maintained By:** Wisprnote AI Team
