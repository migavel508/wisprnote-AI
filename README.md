<div align="center">
  <img src="./logo.png" alt="Wisprnote" width="100" />

  # Wisprnote

  **An AI operating system for your working memory.**

  Wisprnote runs on your Mac, listens to every word spoken in your meetings, turns them
  into a searchable knowledge base, and connects that knowledge to the tools you already
  work in — so everything your team knows lives in one place instead of scattered across
  a dozen apps.

  [![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](LICENSE)
  [![Commercial licence available](https://img.shields.io/badge/commercial-licence_available-green.svg)](LICENSING.md)

  [Demo](#demo) • [What it does](#what-it-does) • [Install](docs/INSTALL.md) • [Architecture](#architecture) • [Licence](#licence)
</div>

<div align="center">
  <img src="./wisprnoteai.png" alt="The Wisprnote interface" width="100%" />
</div>

---

## Demo

**[▶ Watch the demo](docs/demo/wisprnote-demo.mp4)** (26 MB, MP4)

GitHub won't play a repo-hosted video inline — click through, or download the file, to
watch it.

## What it does

**It listens.** Wisprnote captures both sides of a meeting — your microphone and the
system audio coming out of Zoom, Meet, or Teams — and transcribes it with speaker
attribution. Nothing needs to be invited to your call; it hears what your Mac hears.

**It understands.** Every meeting is distilled into a summary, notes, decisions, and
action items with owners. This is not one prompt over a transcript: extraction is
structured, and the results are meant to be read by someone who missed the call.

**It remembers.** Meetings are chunked, embedded, and indexed, then woven into a
knowledge graph spanning everything you have ever recorded — topics, people, decisions,
and how they connect. Ask "what did we decide about pricing?" and the answer is drawn
from six months of calls, with citations back to the moment it was said.

**It organises.** Workspaces, spaces, and folders keep meetings sorted; standalone notes
live alongside them. One place, not twelve.

**It acts.** Connectors reach into external systems — Jira and GitHub among them — so
chat can do more than answer. An action item can become a ticket without leaving the
conversation, with a human approving each step.

**It opens up.** A built-in MCP server exposes your meetings, knowledge graph, and notes
to Claude, Cursor, and any other MCP client, so your own AI tools can read the knowledge
base you have been accumulating.

## Architecture

```
┌──────────────── Your Mac ────────────────┐
│  Tauri desktop app (React + TypeScript)  │
│  Rust audio capture (CoreAudio)          │
│    ├─ microphone        (you)            │
│    └─ system audio      (everyone else)  │
└───────────────────┬──────────────────────┘
                    │
        ┌───────────▼────────────┐
        │  Your AWS backend      │  Lambda + API Gateway
        │  (aws/api)             │  Cognito · S3 · CloudFront
        └───────────┬────────────┘
                    │
   ┌────────────────┼─────────────────┬──────────────────┐
   ▼                ▼                 ▼                  ▼
Transcription    LLM              Vector search      Connectors
(Soniox)     (Gemini /         (Turbopuffer)      (Jira, GitHub)
              OpenRouter)
```

The desktop app and audio capture run locally. Transcription, language models, and vector
search are external services you configure with your own keys — see
[SECURITY.md](SECURITY.md) for what that means for confidential meetings.

**Stack:** React 19 · TypeScript · Vite · Tailwind CSS v4 · Tauri 2 · Rust · AWS Lambda ·
Soniox · Gemini / OpenRouter · Turbopuffer

## Install

Full instructions, including every service you need to provision:
**[docs/INSTALL.md](docs/INSTALL.md)**

```bash
git clone https://github.com/migavel508/wisprnote-AI.git
cd wisprnote-AI
npm install
cp .env.example .env.local    # fill in your own keys
npm run tauri:dev
```

Requires **macOS 13.3+**, Node 20+, Rust, and ffmpeg. The UI builds on Linux and Windows,
but system-audio capture is macOS-only — see [Platform support](docs/INSTALL.md#1-platform-support).

## Documentation

| Document | What's in it |
| --- | --- |
| [docs/INSTALL.md](docs/INSTALL.md) | Step-by-step setup, services, troubleshooting |
| [docs/OVERALL_PROJECT_ARCHITECTURE_DEEP_DIVE.md](docs/OVERALL_PROJECT_ARCHITECTURE_DEEP_DIVE.md) | How the whole system fits together |
| [docs/AWS_CLOUD_SERVICES_ARCHITECTURE_DEEP_DIVE.md](docs/AWS_CLOUD_SERVICES_ARCHITECTURE_DEEP_DIVE.md) | The cloud architecture |
| [docs/PRODUCT_END_TO_END.md](docs/PRODUCT_END_TO_END.md) | The product flow, end to end |
| [docs/AGENTIC_CHAT_LOOP.md](docs/AGENTIC_CHAT_LOOP.md) | How chat plans and executes actions |
| [docs/COMPANY_BRAIN.md](docs/COMPANY_BRAIN.md) | The cross-meeting knowledge layer |
| [SECURITY.md](SECURITY.md) | Reporting vulnerabilities, and self-hosting safely |
| [CONTRIBUTING.md](CONTRIBUTING.md) | How to contribute, and the CLA |

## A word on consent

Wisprnote transcribes everything said in a meeting. Recording laws differ by
jurisdiction and many require consent from every participant. Tell people they are being
recorded — it is both the legal position in much of the world and the decent thing to do.

## Licence

Wisprnote is **dual-licensed**.

**[AGPL-3.0](LICENSE)** — free to use, study, modify, and share. You may run it for any
purpose, including commercially and inside a company. If you distribute it, or let others
interact with it over a network, you must release your complete modified source under the
AGPL too (section 13). Internal use with nothing distributed owes nothing further.

**[Commercial licence](LICENSING.md)** — for anyone who cannot meet those conditions:
embedding Wisprnote in a closed-source product, offering it as a hosted service without
publishing your source, white-labelling it, or redistributing it under different terms.
Warranties and support come this way too.

The **Wisprnote** name and logos are trademarks and are *not* covered by the AGPL. Forks
are welcome; forks called Wisprnote are not.

Not sure which applies to you? → **hello@wisprbee.com**

<div align="center">
  <sub>Copyright © 2026 Wisprbee. See <a href="NOTICE">NOTICE</a>.</sub>
</div>
