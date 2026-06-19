# Wisprnote AI — Core Concept

## The one breath you'd say to a CEO
> "It starts as an **AI meeting note-taker** — but it's really a **company operating
> system**: it listens, writes the notes, then *acts* on the decisions across the tools
> your team uses (Jira, GitHub), and keeps one **living brain** that remembers — and
> reasons about — everything the company decides and ships."

## Two-line version (for anyone)
> **Wisprnote records and transcribes your meetings and writes the notes for you.**
> **Then it turns those decisions into real work in your tools and keeps one searchable,
> self-reasoning memory of everything your team decides and ships.**

## The product evolution (the "much more than notes" story)
A notes app **records**. A memory layer **recalls**. An operating system **acts**.
Wisprnote is all three, in one loop:

  CAPTURE → UNDERSTAND → ACT → UPDATE → RECORD ──┐
     ▲                                            │
     └──────────── the brain compounds ───────────┘

- **Capture** the meeting (audio, both sides).
- **Understand** it (transcript, decisions, action items, people, topics).
- **Act** on it (create/update Jira tickets, propose work — with human approval).
- **Update** the systems of record and reflect changes back.
- **Record** the chain: who decided what, what shipped, was it aligned.

---

## END-TO-END FLOW (what the user actually does, screen by screen)

### 1. Record / Upload  — `ProcessPage`, `RecordingIndicator`, `MeetingDetectionPrompt`
- Two ways in: **Record** (live) or **Upload** an audio file.
- Live recording captures **both the user's mic AND system audio** (the remote
  participants on the call) natively on the desktop.
- **Live transcript** streams in real time:
  - Words appear **faded** the instant you speak (interim), then firm up to **bold**
    (final). Nothing is ever lost on pause/stop — faded text is committed, not erased.
  - **Speaker direction**: your speech is labelled **"You"**, the call's other voices
    as **"Speaker 1 / 2 …"** (half-duplex source separation; diarization for the rest).
  - **Language** is selectable (English default for accuracy; multilingual available).
- Controls: pause / resume / stop; a meeting-detection prompt can auto-offer to record
  when a call starts.

### 2. Process & Notes  — `NotesPage`, `ManualNotes`
- On stop, the transcript becomes a **meeting**: AI-generated **summary + structured
  notes** (Gemini). The user can also keep **manual notes**.
- Each meeting is saved to history, scoped to a **workspace / folder**.

### 3. History  — `HistoryPage`
- The library of all past meetings — searchable, organised by workspace and folder,
  each with its transcript, notes, and extracted insights.

### 4. Knowledge Graph  — `KnowledgePage`, `PeoplePage`
- Every meeting is mined into **decisions · action items · people · topics**.
- A **force-directed graph** shows how meetings, topics, and people connect across
  time; **People** view surfaces who's involved in what.

### 5. Chat (ask your meetings)  — `ChatPage`
- A RAG chat over everything: ask a question, get a **cited answer** drawn from the
  right meetings (and, in a workspace, from Jira/GitHub too).

### 6. Workspaces & the Living Brain  — `WorkspacePage`, `WorkspaceChat`, `BrainMapModal`, `WorkspaceSwitcher`
- **Workspaces** isolate companies/teams; each can connect its own tools.
- **Connect tools** (Integrations): **Jira** and **GitHub** via secure MCP/OAuth,
  per workspace.
- The **Brain map** is the signature view — one graph across **meetings + Jira + GitHub**:
  - Nodes = work items (meeting, task, commit); coloured by source.
  - **Lines are the reasoning**: a connection that's been judged shows a verdict colour
    — **aligned (green) / partial (amber) / divergent (red)** — and is clickable to read
    *why* ("the meeting asked X; this commit does Y").
  - Click any node for a rich **info card**: content (for commits, an AI summary of the
    real diff — not the fluff message), people, status, the reasoned connections, and a
    timeline of changes.
  - **Activity (Pulse)**: a live "who did what, when" feed (status moves, new commits).
  - **Off-track alerts**: divergent code, risky commits, stalled tasks, and meeting
    **decisions that were never ticketed** — the leader's "is anything slipping?" view.
- **Workspace chat** answers across the whole brain and can drive actions.

### 7. Act — the OS turn  — `WorkspaceChat`, `JiraActionCard`, `McpActionCard`
- From chat, the user can **create / update / assign / transition / comment** on Jira
  issues — every write surfaces as an **editable approval card** (human-in-the-loop;
  nothing happens silently; everything is reversible/auditable).
- An **autonomous agent** reads meetings and **proposes** the right tickets/updates,
  again as approval cards.
- A **co-architect** read on each commit: is the code *sound / a concern / a risk*,
  with a concrete suggestion — grounded in the actual diff.

### 8. Assets (turn talk into deliverables)  — `AssetsPage`
- Generate **follow-up emails, wiki pages, slide decks (PPT), and reports** from a
  meeting — text → finished artifact.

### 9. Share  — `ShareModal`, `SharedMeetingPage`
- Share a meeting via link (anyone / workspace / private); a clean public read view.

### 10. The plumbing the user touches  — `Auth`, `SettingsPage`, `settings/*`, `AudioDevicesPage`, `PermissionsGate`, `FreeLimitModal`
- **Sign in** (email, Google, Microsoft via hosted auth).
- **Settings**: theme, app icon, transcription language, default sharing, and
  **Connections** (connect/disconnect Jira/GitHub, map projects/repos to a workspace).
- **Audio devices** + permission gating for capture; usage/billing limits.

---

## What stays invisible but matters (the trust layer)
- **Human-in-the-loop by default** — the brain proposes; the person approves. No silent
  writes to your tools.
- **Workspace isolation** — one company's brain never bleeds into another's.
- **Provenance & audit** — every action is traceable: meeting → decision → who approved
  → what was done → did the result align.
- **It stays fresh on its own** — connected tools sync continuously and on app open, so
  the brain mirrors reality without manual refresh.

---

## The shortest possible framing
- **Today:** "AI meeting note-taker."
- **What it actually is:** "The system that captures what a company decides, does the
  follow-through across its tools, and remembers + reasons about all of it — a living
  company brain."
