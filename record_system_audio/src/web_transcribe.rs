use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::broadcast;

use anyhow::Result;
use cidre::{av, cat, cf, ns, os};
use cidre::core_audio as ca;
use ringbuf::{HeapRb, traits::Split};

mod deepgram_transcriber;
use deepgram_transcriber::DeepgramTranscriber;

const BUFFER_SIZE: usize = 65536;
const CHUNK_SIZE: usize = 4800;

struct Ctx {
    common_format: av::audio::CommonFormat,
    producer: ringbuf::HeapProd<f32>,
}

extern "C" fn mic_io_proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input_data: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output_data: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    ctx: Option<&mut Ctx>,
) -> os::Status {
    let ctx = ctx.unwrap();
    let buf = &input_data.buffers[0];

    if buf.data_bytes_size == 0 || buf.data.is_null() {
        return os::Status::NO_ERR;
    }

    match ctx.common_format {
        av::audio::CommonFormat::PcmF32 => {
            if let Some(samples) = read_samples::<f32>(buf) {
                use ringbuf::traits::Producer;
                ctx.producer.push_slice(samples);
            }
        }
        av::audio::CommonFormat::PcmF64 => {
            convert_and_push::<f64>(buf, &mut ctx.producer, |x| x as f32);
        }
        av::audio::CommonFormat::PcmI32 => {
            convert_and_push::<i32>(buf, &mut ctx.producer, |x| x as f32 / i32::MAX as f32);
        }
        av::audio::CommonFormat::PcmI16 => {
            convert_and_push::<i16>(buf, &mut ctx.producer, |x| x as f32 / i16::MAX as f32);
        }
        _ => {}
    }

    os::Status::NO_ERR
}

extern "C" fn system_io_proc(
    _device: ca::Device,
    _now: &cat::AudioTimeStamp,
    input_data: &cat::AudioBufList<1>,
    _input_time: &cat::AudioTimeStamp,
    _output_data: &mut cat::AudioBufList<1>,
    _output_time: &cat::AudioTimeStamp,
    ctx: Option<&mut Ctx>,
) -> os::Status {
    let ctx = ctx.unwrap();
    let buf = &input_data.buffers[0];

    if buf.data_bytes_size == 0 || buf.data.is_null() {
        return os::Status::NO_ERR;
    }

    match ctx.common_format {
        av::audio::CommonFormat::PcmF32 => {
            if let Some(samples) = read_samples::<f32>(buf) {
                use ringbuf::traits::Producer;
                ctx.producer.push_slice(samples);
            }
        }
        av::audio::CommonFormat::PcmF64 => {
            convert_and_push::<f64>(buf, &mut ctx.producer, |x| x as f32);
        }
        av::audio::CommonFormat::PcmI32 => {
            convert_and_push::<i32>(buf, &mut ctx.producer, |x| x as f32 / i32::MAX as f32);
        }
        av::audio::CommonFormat::PcmI16 => {
            convert_and_push::<i16>(buf, &mut ctx.producer, |x| x as f32 / i16::MAX as f32);
        }
        _ => {}
    }

    os::Status::NO_ERR
}

fn read_samples<T: Copy>(buf: &cat::AudioBuf) -> Option<&[T]> {
    let byte_count = buf.data_bytes_size as usize;
    if byte_count == 0 || buf.data.is_null() {
        return None;
    }
    let ptr = buf.data as *const T;
    if !(ptr as usize).is_multiple_of(std::mem::align_of::<T>()) {
        return None;
    }
    let count = byte_count / std::mem::size_of::<T>();
    if count == 0 {
        return None;
    }
    Some(unsafe { std::slice::from_raw_parts(ptr, count) })
}

fn convert_and_push<T: Copy>(
    buf: &cat::AudioBuf,
    producer: &mut ringbuf::HeapProd<f32>,
    convert: impl Fn(T) -> f32,
) {
    let Some(samples) = read_samples::<T>(buf) else { return };
    use ringbuf::traits::Producer;
    for &s in samples {
        let _ = producer.try_push(convert(s));
    }
}

async fn start_web_server(tx: broadcast::Sender<String>) {
    use warp::Filter;
    use futures_util::{StreamExt, SinkExt};

    let tx = Arc::new(tx);

    let ws_route = warp::path("ws")
        .and(warp::ws())
        .map(move |ws: warp::ws::Ws| {
            let tx = tx.clone();
            ws.on_upgrade(move |websocket| async move {
                let (mut ws_tx, _ws_rx) = websocket.split();
                let mut rx = tx.subscribe();
                
                while let Ok(msg) = rx.recv().await {
                    if ws_tx.send(warp::ws::Message::text(msg)).await.is_err() {
                        break;
                    }
                }
            })
        });

    let html = r##"<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Live Transcription</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: #0f172a;
            min-height: 100vh;
            color: #e2e8f0;
        }
        .header {
            background: linear-gradient(135deg, #1e293b 0%, #334155 100%);
            padding: 20px 30px;
            border-bottom: 1px solid #334155;
            display: flex;
            justify-content: space-between;
            align-items: center;
        }
        .title { display: flex; align-items: center; gap: 12px; }
        .title h1 { font-size: 1.5em; font-weight: 600; color: #f8fafc; }
        .statusbadge {
            display: flex;
            align-items: center;
            gap: 8px;
            background: #1e293b;
            padding: 8px 16px;
            border-radius: 20px;
            font-size: 0.9em;
        }
        .statusdot {
            width: 8px;
            height: 8px;
            border-radius: 50%;
            background: #22c55e;
            animation: pulse 2s infinite;
        }
        .statusdot.disconnected { background: #ef4444; animation: none; }
        @keyframes pulse {
            0%, 100% { opacity: 1; box-shadow: 0 0 0 0 rgba(34, 197, 94, 0.4); }
            50% { opacity: 0.8; box-shadow: 0 0 0 8px rgba(34, 197, 94, 0); }
        }
        .main { max-width: 900px; margin: 0 auto; padding: 30px; }
        .transcriptbox {
            background: #1e293b;
            border-radius: 16px;
            border: 1px solid #334155;
            min-height: 70vh;
            max-height: 80vh;
            overflow-y: auto;
        }
        .transcriptheader {
            padding: 16px 24px;
            border-bottom: 1px solid #334155;
            font-size: 0.85em;
            color: #94a3b8;
            text-transform: uppercase;
            letter-spacing: 0.05em;
        }
        .transcriptcontent { padding: 20px 24px; }
        .entry {
            display: flex;
            gap: 16px;
            padding: 12px 0;
            border-bottom: 1px solid #334155;
            animation: fadeIn 0.3s ease-out;
        }
        .entry:last-child { border-bottom: none; }
        @keyframes fadeIn {
            from { opacity: 0; transform: translateY(-5px); }
            to { opacity: 1; transform: translateY(0); }
        }
        .time {
            flex-shrink: 0;
            font-size: 0.85em;
            color: #64748b;
            font-family: monospace;
            padding-top: 2px;
        }
        .text { flex: 1; font-size: 1.1em; line-height: 1.6; color: #f1f5f9; }
        .emptystate {
            display: flex;
            flex-direction: column;
            align-items: center;
            justify-content: center;
            padding: 80px 20px;
            color: #64748b;
        }
        .emptystate svg { width: 64px; height: 64px; margin-bottom: 16px; opacity: 0.5; }
        .liveindicator {
            display: none;
            align-items: center;
            gap: 8px;
            padding: 12px 24px;
            background: #334155;
            border-radius: 0 0 16px 16px;
            font-size: 0.9em;
            color: #94a3b8;
        }
        .liveindicator.active { display: flex; }
        .livetext { color: #cbd5e1; font-style: italic; }
        .dots { display: flex; gap: 4px; }
        .dots span {
            width: 6px; height: 6px;
            background: #64748b;
            border-radius: 50%;
            animation: typing 1.4s infinite;
        }
        .dots span:nth-child(2) { animation-delay: 0.2s; }
        .dots span:nth-child(3) { animation-delay: 0.4s; }
        @keyframes typing {
            0%, 60%, 100% { transform: translateY(0); }
            30% { transform: translateY(-4px); }
        }
        .stats {
            display: flex;
            gap: 24px;
            margin-top: 20px;
            padding: 16px 24px;
            background: #1e293b;
            border-radius: 12px;
            border: 1px solid #334155;
        }
        .stat { display: flex; flex-direction: column; gap: 4px; }
        .statlabel { font-size: 0.75em; color: #64748b; text-transform: uppercase; letter-spacing: 0.05em; }
        .statvalue { font-size: 1.2em; font-weight: 600; color: #f1f5f9; }
    </style>
</head>
<body>
    <div class="header">
        <div class="title">
            <svg width="28" height="28" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
            </svg>
            <h1>Live Transcription</h1>
        </div>
        <div class="statusbadge">
            <div class="statusdot" id="statusDot"></div>
            <span id="status">Connecting...</span>
        </div>
    </div>

    <div class="main">
        <div class="transcriptbox">
            <div class="transcriptheader">Transcript</div>
            <div class="transcriptcontent" id="transcriptions">
                <div class="emptystate" id="emptyState">
                    <svg fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z"></path>
                    </svg>
                    <p>Waiting for speech...</p>
                </div>
            </div>
            <div class="liveindicator" id="liveIndicator">
                <div class="dots"><span></span><span></span><span></span></div>
                <span class="livetext" id="interimText">Listening...</span>
            </div>
        </div>

        <div class="stats">
            <div class="stat">
                <span class="statlabel">Duration</span>
                <span class="statvalue" id="duration">00:00</span>
            </div>
            <div class="stat">
                <span class="statlabel">Sentences</span>
                <span class="statvalue" id="sentenceCount">0</span>
            </div>
            <div class="stat">
                <span class="statlabel">Words</span>
                <span class="statvalue" id="wordCount">0</span>
            </div>
        </div>
    </div>

    <script>
        var ws = new WebSocket('ws://' + window.location.host + '/ws');
        var transcriptionsDiv = document.getElementById('transcriptions');
        var emptyState = document.getElementById('emptyState');
        var statusSpan = document.getElementById('status');
        var statusDot = document.getElementById('statusDot');
        var liveIndicator = document.getElementById('liveIndicator');
        var interimText = document.getElementById('interimText');
        var durationEl = document.getElementById('duration');
        var sentenceCountEl = document.getElementById('sentenceCount');
        var wordCountEl = document.getElementById('wordCount');

        var lastFinalText = '';
        var sentenceCount = 0;
        var wordCount = 0;
        var startTime = null;
        var durationInterval = null;

        function formatTime(date) {
            return date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
        }

        function updateDuration() {
            if (!startTime) return;
            var elapsed = Math.floor((Date.now() - startTime) / 1000);
            var mins = Math.floor(elapsed / 60).toString().padStart(2, '0');
            var secs = (elapsed % 60).toString().padStart(2, '0');
            durationEl.textContent = mins + ':' + secs;
        }

        ws.onopen = function() {
            statusSpan.textContent = 'Listening';
            statusDot.classList.remove('disconnected');
            startTime = Date.now();
            durationInterval = setInterval(updateDuration, 1000);
        };

        ws.onmessage = function(event) {
            var text = event.data;
            var isFinal = text.indexOf('[FINAL]') === 0;
            var isInterim = text.indexOf('[INTERIM]') === 0;
            var cleanText = text.replace('[FINAL] ', '').replace('[INTERIM] ', '').trim();
            
            if (!cleanText) return;

            if (isInterim) {
                liveIndicator.classList.add('active');
                interimText.textContent = cleanText;
                return;
            }

            if (isFinal) {
                liveIndicator.classList.remove('active');
                
                if (cleanText === lastFinalText) return;
                lastFinalText = cleanText;

                if (emptyState && emptyState.parentNode) {
                    emptyState.parentNode.removeChild(emptyState);
                }

                var entry = document.createElement('div');
                entry.className = 'entry';
                entry.innerHTML = '<span class="time">' + formatTime(new Date()) + '</span><span class="text">' + cleanText + '</span>';
                
                transcriptionsDiv.appendChild(entry);
                transcriptionsDiv.scrollTop = transcriptionsDiv.scrollHeight;

                sentenceCount++;
                wordCount += cleanText.split(' ').length;
                sentenceCountEl.textContent = sentenceCount;
                wordCountEl.textContent = wordCount;
            }
        };

        ws.onerror = function() {
            statusSpan.textContent = 'Error';
            statusDot.classList.add('disconnected');
        };

        ws.onclose = function() {
            statusSpan.textContent = 'Disconnected';
            statusDot.classList.add('disconnected');
            liveIndicator.classList.remove('active');
            if (durationInterval) clearInterval(durationInterval);
        };
    </script>
</body>
</html>"##;

    let index = warp::path::end()
        .map(move || warp::reply::html(html));

    let routes = index.or(ws_route);

    println!("\n🌐 Web interface available at: http://localhost:3030");
    println!("   Open this URL in your browser to see transcriptions\n");

    warp::serve(routes)
        .run(([127, 0, 0, 1], 3030))
        .await;
}

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let mut api_key = std::env::var("DEEPGRAM_API_KEY").ok();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--api-key" | "-k" => {
                i += 1;
                api_key = Some(args[i].clone());
            }
            "--help" | "-h" => {
                println!("Usage: web_transcribe [--api-key <key>]");
                println!("\nCaptures BOTH microphone and system audio for real-time transcription");
                println!("Runs indefinitely until you press Ctrl+C to stop");
                println!("Displays results in a web browser interface at http://localhost:3030");
                println!("\nEnvironment variables:");
                println!("  DEEPGRAM_API_KEY - Deepgram API key (can also use --api-key)");
                return Ok(());
            }
            other => eprintln!("Unknown arg: {other}"),
        }
        i += 1;
    }

    let api_key = api_key.expect("DEEPGRAM_API_KEY not set. Use --api-key or set environment variable.");

    let (broadcast_tx, _) = broadcast::channel::<String>(100);
    let broadcast_tx_clone = broadcast_tx.clone();

    tokio::spawn(async move {
        start_web_server(broadcast_tx_clone).await;
    });

    tokio::time::sleep(Duration::from_millis(500)).await;

    println!("Setting up microphone capture...");
    let mic_device = ca::System::default_input_device()?;
    let mic_asbd = mic_device.input_asbd()?;
    let mic_format = av::AudioFormat::with_asbd(&mic_asbd).unwrap();
    let mic_common_format = mic_format.common_format();
    
    println!("Setting up system audio capture...");
    let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
    let tap = tap_desc.create_process_tap()?;
    let tap_asbd = tap.asbd().unwrap();
    let sample_rate = tap_asbd.sample_rate as u32;
    let tap_format = av::AudioFormat::with_asbd(&tap_asbd).unwrap();
    let tap_common_format = tap_format.common_format();

    println!("Microphone  : {} Hz, {:?}", mic_asbd.sample_rate as u32, mic_common_format);
    println!("System Audio: {} Hz, {:?}", sample_rate, tap_common_format);

    let mic_rb = HeapRb::<f32>::new(BUFFER_SIZE);
    let (mic_producer, mut mic_consumer) = mic_rb.split();
    let mut mic_ctx = Box::new(Ctx { common_format: mic_common_format, producer: mic_producer });

    let system_rb = HeapRb::<f32>::new(BUFFER_SIZE);
    let (system_producer, mut system_consumer) = system_rb.split();
    let mut system_ctx = Box::new(Ctx { common_format: tap_common_format, producer: system_producer });

    let sub_tap = cf::DictionaryOf::with_keys_values(
        &[ca::sub_device_keys::uid()],
        &[tap.uid().unwrap().as_type_ref()],
    );

    let agg_desc = cf::DictionaryOf::with_keys_values(
        &[
            ca::aggregate_device_keys::is_private(),
            ca::aggregate_device_keys::tap_auto_start(),
            ca::aggregate_device_keys::name(),
            ca::aggregate_device_keys::uid(),
            ca::aggregate_device_keys::tap_list(),
        ],
        &[
            cf::Boolean::value_true().as_type_ref(),
            cf::Boolean::value_false(),
            cf::String::from_str("WebTranscriber").as_ref(),
            &cf::Uuid::new().to_cf_string(),
            &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
        ],
    );

    let mic_proc_id = mic_device.create_io_proc_id(mic_io_proc, Some(&mut *mic_ctx))?;
    let _mic_started = ca::device_start(mic_device, Some(mic_proc_id))?;

    let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
    let system_proc_id = agg_device.create_io_proc_id(system_io_proc, Some(&mut *system_ctx))?;
    let _system_started = ca::device_start(agg_device, Some(system_proc_id))?;

    let mut transcriber = DeepgramTranscriber::new(api_key, sample_rate);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    ctrlc::set_handler(move || {
        println!("\nStopping...");
        stop_clone.store(true, Ordering::Relaxed);
    })
    .ok();

    let mut chunk_buffer = Vec::with_capacity(CHUNK_SIZE);

    println!("\n✅ Ready! Listening to microphone and system audio...");
    println!("   Runs indefinitely - Press Ctrl+C to stop\n");

    while !stop.load(Ordering::Relaxed) {
        use ringbuf::traits::Consumer;
        
        while chunk_buffer.len() < CHUNK_SIZE {
            let mic_sample = mic_consumer.try_pop();
            let system_sample = system_consumer.try_pop();
            
            match (mic_sample, system_sample) {
                (Some(m), Some(s)) => {
                    chunk_buffer.push((m + s) * 0.5);
                }
                (Some(m), None) => {
                    chunk_buffer.push(m);
                }
                (None, Some(s)) => {
                    chunk_buffer.push(s);
                }
                (None, None) => break,
            }
        }
        
        if chunk_buffer.len() >= CHUNK_SIZE {
            let _ = transcriber.send_audio(chunk_buffer.clone());
            chunk_buffer.clear();
        }

        while let Some(transcript) = transcriber.try_recv_transcript() {
            let _ = broadcast_tx.send(transcript.clone());
            println!("{}", transcript);
        }

        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    if !chunk_buffer.is_empty() {
        let _ = transcriber.send_audio(chunk_buffer);
    }

    tokio::time::sleep(Duration::from_millis(500)).await;
    
    while let Some(transcript) = transcriber.try_recv_transcript() {
        let _ = broadcast_tx.send(transcript.clone());
        println!("{}", transcript);
    }

    println!("\nStopped. Goodbye!");

    Ok(())
}
