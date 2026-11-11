import { spawn } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { DiscordUtterance, ReviewAudioManifest, SessionRecord } from "../core/types.js";
import { ensureDir, pathExists, readJson, resolveExistingInside } from "../core/paths.js";
import type { AppConfig } from "./config.js";

export class ReviewFallbackError extends Error {
  override name = "ReviewFallbackError";
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 409) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function runFfmpeg(binary: string, args: string[], timeoutMs = 30 * 60_000): Promise<void> {
  return new Promise((resolve, reject) => {
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
      finish(new ReviewFallbackError("ffmpeg_timeout", "Splitting the saved speaker tracks timed out", 504));
    }, timeoutMs);
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr = `${stderr}${chunk.toString("utf8")}`.slice(-4000);
    });
    child.on("error", (error) => finish(new ReviewFallbackError("ffmpeg_missing", `Could not run ${binary}: ${error.message}`, 500)));
    child.on("close", (code) => {
      if (code === 0) finish();
      else finish(new ReviewFallbackError("ffmpeg_failed", `ffmpeg exited ${code}: ${stderr.split(/\r?\n/).filter(Boolean).slice(-2).join(" | ")}`, 500));
    });
  });
}

function slug(value: string): string {
  return value
    .normalize("NFKD")
    .replace(/[^\w-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .toLowerCase() || "speaker";
}

/**
 * When the per-utterance clips are gone, split the saved per-speaker review
 * tracks into fixed windows so a later transcription can still run. Each window
 * becomes a synthetic utterance with the same absolute timeline position.
 */
export async function synthesizeReviewUtterances(params: {
  config: AppConfig;
  session: SessionRecord;
  sessionDir: string;
  windowMs?: number;
}): Promise<{ utterances: DiscordUtterance[]; cleanup: () => Promise<void> }> {
  const { config, session, sessionDir } = params;
  const windowMs = Math.max(1_000, params.windowMs ?? 120_000);
  const review = await readJson<ReviewAudioManifest>(path.join(sessionDir, "review", "manifest.json"));
  const speakers = (review?.files ?? []).filter((file) => file.kind === "speaker");
  if (!review || speakers.length === 0) {
    return { utterances: [], cleanup: async () => undefined };
  }
  const tempDir = path.join(sessionDir, "stt", "review-clips");
  await fsp.rm(tempDir, { recursive: true, force: true });
  await ensureDir(tempDir);
  const sessionStartMs = session.startedAtMs ?? review.generatedAtMs;
  const utterances: DiscordUtterance[] = [];
  const cleanup = async () => {
    await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  };
  try {
    for (const [index, file] of speakers.entries()) {
      const source = await resolveExistingInside(path.join(sessionDir, "review"), file.name);
      const speakerId = file.speakerId ?? `review-${index}`;
      const outDir = path.join(tempDir, slug(speakerId));
      await ensureDir(outDir);
      const pattern = path.join(outDir, "clip-%04d.wav");
      await runFfmpeg(config.ffmpegPath, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        source,
        "-f",
        "segment",
        "-segment_time",
        String(Math.round(windowMs / 1000)),
        "-reset_timestamps",
        "1",
        "-ar",
        "16000",
        "-ac",
        "1",
        "-c:a",
        "pcm_s16le",
        pattern
      ]);
      const files = (await fsp.readdir(outDir)).filter((name) => name.endsWith(".wav")).sort();
      for (const [clipIndex, name] of files.entries()) {
        const absolute = path.join(outDir, name);
        if (!(await pathExists(absolute))) continue;
        const startMs = sessionStartMs + clipIndex * windowMs;
        const endMs = Math.min(startMs + windowMs, sessionStartMs + Math.max(1000, file.durationMs));
        if (endMs <= startMs) continue;
        utterances.push({
          schema: "tablerecords.discord-utterance/v1",
          sessionId: session.sessionId,
          utteranceId: `review-${slug(speakerId)}-${String(clipIndex).padStart(4, "0")}`,
          discordUserId: speakerId,
          displayName: file.speakerName ?? file.label,
          file: path.relative(sessionDir, absolute).split(path.sep).join("/"),
          startMs,
          endMs,
          durationMs: endMs - startMs,
          sampleRate: 16_000,
          channels: 1,
          format: "wav",
          encoding: "pcm_s16le",
          bytes: 0,
          streamEnd: "silence",
          decryptionFailures: 0,
          createdAtMs: Date.now()
        });
      }
    }
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { utterances, cleanup };
}
