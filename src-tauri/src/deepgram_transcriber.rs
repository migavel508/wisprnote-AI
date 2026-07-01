use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::collections::VecDeque;
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEEPGRAM_WS_URL: &str = "wss://api.deepgram.com/v1/listen";

// Bounded buffer of audio captured DURING a reconnect outage, replayed to the fresh
// Deepgram session on reconnect so words spoken across a network blip aren't lost.
// 16 kHz interleaved stereo (TARGET_HZ × 2 channels). Capped so neither a multi-hour
// meeting nor a long outage can grow memory.
//
// We deliberately replay ONLY this outage audio — never the pre-drop tail already sent
// to the previous session. With multichannel + diarize, Deepgram finalizes ch0 ("You")
// and ch1 ("Speaker N") independently and interleaved, and the UI dedup only collapses
// against the single last line; re-sending already-finalized audio would re-finalize a
// now-buried line and append a visible duplicate. Outage audio was never sent anywhere,
// so the fresh session transcribes it for the first time — it cannot duplicate. (An
// adversarial review of the in-flight-tail/“acoustic context” variant found it
// duplication-unsafe under this app's multichannel config; this is the safe subset.)
const REPLAY_SECS: usize = 5;
const REPLAY_MAX_SAMPLES: usize = REPLAY_SECS * 16_000 * 2; // ~160k f32 (~640 KB)

/// Append a chunk to the bounded outage-replay ring, evicting oldest-first (FIFO) so
/// the buffer never exceeds REPLAY_MAX_SAMPLES. `total` tracks the exact sample count
/// so the cap is O(1) to enforce regardless of how chunks are sized. For an outage
/// longer than REPLAY_SECS this keeps only the freshest window — a bounded, intentional
/// loss (the earliest outage words age out rather than growing memory unbounded).
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

#[derive(Debug, Serialize)]
struct KeepAliveMessage {
    #[serde(rename = "type")]
    msg_type: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type")]
enum DeepgramResponse {
    #[serde(rename = "Results")]
    Results {
        channel: Channel,
        #[serde(default)]
        is_final: bool,
        #[serde(default)]
        speech_final: bool,
        // [channel_index, total_channels] — ch0 = mic (You), ch1 = system (participants).
        #[serde(default)]
        channel_index: Vec<u32>,
    },
    #[serde(rename = "Metadata")]
    Metadata {
        #[allow(dead_code)]
        request_id: String,
    },
    #[serde(other)]
    Other,
}

#[derive(Debug, Deserialize)]
struct Channel {
    alternatives: Vec<Alternative>,
}

#[derive(Debug, Deserialize)]
struct Word {
    word: String,
    #[serde(default)]
    speaker: Option<u32>,
}

#[derive(Debug, Deserialize)]
struct Alternative {
    transcript: String,
    #[allow(dead_code)]
    confidence: f64,
    #[serde(default)]
    words: Vec<Word>,
}

fn percent_encode_query_value(value: &str) -> String {
    let mut encoded = String::new();
    for byte in value.as_bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                encoded.push(*byte as char)
            }
            b' ' => encoded.push_str("%20"),
            _ => encoded.push_str(&format!("%{:02X}", byte)),
        }
    }
    encoded
}

/// Resolve a display label. ch0 = the mic = "You". ch1 = participants, where diarize tells
/// us which remote speaker (1-based).
fn speaker_label(channel: u32, words: &[Word]) -> String {
    if channel == 0 {
        return "You".to_string();
    }
    let spk = words.first().and_then(|w| w.speaker).unwrap_or(0);
    format!("Speaker {}", spk + 1)
}

pub struct DeepgramTranscriber {
    #[allow(dead_code)]
    api_key: String,
    #[allow(dead_code)]
    sample_rate: u32,
    // Option so we can DROP the audio sender on stop → Deepgram flushes its trailing
    // FINAL results (the last words you spoke), which the recorder then drains. Without
    // this the final utterance (still shown as faded interim) is lost.
    tx: Option<mpsc::UnboundedSender<Vec<f32>>>,
    transcript_rx: mpsc::UnboundedReceiver<String>,
}

impl DeepgramTranscriber {
    pub fn new(api_key: String, sample_rate: u32, keyterms: Option<Vec<String>>, language: Option<String>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let (transcript_tx, transcript_rx) = mpsc::unbounded_channel();

        let api_key_clone = api_key.clone();
        let lang = language.unwrap_or_else(|| "en".to_string());
        tokio::spawn(async move {
            if let Err(e) = Self::run_websocket(api_key_clone, sample_rate, keyterms, lang, rx, transcript_tx).await {
                eprintln!("Deepgram WebSocket error: {}", e);
            }
        });

        Self {
            api_key,
            sample_rate,
            tx: Some(tx),
            transcript_rx,
        }
    }

    pub fn send_audio(&self, samples: Vec<f32>) -> Result<()> {
        match &self.tx {
            Some(tx) => tx.send(samples).context("Failed to send audio samples"),
            None => Ok(()),
        }
    }

    /// Stop sending audio → Deepgram flushes trailing FINAL results. The caller should
    /// keep polling `try_recv_transcript` for a few seconds afterwards to drain them.
    pub fn close_input(&mut self) {
        self.tx.take();
    }

    pub fn try_recv_transcript(&mut self) -> Option<String> {
        self.transcript_rx.try_recv().ok()
    }

    /// Supervisor loop: keeps a Deepgram connection alive for the whole
    /// recording. If the socket drops (network blip, server-side close), it
    /// reconnects with backoff and resumes. Audio captured during the outage is
    /// BUFFERED into a bounded replay ring (`REPLAY_SECS` cap) instead of being
    /// discarded, then replayed to the fresh session on reconnect — so the words
    /// spoken across a brief blip survive instead of vanishing. The ring lives here,
    /// at supervisor scope, because it must persist across `stream_once` reconnects
    /// (a buffer owned by `stream_once` would be dropped on every disconnect). An
    /// outage longer than `REPLAY_SECS` keeps only its freshest window.
    async fn run_websocket(
        api_key: String,
        sample_rate: u32,
        keyterms: Option<Vec<String>>,
        language: String,
        mut audio_rx: mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: mpsc::UnboundedSender<String>,
    ) -> Result<()> {
        let url = Self::build_url(sample_rate, keyterms, &language);
        let mut backoff_ms = 500u64;
        // Outage-replay ring + running sample count (see push_replay / REPLAY_MAX_SAMPLES).
        let mut replay: VecDeque<Vec<f32>> = VecDeque::new();
        let mut replay_samples: usize = 0;

        loop {
            match Self::stream_once(&api_key, &url, &mut audio_rx, &transcript_tx, &mut replay, &mut replay_samples).await {
                StreamOutcome::Finished => break,
                StreamOutcome::Disconnected(reason) => {
                    // Healthy connection that dropped mid-stream: reset backoff.
                    backoff_ms = 500;
                    eprintln!("Deepgram disconnected ({}); reconnecting in {}ms", reason, backoff_ms);
                    if Self::pause_until(&mut audio_rx, backoff_ms, &mut replay, &mut replay_samples).await {
                        break;
                    }
                }
                StreamOutcome::ConnectFailed(reason) => {
                    eprintln!("Deepgram connect failed ({}); retrying in {}ms", reason, backoff_ms);
                    if Self::pause_until(&mut audio_rx, backoff_ms, &mut replay, &mut replay_samples).await {
                        break;
                    }
                    backoff_ms = (backoff_ms * 2).min(5000);
                }
            }
        }

        Ok(())
    }

    fn build_url(sample_rate: u32, keyterms: Option<Vec<String>>, language: &str) -> String {
        // Deepgram tuning for live meetings:
        // - language selectable (default "en"; "multi" for code-switching).
        // - MULTICHANNEL source labelling: ch0 = mic (You), ch1 = system (Participants). The
        //   capture side HALF-DUPLEX gates the mic to silence whenever the system is active, so
        //   the participant's voice (acoustic echo) never lands on ch0 — clean source labels
        //   with no duplication, no echo canceller. diarize splits multiple remote people on ch1.
        // - endpointing/utterance_end tuned for low-latency finalization.
        // - keyterm prompting for names/domain vocabulary.
        let mut url = format!(
            "{}?encoding=linear16&sample_rate={}&channels=2&multichannel=true&model=nova-3&language={}&interim_results=true&smart_format=true&punctuate=true&numerals=true&diarize=true&utterances=true&filler_words=false&endpointing=300&utterance_end_ms=1000&vad_events=true&no_delay=true",
            DEEPGRAM_WS_URL, sample_rate, language
        );
        // Deepgram keyterm prompting is Nova-3 ENGLISH-ONLY. Sending `keyterm=` with a
        // non-English/multilingual model makes the WebSocket handshake fail (400), which
        // surfaced as a repeating realtime_recording_error once the dictionary always
        // populated keyterms. Only bias for English; other languages still benefit from
        // the post-transcription dictionary correction pass.
        if language.starts_with("en") {
            if let Some(terms) = keyterms {
                for term in terms
                    .into_iter()
                    .map(|t| t.trim().to_string())
                    .filter(|t| !t.is_empty())
                    .take(50)
                {
                    url.push_str("&keyterm=");
                    url.push_str(&percent_encode_query_value(&term));
                }
            }
        }
        url
    }

    /// Connect once and stream until the recorder finishes or the socket drops.
    /// On a reconnect the `replay` ring holds audio captured during the outage; it is
    /// replayed to the fresh session before live audio resumes.
    async fn stream_once(
        api_key: &str,
        url: &str,
        audio_rx: &mut mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: &mpsc::UnboundedSender<String>,
        replay: &mut VecDeque<Vec<f32>>,
        replay_samples: &mut usize,
    ) -> StreamOutcome {
        use tokio_tungstenite::tungstenite::client::IntoClientRequest;

        let mut request = match url.to_string().into_client_request() {
            Ok(r) => r,
            Err(e) => return StreamOutcome::ConnectFailed(format!("request build: {}", e)),
        };
        // `api_key` is now a short-lived access token minted by our backend
        // (Deepgram /v1/auth/grant), so it uses the Bearer scheme. The real
        // Deepgram API key never reaches the client.
        match format!("Bearer {}", api_key).parse() {
            Ok(value) => {
                request.headers_mut().insert("Authorization", value);
            }
            Err(e) => return StreamOutcome::ConnectFailed(format!("auth header: {}", e)),
        }

        // Bound the connect: on a black-holed network (firewall dropping SYN, stalled TLS)
        // the OS can hang the handshake for ~75s, during which the unbounded audio channel
        // keeps filling (~128 KB/s) with nothing draining it. Cap it so a bad reconnect
        // fails fast into backoff (where pause_until drains the channel) instead.
        let (ws_stream, _response) =
            match tokio::time::timeout(Duration::from_secs(10), tokio_tungstenite::connect_async(request)).await {
                Ok(Ok(s)) => s,
                Ok(Err(e)) => return StreamOutcome::ConnectFailed(format!("connect: {}", e)),
                Err(_) => return StreamOutcome::ConnectFailed("connect timeout".to_string()),
            };

        let (mut ws_tx, mut ws_rx) = ws_stream.split();

        // DECOUPLED READ PATH. Responses are drained on their own task so that a
        // congested / slow upload (a `ws_tx.send().await` that blocks because the
        // socket's send buffer is full) can NEVER stall response handling, the
        // keep-alive, or let the OS receive buffer back up. Previously all three
        // shared one `select!`, so a brief upload hiccup mid-meeting would freeze
        // reads → Deepgram would time the connection out → reconnect (discarding
        // audio). That cascade is exactly what made long meetings stutter, lag and
        // sometimes stop transcribing. Keeping the reader always-live is what
        // anarlog/Hyprnote does (separate TX/RX tasks), and is the core fix here.
        let rx_transcript_tx = transcript_tx.clone();
        let mut rx_task = tokio::spawn(async move {
            while let Some(msg) = ws_rx.next().await {
                match msg {
                    Ok(Message::Text(text)) => Self::handle_text(&text, &rx_transcript_tx),
                    Ok(Message::Close(frame)) => {
                        let reason = frame
                            .map(|f| format!("{} {}", f.code, f.reason))
                            .unwrap_or_else(|| "close".to_string());
                        return StreamOutcome::Disconnected(reason);
                    }
                    Ok(_) => {}
                    Err(e) => return StreamOutcome::Disconnected(format!("ws error: {}", e)),
                }
            }
            StreamOutcome::Disconnected("stream ended".to_string())
        });

        // Replay audio buffered during the outage (oldest first), so words spoken across
        // the blip land in the new session. Sequenced AFTER the reader task is live (so the
        // transcripts this generates are read) and BEFORE the live select! loop. The ring
        // holds ONLY outage audio (never sent to any prior session), so this can't produce a
        // duplicate line. Drain as we send: a chunk whose send fails is on a dead socket
        // anyway, and the rest stays buffered for the next reconnect. On the first connect
        // the ring is empty, so this is a no-op and behaviour is identical to before.
        while let Some(chunk) = replay.pop_front() {
            *replay_samples = replay_samples.saturating_sub(chunk.len());
            let bytes = Self::f32_to_i16_bytes(&chunk);
            if ws_tx.send(Message::Binary(bytes)).await.is_err() {
                rx_task.abort();
                return StreamOutcome::Disconnected("replay send failed".to_string());
            }
        }

        let mut keep_alive = tokio::time::interval(Duration::from_secs(5));
        keep_alive.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                maybe_audio = audio_rx.recv() => {
                    match maybe_audio {
                        Some(samples) => {
                            let bytes = Self::f32_to_i16_bytes(&samples);
                            if ws_tx.send(Message::Binary(bytes)).await.is_err() {
                                rx_task.abort();
                                return StreamOutcome::Disconnected("audio send failed".to_string());
                            }
                        }
                        None => {
                            // Recorder stopped: tell Deepgram to flush its trailing FINAL
                            // results, then let the reader task drain them (it forwards to
                            // transcript_tx) for up to 2s before we finish the session.
                            let _ = ws_tx.send(Message::Text(
                                serde_json::json!({"type": "CloseStream"}).to_string().into()
                            )).await;
                            let _ = tokio::time::timeout(Duration::from_secs(2), &mut rx_task).await;
                            rx_task.abort();
                            return StreamOutcome::Finished;
                        }
                    }
                }
                rx_done = &mut rx_task => {
                    // Read side ended first (server closed the socket, or a read error):
                    // surface the reason so the supervisor reconnects with backoff.
                    return rx_done.unwrap_or_else(|_| {
                        StreamOutcome::Disconnected("reader task aborted".to_string())
                    });
                }
                _ = keep_alive.tick() => {
                    let keep_alive_msg = serde_json::to_string(&KeepAliveMessage {
                        msg_type: "KeepAlive".to_string(),
                    }).unwrap();
                    if ws_tx.send(Message::Text(keep_alive_msg.into())).await.is_err() {
                        rx_task.abort();
                        return StreamOutcome::Disconnected("keepalive send failed".to_string());
                    }
                }
            }
        }
    }

    /// Wait `wait_ms` before reconnecting, BUFFERING any audio captured during the
    /// outage into the bounded replay ring (capped at `REPLAY_SECS`) so it can be
    /// replayed to the fresh session instead of being lost. Returns true if the
    /// recorder finished while waiting (so the supervisor stops).
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
                        Some(samples) => push_replay(replay, replay_samples, samples), // keep outage audio for replay
                        None => return true,
                    }
                }
            }
        }
    }

    fn handle_text(text: &str, transcript_tx: &mpsc::UnboundedSender<String>) {
        let Ok(DeepgramResponse::Results { channel, is_final, channel_index, .. }) =
            serde_json::from_str::<DeepgramResponse>(text)
        else {
            return;
        };
        let Some(alt) = channel.alternatives.first() else {
            return;
        };
        let transcript_text = alt.transcript.trim();
        if transcript_text.is_empty() {
            return;
        }
        let kind = if is_final { "FINAL" } else { "INTERIM" };
        // ch0 = mic (You), ch1 = system (participants). Protocol: "[KIND|Label] text".
        let ch = channel_index.first().copied().unwrap_or(0);
        let label = speaker_label(ch, &alt.words);
        let _ = transcript_tx.send(format!("[{}|{}] {}", kind, label, transcript_text));
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
