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
 * Applies a soft noise gate to reduce background noise so the transcription
 * model focuses on actual speech.
 *
 * Uses a running sum-of-squares over a sliding window so the cost is O(n)
 * instead of O(n × windowSize). The previous per-sample re-scan made long
 * recordings (e.g. an hour) take billions of extra operations.
 */
function applyNoiseGate(samples: Float32Array, threshold: number = 0.01): Float32Array {
  const n = samples.length;
  const result = new Float32Array(n);
  const windowSize = 1600; // ~100ms at 16kHz
  const half = windowSize >> 1;

  // Maintain a window [lo, hi) = [max(0, i-half), min(n, i+half)) and update the
  // sum-of-squares incrementally as it slides forward.
  let sum = 0;
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const newLo = Math.max(0, i - half);
    const newHi = Math.min(n, i + half);
    while (hi < newHi) {
      sum += samples[hi] * samples[hi];
      hi++;
    }
    while (lo < newLo) {
      sum -= samples[lo] * samples[lo];
      lo++;
    }
    const count = hi - lo;
    const rms = count > 0 ? Math.sqrt(sum / count) : 0;

    // Soft gate: attenuate very quiet sections but don't hard-mute them.
    result[i] = rms < threshold ? samples[i] * (rms / threshold) : samples[i];
  }

  return result;
}

/**
 * Removes noiseless silence from a mono signal, keeping only regions that
 * contain meaningful sound. This prevents long gaps from being transcribed as
 * "[inaudible]" and shrinks the audio sent to the model (faster batches).
 *
 * The algorithm is a lightweight, single-pass VAD:
 *  1. Compute short-frame RMS energy (O(n)).
 *  2. Derive an ADAPTIVE threshold from the recording's own noise floor, so it
 *     works on both quiet and loud files instead of a brittle fixed cutoff.
 *  3. Bridge short pauses (keep natural speech rhythm) and only drop silence
 *     longer than `minSilenceMs`.
 *  4. Pad each kept region so word onsets/offsets are never clipped.
 *
 * It is deterministic (pure function of the input), which the resume / re-split
 * paths depend on.
 */
function removeSilence(
  samples: Float32Array,
  sampleRate: number,
  opts: { minSilenceMs?: number; padMs?: number; frameMs?: number } = {}
): Float32Array {
  const frameMs = opts.frameMs ?? 20;
  const minSilenceMs = opts.minSilenceMs ?? 600; // gaps shorter than this stay
  const padMs = opts.padMs ?? 150;               // keep a little air around speech

  const frameLen = Math.max(1, Math.floor((frameMs / 1000) * sampleRate));
  const numFrames = Math.ceil(samples.length / frameLen);
  if (numFrames <= 1) return samples;

  // 1) Per-frame RMS energy.
  const energies = new Float32Array(numFrames);
  for (let f = 0; f < numFrames; f++) {
    const start = f * frameLen;
    const end = Math.min(start + frameLen, samples.length);
    let sum = 0;
    for (let i = start; i < end; i++) sum += samples[i] * samples[i];
    energies[f] = Math.sqrt(sum / Math.max(1, end - start));
  }

  // 2) Adaptive threshold from percentiles of the energy distribution.
  const sorted = Float32Array.from(energies).sort();
  const pct = (p: number) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  const noiseFloor = pct(0.1);  // ~ silence/background energy
  const speechLevel = pct(0.95); // ~ loud speech energy
  const threshold = Math.max(noiseFloor * 2.5, 0.005);

  // Not enough dynamic range to confidently separate speech from silence
  // (e.g. uniformly loud or uniformly quiet) — leave the audio untouched.
  if (speechLevel < threshold * 1.5) return samples;

  // 3) Voiced mask + bridge short silence gaps.
  const voiced = new Uint8Array(numFrames);
  for (let f = 0; f < numFrames; f++) voiced[f] = energies[f] >= threshold ? 1 : 0;

  const minSilenceFrames = Math.max(1, Math.round(minSilenceMs / frameMs));
  for (let f = 0; f < numFrames; ) {
    if (voiced[f] === 0) {
      let g = f;
      while (g < numFrames && voiced[g] === 0) g++;
      if (g - f < minSilenceFrames) {
        for (let k = f; k < g; k++) voiced[k] = 1; // keep this short pause
      }
      f = g;
    } else {
      f++;
    }
  }

  // 4) Dilate voiced regions by padMs so onsets/offsets aren't clipped.
  const padFrames = Math.max(0, Math.round(padMs / frameMs));
  if (padFrames > 0) {
    const dilated = voiced.slice();
    for (let i = 0; i < numFrames; i++) {
      if (!voiced[i]) continue;
      const from = Math.max(0, i - padFrames);
      const to = Math.min(numFrames - 1, i + padFrames);
      for (let k = from; k <= to; k++) dilated[k] = 1;
    }
    voiced.set(dilated);
  }

  // 5) Concatenate kept frames.
  let keptFrames = 0;
  for (let i = 0; i < numFrames; i++) if (voiced[i]) keptFrames++;
  // If essentially everything would be cut, keep the original to avoid emitting
  // an empty/degenerate clip.
  if (keptFrames === 0) return samples;

  const out = new Float32Array(keptFrames * frameLen);
  let w = 0;
  for (let i = 0; i < numFrames; i++) {
    if (!voiced[i]) continue;
    const start = i * frameLen;
    const end = Math.min(start + frameLen, samples.length);
    out.set(samples.subarray(start, end), w);
    w += end - start;
  }
  return out.subarray(0, w);
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
    enableSilenceRemoval?: boolean;
  } = {}
): Promise<AudioBatch[]> {
  const {
    overlapSeconds = 10, // 10 second overlap between chunks
    // Normalization + noise gating are extra full-passes over the whole signal
    // that mainly help human listening; Gemini already handles level/noise well,
    // so they are OFF by default to keep splitting fast. (Silence removal below
    // is the pass that actually matters — it shrinks how much audio is uploaded.)
    enableNoiseGate = false,
    enableNormalization = false,
    // Cut noiseless silence so it is never transcribed as "[inaudible]" and so
    // the model has less audio to chew through (faster batches). Defaults to ON
    // for every call site so resume / re-split stay byte-for-byte deterministic.
    enableSilenceRemoval = true,
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

  // Apply audio processing. These helpers already return fresh arrays, so we
  // assign their result directly — no extra full-array copies (which, on a
  // multi-hour recording, meant hundreds of MB of needless allocation + GC).
  if (enableNormalization) {
    monoFull = normalizeAudio(monoFull);
  }
  if (enableNoiseGate) {
    monoFull = applyNoiseGate(monoFull, 0.008);
  }
  // Cut noiseless silence: stops silence becoming "[inaudible]" AND shrinks the
  // audio uploaded to the model (fewer/shorter chunks = faster batches).
  if (enableSilenceRemoval) {
    const trimmed = removeSilence(monoFull, outRate);
    // removeSilence returns a subarray view when it trims; materialize only then.
    monoFull = trimmed === monoFull ? monoFull : new Float32Array(trimmed);
  }

  // Duration now reflects the (possibly shortened) processed audio, so all chunk
  // math below operates on the compacted timeline.
  const duration = monoFull.length / outRate;

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
