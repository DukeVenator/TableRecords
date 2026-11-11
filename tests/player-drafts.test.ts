import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { TableRecordsApp } from "../src/server/app.js";
import { buildPlayerBrief, playerDraftPrompt } from "../src/server/playerDrafts.js";
import type { FoundryEvent, SessionRecord, TranscriptRecord } from "../src/core/types.js";

const apps: TableRecordsApp[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close().catch(() => undefined);
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

const session = {
  sessionId: "session-1",
  title: "Cantina Job",
  timeZone: "UTC"
} as unknown as SessionRecord;

function transcript(id: string, userId: string, startMs: number, text: string): TranscriptRecord {
  return {
    schema: "tablerecords.transcript/v1",
    sessionId: "session-1",
    utteranceId: id,
    sttJobId: `stt-${id}`,
    batchJobId: "batch",
    discordUserId: userId,
    speaker: userId === "opt" ? "Opted Out" : "Veyra",
    character: "Veyra",
    text,
    rawText: text,
    corrections: [],
    startMs,
    endMs: startMs + 1000,
    words: [],
    stt: {
      engine: "fake",
      engineVersion: "1",
      model: "fake",
      device: "cpu",
      computeType: "int8",
      language: "en",
      languageProbability: 1,
      avgLogprob: -0.1,
      noSpeechProb: 0
    },
    flags: [],
    createdAtMs: Date.now()
  };
}

function event(
  eventId: string,
  type: "chat" | "roll",
  timestampMs: number,
  contentText: string,
  options: { whisper?: string[]; blind?: boolean; playerPost?: boolean } = {}
): FoundryEvent {
  return {
    schema: "tablerecords.foundry-event/v1",
    sessionId: "session-1",
    eventId,
    type,
    timestampMs,
    author: { id: "u1", name: "Alice" },
    speaker: { alias: "Veyra", actorId: "a1", actorName: "Veyra", tokenName: null },
    system: "system-a",
    systemVersion: "1.0",
    flavor: null,
    contentText,
    visibility: { whisper: options.whisper ?? [], blind: options.blind ?? false },
    flags: options.playerPost ? { "table-records-bridge": { playerPost: true } } : {},
    rolls: [],
    source: { kind: "module", file: "foundry/live-events.jsonl" }
  };
}

describe("player-facing draft source", () => {
  it("includes only public speech and events, and excludes opted-out players", () => {
    const brief = buildPlayerBrief({
      session,
      transcripts: [
        transcript("t1", "u1", Date.now() - 30_000, "The docking code is blue."),
        transcript("t2", "opt", Date.now() - 20_000, "Private opt-out words.")
      ],
      events: [
        event("e1", "chat", Date.now() - 15_000, "Public clue"),
        event("e2", "chat", Date.now() - 14_000, "Whispered secret", { whisper: ["gm"] }),
        event("e3", "roll", Date.now() - 13_000, "Hidden roll", { blind: true }),
        event("e4", "chat", Date.now() - 12_000, "Old recap", { playerPost: true }),
        event("e5", "roll", Date.now() - 11_000, "Public roll")
      ],
      people: [{ discordUserId: "opt", role: "player", consentStatus: "opted_out" } as never],
      startMs: Date.now() - 180_000,
      endMs: Date.now(),
      windowLabel: "last 3 min",
      missingTranscripts: 0
    });
    expect(brief.markdown).toContain("The docking code is blue.");
    expect(brief.markdown).toContain("Public clue");
    expect(brief.markdown).toContain("Public roll");
    expect(brief.markdown).not.toContain("Private opt-out words");
    expect(brief.markdown).not.toContain("Whispered secret");
    expect(brief.markdown).not.toContain("Hidden roll");
    expect(brief.markdown).not.toContain("Old recap");
    expect(brief.counts).toMatchObject({ speech: 1, chat: 1, rolls: 1 });
  });

  it("uses player-safe prompts for each draft kind", () => {
    const names = playerDraftPrompt("names", "Veyra met the contact.");
    const clues = playerDraftPrompt("clues", "The door is locked.");
    expect(names.system).toContain("Never reveal or infer GM-only notes");
    expect(names.system).toContain("List only names");
    expect(clues.system).toContain("Do not solve the mystery");
    expect(names.user).toContain("<public-record>");
  });
});

async function makeApp(): Promise<TableRecordsApp> {
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { content: "## Recap\n\nA quiet cantina." } }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("test server has no port");
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-player-drafts-"));
  const previousLogLevel = process.env.LOG_LEVEL;
  process.env.LOG_LEVEL = "silent";
  const config = loadConfig({
    projectRoot: root,
    dataDir: path.join(root, "data"),
    sessionsDir: path.join(root, "sessions"),
    modelsDir: path.join(root, "models"),
    port: 17399,
    pythonPath: path.join(root, "missing-python.exe"),
    foundryDataPath: null,
    foundryBridgeToken: "test-bridge-token",
    discordToken: null,
    dashboardToken: null,
    llmEnabled: true,
    llmProvider: "local",
    llmBaseUrl: `http://127.0.0.1:${address.port}/v1`,
    llmModel: "stub-model"
  });
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
  const app = new TableRecordsApp(config);
  await app.init();
  apps.push(app);
  return app;
}

describe("player draft API", () => {
  it("rejects missing tokens and returns a GM-reviewable draft from public source", async () => {
    const app = await makeApp();
    const sessionRecord = await app.sessions.create({
      title: "Cantina Job",
      world: {
        id: "world-a",
        title: "World A",
        system: "system-a",
        systemVersion: "1.0",
        foundryVersion: "14.369.0",
        path: ""
      },
      participants: [],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const now = Date.now();
    await app.sessions.setStatus(sessionRecord, "recording", { startedAtMs: now - 300_000, stoppedAtMs: null });
    const dir = app.sessions.sessionDir(sessionRecord.sessionId);
    await fsp.mkdir(path.join(dir, "stt"), { recursive: true });
    await fsp.mkdir(path.join(dir, "foundry"), { recursive: true });
    await fsp.writeFile(
      path.join(dir, "stt", "transcript.jsonl"),
      [
        transcript("t1", "u1", now - 30_000, "The docking code is blue."),
        transcript("t2", "u1", now - 20_000, "the contact wants the manifest.")
      ].map((record) => JSON.stringify(record)).join("\n") + "\n"
    );
    await fsp.writeFile(
      path.join(dir, "foundry", "live-events.jsonl"),
      [event("e1", "chat", now - 15_000, "Public clue")].map((item) => JSON.stringify(item)).join("\n") + "\n"
    );
    await fsp.writeFile(path.join(dir, "people.json"), JSON.stringify({ schema: "tablerecords.people/v1", people: [] }));

    const disabled = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/player-drafts",
      headers: { "content-type": "application/json" },
      payload: { world: { id: "world-a" }, kind: "recap", windowSeconds: 180 }
    });
    expect(disabled.statusCode).toBe(403);

    const enabled = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { foundryLiveEnabled: true }
    });
    expect(enabled.statusCode).toBe(200);
    const token = (enabled.json() as { foundryBridge: { token: string } }).foundryBridge.token;

    const preflight = await app.fastify.inject({
      method: "OPTIONS",
      url: "/api/foundry/player-drafts",
      headers: { origin: "http://localhost:30000" }
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");

    const noToken = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/player-drafts",
      headers: { "content-type": "application/json" },
      payload: { world: { id: "world-a" }, kind: "recap", windowSeconds: 180 }
    });
    expect(noToken.statusCode).toBe(401);

    const result = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/player-drafts",
      headers: { "content-type": "application/json", "x-tablerecords-token": token },
      payload: { world: { id: "world-a" }, kind: "recap", windowSeconds: 180, transcribe: false, endMs: now }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      schema: "tablerecords.player-draft/v1",
      kind: "recap",
      text: "## Recap\n\nA quiet cantina.",
      provider: "local",
      model: "stub-model",
      counts: { speech: 2, chat: 1, rolls: 0 }
    });
  });
});


