import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { compactSessionAudio, readAudioStorage, removeSessionAudio } from "../src/server/audioStorage.js";
import { inspectWav, wavHeader } from "../src/core/wav.js";
import type { DiscordUtterance } from "../src/core/types.js";

const roots: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

function wav(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(48_000 * 2 * 2 * seconds));
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

async function fixture() {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-storage-"));
  roots.push(root);
  const config = loadConfig({
    projectRoot: root,
    dataDir: path.join(root, "data"),
    sessionsDir: path.join(root, "sessions"),
    modelsDir: path.join(root, "models")
  });
  const store = new Store(config.dbFile);
  stores.push(store);
  const manager = new SessionManager(config, store);
  const session = await manager.create({ title: "Storage", participants: [], consent: { confirmed: true } });
  const dir = manager.sessionDir(session.sessionId);
  await fsp.mkdir(path.join(dir, "discord", "audio", "u1"), { recursive: true });
  await fsp.writeFile(path.join(dir, "discord", "audio", "u1", "a.wav"), wav(0.2));
  await fsp.writeFile(path.join(dir, "discord", "audio", "u1", "b.wav"), wav(0.2));
  const start = Date.now();
  const manifest: DiscordUtterance[] = ["a", "b"].map((name, index) => ({
    schema: "tablerecords.discord-utterance/v1",
    sessionId: session.sessionId,
    utteranceId: `u1-${name}`,
    discordUserId: "u1",
    displayName: "Alice",
    file: `discord/audio/u1/${name}.wav`,
    startMs: start + index * 1000,
    endMs: start + index * 1000 + 200,
    durationMs: 200,
    sampleRate: 48_000,
    channels: 2,
    format: "wav",
    encoding: "pcm_s16le",
    bytes: 44 + 19200,
    streamEnd: "silence",
    decryptionFailures: 0,
    createdAtMs: start
  }));
  await fsp.writeFile(
    path.join(dir, "discord", "manifest.jsonl"),
    `${manifest.map((item) => JSON.stringify(item)).join("\n")}\n`
  );
  await fsp.mkdir(path.join(dir, "review"), { recursive: true });
  await fsp.writeFile(path.join(dir, "review", "master.mp3"), Buffer.from("fake"));
  await fsp.writeFile(path.join(dir, "review", "alice.mp3"), Buffer.from("fake"));
  await fsp.writeFile(
    path.join(dir, "review", "manifest.json"),
    JSON.stringify({
      schema: "tablerecords.review-audio/v1",
      sessionId: session.sessionId,
      generatedAtMs: start,
      durationMs: 2000,
      files: [
        { name: "master.mp3", label: "Master mix", kind: "master", durationMs: 2000, sizeBytes: 4 },
        {
          name: "alice.mp3",
          label: "Alice",
          kind: "speaker",
          speakerId: "u1",
          speakerName: "Alice",
          durationMs: 2000,
          sizeBytes: 4
        }
      ]
    })
  );
  return { config, manager, session, dir, manifest };
}

describe("audio storage", () => {
  it("compacts clips to 16 kHz mono and keeps the review mix", async () => {
    const { manager, session, dir } = await fixture();
    const before = await readAudioStorage(dir);
    expect(before.state).toBe("available");
    const result = await compactSessionAudio({ session, sessionDir: dir });
    expect(result.converted).toBe(2);
    expect(result.after.state).toBe("compacted");
    expect(result.after.bytes).toBeLessThan(result.before.bytes);
    const info = await inspectWav(path.join(dir, "discord", "audio", "u1", "a.wav"));
    expect(info.sampleRate).toBe(16000);
    expect(info.channels).toBe(1);
    const after = await readAudioStorage(dir);
    expect(after.state).toBe("compacted");
    await expect(manager.detail(session.sessionId)).resolves.toMatchObject({ audio: { state: "compacted", clipCount: 2 } });
  });

  it("removes clips only when review audio is on disk", async () => {
    const { manager, session, dir } = await fixture();
    const result = await removeSessionAudio({ session, sessionDir: dir });
    expect(result.after.state).toBe("removed");
    await expect(fsp.access(path.join(dir, "discord", "audio"))).rejects.toThrow();
    await expect(fsp.access(path.join(dir, "discord", "manifest.removed.jsonl"))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(dir, "review", "master.mp3"))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(dir, "review", "alice.mp3"))).resolves.toBeUndefined();
    const detail = await manager.detail(session.sessionId);
    expect(detail.audio).toMatchObject({ state: "removed", clipCount: 2 });
    expect(detail.utterances).toHaveLength(0);
  });

  it("refuses to compact without review audio", async () => {
    const { session, dir } = await fixture();
    await fsp.rm(path.join(dir, "review"), { recursive: true, force: true });
    await expect(compactSessionAudio({ session, sessionDir: dir })).rejects.toMatchObject({ code: "review_required" });
    await expect(removeSessionAudio({ session, sessionDir: dir })).rejects.toMatchObject({ code: "review_required" });
  });
});
