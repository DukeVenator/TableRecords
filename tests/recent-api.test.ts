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

async function makeApp(): Promise<{ app: TableRecordsApp; root: string }> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-recent-"));
  await fsp.mkdir(path.join(root, "python"), { recursive: true });
  const fakePython = `const fs = require("node:fs");
const args = process.argv.slice(2);
const value = (name) => args[args.indexOf(name) + 1];
const jobs = fs.readFileSync(value("--jobs"), "utf8").split(/\\r?\\n/).filter(Boolean).map((line) => JSON.parse(line));
const out = jobs.map((job) => JSON.stringify({
  schema: "tablerecords.transcript/v1",
  sessionId: job.sessionId,
  utteranceId: job.utteranceId,
  sttJobId: job.sttJobId,
  batchJobId: job.batchJobId,
  discordUserId: job.discordUserId,
  speaker: job.speakerLabel,
  character: job.character,
  text: "Hello from the fake STT.",
  rawText: "Hello from the fake STT.",
  corrections: [],
  startMs: job.startMs,
  endMs: job.endMs,
  words: [],
  stt: { engine: "fake", engineVersion: "1", model: job.model, device: job.device, computeType: job.computeType, language: "en", languageProbability: 1, avgLogprob: -0.1, noSpeechProb: 0.01 },
  flags: [],
  createdAtMs: Date.now()
}));
fs.writeFileSync(value("--out"), out.join("\\n") + (out.length ? "\\n" : ""));
fs.writeFileSync(value("--errors"), "");
console.log(JSON.stringify({ type: "start", total: jobs.length, device: "cpu", computeType: "int8" }));
for (let index = 0; index < jobs.length; index += 1) console.log(JSON.stringify({ type: "progress", done: index + 1, total: jobs.length }));
console.log(JSON.stringify({ type: "done", written: jobs.length, errors: 0 }));
`;
  await fsp.writeFile(path.join(root, "python", "transcribe_jobs.py"), fakePython, "utf8");
  const previous = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "silent";
  const config = loadConfig({
    projectRoot: root,
    dataDir: path.join(root, "data"),
    sessionsDir: path.join(root, "sessions"),
    modelsDir: path.join(root, "models"),
    port: 17399,
    pythonPath: process.execPath,
    sttEngine: "faster-whisper",
    foundryDataPath: null,
    discordToken: null,
    dashboardToken: null
  });
  if (previous === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previous;
  const app = new TableRecordsApp(config);
  if (previous === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previous;
  await app.init();
  apps.push(app);
  return { app, root };
}

describe("recent context API", () => {
  it("builds a copyable GM brief and transcribes only missing recent utterances", async () => {
    const { app } = await makeApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: {
        title: "Recent API Test",
        participants: [{ discordUserId: "U1", discordName: "Alice", character: "Veyra" }],
        consent: { confirmed: true, confirmedBy: "GM" }
      }
    });
    const sessionId = (created.json() as { session: { sessionId: string } }).session.sessionId;
    const session = await app.sessions.get(sessionId);
    const now = Date.now();
    const dir = app.sessions.sessionDir(sessionId);
    await fsp.mkdir(path.join(dir, "discord", "audio", "U1"), { recursive: true });
    await fsp.writeFile(path.join(dir, "discord", "audio", "U1", "u_recent.wav"), "fake wav");
    await fsp.writeFile(
      path.join(dir, "discord", "manifest.jsonl"),
      `${JSON.stringify({
        schema: "tablerecords.discord-utterance/v1",
        sessionId,
        utteranceId: "u_recent",
        discordUserId: "U1",
        displayName: "Alice",
        file: "discord/audio/U1/u_recent.wav",
        startMs: now - 8_000,
        endMs: now - 6_500,
        durationMs: 1500,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: 8,
        streamEnd: "silence",
        decryptionFailures: 0,
        createdAtMs: now
      })}\n`,
      "utf8"
    );
    await app.sessions.setStatus(session, "captured", { startedAtMs: now - 60_000, stoppedAtMs: now });

    const claimed = app.jobs.tryClaimTranscription(sessionId);
    expect(claimed).not.toBeNull();
    const blocked = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/context/recent`,
      headers: { "content-type": "application/json" },
      payload: { windowSeconds: 180, transcribe: true }
    });
    expect(blocked.statusCode).toBe(409);
    expect(blocked.json()).toMatchObject({ error: { code: "transcription_active" } });
    claimed?.();

    const result = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/context/recent`,
      headers: { "content-type": "application/json" },
      payload: { windowSeconds: 180, transcribe: true }
    });
    expect(result.statusCode).toBe(200);
    const body = result.json() as {
      markdown: string;
      counts: { speech: number; rolls: number };
      transcription: { transcribed: number; failed: number };
    };
    expect(body.transcription.transcribed).toBe(1);
    expect(body.transcription.failed).toBe(0);
    expect(body.counts.speech).toBe(1);
    expect(body.markdown).toContain("Recent API Test");
    expect(body.markdown).toContain("Hello from the fake STT.");
    expect(body.markdown).toContain("Facts only");

    const transcript = await fsp.readFile(path.join(dir, "stt", "transcript.jsonl"), "utf8");
    expect(transcript).toContain("u_recent");

    const second = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/context/recent`,
      headers: { "content-type": "application/json" },
      payload: { windowSeconds: 180, transcribe: true }
    });
    expect(second.statusCode).toBe(200);
    expect((second.json() as { transcription: { transcribed: number; alreadyPresent: number } }).transcription).toMatchObject({
      transcribed: 0,
      alreadyPresent: 1
    });
  });
});
