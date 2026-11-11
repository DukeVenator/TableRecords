import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { TableRecordsApp } from "../src/server/app.js";
import { wavHeader } from "../src/core/wav.js";

const apps: TableRecordsApp[] = [];
const roots: string[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close().catch(() => undefined);
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true }).catch(() => undefined);
});

function wav(seconds: number): Buffer {
  const pcm = Buffer.alloc(Math.round(48_000 * 2 * 2 * seconds), 0);
  return Buffer.concat([wavHeader(pcm.length), pcm]);
}

describe("resume processing", () => {
  it("enqueues run_all for audio recovered from an interrupted recording", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-resume-"));
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

    const first = new TableRecordsApp(config);
    await first.init();
    const session = await first.sessions.create({
      title: "Resume Test",
      participants: [{ discordUserId: "U1", discordName: "Alice", character: "Veyra" }],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const startMs = Date.now() - 2_000;
    const audioDir = path.join(first.sessions.sessionDir(session.sessionId), "discord", "audio", "U1");
    await fsp.mkdir(audioDir, { recursive: true });
    await fsp.writeFile(path.join(audioDir, `${startMs}-u_resume.wav`), wav(1));
    await first.sessions.setStatus(session, "recording", { startedAtMs: startMs });
    await first.close();

    const second = new TableRecordsApp(config);
    await second.init();
    apps.push(second);

    let jobs = second.store.listJobs(session.sessionId);
    for (let attempt = 0; attempt < 40 && !jobs.some((job) => job.type === "run_all"); attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      jobs = second.store.listJobs(session.sessionId);
    }
    expect(jobs.some((job) => job.type === "run_all")).toBe(true);
    const recovered = await second.sessions.get(session.sessionId);
    expect(recovered.notes).toContain("Interrupted capture recovered");
  });
});
