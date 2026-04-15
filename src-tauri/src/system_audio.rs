/// Native System Audio Capture for Tauri (macOS only)
/// Records BOTH microphone input AND system audio simultaneously
/// Integrated directly into the Tauri desktop app - no separate server needed

#[cfg(target_os = "macos")]
pub mod macos {
    use std::sync::atomic::{AtomicBool, Ordering};
    use std::sync::{Arc, Mutex};
    use cidre::{av, cat, cf, ns, os};
    use cidre::core_audio as ca;
    use ringbuf::{HeapRb, traits::Split};

    const BUFFER_SIZE: usize = 65536;

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

    /// Global state for the audio recorder
    pub struct SystemAudioRecorder {
        is_recording: Arc<AtomicBool>,
        audio_data: Arc<Mutex<Vec<f32>>>,
        sample_rate: u32,
    }

    impl SystemAudioRecorder {
        pub fn new() -> Self {
            Self {
                is_recording: Arc::new(AtomicBool::new(false)),
                audio_data: Arc::new(Mutex::new(Vec::new())),
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

            // Clear previous audio data
            if let Ok(mut data) = self.audio_data.lock() {
                data.clear();
            }

            let is_recording = self.is_recording.clone();
            let audio_data = self.audio_data.clone();

            // Start recording in a separate thread
            std::thread::spawn(move || {
                if let Err(e) = record_audio(is_recording, audio_data) {
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

            // Wait a bit for the recording thread to finish
            std::thread::sleep(std::time::Duration::from_millis(100));

            // Get the audio data and convert to WAV
            let audio_samples = {
                let data = self.audio_data.lock().map_err(|e| e.to_string())?;
                data.clone()
            };

            if audio_samples.is_empty() {
                return Err("No audio data recorded".to_string());
            }

            let wav_data = create_wav(&audio_samples, self.sample_rate);
            Ok(wav_data)
        }

        /// Get current audio size in bytes
        pub fn get_audio_size(&self) -> usize {
            if let Ok(data) = self.audio_data.lock() {
                data.len() * 4 // f32 = 4 bytes
            } else {
                0
            }
        }
    }

    fn record_audio(
        is_recording: Arc<AtomicBool>,
        audio_data: Arc<Mutex<Vec<f32>>>,
    ) -> Result<(), anyhow::Error> {
        // Setup microphone
        let mic_device = ca::System::default_input_device()?;
        let mic_asbd = mic_device.input_asbd()?;
        let mic_format = av::AudioFormat::with_asbd(&mic_asbd).unwrap();
        let mic_common_format = mic_format.common_format();

        // Setup system audio tap
        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;
        let tap_asbd = tap.asbd().unwrap();
        let tap_format = av::AudioFormat::with_asbd(&tap_asbd).unwrap();
        let tap_common_format = tap_format.common_format();

        // Create ring buffers
        let mic_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (mic_producer, mut mic_consumer) = mic_rb.split();
        let mut mic_ctx = Box::new(Ctx { common_format: mic_common_format, producer: mic_producer });

        let system_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (system_producer, mut system_consumer) = system_rb.split();
        let mut system_ctx = Box::new(Ctx { common_format: tap_common_format, producer: system_producer });

        // Create aggregate device for system audio
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

        // Start devices
        let mic_proc_id = mic_device.create_io_proc_id(mic_io_proc, Some(&mut *mic_ctx))?;
        let _mic_started = ca::device_start(mic_device, Some(mic_proc_id))?;

        let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
        let system_proc_id = agg_device.create_io_proc_id(system_io_proc, Some(&mut *system_ctx))?;
        let _system_started = ca::device_start(agg_device, Some(system_proc_id))?;

        eprintln!("System audio recording started");

        // Record loop
        while is_recording.load(Ordering::Relaxed) {
            use ringbuf::traits::Consumer;

            let mut samples_to_add = Vec::new();

            // Mix mic and system audio
            loop {
                let mic_sample = mic_consumer.try_pop();
                let system_sample = system_consumer.try_pop();

                match (mic_sample, system_sample) {
                    (Some(m), Some(s)) => {
                        // Mix: 60% mic + 40% system
                        samples_to_add.push((m * 0.6) + (s * 0.4));
                    }
                    (Some(m), None) => {
                        samples_to_add.push(m);
                    }
                    (None, Some(s)) => {
                        samples_to_add.push(s);
                    }
                    (None, None) => break,
                }
            }

            // Add to audio data
            if !samples_to_add.is_empty() {
                if let Ok(mut data) = audio_data.lock() {
                    data.extend(samples_to_add);
                }
            }

            std::thread::sleep(std::time::Duration::from_millis(10));
        }

        eprintln!("System audio recording stopped");
        Ok(())
    }

    // ─── Realtime Recording with Deepgram Integration ──────────────────────────

    const CHUNK_SIZE: usize = 4800;

    use crate::deepgram_transcriber::DeepgramTranscriber;

    pub struct RealtimeRecorder {
        is_recording: Arc<AtomicBool>,
        transcripts: Arc<Mutex<Vec<String>>>,
        join_handle: Option<std::thread::JoinHandle<()>>,
    }

    impl RealtimeRecorder {
        pub fn new() -> Self {
            Self {
                is_recording: Arc::new(AtomicBool::new(false)),
                transcripts: Arc::new(Mutex::new(Vec::new())),
                join_handle: None,
            }
        }

        pub fn is_recording(&self) -> bool {
            self.is_recording.load(Ordering::Relaxed)
        }

        pub fn start(&mut self, api_key: String, app_handle: tauri::AppHandle) -> Result<(), String> {
            if self.is_recording.load(Ordering::Relaxed) {
                return Err("Already recording in realtime mode".to_string());
            }

            if let Ok(mut t) = self.transcripts.lock() {
                t.clear();
            }

            self.is_recording.store(true, Ordering::Relaxed);

            let is_recording = self.is_recording.clone();
            let transcripts = self.transcripts.clone();

            let handle = std::thread::spawn(move || {
                if let Err(e) = record_realtime(is_recording.clone(), transcripts, api_key, app_handle) {
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

            if let Some(handle) = self.join_handle.take() {
                let _ = handle.join();
            }

            let transcripts = self.transcripts.lock().map_err(|e| e.to_string())?;
            let clean: Vec<String> = transcripts
                .iter()
                .filter_map(|t| {
                    if let Some(pos) = t.find("] ") {
                        Some(t[pos + 2..].to_string())
                    } else {
                        None
                    }
                })
                .collect();
            Ok(clean.join(" "))
        }
    }

    fn record_realtime(
        is_recording: Arc<AtomicBool>,
        transcripts: Arc<Mutex<Vec<String>>>,
        api_key: String,
        app_handle: tauri::AppHandle,
    ) -> Result<(), anyhow::Error> {
        use tauri::Emitter;

        // Setup microphone
        let mic_device = ca::System::default_input_device()?;
        let mic_asbd = mic_device.input_asbd()?;
        let mic_format = av::AudioFormat::with_asbd(&mic_asbd).unwrap();
        let mic_common_format = mic_format.common_format();

        // Setup system audio tap
        let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
        let tap = tap_desc.create_process_tap()?;
        let tap_asbd = tap.asbd().unwrap();
        let sample_rate = tap_asbd.sample_rate as u32;
        let tap_format = av::AudioFormat::with_asbd(&tap_asbd).unwrap();
        let tap_common_format = tap_format.common_format();

        eprintln!("Realtime: Mic {} Hz {:?}, System {} Hz {:?}",
            mic_asbd.sample_rate as u32, mic_common_format,
            sample_rate, tap_common_format);

        // Create ring buffers
        let mic_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (mic_producer, mut mic_consumer) = mic_rb.split();
        let mut mic_ctx = Box::new(Ctx { common_format: mic_common_format, producer: mic_producer });

        let system_rb = HeapRb::<f32>::new(BUFFER_SIZE);
        let (system_producer, mut system_consumer) = system_rb.split();
        let mut system_ctx = Box::new(Ctx { common_format: tap_common_format, producer: system_producer });

        // Create aggregate device for system audio
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

        // Start devices
        let mic_proc_id = mic_device.create_io_proc_id(mic_io_proc, Some(&mut *mic_ctx))?;
        let _mic_started = ca::device_start(mic_device, Some(mic_proc_id))?;

        let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
        let system_proc_id = agg_device.create_io_proc_id(system_io_proc, Some(&mut *system_ctx))?;
        let _system_started = ca::device_start(agg_device, Some(system_proc_id))?;

        eprintln!("Realtime recording started - streaming to Deepgram");

        // Create a dedicated tokio runtime for Deepgram WebSocket communication
        let rt = tokio::runtime::Runtime::new()
            .map_err(|e| anyhow::anyhow!("Failed to create tokio runtime: {}", e))?;

        rt.block_on(async {
            let mut transcriber = DeepgramTranscriber::new(api_key, sample_rate);
            let mut chunk_buffer = Vec::with_capacity(CHUNK_SIZE);

            while is_recording.load(Ordering::Relaxed) {
                use ringbuf::traits::Consumer;

                // Read and mix mic + system audio
                while chunk_buffer.len() < CHUNK_SIZE {
                    let mic_sample = mic_consumer.try_pop();
                    let system_sample = system_consumer.try_pop();

                    match (mic_sample, system_sample) {
                        (Some(m), Some(s)) => chunk_buffer.push((m + s) * 0.5),
                        (Some(m), None) => chunk_buffer.push(m),
                        (None, Some(s)) => chunk_buffer.push(s),
                        (None, None) => break,
                    }
                }

                // Send audio chunk to Deepgram
                if chunk_buffer.len() >= CHUNK_SIZE {
                    let _ = transcriber.send_audio(chunk_buffer.clone());
                    chunk_buffer.clear();
                }

                // Poll for transcripts and emit to frontend
                while let Some(transcript) = transcriber.try_recv_transcript() {
                    let _ = app_handle.emit("realtime-transcript", &transcript);

                    // Accumulate FINAL transcripts
                    if transcript.contains("[FINAL") {
                        if let Ok(mut t) = transcripts.lock() {
                            t.push(transcript.clone());
                        }
                    }
                }

                tokio::time::sleep(std::time::Duration::from_millis(10)).await;
            }

            // Send remaining audio
            if !chunk_buffer.is_empty() {
                let _ = transcriber.send_audio(chunk_buffer);
            }

            // Drain remaining transcripts
            tokio::time::sleep(std::time::Duration::from_millis(500)).await;
            while let Some(transcript) = transcriber.try_recv_transcript() {
                let _ = app_handle.emit("realtime-transcript", &transcript);
                if transcript.contains("[FINAL") {
                    if let Ok(mut t) = transcripts.lock() {
                        t.push(transcript);
                    }
                }
            }
        });

        eprintln!("Realtime recording stopped");
        Ok(())
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

        pub fn start(&mut self, _api_key: String, _app_handle: tauri::AppHandle) -> Result<(), String> {
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
