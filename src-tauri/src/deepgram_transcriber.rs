use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::time::Duration;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEEPGRAM_WS_URL: &str = "wss://api.deepgram.com/v1/listen";

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

fn group_words_by_speaker(words: &[Word]) -> Vec<(u32, String)> {
    let mut segments: Vec<(u32, String)> = Vec::new();
    for word in words {
        let speaker = word.speaker.unwrap_or(0);
        if let Some(last) = segments.last_mut() {
            if last.0 == speaker {
                last.1.push(' ');
                last.1.push_str(&word.word);
                continue;
            }
        }
        segments.push((speaker, word.word.clone()));
    }
    segments
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

fn format_transcript_with_speakers(words: &[Word], fallback: &str) -> (Option<u32>, String) {
    let segments = group_words_by_speaker(words);
    if segments.is_empty() {
        return (None, fallback.trim().to_string());
    }

    let first_speaker = segments.first().map(|(speaker, _)| *speaker);
    let text = segments
        .into_iter()
        .map(|(speaker, seg)| format!("Speaker {}: {}", speaker + 1, seg))
        .collect::<Vec<_>>()
        .join(" ");
    (first_speaker, text)
}

pub struct DeepgramTranscriber {
    #[allow(dead_code)]
    api_key: String,
    #[allow(dead_code)]
    sample_rate: u32,
    tx: mpsc::UnboundedSender<Vec<f32>>,
    transcript_rx: mpsc::UnboundedReceiver<String>,
}

impl DeepgramTranscriber {
    pub fn new(api_key: String, sample_rate: u32, keyterms: Option<Vec<String>>) -> Self {
        let (tx, rx) = mpsc::unbounded_channel();
        let (transcript_tx, transcript_rx) = mpsc::unbounded_channel();

        let api_key_clone = api_key.clone();
        tokio::spawn(async move {
            if let Err(e) = Self::run_websocket(api_key_clone, sample_rate, keyterms, rx, transcript_tx).await {
                eprintln!("Deepgram WebSocket error: {}", e);
            }
        });

        Self {
            api_key,
            sample_rate,
            tx,
            transcript_rx,
        }
    }

    pub fn send_audio(&self, samples: Vec<f32>) -> Result<()> {
        self.tx.send(samples).context("Failed to send audio samples")
    }

    pub fn try_recv_transcript(&mut self) -> Option<String> {
        self.transcript_rx.try_recv().ok()
    }

    /// Supervisor loop: keeps a Deepgram connection alive for the whole
    /// recording. If the socket drops (network blip, server-side close), it
    /// reconnects with backoff and resumes. Audio captured during an outage is
    /// discarded so transcription "pauses" and picks back up with live audio,
    /// matching the recorder's expectation of an uninterrupted session.
    async fn run_websocket(
        api_key: String,
        sample_rate: u32,
        keyterms: Option<Vec<String>>,
        mut audio_rx: mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: mpsc::UnboundedSender<String>,
    ) -> Result<()> {
        let url = Self::build_url(sample_rate, keyterms);
        let mut backoff_ms = 500u64;

        loop {
            match Self::stream_once(&api_key, &url, &mut audio_rx, &transcript_tx).await {
                StreamOutcome::Finished => break,
                StreamOutcome::Disconnected(reason) => {
                    // Healthy connection that dropped mid-stream: reset backoff.
                    backoff_ms = 500;
                    eprintln!("Deepgram disconnected ({}); reconnecting in {}ms", reason, backoff_ms);
                    if Self::pause_until(&mut audio_rx, backoff_ms).await {
                        break;
                    }
                }
                StreamOutcome::ConnectFailed(reason) => {
                    eprintln!("Deepgram connect failed ({}); retrying in {}ms", reason, backoff_ms);
                    if Self::pause_until(&mut audio_rx, backoff_ms).await {
                        break;
                    }
                    backoff_ms = (backoff_ms * 2).min(5000);
                }
            }
        }

        Ok(())
    }

    fn build_url(sample_rate: u32, keyterms: Option<Vec<String>>) -> String {
        // Deepgram tuning for live meetings:
        // - language=multi enables Nova-3 multilingual code-switching (detect_language
        //   is not supported on streaming, so multi is the real-time path)
        // - diarize + utterances for speaker segmentation
        // - endpointing/utterance_end tuned for stable finalization on long calls
        // - keyterm prompting for names/domain vocabulary
        let mut url = format!(
            "{}?encoding=linear16&sample_rate={}&channels=1&model=nova-3&language=multi&interim_results=true&smart_format=true&punctuate=true&numerals=true&diarize=true&utterances=true&filler_words=false&endpointing=400&utterance_end_ms=1200&vad_events=true&no_delay=true",
            DEEPGRAM_WS_URL, sample_rate
        );
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
        url
    }

    /// Connect once and stream until the recorder finishes or the socket drops.
    async fn stream_once(
        api_key: &str,
        url: &str,
        audio_rx: &mut mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: &mpsc::UnboundedSender<String>,
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

        let (ws_stream, _response) = match tokio_tungstenite::connect_async(request).await {
            Ok(s) => s,
            Err(e) => return StreamOutcome::ConnectFailed(format!("connect: {}", e)),
        };

        let (mut ws_tx, mut ws_rx) = ws_stream.split();
        let mut keep_alive = tokio::time::interval(Duration::from_secs(5));
        keep_alive.tick().await; // consume the immediate first tick

        loop {
            tokio::select! {
                maybe_audio = audio_rx.recv() => {
                    match maybe_audio {
                        Some(samples) => {
                            let bytes = Self::f32_to_i16_bytes(&samples);
                            if ws_tx.send(Message::Binary(bytes)).await.is_err() {
                                return StreamOutcome::Disconnected("audio send failed".to_string());
                            }
                        }
                        None => {
                            // Recorder stopped: tell Deepgram to flush, drain trailing
                            // results, then end the supervisor loop.
                            let _ = ws_tx.send(Message::Text(
                                serde_json::json!({"type": "CloseStream"}).to_string().into()
                            )).await;
                            let _ = tokio::time::timeout(Duration::from_secs(2), async {
                                while let Some(Ok(msg)) = ws_rx.next().await {
                                    match msg {
                                        Message::Text(text) => Self::handle_text(&text, transcript_tx),
                                        Message::Close(_) => break,
                                        _ => {}
                                    }
                                }
                            }).await;
                            return StreamOutcome::Finished;
                        }
                    }
                }
                maybe_msg = ws_rx.next() => {
                    match maybe_msg {
                        Some(Ok(Message::Text(text))) => Self::handle_text(&text, transcript_tx),
                        Some(Ok(Message::Close(frame))) => {
                            let reason = frame
                                .map(|f| format!("{} {}", f.code, f.reason))
                                .unwrap_or_else(|| "close".to_string());
                            return StreamOutcome::Disconnected(reason);
                        }
                        Some(Ok(_)) => {}
                        Some(Err(e)) => return StreamOutcome::Disconnected(format!("ws error: {}", e)),
                        None => return StreamOutcome::Disconnected("stream ended".to_string()),
                    }
                }
                _ = keep_alive.tick() => {
                    let keep_alive_msg = serde_json::to_string(&KeepAliveMessage {
                        msg_type: "KeepAlive".to_string(),
                    }).unwrap();
                    if ws_tx.send(Message::Text(keep_alive_msg.into())).await.is_err() {
                        return StreamOutcome::Disconnected("keepalive send failed".to_string());
                    }
                }
            }
        }
    }

    /// Wait `wait_ms` before reconnecting, discarding any audio captured during
    /// the outage. Returns true if the recorder finished while waiting.
    async fn pause_until(audio_rx: &mut mpsc::UnboundedReceiver<Vec<f32>>, wait_ms: u64) -> bool {
        let deadline = tokio::time::sleep(Duration::from_millis(wait_ms));
        tokio::pin!(deadline);
        loop {
            tokio::select! {
                _ = &mut deadline => return false,
                maybe = audio_rx.recv() => {
                    match maybe {
                        Some(_) => {} // discard audio captured while disconnected
                        None => return true,
                    }
                }
            }
        }
    }

    fn handle_text(text: &str, transcript_tx: &mpsc::UnboundedSender<String>) {
        let Ok(DeepgramResponse::Results { channel, is_final, .. }) =
            serde_json::from_str::<DeepgramResponse>(text)
        else {
            return;
        };
        let Some(alt) = channel.alternatives.first() else {
            return;
        };
        if alt.transcript.trim().is_empty() {
            return;
        }
        let kind = if is_final { "FINAL" } else { "INTERIM" };
        let (speaker_hint, transcript_text) = if is_final {
            format_transcript_with_speakers(&alt.words, &alt.transcript)
        } else {
            (alt.words.first().and_then(|w| w.speaker), alt.transcript.trim().to_string())
        };
        let speaker_tag = speaker_hint
            .map(|s| s.to_string())
            .unwrap_or_else(|| "U".to_string());
        let _ = transcript_tx.send(format!("[{}:{}] {}", kind, speaker_tag, transcript_text));
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
