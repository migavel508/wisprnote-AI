/**
 * Audio processing utilities for splitting large audio files into batches.
 */

export interface AudioBatch {
  blob: Blob;
  mimeType: string;
  index: number;
  total: number;
  startTime: number;
  endTime: number;
}

/**
 * Normalise a browser MIME type string to what the Gemini API accepts.
 */
function normalizeMimeType(raw: string): string {
  if (!raw) return 'audio/webm';
  if (raw.startsWith('audio/webm'))  return 'audio/webm';
  if (raw.startsWith('audio/ogg'))   return 'audio/ogg';
  if (raw.startsWith('audio/mp4'))   return 'audio/mp4';
  if (raw.startsWith('audio/mpeg'))  return 'audio/mpeg';
  if (raw.startsWith('audio/wav'))   return 'audio/wav';
  if (raw.startsWith('audio/flac'))  return 'audio/flac';
  return raw;
}

/**
 * Encodes Float32Array samples to a WAV Blob.
 */
function encodeWAV(samples: Float32Array, sampleRate: number): Blob {
  const buffer = new ArrayBuffer(44 + samples.length * 2);
  const view = new DataView(buffer);

  const writeString = (offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  /* RIFF identifier */
  writeString(0, 'RIFF');
  /* file length */
  view.setUint32(4, 36 + samples.length * 2, true);
  /* RIFF type */
  writeString(8, 'WAVE');
  /* format chunk identifier */
  writeString(12, 'fmt ');
  /* format chunk length */
  view.setUint32(16, 16, true);
  /* sample format (raw) */
  view.setUint16(20, 1, true);
  /* channel count */
  view.setUint16(22, 1, true);
  /* sample rate */
  view.setUint32(24, sampleRate, true);
  /* byte rate (sample rate * block align) */
  view.setUint32(28, sampleRate * 2, true);
  /* block align (channel count * bytes per sample) */
  view.setUint16(32, 2, true);
  /* bits per sample */
  view.setUint16(34, 16, true);
  /* data chunk identifier */
  writeString(36, 'data');
  /* data chunk length */
  view.setUint32(40, samples.length * 2, true);

  let offset = 44;
  for (let i = 0; i < samples.length; i++, offset += 2) {
    const s = Math.max(-1, Math.min(1, samples[i]));
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
  }

  return new Blob([buffer], { type: 'audio/wav' });
}

/**
 * Splits an audio file into batches of a maximum size.
 * Since we can't easily predict the encoded size of a slice without encoding it,
 * we split by duration.
 */
/**
 * Returns a single-batch fallback using the raw file blob when
 * AudioContext cannot decode it (e.g. MediaRecorder webm without seek index).
 */
function rawFallbackBatch(file: File): AudioBatch[] {
  return [{
    blob: file,
    mimeType: normalizeMimeType(file.type),
    index: 0,
    total: 1,
    startTime: 0,
    endTime: 0
  }];
}

export async function splitAudio(file: File, maxChunkSizeMB: number = 15): Promise<AudioBatch[]> {
  const audioCtx = new (window.AudioContext || (window as any).webkitAudioContext)();

  let audioBuffer: AudioBuffer;
  try {
    const arrayBuffer = await file.arrayBuffer();
    audioBuffer = await audioCtx.decodeAudioData(arrayBuffer);
  } catch {
    // AudioContext cannot decode this format (common for MediaRecorder .webm).
    // Send the raw file as a single batch with its real MIME type.
    await audioCtx.close();
    return rawFallbackBatch(file);
  }

  // decodeAudioData sometimes succeeds but returns empty audio for recorded webm.
  if (!audioBuffer || audioBuffer.duration === 0 || audioBuffer.length === 0) {
    await audioCtx.close();
    return rawFallbackBatch(file);
  }

  const duration = audioBuffer.duration;
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  
  // Estimate how many seconds fit in maxChunkSizeMB
  // WAV 16-bit mono: sampleRate * 2 bytes per second
  const bytesPerSecond = sampleRate * 2;
  const maxBytesPerChunk = maxChunkSizeMB * 1024 * 1024;
  const secondsPerChunk = Math.floor(maxBytesPerChunk / bytesPerSecond);
  
  const batches: AudioBatch[] = [];
  const totalChunks = Math.ceil(duration / secondsPerChunk);
  
  for (let i = 0; i < totalChunks; i++) {
    const startSec = i * secondsPerChunk;
    const endSec = Math.min((i + 1) * secondsPerChunk, duration);
    
    const startFrame = Math.floor(startSec * sampleRate);
    const endFrame = Math.floor(endSec * sampleRate);
    const frameCount = endFrame - startFrame;
    
    // Extract mono samples (mix down if necessary)
    const chunkSamples = new Float32Array(frameCount);
    const channelData = audioBuffer.getChannelData(0); // Use first channel for mono
    
    for (let j = 0; j < frameCount; j++) {
      let sample = 0;
      for (let c = 0; c < numChannels; c++) {
        sample += audioBuffer.getChannelData(c)[startFrame + j];
      }
      chunkSamples[j] = sample / numChannels;
    }
    
    const blob = encodeWAV(chunkSamples, sampleRate);
    batches.push({
      blob,
      mimeType: 'audio/wav',
      index: i,
      total: totalChunks,
      startTime: startSec,
      endTime: endSec
    });
  }
  
  await audioCtx.close();
  return batches;
}

/**
 * Converts a Blob to a base64 string.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = (reader.result as string).split(',')[1];
      resolve(base64String);
    };
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}
