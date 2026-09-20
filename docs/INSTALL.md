# Installing Wisprnote

A step-by-step guide to running Wisprnote on your own machine, against your own
infrastructure and your own API keys.

Read [SECURITY.md](../SECURITY.md) before processing real meetings — Wisprnote handles
unusually sensitive data, and in its default configuration it sends audio and text to
third-party AI providers.

---

## 1. Platform support

| Platform | Status |
| --- | --- |
| **macOS 13.3+** | **Fully supported.** The only platform where meeting capture works end to end. |
| Linux / Windows | Partial. The Tauri shell and UI build, but **system-audio capture does not work** — the capture helpers in `record_system_audio/` are written against macOS CoreAudio. You can still use imported-audio and manual-note flows. |

Apple Silicon and Intel are both fine.

## 2. Prerequisites

| Tool | Version | Notes |
| --- | --- | --- |
| **Node.js** | 20 or newer | The backend bundles target `node20`. |
| **npm** | ships with Node | |
| **Rust** | stable | Install via [rustup](https://rustup.rs). Needed by Tauri and the audio helpers. |
| **Xcode Command Line Tools** | latest | `xcode-select --install` |
| **ffmpeg** | any recent | Converts captured PCM to WAV. `brew install ffmpeg` |

Verify:

```bash
node --version && npm --version && rustc --version && ffmpeg -version | head -1
```

On Linux you additionally need the Tauri 2 system dependencies (`webkit2gtk-4.1`,
`libayatana-appindicator3`, `librsvg2`); on Windows, MSVC build tools plus the WebView2
runtime. See the [Tauri prerequisites](https://tauri.app/start/prerequisites/).

## 3. Get the code

```bash
git clone https://github.com/migavel508/wisprnote-AI.git
cd wisprnote-AI
npm install
```

`npm install` also fetches the Tauri CLI. The Rust crates compile on first run of
`tauri:dev`, which takes a few minutes the first time.

## 4. Configure your environment

```bash
cp .env.example .env.local
```

Then open `.env.local` and fill in the values. `.env.example` documents every variable
inline; the table below is the shape of what you need.

> **`.env*` is gitignored except `.env.example`.** Never put a real key in a committed
> file. Anything prefixed `VITE_` is compiled into the client bundle and is visible to
> anyone running the app — treat those as public.

### Services you need to provision

| Service | What it does | Required? |
| --- | --- | --- |
| **AWS Cognito** | Sign-in (Google / Microsoft federation) | Yes |
| **AWS API Gateway + Lambda** | The backend in `aws/api` — meetings, knowledge graph, chat | Yes |
| **AWS S3 + CloudFront** | Meeting audio storage and delivery | Yes |
| **Soniox** | Meeting transcription | Yes |
| **OpenRouter** *or* **Google Gemini** | Summaries, notes, knowledge-graph extraction, chat | Yes — pick one via `VITE_AI_PROVIDER` |
| **Turbopuffer** | Vector search for retrieval over past meetings | Yes for RAG / cross-meeting chat |
| **Deepgram** | Legacy real-time transcription path | Optional |
| **Paddle** | Billing and plan limits | Optional — omit to run with no paid tier |

Costs are yours, and the AI providers are metered. A local-only deployment with no paid
tier still needs Cognito, the backend, and a transcription + LLM provider.

### A note on Cognito

Create a **public app client with no client secret**. The app is a desktop/browser client
and cannot keep a secret — `VITE_COGNITO_CLIENT_SECRET` exists only for legacy pools and
anything set there ships inside the bundle.

Your Hosted UI callback URLs must match `VITE_WEB_OAUTH_REDIRECT_URI`
character-for-character — no trailing slash, and the same host your users actually visit.
Mismatches here are the single most common setup failure. Leave that variable empty in
development so the app falls back to `window.location.origin`.

## 5. Deploy the backend

The desktop app talks to the handlers in `aws/api`. Point `VITE_API_GATEWAY_URL` at your
own deployment — not at ours.

```bash
cd aws/api
npm install
npm run build            # esbuild bundle → dist/index.js
```

`npm run deploy` in that directory is **our** deploy script: it pushes to a Lambda named
`wisprnote-api` using an AWS profile named `wisprnote`. Change the function name, profile,
and region to yours before running it, or deploy `dist/index.js` with your own tooling
(SAM, CDK, Terraform, the console — whatever you already use).

Apply the SQL migrations in `aws/` to your database in filename order. Give the Lambda
role only the permissions it actually needs — do not deploy it with an administrator key.

## 6. Run it

**Desktop app (what you want for meetings):**

```bash
npm run tauri:dev
```

**Browser-only UI**, useful for front-end work — no system-audio capture:

```bash
npm run dev          # http://localhost:3000
```

**Production build:**

```bash
npm run tauri:build
```

Bundles land in `src-tauri/target/release/bundle/`. Unsigned builds will be blocked by
Gatekeeper on other people's Macs; distributing to others means signing and notarising
with your own Apple Developer credentials.

**Audio helpers** (built automatically by Tauri, but you can build them alone):

```bash
cd record_system_audio && cargo build --release
```

## 7. Grant macOS permissions

On first recording, macOS prompts for:

- **Microphone** — your own voice
- **System Audio Recording** — everyone else's voice, out of the meeting app

Both are required to capture a full meeting. If you dismiss a prompt, re-enable it in
**System Settings → Privacy & Security**, under Microphone and Screen & System Audio
Recording, then restart the app. The purpose strings shown come from
`src-tauri/Info.plist`.

## 8. Verify your setup

```bash
npm run lint     # tsc --noEmit
npm run test     # vitest
```

Then launch the app, sign in, record a short test meeting, and confirm a transcript and
summary appear. If transcription stays empty, check `SONIOX_API_KEY` and that System Audio
permission was actually granted.

## Troubleshooting

**`redirect_uri_mismatch` on sign-in.** Your Cognito callback URL and
`VITE_WEB_OAUTH_REDIRECT_URI` differ. They must match exactly — protocol, host, port, and
trailing slash. For Google federation, the authorised redirect URI in Google Cloud Console
is the *Cognito* `/oauth2/idpresponse` URL, not your app's URL.

**Transcript empty, no errors.** Almost always System Audio permission. macOS fails this
silently. Check System Settings, then restart the app.

**Rust build fails on first run.** Usually missing Xcode Command Line Tools
(`xcode-select --install`) or a stale toolchain (`rustup update`).

**`ffmpeg: command not found`.** `brew install ffmpeg`.

**Chat answers ignore past meetings.** Turbopuffer is not configured, or your embedding
model's dimension does not match the namespace. `VITE_OPENROUTER_EMBED_MODEL` must stay
consistent with whatever the namespace was created with — changing models means
re-indexing.

**401 from the backend.** Cognito token is not reaching the API, or
`VITE_API_GATEWAY_URL` points somewhere else. Confirm the URL and that your Cognito pool
matches the one the backend validates against.

## Further reading

- [docs/OVERALL_PROJECT_ARCHITECTURE_DEEP_DIVE.md](OVERALL_PROJECT_ARCHITECTURE_DEEP_DIVE.md) — how the system fits together
- [docs/AWS_CLOUD_SERVICES_ARCHITECTURE_DEEP_DIVE.md](AWS_CLOUD_SERVICES_ARCHITECTURE_DEEP_DIVE.md) — the cloud side
- [docs/PRODUCT_END_TO_END.md](PRODUCT_END_TO_END.md) — the product flow
- [mcp-server/README.md](../mcp-server/README.md) — exposing your data to Claude and other AI tools
- [LICENSING.md](../LICENSING.md) — AGPL vs commercial use
