import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { buildReviewAudio } from "../src/server/reviewAudio.js";
import { wavHeader } from "../src/core/wav.js";
import type { DiscordUtterance } from "../src/core/types.js";

const roots: string[] = [];
const stores: Store[] = [];

function ffmpegAvailable(): boolean {
  try {
    execFileSync("ffmpeg", ["-version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

function wav(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(48_000 * 2 * 2 * seconds));
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

describe.skipIf(!ffmpegAvailable())("review audio", () => {
  it("creates a master and per-speaker timeline mixes", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-review-"));
    roots.push(root);
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models"),
      ffmpegPath: "ffmpeg"
    });
    const store = new Store(config.dbFile);
    stores.push(store);
    const manager = new SessionManager(config, store);
    const session = await manager.create({ title: "Review Audio", participants: [], consent: { confirmed: true } });
    const dir = manager.sessionDir(session.sessionId);
    const start = Date.now();
    await fsp.mkdir(path.join(dir, "discord", "audio", "u1"), { recursive: true });
    await fsp.mkdir(path.join(dir, "discord", "audio", "u2"), { recursive: true });
    await fsp.writeFile(path.join(dir, "discord", "audio", "u1", "a.wav"), wav(0.4));
    await fsp.writeFile(path.join(dir, "discord", "audio", "u1", "b.wav"), wav(0.4));
    await fsp.writeFile(path.join(dir, "discord", "audio", "u2", "c.wav"), wav(0.4));
    const manifest: DiscordUtterance[] = [
      {
        schema: "tablerecords.discord-utterance/v1",
        sessionId: session.sessionId,
        utteranceId: "u1a",
        discordUserId: "u1",
        displayName: "Alice",
        file: "discord/audio/u1/a.wav",
        startMs: start,
        endMs: start + 400,
        durationMs: 400,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: 0,
        streamEnd: "silence",
        decryptionFailures: 0,
        createdAtMs: start
      },
      {
        schema: "tablerecords.discord-utterance/v1",
        sessionId: session.sessionId,
        utteranceId: "u1b",
        discordUserId: "u1",
        displayName: "Alice",
        file: "discord/audio/u1/b.wav",
        startMs: start + 1000,
        endMs: start + 1400,
        durationMs: 400,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: 0,
        streamEnd: "silence",
        decryptionFailures: 0,
        createdAtMs: start
      },
      {
        schema: "tablerecords.discord-utterance/v1",
        sessionId: session.sessionId,
        utteranceId: "u2c",
        discordUserId: "u2",
        displayName: "Bob",
        file: "discord/audio/u2/c.wav",
        startMs: start + 500,
        endMs: start + 900,
        durationMs: 400,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: 0,
        streamEnd: "silence",
        decryptionFailures: 0,
        createdAtMs: start
      }
    ];
    await manager.setStatus(session, "captured", { startedAtMs: start, stoppedAtMs: start + 1800 });
    const result = await buildReviewAudio({ config, session: await manager.get(session.sessionId), sessionDir: dir, manifest });
    expect(result.files.map((file) => file.kind)).toEqual(["master", "speaker", "speaker"]);
    expect(result.files[0]?.name).toBe("master.mp3");
    expect(result.files.some((file) => file.label === "Alice")).toBe(true);
    for (const file of result.files) {
      await expect(fsp.access(path.join(dir, "review", file.name))).resolves.toBeUndefined();
    }
  });

  it("batches more than 500 clips and still produces a stitched master", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-review-large-"));
    roots.push(root);
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models"),
      ffmpegPath: "ffmpeg",
      reviewAudioBatchClips: 120
    });
    const store = new Store(config.dbFile);
    stores.push(store);
    const manager = new SessionManager(config, store);
    const session = await manager.create({ title: "Large Review", participants: [], consent: { confirmed: true } });
    const dir = manager.sessionDir(session.sessionId);
    const start = Date.now();
    const clipMs = 50;
    const stepMs = 100;
    const clipCount = 520;
    const clipFile = wav(clipMs / 1000);
    const manifest: DiscordUtterance[] = [];
    await fsp.mkdir(path.join(dir, "discord", "audio", "u1"), { recursive: true });
    for (let index = 0; index < clipCount; index += 1) {
      const file = `discord/audio/u1/${String(index).padStart(4, "0")}.wav`;
      await fsp.writeFile(path.join(dir, file), clipFile);
      const startMs = start + index * stepMs;
      manifest.push({
        schema: "tablerecords.discord-utterance/v1",
        sessionId: session.sessionId,
        utteranceId: `u1-${index}`,
        discordUserId: "u1",
        displayName: "Alice",
        file,
        startMs,
        endMs: startMs + clipMs,
        durationMs: clipMs,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: 0,
        streamEnd: "silence",
        decryptionFailures: 0,
        createdAtMs: start
      });
    }
    await manager.setStatus(session, "captured", { startedAtMs: start, stoppedAtMs: start + clipCount * stepMs });
    const batches: number[] = [];
    const result = await buildReviewAudio({
      config,
      session: await manager.get(session.sessionId),
      sessionDir: dir,
      manifest,
      onProgress: (progress) => {
        if (progress.batch === progress.batches) batches.push(progress.batches);
      }
    });
    expect(result.files[0]?.kind).toBe("master");
    expect(result.files).toHaveLength(2);
    expect(result.durationMs).toBeGreaterThanOrEqual(clipCount * stepMs - 200);
    expect(batches).toEqual([Math.ceil(clipCount / 120)]);
    await expect(fsp.access(path.join(dir, "review", "master.mp3"))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(dir, ".review-tmp"))).rejects.toThrow();
  });
});
