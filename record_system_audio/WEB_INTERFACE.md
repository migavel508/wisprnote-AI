# Web Interface for Real-Time Transcription 🌐

## What's New

A beautiful web interface that displays real-time transcriptions in your browser!

## Quick Start

### 1. Set your API key

```bash
export DEEPGRAM_API_KEY="555b11280fed39c3fdb30249841a9125b4fb0233"
```

### 2. Start the web transcriber

```bash
cargo run --release --bin web_transcribe
```

### 3. Open your browser

The terminal will show:
```
🌐 Web interface available at: http://localhost:3030
   Open this URL in your browser to see transcriptions
```

Open **http://localhost:3030** in your browser.

### 4. Start speaking or play audio!

You'll see transcriptions appear in real-time in the browser with:
- ✅ Beautiful, modern UI
- ✅ Interim results (gray, italic)
- ✅ Final results (blue background)
- ✅ Timestamps for each transcription
- ✅ Auto-scroll to latest transcription
- ✅ No duplicates or repetition

## Features

### Audio Capture
- **Microphone**: Your voice
- **System Audio**: Videos, music, other participants
- **Smart Mixing**: Properly combines both sources without echo

### Web Interface
- **Real-time Updates**: Transcriptions appear instantly via WebSocket
- **Clean Design**: Modern, gradient background with smooth animations
- **Status Indicator**: Shows connection status with animated dot
- **Auto-scroll**: Always shows the latest transcription
- **Duplicate Prevention**: Filters out repeated final transcriptions

### Display
- **Interim Results**: Gray background, italic text, "⋯ Interim" label
- **Final Results**: Blue background, bold text, "✓ Final" label
- **Timestamps**: Each transcription shows the time it was received
- **Responsive**: Works on desktop and mobile browsers

## Usage Examples

```bash
# Basic usage (5 minutes)
cargo run --release --bin web_transcribe

# Longer session (30 minutes)
cargo run --release --bin web_transcribe -- --duration 1800

# With API key
cargo run --release --bin web_transcribe -- --api-key YOUR_KEY --duration 600
```

## Command-Line Options

- `--duration <secs>` or `-d <secs>`: Recording duration in seconds (default: 300)
- `--api-key <key>` or `-k <key>`: Deepgram API key
- `--help` or `-h`: Show help message

## How It Works

```
┌─────────────┐
│ Microphone  │──┐
└─────────────┘  │
                 ├──> Audio Mixer ──> Deepgram ──> WebSocket ──> Browser
┌─────────────┐  │                                                  ↓
│System Audio │──┘                                            Beautiful UI
└─────────────┘
```

1. **Audio Capture**: Captures mic + system audio
2. **Mixing**: Combines both sources (50/50 when both active)
3. **Transcription**: Sends to Deepgram via WebSocket
4. **Broadcasting**: Sends results to browser via WebSocket
5. **Display**: Shows in beautiful web interface

## Troubleshooting

### Browser shows "Connecting..."

1. Make sure the Rust program is running
2. Check that port 3030 is not blocked
3. Try refreshing the browser

### No transcriptions appearing

1. Check that audio is playing or you're speaking
2. Verify microphone permissions are granted
3. Check system audio is not muted
4. Look at terminal output for errors

### Duplicate transcriptions

The web interface automatically filters duplicate final transcriptions. If you still see duplicates:
1. Refresh the browser
2. Restart the program

### Connection lost

If the WebSocket disconnects:
1. The status will show "Disconnected"
2. Refresh the browser to reconnect
3. The Rust program keeps running in the background

## Multiple Browsers

You can open the web interface in multiple browser windows/tabs simultaneously. All will receive the same transcriptions in real-time.

## Stopping

Press **Ctrl-C** in the terminal to stop:
1. Audio capture stops
2. Transcription stops
3. Web server stays up for 10 seconds to show final results
4. Then exits completely

## Technical Details

- **Web Server**: Warp (Rust web framework)
- **WebSocket**: Real-time bidirectional communication
- **Port**: 3030 (localhost only)
- **Broadcast**: All connected browsers receive transcriptions
- **Auto-reconnect**: Browser reconnects if connection drops

## Comparison with Other Modes

| Feature | `combined_transcribe` | `web_transcribe` |
|---------|---------------------|------------------|
| Microphone | ✅ Yes | ✅ Yes |
| System Audio | ✅ Yes | ✅ Yes |
| Terminal Output | ✅ Yes | ✅ Yes |
| Web Interface | ❌ No | ✅ Yes |
| Best For | Quick testing | Presentations, demos, monitoring |

## Tips

1. **Keep browser open**: Leave the browser tab open to see all transcriptions
2. **Multiple monitors**: Put browser on second monitor while working
3. **Screen sharing**: Share the browser window in video calls to show live transcriptions
4. **Recording**: Use browser screen recording to save the transcription session

---

**Enjoy your beautiful real-time transcription interface!** 🎉
