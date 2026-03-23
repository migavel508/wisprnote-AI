/// Combined Audio Recorder (macOS only)
/// Records BOTH microphone input AND system audio simultaneously
/// Mixes them into a single mono output file - perfect for AI meeting notes
///
/// Build & run:
///   cargo run --bin combined_recorder -- --duration 60 --out meeting.pcm
///
/// Convert output PCM to WAV (requires ffmpeg):
///   ffmpeg -f f32le -ar 48000 -ac 1 -i meeting.pcm meeting.wav

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use anyhow::Result;
use cidre::{av, cat, cf, ns, os};
use cidre::core_audio as ca;
use ringbuf::{HeapRb, traits::Split};

const BUFFER_SIZE: usize = 65536;

struct Ctx {
    common_format: av::audio::CommonFormat,
    producer: ringbuf::HeapProd<f32>,
}

// IO proc for microphone input
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

    let mut producer = ctx.producer.lock().unwrap();
    
    match ctx.common_format {
        av::audio::CommonFormat::PcmF32 => {
            if let Some(samples) = read_samples::<f32>(buf) {
                use ringbuf::traits::Producer;
                producer.push_slice(samples);
            }
        }
        av::audio::CommonFormat::PcmF64 => {
            convert_and_push::<f64>(buf, &mut producer, |x| x as f32);
        }
        av::audio::CommonFormat::PcmI32 => {
            convert_and_push::<i32>(buf, &mut producer, |x| x as f32 / i32::MAX as f32);
        }
        av::audio::CommonFormat::PcmI16 => {
            convert_and_push::<i16>(buf, &mut producer, |x| x as f32 / i16::MAX as f32);
        }
        _ => {}
    }

    os::Status::NO_ERR
}

// IO proc for system audio (tap)
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

    let mut producer = ctx.producer.lock().unwrap();
    
    match ctx.common_format {
        av::audio::CommonFormat::PcmF32 => {
            if let Some(samples) = read_samples::<f32>(buf) {
                use ringbuf::traits::Producer;
                producer.push_slice(samples);
            }
        }
        av::audio::CommonFormat::PcmF64 => {
            convert_and_push::<f64>(buf, &mut producer, |x| x as f32);
        }
        av::audio::CommonFormat::PcmI32 => {
            convert_and_push::<i32>(buf, &mut producer, |x| x as f32 / i32::MAX as f32);
        }
        av::audio::CommonFormat::PcmI16 => {
            convert_and_push::<i16>(buf, &mut producer, |x| x as f32 / i16::MAX as f32);
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

pub fn record(duration_secs: u64, out_path: &str) -> Result<()> {
    println!("=== Combined Audio Recorder ===");
    println!("Recording BOTH microphone and system audio");
    println!();
    
    // 1. Setup microphone input device
    let mic_device = ca::System::default_input_device()?;
    let mic_name = mic_device.name()?;
    let mic_asbd = mic_device.input_asbd()?;
    let mic_format = av::AudioFormat::with_asbd(&mic_asbd).unwrap();
    let mic_common_format = mic_format.common_format();
    
    println!("Microphone  : {}", mic_name);
    println!("Mic Format  : {:?} @ {} Hz", mic_common_format, mic_asbd.sample_rate as u32);
    
    // 2. Setup system audio tap
    let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
    let tap = tap_desc.create_process_tap()?;
    let tap_asbd = tap.asbd().unwrap();
    let tap_format = av::AudioFormat::with_asbd(&tap_asbd).unwrap();
    let tap_common_format = tap_format.common_format();
    
    println!("System Audio: Tap");
    println!("Tap Format  : {:?} @ {} Hz", tap_common_format, tap_asbd.sample_rate as u32);
    println!();
    
    // Use the higher sample rate for output (typically both will be 48000)
    let output_sample_rate = mic_asbd.sample_rate.max(tap_asbd.sample_rate) as u32;
    
    // 3. Build aggregate device for system audio tap
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
            cf::String::from_str("CombinedRecorder_Tap").as_ref(),
            &cf::Uuid::new().to_cf_string(),
            &cf::ArrayOf::from_slice(&[sub_tap.as_ref()]),
        ],
    );
    
    let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
    
    // 4. Create shared ring buffer for both streams
    let rb = HeapRb::<f32>::new(BUFFER_SIZE);
    let (producer, mut consumer) = rb.split();
    let producer = Arc::new(Mutex::new(producer));
    
    // 5. Setup contexts for both IO procs
    let mut mic_ctx = Box::new(Ctx {
        common_format: mic_common_format,
        producer: Arc::clone(&producer),
    });
    
    let mut system_ctx = Box::new(Ctx {
        common_format: tap_common_format,
        producer: Arc::clone(&producer),
    });
    
    // 6. Start both devices
    let mic_proc_id = mic_device.create_io_proc_id(mic_io_proc, Some(&mut *mic_ctx))?;
    let _mic_started = ca::device_start(mic_device, Some(mic_proc_id))?;
    
    let system_proc_id = agg_device.create_io_proc_id(system_io_proc, Some(&mut *system_ctx))?;
    let _system_started = ca::device_start(agg_device, Some(system_proc_id))?;
    
    println!("Output file : {}", out_path);
    println!("Sample rate : {} Hz", output_sample_rate);
    println!("Duration    : {}s", duration_secs);
    println!();
    
    // 7. Drain ring buffer into file
    let file = File::create(out_path)?;
    let mut writer = BufWriter::new(file);
    
    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();
    
    ctrlc::set_handler(move || {
        println!("\nInterrupted — stopping.");
        stop_clone.store(true, Ordering::Relaxed);
    })
    .ok();
    
    let deadline = std::time::Instant::now() + Duration::from_secs(duration_secs);
    let mut samples_written: u64 = 0;
    
    println!("Recording… (Ctrl-C to stop early)");
    println!("Capturing: Your voice + System audio");
    println!();
    
    while !stop.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
        use ringbuf::traits::Consumer;
        while let Some(sample) = consumer.try_pop() {
            writer.write_all(&sample.to_le_bytes())?;
            samples_written += 1;
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    
    writer.flush()?;
    println!(
        "Done. Wrote {} samples ({:.2}s @ {}Hz).",
        samples_written,
        samples_written as f64 / output_sample_rate as f64,
        output_sample_rate
    );
    println!();
    println!("Convert to WAV with ffmpeg:");
    println!(
        "  ffmpeg -f f32le -ar {} -ac 1 -i {} meeting.wav",
        output_sample_rate, out_path
    );
    
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    
    let mut duration = 60u64; // Default 1 minute for meetings
    let mut out_path = String::from("meeting.pcm");
    
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
                println!("Combined Audio Recorder - Records microphone + system audio");
                println!();
                println!("Usage: combined_recorder [--duration <secs>] [--out <file.pcm>]");
                println!();
                println!("Options:");
                println!("  --duration, -d <secs>  Recording duration in seconds (default: 60)");
                println!("  --out, -o <file.pcm>   Output file path (default: meeting.pcm)");
                println!("  --help, -h             Show this help message");
                return Ok(());
            }
            other => eprintln!("Unknown arg: {}", other),
        }
        i += 1;
    }
    
    record(duration, &out_path)
}
