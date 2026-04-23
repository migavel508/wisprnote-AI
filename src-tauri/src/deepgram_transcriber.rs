use anyhow::{Context, Result};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use std::sync::Arc;
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

const DEEPGRAM_WS_URL: &str = "wss://api.deepgram.com/v1/listen";

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

    async fn run_websocket(
        api_key: String,
        sample_rate: u32,
        keyterms: Option<Vec<String>>,
        mut audio_rx: mpsc::UnboundedReceiver<Vec<f32>>,
        transcript_tx: mpsc::UnboundedSender<String>,
    ) -> Result<()> {
        // Deepgram tuning for live meetings:
        // - diarize + utterances for speaker segmentation
        // - lower endpointing/utterance_end for faster stable finalization
        // - keyterm prompting for names/domain vocabulary
        let mut url = format!(
            "{}?encoding=linear16&sample_rate={}&channels=1&model=nova-3&language=en&interim_results=true&smart_format=true&punctuate=true&numerals=true&diarize=true&utterances=true&filler_words=false&endpointing=400&utterance_end_ms=1200&vad_events=true&no_delay=true",
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

        use tokio_tungstenite::tungstenite::client::IntoClientRequest;
        let mut request = url.into_client_request()
            .context("Failed to create WebSocket request")?;
        
        request.headers_mut().insert(
            "Authorization",
            format!("Token {}", api_key).parse()
                .context("Failed to parse authorization header")?
        );
        
        let (ws_stream, _response) = tokio_tungstenite::connect_async(request)
            .await
            .map_err(|e| anyhow::anyhow!("Failed to connect to Deepgram: {}", e))?;

        let (ws_tx, mut ws_rx) = ws_stream.split();
        let ws_tx = Arc::new(tokio::sync::Mutex::new(ws_tx));

        let keep_alive_handle = {
            let ws_tx = Arc::clone(&ws_tx);
            tokio::spawn(async move {
                let mut interval = tokio::time::interval(tokio::time::Duration::from_secs(5));
                loop {
                    interval.tick().await;
                    let keep_alive = serde_json::to_string(&KeepAliveMessage {
                        msg_type: "KeepAlive".to_string(),
                    })
                    .unwrap();
                    
                    let mut tx = ws_tx.lock().await;
                    if tx.send(Message::Text(keep_alive.into())).await.is_err() {
                        break;
                    }
                }
            })
        };

        let audio_send_handle = {
            let ws_tx = Arc::clone(&ws_tx);
            tokio::spawn(async move {
                while let Some(samples) = audio_rx.recv().await {
                    let bytes = Self::f32_to_i16_bytes(&samples);
                    let mut tx = ws_tx.lock().await;
                    if tx.send(Message::Binary(bytes)).await.is_err() {
                        break;
                    }
                }
                
                let mut tx = ws_tx.lock().await;
                let _ = tx.send(Message::Text(
                    serde_json::to_string(&serde_json::json!({"type": "CloseStream"}))
                        .unwrap()
                        .into()
                )).await;
            })
        };

        while let Some(msg) = ws_rx.next().await {
            match msg {
                Ok(Message::Text(text)) => {
                    if let Ok(response) = serde_json::from_str::<DeepgramResponse>(&text) {
                        match response {
                            DeepgramResponse::Results { channel, is_final, speech_final: _ } => {
                                if let Some(alt) = channel.alternatives.first() {
                                    if !alt.transcript.trim().is_empty() {
                                        let kind = if is_final { "FINAL" } else { "INTERIM" };
                                        let (speaker_hint, transcript_text) = if is_final {
                                            format_transcript_with_speakers(&alt.words, &alt.transcript)
                                        } else {
                                            (alt.words.first().and_then(|w| w.speaker), alt.transcript.trim().to_string())
                                        };
                                        let speaker_tag = speaker_hint
                                            .map(|s| s.to_string())
                                            .unwrap_or_else(|| "U".to_string());
                                        let msg = format!("[{}:{}] {}", kind, speaker_tag, transcript_text);
                                        let _ = transcript_tx.send(msg);
                                    }
                                }
                            }
                            DeepgramResponse::Metadata { .. } => {}
                            _ => {}
                        }
                    }
                }
                Ok(Message::Close(_)) => {
                    break;
                }
                Err(e) => {
                    eprintln!("WebSocket error: {}", e);
                    break;
                }
                _ => {}
            }
        }

        keep_alive_handle.abort();
        audio_send_handle.abort();

        Ok(())
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
