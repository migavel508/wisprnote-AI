use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::Deserialize;
use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const SONIOX_WS_URL: &str = "wss://stt-rt.soniox.com/transcribe-websocket";
const SONIOX_MODEL: &str = "stt-rt-v5";

/// Channel identity. The capture side delivers INTERLEAVED STEREO where ch0 is the
/// microphone and ch1 is system audio (the other participants), and half-duplex
/// gating guarantees a remote voice never bleeds onto ch0.
///
/// Soniox tokens carry a `speaker` but no channel field, so a single two-channel
/// socket would collapse that distinction — diarisation would number everyone
/// together and "who is the local user" would be unrecoverable. We therefore
/// de-interleave and run ONE SOCKET PER SOURCE, which is also what the reference
/// architecture does (two streams, one per source). Mic is labelled "You"
/// outright; only the system channel is diarised into "Speaker N".
#[derive(Clone, Copy, PartialEq, Eq)]
enum Source {
    Mic,
    System,
}

impl Source {
    fn label_for(&self, speaker: Option<&str>) -> String {
        match self {
            // The local user is known from the channel — never diarised.
            Source::Mic => "You".to_string(),
            Source::System => match speaker.and_then(|s| s.parse::<u32>().ok()) {
                // Soniox numbers speakers from 1; keep that as the display ordinal.
                Some(n) => format!("Speaker {}", n),
                None => "Speaker 1".to_string(),
            },
        }
    }

    fn name(&self) -> &'static str {
        match self {
            Source::Mic => "mic",
            Source::System => "system",
        }
    }
}

// Bounded buffer of audio captured DURING a reconnect outage, replayed to the fresh
// session so words spoken across a network blip aren't lost. Sized per MONO channel
// (the streams are de-interleaved before buffering).
//
// We deliberately replay ONLY outage audio — never the pre-drop tail already sent to
// the previous session. Re-sending audio that was already finalised would emit a
// second copy of a line the UI has already committed.
const REPLAY_SECS: usize = 5;
const REPLAY_MAX_SAMPLES: usize = REPLAY_SECS * 16_000; // mono

/// A gap larger than this between consecutive tokens closes the current utterance.
/// Soniox has no `is_endpoint` field (unlike some recognisers), so endpointing is
/// reconstructed here from token timestamps.
const UTTERANCE_GAP_MS: u64 = 1_200;

/// Append a chunk to the bounded outage-replay ring, evicting oldest-first so the
/// buffer never exceeds REPLAY_MAX_SAMPLES. For an outage longer than REPLAY_SECS
/// this keeps only the freshest window — a bounded, intentional loss.
fn push_replay(replay: &mut VecDeque<Vec<f32>>, total: &mut usize, chunk: Vec<f32>) {
    *total += chunk.len();
    replay.push_back(chunk);
    while *total > REPLAY_MAX_SAMPLES {
        match replay.pop_front() {
            Some(old) => *total -= old.len(),
            None => break,
        }
    }
}

enum StreamOutcome {
    /// Recorder closed the audio channel; the session is complete.
    Finished,
    /// Could not establish the connection (apply backoff before retrying).
    ConnectFailed(String),
    /// A live connection dropped mid-stream (reconnect promptly).
    Disconnected(String),
}

#[derive(Debug, Deserialize)]
struct SonioxToken {
    #[serde(default)]
    text: String,
    #[serde(default)]
    start_ms: u64,
    #[serde(default)]
    end_ms: u64,
    #[serde(default)]
    is_final: bool,
    #[serde(default)]
    speaker: Option<String>,
}

#[derive(Debug, Deserialize)]
struct SonioxResponse {
    #[serde(default)]
    tokens: Vec<SonioxToken>,
    #[serde(default)]
    finished: bool,
    #[serde(default)]
    error_code: Option<u32>,
    #[serde(default)]
    error_message: Option<String>,
}

/// Accumulates streamed tokens into speaker-coherent utterances.
///
/// Two rules, both taken from the reference architecture:
///   1. Only FINAL tokens are committed — interim text is preview only.
///   2. Adjacent tokens from the same speaker merge into ONE entry rather than
///      being appended as separate lines.
/// A line is closed when the speaker changes, a silence gap opens, or the stream ends.
struct UtteranceBuilder {
    source: Source,
    speaker: Option<String>,
    text: String,
    last_end_ms: u64,
}

impl UtteranceBuilder {
    fn new(source: Source) -> Self {
        Self { source, speaker: None, text: String::new(), last_end_ms: 0 }
    }

    /// Take the completed line, if any, leaving the builder empty.
    fn take(&mut self) -> Option<String> {
        let t = self.text.trim().to_string();
        self.text.clear();
        if t.is_empty() { None } else { Some(format!("[FINAL|{}] {}", self.source.label_for(self.speaker.as_deref()), t)) }
    }

    /// Feed one final token; returns a completed line when this token closed the previous one.
    fn push_final(&mut self, tok: &SonioxToken) -> Option<String> {
        let speaker_changed = self.speaker.is_some() && self.speaker.as_deref() != tok.speaker.as_deref();
        let gapped = self.last_end_ms > 0 && tok.start_ms.saturating_sub(self.last_end_ms) > UTTERANCE_GAP_MS;

        let flushed = if speaker_changed || gapped { self.take() } else { None };

        if self.text.is_empty() {
            self.speaker = tok.speaker.clone();
        }
        self.text.push_str(&tok.text);
        self.last_end_ms = tok.end_ms;
        flushed
    }

    /// Preview line: everything committed so far plus the pending interim text.
    fn interim(&self, pending: &str) -> Option<String> {
        let combined = format!("{}{}", self.text, pending);
        let t = combined.trim();
        if t.is_empty() {
            return None;
        }
        Some(format!("[INTERIM|{}] {}", self.source.label_for(self.speaker.as_deref()), t))
    }
}

pub struct SonioxTranscriber {
    #[allow(dead_code)]
    sample_rate: u32,
    // Option so we can DROP the audio senders on stop → each socket is closed with an
    // empty frame, Soniox flushes trailing FINAL tokens, and the recorder drains them.
    // Without this the last utterance (still showing as faded interim) is lost.
    mic_tx: Option<mpsc::UnboundedSender<Vec<f32>>>,
    sys_tx: Option<mpsc::UnboundedSender<Vec<f32>>>,
    transcript_rx: mpsc::UnboundedReceiver<String>,
}

impl SonioxTranscriber {
    /// `api_key` is a SHORT-LIVED temporary key minted by our backend
    /// (`POST /ai/soniox-token`). The permanent Soniox key never reaches the client —
    /// which is what makes shipping this source publicly safe.
    pub fn new(
        api_key: String,
        sample_rate: u32,
        terms: Option<Vec<String>>,
        language: Option<String>,
    ) -> Self {
        let (mic_tx, mic_rx) = mpsc::unbounded_channel();
        let (sys_tx, sys_rx) = mpsc::unbounded_channel();
        let (transcript_tx, transcript_rx) = mpsc::unbounded_channel();

        let lang = language.unwrap_or_else(|| "en".to_string());

        for (source, rx) in [(Source::Mic, mic_rx), (Source::System, sys_rx)] {
            let key = api_key.clone();
            let terms = terms.clone();
            let lang = lang.clone();
            let tx = transcript_tx.clone();
            tokio::spawn(async move {
                if let Err(e) = Self::run_channel(source, key, sample_rate, terms, lang, rx, tx).await {
                    eprintln!("Soniox {} stream error: {}", source.name(), e);
                }
            });
        }

        Self { sample_rate, mic_tx: Some(mic_tx), sys_tx: Some(sys_tx), transcript_rx }
    }

    /// Accepts INTERLEAVED STEREO (ch0 mic, ch1 system) exactly as the recorder
    /// produces it, and de-interleaves into the two per-source streams. Keeping this
    /// signature means the capture side is untouched by the provider swap.
    pub fn send_audio(&self, samples: Vec<f32>) -> Result<()> {
        if self.mic_tx.is_none() && self.sys_tx.is_none() {
            return Ok(());
        }
        let frames = samples.len() / 2;
        let mut mic = Vec::with_capacity(frames);
        let mut sys = Vec::with_capacity(frames);
        for frame in samples.chunks_exact(2) {
            mic.push(frame[0]);
            sys.push(frame[1]);
        }
        if let Some(tx) = &self.mic_tx {
            tx.send(mic).context("Failed to send mic samples")?;
        }
        if let Some(tx) = &self.sys_tx {
            tx.send(sys).context("Failed to send system samples")?;
        }
        Ok(())
    }

    /// Stop sending audio → each socket closes with an empty frame and Soniox flushes
    /// trailing FINAL tokens. The caller should keep polling `try_recv_transcript` for
    /// a few seconds afterwards to drain them.
    pub fn close_input(&mut self) {
        self.mic_tx.take();
        self.sys_tx.take();
    }

    pub fn try_recv_transcript(&mut self) -> Option<String> {
        self.transcript_rx.try_recv().ok()
    }

    /// Supervisor loop for ONE source: keeps a Soniox connection alive for the whole
    /// recording, reconnecting with backoff if the socket drops. Audio captured during
    /// an outage is buffered into a bounded replay ring and replayed to the fresh
    /// session. The ring lives at supervisor scope because it must survive across
    /// `stream_once` reconnects.
    async fn run_channel(
        source: Source,
        api_key: String,
        sample_rate: u32,
        terms: Option<Vec<String>>,
        language: String,
        mut audio_rx: mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: mpsc::UnboundedSender<String>,
    ) -> Result<()> {
        let config = Self::build_config(&api_key, sample_rate, terms, &language);
        let mut backoff_ms = 500u64;
        let mut replay: VecDeque<Vec<f32>> = VecDeque::new();
        let mut replay_samples: usize = 0;

        loop {
            match Self::stream_once(source, &config, &mut audio_rx, &transcript_tx, &mut replay, &mut replay_samples).await {
                StreamOutcome::Finished => break,
                StreamOutcome::Disconnected(reason) => {
                    backoff_ms = 500; // healthy connection that dropped: reset backoff
                    eprintln!("Soniox {} disconnected ({}); reconnecting in {}ms", source.name(), reason, backoff_ms);
                    if Self::pause_until(&mut audio_rx, backoff_ms, &mut replay, &mut replay_samples).await {
                        break;
                    }
                }
                StreamOutcome::ConnectFailed(reason) => {
                    eprintln!("Soniox {} connect failed ({}); retrying in {}ms", source.name(), reason, backoff_ms);
                    if Self::pause_until(&mut audio_rx, backoff_ms, &mut replay, &mut replay_samples).await {
                        break;
                    }
                    backoff_ms = (backoff_ms * 2).min(5000);
                }
            }
        }

        Ok(())
    }

    /// The first frame on every Soniox socket is the JSON config, which also carries
    /// authentication (there is no Authorization header on this API).
    fn build_config(
        api_key: &str,
        sample_rate: u32,
        terms: Option<Vec<String>>,
        language: &str,
    ) -> String {
        let mut cfg = serde_json::json!({
            "api_key": api_key,
            "model": SONIOX_MODEL,
            // De-interleaved mono PCM, matching f32_to_i16_bytes below.
            "audio_format": "pcm_s16le",
            "sample_rate": sample_rate,
            "num_channels": 1,
            // Server-side diarisation. On the mic channel the result is ignored (the
            // channel already identifies the speaker); on the system channel it is what
            // separates the remote participants into Speaker 1..N.
            "enable_speaker_diarization": true,
        });

        // "multi" means "let the recogniser decide" — send no hints at all.
        if !language.is_empty() && language != "multi" {
            cfg["language_hints"] = serde_json::json!([language]);
        }

        // Dictionary terms bias the recogniser toward the user's own vocabulary
        // (names, jargon). Unlike Deepgram's keyterms this is NOT English-only, so it
        // applies on every language.
        if let Some(terms) = terms {
            let terms: Vec<String> = terms
                .into_iter()
                .map(|t| t.trim().to_string())
                .filter(|t| !t.is_empty())
                .take(100)
                .collect();
            if !terms.is_empty() {
                cfg["context"] = serde_json::json!({ "terms": terms });
            }
        }

        cfg.to_string()
    }

    /// Connect once and stream until the recorder finishes or the socket drops.
    async fn stream_once(
        source: Source,
        config: &str,
        audio_rx: &mut mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: &mpsc::UnboundedSender<String>,
        replay: &mut VecDeque<Vec<f32>>,
        replay_samples: &mut usize,
    ) -> StreamOutcome {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let request = match SONIOX_WS_URL.to_string().into_client_request() {
            Ok(r) => r,
            Err(e) => return StreamOutcome::ConnectFailed(format!("request build: {}", e)),
        };

        // Bound the connect: on a black-holed network the OS can hang the handshake for
        // ~75s while the unbounded audio channel keeps filling with nothing draining it.
        let (ws_stream, _response) =
            match tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request)).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return StreamOutcome::ConnectFailed(format!("connect: {}", e)),
                Err(_) => return StreamOutcome::ConnectFailed("connect timeout".to_string()),
            };

        let (mut ws_tx, mut ws_rx) = ws_stream.split();

        // Config/auth frame must precede any audio.
        if ws_tx.send(Message::Text(config.to_string().into())).await.is_err() {
            return StreamOutcome::ConnectFailed("config send failed".to_string());
        }

        // DECOUPLED READ PATH. Responses are drained on their own task so a congested
        // upload (a `ws_tx.send().await` blocking on a full socket buffer) can never
        // stall response handling or let the OS receive buffer back up. Sharing one
        // `select!` between reads and writes made long meetings stutter and eventually
        // time out into a reconnect; keeping the reader always-live is the fix.
        let rx_transcript_tx = transcript_tx.clone();
        let mut rx_task = tokio::spawn(async move {
            let mut builder = UtteranceBuilder::new(source);
            while let Some(msg) = ws_rx.next().await {
                match msg {
                    Ok(Message::Text(text)) => {
                        if let Some(outcome) = Self::handle_text(&text, &mut builder, &rx_transcript_tx) {
                            return outcome;
                        }
                    }
                    Ok(Message::Close(frame)) => {
                        if let Some(line) = builder.take() {
                            let _ = rx_transcript_tx.send(line);
                        }
                        let reason = frame
                            .map(|f| format!("{} {}", f.code, f.reason))
                            .unwrap_or_else(|| "close".to_string());
                        return StreamOutcome::Disconnected(reason);
                    }
                    Ok(_) => {}
                    Err(e) => {
                        if let Some(line) = builder.take() {
                            let _ = rx_transcript_tx.send(line);
                        }
                        return StreamOutcome::Disconnected(format!("ws error: {}", e));
                    }
                }
            }
            if let Some(line) = builder.take() {
                let _ = rx_transcript_tx.send(line);
            }
            StreamOutcome::Disconnected("stream ended".to_string())
        });

        // Replay audio buffered during the outage (oldest first). Sequenced AFTER the
        // reader is live and BEFORE live audio resumes. The ring holds ONLY audio that
        // was never sent to any prior session, so it cannot produce a duplicate line.
        while let Some(chunk) = replay.pop_front() {
            *replay_samples = replay_samples.saturating_sub(chunk.len());
            let bytes = Self::f32_to_i16_bytes(&chunk);
            if ws_tx.send(Message::Binary(bytes.into())).await.is_err() {
                rx_task.abort();
                return StreamOutcome::Disconnected("replay send failed".to_string());
            }
        }

        // NOTE: no application-level keepalive. On this API an EMPTY frame means
        // "end of stream", so a heartbeat would terminate the session. The capture
        // side streams continuously (silence included), so the socket never idles.
        loop {
            tokio::select! {
                maybe_audio = audio_rx.recv() => {
                    match maybe_audio {
                        Some(samples) => {
                            let bytes = Self::f32_to_i16_bytes(&samples);
                            if ws_tx.send(Message::Binary(bytes.into())).await.is_err() {
                                rx_task.abort();
                                return StreamOutcome::Disconnected("audio send failed".to_string());
                            }
                        }
                        None => {
                            // Recorder stopped: an empty frame asks Soniox to finalise and
                            // flush trailing FINAL tokens, which the reader forwards for up
                            // to 2s before we finish the session.
                            let _ = ws_tx.send(Message::Binary(Vec::new().into())).await;
                            let _ = tokio::time::timeout(Duration::from_secs(2), &mut rx_task).await;
                            rx_task.abort();
                            return StreamOutcome::Finished;
                        }
                    }
                }
                rx_done = &mut rx_task => {
                    return rx_done.unwrap_or_else(|_| {
                        StreamOutcome::Disconnected("reader task aborted".to_string())
                    });
                }
            }
        }
    }

    /// Wait `wait_ms` before reconnecting, BUFFERING any audio captured during the
    /// outage so it can be replayed. Returns true if the recorder finished while
    /// waiting (so the supervisor stops).
    async fn pause_until(
        audio_rx: &mut mpsc::UnboundedReceiver<Vec<f32>>,
        wait_ms: u64,
        replay: &mut VecDeque<Vec<f32>>,
        replay_samples: &mut usize,
    ) -> bool {
        let deadline = tokio::time::sleep(Duration::from_millis(wait_ms));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return false,
                maybe = audio_rx.recv() => {
                    match maybe {
                        Some(samples) => push_replay(replay, replay_samples, samples),
                        None => return true,
                    }
                }
            }
        }
    }

    /// Fold one server message into the utterance builder, emitting completed FINAL
    /// lines and a rolling INTERIM preview. Returns Some(outcome) when the stream has
    /// ended (normally or with an error).
    fn handle_text(
        text: &str,
        builder: &mut UtteranceBuilder,
        transcript_tx: &mpsc::UnboundedSender<String>,
    ) -> Option<StreamOutcome> {
        let Ok(resp) = serde_json::from_str::<SonioxResponse>(text) else {
            return None;
        };

        if let Some(code) = resp.error_code {
            if let Some(line) = builder.take() {
                let _ = transcript_tx.send(line);
            }
            let msg = resp.error_message.unwrap_or_default();
            return Some(StreamOutcome::Disconnected(format!("soniox error {}: {}", code, msg)));
        }

        // Interim tokens are preview only and are never committed (rule 1).
        let mut pending = String::new();
        for tok in &resp.tokens {
            if tok.is_final {
                if let Some(line) = builder.push_final(tok) {
                    let _ = transcript_tx.send(line);
                }
            } else {
                pending.push_str(&tok.text);
            }
        }

        if let Some(preview) = builder.interim(&pending) {
            let _ = transcript_tx.send(preview);
        }

        if resp.finished {
            if let Some(line) = builder.take() {
                let _ = transcript_tx.send(line);
            }
            return Some(StreamOutcome::Disconnected("finished".to_string()));
        }
        None
    }

    fn f32_to_i16_bytes(samples: &[f32]) -> Vec<u8> {
        let mut bytes = Vec::with_capacity(samples.len() * 2);
        for &sample in samples {
            let clamped = sample.clamp(-1.0, 1.0);
            let i16_sample = (clamped * i16::MAX as f32) as i16;
            bytes.extend_from_slice(&i16_sample.to_le_bytes());
        }
        bytes
    }
}
