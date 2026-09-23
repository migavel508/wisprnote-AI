# Changelog

Notable changes to Wisprnote. Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning is [semver](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Speaker names from meeting applications.** Reads the participant tiles of
  Zoom, Google Meet, Microsoft Teams and Slack huddles over the macOS
  Accessibility API and attaches real names to transcript turns. Google Meet and
  Slack are read from DOM class names; Teams and Zoom from accessibility
  descriptions. Accessibility permission is optional — without it a meeting is
  still recorded and diarised, speakers just stay "Speaker N" until renamed.
- **Outbound MCP server** exposing the meeting brain to other AI agents:
  `search_meetings`, `get_knowledge_graph`, `get_action_items`, `get_people`,
  `list_meetings`, `get_meeting_details`, `get_meeting_assets`.
- Structured transcript view — speakers in a left column, what they said on the
  right, replacing a single run-on paragraph.

### Changed
- **Transcription moved to Soniox.** One record button instead of the previous
  batch/realtime fork: live `stt-rt-v5` over WebSocket for recordings, and
  `stt-async-v5` for uploaded files. Mic and system audio are transcribed on
  separate sockets so the local user is never confused with a remote speaker.
- New brand mark across the app, installers and share images.

### Fixed
- Live transcripts were stored twice — the recorder's returned transcript and the
  renderer's accumulated copy were two views of one stream and both were saved.
- A literal NUL byte in `NotesPage.tsx` made the file read as binary to `grep`
  and other text tooling.

### Security
- The transcription provider key never reaches the client. The desktop app
  streams using a short-lived, websocket-scoped key minted per session; the
  permanent key stays server-side.
- Uploaded audio is passed to transcription as a short-lived signed URL derived
  from an object key scoped to the requesting user, so one account cannot
  transcribe another's recording.

[Unreleased]: https://github.com/migavel508/wisprnote-AI/commits/main
