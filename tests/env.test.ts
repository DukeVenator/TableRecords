import { describe, expect, it } from "vitest";
import { sanitizedChildEnv } from "../src/server/childEnv.js";

describe("child process environment", () => {
  it("never forwards Discord or dashboard secrets to Python", () => {
    const previousDiscord = process.env.DISCORD_TOKEN;
    const previousDashboard = process.env.DASHBOARD_TOKEN;
    process.env.DISCORD_TOKEN = "secret-discord-token";
    process.env.DASHBOARD_TOKEN = "secret-dashboard-token";
    try {
      const env = sanitizedChildEnv({ PYTHONIOENCODING: "utf-8" });
      expect(env.DISCORD_TOKEN).toBeUndefined();
      expect(env.DASHBOARD_TOKEN).toBeUndefined();
      expect(env.PYTHONIOENCODING).toBe("utf-8");
      expect(env.SystemRoot || env.PATH || env.Path).toBeTruthy();
    } finally {
      if (previousDiscord === undefined) delete process.env.DISCORD_TOKEN;
      else process.env.DISCORD_TOKEN = previousDiscord;
      if (previousDashboard === undefined) delete process.env.DASHBOARD_TOKEN;
      else process.env.DASHBOARD_TOKEN = previousDashboard;
    }
  });
});
