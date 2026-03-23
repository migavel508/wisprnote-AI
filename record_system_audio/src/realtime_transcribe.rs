use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use anyhow::Result;
use cidre::{av, cat, cf, ns, os};
use cidre::core_audio as ca;
use ringbuf::{HeapRb, traits::Split};

mod deepgram_transcriber;
use deepgram_transcriber::DeepgramTranscriber;

const BUFFER_SIZE: usize = 65536;
const TAP_DEVICE_NAME: &str = "SystemAudioRecorder";
const CHUNK_SIZE: usize = 4800;

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

#[tokio::main]
async fn main() -> Result<()> {
    let args: Vec<String> = std::env::args().collect();

    let mut duration = 60u64;
    let mut api_key = std::env::var("DEEPGRAM_API_KEY").ok();

    let mut i = 1;
    while i < args.len() {
        match args[i].as_str() {
            "--duration" | "-d" => {
                i += 1;
                duration = args[i].parse().expect("duration must be a number");
            }
            "--api-key" | "-k" => {
                i += 1;
                api_key = Some(args[i].clone());
            }
            "--help" | "-h" => {
                println!("Usage: realtime_transcribe [--duration <secs>] [--api-key <key>]");
                println!("\nEnvironment variables:");
                println!("  DEEPGRAM_API_KEY - Deepgram API key (can also use --api-key)");
                return Ok(());
            }
            other => eprintln!("Unknown arg: {other}"),
        }
        i += 1;
    }

    let api_key = api_key.expect("DEEPGRAM_API_KEY not set. Use --api-key or set environment variable.");

    let tap_desc = ca::TapDesc::with_mono_global_tap_excluding_processes(&ns::Array::new());
    let tap = tap_desc.create_process_tap()?;

    let asbd = tap.asbd().unwrap();
    let sample_rate = asbd.sample_rate as u32;
    let format = av::AudioFormat::with_asbd(&asbd).unwrap();
    let common_format = format.common_format();

    println!("Sample rate : {sample_rate} Hz");
    println!("Format      : {common_format:?}");
    println!("Duration    : {duration}s");
    println!("Starting real-time transcription with Deepgram...\n");

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

    let rb = HeapRb::<f32>::new(BUFFER_SIZE);
    let (producer, mut consumer) = rb.split();

    let mut ctx = Box::new(Ctx { common_format, producer });

    let agg_device = ca::AggregateDevice::with_desc(&agg_desc)?;
    let proc_id = agg_device.create_io_proc_id(io_proc, Some(&mut *ctx))?;
    let _started = ca::device_start(agg_device, Some(proc_id))?;

    let mut transcriber = DeepgramTranscriber::new(api_key, sample_rate);

    let stop = Arc::new(AtomicBool::new(false));
    let stop_clone = stop.clone();

    ctrlc::set_handler(move || {
        println!("\nInterrupted — stopping.");
        stop_clone.store(true, Ordering::Relaxed);
    })
    .ok();

    let deadline = std::time::Instant::now() + Duration::from_secs(duration);
    let mut chunk_buffer = Vec::with_capacity(CHUNK_SIZE);

    println!("Listening... (Ctrl-C to stop early)\n");
    println!("--- TRANSCRIPTION ---");

    while !stop.load(Ordering::Relaxed) && std::time::Instant::now() < deadline {
        use ringbuf::traits::Consumer;
        
        while let Some(sample) = consumer.try_pop() {
            chunk_buffer.push(sample);
            
            if chunk_buffer.len() >= CHUNK_SIZE {
                if let Err(e) = transcriber.send_audio(chunk_buffer.clone()) {
                    eprintln!("Failed to send audio: {}", e);
                }
                chunk_buffer.clear();
            }
        }

        while let Some(transcript) = transcriber.try_recv_transcript() {
            println!("{}", transcript);
        }

        tokio::time::sleep(Duration::from_millis(10)).await;
    }

    if !chunk_buffer.is_empty() {
        let _ = transcriber.send_audio(chunk_buffer);
    }

    tokio::time::sleep(Duration::from_millis(500)).await;
    
    while let Some(transcript) = transcriber.try_recv_transcript() {
        println!("{}", transcript);
    }

    println!("\n--- END TRANSCRIPTION ---");
    println!("Done.");

    Ok(())
}
