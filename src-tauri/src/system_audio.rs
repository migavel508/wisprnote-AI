/// Native System Audio Capture for Tauri (macOS only)
/// Records BOTH microphone input AND system audio simultaneously
/// Integrated directly into the Tauri desktop app - no separate server needed

#[cfg(target_os = "macos")]
pub mod macos {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use std::io::{BufWriter, Write, Read};
    use std::fs::File;
    use std::path::PathBuf;
    use cidre::{av, cat, cf, ns, os};
    use cidre::core_audio as ca;
    use ringbuf::{HeapRb, traits::Split, traits::Consumer};

    const BUFFER_SIZE: usize = 65536;

    /// Downsamples an interleaved mic/system pair from the capture (tap) rate to a
    /// target rate (16 kHz for Soniox) by box-filter averaging each source window.
    ///
    /// Why: nova-3 runs at 16 kHz internally, so sending the tap's native 48 kHz buys
    /// no accuracy — it just triples the websocket bytes (192 KB/s vs 64 KB/s of stereo
    /// linear16). On a real meeting (already sharing the uplink with Zoom/Meet) that
    /// extra upload is what causes send backpressure → dropped connections → gaps. We
    /// downsample once, here, before it ever hits the socket.
    ///
    /// Both channels share one phase accumulator so they stay sample-aligned, and the
    /// phase carries across chunks so there are no clicks at chunk boundaries. Averaging
    /// (rather than naive drop-sample decimation) gives mild anti-aliasing — adequate for
    /// speech STT and far simpler than a full polyphase resampler. Any ratio works; if the
    /// source is already ≤ target it passes through 1:1.
    struct StereoDownsampler {
        step: f64, // source frames consumed per output frame (src_hz / dst_hz)
        pos: f64,  // fractional progress toward the next output frame
        mic_acc: f32,
        sys_acc: f32,
        count: u32,
    }

    impl StereoDownsampler {
        fn new(src_hz: u32, dst_hz: u32) -> Self {
            let step = (src_hz.max(1) as f64) / (dst_hz.max(1) as f64);
            Self { step: step.max(1.0), pos: 0.0, mic_acc: 0.0, sys_acc: 0.0, count: 0 }
        }

        /// Feed one source frame; emit an averaged frame to `out_*` once a full
        /// output window has been gathered.
        #[inline]
        fn push(&mut self, mic: f32, sys: f32, out_mic: &mut Vec<f32>, out_sys: &mut Vec<f32>) {
            self.mic_acc += mic;
            self.sys_acc += sys;
            self.count += 1;
            self.pos += 1.0;
            if self.pos >= self.step {
                let inv = 1.0 / self.count as f32;
                out_mic.push(self.mic_acc * inv);
                out_sys.push(self.sys_acc * inv);
                self.mic_acc = 0.0;
                self.sys_acc = 0.0;
                self.count = 0;
                self.pos -= self.step;
            }
        }
    }

    /// Streaming sink: recorded samples are appended (as little-endian f32 bytes)
    /// to a scratch .pcm file on disk DURING recording, instead of accumulating in
    /// a growing in-memory Vec. This keeps recording-phase RAM flat regardless of
    /// length (a multi-hour session no longer grows hundreds of MB of RAM). The
    /// audio loop only does cheap byte appends — no DSP — so capture timing is
    /// never affected. All compression/silence-cut still happens at stop().
    struct PcmSink {
        writer: BufWriter<File>,
        path: PathBuf,
        samples_written: u64,
    }

    impl PcmSink {
        fn create() -> std::io::Result<Self> {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|d| d.as_nanos())
                .unwrap_or(0);
            let path = std::env::temp_dir().join(format!("wisprnote_rec_{stamp}.pcm"));
            let file = File::create(&path)?;
            Ok(Self { writer: BufWriter::new(file), path, samples_written: 0 })
        }

        fn write_samples(&mut self, samples: &[f32]) {
            // Write a whole tick's worth at once (called ~every 10ms), not per sample.
            let mut buf = Vec::with_capacity(samples.len() * 4);
            for &s in samples {
                buf.extend_from_slice(&s.to_le_bytes());
            }
            if self.writer.write_all(&buf).is_ok() {
                self.samples_written += samples.len() as u64;
            }
        }
    }

    struct Ctx {
        common_format: av::audio::CommonFormat,
        producer: ringbuf::HeapProd<f32>,
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

    /// Skip our own aggregate / tap device names so we never capture the system-audio tap as "mic".
    const CAPTURE_SKIP_NAME_FRAGMENTS: &[&str] =
        &["WisprnoteAudioCapture", "WisprnoteRealtimeCapture"];

    fn device_name_should_skip_mic(name: &str) -> bool {
        CAPTURE_SKIP_NAME_FRAGMENTS
            .iter()
            .any(|frag| name.contains(frag))
    }

    fn has_input_streams(device: &ca::Device) -> bool {
        let addr =
            ca::PropSelector::DEVICE_STREAMS.addr(ca::PropScope::INPUT, ca::PropElement::MAIN);
        device
            .prop_size(&addr)
            .map(|size| size > 0)
            .unwrap_or(false)
    }

    /// Prefer the user-selected default input (Bluetooth / USB / built-in). If the default is
    /// missing, invalid, or one of our virtual tap aggregates, pick the first real input device
    /// (same idea as anarlog/cpal fallbacks).
    fn resolve_capture_input_device() -> Result<ca::Device, anyhow::Error> {
        if let Ok(default) = ca::System::default_input_device() {
            if !default.is_unknown() && has_input_streams(&default) {
                match default.name() {
                    Ok(name) => {
                        let n = name.to_string();
                        if !device_name_should_skip_mic(&n) {
                            return Ok(default);
                        }
                    }
                    Err(_) => return Ok(default),
                }
            }
        }

        let ca_devices = ca::System::devices()
            .map_err(|e| anyhow::anyhow!("enumerate devices: {:?}", e))?;
        for ca_device in ca_devices {
            if ca_device.is_unknown() || !has_input_streams(&ca_device) {
                continue;
            }
            if let Ok(name) = ca_device.name() {
                if device_name_should_skip_mic(&name.to_string()) {
                    continue;
                }
            }
            return Ok(ca_device);
        }

        ca::System::default_input_device()
            .map_err(|e| anyhow::anyhow!("default input device: {:?}", e))
    }

    /// Global state for the audio recorder
    pub struct SystemAudioRecorder {
        is_recording: Arc<AtomicBool>,
        /// Streaming sink shared with the capture thread. Samples are written here
        /// during recording (flat RAM); at stop() we read the .pcm back, compress,
        /// and encode the WAV.
        sink: Arc<Mutex<Option<PcmSink>>>,
        sample_rate: u32,
    }

    impl SystemAudioRecorder {
        pub fn new() -> Self {
            Self {
                is_recording: Arc::new(AtomicBool::new(false)),
                sink: Arc::new(Mutex::new(None)),
                sample_rate: 48000,
            }
        }

        pub fn is_recording(&self) -> bool {
            self.is_recording.load(Ordering::Relaxed)
        }

        pub fn get_sample_rate(&self) -> u32 {
            self.sample_rate
        }

        /// Start recording mic + system audio
        pub fn start(&mut self) -> Result<(), String> {
            if self.is_recording.load(Ordering::Relaxed) {
                return Err("Already recording".to_string());
            }

            // Open a fresh streaming sink (scratch .pcm on disk).
            let sink = PcmSink::create().map_err(|e| format!("create pcm sink: {e}"))?;
            {
                let mut guard = self.sink.lock().map_err(|e| e.to_string())?;
                *guard = Some(sink);
            }

            let is_recording = self.is_recording.clone();
            let sink = self.sink.clone();

            // Start recording in a separate thread
            std::thread::spawn(move || {
                if let Err(e) = record_audio(is_recording, sink) {
                    eprintln!("Recording error: {}", e);
                }
            });

            self.is_recording.store(true, Ordering::Relaxed);
            Ok(())
        }

        /// Stop recording and return the audio data as WAV bytes
        pub fn stop(&mut self) -> Result<Vec<u8>, String> {
            if !self.is_recording.load(Ordering::Relaxed) {
                return Err("Not recording".to_string());
            }

            self.is_recording.store(false, Ordering::Relaxed);

            // Wait a bit for the recording thread to finish its last writes.
            std::thread::sleep(std::time::Duration::from_millis(100));

            // Take the sink out, flush it, and read the streamed .pcm back.
            let pcm_path = {
                let mut guard = self.sink.lock().map_err(|e| e.to_string())?;
                match guard.take() {
                    Some(mut sink) => {
                        let _ = sink.writer.flush();
                        sink.path
                    }
                    None => return Err("No audio data recorded".to_string()),
                }
            };

            let audio_samples = read_pcm_f32(&pcm_path);
            // The scratch file has served its purpose — delete it now.
            let _ = std::fs::remove_file(&pcm_path);

            if audio_samples.is_empty() {
                return Err("No audio data recorded".to_string());
            }

            // Compress in Rust before encoding: downsample to 16 kHz (the speech-
            // recognition standard) and cut noiseless silence. This shrinks a long
            // recording ~3× from the rate change alone, plus more from silence
            // removal — so the WAV written to disk is small from the start and JS
            // never has to decode a huge file. Mono already (single channel).
            let compressed = compress_samples(&audio_samples, self.sample_rate, 16000);
            let wav_data = create_wav(&compressed, 16000);
            Ok(wav_data)
        }

        /// Get current audio size in bytes (samples streamed so far × 4).
        pub fn get_audio_size(&self) -> usize {
            if let Ok(guard) = self.sink.lock() {
                guard.as_ref().map(|s| s.samples_written as usize * 4).unwrap_or(0)
            } else {
                0
            }
        }
    }

    fn record_audio(
        is_recording: Arc<AtomicBool>,
        sink: Arc<Mutex<Option<PcmSink>>>,
    ) -> Result<(), anyhow::Error> {
        use crate::device_monitor;

        // Spawn device change monitor for this recording session
        let (dev_tx, dev_rx) = std::sync::mpsc::channel();
        let _dev_monitor = device_monitor::spawn_monitor(dev_tx);

        const MAX_ERROR_RETRIES: u32 = 3;
        let mut error_count: u32 = 0;

        // Outer loop: restarts capture when device changes
        while is_recording.load(Ordering::Relaxed) {
            // Drain residual device events before starting a new session
            while dev_rx.try_recv().is_ok() {}

            if let Err(e) = record_audio_session(&is_recording, &sink, &dev_rx) {
                let msg = format!("{}", e);
                if msg == "device_change" && is_recording.load(Ordering::Relaxed) {
                    error_count = 0;
                    std::thread::sleep(std::time::Duration::from_millis(2000));
                    continue;
                } else if is_recording.load(Ordering::Relaxed) {
                    error_count += 1;
                    eprintln!("Recording session error (attempt {}/{}): {}", error_count, MAX_ERROR_RETRIES, e);
                    if error_count >= MAX_ERROR_RETRIES {
                        eprintln!("Recording failed permanently after {} attempts", MAX_ERROR_RETRIES);
                        is_recording.store(false, Ordering::Relaxed);
                        return Err(e);
                    }
                    let backoff = std::time::Duration::from_millis(2000 * (error_count as u64));
                    std::thread::sleep(backoff);
                    continue;
                } else {
                    return Err(e);
                }
            }
            break;
        }

        eprintln!("System audio recording stopped");
        Ok(())
    }

    fn record_audio_session(
        is_recording: &Arc<AtomicBool>,
        sink: &Arc<Mutex<Option<PcmSink>>>,
        dev_rx: &std::sync::mpsc::Receiver<crate::device_monitor::DeviceChange>,
    ) -> Result<(), anyhow::Error> {
        // CoreAudio device id + human name (CPAL matches by name — same as anarlog’s device pick).
        let mic_ca = resolve_capture_input_device()?;
        let mic_ca_name = mic_ca
            .name()
            .map_err(|e| anyhow::anyhow!("mic device name: {:?}", e))?
            .to_string();

        // System audio tap (dictates the mix timeline sample rate).
        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;
        let tap_asbd = tap.asbd().unwrap();
        let out_hz = tap_asbd.sample_rate as u32;
        let tap_format = av::AudioFormat::with_asbd(&tap_asbd).unwrap();
        let tap_common_format = tap_format.common_format();

        // Mic via CPAL (Bluetooth-safe); align to tap rate when hardware allows.
        let mic_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (mic_producer, mut mic_consumer) = mic_rb.split();
        let _mic_cpal = crate::mic_cpal::spawn_cpal_mic(&mic_ca_name, out_hz, mic_producer)?;
        let mic_cpal_hz = _mic_cpal.mic_sample_hz();

        std::thread::sleep(std::time::Duration::from_millis(50));

        let system_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (system_producer, mut system_consumer) = system_rb.split();
        let mut system_ctx = Box::new(Ctx {
            common_format: tap_common_format,
            producer: system_producer,
        });

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
                cf::String::from_str("WisprnoteAudioCapture").as_ref(),
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
        let system_proc_id = agg_device.create_io_proc_id(system_io_proc, Some(&mut *system_ctx))?;
        let _system_started = ca::device_start(agg_device, Some(system_proc_id))?;

        let mut mic_follower = crate::mic_cpal::MicRateFollower::default();

        eprintln!(
            "System audio recording started: cpal mic @ {} Hz, tap @ {} Hz",
            mic_cpal_hz, out_hz
        );

        // Drain events already queued from setup (creating the aggregate device fires
        // HW_DEVICES changes). Don't block ~500ms here — start capturing immediately; the
        // grace window below ignores the self-triggered DefaultInputChanged that follows.
        while dev_rx.try_recv().is_ok() {}
        let session_start = std::time::Instant::now();
        const DEVICE_CHANGE_GRACE_MS: u64 = 700;

        // Record loop — also checks for device changes
        while is_recording.load(Ordering::Relaxed) {
            // Only react to actual input device changes, NOT device-list changes
            // (we trigger DeviceListChanged ourselves when creating/destroying aggregate devices)
            if let Ok(change) = dev_rx.try_recv() {
                match change {
                    crate::device_monitor::DeviceChange::DefaultInputChanged => {
                        // Skip the aggregate device's own setup churn; only a genuine later
                        // change (after the grace window) restarts capture.
                        if session_start.elapsed().as_millis() as u64 >= DEVICE_CHANGE_GRACE_MS {
                            eprintln!("Batch recording: input device changed, restarting capture...");
                            return Err(anyhow::anyhow!("device_change"));
                        }
                    }
                    _ => {}
                }
            }

            let mut samples_to_add = Vec::new();

            // Mix: advance mic on the system (tap) clock so Bluetooth 16 kHz HFP + 48 kHz tap stay aligned.
            loop {
                match system_consumer.try_pop() {
                    Some(s) => {
                        let m = mic_follower.next_mic_for_system_tick(
                            &mut mic_consumer,
                            mic_cpal_hz,
                            out_hz,
                        );
                        samples_to_add.push((m * 0.6) + (s * 0.4));
                    }
                    None => break,
                }
            }

            // Stream this tick's samples straight to the .pcm file (cheap byte
            // append — no DSP, no growing Vec). RAM stays flat for any length.
            if !samples_to_add.is_empty() {
                if let Ok(mut guard) = sink.lock() {
                    if let Some(s) = guard.as_mut() {
                        s.write_samples(&samples_to_add);
                    }
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        Ok(())
    }

    // ─── Realtime Recording with Soniox Integration ──────────────────────────

    // Samples per send (mono). Smaller = lower interim latency (faded text appears + firms up
    // faster). ~1600 samples ≈ 33 ms at 48 kHz.
    const CHUNK_SIZE: usize = 1600;

    use crate::soniox_transcriber::SonioxTranscriber;

    pub struct RealtimeRecorder {
        is_recording: Arc<AtomicBool>,
        // When set mid-recording, the capture session tears down the CoreAudio devices
        // (mic released) but the Soniox WebSocket is kept warm (see record_realtime).
        // Flipping it is instant — no teardown/rebuild of the streaming pipeline.
        paused: Arc<AtomicBool>,
        transcripts: Arc<Mutex<Vec<String>>>,
        join_handle: Option<std::thread::JoinHandle<()>>,
    }

    impl RealtimeRecorder {
        pub fn new() -> Self {
            Self {
                is_recording: Arc::new(AtomicBool::new(false)),
                paused: Arc::new(AtomicBool::new(false)),
                transcripts: Arc::new(Mutex::new(Vec::new())),
                join_handle: None,
            }
        }

        pub fn is_recording(&self) -> bool {
            self.is_recording.load(Ordering::Relaxed)
        }

        /// Pause: release the mic (capture torn down) but keep the socket warm. Instant.
        pub fn pause(&self) -> Result<(), String> {
            if !self.is_recording.load(Ordering::Relaxed) {
                return Err("Not recording".to_string());
            }
            self.paused.store(true, Ordering::Relaxed);
            Ok(())
        }

        /// Resume: rebuild only the capture; the warm socket continues. Instant.
        pub fn resume(&self) -> Result<(), String> {
            if !self.is_recording.load(Ordering::Relaxed) {
                return Err("Not recording".to_string());
            }
            self.paused.store(false, Ordering::Relaxed);
            Ok(())
        }

        pub fn start(
            &mut self,
            api_key: String,
            keyterms: Option<Vec<String>>,
            language: Option<String>,
            app_handle: tauri::AppHandle,
        ) -> Result<(), String> {
            if self.is_recording.load(Ordering::Relaxed) {
                return Err("Already recording in realtime mode".to_string());
            }

            if let Ok(mut t) = self.transcripts.lock() {
                t.clear();
            }

            self.is_recording.store(true, Ordering::Relaxed);
            self.paused.store(false, Ordering::Relaxed);

            let is_recording = self.is_recording.clone();
            let paused = self.paused.clone();
            let transcripts = self.transcripts.clone();

            let handle = std::thread::spawn(move || {
                if let Err(e) = record_realtime(is_recording.clone(), paused, transcripts, api_key, keyterms, language, app_handle) {
                    eprintln!("Realtime recording error: {}", e);
                    is_recording.store(false, Ordering::Relaxed);
                }
            });

            self.join_handle = Some(handle);
            Ok(())
        }

        pub fn stop(&mut self) -> Result<String, String> {
            if !self.is_recording.load(Ordering::Relaxed) {
                return Err("Not recording".to_string());
            }

            self.is_recording.store(false, Ordering::Relaxed);
            self.paused.store(false, Ordering::Relaxed);

            if let Some(handle) = self.join_handle.take() {
                let _ = handle.join();
            }

            let transcripts = self.transcripts.lock().map_err(|e| e.to_string())?;
            // "[FINAL|Label] text" → "Label: text" so the saved transcript keeps speaker
            // attribution (You / Speaker N) for the notes + knowledge-graph pipeline.
            let clean: Vec<String> = transcripts
                .iter()
                .filter_map(|t| {
                    let close = t.find("] ")?;
                    let text = t[close + 2..].trim();
                    if text.is_empty() {
                        return None;
                    }
                    let label = t.find('|').map(|p| &t[p + 1..close]).unwrap_or("");
                    Some(if label.is_empty() { text.to_string() } else { format!("{}: {}", label, text) })
                })
                .collect();
            Ok(clean.join("\n"))
        }
    }

    /// Drain every transcript currently queued from Soniox: emit each to the
    /// frontend and accumulate FINALs into the shared list (dedup consecutive dupes).
    /// Returns true if at least one message was received (used to pace the stop drain).
    fn drain_transcripts(
        transcriber: &mut SonioxTranscriber,
        transcripts: &Arc<Mutex<Vec<String>>>,
        app_handle: &tauri::AppHandle,
    ) -> bool {
        use tauri::Emitter;
        let mut received = false;
        while let Some(transcript) = transcriber.try_recv_transcript() {
            received = true;
            let _ = app_handle.emit("realtime-transcript", &transcript);
            if transcript.contains("[FINAL") {
                if let Ok(mut t) = transcripts.lock() {
                    let should_push = t.last().map(|prev| prev != &transcript).unwrap_or(true);
                    if should_push {
                        t.push(transcript);
                    }
                }
            }
        }
        received
    }

    fn record_realtime(
        is_recording: Arc<AtomicBool>,
        paused: Arc<AtomicBool>,
        transcripts: Arc<Mutex<Vec<String>>>,
        api_key: String,
        keyterms: Option<Vec<String>>,
        language: Option<String>,
        app_handle: tauri::AppHandle,
    ) -> Result<(), anyhow::Error> {
        use crate::device_monitor;
        use tauri::Emitter;

        // Spawn device change monitor for this recording session
        let (dev_tx, dev_rx) = std::sync::mpsc::channel();
        let _dev_monitor = device_monitor::spawn_monitor(dev_tx);

        // The Soniox WebSocket lives for the WHOLE recording — created once here and
        // kept warm across pauses. Its task runs on this runtime, so `_rt` (and the enter
        // guard) MUST outlive the recording. Pause tears down only the CoreAudio capture
        // (mic released); the socket stays open via its 5s KeepAlive, so resume just
        // rebuilds capture — no new token, no handshake, no drain.
        const TARGET_HZ: u32 = 16_000;
        let _rt = tokio::runtime::Runtime::new()
            .map_err(|e| anyhow::anyhow!("Failed to create tokio runtime: {}", e))?;
        let _rt_guard = _rt.enter();
        let mut transcriber =
            SonioxTranscriber::new(api_key.clone(), TARGET_HZ, keyterms.clone(), language.clone());

        const MAX_ERROR_RETRIES: u32 = 3;
        let mut error_count: u32 = 0;

        // Outer loop: drives capture sessions, idles while paused, restarts on device change.
        while is_recording.load(Ordering::Relaxed) {
            // While paused the mic is released (no capture session). Keep the socket warm
            // and forward any trailing finals (the last words spoken before the pause).
            if paused.load(Ordering::Relaxed) {
                drain_transcripts(&mut transcriber, &transcripts, &app_handle);
                std::thread::sleep(std::time::Duration::from_millis(20));
                continue;
            }

            // Drain any residual device events before starting a new session
            while dev_rx.try_recv().is_ok() {}

            match record_realtime_session(
                &is_recording,
                &paused,
                &transcripts,
                &mut transcriber,
                &app_handle,
                &dev_rx,
            ) {
                // A session ends when we pause or stop — loop back and let the pause
                // branch / while-condition decide which it was.
                Ok(()) => continue,
                Err(e) => {
                    let msg = format!("{}", e);
                    if msg.contains("device_change") && is_recording.load(Ordering::Relaxed) {
                        eprintln!("Realtime recording: device changed, restarting capture...");
                        let _ = app_handle.emit("audio-device-restart", "restarting");
                        error_count = 0;
                        std::thread::sleep(std::time::Duration::from_millis(2000));
                        continue;
                    } else if is_recording.load(Ordering::Relaxed) {
                        error_count += 1;
                        eprintln!("Realtime recording error (attempt {}/{}): {}", error_count, MAX_ERROR_RETRIES, e);
                        if error_count >= MAX_ERROR_RETRIES {
                            let _ = app_handle.emit("recording-error", format!("Recording failed after {} attempts: {}", MAX_ERROR_RETRIES, e));
                            is_recording.store(false, Ordering::Relaxed);
                            break;
                        }
                        let backoff = std::time::Duration::from_millis(2000 * (error_count as u64));
                        std::thread::sleep(backoff);
                        continue;
                    } else {
                        break;
                    }
                }
            }
        }

        // Final stop: close the input so Soniox flushes its trailing FINALs, then drain
        // them ADAPTIVELY — exit as soon as ~400ms passes with nothing new, capped at 1.5s.
        // (Replaces the old fixed 3.5s wait that ran in full on every stop AND every pause.)
        transcriber.close_input();
        let drain_cap = std::time::Instant::now() + std::time::Duration::from_millis(1500);
        let mut last_recv = std::time::Instant::now();
        loop {
            if drain_transcripts(&mut transcriber, &transcripts, &app_handle) {
                last_recv = std::time::Instant::now();
            }
            let now = std::time::Instant::now();
            if now >= drain_cap || now.duration_since(last_recv) >= std::time::Duration::from_millis(400) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        eprintln!("Realtime recording stopped");
        Ok(())
    }

    fn record_realtime_session(
        is_recording: &Arc<AtomicBool>,
        paused: &Arc<AtomicBool>,
        transcripts: &Arc<Mutex<Vec<String>>>,
        transcriber: &mut SonioxTranscriber,
        app_handle: &tauri::AppHandle,
        dev_rx: &std::sync::mpsc::Receiver<crate::device_monitor::DeviceChange>,
    ) -> Result<(), anyhow::Error> {

        // CoreAudio name → CPAL mic (Bluetooth / HFP safe).
        let mic_ca = resolve_capture_input_device()?;
        let mic_ca_name = mic_ca
            .name()
            .map_err(|e| anyhow::anyhow!("mic device name: {:?}", e))?
            .to_string();

        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;
        let tap_asbd = tap.asbd().unwrap();
        let sample_rate = tap_asbd.sample_rate as u32;
        let tap_format = av::AudioFormat::with_asbd(&tap_asbd).unwrap();
        let tap_common_format = tap_format.common_format();

        let mic_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (mic_producer, mut mic_consumer) = mic_rb.split();
        let _mic_cpal = crate::mic_cpal::spawn_cpal_mic(&mic_ca_name, sample_rate, mic_producer)?;
        let mic_cpal_hz = _mic_cpal.mic_sample_hz();

        std::thread::sleep(std::time::Duration::from_millis(50));

        let system_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (system_producer, mut system_consumer) = system_rb.split();
        let mut system_ctx = Box::new(Ctx {
            common_format: tap_common_format,
            producer: system_producer,
        });

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
                cf::String::from_str("WisprnoteRealtimeCapture").as_ref(),
                &cf::Uuid::new().to_cf_string(),
                &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
            ],
        );

        let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
        let system_proc_id = agg_device.create_io_proc_id(system_io_proc, Some(&mut *system_ctx))?;
        let _system_started = ca::device_start(agg_device, Some(system_proc_id))?;

        let mut mic_follower = crate::mic_cpal::MicRateFollower::default();

        eprintln!(
            "Realtime: cpal mic {} Hz, tap {} Hz {:?}",
            mic_cpal_hz, sample_rate, tap_common_format
        );

        // Drain events already queued from setup (creating the aggregate device fires
        // HW_DEVICES notifications). Don't block ~500ms here — anarlog streams immediately.
        // Any self-triggered DefaultInputChanged that lands a beat later is ignored by the
        // grace window in the loop below, so transcription starts ~0.5s sooner.
        while dev_rx.try_recv().is_ok() {}
        let session_start = std::time::Instant::now();
        const DEVICE_CHANGE_GRACE_MS: u64 = 700;

        // Stream to Soniox at 16 kHz, not the tap's native rate (~48 kHz). nova-3 is a
        // 16 kHz model, so this is no accuracy loss but ~1/3 the upload bytes — the single
        // biggest lever against latency/stutter/drop-outs in long meetings on a shared uplink.
        const TARGET_HZ: u32 = 16_000;
        let mut downsampler = StereoDownsampler::new(sample_rate, TARGET_HZ);
        let mut device_changed = false;
        // Per-chunk source buffers (mic + system, at tap rate) and the resampled,
        // interleaved 16 kHz output staged before send.
        let mut mic_buf: Vec<f32> = Vec::with_capacity(CHUNK_SIZE);
        let mut sys_buf: Vec<f32> = Vec::with_capacity(CHUNK_SIZE);
        let mut out_mic: Vec<f32> = Vec::with_capacity(CHUNK_SIZE);
        let mut out_sys: Vec<f32> = Vec::with_capacity(CHUNK_SIZE);
        // Half-duplex gate state: how many more chunks to keep the mic muted after the
        // system last went active (hangover catches the echo/reverb tail + avoids chatter).
        let mut mic_mute_hangover: i32 = 0;
        const SYS_VAD_FLOOR: f32 = 0.01;   // system RMS above this ⇒ a participant is talking
        const HANGOVER_CHUNKS: i32 = 8;    // ~250 ms at ~33 ms/chunk

        // Throttle for the floating recording-indicator waveform: push the live mic
        // level to the overlay window at ~25 fps. Computed in the capture pipeline so
        // the waveform is reactive regardless of the overlay's own mic access.
        let mut last_level_emit = std::time::Instant::now();

        // Capture runs until we STOP or PAUSE. On pause this loop exits → the CoreAudio
        // devices (this fn's locals) drop → the mic is released — while the WebSocket
        // (owned by the caller) stays warm. The trailing-final close + drain on a true
        // stop happens in record_realtime, not here, so the socket survives pauses.
        while is_recording.load(Ordering::Relaxed) && !paused.load(Ordering::Relaxed) {
            // Only react to actual input device changes (e.g. Bluetooth headset connected).
            // Ignore DeviceListChanged — we trigger those ourselves when creating aggregate devices.
            if let Ok(change) = dev_rx.try_recv() {
                match change {
                    crate::device_monitor::DeviceChange::DefaultInputChanged => {
                        // Ignore the aggregate device's own setup churn (fires within a few
                        // hundred ms of device_start); only a genuine later change restarts.
                        if session_start.elapsed().as_millis() as u64 >= DEVICE_CHANGE_GRACE_MS {
                            eprintln!("Realtime: input device changed, signaling restart...");
                            device_changed = true;
                            break;
                        }
                    }
                    _ => {}
                }
            }

            // Collect one chunk of mic + system frames (tap is the master clock).
            while mic_buf.len() < CHUNK_SIZE {
                match system_consumer.try_pop() {
                    Some(s) => {
                        let m = mic_follower.next_mic_for_system_tick(
                            &mut mic_consumer,
                            mic_cpal_hz,
                            sample_rate,
                        );
                        mic_buf.push(m);
                        sys_buf.push(s);
                    }
                    None => break,
                }
            }

            // HALF-DUPLEX SOURCE GATING. The mic also picks up the participant's voice from
            // the speakers (acoustic echo). Decide purely from the CLEAN system signal: if a
            // participant is talking (system RMS above floor), mute the mic for this chunk so
            // that voice stays only on ch1 (Participant) and never duplicates onto ch0 (You).
            // A hangover keeps the mic muted briefly after the system goes quiet (reverb tail).
            // Trade-off: true simultaneous speech favours the participant side. No echo canceller.
            if mic_buf.len() >= CHUNK_SIZE {
                let sys_sq: f32 = sys_buf.iter().map(|s| s * s).sum();
                let sys_rms = (sys_sq / sys_buf.len() as f32).sqrt();
                if sys_rms > SYS_VAD_FLOOR {
                    mic_mute_hangover = HANGOVER_CHUNKS;
                } else if mic_mute_hangover > 0 {
                    mic_mute_hangover -= 1;
                }
                let mic_gain = if mic_mute_hangover > 0 { 0.0 } else { 1.0 };

                // Downsample (tap rate → 16 kHz) and interleave in one pass. The mic
                // gate is applied pre-resample so the gated participant echo never
                // reaches ch0 (You). A partial output window is carried in the
                // downsampler across chunks, so nothing is lost at boundaries.
                out_mic.clear();
                out_sys.clear();
                for i in 0..mic_buf.len() {
                    downsampler.push(mic_buf[i] * mic_gain, sys_buf[i], &mut out_mic, &mut out_sys);
                }
                if !out_mic.is_empty() {
                    // Live waveform level for the floating indicator — peak across both
                    // channels (you OR a participant), so the bars track whoever is
                    // speaking. Throttled to ~25 fps.
                    if last_level_emit.elapsed().as_millis() >= 40 {
                        use tauri::Emitter;
                        // Use the RAW (pre-gate) mic + system so the user's OWN voice
                        // always drives the waveform. out_mic is half-duplex gated (muted
                        // when a participant speaks) — that's for transcription, not the
                        // visual meter. The mic is usually quieter, so give it more gain.
                        let mut peak_mic = 0.0f32;
                        for &s in mic_buf.iter() { let a = s.abs(); if a > peak_mic { peak_mic = a; } }
                        let mut peak_sys = 0.0f32;
                        for &s in sys_buf.iter() { let a = s.abs(); if a > peak_sys { peak_sys = a; } }
                        let level = (peak_mic * 3.5).max(peak_sys * 2.2).min(1.0);
                        let _ = app_handle.emit("audio-level", level);
                        last_level_emit = std::time::Instant::now();
                    }

                    let mut frame = Vec::with_capacity(out_mic.len() * 2);
                    for i in 0..out_mic.len() {
                        frame.push(out_mic[i]); // ch0 — you (gated)
                        frame.push(out_sys[i]); // ch1 — participants
                    }
                    let _ = transcriber.send_audio(frame);
                }
                mic_buf.clear();
                sys_buf.clear();
            }

            // Poll for transcripts → emit + accumulate finals.
            drain_transcripts(transcriber, transcripts, app_handle);

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        // Flush any partial chunk (interleaved, mic gated by the last hangover state) so the
        // last words before a pause/stop reach Soniox. We do NOT close the input here — the
        // socket stays warm across pauses; only a true stop (record_realtime) closes + drains.
        if !mic_buf.is_empty() {
            let mic_gain = if mic_mute_hangover > 0 { 0.0 } else { 1.0 };
            out_mic.clear();
            out_sys.clear();
            for i in 0..mic_buf.len() {
                let s = *sys_buf.get(i).unwrap_or(&0.0);
                downsampler.push(mic_buf[i] * mic_gain, s, &mut out_mic, &mut out_sys);
            }
            if !out_mic.is_empty() {
                let mut frame = Vec::with_capacity(out_mic.len() * 2);
                for i in 0..out_mic.len() {
                    frame.push(out_mic[i]);
                    frame.push(out_sys[i]);
                }
                let _ = transcriber.send_audio(frame);
            }
        }

        if device_changed {
            return Err(anyhow::anyhow!("device_change"));
        }

        Ok(())
    }

    /// Read a streamed .pcm scratch file (raw little-endian f32) back into a
    /// sample Vec. Reads in chunks so peak memory at stop() is the decoded
    /// samples, not double-buffered.
    fn read_pcm_f32(path: &PathBuf) -> Vec<f32> {
        let mut file = match File::open(path) {
            Ok(f) => f,
            Err(_) => return Vec::new(),
        };
        let len = file.metadata().map(|m| m.len() as usize).unwrap_or(0);
        let mut out = Vec::with_capacity(len / 4);
        let mut buf = [0u8; 8192];
        let mut carry: Vec<u8> = Vec::new();
        loop {
            let n = match file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => n,
                Err(_) => break,
            };
            carry.extend_from_slice(&buf[..n]);
            let whole = carry.len() / 4 * 4;
            let mut i = 0;
            while i < whole {
                let bytes = [carry[i], carry[i + 1], carry[i + 2], carry[i + 3]];
                out.push(f32::from_le_bytes(bytes));
                i += 4;
            }
            carry.drain(0..whole);
        }
        out
    }

    /// Downsample mono samples to `out_rate`, apply a light noise gate, and cut
    /// noiseless silence longer than ~600 ms. O(n), no allocations beyond the
    /// output. Mirrors the JS-side pipeline so transcription quality is identical.
    fn compress_samples(samples: &[f32], in_rate: u32, out_rate: u32) -> Vec<f32> {
        if samples.is_empty() || in_rate == 0 {
            return Vec::new();
        }

        // 1) Downsample via linear interpolation (only if needed).
        let ratio = in_rate as f64 / out_rate as f64;
        let down: Vec<f32> = if (ratio - 1.0).abs() < f64::EPSILON {
            samples.to_vec()
        } else {
            let out_len = (samples.len() as f64 / ratio).ceil() as usize;
            let mut out = Vec::with_capacity(out_len);
            for j in 0..out_len {
                let src = j as f64 * ratio;
                let lo = src.floor() as usize;
                let hi = (lo + 1).min(samples.len() - 1);
                let t = (src - lo as f64) as f32;
                out.push(samples[lo] * (1.0 - t) + samples[hi] * t);
            }
            out
        };

        // 2) Frame energies (20 ms frames) for silence detection.
        let frame_len = ((out_rate as usize) / 50).max(1); // 20 ms
        let num_frames = (down.len() + frame_len - 1) / frame_len;
        if num_frames <= 1 {
            return down;
        }
        let mut energies = vec![0f32; num_frames];
        for f in 0..num_frames {
            let start = f * frame_len;
            let end = (start + frame_len).min(down.len());
            let mut sum = 0f32;
            for &s in &down[start..end] {
                sum += s * s;
            }
            energies[f] = (sum / (end - start).max(1) as f32).sqrt();
        }

        // 3) Adaptive threshold from the 10th-percentile noise floor.
        let mut sorted = energies.clone();
        sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let pct = |p: f32| sorted[((p * sorted.len() as f32) as usize).min(sorted.len() - 1)];
        let noise_floor = pct(0.1);
        let speech_level = pct(0.95);
        let threshold = (noise_floor * 2.5).max(0.005);
        // Not enough dynamic range to separate speech from silence — leave as-is.
        if speech_level < threshold * 1.5 {
            return down;
        }

        // 4) Voiced mask; bridge gaps < 600 ms; pad voiced regions by 150 ms.
        let mut voiced: Vec<bool> = energies.iter().map(|&e| e >= threshold).collect();
        let min_silence_frames = (600 / 20).max(1); // 600 ms
        let mut f = 0usize;
        while f < num_frames {
            if !voiced[f] {
                let mut g = f;
                while g < num_frames && !voiced[g] {
                    g += 1;
                }
                if g - f < min_silence_frames {
                    for v in voiced.iter_mut().take(g).skip(f) {
                        *v = true;
                    }
                }
                f = g;
            } else {
                f += 1;
            }
        }
        let pad = (150 / 20).max(0); // 150 ms
        if pad > 0 {
            let base = voiced.clone();
            for i in 0..num_frames {
                if base[i] {
                    let from = i.saturating_sub(pad);
                    let to = (i + pad).min(num_frames - 1);
                    for v in voiced.iter_mut().take(to + 1).skip(from) {
                        *v = true;
                    }
                }
            }
        }

        // 5) Concatenate kept frames (with a light noise gate on quiet samples).
        let kept: usize = voiced.iter().filter(|&&v| v).count();
        if kept == 0 {
            return down;
        }
        let mut out = Vec::with_capacity(kept * frame_len);
        for f in 0..num_frames {
            if !voiced[f] {
                continue;
            }
            let start = f * frame_len;
            let end = (start + frame_len).min(down.len());
            out.extend_from_slice(&down[start..end]);
        }
        out
    }

    /// Create a WAV file from f32 samples
    fn create_wav(samples: &[f32], sample_rate: u32) -> Vec<u8> {
        let channels: u16 = 1;
        let bits_per_sample: u16 = 16;
        let byte_rate = sample_rate * channels as u32 * bits_per_sample as u32 / 8;
        let block_align = channels * bits_per_sample / 8;

        // Convert f32 to i16
        let i16_samples: Vec<i16> = samples
            .iter()
            .map(|&s| (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16)
            .collect();

        let data_size = (i16_samples.len() * 2) as u32;
        let file_size = 36 + data_size;

        let mut wav = Vec::with_capacity(44 + data_size as usize);

        // RIFF header
        wav.extend_from_slice(b"RIFF");
        wav.extend_from_slice(&file_size.to_le_bytes());
        wav.extend_from_slice(b"WAVE");

        // fmt chunk
        wav.extend_from_slice(b"fmt ");
        wav.extend_from_slice(&16u32.to_le_bytes()); // chunk size
        wav.extend_from_slice(&1u16.to_le_bytes()); // audio format (PCM)
        wav.extend_from_slice(&channels.to_le_bytes());
        wav.extend_from_slice(&sample_rate.to_le_bytes());
        wav.extend_from_slice(&byte_rate.to_le_bytes());
        wav.extend_from_slice(&block_align.to_le_bytes());
        wav.extend_from_slice(&bits_per_sample.to_le_bytes());

        // data chunk
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&data_size.to_le_bytes());

        for sample in i16_samples {
            wav.extend_from_slice(&sample.to_le_bytes());
        }

        wav
    }
}

// Stub for non-macOS platforms
#[cfg(not(target_os = "macos"))]
pub mod stub {
    pub struct SystemAudioRecorder;

    impl SystemAudioRecorder {
        pub fn new() -> Self {
            Self
        }

        pub fn is_recording(&self) -> bool {
            false
        }

        pub fn get_sample_rate(&self) -> u32 {
            48000
        }

        pub fn start(&mut self) -> Result<(), String> {
            Err("System audio recording is only supported on macOS".to_string())
        }

        pub fn stop(&mut self) -> Result<Vec<u8>, String> {
            Err("System audio recording is only supported on macOS".to_string())
        }

        pub fn get_audio_size(&self) -> usize {
            0
        }
    }

    pub struct RealtimeRecorder;

    impl RealtimeRecorder {
        pub fn new() -> Self {
            Self
        }

        pub fn is_recording(&self) -> bool {
            false
        }

        pub fn start(
            &mut self,
            _api_key: String,
            _keyterms: Option<Vec<String>>,
            _app_handle: tauri::AppHandle,
        ) -> Result<(), String> {
            Err("Realtime recording is only supported on macOS".to_string())
        }

        pub fn stop(&mut self) -> Result<String, String> {
            Err("Realtime recording is only supported on macOS".to_string())
        }
    }
}

#[cfg(target_os = "macos")]
pub use macos::SystemAudioRecorder;
#[cfg(target_os = "macos")]
pub use macos::RealtimeRecorder;

#[cfg(not(target_os = "macos"))]
pub use stub::SystemAudioRecorder;
#[cfg(not(target_os = "macos"))]
pub use stub::RealtimeRecorder;
