/**
 * Cheap energy-based voice activity detection for captured Discord audio.
 *
 * Discord already tells us when a user starts transmitting, but a muted mic,
 * desktop fan, or an open-but-silent channel still produces Opus frames. Those
 * frames are pure hallucination fuel for ASR models, so we measure how much of
 * each utterance actually contains speech before it reaches STT.
 *
 * This is deliberately a tiny, dependency-free meter: 20 ms RMS frames against
 * a dBFS floor. It is not a semantic VAD and never replaces STT; it only lets
 * the capture pipeline mark (and skip) clips with no usable speech energy.
 */

export const VAD_SAMPLE_RATE = 48_000;
export const VAD_CHANNELS = 2;
export const VAD_FRAME_MS = 20;
export const VAD_DEFAULT_FLOOR_DBFS = -45;

export interface VadOptions {
  sampleRate?: number;
  channels?: number;
  frameMs?: number;
  /** A frame must be louder than this to count as voiced. */
  floorDbfs?: number;
}

export interface VadStats {
  /** Complete 20 ms frames measured. */
  frames: number;
  voicedFrames: number;
  voicedMs: number;
  totalMs: number;
  peakDbfs: number;
  rmsDbfs: number;
  floorDbfs: number;
}

export function amplitudeToDbfs(amplitude: number): number {
  if (!Number.isFinite(amplitude) || amplitude <= 0) return -120;
  return Math.max(-120, 20 * Math.log10(amplitude));
}

export function isVoicedFrame(frameRmsDbfs: number, floorDbfs = VAD_DEFAULT_FLOOR_DBFS): boolean {
  return frameRmsDbfs > floorDbfs;
}

/**
 * Streaming meter. `write` accepts arbitrary PCM s16le chunk boundaries and
 * keeps a partial frame for the next call.
 */
export class VoiceActivityMeter {
  readonly sampleRate: number;
  readonly channels: number;
  readonly frameMs: number;
  readonly floorDbfs: number;
  private readonly frameSamples: number;
  private readonly frameBytes: number;
  private carry = Buffer.alloc(0);
  private frames = 0;
  private voicedFrames = 0;
  private totalSamples = 0;
  private peak = 0;
  private sumSquares = 0;

  constructor(options: VadOptions = {}) {
    this.sampleRate = options.sampleRate ?? VAD_SAMPLE_RATE;
    this.channels = options.channels ?? VAD_CHANNELS;
    this.frameMs = options.frameMs ?? VAD_FRAME_MS;
    this.floorDbfs = options.floorDbfs ?? VAD_DEFAULT_FLOOR_DBFS;
    this.frameSamples = Math.max(1, Math.round((this.sampleRate * this.frameMs) / 1000) * this.channels);
    this.frameBytes = this.frameSamples * 2;
  }

  write(chunk: Buffer): void {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    let buffer: Buffer;
    if (this.carry.length === 0) {
      buffer = chunk;
    } else {
      buffer = Buffer.concat([this.carry, chunk]);
    }
    let offset = 0;
    while (buffer.length - offset >= this.frameBytes) {
      this.measureFrame(buffer, offset, this.frameBytes);
      offset += this.frameBytes;
    }
    this.carry = offset >= buffer.length ? Buffer.alloc(0) : Buffer.from(buffer.subarray(offset));
  }

  private measureFrame(buffer: Buffer, offset: number, bytes: number): void {
    const samples = bytes / 2;
    let frameSquares = 0;
    let framePeak = 0;
    for (let index = 0; index < samples; index += 1) {
      const value = buffer.readInt16LE(offset + index * 2) / 32768;
      const magnitude = Math.abs(value);
      if (magnitude > framePeak) framePeak = magnitude;
      frameSquares += value * value;
    }
    if (framePeak > this.peak) this.peak = framePeak;
    this.sumSquares += frameSquares;
    this.totalSamples += samples;
    this.frames += 1;
    const frameRms = Math.sqrt(frameSquares / samples);
    if (isVoicedFrame(amplitudeToDbfs(frameRms), this.floorDbfs)) this.voicedFrames += 1;
  }

  stats(): VadStats {
    const totalSamples = this.totalSamples + Math.floor(this.carry.length / 2);
    const rms = this.totalSamples > 0 ? Math.sqrt(this.sumSquares / this.totalSamples) : 0;
    return {
      frames: this.frames,
      voicedFrames: this.voicedFrames,
      voicedMs: Math.round(this.voicedFrames * this.frameMs),
      totalMs: Math.round((totalSamples / this.channels / this.sampleRate) * 1000),
      peakDbfs: Math.round(amplitudeToDbfs(this.peak)),
      rmsDbfs: Math.round(amplitudeToDbfs(rms)),
      floorDbfs: this.floorDbfs
    };
  }
}

export interface SilenceDecisionOptions {
  minVoicedMs?: number;
}

/**
 * True when a clip has too little voiced energy to be worth transcribing.
 * At 20 ms frames the default rejects room tone and sub-200 ms clicks while
 * keeping a real one-word answer; capture-side gap merging folds the short
 * interjections into the next utterance before this check runs.
 */
export function isSilentUtterance(stats: Pick<VadStats, "voicedMs">, options: SilenceDecisionOptions = {}): boolean {
  const minVoicedMs = options.minVoicedMs ?? 200;
  return stats.voicedMs < Math.max(0, minVoicedMs);
}
