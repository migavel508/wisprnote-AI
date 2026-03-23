# Combined Real-Time Transcription (Microphone + System Audio)

## ✅ What This Does

Captures **BOTH** your microphone input AND system audio simultaneously, then transcribes everything in real-time using Deepgram.

Perfect for:
- 🎙️ **Meeting transcription** - Captures your voice + other participants
- 🎥 **Video call notes** - Records both sides of the conversation
- 🎮 **Gaming commentary** - Your voice + game audio
- 📺 **Content creation** - Narration + background audio

## Quick Start

### 1. Set your API key

```bash
export DEEPGRAM_API_KEY="555b11280fed39c3fdb30249841a9125b4fb0233"
```

### 2. Run the combined transcriber

```bash
cargo run --release --bin combined_transcribe -- --duration 60
```

### 3. Start speaking!

The program will capture:
- ✅ Your microphone (your voice)
- ✅ System audio (videos, music, other participants)
- ✅ Both mixed together for transcription

## Usage Examples

```bash
# Basic usage (60 seconds)
cargo run --release --bin combined_transcribe

# 5-minute meeting
cargo run --release --bin combined_transcribe -- --duration 300

# Pass API key directly
cargo run --release --bin combined_transcribe -- --api-key YOUR_KEY --duration 120

# Stop early with Ctrl-C
cargo run --release --bin combined_transcribe -- --duration 600
# Press Ctrl-C when done
```

## Command-Line Options

- `--duration <secs>` or `-d <secs>`: Recording duration in seconds (default: 60)
- `--api-key <key>` or `-k <key>`: Deepgram API key (overrides environment variable)
- `--help` or `-h`: Show help message

## Sample Output

```
Setting up microphone capture...
Setting up system audio capture...
Microphone  : 48000 Hz, PcmF32
System Audio: 48000 Hz, PcmF32
Duration    : 60s
Starting real-time transcription with Deepgram...

Listening to BOTH microphone and system audio... (Ctrl-C to stop early)

--- TRANSCRIPTION ---
[INTERIM] hello everyone
[FINAL] hello everyone
[INTERIM] today we're going to discuss
[FINAL] today we're going to discuss the project timeline
[INTERIM] can you hear me
[FINAL] can you hear me okay
--- END TRANSCRIPTION ---
Done.
```

## How It Works

1. **Dual Audio Capture**
   - Microphone: Captures your voice via default input device
   - System Audio: Captures all system output via CoreAudio tap

2. **Audio Mixing**
   - Both streams are mixed together in real-time
   - When both sources have audio, they're averaged (50/50 mix)
   - When only one source has audio, it's used directly

3. **Real-Time Transcription**
   - Mixed audio is sent to Deepgram via WebSocket
   - Transcriptions appear as they're processed
   - Shows both interim (partial) and final results

## Differences from Other Modes

| Feature | `realtime_transcribe` | `combined_transcribe` |
|---------|----------------------|----------------------|
| Microphone | ❌ No | ✅ Yes |
| System Audio | ✅ Yes | ✅ Yes |
| Best For | Transcribing videos/music | Meetings, calls, conversations |

## Troubleshooting

### No microphone audio?

1. Check macOS microphone permissions
2. Verify default input device: `System Settings > Sound > Input`
3. Test microphone with another app first

### No system audio?

1. Make sure audio is playing (YouTube, Spotify, etc.)
2. Check system volume is not muted
3. Try the `realtime_transcribe` binary to test system audio alone

### Only seeing one source?

Both sources are mixed. If you're only speaking (no system audio playing), you'll only hear your voice transcribed. Same if only system audio is playing.

### Echoing or repeated words?

This shouldn't happen with this implementation. The audio streams are properly mixed without duplication. If you experience this:
1. Check if you have multiple recording apps running
2. Verify you're not playing back your own audio
3. Make sure echo cancellation is enabled in your video call app

## Technical Details

- **Sample Rate**: Uses system audio sample rate (typically 48000 Hz)
- **Format**: Mono, 16-bit PCM sent to Deepgram
- **Mixing**: Averages samples when both sources are active
- **Latency**: Low-latency WebSocket streaming
- **Model**: Deepgram Nova-2 with interim results

## Build

```bash
cargo build --release --bin combined_transcribe
```

## Permissions

On first run, macOS will ask for:
- Microphone access
- Screen recording access (for system audio tap)

Grant both permissions for the app to work properly.

---

**Enjoy real-time transcription of your complete audio experience!** 🎉
