import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { TableRecordsApp } from "../src/server/app.js";

const apps: TableRecordsApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close().catch(() => undefined);
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true }).catch(() => undefined);
});

describe("audio range responses", () => {
  it("serves review audio with byte ranges so waveform players can seek", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-range-"));
    roots.push(root);
    const previous = process.env.LOG_LEVEL;
    process.env.LOG_LEVEL = "silent";
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models"),
      port: 17399,
      pythonPath: path.join(root, "missing-python.exe"),
      foundryDataPath: null,
      discordToken: null,
      dashboardToken: null
    });
    if (previous === undefined) delete process.env.LOG_LEVEL;
    else process.env.LOG_LEVEL = previous;
    const app = new TableRecordsApp(config);
    await app.init();
    apps.push(app);
    const session = await app.sessions.create({ title: "Range Test", participants: [], consent: { confirmed: true } });
    const dir = app.sessions.sessionDir(session.sessionId);
    const review = path.join(dir, "review");
    await fsp.mkdir(review, { recursive: true });
    const payload = Buffer.from("0123456789", "ascii");
    await fsp.writeFile(path.join(review, "master.mp3"), payload);
    await fsp.writeFile(
      path.join(review, "manifest.json"),
      JSON.stringify({
        schema: "tablerecords.review-audio/v1",
        sessionId: session.sessionId,
        generatedAtMs: Date.now(),
        durationMs: 1000,
        files: [{ name: "master.mp3", label: "Master mix", kind: "master", durationMs: 1000, sizeBytes: payload.length }]
      })
    );

    const ranged = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${session.sessionId}/review-audio/master.mp3`,
      headers: { range: "bytes=2-5" }
    });
    expect(ranged.statusCode).toBe(206);
    expect(ranged.headers["content-range"]).toBe("bytes 2-5/10");
    expect(ranged.headers["content-length"]).toBe("4");
    expect(ranged.headers["accept-ranges"]).toBe("bytes");
    expect(ranged.rawPayload.toString("ascii")).toBe("2345");

    const full = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${session.sessionId}/review-audio/master.mp3`
    });
    expect(full.statusCode).toBe(200);
    expect(full.headers["accept-ranges"]).toBe("bytes");
    expect(full.rawPayload.length).toBe(10);
  });
});
