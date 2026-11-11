import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { loadConfig, type AppConfig } from "../src/server/config.js";
import { TableRecordsApp } from "../src/server/app.js";

const apps: TableRecordsApp[] = [];
const servers: http.Server[] = [];
afterEach(async () => {
  while (apps.length) await apps.pop()!.close().catch(() => undefined);
  while (servers.length) {
    const server = servers.pop()!;
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

async function makeApp(overrides: Partial<AppConfig> = {}): Promise<TableRecordsApp> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-llm-api-"));
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
    dashboardToken: null,
    llmEnabled: false,
    llmProvider: "local",
    llmBaseUrl: "http://127.0.0.1:11434/v1",
    llmModel: null,
    ...overrides
  });
  const app = new TableRecordsApp(config);
  await app.init();
  apps.push(app);
  return app;
}

describe("LLM API gating", () => {
  it("is disabled by default and rejects non-loopback endpoints", async () => {
    const app = await makeApp();
    const settings = await app.fastify.inject({ method: "GET", url: "/api/settings" });
    expect(settings.statusCode).toBe(200);
    expect(settings.json()).toMatchObject({ llm: { enabled: false, configured: false, localOnly: true } });

    const rejected = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmBaseUrl: "https://api.example.com/v1", llmModel: "cloud-model", llmEnabled: true }
    });
    expect(rejected.statusCode).toBe(400);
    expect(rejected.json()).toMatchObject({ error: { code: "llm_not_local" } });
    const afterRejected = await app.fastify.inject({ method: "GET", url: "/api/settings" });
    expect(afterRejected.json()).toMatchObject({ llm: { enabled: false, model: null } });

    const session = await app.sessions.create({
      title: "LLM API Test",
      participants: [],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const now = Date.now();
    await app.sessions.setStatus(session, "captured", { startedAtMs: now - 60_000, stoppedAtMs: now });

    const disabled = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${session.sessionId}/llm/summarize`,
      headers: { "content-type": "application/json" },
      payload: { windowSeconds: 180 }
    });
    expect(disabled.statusCode).toBe(409);
    expect(disabled.json()).toMatchObject({ error: { code: "llm_disabled" } });

    const saved = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmBaseUrl: "http://127.0.0.1:11434/v1/", llmModel: "local-model", llmEnabled: false }
    });
    expect(saved.statusCode).toBe(200);
    expect(saved.json()).toMatchObject({ llm: { enabled: false, configured: true, baseUrl: "http://127.0.0.1:11434/v1", model: "local-model" } });

    const tuned = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmContextTokens: 32768, llmGpuLayers: 40 }
    });
    expect(tuned.statusCode).toBe(200);
    expect(tuned.json()).toMatchObject({ llm: { contextTokens: 32768, gpuLayers: 40 } });

    const auto = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmGpuLayers: null }
    });
    expect(auto.statusCode).toBe(200);
    expect(auto.json()).toMatchObject({ llm: { gpuLayers: null } });

    const invalidContext = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmContextTokens: 1024 }
    });
    expect(invalidContext.statusCode).toBe(400);
    expect(invalidContext.json()).toMatchObject({ error: { code: "invalid_llm_context" } });

    const modelPath = path.join(app.config.projectRoot, "qwen.gguf");
    await fsp.writeFile(modelPath, "GGUF");
    const llama = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: {
        llmProvider: "llamacpp",
        llmBaseUrl: "http://127.0.0.1:9931/v1",
        llmModel: "qwen3.5-35b-a3b",
        llmContextTokens: 65536,
        llamacppNcpuMoe: 12,
        llamacppKvCache: "q8_0",
        llamacppFlashAttn: false,
        llamacppExe: "llama-server.exe",
        llamacppModelPath: modelPath,
        llamacppPort: 9931,
        llamacppAutostart: false,
        llmThinkingEffort: "high"
      }
    });
    expect(llama.statusCode).toBe(200);
    expect(llama.json()).toMatchObject({
      llm: {
        provider: "llamacpp",
        model: "qwen3.5-35b-a3b",
        contextTokens: 65536,
        llamacppNcpuMoe: 12,
        llamacppKvCache: "q8_0",
        llamacppFlashAttn: false,
        thinkingEffort: "high"
      },
      llamacpp: {
        exe: "llama-server.exe",
        modelPath,
        port: 9931,
        autostart: false
      }
    });

    const invalidThinking = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmThinkingEffort: "maximum" }
    });
    expect(invalidThinking.statusCode).toBe(400);
    expect(invalidThinking.json()).toMatchObject({ error: { code: "invalid_llm_thinking" } });
  });

  it("summarizes through a local OpenAI-compatible endpoint when enabled", async () => {
    let captured = "";
    const server = http.createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        captured = Buffer.concat(chunks).toString("utf8");
        response.writeHead(200, { "content-type": "application/json" });
        if (request.url?.endsWith("/models")) {
          response.end(JSON.stringify({ data: [{ id: "stub-model" }] }));
          return;
        }
        response.end(JSON.stringify({ choices: [{ message: { content: "## Current situation\n\nA quiet cantina." } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const app = await makeApp({
      llmEnabled: true,
      llmProvider: "local",
      llmBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      llmModel: "stub-model"
    });
    const session = await app.sessions.create({
      title: "LLM Success Test",
      participants: [],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const now = Date.now();
    await app.sessions.setStatus(session, "captured", { startedAtMs: now - 60_000, stoppedAtMs: now });

    const models = await app.fastify.inject({ method: "GET", url: "/api/llm/models" });
    expect(models.statusCode).toBe(200);
    expect(models.json()).toMatchObject({ provider: "local", models: [{ id: "stub-model" }] });
    const connection = await app.fastify.inject({ method: "POST", url: "/api/llm/test", payload: {} });
    expect(connection.statusCode).toBe(200);
    expect(connection.json()).toMatchObject({ ok: true, provider: "local", models: 1 });

    const result = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${session.sessionId}/llm/summarize`,
      headers: { "content-type": "application/json" },
      payload: { windowSeconds: 180 }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({
      schema: "tablerecords.llm-summary/v2",
      sessionId: session.sessionId,
      summary: "## Current situation\n\nA quiet cantina.",
      model: "stub-model",
      provider: "local",
      preset: "gm-prep",
      scope: "recent",
      trimmed: false,
      chunks: 1
    });
    expect(captured).toContain("GM context");
    expect(captured).toContain("stub-model");

    const history = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${session.sessionId}/llm/summaries`
    });
    expect(history.statusCode).toBe(200);
    const summaries = (history.json() as { summaries: Array<{ summaryId: string }> }).summaries;
    expect(summaries).toHaveLength(1);
    const single = await app.fastify.inject({
      method: "GET",
      url: `/api/sessions/${session.sessionId}/llm/summaries/${summaries[0]!.summaryId}`
    });
    expect(single.statusCode).toBe(200);
    expect(single.json()).toMatchObject({ summaryId: summaries[0]!.summaryId });
  });

  it("reduces a four-hour brief in bounded rounds instead of dropping the tail", async () => {
    let calls = 0;
    const prompts: string[] = [];
    const server = http.createServer((request, response) => {
      calls += 1;
      let body = "";
      request.setEncoding("utf8");
      request.on("data", (chunk: string) => {
        body += chunk;
      });
      request.on("end", () => {
        try {
          const parsed = JSON.parse(body) as { messages?: Array<{ content?: string }> };
          const user = parsed.messages?.[1]?.content;
          if (typeof user === "string") prompts.push(user);
        } catch {
          // The assertion below reports a missing prompt.
        }
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ choices: [{ message: { content: "## Portion\n\nA short fact." } }] }));
      });
    });
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server has no port");
    const app = await makeApp({
      llmEnabled: true,
      llmProvider: "local",
      llmBaseUrl: `http://127.0.0.1:${address.port}/v1`,
      llmModel: "stub-model",
      llmContextTokens: 16384,
      llmThinkingEffort: "off",
      llmMaxInputChars: 40000
    });
    const session = await app.sessions.create({
      title: "Four Hour Session",
      participants: [{ discordUserId: "u1", discordName: "Veyra", character: "Veyra" }],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const endMs = Date.now();
    await app.sessions.setStatus(session, "captured", { startedAtMs: endMs - 4 * 3_600_000, stoppedAtMs: endMs });
    const capturedSession = await app.sessions.get(session.sessionId);
    await app.sessions.save({ ...capturedSession, notes: `## Secret\n\n${"n".repeat(2_500)}\n\nTAIL_MARKER` });
    expect((await app.sessions.get(session.sessionId)).notes).toContain("TAIL_MARKER");
    const dir = app.sessions.sessionDir(session.sessionId);
    await fsp.mkdir(path.join(dir, "stt"), { recursive: true });
    const lines = Array.from({ length: 5000 }, (_, index) => {
      const startMs = endMs - 4 * 3_600_000 + index * 2_800;
      return JSON.stringify({
        schema: "tablerecords.transcript/v1",
        sessionId: session.sessionId,
        utteranceId: `u-${index}`,
        sttJobId: `stt-${index}`,
        batchJobId: "batch",
        discordUserId: "u1",
        speaker: "Veyra",
        character: "Veyra",
        text: "The crew discusses the docking manifest and the blue code.",
        rawText: "The crew discusses the docking manifest and the blue code.",
        corrections: [],
        startMs,
        endMs: startMs + 500,
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
        createdAtMs: startMs
      });
    });
    await fsp.writeFile(path.join(dir, "stt", "transcript.jsonl"), `${lines.join("\n")}\n`);
    await fsp.writeFile(
      path.join(dir, "people.json"),
      JSON.stringify({
        schema: "tablerecords.people/v1",
        sessionId: session.sessionId,
        people: [
          {
            personId: "u1",
            role: "player",
            discordUserId: "u1",
            discordName: "Veyra",
            foundryUserId: null,
            foundryUserName: null,
            character: "Veyra",
            aliases: [],
            consent: true
          }
        ]
      })
    );
    const result = await app.fastify.inject({
      method: "POST",
      url: `/api/sessions/${session.sessionId}/llm/summarize`,
      headers: { "content-type": "application/json" },
      payload: { scope: "session", preset: "recap" }
    });
    expect(result.statusCode).toBe(200);
    expect(result.json()).toMatchObject({ chunks: expect.any(Number) });
    expect((result.json() as { chunks: number }).chunks).toBeGreaterThan(12);
    expect(calls).toBeGreaterThan(12);
    expect(prompts.some((prompt) => prompt.includes("TAIL_MARKER"))).toBe(true);
  }, 30_000);

  it("rejects a missing llama.cpp model and keeps the address on the new port", async () => {
    const app = await makeApp({ llmProvider: "llamacpp", llmModel: "qwen3.5-35b-a3b", llmBaseUrl: "http://127.0.0.1:9931/v1" });
    const missing = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llamacppModelPath: "C:\\Models\\does-not-exist.gguf" }
    });
    expect(missing.statusCode).toBe(400);
    expect(missing.json()).toMatchObject({ error: { code: "llamacpp_model_missing" } });

    const modelPath = path.join(app.config.projectRoot, "qwen.gguf");
    await fsp.writeFile(modelPath, "GGUF");
    const synced = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llamacppModelPath: modelPath, llamacppPort: 9932 }
    });
    expect(synced.statusCode).toBe(200);
    expect(synced.json()).toMatchObject({
      llm: { baseUrl: "http://127.0.0.1:9932/v1" },
      llamacpp: { port: 9932 }
    });
  });

  it("validates provider settings and the cloud gate", async () => {
    const app = await makeApp({ llmProvider: "ollama", llmModel: "qwen3.5:0.8b" });
    const invalid = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmProvider: "unknown" }
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ error: { code: "invalid_llm_provider" } });

    const normalized = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmProvider: "ollama", llmBaseUrl: "http://127.0.0.1:11434/v1/" }
    });
    expect(normalized.statusCode).toBe(200);
    expect(normalized.json()).toMatchObject({
      llm: { provider: "ollama", baseUrl: "http://127.0.0.1:11434", localOnly: true }
    });

    const deepseek = await app.fastify.inject({
      method: "PUT",
      url: "/api/settings",
      headers: { "content-type": "application/json" },
      payload: { llmProvider: "deepseek", llmCloudEnabled: true, llmModel: null }
    });
    expect(deepseek.statusCode).toBe(200);
    expect(deepseek.json()).toMatchObject({
      llm: {
        provider: "deepseek",
        baseUrl: "https://api.deepseek.com",
        cloudEnabled: true,
        apiKeyConfigured: false,
        configured: false,
        localOnly: false
      }
    });
  });
});
