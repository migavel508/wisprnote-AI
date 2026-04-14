# 🎙️ Wisprnote AI

<div align="center">
  <img src="./wisprnoteai.png" alt="Wisprnote AI Interface" width="100%" />
</div>

<p align="center">
  <b>A beautiful, intelligent workspace for your meetings, thoughts, and knowledge.</b>
</p>

<p align="center">
  <a href="#features">Features</a> •
  <a href="#tech-stack">Tech Stack</a> •
  <a href="#getting-started">Getting Started</a> •
  <a href="#database-setup">Database Setup</a>
</p>

---

## ✨ Features

- **🎙️ Real-time Voice Transcription:** Lightning-fast, highly accurate voice-to-text powered by Deepgram Nova 3. Captures your thoughts as you speak.
- **🧠 AI Knowledge Processing:** Automated summarization, action item extraction, and deep insights powered by Google Gemini.
- **🕸️ Interactive Knowledge Graph:** Visualize your notes, connections, and ideas in a dynamic, responsive 2D graph.
- **💬 Contextual AI Chat:** Converse with an AI assistant that remembers your past meetings and notes, providing context-aware answers.
- **☁️ Secure & Synced:** Powered by Supabase for reliable authentication, row-level security, and seamless cloud synchronization.
- **🖥️ Cross-Platform:** Designed for the modern web with an elegant, responsive UI, and available as a native desktop application via Tauri.
- **📤 Export Anywhere:** Easily export your processed notes and insights to Markdown, Microsoft Word (`.docx`), and PowerPoint (`.pptx`).

## 🛠️ Tech Stack

**Frontend & Design**
- React 19 + TypeScript
- Vite + Tailwind CSS v4
- Framer Motion (for smooth micro-animations)

**Backend & Data**
- Supabase (PostgreSQL, Auth, Edge Functions)

**AI & Voice**
- Deepgram SDK (Real-time Speech-to-Text)
- Google GenAI / OpenRouter (LLM, Summarization, Chat)

**Desktop**
- Tauri (Cross-platform desktop application packaging)

## 🚀 Getting Started

### Prerequisites
- Node.js (v18+)
- Active [Deepgram](https://deepgram.com/) and [Google Gemini](https://ai.google.dev/) API Keys
- A [Supabase](https://supabase.com/) project

### Installation

1. **Clone the repository:**
   ```bash
   git clone <your-repo-url>
   cd Lumina-AI-
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Environment Setup:**
   Create a `.env.local` file in the root directory (you can copy `.env.example`) and add your keys:
   ```env
   VITE_GEMINI_API_KEY=your_gemini_api_key
   VITE_DEEPGRAM_API_KEY=your_deepgram_api_key
   VITE_SUPABASE_URL=your_supabase_url
   VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
   ```

4. **Run the Development Server:**
   ```bash
   npm run dev
   ```
   The application will be available at `http://localhost:3000`.

### Desktop Development (Tauri)

To run the desktop application natively:
```bash
npm run tauri:dev
```

To build for production:
```bash
npm run tauri:build
```

## 🗄️ Database Setup

To enable the backend features (Auth, Chat History, Knowledge Graph), ensure you have applied the provided Supabase migrations found in the root directory:
- `supabase_knowledge_graph.sql`
- `supabase_chat_history.sql`
- `supabase_rls_migration.sql`

Run these in your Supabase SQL editor to set up the necessary tables and Row-Level Security policies.

---

<div align="center">
  <i>Built with ❤️ for modern thinkers and doers.</i>
</div>
