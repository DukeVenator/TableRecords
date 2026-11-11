import { describe, expect, it } from "vitest";
import { buildSetupSteps, setupProgress } from "../src/web/setupStatus.js";
import type { SettingsPayload, Status } from "../src/web/types.js";

const status = {
  bot: { state: "ready" },
  stt: { state: "ready", engine: "parakeet" }
} as unknown as Status;

function settingsFor(llm: Record<string, unknown>): SettingsPayload {
  return {
    env: { discordTokenConfigured: true, discordClientId: "123456789012345678" },
    settings: { sttEngine: "parakeet" },
    foundryBridge: { status: { connected: false, moduleVersion: null } },
    llm: {
      enabled: true,
      configured: true,
      provider: "ollama",
      baseUrl: "http://127.0.0.1:11434",
      model: "qwen3.5:27b-q4_K_M",
      timeoutMs: 180000,
      localOnly: true,
      cloudEnabled: false,
      apiKeyConfigured: false,
      maxInputChars: 40000,
      contextTokens: 16384,
      ...llm
    }
  } as unknown as SettingsPayload;
}

function aiStep(settings: SettingsPayload) {
  return buildSetupSteps({ settings, status, guilds: [], worlds: [], captureTestPassed: true }).find(
    (step) => step.id === "ai"
  );
}

describe("setup checklist AI step", () => {
  it("is optional and done when a local model is configured", () => {
    const settings = settingsFor({});
    const step = aiStep(settings);
    expect(step).toMatchObject({ optional: true, done: true });
    expect(step?.detail).toContain("Ollama is configured");
    expect(setupProgress(buildSetupSteps({ settings, status, guilds: [], worlds: [], captureTestPassed: true })).total).toBe(4);
  });

  it("stays optional and explains the gap when the model is missing", () => {
    const step = aiStep(settingsFor({ configured: false, model: null }));
    expect(step).toMatchObject({ optional: true, done: false });
    expect(step?.detail).toContain("no model is selected");
  });

  it("stays optional when summaries are off", () => {
    const step = aiStep(settingsFor({ enabled: false }));
    expect(step).toMatchObject({ optional: true, done: false });
    expect(step?.detail).toContain("Optional");
  });
});
