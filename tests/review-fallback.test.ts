import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { synthesizeReviewUtterances } from "../src/server/reviewFallback.js";

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

describe.skipIf(!ffmpegAvailable())("review track fallback", () => {
  it("splits a saved speaker track into timeline windows", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-review-fallback-"));
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
    const session = await manager.create({ title: "Fallback", participants: [], consent: { confirmed: true } });
    const dir = manager.sessionDir(session.sessionId);
    const start = Date.now();
    await fsp.mkdir(path.join(dir, "review"), { recursive: true });
    execFileSync("ffmpeg", [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      "-f",
      "lavfi",
      "-i",
      "anullsrc=r=48000:cl=stereo",
      "-t",
      "2.4",
      "-c:a",
      "libmp3lame",
      "-q:a",
      "6",
      path.join(dir, "review", "alice.mp3")
    ]);
    await fsp.writeFile(
      path.join(dir, "review", "manifest.json"),
      JSON.stringify({
        schema: "tablerecords.review-audio/v1",
        sessionId: session.sessionId,
        generatedAtMs: start,
        durationMs: 2400,
        files: [
          {
            name: "alice.mp3",
            label: "Alice",
            kind: "speaker",
            speakerId: "u1",
            speakerName: "Alice",
            durationMs: 2400,
            sizeBytes: 1000
          }
        ]
      })
    );
    await manager.setStatus(session, "captured", { startedAtMs: start, stoppedAtMs: start + 2400 });
    const fallback = await synthesizeReviewUtterances({
      config,
      session: await manager.get(session.sessionId),
      sessionDir: dir,
      windowMs: 1000
    });
    expect(fallback.utterances.length).toBe(3);
    expect(fallback.utterances[0]).toMatchObject({ startMs: start, durationMs: 1000, sampleRate: 16000, channels: 1 });
    expect(fallback.utterances[1]?.startMs).toBe(start + 1000);
    for (const utterance of fallback.utterances) {
      await expect(fsp.access(path.join(dir, utterance.file))).resolves.toBeUndefined();
    }
    await fallback.cleanup();
    await expect(fsp.access(path.join(dir, "stt", "review-clips"))).rejects.toThrow();
  });
});
