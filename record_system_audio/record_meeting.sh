#!/bin/bash
# Quick script to record a meeting with combined audio (mic + system)
# Usage: ./record_meeting.sh [duration_in_seconds] [output_name]

DURATION=${1:-1800}  # Default 30 minutes
OUTPUT_NAME=${2:-"meeting_$(date +%Y%m%d_%H%M%S)"}

echo "🎙️  Starting Combined Audio Recording"
echo "Duration: ${DURATION} seconds ($((DURATION / 60)) minutes)"
echo "Output: ${OUTPUT_NAME}.pcm"
echo ""

# Record
cargo run --release --bin combined_recorder -- --duration ${DURATION} --out "${OUTPUT_NAME}.pcm"

# Convert to WAV
echo ""
echo "Converting to WAV..."
ffmpeg -f f32le -ar 48000 -ac 1 -i "${OUTPUT_NAME}.pcm" "${OUTPUT_NAME}.wav" -y

echo ""
echo "✅ Recording complete!"
echo "📁 Files created:"
echo "   - ${OUTPUT_NAME}.pcm (raw)"
echo "   - ${OUTPUT_NAME}.wav (ready for transcription)"
echo ""
echo "💡 Next steps:"
echo "   - Transcribe with Whisper: whisper ${OUTPUT_NAME}.wav"
echo "   - Or upload to your AI note-taking service"
