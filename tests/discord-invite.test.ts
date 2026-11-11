import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { discordClientIdFromToken, loadConfig } from "../src/server/config.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "tablerecords-invite-"));

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("Discord invite client ID", () => {
  const clientId = "241234567890123456";
  const token = `${Buffer.from(clientId).toString("base64url")}.timestamp.signature`;

  it("reads the public client ID out of a bot token", () => {
    expect(discordClientIdFromToken(token)).toBe(clientId);
    expect(discordClientIdFromToken(`Bot ${token}`)).toBe(clientId);
  });

  it("ignores tokens that do not carry a numeric ID", () => {
    expect(discordClientIdFromToken("not-a-token")).toBeNull();
    expect(discordClientIdFromToken("")).toBeNull();
    expect(discordClientIdFromToken(null)).toBeNull();
    expect(discordClientIdFromToken(`${Buffer.from("hello").toString("base64url")}.a.b`)).toBeNull();
  });

  it("exposes the derived ID on the loaded config without exposing the token", () => {
    const config = loadConfig({
      discordToken: token,
      dataDir: path.join(tmpRoot, "data"),
      sessionsDir: path.join(tmpRoot, "sessions"),
      modelsDir: path.join(tmpRoot, "models"),
      webDir: path.join(tmpRoot, "web")
    });
    expect(config.discordClientId).toBe(clientId);
  });

  it("has no client ID when no token is configured", () => {
    const config = loadConfig({
      discordToken: null,
      dataDir: path.join(tmpRoot, "data2"),
      sessionsDir: path.join(tmpRoot, "sessions2"),
      modelsDir: path.join(tmpRoot, "models2"),
      webDir: path.join(tmpRoot, "web2")
    });
    expect(config.discordClientId).toBeNull();
  });
});
