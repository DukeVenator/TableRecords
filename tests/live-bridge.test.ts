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
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-live-"));
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
    foundryBridgeToken: "test-bridge-token",
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

async function createRecordingSession(app: TableRecordsApp): Promise<string> {
  const created = await app.fastify.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "content-type": "application/json" },
    payload: {
      title: "Live Bridge Test",
      participants: [{ discordUserId: "U1", discordName: "Alice", character: "Veyra" }],
      consent: { confirmed: true, confirmedBy: "GM" }
    }
  });
  const sessionId = (created.json() as { session: { sessionId: string } }).session.sessionId;
  const session = await app.sessions.get(sessionId);
  await app.sessions.setStatus(session, "recording", { startedAtMs: Date.now() - 60_000, stoppedAtMs: null });
  return sessionId;
}

async function createFinalizedSession(app: TableRecordsApp): Promise<string> {
  const session = await app.sessions.create({
    title: "Finalized Live Test",
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
  await app.sessions.setStatus(session, "ready", { startedAtMs: now - 60_000, stoppedAtMs: now });
  return session.sessionId;
}

function message(id: string, timestampMs: number): Record<string, unknown> {
  return {
    messageId: id,
    timestampMs,
    author: { id: "F_ALICE", name: "Alice" },
    speaker: { scene: "s1", token: "t1", actor: "A1", alias: "Veyra Sol" },
    speakerName: "Veyra Sol",
    actorId: "A1",
    actorName: "Veyra Sol",
    tokenName: "Veyra Sol",
    flavor: "Blaster attack",
    content: "<p>Blaster attack</p>",
    whisper: [],
    blind: false,
    rolls: [
      {
        class: "RollFFG",
        formula: "2eP+1eA",
        total: 0,
        ffg: { success: 2, failure: 0, advantage: 1, threat: 0, triumph: 1, despair: 0, light: 0, dark: 0 }
      }
    ]
  };
}

describe("Foundry live bridge", () => {
  it("is gated, accepts token-authenticated messages, deduplicates, and creates live markers", async () => {
    const { app } = await makeApp();    const sessionId = await createRecordingSession(app);
    const settings = await app.fastify.inject({ method: "GET", url: "/api/settings" });
    const bridge = (settings.json() as { foundryBridge: { token: string } }).foundryBridge;
    expect(bridge.token).toBe("test-bridge-token");

    const disabled = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: { schema: "tablerecords.foundry-live/v1" }
    });
    expect(disabled.statusCode).toBe(403);
    expect(disabled.json()).toMatchObject({ error: { code: "live_disabled" } });

    const enabled = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { foundryLiveEnabled: true, foundryLiveMarkers: true, recentContextSeconds: 240 }
    });
    expect(enabled.statusCode).toBe(200);
    expect(enabled.json()).toMatchObject({ settings: { recentContextSeconds: 240 }, foundryBridge: { status: { enabled: true } } });

    const preflight = await app.fastify.inject({
      method: "OPTIONS",
      url: "/api/foundry/live",
      headers: { origin: "http://localhost:30000", "access-control-request-headers": "content-type,x-tablerecords-token" }
    });
    expect(preflight.statusCode).toBe(204);
    expect(preflight.headers["access-control-allow-origin"]).toBe("*");

    const commandsNoToken = await app.fastify.inject({ method: "GET", url: "/api/foundry/commands" });
    expect(commandsNoToken.statusCode).toBe(401);
    const commands = await app.fastify.inject({
      method: "GET",
      url: "/api/foundry/commands",
      headers: { origin: "http://localhost:30000", "x-tablerecords-token": bridge.token }
    });
    expect(commands.statusCode).toBe(200);
    expect(commands.json()).toMatchObject({ commands: [] });
    expect(commands.headers["access-control-allow-origin"]).toBe("*");

    const badToken = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { origin: "http://localhost:30000", "content-type": "application/json", "x-tablerecords-token": "wrong" },
      payload: { schema: "tablerecords.foundry-live/v1" }
    });
    expect(badToken.statusCode).toBe(401);
    expect(badToken.headers["access-control-allow-origin"]).toBe("*");

    const firstHeartbeat = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        moduleVersion: "0.1.0",
        foundryVersion: "14.369",
        world: { id: "swffg-cartel", title: "Cartel" },
        system: { id: "starwarsffg", version: "2.0" },
        messages: [],
        state: { scene: { id: "s1", name: "Cantina" }, combat: null, paused: false }
      }
    });
    expect(firstHeartbeat.statusCode).toBe(200);
    expect(firstHeartbeat.json()).toMatchObject({ accepted: true, sessionId });

    const now = Date.now();
    const live = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        messages: [message("msg_live_1", now)],
        roster: {
          users: [{ id: "F_ALICE", name: "Alice", isGM: false, characterId: "A1", characterName: "Veyra Sol" }],
          actors: [{ id: "A1", name: "Veyra Sol", type: "character", hasPlayerOwner: true }]
        },
        state: { scene: { id: "s2", name: "Docking Bay" }, combat: { id: "c1", name: "Hangar fight", round: 1, active: true }, paused: false }
      }
    });
    expect(live.statusCode).toBe(200);
    expect(live.json()).toMatchObject({ accepted: true, acceptedMessages: 1, duplicateMessages: 0, sessionId });

    const duplicate = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: { schema: "tablerecords.foundry-live/v1", messages: [message("msg_live_1", now)] }
    });
    expect(duplicate.statusCode).toBe(200);
    expect(duplicate.json()).toMatchObject({ acceptedMessages: 0, duplicateMessages: 1 });

    const note = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: { schema: "tablerecords.foundry-live/v1", note: "The crime lord owes us a favour" }
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ accepted: true, noteAccepted: true });

    const breakStartedAtMs = now - 59_000;
    const breakStarted = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        events: [
          {
            eventId: "break-start-1",
            kind: "break",
            phase: "start",
            atMs: breakStartedAtMs,
            actor: { id: "gm", name: "Gamemaster" }
          }
        ]
      }
    });
    expect(breakStarted.statusCode).toBe(200);
    expect(breakStarted.json()).toMatchObject({ accepted: true, eventsAccepted: 1 });

    const breakStartedAgain = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        events: [
          {
            eventId: "break-start-1",
            kind: "break",
            phase: "start",
            atMs: breakStartedAtMs,
            actor: { id: "gm", name: "Gamemaster" }
          }
        ]
      }
    });
    expect(breakStartedAgain.statusCode).toBe(200);
    expect(breakStartedAgain.json()).toMatchObject({ eventsAccepted: 0 });

    const breakEnded = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        events: [
          {
            eventId: "break-end-1",
            kind: "break",
            phase: "end",
            atMs: now,
            startedAtMs: breakStartedAtMs,
            actor: { id: "gm", name: "Gamemaster" }
          }
        ]
      }
    });
    expect(breakEnded.statusCode).toBe(200);
    expect(breakEnded.json()).toMatchObject({ accepted: true, eventsAccepted: 1 });

    const breakEndedAgain = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        events: [
          {
            eventId: "break-end-1",
            kind: "break",
            phase: "end",
            atMs: now,
            startedAtMs: breakStartedAtMs,
            actor: { id: "gm", name: "Gamemaster" }
          }
        ]
      }
    });
    expect(breakEndedAgain.statusCode).toBe(200);
    expect(breakEndedAgain.json()).toMatchObject({ eventsAccepted: 0 });

    const combatEnded = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        state: { scene: { id: "s2", name: "Docking Bay" }, combat: { id: "c1", name: "Hangar fight", round: 3, active: false }, paused: false }
      }
    });
    expect(combatEnded.statusCode).toBe(200);
    const combatEndedAgain = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": bridge.token },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        state: { scene: { id: "s2", name: "Docking Bay" }, combat: { id: "c1", name: "Hangar fight", round: 3, active: false }, paused: false }
      }
    });
    expect(combatEndedAgain.statusCode).toBe(200);

    const detail = await app.fastify.inject({ method: "GET", url: `/api/sessions/${sessionId}` });
    const body = detail.json() as {
      counts: { foundryEvents: number };
      markers: Array<{ kind: string; label: string; mentalNote?: boolean }>;
      foundryLive: {
        messageCount: number;
        scene: { name: string };
        combat: { name: string };
        roster: { users: Array<{ id: string; characterName: string }>; actors: Array<{ name: string }> };
      };
    };
    expect(body.counts.foundryEvents).toBe(1);
    expect(body.foundryLive.messageCount).toBe(1);
    expect(body.foundryLive.scene.name).toBe("Docking Bay");
    expect(body.foundryLive.combat.name).toBe("Hangar fight");
    expect(body.foundryLive.roster.users[0]).toMatchObject({ id: "F_ALICE", characterName: "Veyra Sol" });
    expect(body.foundryLive.roster.actors[0]?.name).toBe("Veyra Sol");
    expect(body.markers.some((marker) => marker.kind === "scene" && marker.label === "Foundry scene: Docking Bay")).toBe(true);
    expect(body.markers.some((marker) => marker.kind === "scene" && marker.label === "Foundry scene: Cantina")).toBe(true);
    expect(body.markers.some((marker) => marker.kind === "combat" && marker.label.includes("Hangar fight"))).toBe(true);
    expect(body.markers.filter((marker) => marker.kind === "combat" && marker.label === "Combat ended: Hangar fight")).toHaveLength(1);
    expect(body.markers.some((marker) => marker.mentalNote && marker.label === "The crime lord owes us a favour")).toBe(true);
    expect(body.markers.some((marker) => marker.kind === "break" && marker.label === "Break time called by Gamemaster")).toBe(true);
    expect(body.markers.some((marker) => marker.kind === "break" && marker.label === "Break time over after 1 minute")).toBe(true);
    expect(body.markers.filter((marker) => marker.kind === "break" && marker.label.startsWith("Break time over"))).toHaveLength(1);

    const liveEvents = await fsp.readFile(path.join(app.sessions.sessionDir(sessionId), "foundry", "live-events.jsonl"), "utf8");
    expect(liveEvents).toContain("msg_live_1");
    expect(liveEvents.match(/msg_live_1/g)).toHaveLength(1);
  });

  it("records Foundry consent prompt and opt-out responses on the session", async () => {
    const { app } = await makeApp();
    const created = await app.fastify.inject({
      method: "POST",
      url: "/api/sessions",
      headers: { "content-type": "application/json" },
      payload: {
        title: "Consent Bridge Test",
        participants: [{ discordUserId: "U1", discordName: "Alice", character: "Veyra" }],
        consent: { confirmed: false }
      }
    });
    const sessionId = (created.json() as { session: { sessionId: string } }).session.sessionId;
    const firstDetail = await app.sessions.detail(sessionId);
    await app.sessions.updatePeople(sessionId, [
      {
        ...firstDetail.people[0]!,
        foundryUserId: "F_ALICE",
        foundryUserName: "Alice"
      }
    ]);
    await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { foundryLiveEnabled: true }
    });
    const settings = (await app.fastify.inject({ method: "GET", url: "/api/settings" })).json() as {
      foundryBridge: { token: string };
    };
    const postConsent = (optOut: boolean, promptSent = false) =>
      app.fastify.inject({
        method: "POST",
        url: "/api/foundry/live",
        headers: { "content-type": "application/json", "x-tablerecords-token": settings.foundryBridge.token },
        payload: {
          schema: "tablerecords.foundry-live/v1",
          world: { id: "unknown", title: "Unknown" },
          system: { id: "generic", version: null },
          sessionId,
          consent: {
            noticeVersion: "2026-11-01",
            promptSent,
            responses: [{ foundryUserId: "F_ALICE", foundryUserName: "Alice", optOut }]
          }
        }
      });

    const optedOut = await postConsent(true, true);
    expect(optedOut.statusCode).toBe(200);
    expect(optedOut.json()).toMatchObject({
      consentAccepted: true,
      consentResponses: 1,
      consentSessionId: sessionId
    });
    const detail = await app.sessions.detail(sessionId);
    expect(detail.session.consent.promptedAtMs).toBeTypeOf("number");
    expect(detail.people[0]?.consentStatus).toBe("opted_out");
    expect(detail.people[0]?.consent).toBe(false);
    const consentRecord = await fsp.readFile(path.join(app.sessions.sessionDir(sessionId), "consent.md"), "utf8");
    expect(consentRecord).toContain("did not want to be recorded");

    const backIn = await postConsent(false);
    expect(backIn.statusCode).toBe(200);
    const refreshed = await app.sessions.detail(sessionId);
    expect(refreshed.people[0]?.consentStatus).toBe("opted_in");
    expect(refreshed.people[0]?.consent).toBe(true);

    const start = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${sessionId}/start`
    });
    expect(start.statusCode).toBe(400);
    const afterStart = await app.sessions.detail(sessionId);
    expect(afterStart.session.consent.confirmed).toBe(true);
    expect(afterStart.session.consent.method).toBe("foundry");
  });

  it("follows only active recordings unless an explicit session id is supplied", async () => {
    const { app } = await makeApp();
    const sessionId = await createFinalizedSession(app);
    const enabled = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { foundryLiveEnabled: true, foundryLiveMarkers: true }
    });
    expect(enabled.statusCode).toBe(200);

    const now = Date.now();
    const untargeted = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": "test-bridge-token" },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        messages: [message("late-without-target", now - 1000)],
        note: "this should not attach to the old session"
      }
    });
    expect(untargeted.statusCode).toBe(200);
    expect(untargeted.json()).toMatchObject({
      accepted: true,
      acceptedMessages: 0,
      noteAccepted: false,
      sessionId: null,
      reason: "no_active_session"
    });
    const untargetedDetail = await app.sessions.detail(sessionId);
    expect(untargetedDetail.markers).toHaveLength(0);

    const targeted = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": "test-bridge-token" },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        sessionId,
        world: { id: "world-a", title: "World A" },
        system: { id: "system-a", version: "1.0" },
        messages: [message("late-with-target", now - 500)]
      }
    });
    expect(targeted.statusCode).toBe(200);
    expect(targeted.json()).toMatchObject({ accepted: true, acceptedMessages: 1, sessionId });

    const longNote = "n".repeat(300);
    const note = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": "test-bridge-token" },
      payload: { schema: "tablerecords.foundry-live/v1", sessionId, note: longNote }
    });
    expect(note.statusCode).toBe(200);
    expect(note.json()).toMatchObject({ accepted: true, noteAccepted: true });
    const targetedDetail = await app.sessions.detail(sessionId);
    expect(targetedDetail.markers.some((marker) => marker.mentalNote && marker.label === longNote)).toBe(true);

    const mismatch = await app.fastify.inject({
      method: "POST",
      url: "/api/foundry/live",
      headers: { "content-type": "application/json", "x-tablerecords-token": "test-bridge-token" },
      payload: {
        schema: "tablerecords.foundry-live/v1",
        sessionId,
        world: { id: "world-b", title: "Wrong World" },
        system: { id: "system-a", version: "1.0" }
      }
    });
    expect(mismatch.statusCode).toBe(409);
    expect(mismatch.json()).toMatchObject({ error: { code: "world_mismatch" } });
  });

  it("serializes concurrent live posts so one event is written once", async () => {
    const { app } = await makeApp();
    const sessionId = await createRecordingSession(app);
    await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { foundryLiveEnabled: true, foundryLiveMarkers: true }
    });
    const payload = {
      schema: "tablerecords.foundry-live/v1",
      messages: [message("race-event", Date.now() - 1000)]
    };
    const [first, second] = await Promise.all([
      app.fastify.inject({
        method: "POST",
        url: "/api/foundry/live",
        headers: { "content-type": "application/json", "x-tablerecords-token": "test-bridge-token" },
        payload
      }),
      app.fastify.inject({
        method: "POST",
        url: "/api/foundry/live",
        headers: { "content-type": "application/json", "x-tablerecords-token": "test-bridge-token" },
        payload
      })
    ]);
    expect(first.statusCode).toBe(200);
    expect(second.statusCode).toBe(200);
    const liveFile = path.join(app.sessions.sessionDir(sessionId), "foundry", "live-events.jsonl");
    const lines = (await fsp.readFile(liveFile, "utf8")).trim().split(/\r?\n/).filter(Boolean);
    expect(lines).toHaveLength(1);
  });

  it("installs the optional module only under the configured Foundry data path", async () => {
    const { app, root } = await makeApp();
    await fsp.cp(path.join(process.cwd(), "foundry-module"), path.join(root, "foundry-module"), { recursive: true });
    const foundryRoot = path.join(root, "foundry");
    await fsp.mkdir(path.join(foundryRoot, "Data", "worlds"), { recursive: true });
    const saved = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { foundryDataPath: foundryRoot }
    });
    expect(saved.statusCode).toBe(200);

    const installed = await app.fastify.inject({ method: "POST", url: "/api/foundry/module/install" });
    expect(installed.statusCode).toBe(200);
    const body = installed.json() as { installedTo: string; modulesDir: string };
    expect(body.installedTo).toBe(path.join(foundryRoot, "Data", "modules", "table-records-bridge"));
    await expect(fsp.access(path.join(body.installedTo, "module.json"))).resolves.toBeUndefined();
    await expect(fsp.access(path.join(body.installedTo, "scripts", "main.js"))).resolves.toBeUndefined();
  });
});
