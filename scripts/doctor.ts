/**
 * CLI health check. The dashboard /api/doctor/run is the primary interface.
 */
import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { checkPythonHealth } from "../src/server/stt.js";
import { checkParakeetHealth } from "../src/server/parakeet.js";
import { listFoundryWorlds } from "../src/server/foundryWorlds.js";
import { Store } from "../src/server/store.js";
import { LlmService } from "../src/server/llm.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const [python, parakeet] = await Promise.all([
    checkPythonHealth(config),
    checkParakeetHealth(config)
  ]);
  const worlds = await listFoundryWorlds(config.foundryDataPath);
  const store = new Store(config.dbFile);
  try {
    const enabled = store.getSetting<boolean | null>("llm_enabled", null);
    if (typeof enabled === "boolean") config.llmEnabled = enabled;
    const baseUrl = store.getSetting<string | null>("llm_base_url", null);
    if (typeof baseUrl === "string") config.llmBaseUrl = baseUrl || null;
    const model = store.getSetting<string | null>("llm_model", null);
    if (typeof model === "string") config.llmModel = model || null;
    const provider = store.getSetting<string | null>("llm_provider", null);
    if (provider === "ollama" || provider === "llamacpp" || provider === "deepseek" || provider === "local") {
      config.llmProvider = provider;
    }
    const cloud = store.getSetting<boolean | null>("llm_cloud_enabled", null);
    if (typeof cloud === "boolean") config.llmCloudEnabled = cloud;
    const maxInput = store.getSetting<number | null>("llm_max_input_chars", null);
    if (typeof maxInput === "number") config.llmMaxInputChars = maxInput;
    const timeout = store.getSetting<number | null>("llm_timeout_ms", null);
    if (typeof timeout === "number") config.llmTimeoutMs = timeout;
    const context = store.getSetting<number | null>("llm_context_tokens", null);
    if (typeof context === "number" && context >= 4096 && context <= 131072) config.llmContextTokens = context;
    const gpuLayers = store.getSetting<number | null>("llm_gpu_layers", -1);
    if (gpuLayers !== -1) {
      config.llmGpuLayers =
        gpuLayers == null || (typeof gpuLayers === "number" && gpuLayers >= 0 && gpuLayers <= 999)
          ? gpuLayers
          : config.llmGpuLayers;
    }
    const thinking = store.getSetting<string | null>("llm_thinking_effort", null);
    if (thinking === "off" || thinking === "low" || thinking === "medium" || thinking === "high") {
      config.llmThinkingEffort = thinking;
    }
    const ncpuMoe = store.getSetting<number | null>("llamacpp_n_cpu_moe", null);
    if (typeof ncpuMoe === "number" && ncpuMoe >= 0 && ncpuMoe <= 999) config.llamacppNcpuMoe = ncpuMoe;
    const kvCache = store.getSetting<string | null>("llamacpp_kv_cache", null);
    if (kvCache === "f16" || kvCache === "q8_0" || kvCache === "q4_0") config.llamacppKvCache = kvCache;
    const flashAttn = store.getSetting<boolean | null>("llamacpp_flash_attn", null);
    if (typeof flashAttn === "boolean") config.llamacppFlashAttn = flashAttn;
  } finally {
    store.close();
  }
  const llm = new LlmService(config).status();
  const active = config.sttEngine === "parakeet" ? parakeet : python;
  const activeReady =
    config.sttEngine === "parakeet"
      ? parakeet.available && parakeet.modelPresent
      : python.available && !python.error && python.fasterWhisper != null;
  const report = {
    version: "0.1.0",
    port: config.port,
    host: config.host,
    discordTokenConfigured: Boolean(config.discordToken),
    dashboardTokenConfigured: Boolean(config.dashboardToken),
    foundryDataPath: config.foundryDataPath,
    foundryWorlds: worlds.map((world) => ({
      id: world.id,
      title: world.title,
      system: world.system,
      systemVersion: world.systemVersion
    })),
    llm: {
      enabled: llm.enabled,
      configured: llm.configured,
      connectionChecked: false,
      generationChecked: false,
      provider: llm.provider,
      baseUrl: llm.baseUrl,
      model: llm.model,
      contextTokens: llm.contextTokens,
      gpuLayers: llm.gpuLayers,
      llamacppNcpuMoe: llm.llamacppNcpuMoe,
      llamacppKvCache: llm.llamacppKvCache,
      llamacppFlashAttn: llm.llamacppFlashAttn,
      thinkingEffort: llm.thinkingEffort,
      maxInputChars: llm.maxInputChars,
      cloudEnabled: llm.cloudEnabled,
      apiKeyConfigured: llm.apiKeyConfigured
    },
    stt: {
      engine: config.sttEngine,
      ready: activeReady,
      error: active.error,
      whisper: {
        model: config.sttModel,
        device: config.sttDevice,
        computeType: config.sttComputeType,
        beamSize: config.sttBeamSize,
        vadFilter: config.sttVadFilter,
        noSpeechThreshold: config.sttNoSpeechThreshold,
        logProbThreshold: config.sttLogProbThreshold,
        compressionRatioThreshold: config.sttCompressionRatioThreshold,
        health: python
      },
      parrot: {
        model: path.basename(config.parakeetModel),
        modelPath: config.parakeetModel,
        runtimePath: config.parakeetPath,
        device: config.parakeetDevice,
        concurrency: config.parakeetConcurrency,
        health: parakeet
      }
    },
    python,
    parakeet,
    diskFreeBytes: (() => {
      try {
        const stat = fs.statfsSync(config.dataDir);
        return Number(stat.bavail) * Number(stat.bsize);
      } catch {
        return null;
      }
    })()
  };
  console.log(JSON.stringify(report, null, 2));
  if (!activeReady) process.exitCode = 3;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
