import type { AppConfig } from "./config.js";
import type { LlmProvider, LlmThinkingEffort } from "../core/types.js";

export const DEEPSEEK_BASE_URL = "https://api.deepseek.com";
export const DEFAULT_OLLAMA_URL = "http://127.0.0.1:11434";
export const DEEPSEEK_DEFAULT_MODEL = "deepseek-flash";

export interface LlmStatus {
  enabled: boolean;
  configured: boolean;
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  timeoutMs: number;
  localOnly: boolean;
  cloudEnabled: boolean;
  apiKeyConfigured: boolean;
  maxInputChars: number;
  contextTokens: number;
  gpuLayers: number | null;
  llamacppNcpuMoe: number;
  llamacppKvCache: "f16" | "q8_0" | "q4_0";
  llamacppFlashAttn: boolean;
  thinkingEffort: LlmThinkingEffort;
}

export interface LlmSummary {
  text: string;
  model: string;
  elapsedMs: number;
}

export interface LlmModelInfo {
  id: string;
  name: string;
  sizeBytes?: number;
}

export interface LlmConnectionTest {
  ok: true;
  provider: LlmProvider;
  latencyMs: number;
  models: number;
}

export interface LlmChatRequest {
  system: string;
  user: string;
  maxTokens?: number;
  json?: boolean;
  jsonSchema?: unknown;
  /** Per-call override; extraction and notes passes use off even on a thinking profile. */
  thinkingEffort?: LlmThinkingEffort;
}

interface LlmChatResponse {
  text: string;
  model: string;
}

interface LlmProviderAdapter {
  id: LlmProvider;
  listModels(): Promise<LlmModelInfo[]>;
  chat(request: LlmChatRequest): Promise<LlmChatResponse>;
}

export class LlmError extends Error {
  override name = "LlmError";
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

/**
 * Qwen3.5 can spend a whole small completion budget on its thinking block and
 * never emit the answer. Every non-off level therefore gets the same 4,096
 * token completion headroom; the level still travels to the runtime as a
 * hint, but the budget is large enough to finish either way.
 */
function thinkingTokenBudget(effort: LlmThinkingEffort): number {
  return effort === "off" ? 0 : 4_096;
}

function isLocalHost(hostname: string): boolean {
  return LOCAL_HOSTS.has(hostname.toLowerCase());
}

export function validateLlmBaseUrl(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new LlmError("invalid_llm_url", "That address is not a valid http or https URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new LlmError("invalid_llm_url", "Use an http or https address");
  }
  if (!isLocalHost(url.hostname)) {
    throw new LlmError("llm_not_local", "Summaries only work with a model on this computer (127.0.0.1, localhost, or ::1)");
  }
  if (url.username || url.password) {
    throw new LlmError("invalid_llm_url", "Remove the username and password from that address");
  }
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function normalizeOllamaBaseUrl(raw: string): string {
  const validated = validateLlmBaseUrl(raw);
  const url = new URL(validated);
  let pathname = url.pathname.replace(/\/+$/, "");
  if (pathname.endsWith("/v1")) pathname = pathname.slice(0, -3);
  url.pathname = pathname || "/";
  return url.toString().replace(/\/+$/, "");
}

function openAiBaseUrl(raw: string): string {
  return validateLlmBaseUrl(raw).replace(/\/chat\/completions$/i, "");
}

function endpoint(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function errorMessage(payload: unknown): string | null {
  if (!payload || typeof payload !== "object") return null;
  const error = (payload as { error?: unknown }).error;
  if (typeof error === "string") return error;
  if (error && typeof error === "object") {
    const message = (error as { message?: unknown }).message;
    if (typeof message === "string" && message.trim()) return message.trim();
  }
  return null;
}

async function requestJson(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
  timeoutMs: number,
  label: string
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...init, signal: controller.signal });
    const text = await response.text();
    let payload: unknown = null;
    try {
      payload = text ? JSON.parse(text) : null;
    } catch {
      payload = null;
    }
    if (!response.ok) {
      const detail = errorMessage(payload);
      throw new LlmError(
        "llm_request_failed",
        `${label} returned ${response.status}${detail ? `: ${detail}` : ""}`,
        502
      );
    }
    return payload;
  } catch (error) {
    if (error instanceof LlmError) throw error;
    if ((error as Error).name === "AbortError") {
      throw new LlmError("llm_timeout", `${label} did not answer within ${Math.round(timeoutMs / 1000)} seconds`, 504);
    }
    throw new LlmError("llm_unreachable", `Could not reach ${label}: ${(error as Error).message}`, 502);
  } finally {
    clearTimeout(timer);
  }
}

function modelList(value: unknown, provider: LlmProvider): LlmModelInfo[] {
  if (!value || typeof value !== "object") return [];
  const object = value as Record<string, unknown>;
  const raw =
    provider === "ollama"
      ? Array.isArray(object.models)
        ? object.models
        : []
      : Array.isArray(object.data)
        ? object.data
        : [];
  const seen = new Set<string>();
  const models: LlmModelInfo[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const record = item as Record<string, unknown>;
    const rawId = provider === "ollama" ? record.name ?? record.model : record.id;
    if (typeof rawId !== "string" || !rawId.trim()) continue;
    const id = rawId.trim();
    if (seen.has(id)) continue;
    seen.add(id);
    const size = typeof record.size === "number" && Number.isFinite(record.size) ? record.size : undefined;
    models.push({ id, name: id, ...(size != null ? { sizeBytes: size } : {}) });
  }
  return models.sort((a, b) => a.id.localeCompare(b.id));
}

class OllamaProvider implements LlmProviderAdapter {
  readonly id = "ollama" as const;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly contextTokens: number;
  private readonly gpuLayers: number | null;
  private readonly thinkingEffort: LlmThinkingEffort;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AppConfig, fetchImpl: typeof fetch) {
    if (!config.llmBaseUrl) throw new LlmError("llm_not_configured", "Set an Ollama address in Setup first", 409);
    this.baseUrl = normalizeOllamaBaseUrl(config.llmBaseUrl);
    this.model = config.llmModel ?? "";
    this.timeoutMs = config.llmTimeoutMs;
    this.contextTokens = config.llmContextTokens;
    this.gpuLayers = config.llmGpuLayers;
    this.thinkingEffort = config.llmThinkingEffort;
    this.fetchImpl = fetchImpl;
  }

  async listModels(): Promise<LlmModelInfo[]> {
    const payload = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/api/tags"),
      { method: "GET" },
      Math.min(this.timeoutMs, 15_000),
      "Ollama"
    );
    return modelList(payload, "ollama");
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const effort = request.thinkingEffort ?? this.thinkingEffort;
    const thinkingBudget = thinkingTokenBudget(effort);
    const body = {
      model: this.model,
      stream: false,
      think: effort === "off" ? false : effort,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user }
      ],
      options: {
        temperature: 0.2,
        num_predict: (request.maxTokens ?? 1200) + thinkingBudget,
        num_ctx: this.contextTokens,
        ...(this.gpuLayers != null ? { num_gpu: this.gpuLayers } : {})
      },
      ...(request.json ? { format: request.jsonSchema ?? "json" } : {})
    };
    const payload = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/api/chat"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      this.timeoutMs,
      "Ollama"
    );
    const message = (payload as { message?: { content?: unknown } } | null)?.message;
    const text = message?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new LlmError("llm_empty_response", "Ollama returned no summary text", 502);
    }
    return { text: text.trim(), model: this.model };
  }
}

class DeepSeekProvider implements LlmProviderAdapter {
  readonly id = "deepseek" as const;
  private readonly model: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AppConfig, fetchImpl: typeof fetch) {
    if (!config.llmCloudEnabled) {
      throw new LlmError("llm_cloud_disabled", "Cloud summaries are off in Setup", 409);
    }
    if (!config.deepseekApiKey) {
      throw new LlmError("llm_api_key_missing", "Add a DeepSeek key to the dashboard environment file and restart the dashboard", 409);
    }
    this.model = config.llmModel?.trim() || DEEPSEEK_DEFAULT_MODEL;
    this.apiKey = config.deepseekApiKey;
    this.timeoutMs = config.llmTimeoutMs;
    this.fetchImpl = fetchImpl;
  }

  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`
    };
  }

  async listModels(): Promise<LlmModelInfo[]> {
    const payload = await requestJson(
      this.fetchImpl,
      endpoint(DEEPSEEK_BASE_URL, "/models"),
      { method: "GET", headers: this.headers() },
      Math.min(this.timeoutMs, 15_000),
      "DeepSeek"
    );
    return modelList(payload, "deepseek");
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const body = {
      model: this.model,
      temperature: 0.2,
      max_tokens: request.maxTokens ?? 1200,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user }
      ],
      ...(request.json ? { response_format: { type: "json_object" } } : {})
    };
    const payload = await requestJson(
      this.fetchImpl,
      endpoint(DEEPSEEK_BASE_URL, "/chat/completions"),
      { method: "POST", headers: this.headers(), body: JSON.stringify(body) },
      this.timeoutMs,
      "DeepSeek"
    );
    const text = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message
      ?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new LlmError("llm_empty_response", "DeepSeek returned no summary text", 502);
    }
    return { text: text.trim(), model: this.model };
  }
}

class LocalOpenAiProvider implements LlmProviderAdapter {
  readonly id: "local" | "llamacpp";
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly timeoutMs: number;
  private readonly thinkingEffort: LlmThinkingEffort;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AppConfig, fetchImpl: typeof fetch, id: "local" | "llamacpp" = "local") {
    if (!config.llmBaseUrl) throw new LlmError("llm_not_configured", "Set a local model address in Setup first", 409);
    this.id = id;
    this.baseUrl = openAiBaseUrl(config.llmBaseUrl);
    this.model = config.llmModel ?? "";
    this.timeoutMs = config.llmTimeoutMs;
    this.thinkingEffort = config.llmThinkingEffort;
    this.fetchImpl = fetchImpl;
  }

  async listModels(): Promise<LlmModelInfo[]> {
    const payload = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/models"),
      { method: "GET" },
      Math.min(this.timeoutMs, 15_000),
      "Local model"
    );
    return modelList(payload, "local");
  }

  async chat(request: LlmChatRequest): Promise<LlmChatResponse> {
    const effort = request.thinkingEffort ?? this.thinkingEffort;
    const thinkingBudget = thinkingTokenBudget(effort);
    const body = {
      model: this.model,
      temperature: 0.2,
      max_tokens: (request.maxTokens ?? 1200) + thinkingBudget,
      messages: [
        { role: "system", content: request.system },
        { role: "user", content: request.user }
      ],
      ...(this.id === "llamacpp"
        ? { reasoning_effort: effort === "off" ? "none" : effort }
        : {}),
      ...(request.json ? { response_format: { type: "json_object" } } : {})
    };
    const payload = await requestJson(
      this.fetchImpl,
      endpoint(this.baseUrl, "/chat/completions"),
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body)
      },
      this.timeoutMs,
      this.id === "llamacpp" ? "llama.cpp" : "Local model"
    );
    const text = (payload as { choices?: Array<{ message?: { content?: unknown } }> } | null)?.choices?.[0]?.message
      ?.content;
    if (typeof text !== "string" || !text.trim()) {
      throw new LlmError("llm_empty_response", "Local model returned no summary text", 502);
    }
    return { text: text.trim(), model: this.model };
  }
}

/**
 * The LLM stage is deliberately small and boring: one configured provider, no
 * tools, no retries, no automatic fallback. Turning the toggle off is the
 * privacy boundary.
 */
export class LlmService {
  private readonly config: AppConfig;
  private readonly fetchImpl: typeof fetch;

  constructor(config: AppConfig, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
  }

  private effectiveModel(): string | null {
    if (this.config.llmProvider === "deepseek") {
      return this.config.llmModel?.trim() || DEEPSEEK_DEFAULT_MODEL;
    }
    return this.config.llmModel?.trim() || null;
  }

  private baseUrl(): string {
    return this.config.llmProvider === "deepseek" ? DEEPSEEK_BASE_URL : this.config.llmBaseUrl ?? "";
  }

  private validBaseUrl(): boolean {
    if (this.config.llmProvider === "deepseek") return true;
    if (!this.config.llmBaseUrl) return false;
    try {
      if (this.config.llmProvider === "ollama") normalizeOllamaBaseUrl(this.config.llmBaseUrl);
      else validateLlmBaseUrl(this.config.llmBaseUrl);
      return true;
    } catch {
      return false;
    }
  }

  status(): LlmStatus {
    const model = this.effectiveModel();
    const validBaseUrl = this.validBaseUrl();
    const cloudReady = this.config.llmProvider !== "deepseek" || (this.config.llmCloudEnabled && Boolean(this.config.deepseekApiKey));
    return {
      enabled: this.config.llmEnabled,
      configured: Boolean(validBaseUrl && model && cloudReady),
      provider: this.config.llmProvider,
      baseUrl: this.baseUrl() || null,
      model,
      timeoutMs: this.config.llmTimeoutMs,
      localOnly: this.config.llmProvider !== "deepseek",
      cloudEnabled: this.config.llmCloudEnabled,
      apiKeyConfigured: Boolean(this.config.deepseekApiKey),
      maxInputChars: this.config.llmMaxInputChars,
      contextTokens: this.config.llmContextTokens,
      gpuLayers: this.config.llmGpuLayers,
      llamacppNcpuMoe: this.config.llamacppNcpuMoe,
      llamacppKvCache: this.config.llamacppKvCache,
      llamacppFlashAttn: this.config.llamacppFlashAttn,
      thinkingEffort: this.config.llmThinkingEffort
    };
  }

  private provider(requireEnabled: boolean, requireModel = true): LlmProviderAdapter {
    if (requireEnabled && !this.config.llmEnabled) {
      throw new LlmError("llm_disabled", "Local LLM summaries are disabled in Setup", 409);
    }
    if (!this.config.llmBaseUrl && this.config.llmProvider !== "deepseek") {
      throw new LlmError("llm_not_configured", "Set a model address in Setup first", 409);
    }
    if (requireModel && !this.effectiveModel()) {
      throw new LlmError("llm_not_configured", "Choose a model in Setup first", 409);
    }
    if (this.config.llmProvider === "ollama") return new OllamaProvider(this.config, this.fetchImpl);
    if (this.config.llmProvider === "deepseek") return new DeepSeekProvider(this.config, this.fetchImpl);
    if (this.config.llmProvider === "llamacpp") return new LocalOpenAiProvider(this.config, this.fetchImpl, "llamacpp");
    return new LocalOpenAiProvider(this.config, this.fetchImpl);
  }

  async listModels(): Promise<LlmModelInfo[]> {
    return this.provider(false, false).listModels();
  }

  async testConnection(): Promise<LlmConnectionTest> {
    const startedAtMs = Date.now();
    const provider = this.provider(false, false);
    const models = await provider.listModels();
    return {
      ok: true,
      provider: provider.id,
      latencyMs: Date.now() - startedAtMs,
      models: models.length
    };
  }

  async summarize(request: LlmChatRequest): Promise<LlmSummary> {
    const provider = this.provider(true);
    const startedAtMs = Date.now();
    const result = await provider.chat(request);
    return { text: result.text, model: result.model, elapsedMs: Date.now() - startedAtMs };
  }
}
