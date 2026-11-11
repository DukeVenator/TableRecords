import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { buildLlamaCppArgs, LlamaCppServer } from "../src/server/llamacpp.js";

const roots: string[] = [];
afterEach(async () => {
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

async function configFor(overrides: Record<string, unknown> = {}) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-llamacpp-"));
  roots.push(root);
  return loadConfig({
    projectRoot: root,
    dataDir: path.join(root, "data"),
    sessionsDir: path.join(root, "sessions"),
    modelsDir: path.join(root, "models"),
    llmProvider: "llamacpp",
    llmModel: "qwen3.5-35b-a3b",
    llmContextTokens: 32768,
    llmGpuLayers: 99,
    llamacppNcpuMoe: 12,
    llamacppKvCache: "q8_0",
    llamacppFlashAttn: true,
    llamacppModelPath: path.join(root, "model.gguf"),
    llamacppExe: path.join(root, "llama-server.exe"),
    llamacppPort: 19771,
    ...overrides
  });
}

describe("llama.cpp managed server", () => {
  it("builds typed arguments for mmap, context, GPU, MoE, and KV cache", async () => {
    const config = await configFor();
    expect(buildLlamaCppArgs(config)).toEqual([
      "-m",
      path.join(config.projectRoot, "model.gguf"),
      "--load-mode",
      "mmap",
      "-ngl",
      "99",
      "-c",
      "32768",
      "-ctk",
      "q8_0",
      "-ctv",
      "q8_0",
      "-fa",
      "on",
      "--host",
      "127.0.0.1",
      "--port",
      "19771",
      "--alias",
      "qwen3.5-35b-a3b",
      "--n-cpu-moe",
      "12"
    ]);
  });

  it("refuses to start without a real model file", async () => {
    const config = await configFor();
    const server = new LlamaCppServer(config);
    await expect(server.start()).rejects.toThrow("Model file not found");
    expect(server.snapshot()).toMatchObject({ state: "stopped", managed: false });
  });
});
