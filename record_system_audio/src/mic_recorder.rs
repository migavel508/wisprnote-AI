/// Microphone Audio Recorder (macOS only)
/// Records microphone input via CoreAudio → writes raw f32 PCM to a .pcm file
///
/// Build & run:
///   cargo run --bin mic_recorder -- --duration 10 --out mic_output.pcm
///
/// Convert output PCM to WAV (requires ffmpeg):
///   ffmpeg -f f32le -ar 48000 -ac 1 -i mic_output.pcm mic_output.wav

use std::fs::File;
use std::io::{BufWriter, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use cidre::{av, cat, os};
use cidre::core_audio as ca;
use ringbuf::{HeapRb, traits::Split};

const BUFFER_SIZE: usize = 65536;

struct Ctx {
    common_format: av::audio::CommonFormat,
    producer: ringbuf::HeapProd<f32>,
}

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

pub fn record(duration_secs: u64, out_path: &str) -> Result<()> {
    // Get the default input device (microphone)
    let device = ca::System::default_input_device()?;
    
    // Get device info
    let device_name = device.name()?;
    let device_uid = device.uid()?;
    
    println!("Input Device: {}", device_name);
    println!("Device UID  : {}", device_uid);
    
    // Get the device's audio format
    let asbd = device.input_asbd()?;
    let sample_rate = asbd.sample_rate as u32;
    
    let format = av::AudioFormat::with_asbd(&asbd).unwrap();
    let common_format = format.common_format();
    
    println!("Sample rate : {} Hz", sample_rate);
    println!("Format      : {:?}", common_format);
    println!("Output file : {}", out_path);
    println!("Duration    : {}s", duration_secs);
    
    // Ring buffer for RT → main-thread transfer
    let rb = HeapRb::<f32>::new(BUFFER_SIZE);
    let (producer, mut consumer) = rb.split();
    
    let mut ctx = Box::new(Ctx { common_format, producer });
    
    // Create IO proc and start the device
    let proc_id = device.create_io_proc_id(io_proc, Some(&mut *ctx))?;
    let _started = ca::device_start(device, Some(proc_id))?;
    
    // Drain ring buffer into file
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
        samples_written as f64 / sample_rate as f64,
        sample_rate
    );
    println!();
    println!("Convert to WAV with ffmpeg:");
    println!(
        "  ffmpeg -f f32le -ar {} -ac 1 -i {} mic_output.wav",
        sample_rate, out_path
    );
    
    Ok(())
}

fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();
    
    let mut duration = 10u64;
    let mut out_path = String::from("mic_output.pcm");
    
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
                println!("Usage: mic_recorder [--duration <secs>] [--out <file.pcm>]");
                return Ok(());
            }
            other => eprintln!("Unknown arg: {}", other),
        }
        i += 1;
    }
    
    record(duration, &out_path)
}
