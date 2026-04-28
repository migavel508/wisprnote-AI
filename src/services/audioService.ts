/**
 * Audio processing utilities for splitting large audio files into batches.
 * 
 * Key features:
 * - Overlapping chunks to prevent content loss at boundaries
 * - Silence-aware splitting to find natural break points
 * - Noise normalization for better transcription quality
 * - Support for very large files via Gemini File API fallback
 */

export interface AudioBatch {
  blob: Blob;
  mimeType: string;
  index: number;
  total: number;
  startTime: number;
  endTime: number;
  overlapStart?: number; // seconds of overlap from previous chunk
}

// Threshold in MB above which we recommend using File API instead of batching
export const FILE_API_THRESHOLD_MB = 25;

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
 * Calculates RMS (root mean square) energy of a sample window.
 * Used for silence detection.
 */
function calculateRMS(samples: Float32Array, start: number, length: number): number {
  let sum = 0;
  const end = Math.min(start + length, samples.length);
  for (let i = start; i < end; i++) {
    sum += samples[i] * samples[i];
  }
  return Math.sqrt(sum / (end - start));
}

/**
 * Finds the best split point near a target position by looking for silence.
 * Returns the frame index of the best split point.
 */
function findSilenceSplitPoint(
  samples: Float32Array,
  targetFrame: number,
  sampleRate: number,
  searchWindowSec: number = 5 // search ±5 seconds around target
): number {
  const searchFrames = Math.floor(searchWindowSec * sampleRate);
  const windowSize = Math.floor(0.1 * sampleRate); // 100ms analysis window
  
  const searchStart = Math.max(0, targetFrame - searchFrames);
  const searchEnd = Math.min(samples.length - windowSize, targetFrame + searchFrames);
  
  let minEnergy = Infinity;
  let bestFrame = targetFrame;
  
  // Scan in 50ms steps for efficiency
  const stepSize = Math.floor(0.05 * sampleRate);
  
  for (let frame = searchStart; frame < searchEnd; frame += stepSize) {
    const energy = calculateRMS(samples, frame, windowSize);
    if (energy < minEnergy) {
      minEnergy = energy;
      bestFrame = frame;
    }
  }
  
  return bestFrame;
}

/**
 * Applies simple noise gate to reduce background noise.
 * This helps the transcription model focus on actual speech.
 */
function applyNoiseGate(samples: Float32Array, threshold: number = 0.01): Float32Array {
  const result = new Float32Array(samples.length);
  const windowSize = 1600; // 100ms at 16kHz
  
  for (let i = 0; i < samples.length; i++) {
    // Calculate local RMS
    const start = Math.max(0, i - windowSize / 2);
    const end = Math.min(samples.length, i + windowSize / 2);
    let sum = 0;
    for (let j = start; j < end; j++) {
      sum += samples[j] * samples[j];
    }
    const rms = Math.sqrt(sum / (end - start));
    
    // Apply soft gate - reduce very quiet sections but don't eliminate them
    if (rms < threshold) {
      result[i] = samples[i] * (rms / threshold);
    } else {
      result[i] = samples[i];
    }
  }
  
  return result;
}

/**
 * Normalizes audio to a consistent level for better transcription.
 */
function normalizeAudio(samples: Float32Array): Float32Array {
  // Find peak amplitude
  let peak = 0;
  for (let i = 0; i < samples.length; i++) {
    const abs = Math.abs(samples[i]);
    if (abs > peak) peak = abs;
  }
  
  // Normalize to 0.9 peak (leave headroom)
  if (peak > 0.001) {
    const gain = 0.9 / peak;
    const result = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) {
      result[i] = samples[i] * gain;
    }
    return result;
  }
  
  return samples;
}

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

/**
 * Check if a file should use the File API (server-side processing) instead of batching.
 */
export function shouldUseFileAPI(file: File): boolean {
  return file.size > FILE_API_THRESHOLD_MB * 1024 * 1024;
}

/**
 * Splits an audio file into overlapping batches with silence-aware boundaries.
 * 
 * Key improvements over simple fixed-duration splitting:
 * 1. Overlapping chunks (10 seconds) to capture content at boundaries
 * 2. Silence-aware split points to avoid cutting mid-sentence
 * 3. Audio normalization for consistent transcription quality
 * 4. Noise gating to reduce background noise interference
 */
export async function splitAudio(
  file: File, 
  maxChunkSizeMB: number = 15,
  options: {
    overlapSeconds?: number;
    enableNoiseGate?: boolean;
    enableNormalization?: boolean;
  } = {}
): Promise<AudioBatch[]> {
  const {
    overlapSeconds = 10, // 10 second overlap between chunks
    enableNoiseGate = true,
    enableNormalization = true,
  } = options;

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
  const srcRate = audioBuffer.sampleRate;
  
  // 16 kHz is the industry-standard rate for speech recognition.
  const outRate = Math.min(srcRate, 16000);
  const ratio = srcRate / outRate;

  // First, create the full mono downsampled audio for analysis
  const totalOutFrames = Math.ceil(audioBuffer.length / ratio);
  let monoFull = new Float32Array(totalOutFrames);
  
  // Mix all channels down to mono and downsample
  for (let j = 0; j < totalOutFrames; j++) {
    const srcIdx = j * ratio;
    const lo = Math.floor(srcIdx);
    const hi = Math.min(lo + 1, audioBuffer.length - 1);
    const t = srcIdx - lo;
    
    let sample = 0;
    for (let c = 0; c < numChannels; c++) {
      const channelData = audioBuffer.getChannelData(c);
      sample += channelData[lo] * (1 - t) + channelData[hi] * t;
    }
    monoFull[j] = sample / numChannels;
  }

  // Apply audio processing
  if (enableNormalization) {
    const normalized = normalizeAudio(monoFull);
    monoFull = new Float32Array(normalized);
  }
  if (enableNoiseGate) {
    const gated = applyNoiseGate(monoFull, 0.008);
    monoFull = new Float32Array(gated);
  }

  // Calculate chunk parameters
  const bytesPerSecond = outRate * 2; // 16-bit mono
  const maxBytesPerChunk = maxChunkSizeMB * 1024 * 1024;
  const baseSecondsPerChunk = Math.floor(maxBytesPerChunk / bytesPerSecond);
  
  // Effective chunk duration accounting for overlap
  const effectiveChunkDuration = baseSecondsPerChunk - overlapSeconds;
  
  // If audio is short enough for a single chunk, just return it
  if (duration <= baseSecondsPerChunk) {
    const blob = encodeWAV(monoFull, outRate);
    await audioCtx.close();
    return [{
      blob,
      mimeType: 'audio/wav',
      index: 0,
      total: 1,
      startTime: 0,
      endTime: duration,
      overlapStart: 0
    }];
  }

  const batches: AudioBatch[] = [];
  let currentStart = 0;
  let chunkIndex = 0;

  while (currentStart < duration) {
    // Calculate target end point
    let targetEnd = currentStart + baseSecondsPerChunk;
    
    // For all chunks except the last, find a silence point to split at
    let actualEnd: number;
    if (targetEnd >= duration) {
      actualEnd = duration;
    } else {
      // Find silence near the target split point (but before it to stay within size limit)
      const targetFrame = Math.floor((targetEnd - overlapSeconds / 2) * outRate);
      const silenceFrame = findSilenceSplitPoint(monoFull, targetFrame, outRate, 8);
      actualEnd = silenceFrame / outRate;
      
      // Ensure we don't exceed max chunk size
      if (actualEnd > targetEnd) {
        actualEnd = targetEnd;
      }
      // Ensure we make progress
      if (actualEnd <= currentStart + 30) {
        actualEnd = Math.min(currentStart + baseSecondsPerChunk, duration);
      }
    }

    // Extract chunk samples
    const startFrame = Math.floor(currentStart * outRate);
    const endFrame = Math.min(Math.floor(actualEnd * outRate), monoFull.length);
    const chunkSamples = monoFull.slice(startFrame, endFrame);

    const blob = encodeWAV(chunkSamples, outRate);
    
    batches.push({
      blob,
      mimeType: 'audio/wav',
      index: chunkIndex,
      total: 0, // Will be set after we know total count
      startTime: currentStart,
      endTime: actualEnd,
      overlapStart: chunkIndex > 0 ? overlapSeconds : 0
    });

    // Move to next chunk with overlap
    currentStart = actualEnd - overlapSeconds;
    if (currentStart < 0) currentStart = 0;
    
    // Prevent infinite loop
    if (actualEnd >= duration) break;
    
    chunkIndex++;
  }

  // Update total count in all batches
  const totalChunks = batches.length;
  for (const batch of batches) {
    batch.total = totalChunks;
  }

  await audioCtx.close();
  return batches;
}

/**
 * Converts a Blob to a base64 string.
 * Validates the blob is still readable before attempting conversion —
 * WebKit can silently evict blob backing data under memory pressure.
 */
export function blobToBase64(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!blob || blob.size === 0) {
      return reject(new BlobReadError('Blob is empty or invalid (size=0)'));
    }
    const reader = new FileReader();
    reader.onloadend = () => {
      if (!reader.result || typeof reader.result !== 'string') {
        return reject(new BlobReadError('FileReader returned empty result — blob data may have been evicted'));
      }
      const base64String = (reader.result as string).split(',')[1];
      if (!base64String) {
        return reject(new BlobReadError('Base64 conversion produced empty output'));
      }
      resolve(base64String);
    };
    reader.onerror = () => {
      reject(new BlobReadError(
        `FileReader failed: ${reader.error?.message || 'blob data unavailable (WebKitBlobResource eviction)'}`
      ));
    };
    reader.readAsDataURL(blob);
  });
}

/**
 * Distinguishable error class for blob-read failures so they aren't
 * confused with network errors in the caller's catch blocks.
 */
export class BlobReadError extends Error {
  readonly isBlobError = true;
  constructor(message: string) {
    super(message);
    this.name = 'BlobReadError';
  }
}
