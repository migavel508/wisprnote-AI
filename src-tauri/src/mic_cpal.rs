//! Microphone capture via CPAL (Core Audio), matching anarlog’s `hypr-audio-actual` mic path.
//! Bluetooth / headset microphones often deliver silence with raw HAL `DeviceIOProc` + a single
//! `AudioBuf`; CPAL’s input stream matches what anarlog uses and reliably captures HFP voice.

use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use cpal::{BuildStreamError, SampleFormat, SizedSample, StreamConfig};
use ringbuf::HeapProd;

const WISPRNOTE_TAP_FRAGMENTS: &[&str] = &["WisprnoteAudioCapture", "WisprnoteRealtimeCapture"];

fn is_wisprnote_tap_name(name: &str) -> bool {
    WISPRNOTE_TAP_FRAGMENTS.iter().any(|f| name.contains(f))
}

fn norm_name(s: &str) -> String {
    s.trim().to_lowercase()
}

fn cpal_device_label(device: &cpal::Device) -> Result<String, anyhow::Error> {
    device
        .description()
        .map_err(|e| anyhow::anyhow!("cpal device description: {e}"))
        .map(|d| d.name().to_string())
}

/// Resolve CPAL input device: match CoreAudio’s device name when possible, else non-tap default.
pub fn pick_cpal_input_device(coreaudio_name: &str) -> Result<(cpal::Device, String), anyhow::Error> {
    let host = cpal::default_host();
    let devices: Vec<_> = host
        .input_devices()
        .map_err(|e| anyhow::anyhow!("cpal enum inputs: {e}"))?
        .collect();

    let target = norm_name(coreaudio_name);

    for d in devices.iter() {
        let name = cpal_device_label(d)?;
        if norm_name(&name) == target {
            return Ok((d.clone(), name));
        }
    }
    for d in devices.iter() {
        let name = cpal_device_label(d)?;
        let n = norm_name(&name);
        if !target.is_empty() && (n.contains(&target) || target.contains(&n)) {
            return Ok((d.clone(), name));
        }
    }

    if let Some(d) = host.default_input_device() {
        let name = cpal_device_label(&d)?;
        if !is_wisprnote_tap_name(&name) {
            return Ok((d, name));
        }
    }

    for d in devices {
        let name = cpal_device_label(&d)?;
        if !is_wisprnote_tap_name(&name) {
            return Ok((d, name));
        }
    }

    Err(anyhow::anyhow!("no usable CPAL input device"))
}

/// Prefer opening the mic at `preferred_hz` (system tap rate) when supported.
fn chosen_stream_config(
    device: &cpal::Device,
    preferred_hz: cpal::SampleRate,
) -> Result<(StreamConfig, SampleFormat, cpal::SampleRate), anyhow::Error> {
    let default = device
        .default_input_config()
        .map_err(|e| anyhow::anyhow!("cpal default_input_config: {e}"))?;

    let mut chosen = default;
    for range in device
        .supported_input_configs()
        .map_err(|e| anyhow::anyhow!("cpal supported_input_configs: {e}"))?
    {
        let min_r = range.min_sample_rate();
        let max_r = range.max_sample_rate();
        if preferred_hz >= min_r && preferred_hz <= max_r {
            chosen = range.with_sample_rate(preferred_hz);
            break;
        }
    }

    let hz = chosen.sample_rate();
    let fmt = chosen.sample_format();
    Ok((chosen.config(), fmt, hz))
}

fn push_mono_f32(data: &[f32], channels: usize, producer: &mut HeapProd<f32>) {
    use ringbuf::traits::Producer;
    if channels == 0 {
        return;
    }
    if channels == 1 {
        for &s in data {
            let _ = producer.try_push(s);
        }
        return;
    }
    for frame in data.chunks(channels) {
        let avg = frame.iter().copied().sum::<f32>() / channels as f32;
        let _ = producer.try_push(avg);
    }
}

fn push_mono_i16(data: &[i16], channels: usize, producer: &mut HeapProd<f32>) {
    use ringbuf::traits::Producer;
    const SCALE: f32 = 1.0 / (i16::MAX as f32);
    if channels == 0 {
        return;
    }
    if channels == 1 {
        for &s in data {
            let _ = producer.try_push(s as f32 * SCALE);
        }
        return;
    }
    for frame in data.chunks(channels) {
        let mut sum = 0f32;
        for &s in frame {
            sum += s as f32 * SCALE;
        }
        let _ = producer.try_push(sum / channels as f32);
    }
}

fn push_mono_i32(data: &[i32], channels: usize, producer: &mut HeapProd<f32>) {
    use ringbuf::traits::Producer;
    if channels == 0 {
        return;
    }
    if channels == 1 {
        for &s in data {
            let _ = producer.try_push((s as f64 / i32::MAX as f64) as f32);
        }
        return;
    }
    for frame in data.chunks(channels) {
        let mut sum = 0f32;
        for &s in frame {
            sum += (s as f64 / i32::MAX as f64) as f32;
        }
        let _ = producer.try_push(sum / channels as f32);
    }
}

fn push_mono_i8(data: &[i8], channels: usize, producer: &mut HeapProd<f32>) {
    use ringbuf::traits::Producer;
    const SCALE: f32 = 1.0 / i8::MAX as f32;
    if channels == 0 {
        return;
    }
    if channels == 1 {
        for &s in data {
            let _ = producer.try_push(s as f32 * SCALE);
        }
        return;
    }
    for frame in data.chunks(channels) {
        let mut sum = 0f32;
        for &s in frame {
            sum += s as f32 * SCALE;
        }
        let _ = producer.try_push(sum / channels as f32);
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    config: &StreamConfig,
    channels: usize,
    mut producer: HeapProd<f32>,
    push: fn(&[T], usize, &mut HeapProd<f32>),
) -> Result<cpal::Stream, BuildStreamError>
where
    T: SizedSample + 'static,
{
    device.build_input_stream(
        config,
        move |data: &[T], _| {
            push(data, channels, &mut producer);
        },
        |e| eprintln!("cpal mic stream error: {e}"),
        None,
    )
}

/// Keep CPAL stream alive; stopping the session drops this (stream pauses / stops).
pub struct CpalMicGuard {
    _stream: cpal::Stream,
    mic_sample_hz: cpal::SampleRate,
}

impl CpalMicGuard {
    pub fn mic_sample_hz(&self) -> cpal::SampleRate {
        self.mic_sample_hz
    }
}

/// Start CPAL microphone → mono f32 ring buffer. Match `preferred_out_hz` when the device allows.
pub fn spawn_cpal_mic(
    coreaudio_mic_name: &str,
    preferred_out_hz: u32,
    producer: HeapProd<f32>,
) -> Result<CpalMicGuard, anyhow::Error> {
    let (device, picked_name) = pick_cpal_input_device(coreaudio_mic_name)?;
    let (config, sample_format, mic_hz) = chosen_stream_config(&device, preferred_out_hz)?;
    let ch = config.channels as usize;

    eprintln!(
        "cpal mic: {picked_name} ch={ch} hz={mic_hz} fmt={sample_format:?} (tap prefers {preferred_out_hz})"
    );

    let stream = match sample_format {
        SampleFormat::F32 => build_stream::<f32>(&device, &config, ch, producer, push_mono_f32)?,
        SampleFormat::I16 => build_stream::<i16>(&device, &config, ch, producer, push_mono_i16)?,
        SampleFormat::I32 => build_stream::<i32>(&device, &config, ch, producer, push_mono_i32)?,
        SampleFormat::I8 => build_stream::<i8>(&device, &config, ch, producer, push_mono_i8)?,
        other => {
            return Err(anyhow::anyhow!(
                "unsupported CPAL mic sample format {other:?}; try another input device"
            ));
        }
    };

    stream.play().map_err(|e| anyhow::anyhow!("cpal play: {e}"))?;

    Ok(CpalMicGuard {
        _stream: stream,
        mic_sample_hz: mic_hz,
    })
}

/// Follow default input on the **system (tap) clock** so e.g. 16 kHz Bluetooth HFP stays aligned with 48 kHz tap.
#[derive(Clone, Default)]
pub struct MicRateFollower {
    phase: f64,
    held: f32,
    primed: bool,
}

impl MicRateFollower {
    /// One tap output tick worth of microphone audio.
    pub fn next_mic_for_system_tick(
        &mut self,
        mic_cons: &mut ringbuf::HeapCons<f32>,
        mic_hz: cpal::SampleRate,
        system_hz: cpal::SampleRate,
    ) -> f32 {
        use ringbuf::traits::Consumer;
        if !self.primed {
            if let Some(m) = mic_cons.try_pop() {
                self.held = m;
            }
            self.primed = true;
        }
        if mic_hz == 0 || system_hz == 0 {
            return self.held;
        }
        let ratio = mic_hz as f64 / system_hz as f64;
        self.phase += ratio;
        while self.phase >= 1.0 {
            if let Some(m) = mic_cons.try_pop() {
                self.held = m;
            }
            self.phase -= 1.0;
        }
        self.held
    }
}
