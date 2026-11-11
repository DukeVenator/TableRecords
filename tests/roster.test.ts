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

async function makeApp(): Promise<TableRecordsApp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-roster-"));
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
  const app = new TableRecordsApp(config);
  await app.init();
  apps.push(app);
  return app;
}

async function createSession(app: TableRecordsApp, character: string) {
  const response = await app.fastify.inject({
    method: "POST",
    url: "/api/sessions",
    headers: { "content-type": "application/json" },
    payload: {
      title: "Roster Test",
      participants: [{ discordUserId: "U1", discordName: "Alice", character, role: "player" }],
      consent: { confirmed: true, confirmedBy: "GM" }
    }
  });
  expect(response.statusCode).toBe(201);
  return response.json() as { session: { sessionId: string; world: { id: string } }; people: Array<{ personId: string; character: string }> };
}

describe("people roster", () => {
  it("reuses a player mapping across sessions and updates the roster on save", async () => {
    const app = await makeApp();
    const first = await createSession(app, "Veyra");
    const second = await createSession(app, "Veyra Sol");

    const roster = await app.fastify.inject({ method: "GET", url: `/api/people/roster?worldId=${first.session.world.id}` });
    expect(roster.statusCode).toBe(200);
    const profiles = (roster.json() as { profiles: Array<{ discordUserId: string; character: string; profileId: string }> }).profiles;
    expect(profiles).toHaveLength(1);
    expect(profiles[0]).toMatchObject({ discordUserId: "U1", character: "Veyra Sol" });

    const updated = await app.fastify.inject({
      method: "PUT",
      url: `/api/sessions/${second.session.sessionId}/people`,
      headers: { "content-type": "application/json" },
      payload: {
        people: [
          {
            personId: second.people[0]!.personId,
            role: "player",
            discordUserId: "U1",
            discordName: "Alice",
            foundryUserId: "F1",
            foundryUserName: "Alice F",
            character: "Veyra Prime",
            aliases: ["Vey"],
            consent: true
          }
        ]
      }
    });
    expect(updated.statusCode).toBe(200);
    const after = await app.fastify.inject({ method: "GET", url: `/api/people/roster?worldId=${first.session.world.id}` });
    expect((after.json() as { profiles: Array<{ character: string; foundryUserId: string }> }).profiles[0]).toMatchObject({
      character: "Veyra Prime",
      foundryUserId: "F1"
    });

    const original = await app.fastify.inject({ method: "GET", url: `/api/sessions/${first.session.sessionId}` });
    expect((original.json() as { people: Array<{ character: string }> }).people[0]!.character).toBe("Veyra");
  });
});
