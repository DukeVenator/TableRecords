import { describe, expect, it } from "vitest";
import os from "node:os";
import path from "node:path";
import fsp from "node:fs/promises";
import { resolveInside, PathSafetyError } from "../src/core/paths.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";

describe("path safety", () => {
  it("rejects traversal and absolute paths under the session root", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-paths-"));
    expect(() => resolveInside(root, "../outside.wav")).toThrow(PathSafetyError);
    expect(() => resolveInside(root, "C:\\Windows\\system.ini")).toThrow(PathSafetyError);
    expect(() => resolveInside(root, ".")).toThrow(PathSafetyError);
    expect(resolveInside(root, "discord/audio/u1/a.wav")).toContain("discord");
    await fsp.rm(root, { recursive: true, force: true });
  });

  it("rejects an invalid session ID before touching the filesystem", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-session-path-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    const manager = new SessionManager(config, store);
    expect(() => manager.sessionDir("../escape")).toThrow();
    expect(() => manager.sessionDir("..")).toThrow();
    expect(() => manager.sessionDir("C:\\Windows")).toThrow();
    store.close();
    await fsp.rm(root, { recursive: true, force: true });
  });
});
