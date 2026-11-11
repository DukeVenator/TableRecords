import { spawn } from "node:child_process";
import { once } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DiscordUtterance, PeopleFile, ReviewAudioFile, ReviewAudioManifest, SessionRecord } from "../core/types.js";
import { WAV_BITS, WAV_CHANNELS, WAV_HEADER_BYTES, WAV_SAMPLE_RATE, inspectWav } from "../core/wav.js";
import { ensureDir, readJson, resolveExistingInside, writeJsonAtomic } from "../core/paths.js";
import { personIsOptedOut } from "../core/consent.js";
import type { AppConfig } from "./config.js";

const PCM_SAMPLE_RATE = WAV_SAMPLE_RATE;
const PCM_CHANNELS = WAV_CHANNELS;
const PCM_BYTES_PER_MS = (PCM_SAMPLE_RATE * PCM_CHANNELS * (WAV_BITS / 8)) / 1000;
const SILENCE_CHUNK = Buffer.alloc(Math.round(PCM_BYTES_PER_MS * 1000));

export interface ReviewAudioProgress {
  speaker: string;
  batch: number;
  batches: number;
  clipsWritten: number;
  totalClips: number;
}

export class ReviewAudioError extends Error {
  override name = "ReviewAudioError";
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function speakerSlug(name: string | null, userId: string): string {
  const base = (name ?? "speaker")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 40)
    .toLowerCase();
  return `${base || "speaker"}-${userId}`;
}

async function runFfmpeg(binary: string, args: string[], timeoutMs = 10 * 60_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(binary, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    let done = false;
    const finish = (error?: Error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve();
    };
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      finish(new ReviewAudioError("ffmpeg_timeout", "Review audio build timed out", 504));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
    });
    child.on("error", (error) => {
      finish(new ReviewAudioError("ffmpeg_missing", `Could not run ${binary}: ${error.message}`, 500));
    });
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new ReviewAudioError("ffmpeg_failed", `ffmpeg exited ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`, 500));
    });
  });
}

const waveformBuilds = new Map<string, Promise<string>>();

/**
 * Build a small, cached waveform image with ffmpeg's native decoder. This avoids
 * ever decoding a multi-hour mix in the browser. The image is white-on-black;
 * the client tints it and overlays speaker colours.
 */
export async function ensureReviewWaveform(params: {
  config: AppConfig;
  sessionDir: string;
  input: string;
  name: string;
}): Promise<string> {
  const dir = path.join(params.sessionDir, "review", "waveforms");
  await ensureDir(dir);
  const target = path.join(dir, `${params.name.replace(/\.mp3$/i, "")}.png`);
  try {
    const [inputStat, targetStat] = await Promise.all([fsp.stat(params.input), fsp.stat(target)]);
    if (targetStat.size > 0 && targetStat.mtimeMs >= inputStat.mtimeMs) return target;
  } catch {
    // Missing cache or source metadata; rebuild.
  }
  const existing = waveformBuilds.get(target);
  if (existing) return existing;
  const build = (async () => {
    await runFfmpeg(
      params.config.ffmpegPath,
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        params.input,
        "-filter_complex",
        "aformat=channel_layouts=mono,showwavespic=s=1600x120:colors=white",
        "-frames:v",
        "1",
        target
      ],
      20 * 60_000
    );
    return target;
  })();
  waveformBuilds.set(target, build);
  try {
    return await build;
  } catch (error) {
    await fsp.rm(target, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    waveformBuilds.delete(target);
  }
}

/** Parse ffmpeg's volumedetect max_volume without buffering decoded audio. */
async function measurePeakDb(binary: string, file: string, timeoutMs = 10 * 60_000): Promise<number | null> {
  return new Promise((resolve) => {
    const child = spawn(
      binary,
      ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"],
      { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] }
    );
    let stderr = "";
    const timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      resolve(null);
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", () => {
      clearTimeout(timer);
      resolve(null);
    });
    child.on("close", () => {
      clearTimeout(timer);
      const match = /max_volume:\s*(-?\d+(?:\.\d+)?)\s*dB/i.exec(stderr);
      resolve(match ? Number.parseFloat(match[1]!) : null);
    });
  });
}

/**
 * Some microphones are 20–40 dB quieter than others even after gating. Apply one
 * static peak lift after dynaudnorm so every speaker track is audible without
 * re-running a slow two-pass loudnorm over a multi-hour track.
 */
async function normalizeTrackPeak(binary: string, file: string): Promise<void> {
  const peak = await measurePeakDb(binary, file);
  if (peak == null || peak >= -3) return;
  const gain = Math.min(40, Math.max(0, -1.5 - peak));
  if (gain < 1) return;
  const temp = `${file}.normalize.mp3`;
  await runFfmpeg(
    binary,
    ["-hide_banner", "-loglevel", "error", "-y", "-i", file, "-af", `volume=${gain.toFixed(2)}dB`, "-c:a", "libmp3lame", "-q:a", "4", temp],
    20 * 60_000
  );
  await fsp.rename(temp, file);
}

/** Write a silence run without allocating the whole gap. */
async function writeSilence(write: (chunk: Buffer) => Promise<void>, ms: number): Promise<void> {  let remaining = Math.max(0, Math.round(ms * PCM_BYTES_PER_MS));
  remaining -= remaining % 4;
  while (remaining > 0) {
    const size = Math.min(remaining, SILENCE_CHUNK.length);
    await write(size === SILENCE_CHUNK.length ? SILENCE_CHUNK : SILENCE_CHUNK.subarray(0, size));
    remaining -= size;
  }
}

/** Copy one clip as exactly `targetBytes` of PCM, trimming or padding to keep the timeline exact. */
async function writeClipPcm(
  write: (chunk: Buffer) => Promise<void>,
  file: string,
  targetBytes: number
): Promise<void> {
  const info = await inspectWav(file);
  if (info.sampleRate === 16_000 && info.channels === 1 && info.bitsPerSample === WAV_BITS) {
    // Compacted clips are 16 kHz mono; repeat each sample into 48 kHz stereo so
    // the review mix can still be rebuilt from them.
    const source = await fsp.readFile(file);
    const frames = Math.min(info.dataBytes, source.length - WAV_HEADER_BYTES) >> 1;
    const out = Buffer.alloc(frames * 6 * 2);
    for (let index = 0; index < frames; index += 1) {
      const value = source.readInt16LE(WAV_HEADER_BYTES + index * 2);
      for (let repeat = 0; repeat < 3; repeat += 1) {
        out.writeInt16LE(value, index * 12 + repeat * 4);
        out.writeInt16LE(value, index * 12 + repeat * 4 + 2);
      }
    }
    const usable = Math.min(targetBytes, out.length);
    await write(out.subarray(0, usable));
    if (usable < targetBytes) await writeSilence(write, (targetBytes - usable) / PCM_BYTES_PER_MS);
    return;
  }
  if (info.sampleRate !== PCM_SAMPLE_RATE || info.channels !== PCM_CHANNELS || info.bitsPerSample !== WAV_BITS) {
    throw new ReviewAudioError(
      "unsupported_audio",
      `Review audio expects 48 kHz stereo 16-bit WAV clips (${path.basename(file)} is ${info.sampleRate} Hz, ${info.channels} ch, ${info.bitsPerSample}-bit)`,
      409
    );
  }
  const handle = await fsp.open(file, "r");
  let written = 0;
  try {
    const buffer = Buffer.alloc(1024 * 1024);
    let position = WAV_HEADER_BYTES;
    let remaining = Math.min(targetBytes, info.dataBytes);
    while (remaining > 0) {
      const size = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, size, position);
      if (bytesRead <= 0) break;
      await write(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
      written += bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (written < targetBytes) await writeSilence(write, (targetBytes - written) / PCM_BYTES_PER_MS);
}

/**
 * Encode a continuous PCM timeline into MP3. Clips are streamed in batches (default
 * 500) into one stdin pipe, so large sessions never need one ffmpeg input per clip
 * and never hit the Windows command-line limit.
 */
async function encodePcmTrack(params: {
  binary: string;
  output: string;
  produce: (write: (chunk: Buffer) => Promise<void>) => Promise<void>;
  normalize?: boolean;
  timeoutMs?: number;
}): Promise<void> {
  const args = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-y",
    "-f",
    "s16le",
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-ac",
    String(PCM_CHANNELS),
    "-i",
    "pipe:0"
  ];
  if (params.normalize) {
    // Dynaudnorm is fast enough for multi-hour tracks and lifts quiet speakers;
    // allow up to 40 dB of gain with a -1 dB peak target.
    args.push("-af", "dynaudnorm=f=500:g=31:p=0.9:m=100");
  }
  args.push(
    "-vn",
    "-ar",
    String(PCM_SAMPLE_RATE),
    "-ac",
    String(PCM_CHANNELS),
    "-c:a",
    "libmp3lame",
    "-q:a",
    "4",
    params.output
  );
  const child = spawn(
    params.binary,
    args,
    { windowsHide: true, stdio: ["pipe", "ignore", "pipe"] }
  );
  const stdin = child.stdin;
  if (!stdin) throw new ReviewAudioError("ffmpeg_failed", "Could not open the encoder input", 500);
  stdin.on("error", () => undefined);
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString("utf8")}`.slice(-8000);
  });
  const exit = new Promise<void>((resolve, reject) => {
    child.on("error", (error) => reject(new ReviewAudioError("ffmpeg_missing", `Could not run ${params.binary}: ${error.message}`, 500)));
    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new ReviewAudioError("ffmpeg_failed", `ffmpeg exited ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-3).join(" | ")}`, 500));
    });
  });
  const write = async (chunk: Buffer) => {
    if (!chunk.length) return;
    if (!stdin.write(chunk)) await once(stdin, "drain");
  };
  const timeoutMs = params.timeoutMs ?? 30 * 60_000;
  let timeoutHandle: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutHandle = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
      reject(new ReviewAudioError("ffmpeg_timeout", "Review audio build timed out", 504));
    }, timeoutMs);
  });
  const work = (async () => {
    await params.produce(write);
    stdin.end();
    await exit;
  })();
  // If the timeout wins the race, the work promise may still reject; keep it handled.
  work.catch(() => undefined);
  try {
    await Promise.race([work, timeout]);
  } catch (error) {
    try {
      child.kill("SIGKILL");
    } catch {
      // already gone
    }
    stdin.destroy();
    throw error;
  } finally {
    if (timeoutHandle) clearTimeout(timeoutHandle);
  }
}

async function removeWithRetry(target: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rm(target, { recursive: true, force: true });
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EBUSY", "EACCES", "ENOTEMPTY"].includes(code ?? "") || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await fsp.rename(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["EPERM", "EBUSY", "EACCES"].includes(code ?? "") || attempt === 3) throw error;
      await new Promise((resolve) => setTimeout(resolve, 150 * (attempt + 1)));
    }
  }
}

/**
 * Build review-only mixes from the per-utterance WAVs. The source recordings
 * stay untouched; each speaker's clips are streamed in batches at their real
 * session offsets into one PCM timeline, encoded once, then summed into a master.
 */
const activeBuilds = new Set<string>();

export async function buildReviewAudio(params: {
  config: AppConfig;
  session: SessionRecord;
  sessionDir: string;
  manifest: DiscordUtterance[];
  onProgress?: (progress: ReviewAudioProgress) => void;
}): Promise<ReviewAudioManifest> {
  if (activeBuilds.has(params.session.sessionId)) {
    throw new ReviewAudioError("build_in_progress", "Review audio is already being built for this session", 409);
  }
  activeBuilds.add(params.session.sessionId);
  try {
    return await buildReviewAudioInner(params);
  } finally {
    activeBuilds.delete(params.session.sessionId);
  }
}

async function buildReviewAudioInner(params: {
  config: AppConfig;
  session: SessionRecord;
  sessionDir: string;
  manifest: DiscordUtterance[];
  onProgress?: (progress: ReviewAudioProgress) => void;
}): Promise<ReviewAudioManifest> {
  const { config, session, sessionDir, manifest } = params;
  const peopleFile = await readJson<PeopleFile>(path.join(sessionDir, "people.json"));
  const optedOut = new Set(
    (peopleFile?.people ?? [])
      .filter((person) => personIsOptedOut(person) && person.discordUserId)
      .map((person) => person.discordUserId as string)
  );
  const valid = manifest
    .filter((item) => item && typeof item.file === "string" && Number.isFinite(item.startMs))
    .filter((item) => !optedOut.has(item.discordUserId))
    .sort((a, b) => a.startMs - b.startMs);
  if (valid.length === 0) {
    throw new ReviewAudioError(
      "no_audio",
      optedOut.size > 0 ? "Every captured speaker opted out of recording" : "No captured utterances to mix",
      409
    );
  }

  const startMs = session.startedAtMs ?? valid[0]!.startMs;
  const speakerDurationMs = new Map<string, number>();
  const speakerLabels = new Map<string, string>();
  const inputs = new Map<string, typeof valid>();
  for (const item of valid) {
    const durationMs = Math.max(0, item.durationMs || item.endMs - item.startMs);
    const end = item.startMs + durationMs;
    speakerDurationMs.set(item.discordUserId, Math.max(speakerDurationMs.get(item.discordUserId) ?? 0, end - startMs));
    speakerLabels.set(item.discordUserId, item.displayName || item.discordUserId);
    const list = inputs.get(item.discordUserId) ?? [];
    list.push(item);
    inputs.set(item.discordUserId, list);
  }
  const masterDurationMs = Math.max(1000, ...speakerDurationMs.values());

  const reviewDir = path.join(sessionDir, "review");
  const workDir = path.join(sessionDir, ".review-tmp");
  await removeWithRetry(workDir);
  await ensureDir(workDir);

  const batchSize = Math.max(50, Math.min(2000, config.reviewAudioBatchClips ?? 500));
  const files: ReviewAudioFile[] = [];
  const speakerFiles: string[] = [];
  try {
    for (const [userId, clips] of inputs) {
      const label = speakerLabels.get(userId) ?? userId;
      const name = `${speakerSlug(label, userId)}.mp3`;
      const output = path.join(workDir, name);
      let cursorMs = 0;
      let batchIndex = 0;
      const batches = Math.ceil(clips.length / batchSize);
      await encodePcmTrack({
        binary: config.ffmpegPath,
        output,
        normalize: config.reviewAudioNormalize,
        produce: async (write) => {
          for (let offset = 0; offset < clips.length; offset += batchSize) {
            const batch = clips.slice(offset, offset + batchSize);
            for (const clip of batch) {
              const clipStart = Math.max(0, clip.startMs - startMs);
              if (clipStart > cursorMs) {
                await writeSilence(write, clipStart - cursorMs);
                cursorMs = clipStart;
              }
              const durationMs = Math.max(0, clip.durationMs || clip.endMs - clip.startMs);
              const targetBytes = Math.max(0, Math.round((durationMs * PCM_BYTES_PER_MS) / 4) * 4);
              const file = await resolveExistingInside(sessionDir, clip.file);
              await writeClipPcm(write, file, targetBytes);
              cursorMs = clipStart + durationMs;
            }
            batchIndex += 1;
            params.onProgress?.({
              speaker: label,
              batch: batchIndex,
              batches,
              clipsWritten: Math.min(clips.length, offset + batch.length),
              totalClips: clips.length
            });
          }
        }
      });
      if (config.reviewAudioNormalize) await normalizeTrackPeak(config.ffmpegPath, output);
      const stat = await fsp.stat(output);
      files.push({
        name,
        label,
        kind: "speaker",
        speakerId: userId,
        speakerName: label,
        durationMs: Math.max(1000, speakerDurationMs.get(userId) ?? masterDurationMs),
        sizeBytes: stat.size
      });
      speakerFiles.push(output);
    }

    const masterName = "master.mp3";
    const masterFile = path.join(workDir, masterName);
    if (speakerFiles.length === 1) {
      await fsp.copyFile(speakerFiles[0]!, masterFile);
    } else {
      const args = ["-hide_banner", "-loglevel", "error", "-y"];
      for (const file of speakerFiles) args.push("-i", file);
      args.push(
        "-filter_complex",
        `${speakerFiles.map((_file, index) => `[${index}:a]`).join("")}amix=inputs=${speakerFiles.length}:duration=longest:dropout_transition=0,volume=${speakerFiles.length},alimiter=limit=0.95[mix]`,
        "-map",
        "[mix]",
        "-vn",
        "-ar",
        String(PCM_SAMPLE_RATE),
        "-ac",
        String(PCM_CHANNELS),
        "-c:a",
        "libmp3lame",
        "-q:a",
        "4",
        masterFile
      );
      await runFfmpeg(config.ffmpegPath, args, 30 * 60_000);
    }
    const masterStat = await fsp.stat(masterFile);
    files.unshift({
      name: masterName,
      label: "Master mix",
      kind: "master",
      durationMs: masterDurationMs,
      sizeBytes: masterStat.size
    });

    const result: ReviewAudioManifest = {
      schema: "tablerecords.review-audio/v1",
      sessionId: session.sessionId,
      generatedAtMs: Date.now(),
      durationMs: masterDurationMs,
      files
    };
    await writeJsonAtomic(path.join(workDir, "manifest.json"), result);
    await removeWithRetry(reviewDir);
    await renameWithRetry(workDir, reviewDir);
    return result;
  } catch (error) {
    await removeWithRetry(workDir).catch(() => undefined);
    throw error;
  }
}
