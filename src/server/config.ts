import "dotenv/config";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { LlmProvider, LlmThinkingEffort } from "../core/types.js";

export const PROJECT_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const APP_VERSION = "0.1.0";
export const APP_SCHEMA = "tablerecords.status/v1";
export const DEFAULT_PORT = 17_300;
function hostTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export const DEFAULT_SESSION_TIME_ZONE = hostTimeZone();

function env(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value.trim() : undefined;
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function boolEnv(name: string, fallback: boolean): boolean {
  const raw = env(name)?.toLowerCase();
  if (raw === "1" || raw === "true" || raw === "yes") return true;
  if (raw === "0" || raw === "false" || raw === "no") return false;
  return fallback;
}

function providerEnv(name: string, fallback: LlmProvider): LlmProvider {
  const raw = env(name)?.toLowerCase();
  return raw === "ollama" || raw === "llamacpp" || raw === "deepseek" || raw === "local" ? raw : fallback;
}

function thinkingEnv(name: string, fallback: LlmThinkingEffort): LlmThinkingEffort {
  const raw = env(name)?.toLowerCase();
  return raw === "off" || raw === "low" || raw === "medium" || raw === "high" ? raw : fallback;
}

function floatEnv(name: string, fallback: number): number {
  const raw = env(name);
  if (!raw) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function resolveFromRoot(value: string | undefined, fallback: string): string {
  if (!value) return path.resolve(PROJECT_ROOT, fallback);
  return path.isAbsolute(value) ? value : path.resolve(PROJECT_ROOT, value);
}

/**
 * Discord bot tokens embed the application/user ID as a base64url segment.
 * Only the public client ID is returned; the token itself never leaves config.
 */
export function discordClientIdFromToken(token: string | null | undefined): string | null {
  const raw = (token ?? "").trim().replace(/^Bot\s+/i, "");
  if (!raw) return null;
  const segment = raw.split(".")[0];
  if (!segment) return null;
  try {
    const decoded = Buffer.from(segment, "base64url").toString("utf8").trim();
    return /^\d{17,20}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

export interface AppConfig {
  projectRoot: string;
  dataDir: string;
  sessionsDir: string;
  modelsDir: string;
  dbFile: string;
  webDir: string;
  host: "127.0.0.1";
  port: number;
  discordToken: string | null;
  discordClientId: string | null;
  discordBotName: string;
  discordActivityType: "playing" | "listening" | "watching" | "competing";
  discordActivityText: string;
  discordActivityDynamic: boolean;
  dashboardToken: string | null;
  defaultGuildId: string | null;
  foundryDataPath: string | null;
  foundryBridgeToken: string | null;
  pythonPath: string;
  sttEngine: "faster-whisper" | "parakeet";
  sttModel: string;
  sttDevice: string;
  sttComputeType: string;
  sttModelDir: string;
  sttLanguage: string;
  sttBeamSize: number;
  sttVadFilter: boolean;
  sttNoSpeechThreshold: number;
  sttLogProbThreshold: number;
  sttCompressionRatioThreshold: number;
  sttPromptExtra: string;
  sttHotwordsExtra: string;
  parakeetPath: string;
  parakeetModel: string;
  parakeetDevice: string;
  parakeetConcurrency: number;
  captureSilenceMs: number;
  captureTrimPaddingMs: number;
  captureMinVoicedMs: number;
  captureNoiseFloorDbfs: number;
  stitchGapMs: number;
  ffmpegPath: string;
  rollContextBeforeMs: number;
  rollContextAfterMs: number;
  recentContextSeconds: number;
  llmEnabled: boolean;
  llmProvider: LlmProvider;
  llmCloudEnabled: boolean;
  llmBaseUrl: string | null;
  llmModel: string | null;
  llmTimeoutMs: number;
  llmMaxInputChars: number;
  llmContextTokens: number;
  /** Ollama GPU layers or llama.cpp -ngl. null means let the runtime choose; 0 means CPU only. */
  llmGpuLayers: number | null;
  /** llama.cpp --n-cpu-moe: layers whose MoE experts stay in system RAM. */
  llamacppNcpuMoe: number;
  llamacppKvCache: "f16" | "q8_0" | "q4_0";
  llamacppFlashAttn: boolean;
  llamacppExe: string;
  llamacppModelPath: string | null;
  llamacppPort: number;
  llamacppAutostart: boolean;
  llmThinkingEffort: LlmThinkingEffort;
  deepseekApiKey: string | null;
  timeZone: string;
  captureTestMaxSeconds: number;
  reviewAudioBatchClips: number;
  reviewAudioNormalize: boolean;
}

export function loadConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  const projectRoot = path.resolve(overrides.projectRoot ?? PROJECT_ROOT);
  const dataDir = overrides.dataDir ?? resolveFromRoot(env("DATA_DIR"), "data");
  const sessionsDir = overrides.sessionsDir ?? resolveFromRoot(env("SESSIONS_DIR"), "sessions");
  const modelsDir = overrides.modelsDir ?? resolveFromRoot(env("MODELS_DIR"), "models");
  const host = "127.0.0.1";
  const port = overrides.port ?? intEnv("PORT", DEFAULT_PORT);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid PORT: ${String(port)}`);

  const foundryFromEnv = env("FOUNDRY_DATA_PATH");
  const standardFoundryPath = path.join(os.homedir(), "AppData", "Local", "FoundryVTT");
  const foundryDataPath = foundryFromEnv
    ? resolveFromRoot(foundryFromEnv, foundryFromEnv)
    : fs.existsSync(standardFoundryPath)
      ? standardFoundryPath
      : null;
  const discordToken =
    overrides.discordToken !== undefined ? overrides.discordToken : env("DISCORD_TOKEN") ?? null;
  const config: AppConfig = {
    projectRoot,
    dataDir,
    sessionsDir,
    modelsDir,
    dbFile: overrides.dbFile ?? path.join(dataDir, "tablerecords.db"),
    webDir: overrides.webDir ?? path.join(projectRoot, "dist", "web"),
    host,
    port,
    discordToken,
    discordClientId:
      overrides.discordClientId !== undefined ? overrides.discordClientId : discordClientIdFromToken(discordToken),
    discordBotName: overrides.discordBotName ?? env("DISCORD_BOT_NAME") ?? "Scribblespark",
    discordActivityType:
      overrides.discordActivityType ??
      (["playing", "listening", "watching", "competing"].includes((env("DISCORD_ACTIVITY_TYPE") ?? "").toLowerCase())
        ? (env("DISCORD_ACTIVITY_TYPE")!.toLowerCase() as "playing" | "listening" | "watching" | "competing")
        : "watching"),
    discordActivityText:
      overrides.discordActivityText ??
      env("DISCORD_ACTIVITY_TEXT") ??
      "every adventure (and slowly destroying this computer)",
    discordActivityDynamic: overrides.discordActivityDynamic ?? boolEnv("DISCORD_ACTIVITY_DYNAMIC", true),
    dashboardToken: overrides.dashboardToken !== undefined ? overrides.dashboardToken : env("DASHBOARD_TOKEN") ?? null,
    defaultGuildId: overrides.defaultGuildId !== undefined ? overrides.defaultGuildId : env("DISCORD_GUILD_ID") ?? null,
    foundryDataPath: overrides.foundryDataPath !== undefined ? overrides.foundryDataPath : foundryDataPath,
    foundryBridgeToken:
      overrides.foundryBridgeToken !== undefined ? overrides.foundryBridgeToken : env("FOUNDRY_BRIDGE_TOKEN") ?? null,
    pythonPath: overrides.pythonPath ?? resolveFromRoot(env("PYTHON_PATH"), path.join(".venv", "Scripts", "python.exe")),
    sttEngine:
      overrides.sttEngine ??
      (["whisper", "faster-whisper"].includes((env("STT_ENGINE") ?? "").toLowerCase())
        ? "faster-whisper"
        : "parakeet"),
    sttModel: overrides.sttModel ?? env("STT_MODEL") ?? "large-v3-turbo",
    sttDevice: overrides.sttDevice ?? env("STT_DEVICE") ?? "cuda",
    sttComputeType: overrides.sttComputeType ?? env("STT_COMPUTE_TYPE") ?? "float16",
    sttModelDir: overrides.sttModelDir ?? resolveFromRoot(env("STT_MODEL_DIR"), path.join("models", "faster-whisper")),
    sttLanguage: overrides.sttLanguage ?? env("STT_LANGUAGE") ?? "en",
    sttBeamSize: Math.max(1, Math.min(10, overrides.sttBeamSize ?? intEnv("STT_BEAM_SIZE", 5))),
    sttVadFilter: overrides.sttVadFilter ?? boolEnv("STT_VAD_FILTER", false),
    sttNoSpeechThreshold: Math.max(
      0,
      Math.min(1, overrides.sttNoSpeechThreshold ?? floatEnv("STT_NO_SPEECH_THRESHOLD", 0.6))
    ),
    sttLogProbThreshold: Math.max(
      -5,
      Math.min(0, overrides.sttLogProbThreshold ?? floatEnv("STT_LOG_PROB_THRESHOLD", -1))
    ),
    sttCompressionRatioThreshold: Math.max(
      1,
      Math.min(10, overrides.sttCompressionRatioThreshold ?? floatEnv("STT_COMPRESSION_RATIO_THRESHOLD", 2.4))
    ),
    sttPromptExtra: overrides.sttPromptExtra ?? env("STT_PROMPT_EXTRA") ?? "",
    sttHotwordsExtra: overrides.sttHotwordsExtra ?? env("STT_HOTWORDS_EXTRA") ?? "",
    parakeetPath: overrides.parakeetPath ?? env("NEMO_SPEECH_PATH") ?? "nemo-speech",
    parakeetModel:
      overrides.parakeetModel ??
      resolveFromRoot(env("PARAKEET_MODEL"), path.join("models", "parakeet", "parakeet-tdt-0.6b-v3.q8_0.gguf")),
    parakeetDevice: overrides.parakeetDevice ?? env("PARAKEET_DEVICE") ?? "cuda",
    parakeetConcurrency: Math.max(1, Math.min(16, overrides.parakeetConcurrency ?? intEnv("PARAKEET_CONCURRENCY", 4))),
    captureSilenceMs: Math.max(
      500,
      Math.min(10_000, overrides.captureSilenceMs ?? intEnv("CAPTURE_SILENCE_MS", 2400))
    ),
    captureTrimPaddingMs: Math.max(
      0,
      Math.min(2000, overrides.captureTrimPaddingMs ?? intEnv("CAPTURE_TRIM_PADDING_MS", 300))
    ),
    captureMinVoicedMs: Math.max(
      0,
      Math.min(5000, overrides.captureMinVoicedMs ?? intEnv("CAPTURE_MIN_VOICED_MS", 200))
    ),
    captureNoiseFloorDbfs: Math.max(
      -80,
      Math.min(-20, overrides.captureNoiseFloorDbfs ?? intEnv("CAPTURE_NOISE_FLOOR_DBFS", -45))
    ),
    stitchGapMs: Math.max(0, Math.min(10_000, overrides.stitchGapMs ?? intEnv("STITCH_GAP_MS", 2000))),
    ffmpegPath: overrides.ffmpegPath ?? env("FFMPEG_PATH") ?? "ffmpeg",
    rollContextBeforeMs: overrides.rollContextBeforeMs ?? intEnv("ROLL_CONTEXT_BEFORE_MS", 20_000),
    rollContextAfterMs: overrides.rollContextAfterMs ?? intEnv("ROLL_CONTEXT_AFTER_MS", 10_000),
    recentContextSeconds: overrides.recentContextSeconds ?? intEnv("RECENT_CONTEXT_SECONDS", 180),
    llmEnabled: overrides.llmEnabled ?? boolEnv("LLM_ENABLED", false),
    llmProvider: overrides.llmProvider ?? providerEnv("LLM_PROVIDER", "ollama"),
    llmCloudEnabled: overrides.llmCloudEnabled ?? boolEnv("LLM_CLOUD_ENABLED", false),
    llmBaseUrl:
      overrides.llmBaseUrl !== undefined
        ? overrides.llmBaseUrl
        : env("LLM_BASE_URL") ?? "http://127.0.0.1:11434",
    llmModel: overrides.llmModel !== undefined ? overrides.llmModel : env("LLM_MODEL") ?? null,
    llmTimeoutMs: Math.min(300_000, Math.max(5_000, overrides.llmTimeoutMs ?? intEnv("LLM_TIMEOUT_MS", 60_000))),
    llmMaxInputChars: Math.min(
      200_000,
      Math.max(4_000, overrides.llmMaxInputChars ?? intEnv("LLM_MAX_INPUT_CHARS", 40_000))
    ),
    llmContextTokens: Math.min(
      131_072,
      Math.max(4_096, overrides.llmContextTokens ?? intEnv("LLM_CONTEXT_TOKENS", 16_384))
    ),
    llmGpuLayers:
      overrides.llmGpuLayers !== undefined
        ? overrides.llmGpuLayers == null
          ? null
          : Math.min(999, Math.max(0, overrides.llmGpuLayers))
        : env("LLM_GPU_LAYERS")?.trim()
          ? Math.min(999, Math.max(0, intEnv("LLM_GPU_LAYERS", 0)))
          : null,
    llamacppNcpuMoe: Math.min(
      999,
      Math.max(0, overrides.llamacppNcpuMoe ?? intEnv("LLAMACPP_N_CPU_MOE", 0))
    ),
    llamacppKvCache:
      overrides.llamacppKvCache ??
      (() => {
        const value = env("LLAMACPP_KV_CACHE")?.toLowerCase();
        return value === "q8_0" || value === "q4_0" ? value : "f16";
      })(),
    llamacppFlashAttn: overrides.llamacppFlashAttn ?? boolEnv("LLAMACPP_FLASH_ATTN", true),
    llamacppExe: overrides.llamacppExe ?? env("LLAMACPP_EXE") ?? "llama-server.exe",
    llamacppModelPath:
      overrides.llamacppModelPath !== undefined
        ? overrides.llamacppModelPath
        : env("LLAMACPP_MODEL_PATH") ?? null,
    llamacppPort: Math.min(65_535, Math.max(1, overrides.llamacppPort ?? intEnv("LLAMACPP_PORT", 9931))),
    llamacppAutostart: overrides.llamacppAutostart ?? boolEnv("LLAMACPP_AUTOSTART", false),
    llmThinkingEffort: overrides.llmThinkingEffort ?? thinkingEnv("LLM_THINKING_EFFORT", "off"),
    deepseekApiKey:
      overrides.deepseekApiKey !== undefined ? overrides.deepseekApiKey : env("DEEPSEEK_API_KEY") ?? null,
    timeZone: overrides.timeZone ?? env("TIME_ZONE") ?? DEFAULT_SESSION_TIME_ZONE,
    captureTestMaxSeconds: overrides.captureTestMaxSeconds ?? intEnv("CAPTURE_TEST_MAX_SECONDS", 60),
    reviewAudioBatchClips: Math.max(
      50,
      Math.min(2000, overrides.reviewAudioBatchClips ?? intEnv("REVIEW_AUDIO_BATCH_CLIPS", 500))
    ),
    reviewAudioNormalize: overrides.reviewAudioNormalize ?? boolEnv("REVIEW_AUDIO_NORMALIZE", true)
  };

  for (const dir of [config.dataDir, config.sessionsDir, config.modelsDir]) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return config;
}

export function ensureWebBuild(config: AppConfig): boolean {
  return fs.existsSync(path.join(config.webDir, "index.html"));
}
