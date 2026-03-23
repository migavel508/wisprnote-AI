/// System Audio Recorder (macOS only)
/// Records system audio via CoreAudio process tap → writes raw f32 PCM to a .pcm file
///
/// Cargo.toml dependencies needed:
/// [dependencies]
/// anyhow = "1"
/// cidre = { version = "*", features = ["ca", "av", "cf", "ns"] }
/// ringbuf = "0.4"
///
/// Build & run:
///   rustc / cargo build --release
///   cargo run --bin record_system_audio -- --duration 10 --out output.pcm
///
/// Convert output PCM to WAV (requires ffmpeg):
///   ffmpeg -f f32le -ar 48000 -ac 1 -i output.pcm output.wav

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use cidre::{av, cat, cf, ns, os};
use cidre::core_audio as ca;
use ringbuf::{HeapRb, traits::Split};

const BUFFER_SIZE: usize = 65536; // ring buffer capacity (f32 samples)
const TAP_DEVICE_NAME: &str = "SystemAudioRecorder";

// ── Shared state passed into the CoreAudio IO proc ──────────────────────────

struct Ctx {
    common_format: av::audio::CommonFormat,
    producer: ringbuf::HeapProd<f32>,
}

// ── CoreAudio IO proc (real-time callback) ───────────────────────────────────

extern "C" fn io_proc(
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
                // Push directly — drop samples if ring is full (RT-safe)
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

// ── Helpers ──────────────────────────────────────────────────────────────────

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

// ── Main recording function ───────────────────────────────────────────────────

pub fn record(duration_secs: u64, out_path: &str) -> Result<()> {
    // 1. Create a global mono process tap (captures all system audio)
    let tap_desc =
        ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
    let tap = tap_desc.create_process_tap()?;

    let asbd = tap.asbd().unwrap();
    let sample_rate = asbd.sample_rate as u32;
    let format = av::AudioFormat::with_asbd(&asbd).unwrap();
    let common_format = format.common_format();

    println!("Sample rate : {sample_rate} Hz");
    println!("Format      : {common_format:?}");
    println!("Output file : {out_path}");
    println!("Duration    : {duration_secs}s");

    // 2. Build an aggregate device wrapping the tap
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
            cf::String::from_str(TAP_DEVICE_NAME).as_ref(),
            &cf::Uuid::new().to_cf_string(),
            &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
        ],
    );

    // 3. Ring buffer for RT → main-thread transfer
    let rb = HeapRb::<f32>::new(BUFFER_SIZE);
    let (producer, mut consumer) = rb.split();

    let mut ctx = Box::new(Ctx { common_format, producer });

    // 4. Start the aggregate device with our IO proc
    let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
    let proc_id = agg_device.create_io_proc_id(io_proc, Some(&mut *ctx))?;
    let _started = ca::device_start(agg_device, Some(proc_id))?;

    // 5. Drain ring buffer into file for `duration_secs`
    let file = File::create(out_path)?;
    let mut writer = BufWriter::new(file);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    // Ctrl-C handler
    ctrlc::set_handler(move || {
        println!("\nInterrupted — stopping.");
        stop_clone.store(true, Ordering::Relaxed);
    })
    .ok();

    let deadline = std::time::Instant::now() + Duration::from_secs(duration_secs);
    let mut samples_written: u64 = 0;

    println!("Recording… (Ctrl-C to stop early)");

    while !stop.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
        use ringbuf::traits::Consumer;
        // Drain whatever is available
        while let Some(sample) = consumer.try_pop() {
            writer.write_all(&sample.to_le_bytes())?;
            samples_written += 1;
        }
        std::thread::sleep(Duration::from_millis(5));
    }

    writer.flush()?;
    println!(
        "Done. Wrote {samples_written} samples ({:.2}s @ {sample_rate}Hz).",
        samples_written as f64 / sample_rate as f64
    );
    println!();
    println!("Convert to WAV with ffmpeg:");
    println!(
        "  ffmpeg -f f32le -ar {sample_rate} -ac 1 -i {out_path} output.wav"
    );

    Ok(())
}

// ── CLI entry point ───────────────────────────────────────────────────────────

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let mut duration = 10u64;
    let mut out_path = String::from("output.pcm");

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--duration" | "-d" => {
                i += 1;
                duration = args[i].parse().expect("duration must be a number");
            }
            "--out" | "-o" => {
                i += 1;
                out_path = args[i].clone();
            }
            "--help" | "-h" => {
                println!("Usage: record_system_audio [--duration <secs>] [--out <file.pcm>]");
                return Ok(());
            }
            other => eprintln!("Unknown arg: {other}"),
        }
        i += 1;
    }

    record(duration, &out_path)
}
