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

async function makeApp(rootOverride?: string, dashboardToken: string | null = null): Promise<TableRecordsApp> {
  const root = rootOverride ?? (await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-api-")));
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
    discordToken: null,
    dashboardToken
  });
  const app = new TableRecordsApp(config);
  if (previousLogLevel === undefined) delete process.env.LOG_LEVEL;
  else process.env.LOG_LEVEL = previousLogLevel;
  await app.init();
  apps.push(app);
  return app;
}

describe("HTTP API", () => {
  it("serves status and validates session, marker, and job requests", async () => {
    const app = await makeApp();
    const status = await app.fastify.inject({ method: "GET", url: "/api/status" });
    expect(status.statusCode).toBe(200);
    const snapshot = status.json() as { schema: string; bot: { state: string }; stt: { available: boolean } };
    expect(snapshot.schema).toBe("tablerecords.status/v1");
    expect(snapshot.bot.state).toBe("not_configured");
    expect(snapshot.stt.available).toBe(false);

    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: {
        title: "API Test Session",
        participants: [
          { discordUserId: "U1", discordName: "Alice", character: "Veyra" },
          { discordUserId: "U2", discordName: "GM", role: "gm" }
        ],
        consent: { confirmed: true, confirmedBy: "GM" }
      }
    });
    expect(created.statusCode).toBe(201);
    const detail = created.json() as {
      session: { sessionId: string; status: string };
      people: Array<{ personId: string; discordName: string }>;
    };
    expect(detail.session.status).toBe("draft");
    expect(detail.people.map((person) => person.discordName)).toEqual(["Alice", "GM"]);
    expect(new Set(detail.people.map((person) => person.personId)).size).toBe(2);

    const directory = await app.fastify.inject({ method: "GET", url: "/api/people" });
    expect(directory.statusCode).toBe(200);
    const people = directory.json().people as Array<{
      discordUserId: string | null;
      characters: string[];
      games: string[];
      appearances: Array<{ sessionId: string; campaign: string }>;
    }>;
    const alice = people.find((person) => person.discordUserId === "U1");
    expect(alice).toMatchObject({ characters: ["Veyra"], games: ["Unsorted"] });
    expect(alice?.appearances[0]).toMatchObject({ sessionId: detail.session.sessionId, campaign: "Unsorted" });
    expect(people.find((person) => person.discordUserId === "U2")?.characters).toEqual([]);

    const marker = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${detail.session.sessionId}/markers`,
      headers: { "content-type": "application/json" },
      payload: { kind: "scene", label: "Airlock" }
    });
    expect(marker.statusCode).toBe(201);
    expect(marker.json()).toMatchObject({ kind: "scene", label: "Airlock" });

    const mentalNote = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${detail.session.sessionId}/markers`,
      headers: { "content-type": "application/json" },
      payload: { kind: "scene", label: "Remember the hidden door", mentalNote: true }
    });
    expect(mentalNote.statusCode).toBe(201);
    expect(mentalNote.json()).toMatchObject({ kind: "note", label: "Remember the hidden door", mentalNote: true });

    const mergeSettings = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${detail.session.sessionId}/merge-settings`,
      headers: { "content-type": "application/json" },
      payload: { rollContextBeforeMs: 30_000, rollContextAfterMs: 15_000 }
    });
    expect(mergeSettings.statusCode).toBe(200);
    expect((mergeSettings.json() as { session: { merge: { rollContextBeforeMs: number; rollContextAfterMs: number } } }).session.merge).toMatchObject({
      rollContextBeforeMs: 30_000,
      rollContextAfterMs: 15_000
    });

    const startWithoutChannel = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${detail.session.sessionId}/start`,
      headers: { "content-type": "application/json" },
      payload: {}
    });
    expect(startWithoutChannel.statusCode).toBe(400);
    expect(startWithoutChannel.json()).toMatchObject({ error: { code: "channel_required" } });

    const badJob = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${detail.session.sessionId}/jobs`,
      headers: { "content-type": "application/json" },
      payload: { type: "bogus" }
    });
    expect(badJob.statusCode).toBe(400);
    expect(badJob.json()).toMatchObject({ error: { code: "invalid_type" } });

    const missingJob = await app.fastify.inject({ method: "GET", url: "/api/jobs/job_missing" });
    expect(missingJob.statusCode).toBe(404);
    expect(missingJob.json()).toMatchObject({ error: { code: "not_found" } });

    const joinWithoutBot = await app.fastify.inject({
      method: "POST",
      url: "/api/discord/join",
      headers: { "content-type": "application/json" },
      payload: { guildId: "g", channelId: "c" }
    });
    expect(joinWithoutBot.statusCode).toBe(409);
    expect(joinWithoutBot.json()).toMatchObject({ error: { code: "discord_not_ready" } });

    const configured = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: {
        title: "Configured Voice Session",
        guildId: "g",
        voiceChannelId: "c",
        consent: { confirmed: true }
      }
    });
    const configuredId = (configured.json() as { session: { sessionId: string } }).session.sessionId;
    const startWithoutBot = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${configuredId}/start`,
      headers: { "content-type": "application/json" },
      payload: {}
    });
    expect(startWithoutBot.statusCode).toBe(409);
    expect(startWithoutBot.json()).toMatchObject({ error: { code: "discord_not_ready" } });
  });

  it("accepts bodyless JSON commands and rejects cross-origin mutations", async () => {
    const app = await makeApp();
    const withOrigin = await app.fastify.inject({
      method: "POST",
      url: "/api/discord/leave",
      headers: { origin: "http://evil.example", "content-type": "application/json" }
    });
    expect(withOrigin.statusCode).toBe(403);
    const leave = await app.fastify.inject({
      method: "POST",
      url: "/api/discord/leave",
      headers: { origin: "http://127.0.0.1:17399", "content-type": "application/json" }
    });
    expect(leave.statusCode).toBe(200);
    expect((leave.json() as { bot: { state: string } }).bot.state).toBe("not_configured");
  });

  it("authenticates bridge recording controls and reports their state", async () => {
    const app = await makeApp();
    const settings = await app.fastify.inject({ method: "GET", url: "/api/settings" });
    const token = (settings.json() as { foundryBridge: { token: string } }).foundryBridge.token;
    expect(token).toBeTruthy();

    const unauthorized = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/control",
      headers: { "content-type": "application/json" },
      payload: { action: "status" }
    });
    expect(unauthorized.statusCode).toBe(401);

    const status = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/control",
      headers: { "content-type": "application/json", "x-tablerecords-token": token },
      payload: { action: "status" }
    });
    expect(status.statusCode).toBe(200);
    expect(status.json()).toMatchObject({ ok: true, state: "idle" });

    const pause = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/control",
      headers: { "content-type": "application/json", "x-tablerecords-token": token },
      payload: { action: "pause" }
    });
    expect(pause.statusCode).toBe(409);
    expect(pause.json()).toMatchObject({ error: { code: "no_session" } });
  });

  it("persists non-secret settings across an app restart", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-settings-"));
    const first = await makeApp(root);
    const updated = await first.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: {
        sttEngine: "faster-whisper",
        sttModel: "tiny.en",
        sttDevice: "cpu",
        sttComputeType: "int8",
        sttLanguage: "fr",
        sttBeamSize: 3,
        sttVadFilter: true,
        sttNoSpeechThreshold: 0.7,
        sttLogProbThreshold: -1.2,
        sttCompressionRatioThreshold: 2.8,
        sttPromptExtra: "French table",
        sttHotwordsExtra: "Harbor, Old Town",
        parakeetPath: "C:\\tools\\nemo-speech.exe",
        parakeetModel: "C:\\models\\parrot.gguf",
        parakeetDevice: "cpu",
        parakeetConcurrency: 2,
        discordBotName: "Scribblespark",
        discordActivityType: "listening",
        discordActivityText: "recording every adventure",
        discordActivityDynamic: false,
        rollContextBeforeMs: 25_000,
        rollContextAfterMs: 12_000,
        recentContextSeconds: 300
      }
    });
    expect(updated.statusCode).toBe(200);
    expect((updated.json() as { settings: { sttEngine: string } }).settings.sttEngine).toBe("faster-whisper");
    await first.close();
    apps.pop();

    const second = await makeApp(root);
    expect(second.config.sttEngine).toBe("faster-whisper");
    expect(second.config.sttModel).toBe("tiny.en");
    expect(second.config.sttDevice).toBe("cpu");
    expect(second.config.sttComputeType).toBe("int8");
    expect(second.config.sttLanguage).toBe("fr");
    expect(second.config.sttBeamSize).toBe(3);
    expect(second.config.sttVadFilter).toBe(true);
    expect(second.config.sttNoSpeechThreshold).toBe(0.7);
    expect(second.config.sttLogProbThreshold).toBe(-1.2);
    expect(second.config.sttCompressionRatioThreshold).toBe(2.8);
    expect(second.config.sttPromptExtra).toBe("French table");
    expect(second.config.sttHotwordsExtra).toBe("Harbor, Old Town");
    expect(second.config.parakeetConcurrency).toBe(2);
    expect(second.config.parakeetDevice).toBe("cpu");
    expect(second.config.discordBotName).toBe("Scribblespark");
    expect(second.config.discordActivityType).toBe("listening");
    expect(second.config.discordActivityText).toBe("recording every adventure");
    expect(second.config.discordActivityDynamic).toBe(false);
    expect(second.config.rollContextBeforeMs).toBe(25_000);
    expect(second.config.rollContextAfterMs).toBe(12_000);
    expect(second.config.recentContextSeconds).toBe(300);
    const settings = await second.fastify.inject({ method: "GET", url: "/api/settings" });
    expect((settings.json() as { settings: { sttModel: string; sttEngine: string; recentContextSeconds: number } }).settings).toMatchObject({
      sttModel: "tiny.en",
      sttEngine: "faster-whisper",
      recentContextSeconds: 300
    });
  });

  it("rejects an invalid settings payload without saving earlier fields", async () => {
    const app = await makeApp();
    const before = await app.fastify.inject({ method: "GET", url: "/api/settings" });
    const originalModel = (before.json() as { settings: { sttModel: string } }).settings.sttModel;
    const invalid = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { sttModel: "tiny.en", sttDevice: "gpu" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_device" } });
    const settings = await app.fastify.inject({ method: "GET", url: "/api/settings" });
    expect((settings.json() as { settings: { sttModel: string } }).settings.sttModel).toBe(originalModel);
  });

  it("archives and deletes a session with an explicit confirmation", async () => {
    const app = await makeApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: { title: "Archive API", participants: [], consent: { confirmed: true } }
    });
    const sessionId = (created.json() as { session: { sessionId: string } }).session.sessionId;
    const archived = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/archive`,
      headers: { "content-type": "application/json" },
      payload: { archived: true }
    });
    expect(archived.statusCode).toBe(200);
    expect(archived.json()).toMatchObject({ session: { archived: true } });

    const unconfirmed = await app.fastify.inject({ method: "DELETE", url: `/api/sessions/${sessionId}` });
    expect(unconfirmed.statusCode).toBe(409);
    expect(unconfirmed.json()).toMatchObject({ error: { code: "confirmation_required" } });

    const deleted = await app.fastify.inject({
      method: "DELETE",
      url: `/api/sessions/${sessionId}?confirm=${encodeURIComponent(sessionId)}`
    });
    expect(deleted.statusCode).toBe(204);
    const missing = await app.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    expect(missing.statusCode).toBe(404);
  });

  it("gates API routes behind the optional dashboard cookie", async () => {
    const app = await makeApp(undefined, "secret-token");
    const unauthorized = await app.fastify.inject({ method: "GET", url: "/api/status" });
    expect(unauthorized.statusCode).toBe(401);

    const bad = await app.fastify.inject({
      method: "POST",
      url: "/api/auth",
      headers: { "content-type": "application/json" },
      payload: { token: "wrong" }
    });
    expect(bad.statusCode).toBe(401);

    const auth = await app.fastify.inject({
      method: "POST",
      url: "/api/auth",
      headers: { "content-type": "application/json" },
      payload: { token: "secret-token" }
    });
    expect(auth.statusCode).toBe(204);
    const setCookie = auth.headers["set-cookie"];
    expect(setCookie).toBeTruthy();
    const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie).split(";")[0]!;

    const authorized = await app.fastify.inject({ method: "GET", url: "/api/status", headers: { cookie } });
    expect(authorized.statusCode).toBe(200);
  });
});

