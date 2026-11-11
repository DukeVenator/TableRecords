import fs from "node:fs";
import fsp from "node:fs/promises";
import { once } from "node:events";
import path from "node:path";
import { ensureDir } from "./paths.js";

export const WAV_SAMPLE_RATE = 48_000;
export const WAV_CHANNELS = 2;
export const WAV_BITS = 16;
export const WAV_HEADER_BYTES = 44;

/** Build a canonical 44-byte PCM RIFF/WAVE header. */
export function wavHeader(
  dataBytes: number,
  sampleRate = WAV_SAMPLE_RATE,
  channels = WAV_CHANNELS,
  bitsPerSample = WAV_BITS
): Buffer {
  if (!Number.isInteger(dataBytes) || dataBytes < 0) throw new Error("dataBytes must be a non-negative integer");
  if (dataBytes > 0xffffffff - 36) throw new Error("WAV data exceeds 4 GiB");
  const blockAlign = (channels * bitsPerSample) / 8;
  const byteRate = sampleRate * blockAlign;
  const header = Buffer.alloc(WAV_HEADER_BYTES);
  header.write("RIFF", 0, "ascii");
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write("WAVE", 8, "ascii");
  header.write("fmt ", 12, "ascii");
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20); // PCM
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(bitsPerSample, 34);
  header.write("data", 36, "ascii");
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

export interface WavFinalizeResult {
  bytes: number;
  dataBytes: number;
  durationMs: number;
}

/**
 * Streaming WAV writer. The header is reserved up front and patched on finalize.
 * PCM must be interleaved little-endian signed 16-bit.
 */
export class WavWriter {
  readonly file: string;
  readonly sampleRate: number;
  readonly channels: number;
  readonly bitsPerSample: number;
  private stream: fs.WriteStream;
  private dataBytes = 0;
  private finalized = false;

  constructor(
    file: string,
    options: { sampleRate?: number; channels?: number; bitsPerSample?: number } = {}
  ) {
    this.file = file;
    this.sampleRate = options.sampleRate ?? WAV_SAMPLE_RATE;
    this.channels = options.channels ?? WAV_CHANNELS;
    this.bitsPerSample = options.bitsPerSample ?? WAV_BITS;
    ensureDir(path.dirname(file));
    this.stream = fs.createWriteStream(file, { flags: "w" });
    this.stream.write(Buffer.alloc(WAV_HEADER_BYTES));
  }

  get bytes(): number {
    return this.dataBytes;
  }

  get durationMs(): number {
    const bytesPerMs = (this.sampleRate * this.channels * (this.bitsPerSample / 8)) / 1000;
    return Math.round(this.dataBytes / bytesPerMs);
  }

  async write(chunk: Buffer): Promise<void> {
    if (this.finalized) throw new Error("WAV writer already finalized");
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return;
    this.dataBytes += chunk.length;
    if (!this.stream.write(chunk)) await once(this.stream, "drain");
  }

  async finalize(): Promise<WavFinalizeResult> {
    if (this.finalized) throw new Error("WAV writer already finalized");
    this.finalized = true;
    const header = wavHeader(this.dataBytes, this.sampleRate, this.channels, this.bitsPerSample);
    this.stream.end();
    await once(this.stream, "close");
    const handle = await fsp.open(this.file, "r+");
    try {
      await handle.write(header, 0, WAV_HEADER_BYTES, 0);
    } finally {
      await handle.close();
    }
    if (this.dataBytes === 0) {
      // A zero-byte WAV is still a valid, diagnosable file. Callers decide whether to keep it.
    }
    return { bytes: WAV_HEADER_BYTES + this.dataBytes, dataBytes: this.dataBytes, durationMs: this.durationMs };
  }

  abort(): void {
    if (!this.finalized) {
      this.finalized = true;
      this.stream.destroy();
    }
  }
}

export interface TrimResult {
  trimmedMs: number;
  durationMs: number;
  dataBytes: number;
}

/**
 * Trim trailing near-silence from a canonical PCM WAV.
 *
 * Capture keeps a generous silence window open so a speaker can pause for a
 * sentence or two without being split into separate utterances. That means the
 * tail of every clip is mostly silence; trim it back to `paddingMs` after the
 * last voiced frame. Leading audio is never touched, so utterance start times
 * stay aligned with the manifest.
 */
export async function trimWavTrailingSilence(
  file: string,
  options: { thresholdDbfs?: number; paddingMs?: number; frameMs?: number } = {}
): Promise<TrimResult> {
  const thresholdDbfs = options.thresholdDbfs ?? -45;
  const paddingMs = Math.max(0, options.paddingMs ?? 300);
  const frameMs = Math.max(1, options.frameMs ?? 20);
  const buffer = await fsp.readFile(file);
  if (buffer.length < WAV_HEADER_BYTES) throw new Error("Not a WAV file");
  if (buffer.toString("ascii", 0, 4) !== "RIFF" || buffer.toString("ascii", 8, 12) !== "WAVE") {
    throw new Error("Not a RIFF/WAVE file");
  }
  const channels = buffer.readUInt16LE(22);
  const sampleRate = buffer.readUInt32LE(24);
  const bits = buffer.readUInt16LE(34);
  const declared = buffer.readUInt32LE(40);
  const dataBytes = Math.min(declared, buffer.length - WAV_HEADER_BYTES);
  if (dataBytes <= 0 || channels < 1 || bits !== 16) {
    return { trimmedMs: 0, durationMs: Math.round((dataBytes / (sampleRate * channels * 2)) * 1000), dataBytes };
  }
  const bytesPerMs = (sampleRate * channels * (bits / 8)) / 1000;
  const frameSamples = Math.max(1, Math.round((sampleRate * frameMs) / 1000) * channels);
  const frameBytes = frameSamples * 2;
  let lastVoicedEnd = 0;
  let frameStart = 0;
  while (frameStart + frameBytes <= dataBytes) {
    let squares = 0;
    for (let index = 0; index < frameSamples; index += 1) {
      const value = buffer.readInt16LE(WAV_HEADER_BYTES + frameStart + index * 2) / 32768;
      squares += value * value;
    }
    const rms = Math.sqrt(squares / frameSamples);
    const dbfs = rms <= 0 ? -120 : 20 * Math.log10(rms);
    if (dbfs > thresholdDbfs) lastVoicedEnd = frameStart + frameBytes;
    frameStart += frameBytes;
  }
  const paddingBytes = Math.round(paddingMs * bytesPerMs);
  const minimumBytes = Math.min(dataBytes, frameBytes);
  let keepBytes = Math.min(dataBytes, Math.max(minimumBytes, lastVoicedEnd + paddingBytes));
  const blockAlign = channels * (bits / 8);
  keepBytes -= keepBytes % blockAlign;
  if (keepBytes >= dataBytes) {
    return { trimmedMs: 0, durationMs: Math.round(dataBytes / bytesPerMs), dataBytes };
  }
  const header = wavHeader(keepBytes, sampleRate, channels, bits);
  const handle = await fsp.open(file, "r+");
  try {
    await handle.write(header, 0, WAV_HEADER_BYTES, 0);
    await handle.truncate(WAV_HEADER_BYTES + keepBytes);
  } finally {
    await handle.close();
  }
  return {
    trimmedMs: Math.round((dataBytes - keepBytes) / bytesPerMs),
    durationMs: Math.round(keepBytes / bytesPerMs),
    dataBytes: keepBytes
  };
}

/** Read a WAV header's PCM byte count and duration, for recovery/diagnostics. */
export async function inspectWav(file: string): Promise<{
  dataBytes: number;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  durationMs: number;
}> {
  const handle = await fsp.open(file, "r");
  try {
    const header = Buffer.alloc(WAV_HEADER_BYTES);
    await handle.read(header, 0, WAV_HEADER_BYTES, 0);
    if (header.toString("ascii", 0, 4) !== "RIFF" || header.toString("ascii", 8, 12) !== "WAVE") {
      throw new Error("Not a RIFF/WAVE file");
    }
    const channels = header.readUInt16LE(22);
    const sampleRate = header.readUInt32LE(24);
    const bitsPerSample = header.readUInt16LE(34);
    const dataBytes = header.readUInt32LE(40);
    const bytesPerMs = (sampleRate * channels * (bitsPerSample / 8)) / 1000;
    return { dataBytes, sampleRate, channels, bitsPerSample, durationMs: Math.round(dataBytes / bytesPerMs) };
  } finally {
    await handle.close();
  }
}
