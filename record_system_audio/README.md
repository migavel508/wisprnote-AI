# Audio Recorders for macOS

This project contains audio recording utilities for macOS using CoreAudio:

1. **System Audio Recorder** - Records system/speaker audio (what you hear)
2. **Microphone Recorder** - Records microphone/user input audio
3. **Combined Recorder** - Records BOTH microphone + system audio simultaneously (perfect for AI meeting notes like Granola)
4. **Real-Time Transcriber** - Records system audio with live Deepgram transcription 🆕

## Requirements

- macOS (uses CoreAudio framework)
- Rust toolchain
- ffmpeg (for converting PCM to WAV)

## Building

```bash
# Build all recorders
cargo build --release

# Or build individually
cargo build --release --bin record_system_audio
cargo build --release --bin mic_recorder
cargo build --release --bin combined_recorder
cargo build --release --bin realtime_transcribe
```

## Usage

### System Audio Recorder

Records all system audio output (what's playing through your speakers):

```bash
# Record 10 seconds to output.pcm (default)
cargo run --release --bin record_system_audio

# Record 30 seconds to a custom file
cargo run --release --bin record_system_audio -- --duration 30 --out mysession.pcm

# Convert PCM to WAV
ffmpeg -f f32le -ar 48000 -ac 1 -i output.pcm output.wav
```

### Microphone Recorder

Records audio from your default microphone:

```bash
# Record 10 seconds to mic_output.pcm (default)
cargo run --release --bin mic_recorder

# Record 30 seconds to a custom file
cargo run --release --bin mic_recorder -- --duration 30 --out my_recording.pcm

# Convert PCM to WAV (sample rate may vary based on your mic)
ffmpeg -f f32le -ar 16000 -ac 1 -i mic_output.pcm mic_output.wav
```

**Note:** The sample rate for the microphone recorder depends on your device. The program will display the detected sample rate - use that value in the ffmpeg command.

### Combined Recorder (Microphone + System Audio)

Records both your voice and system audio simultaneously - **perfect for AI meeting notes, Granola-style recordings**:

```bash
# Record 60 seconds to meeting.pcm (default)
cargo run --release --bin combined_recorder

# Record a 30-minute meeting
cargo run --release --bin combined_recorder -- --duration 1800 --out my_meeting.pcm

# Convert PCM to WAV
ffmpeg -f f32le -ar 48000 -ac 1 -i meeting.pcm meeting.wav
```

**What it captures:**
- ✅ Your microphone input (your voice)
- ✅ System audio (other participants, videos, music, notifications)
- ✅ Both streams mixed into a single mono output
- ✅ Perfect for transcription and AI note-taking apps

### Real-Time Transcriber (System Audio Only)

Records system audio and transcribes it in real-time using Deepgram's WebSocket API:

```bash
# Set your Deepgram API key
export DEEPGRAM_API_KEY="your_api_key_here"

# Start real-time transcription (default 60 seconds)
cargo run --release --bin realtime_transcribe

# Record and transcribe for 5 minutes
cargo run --release --bin realtime_transcribe -- --duration 300
```

**Features:**
- ✅ Real-time transcription of system audio
- ✅ Shows both interim (partial) and final results
- ✅ Low-latency WebSocket streaming

**See [REALTIME_TRANSCRIPTION.md](REALTIME_TRANSCRIPTION.md) for detailed documentation.**

### Combined Real-Time Transcriber (Microphone + System Audio) 🔥

Records **BOTH** microphone and system audio, then transcribes everything in real-time:

```bash
# Set your Deepgram API key
export DEEPGRAM_API_KEY="your_api_key_here"

# Start combined transcription
cargo run --release --bin combined_transcribe -- --duration 60
```

**Features:**
- ✅ Captures your voice (microphone) AND system audio simultaneously
- ✅ Perfect for meetings, video calls, and conversations
- ✅ Real-time transcription of both audio sources mixed together
- ✅ No echo or repeated words

**See [COMBINED_TRANSCRIPTION.md](COMBINED_TRANSCRIPTION.md) for detailed documentation.**

### Web Interface Transcriber (Browser UI) 🌐✨

Same as combined transcriber but with a **beautiful web interface** in your browser!

```bash
# Set your Deepgram API key
export DEEPGRAM_API_KEY="your_api_key_here"

# Start web transcriber
cargo run --release --bin web_transcribe

# Open browser to http://localhost:3030
```

**Features:**
- ✅ Beautiful, modern web UI with real-time updates
- ✅ Captures microphone + system audio
- ✅ WebSocket streaming to browser
- ✅ Automatic duplicate filtering
- ✅ Timestamps and status indicators
- ✅ Perfect for presentations and demos

**See [WEB_INTERFACE.md](WEB_INTERFACE.md) for detailed documentation.**

## Command Line Options

Both recorders support the same options:

- `--duration <secs>` or `-d <secs>` - Recording duration in seconds (default: 10)
- `--out <file.pcm>` or `-o <file.pcm>` - Output file path (default: output.pcm or mic_output.pcm)
- `--help` or `-h` - Show help message

## Output Format

Both recorders output raw PCM audio in the following format:
- **Format:** 32-bit floating point (f32le)
- **Channels:** Mono (1 channel)
- **Sample Rate:** Varies by device (typically 48000 Hz for system audio, 16000-48000 Hz for microphones)

## Converting to WAV

Use ffmpeg to convert the raw PCM files to WAV format:

```bash
# For system audio (typically 48000 Hz)
ffmpeg -f f32le -ar 48000 -ac 1 -i output.pcm output.wav

# For microphone (check the sample rate displayed when recording)
ffmpeg -f f32le -ar 16000 -ac 1 -i mic_output.pcm mic_output.wav
```

## Permissions

On macOS, you may need to grant microphone access permissions when running the microphone recorder for the first time.

## Stopping Early

Press `Ctrl-C` to stop recording before the duration expires.

## Use Cases

### For AI Meeting Notes (like Granola)

Use the **combined_recorder** to capture everything in a meeting:

```bash
# Start recording before your meeting
cargo run --release --bin combined_recorder -- --duration 3600 --out meeting_2024_03_15.pcm

# After the meeting, convert to WAV
ffmpeg -f f32le -ar 48000 -ac 1 -i meeting_2024_03_15.pcm meeting_2024_03_15.wav

# Now you can:
# - Transcribe with Whisper or other AI tools
# - Send to ChatGPT/Claude for meeting summaries
# - Extract action items and key points
```

### For Podcasting

- Use **mic_recorder** for your voice
- Use **record_system_audio** for guest audio from video calls
- Use **combined_recorder** for both simultaneously

### For Screen Recording Audio

- Use **record_system_audio** to capture app audio
- Use **combined_recorder** to include your narration
