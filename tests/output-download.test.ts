import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { TableRecordsApp } from "../src/server/app.js";

const apps: TableRecordsApp[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close().catch(() => undefined);
});

async function makeApp(): Promise<{ app: TableRecordsApp; sessionId: string; dir: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-download-"));
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

  const created = await app.fastify.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "content-type": "application/json" },
    payload: {
      title: "Download Test",
      participants: [{ discordUserId: "U1", discordName: "Alice" }],
      consent: { confirmed: true, confirmedBy: "GM" }
    }
  });
  const sessionId = (created.json() as { session: { sessionId: string } }).session.sessionId;
  const dir = app.sessions.sessionDir(sessionId);
  await fsp.mkdir(path.join(dir, "outputs"), { recursive: true });
  await fsp.writeFile(path.join(dir, "outputs", "transcript.md"), "# Transcript\n\nA long line of speech.\n", "utf8");
  return { app, sessionId, dir };
}

describe("output downloads", () => {
  it("serves inline by default and forces an attachment with ?download=1", async () => {
    const { app, sessionId } = await makeApp();

    const inline = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/outputs/transcript.md`
    });
    expect(inline.statusCode).toBe(200);
    expect(inline.headers["content-disposition"]).toBe('inline; filename="transcript.md"');
    expect(inline.body).toContain("A long line of speech.");

    const download = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/outputs/transcript.md?download=1`
    });
    expect(download.statusCode).toBe(200);
    expect(download.headers["content-disposition"]).toBe('attachment; filename="transcript.md"');
    expect(download.body).toContain("A long line of speech.");
  });

  it("keeps the output allowlist and missing-file behavior", async () => {
    const { app, sessionId } = await makeApp();
    const outside = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/outputs/session.json?download=1`
    });
    expect(outside.statusCode).toBe(404);

    const missing = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${sessionId}/outputs/chronology.md?download=1`
    });
    expect(missing.statusCode).toBe(404);
  });
});
