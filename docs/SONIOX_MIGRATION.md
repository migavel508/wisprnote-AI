# Soniox transcription migration — production change record

Everything this change touches in the **production** environment, recorded so the
deployment is reproducible (and reversible) from this repo alone, including after
the hosted environment is shut down.

Date: 2026-09-14 · Lambda: `wisprnote-api` · Region: `us-east-1` · Profile: `wisprnote`

---

## 1. What changed, in one paragraph

Meeting transcription moved from a two-mode system (Gemini batch **or** Deepgram
streaming, chosen automatically) to a single always-live path on **Soniox**. The
user now presses one Record button. Uploaded files go to Soniox's async API in one
job. Deepgram is **not** removed — it still serves the chat box's voice input.

## 2. Secrets

One new key in the Secrets Manager document `wisprnote/prod/api`
(`API_SECRETS_ID`), read by `aws/api/src/secrets.ts`:

| Key | Purpose |
| --- | --- |
| `SONIOX_API_KEY` | Permanent Soniox key. Server-side only — used to mint temporary websocket keys and to run async jobs. |

`DEEPGRAM_API_KEY` **stays** — `/ai/transcribe` (chat voice input) still uses it.

Set it without printing it to a shell history:

```bash
aws secretsmanager get-secret-value --secret-id wisprnote/prod/api \
  --profile wisprnote --region us-east-1 --query SecretString --output text > /tmp/api-secrets.json
# edit /tmp/api-secrets.json, add: "SONIOX_API_KEY": "snx_proj_..."
aws secretsmanager put-secret-value --secret-id wisprnote/prod/api \
  --profile wisprnote --region us-east-1 --secret-string file:///tmp/api-secrets.json
rm -f /tmp/api-secrets.json
```

> The key originally issued for this work was pasted into a chat transcript and must
> be treated as compromised. Rotate it in the Soniox console and store the new value.

## 3. API routes

| Route | Change |
| --- | --- |
| `POST /ai/soniox-token` | **added** — mints a short-lived key (`usage_type: transcribe_websocket`) for the desktop client's live stream. |
| `POST /ai/soniox-transcribe` | **added** — async transcription of an uploaded file; takes an S3 **key**, presigns a GET, polls, returns diarised tokens. |
| `POST /ai/deepgram-token` | **removed** — no client mints Deepgram streaming tokens any more. |
| `POST /ai/transcription-usage` | **changed** — provider/model now Soniox; `mode` is `live \| upload` (was `realtime \| batch`). |
| `POST /ai/transcribe` | **unchanged** — Deepgram prerecorded, chat voice input. |
| `POST /storage/presign` | **changed** — response now also returns `key` (additive; existing callers unaffected). |

### Why the client holds a key at all

The desktop app streams **directly** to Soniox for latency. That needs a credential
on the client, so the permanent key is never used there: the Lambda mints a
temporary, websocket-scoped, self-expiring key per session. This is what makes
open-sourcing the client safe — verified by `grep -r "snx_" dist/` coming back empty.

### Why uploads pass a key, not a URL

Meeting audio is private. The client PUTs to S3 via `/storage/presign`, then sends
only the object **key**; the server signs a short-lived GET for Soniox.
`presignUserAudio` (`aws/api/src/storage.ts`) refuses any key outside the caller's
own `${userId}/` prefix, so one user cannot transcribe another's recording. The
bucket needs no public access, and routing bytes around Lambda avoids its 6 MB
request ceiling.

## 4. Model registry

`aws/api/src/models/registry.ts` and `src/config/models.ts`:

- `Provider` union gains `'soniox'`.
- `meetingLive` → `stt-rt-v5` (websocket)
- `meetingAsync` → `stt-async-v5` (files)
- `transcription` → `nova-3`, now documented as chat-voice-input only.

Usage metering (`recordAudioUsage`) records provider `soniox` for meeting audio.

## 5. Deploy

```bash
cd aws/api && npm run deploy
```

Bundles with esbuild, zips, and runs `aws lambda update-function-code
--function-name wisprnote-api`. Set the secret **before** deploying: without
`SONIOX_API_KEY` both new routes return 500 and recording cannot start.

Desktop client: `npm run tauri:build`.

## 6. Verify after deploy

```bash
# Needs a signed-in user's ID token.
curl -s -X POST "$API/ai/soniox-token" -H "Authorization: $ID_TOKEN" \
  -H 'Content-Type: application/json' -d '{"expires_in_seconds":120}' | head -c 120
# expect: {"api_key":"snx_temp_...","expires_at":"..."}
```

Then in the app: record a two-party call and confirm live text appears, your own
speech is labelled **You**, and remote speakers get stable **Speaker N** that does
not renumber mid-call.

## 6a. Deploy log

| When (UTC) | What |
| --- | --- |
| 2026-09-14 ~14:29 | `SONIOX_API_KEY` added to `wisprnote/prod/api`. Secret went 16 → 17 keys; all pre-existing values verified intact afterwards. Version `84c6a631-af18-4bba-b467-0261974aa00a`. |
| 2026-09-14 14:30:53 | `wisprnote-api` code updated (`npm run deploy`). `LastUpdateStatus: Successful`, `State: Active`. |

Post-deploy verification actually performed:

- Downloaded the **deployed** artifact and grepped it: `soniox-token` and
  `soniox-transcribe` present, `deepgram-token` absent, `stt-rt-v5` / `stt-async-v5`
  present, and **zero** occurrences of any literal key (it is read from Secrets
  Manager at runtime).
- CloudWatch since the deploy: requests served, **0** import/module/secrets errors.
  The new `storage.ts` module graph loads cleanly in production.
- The temporary-key mint (`POST /v1/auth/temporary-api-key`) was exercised directly
  against Soniox and returned `201` with a valid `snx_temp_…`.

> ⚠️ The key currently in Secrets Manager was pasted into a chat transcript and is
> therefore exposed. Rotate it at Soniox and re-run the §2 update; no redeploy is
> needed, because the Lambda reads the secret at runtime.

## 7. Rollback

The previous implementation is in git history; `src-tauri/src/deepgram_transcriber.rs`
was deleted in this change and restores cleanly. To roll back:

1. `git revert` this change; `cd aws/api && npm run deploy`.
2. Rebuild and redistribute the desktop client (the live provider is compiled in).
3. `SONIOX_API_KEY` can be left in Secrets Manager; it is ignored when unused.

Deepgram's key and `/ai/transcribe` were untouched, so chat voice input is
unaffected in both directions.

## 8. Known gaps

- **Speaker names are manual.** Diarisation gives anonymous voices; the rename UI
  attaches names. Automatic name attribution (reading the meeting app's participant
  UI through the macOS accessibility API) is deliberately out of scope.
- **Async polling is bounded** at ~12 minutes inside the Lambda. A longer job keeps
  running at Soniox and is not lost, but the client sees a timeout error and falls
  back to the Gemini path rather than resuming by job id.
- The Gemini File-API / chunked upload path is retained as an automatic fallback
  when Soniox fails, so a provider outage degrades quality instead of losing a
  meeting. It is dead code on the happy path.
