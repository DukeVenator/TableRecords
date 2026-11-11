import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { DEEPSEEK_BASE_URL, LlmError, LlmService, normalizeOllamaBaseUrl, validateLlmBaseUrl } from "../src/server/llm.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

async function configFor(overrides: Record<string, unknown> = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-llm-"));
  roots.push(root);
  return loadConfig({
    projectRoot: root,
    dataDir: path.join(root, "data"),
    sessionsDir: path.join(root, "sessions"),
    modelsDir: path.join(root, "models"),
    llmEnabled: true,
    llmProvider: "local",
    llmBaseUrl: "http://127.0.0.1:11434/v1",
    llmModel: "test-model",
    llmTimeoutMs: 5_000,
    ...overrides
  });
}

const request = { system: "You are an archivist.", user: "# GM context\n\nA quiet cantina." };

describe("LLM providers", () => {
  it("accepts only loopback base URLs for local providers", () => {
    expect(validateLlmBaseUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434/v1");
    expect(validateLlmBaseUrl("http://localhost:1234/v1")).toBe("http://localhost:1234/v1");
    expect(() => validateLlmBaseUrl("https://api.example.com/v1")).toThrowError(LlmError);
    expect(() => validateLlmBaseUrl("http://user:pass@127.0.0.1/v1")).toThrowError(LlmError);
    expect(() => validateLlmBaseUrl("ftp://127.0.0.1/v1")).toThrowError(LlmError);
    expect(normalizeOllamaBaseUrl("http://127.0.0.1:11434/v1/")).toBe("http://127.0.0.1:11434");
  });

  it("calls the local OpenAI-compatible endpoint", async () => {
    const config = await configFor();
    const captured: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      captured.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ choices: [{ message: { content: "  Summary text.  " } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const service = new LlmService(config, fetcher);
    const result = await service.summarize(request);
    expect(result.text).toBe("Summary text.");
    expect(result.model).toBe("test-model");
    expect(captured[0]?.url).toBe("http://127.0.0.1:11434/v1/chat/completions");
    expect(captured[0]?.body.model).toBe("test-model");
    expect(JSON.stringify(captured[0]?.body.messages)).toContain("A quiet cantina.");
  });

  it("uses Ollama's native chat and model endpoints", async () => {
    const config = await configFor({
      llmProvider: "ollama",
      llmBaseUrl: "http://127.0.0.1:11434/v1",
      llmModel: "qwen3.5:0.8b"
    });
    const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      calls.push({ url, body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {} });
      if (url.endsWith("/api/tags")) {
        return new Response(JSON.stringify({ models: [{ name: "qwen3.5:0.8b" }, { name: "deepseek-r1:8b" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ message: { content: "  Ollama summary.  " } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const service = new LlmService(config, fetcher);
    expect((await service.listModels()).map((model) => model.id)).toEqual(["deepseek-r1:8b", "qwen3.5:0.8b"]);
    const result = await service.summarize({ ...request, json: true, jsonSchema: { type: "object" } });
    expect(result.text).toBe("Ollama summary.");
    expect(calls.at(-1)?.url).toBe("http://127.0.0.1:11434/api/chat");
    expect(calls.at(-1)?.body).toMatchObject({ model: "qwen3.5:0.8b", format: { type: "object" }, stream: false });
    expect(calls.at(-1)?.body).toMatchObject({ options: { num_ctx: 16_384 }, think: false });
  });

  it("sends reasoning effort to llama.cpp and Ollama", async () => {
    const llamaConfig = await configFor({
      llmProvider: "llamacpp",
      llmBaseUrl: "http://127.0.0.1:9931/v1",
      llmModel: "qwen3.5-35b-a3b",
      llmThinkingEffort: "high"
    });
    const llamaCalls: Array<{ url: string; body: Record<string, unknown> }> = [];
    const llamaFetch = (async (url: string, init: RequestInit) => {
      llamaCalls.push({ url, body: JSON.parse(String(init.body)) as Record<string, unknown> });
      return new Response(JSON.stringify({ choices: [{ message: { content: "Summary." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const llama = new LlmService(llamaConfig, llamaFetch);
    await llama.summarize({ ...request, maxTokens: 900 });
    expect(llamaCalls[0]?.url).toBe("http://127.0.0.1:9931/v1/chat/completions");
    expect(llamaCalls[0]?.body).toMatchObject({
      model: "qwen3.5-35b-a3b",
      reasoning_effort: "high",
      max_tokens: 4_996
    });
    expect(llama.status()).toMatchObject({ provider: "llamacpp", thinkingEffort: "high" });

    const ollamaConfig = await configFor({
      llmProvider: "ollama",
      llmBaseUrl: "http://127.0.0.1:11434",
      llmModel: "qwen3.5:27b-q4_K_M",
      llmThinkingEffort: "medium"
    });
    const ollamaCalls: Array<Record<string, unknown>> = [];
    const ollamaFetch = (async (_url: string, init: RequestInit) => {
      ollamaCalls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { content: "Summary." } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await new LlmService(ollamaConfig, ollamaFetch).summarize({ ...request, maxTokens: 900 });
    expect(ollamaCalls[0]).toMatchObject({ think: "medium", options: { num_predict: 4_996 } });
  });

  it("passes context and GPU layer overrides to Ollama", async () => {
    const config = await configFor({
      llmProvider: "ollama",
      llmBaseUrl: "http://127.0.0.1:11434",
      llmModel: "qwen3.5:35b-a3b-q4_K_M",
      llmContextTokens: 32_768,
      llmGpuLayers: 40
    });
    const calls: Array<Record<string, unknown>> = [];
    const fetcher = (async (_url: string, init: RequestInit) => {
      calls.push(JSON.parse(String(init.body)) as Record<string, unknown>);
      return new Response(JSON.stringify({ message: { content: "Summary." } }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    await new LlmService(config, fetcher).summarize(request);
    expect(calls[0]?.options).toMatchObject({ num_ctx: 32_768, num_gpu: 40 });
  });

  it("uses DeepSeek only when cloud is on and a key is configured", async () => {
    const cloudOff = await configFor({
      llmProvider: "deepseek",
      llmCloudEnabled: false,
      deepseekApiKey: "secret-key",
      llmModel: null
    });
    expect(new LlmService(cloudOff).status()).toMatchObject({
      provider: "deepseek",
      configured: false,
      localOnly: false,
      apiKeyConfigured: true
    });
    await expect(new LlmService(cloudOff).summarize(request)).rejects.toMatchObject({ code: "llm_cloud_disabled" });

    const noKey = await configFor({ llmProvider: "deepseek", llmCloudEnabled: true, deepseekApiKey: null });
    await expect(new LlmService(noKey).summarize(request)).rejects.toMatchObject({ code: "llm_api_key_missing" });

    const config = await configFor({
      llmProvider: "deepseek",
      llmCloudEnabled: true,
      deepseekApiKey: "secret-key",
      llmModel: null
    });
    const captured: Array<{ url: string; body: Record<string, unknown>; auth: string | null }> = [];
    const fetcher = (async (url: string, init: RequestInit) => {
      captured.push({
        url,
        body: init.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {},
        auth: new Headers(init.headers).get("authorization")
      });
      if (url.endsWith("/models")) {
        return new Response(JSON.stringify({ data: [{ id: "deepseek-flash" }] }), {
          status: 200,
          headers: { "content-type": "application/json" }
        });
      }
      return new Response(JSON.stringify({ choices: [{ message: { content: "DeepSeek summary." } }] }), {
        status: 200,
        headers: { "content-type": "application/json" }
      });
    }) as typeof fetch;
    const service = new LlmService(config, fetcher);
    expect((await service.listModels())[0]?.id).toBe("deepseek-flash");
    const result = await service.summarize(request);
    expect(result.text).toBe("DeepSeek summary.");
    expect(result.model).toBe("deepseek-flash");
    expect(captured.at(-1)?.url).toBe(`${DEEPSEEK_BASE_URL}/chat/completions`);
    expect(captured.at(-1)?.auth).toBe("Bearer secret-key");
  });

  it("fails closed when disabled or the endpoint is missing", async () => {
    const disabled = await configFor({ llmEnabled: false });
    await expect(new LlmService(disabled).summarize(request)).rejects.toMatchObject({ code: "llm_disabled" });
    const missing = await configFor({ llmModel: null });
    await expect(new LlmService(missing).summarize(request)).rejects.toMatchObject({ code: "llm_not_configured" });
  });
});
