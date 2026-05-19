# Wisprnote AWS and Cloud Services Architecture

Last updated: 2026-05-18
Scope: active cloud architecture used by `desktop/Lumina-AI-/`

## 1. Executive Summary

The current production-facing application path is AWS-led, but not AWS-only.

Active AWS responsibilities:

- authentication and federated sign-in with Cognito
- application API behind API Gateway
- business logic in a Node Lambda package
- primary relational storage in PostgreSQL on the AWS side
- object storage for uploaded note images in S3
- email delivery for meeting-share invites through SES

Non-AWS but production-relevant cloud services:

- Google Gemini for transcription and generation
- OpenRouter as an alternate LLM/embedding gateway
- Deepgram for realtime speech-to-text
- Turbopuffer for hybrid vector retrieval
- Vercel for the share-preview HTML edge layer

The result is a split control plane:

- AWS owns identity, app data, sharing state, media upload URLs, and invite mail
- external AI services own model execution and vector retrieval
- Vercel helps the web/shared distribution surface

## 2. Current AWS Service Inventory

### 2.1 Amazon Cognito

Used by `src/services/awsAuthService.ts`.

Observed responsibilities:

- username/password sign-up and sign-in
- Google federated login through Hosted UI / managed login
- PKCE authorization-code exchange
- ID token issuance for the app API
- deep-link and browser OAuth callback compatibility

Relevant frontend config keys:

- `VITE_COGNITO_USER_POOL_ID`
- `VITE_COGNITO_CLIENT_ID`
- `VITE_COGNITO_DOMAIN`
- `VITE_COGNITO_AUTH_ORIGIN`
- `VITE_COGNITO_IDENTITY_PROVIDER`
- `VITE_WEB_OAUTH_REDIRECT_URI`
- `VITE_AWS_REGION`

The code also optionally references `VITE_COGNITO_CLIENT_SECRET`. That is an important design note: a client secret in a frontend runtime is inappropriate for a public web client and should only exist if the deployment model is explicitly trusted and constrained.

### 2.2 API Gateway

The frontend uses `VITE_API_GATEWAY_URL` as its base API URL.

Consumers:

- `awsService.ts`
- `awsShareService.ts`
- `awsLedgerService.ts`
- `api/_sharePreview.ts`

The Tauri capability allowlist explicitly permits calls to:

- `https://*.execute-api.*.amazonaws.com/**`

This is the central application ingress for authenticated CRUD and share verification.

### 2.3 AWS Lambda

The backend package lives in `aws/api/`.

Packaging traits:

- bundled with `esbuild`
- targeted at Node 20
- deployed by zipping `dist/index.js`

Important implication:

- the repo contains a code deployment script
- but it does not contain full infrastructure-as-code for creating the function, API Gateway, IAM, S3, Cognito, or SES resources

This means the repo documents the function code, not the full AWS environment definition.

### 2.4 PostgreSQL on the AWS side

The Lambda uses `pg` in `aws/api/src/db.ts` with:

- `DB_HOST`
- `DB_PORT`
- `DB_NAME`
- `DB_USER`
- `DB_PASSWORD`

The migration file `aws/migration.sql` defines the application schema and explicitly notes that this AWS schema is adapted from the earlier Supabase model.

### 2.5 Amazon S3

Used for note-image uploads through presigned URLs.

Flow:

1. frontend calls `POST /storage/presign`
2. Lambda creates a `PutObjectCommand`
3. Lambda returns a presigned PUT URL plus a public object URL
4. frontend uploads the file directly to S3

Important traits:

- object key is user-scoped: `${userId}/timestamp_random.ext`
- presign TTL is 600 seconds
- returned public URL uses the bucket’s regional S3 hostname

### 2.6 Amazon SES

Used in `aws/api/src/index.ts` for share-invite emails.

Trigger points:

- new restricted/public share creation with email recipients
- adding emails to an existing share

Payload includes:

- branded HTML email
- plaintext fallback
- direct link to the shared meeting page

### 2.7 Custom domains and public web references

Observed host/domain assumptions:

- `https://www.wisprnote.com`
- `https://auth.wisprnote.com`
- regional Cognito fallback host in `us-east-1`

These appear in comments, redirect guidance, and capability allowlists, which strongly suggests a production topology with:

- public app/share website
- custom Cognito auth domain

## 3. Lambda API Architecture

### 3.1 Entry and auth model

The Lambda handler in `aws/api/src/index.ts`:

- short-circuits CORS `OPTIONS`
- allows unauthenticated access only for share verification
- verifies Cognito ID tokens for all other routes using `aws-jwt-verify`

Verification inputs:

- `COGNITO_USER_POOL_ID`
- `COGNITO_CLIENT_ID`

Authorization model:

- user identity is derived from the Cognito `sub`
- backend uses that `sub` as `user_id`
- all SQL filtering is enforced in application code, not database RLS

This is a deliberate departure from the Supabase/RLS model.

### 3.2 Route surface

Current top-level resources:

- `/tasks`
- `/assets`
- `/notes`
- `/knowledge-graph`
- `/chat`
- `/shares`
- `/ledger`
- `/storage`

### `/tasks`

Purpose:

- create meetings
- fetch one meeting
- fetch paginated meeting history
- update editable fields

Behavior highlights:

- lightweight vs full listing
- search by filename or summary
- user-scoped reads and writes

### `/assets`

Purpose:

- persist generated assets such as emails and wiki content
- fetch assets for a meeting

### `/notes`

Purpose:

- create/update notebook-style manual notes
- list notes
- delete notes

### `/knowledge-graph`

Purpose:

- upsert one or many KG records
- fetch all KG entries or one by task
- delete KG for a task

Notable design:

- accepts batch upsert payloads
- uses `ON CONFLICT (user_id, task_id)` to keep one KG row per meeting per user

### `/chat`

Purpose:

- write one or many chat messages
- fetch by `taskId` or `threadId`
- delete a task’s chat history

Stored fields include:

- `citations`
- `retrieval_meta`

This supports explainable chat and replay of retrieval context.

### `/shares`

Purpose:

- create shares
- fetch the current share for a task
- change access type or active state
- delete shares
- manage email allowlists

Sub-routes:

- `/shares`
- `/shares/{id}`
- `/shares/{id}/emails`
- `/shares/{id}/emails/{email}`
- `/shares/verify/{token}` (public)

### `/ledger`

Purpose:

- persist per-user retrieval/KG operational state
- read remote index/extraction state
- store/retrieve KG artifact snapshots
- clear artifact cache state

This is not user content in the normal sense. It is operational metadata used to avoid expensive rework.

### `/storage/presign`

Purpose:

- create S3 upload URLs for note images

No object data passes through Lambda after presigning.

### 3.3 Request pattern from the frontend

`awsService.ts`, `awsShareService.ts`, and `awsLedgerService.ts` follow the same structure:

1. read Cognito ID token from `awsAuthService`
2. send JSON request to `VITE_API_GATEWAY_URL + path`
3. parse JSON response or throw enriched errors
4. in Tauri, use `@tauri-apps/plugin-http`
5. in browser mode, use native `fetch`

That means the frontend already abstracts over desktop vs web networking, while keeping the same backend contract.

## 4. Database Architecture on AWS

The current authoritative schema is `aws/migration.sql`.

### 4.1 Design philosophy

Key differences from the old Supabase approach:

- no `auth.users` foreign-key dependency
- no row-level security
- user scoping is enforced in the Lambda application layer

This makes the backend more portable, but it shifts security correctness into code discipline.

### 4.2 Core tables

### `task_history`

System of record for meetings.

Stores:

- meeting metadata
- full transcription
- AI summary
- AI notes
- audio URL
- duration
- personal note
- visualization image

### `generated_assets`

Stores generated meeting outputs as JSONB content with a meeting foreign key.

### `manual_notes`

Standalone user notes with `updated_at` trigger support.

### `knowledge_graph`

Stores structured AI-extracted meeting facts:

- topics
- decisions
- people
- action_items
- refs

JSONB is used rather than a fully normalized entity graph.

### `chat_history`

Stores conversational history with optional image, thread ID, citations, and retrieval metadata.

### `shared_meetings`

Stores the share object itself:

- token
- owner
- task
- access type
- permissions array
- active/expired state

### `shared_meeting_access`

Stores restricted-share email access and first access timestamps.

### `user_ledger_state`

Stores:

- Turbopuffer index ledger
- KG extraction ledger
- optional cached KG artifact JSON

This table is an important optimization layer, not just a miscellaneous dumping ground.

### 4.3 Relationship model

The schema is intentionally simple:

- `task_history` is the root aggregate
- `generated_assets`, `knowledge_graph`, `chat_history`, and `shared_meetings` hang off tasks
- `shared_meeting_access` hangs off shares
- `user_ledger_state` hangs directly off user identity

This is a sensible shape for a Lambda CRUD backend because it minimizes join complexity and keeps ownership checks straightforward.

### 4.4 Operational tradeoffs

Advantages:

- simple mental model
- easy to query from Lambda
- fewer moving parts than RLS-heavy designs

Tradeoffs:

- authorization correctness depends on every query being properly scoped
- schema contains large text and JSONB blobs, which can grow rapidly
- graph and chat analytics are limited unless more specialized indexing is added

## 5. Auth Architecture in Detail

### 5.1 Desktop and web callback strategy

Observed callback patterns:

- desktop deep link: `wisprnote://auth-callback/`
- browser callback: `window.location.origin` or `VITE_WEB_OAUTH_REDIRECT_URI`

The code supports both:

- opening Hosted UI in the browser from the desktop shell
- redirecting back into the desktop app
- performing PKCE token exchange from the app

### 5.2 Session handling

Cognito session persistence is handled client-side using:

- localStorage when available
- in-memory fallback when localStorage is constrained

The code also removes stale Supabase storage keys at startup. That is an implementation detail with architectural meaning: the team has already hit storage-pressure conflicts from the old auth layer and patched around them.

### 5.3 Token usage

The frontend prefers ID tokens, and the Lambda verifies them as `tokenUse: 'id'`.

That is consistent internally, but teams commonly choose access tokens for API authorization. If the platform grows, this choice should stay intentional and documented.

## 6. S3 Upload Architecture

Image uploads for notebook/editor content are offloaded directly to S3.

Frontend behavior:

- request presigned URL
- upload file directly to S3
- persist the resulting public URL in note content

Benefits:

- Lambda avoids handling file streams
- upload bandwidth bypasses the application server
- object keys are user-scoped

Constraints:

- bucket/object privacy model is not defined in this repo
- public URL construction assumes direct object accessibility

That means the code implies either:

- public-read objects
- or a bucket policy/CDN layer that makes those URLs readable

That infrastructure assumption is outside the repo and should be verified in deployment.

## 7. Share and Email Architecture

### 7.1 Share creation model

When a share is created:

1. Lambda generates a token
2. inserts into `shared_meetings`
3. optionally inserts allowed emails into `shared_meeting_access`
4. optionally sends SES invitations

The share page itself is not rendered by Lambda. Lambda only governs access and returns meeting data.

### 7.2 Public verification route

`GET /shares/verify/{token}` is intentionally unauthenticated.

Behavior:

- invalid/revoked token -> denied payload
- expired token -> denied payload
- restricted share without email -> `sign_in_required`
- restricted share with unauthorized email -> denied payload
- successful access -> meeting payload constrained by share permissions

This route is the core trust boundary for publicly reachable shared content.

### 7.3 Vercel preview layer

The Vercel function `api/share-html.ts`:

- reads the share token
- asks the AWS API for preview data
- injects Open Graph metadata into `index.html`
- returns HTML for crawlers and social previews

This is a cross-cloud pattern:

- Vercel handles web preview rendering
- AWS remains the source of truth for share authorization and content

## 8. Ledger and Retrieval State Architecture

The ledger system is a meaningful part of the cloud design.

Frontend use cases:

- know which meetings have already been indexed into Turbopuffer
- know which meetings have already had KG extraction
- cache a built KG artifact to avoid recomputation

Why it matters:

- Turbopuffer indexing and KG graph builds are expensive
- without a persistent ledger, the app would repeatedly re-index or re-extract

Design observations:

- legacy localStorage keys are still migrated forward
- remote persistence is debounced
- large artifact JSON is capped at roughly 4.5 MB before upload is skipped

This is a pragmatic operational cache, not just convenience state.

## 9. External Cloud Tooling Adjacent to AWS

The AWS side is only part of the product runtime.

### 9.1 Google Gemini

Used for:

- content generation
- file-based transcription
- summaries
- notes
- meeting titles
- KG extraction
- embeddings in the Gemini provider path

Architectural note:

- the frontend calls Gemini directly
- this keeps the AWS API lighter, but moves provider orchestration into the client

### 9.2 OpenRouter

Used as an alternative model/embedding gateway.

Observed uses:

- chat completions
- image-capable prompts
- embeddings
- KG extraction path

### 9.3 Deepgram

Used from the Tauri native runtime for realtime transcription.

This is a desktop-native path, not part of the AWS backend.

### 9.4 Turbopuffer

Used for hybrid retrieval:

- vector ANN
- BM25
- reciprocal-rank fusion

Observed namespace:

- `lumina-meetings`

Region observed in code:

- `gcp-us-central1`

This is a notable architectural fact: the retrieval tier is not on AWS.

### 9.5 Vercel

Used for:

- routing `/shared/:token`
- serving a rewritten SPA shell
- injecting OG metadata via serverless function

This makes the public sharing surface partly Vercel-backed even though the source content and permissions are AWS-backed.

## 10. Deployment and Operations Gaps

### 10.1 Missing infrastructure-as-code

What exists:

- Lambda source
- Lambda packaging script
- SQL schema file

What is not present in the repo:

- CDK
- CloudFormation
- Terraform
- Serverless Framework config
- IAM policy definitions
- API Gateway route definitions
- Cognito pool/client definitions
- S3/SES resource definitions

Operational consequence:

- the codebase alone is not enough to recreate the AWS environment
- there is likely manual console state or separate private infra code

### 10.2 Documentation drift around MCP

The MCP runtime now expects direct DB credentials, but its README and `.env.example` still describe Supabase inputs.

This is not just a docs typo. It means the integration contract has changed without the surrounding operational docs being updated.

### 10.3 Security-sensitive config in frontend space

The presence of optional `VITE_COGNITO_CLIENT_SECRET` usage is a warning sign for any public web deployment.

Even if currently unused in production, the architecture docs should treat that as a constraint:

- public clients should avoid secret-bearing app clients
- desktop-only distribution still needs a deliberate threat model

## 11. Recommended Mental Model for the AWS Side

Use this simplified request model:

```text
Frontend/Desktop App
  -> Cognito sign-in / Hosted UI
  -> receive ID token
  -> call API Gateway with Authorization header
  -> Lambda verifies Cognito token
  -> Lambda reads/writes PostgreSQL
  -> Lambda presigns S3 uploads or sends SES mail when needed
  -> frontend directly calls AI/retrieval providers for model work
```

And for sharing:

```text
Owner creates share
  -> Lambda writes shared_meetings/shared_meeting_access
  -> SES sends invites

Viewer opens shared URL
  -> Vercel share-html function requests preview info from AWS
  -> browser SPA requests /shares/verify/{token}
  -> Lambda enforces access and returns limited meeting payload
```

## 12. Concrete Next Documentation Tasks

To make the cloud architecture maintainable, the next useful docs would be:

1. an environment variable matrix by deployment target
2. an API contract document for the Lambda routes
3. an infrastructure ownership document covering Cognito, API Gateway, Lambda, RDS, S3, SES, Vercel, and external AI services
4. a cleanup pass on outdated Supabase and MCP setup documentation
