# AI Models & External Sources — Detailed Reference

This document catalogs every AI model and every external service used by the Lumina-AI- (WisprNote) desktop app, with the exact call sites and the role each one plays in the product.

Source files referenced throughout:
- [src/services/geminiService.ts](../src/services/geminiService.ts) — main AI orchestration layer
- [src/lib/knowledgeGraph.utils.ts](../src/lib/knowledgeGraph.utils.ts) — KG embeddings + extraction
- [src/lib/kgEmbedCache.ts](../src/lib/kgEmbedCache.ts) — embedding cache
- [src/services/turbopufferService.ts](../src/services/turbopufferService.ts) — vector store client
- [src/services/awsAuthService.ts](../src/services/awsAuthService.ts) — Cognito auth
- [src/services/awsService.ts](../src/services/awsService.ts) — API Gateway + S3
- [src/services/supabaseService.ts](../src/services/supabaseService.ts) — Supabase client
- [src/pages/KnowledgePage.tsx](../src/pages/KnowledgePage.tsx) — knowledge UI calls

---

## 1. AI Provider Selection

The app supports two interchangeable providers, chosen via the `VITE_AI_PROVIDER` env var:

| Provider | Value | Default? | Required Key |
|---|---|---|---|
| Google Gemini (direct) | `gemini` | yes | `VITE_GEMINI_API_KEY` / `GEMINI_API_KEY` |
| OpenRouter (proxy) | `openrouter` | no | `VITE_OPENROUTER_API_KEY` |

Selection logic: [geminiService.ts:11-16](../src/services/geminiService.ts#L11-L16). When `openrouter` is selected, Gemini model IDs are auto-mapped to the `google/<model>` namespace via `toOpenRouterModel()` ([geminiService.ts:24](../src/services/geminiService.ts#L24)).

---

## 2. Text / Reasoning Models

### 2.1 `gemini-3-flash-preview` — primary workhorse
Used for nearly every non-image text task. Fallback chain (configured at [geminiService.ts:302](../src/services/geminiService.ts#L302)): `gemini-3.1-flash-lite` (single fallback tier).

| Use case | Call site |
|---|---|
| Audio batch transcription (chunked) | [geminiService.ts:395](../src/services/geminiService.ts#L395) |
| File-API single-shot transcription | [geminiService.ts:589](../src/services/geminiService.ts#L589) |
| Meeting summary generation | [geminiService.ts:602](../src/services/geminiService.ts#L602) |
| Structured notes generation | [geminiService.ts:651](../src/services/geminiService.ts#L651) |
| Agentic intent classifier (`agentPlanQuery`) | [geminiService.ts:932](../src/services/geminiService.ts#L932) |
| Single-meeting chat (Chat with Notes) | [geminiService.ts:1066](../src/services/geminiService.ts#L1066) |
| Cross-meeting evidence synthesis | [geminiService.ts:1122](../src/services/geminiService.ts#L1122) |
| Follow-up email generation | [geminiService.ts:1677](../src/services/geminiService.ts#L1677) |
| Knowledge-graph topic extraction | [geminiService.ts:1810](../src/services/geminiService.ts#L1810), retry [geminiService.ts:1983](../src/services/geminiService.ts#L1983) |
| Free-form "ask AI" against transcript | [geminiService.ts:2066](../src/services/geminiService.ts#L2066) |
| Podcast script generation | [geminiService.ts:2111](../src/services/geminiService.ts#L2111) |
| Live podcast guest-reply generation | [geminiService.ts:2156](../src/services/geminiService.ts#L2156) |
| KG topic extraction (utils) | [knowledgeGraph.utils.ts:85](../src/lib/knowledgeGraph.utils.ts#L85) |
| Knowledge page direct fetch | [KnowledgePage.tsx:538,561](../src/pages/KnowledgePage.tsx#L538) |

### 2.2 `gemini-3.1-flash-lite` — cheap path + only fallback
Used wherever cost/latency matters more than peak reasoning, and as the single fallback model when the primary fails.

| Use case | Call site |
|---|---|
| Meeting title generation (whole-meeting head+middle+tail context) | [geminiService.ts:625-647](../src/services/geminiService.ts#L625) |
| Grounding/verification pass on chat answers | [geminiService.ts:898](../src/services/geminiService.ts#L898) |
| OpenRouter agentic tool-calling loop (`google/gemini-3.1-flash-lite`) | [geminiService.ts:1378](../src/services/geminiService.ts#L1378) |
| Only entry in fallback list | [geminiService.ts:302](../src/services/geminiService.ts#L302) |
| KG extraction model fallback | [geminiService.ts:1810](../src/services/geminiService.ts#L1810) |

### 2.3 `gemini-2.5-flash` — agentic Gemini path
Used inside the native Gemini tool-calling agent loop (the OpenRouter equivalent uses `google/gemini-3.1-flash-lite`). Call site: [geminiService.ts:1454](../src/services/geminiService.ts#L1454).

---

## 3. Image Generation Models

### 3.1 `gemini-3.1-flash-image-preview` — primary image model
Used for hand-drawn-style sketchnote and concept diagram generation.

| Use case | Call site |
|---|---|
| Concept image / architecture diagram | [geminiService.ts:1529](../src/services/geminiService.ts#L1529) |
| Sketchnote visualization of meeting notes | [geminiService.ts:1654](../src/services/geminiService.ts#L1654) |

Fallback: `gemini-2.5-flash-image-preview` (lines 1532, 1656). The fallback chain is **kept inside Gemini** even when `VITE_AI_PROVIDER=openrouter` — when OpenRouter is selected, the app routes images through a separate OpenRouter image path instead.

### 3.2 OpenRouter image models
Configurable via `VITE_OPENROUTER_IMAGE_MODEL` ([geminiService.ts:30](../src/services/geminiService.ts#L30)). Default and fallback list:

- `google/gemini-2.5-flash-image` (default)
- `google/gemini-2.0-flash-exp` (fallback)

Defined at [geminiService.ts:32,237-238](../src/services/geminiService.ts#L237).

---

## 4. Embedding Models

Embeddings power the knowledge graph and semantic search over meetings.

| Provider path | Model | Notes |
|---|---|---|
| Gemini (default) | `gemini-embedding-001` | Primary embedding model ([knowledgeGraph.utils.ts:83](../src/lib/knowledgeGraph.utils.ts#L83)) |
| Gemini fallback | `text-embedding-004` | Older Gemini embed model ([knowledgeGraph.utils.ts:84](../src/lib/knowledgeGraph.utils.ts#L84)) |
| OpenRouter | `openai/text-embedding-3-large` | Vector-dim-matched OpenRouter fallback ([knowledgeGraph.utils.ts:115](../src/lib/knowledgeGraph.utils.ts#L115)) |

Vector dimensions must stay consistent across the embedding model, the KG cache, and the Turbopuffer namespace — the comment at [knowledgeGraph.utils.ts:107](../src/lib/knowledgeGraph.utils.ts#L107) explains why the OpenRouter model is pinned to the same family.

Override env var: `VITE_OPENROUTER_EMBED_MODEL` ([kgEmbedCache.ts:21](../src/lib/kgEmbedCache.ts#L21), [knowledgeGraph.utils.ts:109](../src/lib/knowledgeGraph.utils.ts#L109)).

---

## 5. External Services

### 5.1 Google Generative Language API
Base URL: `https://generativelanguage.googleapis.com/v1beta/`

| Endpoint | Purpose | Call site |
|---|---|---|
| `/upload/v1beta/files?uploadType=resumable` | Resumable upload of audio blobs for File-API transcription | [geminiService.ts:455](../src/services/geminiService.ts#L455) |
| `/v1beta/{name}` (GET) | Poll file processing state | [geminiService.ts:515](../src/services/geminiService.ts#L515) |
| `/v1beta/{name}` (DELETE) | Clean up uploaded files | [geminiService.ts:530](../src/services/geminiService.ts#L530) |
| `/v1beta/models/{model}:generateContent` | Text/image generation | [geminiService.ts:1835,2002](../src/services/geminiService.ts#L1835), [knowledgeGraph.utils.ts:793](../src/lib/knowledgeGraph.utils.ts#L793) |
| `/v1beta/{modelPath}:batchEmbedContents` | Batch embedding requests | [knowledgeGraph.utils.ts:411](../src/lib/knowledgeGraph.utils.ts#L411) |

Auth: `?key=<VITE_GEMINI_API_KEY>` query param.

### 5.2 OpenRouter API
Base URL: `https://openrouter.ai/api/v1/`

| Endpoint | Purpose | Call site |
|---|---|---|
| `/chat/completions` | OpenAI-compatible chat completions for all chat/extraction tasks when provider=openrouter | [geminiService.ts:141,246,1369,1819,1986](../src/services/geminiService.ts#L141), [knowledgeGraph.utils.ts:773](../src/lib/knowledgeGraph.utils.ts#L773), [KnowledgePage.tsx:529](../src/pages/KnowledgePage.tsx#L529) |
| `/embeddings` | OpenAI-compatible embeddings endpoint | [knowledgeGraph.utils.ts:346](../src/lib/knowledgeGraph.utils.ts#L346) |

Auth: `Authorization: Bearer <VITE_OPENROUTER_API_KEY>`. Required headers: `HTTP-Referer` (origin or `https://wisprnote.app`) and `X-Title: WisprNote AI`.

### 5.3 Turbopuffer (vector store)
SDK: `@turbopuffer/turbopuffer`. Region: `gcp-us-central1`. Namespace: `lumina-meetings`. Configured at [turbopufferService.ts:13,30-34](../src/services/turbopufferService.ts#L13).

Purpose: stores chunked meeting embeddings for hybrid (BM25 + vector) retrieval used by the chat-with-notes RAG layer. Constants: `NAMESPACE = 'lumina-meetings'`, `RRF_K = 60` (Reciprocal Rank Fusion). Auth via `VITE_TURBOPUFFER_API_KEY`.

### 5.4 AWS Cognito
SDK: `amazon-cognito-identity-js`. Used for the production user identity layer (sign-up, sign-in, hosted UI with Google federation).

| Env var | Purpose |
|---|---|
| `VITE_COGNITO_USER_POOL_ID` | User pool identifier ([awsAuthService.ts:18](../src/services/awsAuthService.ts#L18)) |
| `VITE_COGNITO_CLIENT_ID` | App client ID |
| `VITE_COGNITO_CLIENT_SECRET` | Confidential client secret |
| `VITE_COGNITO_DOMAIN` | Hosted UI domain prefix or full origin |
| `VITE_COGNITO_AUTH_ORIGIN` | Preferred custom domain origin |
| `VITE_COGNITO_IDENTITY_PROVIDER` | Google federation identity provider name |
| `VITE_AWS_REGION` | AWS region (defaults to `us-east-1`) |
| `VITE_WEB_OAUTH_REDIRECT_URI` | OAuth redirect URI (web build) |

Hosted UI origin construction: [awsAuthService.ts:49-74](../src/services/awsAuthService.ts#L49-L74).

### 5.5 AWS API Gateway
Base URL: `VITE_API_GATEWAY_URL`. Used by [awsService.ts](../src/services/awsService.ts), [awsShareService.ts](../src/services/awsShareService.ts), [awsLedgerService.ts](../src/services/awsLedgerService.ts), and [workspaceService.ts](../src/services/workspaceService.ts) for ledger writes, workspace management, share-link creation, and meeting persistence.

### 5.6 AWS S3
Bucket: `VITE_S3_BUCKET` in region `VITE_AWS_REGION` (default `us-east-1`) — [awsService.ts:8-9](../src/services/awsService.ts#L8). Stores audio recordings and large meeting artifacts.

### 5.7 Supabase
Client created in [supabaseService.ts:7-12](../src/services/supabaseService.ts#L7). Uses `VITE_SUPABASE_URL` + anon key. Used for secondary persistence / shared chat features alongside the AWS stack.

### 5.8 Public share URLs
- `https://www.wisprnote.com/shared/{token}` — [shareService.ts:302](../src/services/shareService.ts#L302)
- `https://wisprnote.com/shared/{token}` — [awsShareService.ts:159](../src/services/awsShareService.ts#L159)

---

## 6. Provider/Model Routing Summary

```
                ┌─────────────────────────────┐
                │  VITE_AI_PROVIDER selector  │
                └──────────────┬──────────────┘
                               │
              ┌────────────────┴────────────────┐
              ▼                                 ▼
      ┌───────────────┐                ┌─────────────────┐
      │  Gemini API   │                │   OpenRouter    │
      │  (direct)     │                │   (proxy)       │
      └───────┬───────┘                └────────┬────────┘
              │                                 │
   ┌──────────┼──────────┐               ┌──────┴───────┐
   ▼          ▼          ▼               ▼              ▼
  Text     Images   Embeddings       Text/Tools    Embeddings
  3-flash  3.1-img  embedding-001    google/3.1-lite  openai/3-large
  3.1-lite 2.5-img  text-embed-004   google/3-pv
  2.5                                 google/2.5-img
```

External, non-AI dependencies sit alongside:

```
Turbopuffer (vectors)  ◄── embeddings from above
AWS Cognito (auth) ──► API Gateway ──► S3 (audio) + DynamoDB (ledger)
Supabase (shared chat / secondary persistence)
```

---

## 7. Environment Variable Index

| Var | Required when | Used by |
|---|---|---|
| `VITE_AI_PROVIDER` | optional (defaults `gemini`) | provider selector |
| `VITE_GEMINI_API_KEY` / `GEMINI_API_KEY` | provider=gemini | all Gemini calls |
| `VITE_OPENROUTER_API_KEY` | provider=openrouter | all OpenRouter calls |
| `VITE_OPENROUTER_IMAGE_MODEL` | optional | OpenRouter image override |
| `VITE_OPENROUTER_EMBED_MODEL` | optional | OpenRouter embed override |
| `VITE_TURBOPUFFER_API_KEY` | RAG enabled | Turbopuffer client |
| `VITE_SUPABASE_URL` + anon key | shared features | Supabase client |
| `VITE_API_GATEWAY_URL` | AWS backend | aws*Service.ts |
| `VITE_S3_BUCKET` | audio uploads | awsService |
| `VITE_AWS_REGION` | AWS backend | all AWS services |
| `VITE_COGNITO_*` | auth | awsAuthService |
| `VITE_WEB_OAUTH_REDIRECT_URI` | web build | awsAuthService |

---

## 8. Notes on Recent Changes

- `gemini-3.5-flash` has been removed from the codebase entirely. All its prior roles (title generation, chat grounding verifier, OpenRouter agentic loop primary, fallback) now route to `gemini-3.1-flash-lite`.
- Fallback list is now single-tier: `["gemini-3.1-flash-lite"]` — see [geminiService.ts:302](../src/services/geminiService.ts#L302).
- `generateMeetingTitle` was rewritten to base the title on the **whole meeting** (beginning + middle + end sampled at ~3600 chars total) instead of only the first 500 chars, with `maxOutputTokens: 24` to keep output tight.
- Transcription paths (`processAudioBatch`, `transcribeViaFileAPI`) intentionally stay on `gemini-3-flash-preview` for transcription quality.
