# Real-Time Transcription with Deepgram

This project now includes real-time transcription capabilities using Deepgram's WebSocket API.

## Features

- **Real-time transcription**: Transcribes system audio as you speak
- **Interim and final results**: Shows both interim (partial) and final transcriptions
- **WebSocket streaming**: Uses Deepgram's streaming API for low-latency transcription
- **System audio capture**: Records all system audio output on macOS

## Prerequisites

1. **Deepgram API Key**: Get one from [https://deepgram.com](https://deepgram.com)
2. **macOS**: This uses CoreAudio for system audio capture (macOS only)

## Setup

### 1. Set your Deepgram API key

```bash
export DEEPGRAM_API_KEY="your_api_key_here"
```

Or pass it directly via command line (see usage below).

### 2. Build the project

```bash
cargo build --release --bin realtime_transcribe
```

## Usage

### Basic usage (with environment variable)

```bash
cargo run --release --bin realtime_transcribe
```

### With command-line options

```bash
# Specify duration
cargo run --release --bin realtime_transcribe -- --duration 30

# Specify API key directly
cargo run --release --bin realtime_transcribe -- --api-key YOUR_KEY_HERE

# Both options
cargo run --release --bin realtime_transcribe -- --duration 60 --api-key YOUR_KEY_HERE
```

### Command-line options

- `--duration <secs>` or `-d <secs>`: Recording duration in seconds (default: 60)
- `--api-key <key>` or `-k <key>`: Deepgram API key (overrides environment variable)
- `--help` or `-h`: Show help message

## Output

The program will display:
- Connection information (sample rate, format)
- Real-time transcription results with prefixes:
  - `[INTERIM]`: Partial transcription (may change)
  - `[FINAL]`: Final transcription (confirmed)

Example output:
```
Sample rate : 48000 Hz
Format      : PcmF32
Duration    : 60s
Starting real-time transcription with Deepgram...

Listening... (Ctrl-C to stop early)

--- TRANSCRIPTION ---
Deepgram connected: abc123-def456-ghi789
[INTERIM] Hello
[INTERIM] Hello world
[FINAL] Hello world
[INTERIM] This is
[INTERIM] This is a test
[FINAL] This is a test
--- END TRANSCRIPTION ---
Done.
```

## How It Works

1. **Audio Capture**: Uses CoreAudio process tap to capture system audio
2. **Audio Buffering**: Buffers audio samples in a lock-free ring buffer
3. **Format Conversion**: Converts f32 samples to i16 PCM for Deepgram
4. **WebSocket Streaming**: Sends audio chunks to Deepgram via WebSocket
5. **Real-time Results**: Receives and displays transcription results as they arrive

## Architecture

- `realtime_transcribe.rs`: Main binary that captures audio and manages transcription
- `deepgram_transcriber.rs`: Deepgram WebSocket client module
  - Handles WebSocket connection
  - Sends audio data
  - Receives and parses transcription results
  - Keep-alive messages to maintain connection

## Troubleshooting

### "DEEPGRAM_API_KEY not set"
Set the environment variable or use `--api-key` flag.

### No audio captured
Make sure there's audio playing on your system. The program captures system audio output.

### Connection errors
Check your internet connection and verify your Deepgram API key is valid.

### Build errors
Make sure you have all dependencies installed:
```bash
cargo clean
cargo build --release --bin realtime_transcribe
```

## Comparison with char Project

This implementation is inspired by the `char` project's Deepgram integration but simplified:
- Direct WebSocket connection (no custom adapter layer)
- Focused on system audio capture only
- Standalone binary (no complex workspace structure)
- Simpler transcription output (console-based)

## License

Same as the parent project.
