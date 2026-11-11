import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { sessionCampaign } from "../src/core/campaign.js";

const roots: string[] = [];
const stores: Store[] = [];

afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

describe("session campaigns", () => {
  it("stores an explicit game label and falls back to the world or Unsorted", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-campaign-"));
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
    const world = {
      id: "swffg-cartel",
      title: "Demo Cartel",
      system: "starwarsffg",
      systemVersion: "2.0",
      foundryVersion: "14.369",
      path: ""
    };
    const explicit = await manager.create({ title: "Cartel 6", campaign: "Cartel", world, participants: [], consent: { confirmed: true } });
    expect(explicit.campaign).toBe("Cartel");
    const derived = await manager.create({ title: "Cartel 7", world, participants: [], consent: { confirmed: true } });
    expect(derived.campaign).toBe("Demo Cartel");
    const unsorted = await manager.create({ title: "One shot", participants: [], consent: { confirmed: true } });
    expect(unsorted.campaign).toBe("Unsorted");
    expect(sessionCampaign({ campaign: "  Cartel  ", world: { id: "w", title: "World" } })).toBe("Cartel");
    expect(sessionCampaign({ world: { id: "w", title: "World" } })).toBe("World");
    expect(sessionCampaign({ world: { id: "unknown", title: "Unknown World" } })).toBe("Unsorted");
  });
});

