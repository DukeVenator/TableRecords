import { afterEach, describe, expect, it } from "vitest";
import { EventEmitter, once } from "node:events";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough, Readable } from "node:stream";
import prism from "prism-media";
import { VoiceConnectionStatus } from "@discordjs/voice";
import { loadConfig } from "../src/server/config.js";
import { RecorderService } from "../src/server/recorder.js";
import type { DiscordService } from "../src/server/discord.js";
import { inspectWav } from "../src/core/wav.js";
import { readJsonl } from "../src/core/paths.js";
import type { DiscordUtterance } from "../src/core/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function opusPackets(frames = 5): Promise<Buffer[]> {
  const encoder = new prism.opus.Encoder({ rate: 48_000, channels: 2, frameSize: 960 });
  const packets: Buffer[] = [];
  encoder.on("data", (packet: Buffer) => packets.push(packet));
  for (let index = 0; index < frames; index += 1) {
    encoder.write(Buffer.alloc(960 * 2 * 2));
  }
  encoder.end();
  await once(encoder, "end");
  return packets;
}

describe("recorder", () => {
  it("turns a speaking.start stream into a valid WAV and manifest line", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-recorder-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const packets = await opusPackets(5);
    expect(packets.length).toBeGreaterThan(0);

    const speaking = new EventEmitter();
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      receiver: {
        speaking,
        subscribe: () => Readable.from(packets)
      }
    });
    const discord = {
      voiceConnection: connection,
      voiceStatus: () => ({ state: "ready" }),
      botStatus: () => ({ userId: "BOT" }),
      memberName: async () => "Alice"
    } as unknown as DiscordService;

    const recorder = new RecorderService(config, discord);
    cleanup.push(async () => {
      await recorder.stop("manual").catch(() => undefined);
      await fsp.rm(root, { recursive: true, force: true });
    });

    const sessionId = "2026-11-01-recorder-test";
    const sessionDir = path.join(root, "sessions", sessionId);
    const utterance = new Promise<DiscordUtterance>((resolve) => recorder.once("utterance", resolve));
    await recorder.start({ sessionId, sessionDir });
    speaking.emit("start", "U_ALICE");
    const record = await utterance;
    await recorder.stop("stop");

    expect(record.discordUserId).toBe("U_ALICE");
    expect(record.displayName).toBe("Alice");
    expect(record.sessionId).toBe(sessionId);
    expect(record.bytes).toBeGreaterThan(44);
    expect(record.durationMs).toBeGreaterThan(0);
    expect(record.streamEnd).toBe("silence");
    expect(record.silent).toBe(true);
    expect(record.voicedMs).toBe(0);

    const wav = await inspectWav(path.join(sessionDir, record.file));
    expect(wav.dataBytes).toBe(record.bytes - 44);
    expect(wav.sampleRate).toBe(48_000);
    expect(wav.channels).toBe(2);
    const manifest = await readJsonl<DiscordUtterance>(path.join(sessionDir, "discord", "manifest.jsonl"));
    expect(manifest.items).toHaveLength(1);
    expect(manifest.items[0]?.utteranceId).toBe(record.utteranceId);
    expect(manifest.items[0]?.bytes).toBe(record.bytes);
  });

  it("pauses and resumes capture without recording while paused", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-recorder-pause-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const packets = await opusPackets(5);
    const speaking = new EventEmitter();
    const streams: PassThrough[] = [];
    let subscriptions = 0;
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      receiver: {
        speaking,
        subscribe: () => {
          subscriptions += 1;
          const stream = new PassThrough();
          streams.push(stream);
          return stream;
        }
      }
    });
    const discord = {
      voiceConnection: connection,
      voiceStatus: () => ({ state: "ready" }),
      botStatus: () => ({ userId: "BOT" }),
      memberName: async () => "Alice"
    } as unknown as DiscordService;

    const recorder = new RecorderService(config, discord);
    cleanup.push(async () => {
      await recorder.stop("manual").catch(() => undefined);
      await fsp.rm(root, { recursive: true, force: true });
    });
    const sessionId = "2026-01-01-recorder-pause-test";
    const sessionDir = path.join(root, "sessions", sessionId);
    await recorder.start({ sessionId, sessionDir });

    speaking.emit("start", "U_ALICE");
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(subscriptions).toBe(1);
    for (const packet of packets) streams[0]!.write(packet);
    await new Promise((resolve) => setTimeout(resolve, 20));

    await recorder.pause();
    expect(recorder.captureState).toBe("paused");
    expect(speaking.listenerCount("start")).toBe(0);
    expect(await fsp.readdir(path.join(sessionDir, "discord", "audio", "unknown")).catch(() => [])).toHaveLength(0);
    speaking.emit("start", "U_ALICE");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscriptions).toBe(1);

    await recorder.resume();
    expect(recorder.captureState).toBe("recording");
    expect(speaking.listenerCount("start")).toBe(1);
    const utterance = new Promise<DiscordUtterance>((resolve) => recorder.once("utterance", resolve));
    speaking.emit("start", "U_ALICE");
    await new Promise((resolve) => setTimeout(resolve, 20));
    for (const packet of packets) streams[1]!.write(packet);
    streams[1]!.end();
    expect((await utterance).discordUserId).toBe("U_ALICE");
    await recorder.stop("stop");
  });

  it("does not subscribe to a player who opted out", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-recorder-optout-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const speaking = new EventEmitter();
    let subscriptions = 0;
    const connection = Object.assign(new EventEmitter(), {
      state: { status: VoiceConnectionStatus.Ready },
      receiver: {
        speaking,
        subscribe: () => {
          subscriptions += 1;
          return Readable.from([]);
        }
      }
    });
    const discord = {
      voiceConnection: connection,
      voiceStatus: () => ({ state: "ready" }),
      botStatus: () => ({ userId: "BOT" }),
      memberName: async () => "Alice"
    } as unknown as DiscordService;

    const recorder = new RecorderService(config, discord);
    cleanup.push(async () => {
      await recorder.stop("manual").catch(() => undefined);
      await fsp.rm(root, { recursive: true, force: true });
    });
    const sessionId = "2026-11-01-recorder-optout-test";
    const sessionDir = path.join(root, "sessions", sessionId);
    await recorder.start({ sessionId, sessionDir, optOutUserIds: ["U_ALICE"] });
    speaking.emit("start", "U_ALICE");
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(subscriptions).toBe(0);
    expect(recorder.diagnostics().utteranceCount).toBe(0);
    expect(await fsp.readFile(path.join(sessionDir, "discord", "manifest.jsonl"), "utf8").catch(() => "")).toBe("");
    await recorder.stop("stop");
  });
});
