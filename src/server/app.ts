import crypto from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import fastifyCookie from "@fastify/cookie";
import fastifyMultipart from "@fastify/multipart";
import fastifyStatic from "@fastify/static";
import { generateDependencyReport } from "@discordjs/voice";
import type { AppConfig } from "./config.js";
import { APP_VERSION, ensureWebBuild } from "./config.js";
import { Store } from "./store.js";
import { SessionManager } from "./sessions.js";
import { DiscordService } from "./discord.js";
import { RecorderService } from "./recorder.js";
import { JobRunner } from "./jobs.js";
import { SseHub } from "./sse.js";
import { buildStatus } from "./status.js";
import { checkPythonHealth, type PythonHealth } from "./stt.js";
import { checkParakeetHealth, type ParakeetHealth } from "./parakeet.js";
import { listFoundryWorlds, findModulesDir } from "./foundryWorlds.js";
import { LlmService, LlmError, validateLlmBaseUrl, normalizeOllamaBaseUrl, DEEPSEEK_BASE_URL, type LlmSummary } from "./llm.js";
import { LlamaCppServer } from "./llamacpp.js";
import {
  SUMMARY_PROMPT_VERSION,
  SUMMARY_PRESETS,
  SUMMARY_CHUNK_SYSTEM,
  SUMMARY_COVERAGE_SCHEMA,
  SUMMARY_COVERAGE_SYSTEM,
  SUMMARY_FACTS_SCHEMA,
  SUMMARY_FACTS_SYSTEM,
  emptySummaryFacts,
  mergeSummaryFacts,
  parseSummaryFacts,
  summaryFactsBlock,
  parseStructuredSummary,
  summaryPreset,
  summaryScope,
  estimateTokens,
  summaryUserPrompt,
  summaryChunkCount,
  summaryInputCharBudget,
  trimSummaryBrief,
  SummaryFormatError
} from "../core/llmPrompts.js";
import { appendLlmSummary, listLlmSummaries } from "./llmHistory.js";
import { buildReviewAudio, ensureReviewWaveform, ReviewAudioError } from "./reviewAudio.js";
import {
  AudioStorageError,
  compactSessionAudio,
  measureSessionStorage,
  readAudioStorage,
  removeSessionAudio,
  reviewAudioReady
} from "./audioStorage.js";
import type {
  DiscordUtterance,
  FoundryEvent,
  FoundryLiveState,
  FoundryLiveStatus,
  JobType,
  LlmProvider,
  LlmSummaryRecord,
  LlmSummaryScope,
  Marker,
  MarkerKind,
  PeopleFile,
  Person,
  ReviewAudioManifest,
  RosterPerson,
  SessionRecord,
  SessionStatus,
  SystemRef,
  WorldRef
} from "../core/types.js";
import { OUTPUT_FILES } from "../core/render.js";
import { importFoundryExport } from "../core/foundry/import.js";
import { breakMarkerLabel, buildLiveFoundryEvents, normalizeLiveBreakEvents, normalizeLiveRoster, normalizeLiveState } from "../core/foundry/live.js";
import {
  appendJsonl,
  pathExists,
  readJson,
  readJsonl,
  resolveExistingInside,
  writeJsonAtomic
} from "../core/paths.js";
import { buildRecentContext, clampRecentSeconds, resolveRecentWindow } from "../core/recent.js";
import { mergeRecords } from "../core/merge.js";
import { buildSummaryLedger, splitNotesByHeadings, summaryNotesBlock } from "../core/summaryLedger.js";
import { personIsOptedOut } from "../core/consent.js";
import { personConsentStatus } from "../core/consent.js";
import { CONSENT_NOTICE_VERSION } from "../core/consent.js";
import { sessionCampaign } from "../core/campaign.js";
import { FOUNDRY_CONSENT_COMMAND_VERSION, versionAtLeast } from "../core/version.js";
import { readRecentSource } from "./recent.js";
import { createPlayerDraft, PlayerDraftError, playerDraftKind } from "./playerDrafts.js";

const SESSION_COOKIE = "tr_session";
const MAX_JSON_BODY = 1024 * 1024;
const MAX_UPLOAD = 64 * 1024 * 1024;
const MARKER_KINDS = new Set<MarkerKind>(["scene", "break", "combat", "note", "other"]);
const LIVE_ACTIVE_STATUSES = new Set<SessionStatus>(["joining", "recording", "stopping"]);
function insertFactUnderHeading(markdown: string, heading: string, fact: string): string {
  const headingPattern = new RegExp(`^##\\s*${heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*$`, "im");
  const match = headingPattern.exec(markdown);
  if (!match) return markdown;
  const start = match.index + match[0].length;
  const next = markdown.slice(start).search(/\n##\s+/);
  const insertAt = next < 0 ? markdown.length : start + next;
  const before = markdown.slice(0, insertAt).trimEnd();
  const after = markdown.slice(insertAt).replace(/^\n+/, "");
  return `${before}\n- ${fact}${after ? `\n\n${after}` : ""}`;
}

const LIVE_TARGET_STATUSES = new Set<SessionStatus>([
  "joining",
  "recording",
  "stopping",
  "captured",
  "processing",
  "ready",
  "error"
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function num(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function bool(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function statusAllowsLiveMarkers(status: SessionStatus): boolean {
  return status === "recording";
}

/** The latest "Break time called" marker that has no matching end after it. */
function openBreakStart(markers: Marker[]): Marker | null {
  let open: Marker | null = null;
  for (const marker of markers) {
    if (marker.kind !== "break") continue;
    if (/^break time called\b/i.test(marker.label)) open = marker;
    else if (/^break time over\b/i.test(marker.label)) open = null;
  }
  return open;
}

/** Serve audio with byte ranges so browser players can seek. */
async function streamMedia(
  request: FastifyRequest,
  reply: FastifyReply,
  file: string,
  contentType: string
): Promise<unknown> {
  const size = (await fsp.stat(file)).size;
  reply.header("Accept-Ranges", "bytes");
  reply.type(contentType);
  const range = request.headers.range;
  if (!range) {
    reply.header("Content-Length", String(size));
    return reply.send(fs.createReadStream(file));
  }
  const match = /^bytes=(\d*)-(\d*)$/.exec(range.trim());
  if (!match) {
    reply.code(416).header("Content-Range", `bytes */${size}`);
    return reply.send("Range Not Satisfiable");
  }
  const startText = match[1] ?? "";
  const endText = match[2] ?? "";
  let start: number;
  let end: number;
  if (!startText) {
    const suffix = Number(endText);
    if (!Number.isFinite(suffix) || suffix <= 0) {
      reply.code(416).header("Content-Range", `bytes */${size}`);
      return reply.send("Range Not Satisfiable");
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(startText);
    end = endText ? Number(endText) : size - 1;
  }
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start >= size || end < start) {
    reply.code(416).header("Content-Range", `bytes */${size}`);
    return reply.send("Range Not Satisfiable");
  }
  end = Math.min(end, size - 1);
  reply.code(206);
  reply.header("Content-Range", `bytes ${start}-${end}/${size}`);
  reply.header("Content-Length", String(end - start + 1));
  return reply.send(fs.createReadStream(file, { start, end }));
}

function liveRefConflict(payloadId: string | null, sessionId: string): boolean {
  if (!payloadId || payloadId === "unknown" || payloadId === "generic") return false;
  if (sessionId === "unknown" || sessionId === "generic") return false;
  return payloadId !== sessionId;
}

function apiError(code: string, message: string, statusCode = 400, details: unknown = {}): never {
  const error = new Error(message) as Error & { code: string; statusCode: number; details: unknown };
  error.code = code;
  error.statusCode = statusCode;
  error.details = details;
  throw error;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

interface ActiveTest {
  testId: string;
  startedAtMs: number;
  dir: string;
  timer: NodeJS.Timeout | null;
}

export interface PeopleDirectoryAppearance {
  sessionId: string;
  title: string;
  campaign: string;
  worldId: string;
  createdAtMs: number;
  role: Person["role"];
  character: string | null;
  consentStatus: "assumed" | "opted_in" | "opted_out";
  consentSource?: string;
}

export interface PeopleDirectoryEntry {
  key: string;
  discordUserId: string | null;
  discordName: string | null;
  foundryUserId: string | null;
  foundryUserName: string | null;
  characters: string[];
  roles: Array<Person["role"]>;
  consent: "assumed" | "opted_in" | "opted_out";
  games: string[];
  appearances: PeopleDirectoryAppearance[];
  profiles: RosterPerson[];
  lastActivityMs: number;
}

export class TableRecordsApp {
  readonly config: AppConfig;
  readonly fastify: FastifyInstance;
  readonly store: Store;
  readonly sessions: SessionManager;
  readonly discord: DiscordService;
  readonly recorder: RecorderService;
  readonly jobs: JobRunner;
  readonly llm: LlmService;
  readonly llamacpp: LlamaCppServer;
  readonly sse = new SseHub();
  readonly startedAtMs = Date.now();
  pythonHealth: PythonHealth | null = null;
  parakeetHealth: ParakeetHealth | null = null;
  currentSessionId: string | null = null;
  private activeTest: ActiveTest | null = null;
  private captureErrorHandling = false;
  private authAttempts = new Map<string, number[]>();
  private statusTimer: NodeJS.Timeout | null = null;
  private statusInFlight = false;
  private closing = false;
  private lastDecryptWarningAt = 0;
  private liveWriteQueue: Promise<void> = Promise.resolve();
  private bridgeToken = "";
  private liveEnabled = false;
  private playerDraftBusy = false;
  private liveMarkers = true;
  private bridgeStatus: FoundryLiveStatus = {
    enabled: false,
    markers: true,
    connected: false,
    lastSeenAtMs: null,
    moduleVersion: null,
    foundryVersion: null,
    world: null,
    system: null,
    scene: null,
    combat: null,
    paused: null,
    roster: null,
    targetSessionId: null,
    eventCount: 0,
    lastError: null
  };
  private bridgeCommands: Array<{
    id: string;
    type: "prompt_consent";
    createdAtMs: number;
    payload: Record<string, unknown>;
  }> = [];

  constructor(config: AppConfig) {
    this.config = config;
    const logLevel = process.env.LOG_LEVEL ?? "info";
    this.fastify = Fastify({
      logger: logLevel === "silent" ? false : { level: logLevel },
      bodyLimit: MAX_JSON_BODY,
      trustProxy: false
    });
    this.store = new Store(config.dbFile);
    this.sessions = new SessionManager(config, this.store);
    this.discord = new DiscordService(config);
    this.recorder = new RecorderService(config, this.discord);
    this.jobs = new JobRunner(config, this.store, this.sessions, (event, data) => this.sse.broadcast(event, data));
    this.llm = new LlmService(config);
    this.llamacpp = new LlamaCppServer(config);
  }

  cookieValue(): string | null {
    if (!this.config.dashboardToken) return null;
    return crypto.createHmac("sha256", this.config.dashboardToken).update("tablerecords-session-v1").digest("hex");
  }

  authRequired(): boolean {
    return Boolean(this.config.dashboardToken);
  }

  private ensureBridgeSettings(): void {
    const storedToken = this.store.getSetting<string | null>("foundry_bridge_token", null);
    const envToken = this.config.foundryBridgeToken?.trim() || null;
    this.bridgeToken = envToken ?? storedToken ?? crypto.randomBytes(24).toString("hex");
    if (!storedToken || storedToken !== this.bridgeToken) {
      this.store.setSetting("foundry_bridge_token", this.bridgeToken);
    }
    this.liveEnabled = this.store.getSetting<boolean>("foundry_live_enabled", false) === true;
    this.liveMarkers = this.store.getSetting<boolean>("foundry_live_markers", true) !== false;
    const storedStatus = this.store.getSetting<Partial<FoundryLiveStatus> | null>("foundry_live_status", null);
    if (storedStatus && typeof storedStatus === "object") {
      this.bridgeStatus = {
        ...this.bridgeStatus,
        ...storedStatus,
        enabled: this.liveEnabled,
        markers: this.liveMarkers,
        connected: false,
        targetSessionId: null,
        eventCount: 0,
        lastError: storedStatus.lastError ?? null
      };
    }
  }

  private async acquireLiveLock(): Promise<() => void> {
    let release: () => void = () => undefined;
    const previous = this.liveWriteQueue;
    this.liveWriteQueue = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    return release;
  }

  private queueBridgeCommand(type: "prompt_consent", payload: Record<string, unknown>): void {
    if (this.bridgeCommands.length >= 20) this.bridgeCommands.shift();
    this.bridgeCommands.push({
      id: `cmd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      createdAtMs: Date.now(),
      payload
    });
  }

  private liveStatusSnapshot(): FoundryLiveStatus {
    return {
      ...this.bridgeStatus,
      enabled: this.liveEnabled,
      markers: this.liveMarkers,
      connected: Boolean(
        this.liveEnabled &&
          this.bridgeStatus.lastSeenAtMs &&
          this.bridgeStatus.lastSeenAtMs >= this.startedAtMs &&
          Date.now() - this.bridgeStatus.lastSeenAtMs < 180_000
      )
    };
  }

  private saveBridgeStatus(): void {
    this.store.setSetting("foundry_live_status", {
      ...this.bridgeStatus,
      enabled: this.liveEnabled,
      markers: this.liveMarkers,
      connected: false
    });
  }

  private bridgeTokenManagedByEnv(): boolean {
    return Boolean(this.config.foundryBridgeToken?.trim());
  }

  private foundryPath(): string | null {
    const setting = this.store.getSetting<string | null>("foundry_data_path", this.config.foundryDataPath);
    return setting ?? this.config.foundryDataPath;
  }

  private async buildStatus(): Promise<ReturnType<typeof buildStatus>> {
    return buildStatus({
      config: this.config,
      store: this.store,
      sessions: this.sessions,
      discord: this.discord,
      recorder: this.recorder,
      pythonHealth: this.pythonHealth,
      parakeetHealth: this.parakeetHealth,
      startedAtMs: this.startedAtMs,
      currentSessionId: this.currentSessionId,
      foundryLive: this.liveStatusSnapshot()
    });
  }

  async emitStatus(): Promise<void> {
    if (this.closing || this.statusInFlight) return;
    this.statusInFlight = true;
    try {
      const status = await this.buildStatus();
      this.discord.updateActivityContext({
        recording: status.capture.state === "recording" && !status.capture.testId,
        testing: Boolean(status.capture.testId) && status.capture.state === "recording",
        processing: status.jobs.active != null,
        title: status.session.title,
        channel: status.voice.channelName
      });
      if (!this.closing) this.sse.broadcast("status", status);
    } catch (error) {
      if (!this.closing) this.fastify.log.warn({ err: error }, "status snapshot failed");
    } finally {
      this.statusInFlight = false;
    }
  }

  private startStatusLoop(): void {
    const tick = async () => {
      if (this.closing) return;
      await this.emitStatus();
      if (this.closing) return;
      const active = this.recorder.isActive() || this.store.activeJob() !== null;
      this.statusTimer = setTimeout(tick, active ? 1000 : 10_000);
      this.statusTimer.unref?.();
    };
    void tick();
  }

  private wireEvents(): void {
    this.discord.on("status", () => void this.emitStatus());
    this.discord.on("voice", () => void this.emitStatus());
    this.discord.on("voiceState", () => void this.emitStatus());
    this.discord.on("decryptDebug", (message: string) => {
      this.recorder.noteDecryptionFailure(message);
      const now = Date.now();
      if (now - this.lastDecryptWarningAt > 5000) {
        this.lastDecryptWarningAt = now;
        this.sse.broadcast("warning", { code: "decryption_failure", message });
      }
    });
    this.recorder.on("state", () => void this.emitStatus());
    this.recorder.on("utterance", () => {
      void this.emitStatus();
    });
    this.recorder.on("decryptionFailure", (info: { userId: string; message: string }) => {
      const now = Date.now();
      if (now - this.lastDecryptWarningAt > 5000) {
        this.lastDecryptWarningAt = now;
        this.sse.broadcast("warning", {
          code: "decryption_failure",
          message: `Decryption failure for ${info.userId}: ${info.message}`
        });
      }
    });
    this.recorder.on("captureWarning", (message: string) => {
      this.sse.broadcast("warning", { code: "capture_warning", message });
    });
    this.recorder.on("captureError", (message: string) => {
      void this.handleCaptureError(message);
    });
  }

  private async handleCaptureError(message: string): Promise<void> {
    if (this.captureErrorHandling) return;
    this.captureErrorHandling = true;
    try {
      const sessionId = this.recorder.activeSessionId;
      const isTest = this.recorder.diagnostics().testId !== null;
      if (isTest && this.activeTest) {
        if (this.activeTest.timer) clearTimeout(this.activeTest.timer);
        this.activeTest = null;
      }
      if (sessionId && !isTest) {
        const session = await this.sessions.get(sessionId).catch(() => null);
        if (session) {
          await this.recorder.stop("manual").catch(() => undefined);
          const refreshed = await this.sessions.refreshRecordingStats(sessionId).catch(() => session);
          await this.sessions
            .setStatus(refreshed, "error", {
              stoppedAtMs: Date.now(),
              notes: `${refreshed.notes ?? ""}\nCapture error: ${message}`.trim()
            })
            .catch(() => undefined);
          this.sse.broadcast("warning", { code: "capture_stopped", message });
          this.sse.broadcast("session.updated", { sessionId, status: "error", error: message });
        }
      }
      this.discord.leave();
      await this.emitStatus();
    } finally {
      this.captureErrorHandling = false;
    }
  }

  private async refreshPythonHealth(): Promise<PythonHealth> {
    this.pythonHealth = await checkPythonHealth(this.config);
    this.parakeetHealth = await checkParakeetHealth(this.config);
    return this.pythonHealth;
  }

  private doctorChecks(): Array<{ id: string; label: string; status: string; detail: string; hint?: string }> {
    const llmStatus = this.llm.status();
    const worldsPath = this.foundryPath();
    const probe = path.join(this.config.sessionsDir, `.write-test-${process.pid}`);
    let sessionsWritable = false;
    try {
      fs.writeFileSync(probe, "ok", "utf8");
      fs.unlinkSync(probe);
      sessionsWritable = true;
    } catch {
      sessionsWritable = false;
      try {
        fs.unlinkSync(probe);
      } catch {
        // ignore
      }
    }
    const checks: Array<{ id: string; label: string; status: string; detail: string; hint?: string }> = [
      {
        id: "server",
        label: "Local server",
        status: "ok",
        detail: `Listening on http://${this.config.host}:${this.config.port} (loopback only)`
      },
      {
        id: "dashboard_token",
        label: "Dashboard auth",
        status: this.config.dashboardToken ? "ok" : "info",
        detail: this.config.dashboardToken ? "Dashboard token is on. The browser keeps a signed-in session." : "No dashboard token; loopback access is trusted."
      },
      {
        id: "discord_token",
        label: "Discord bot token",
        status: this.discord.configured ? "ok" : "error",
        detail: this.discord.configured ? "DISCORD_TOKEN is configured (value never displayed)." : "DISCORD_TOKEN is missing.",
        hint: this.discord.configured ? undefined : "Create a dedicated bot, enable Guilds + GuildVoiceStates, invite it, and put the token in .env."
      },
      {
        id: "discord_login",
        label: "Discord login",
        status: this.discord.botStatus().state === "ready" ? "ok" : this.discord.configured ? "warning" : "error",
        detail: this.discord.botStatus().error ?? `Bot state: ${this.discord.botStatus().state}`,
        hint: this.discord.botStatus().state === "ready" ? undefined : "Check the token, network, and that the bot is invited to the guild."
      },
      {
        id: "web_build",
        label: "Dashboard build",
        status: ensureWebBuild(this.config) ? "ok" : "warning",
        detail: ensureWebBuild(this.config) ? "dist/web/index.html is present." : "dist/web/index.html is missing.",
        hint: ensureWebBuild(this.config) ? undefined : "Run npm run build:web."
      },
      {
        id: "foundry_path",
        label: "Foundry data path",
        status: worldsPath && fs.existsSync(worldsPath) ? "ok" : "warning",
        detail: worldsPath ? `Configured path: ${worldsPath}` : "FOUNDRY_DATA_PATH is not configured.",
        hint: worldsPath && fs.existsSync(worldsPath) ? undefined : "Set FOUNDRY_DATA_PATH to the FoundryVTT data root, or edit it in Settings."
      },
      {
        id: "python",
        label: "Whisper (faster-whisper) STT",
        status: this.pythonHealth?.available
          ? this.pythonHealth.error
            ? "warning"
            : "ok"
          : this.config.sttEngine === "faster-whisper"
            ? "warning"
            : "info",
        detail: this.pythonHealth
          ? this.pythonHealth.error ?? `Python ${this.pythonHealth.pythonVersion ?? "?"}; faster-whisper ${this.pythonHealth.fasterWhisper ?? "?"}; CUDA devices ${this.pythonHealth.cudaDeviceCount ?? 0}; model ${this.pythonHealth.modelPresent ? "cached" : "not cached"}`
          : "Not checked yet; run the doctor.",
        hint:
          this.pythonHealth?.available && !this.pythonHealth.error
            ? undefined
            : "Run npm run setup:python; use CPU mode if CUDA is unavailable."
      },
      {
        id: "parakeet",
        label: "Parrot (Parakeet) STT",
        status: this.parakeetHealth?.available
          ? "ok"
          : this.config.sttEngine === "parakeet"
            ? "warning"
            : "info",
        detail: this.parakeetHealth
          ? this.parakeetHealth.error ?? `nemo-speech ${this.parakeetHealth.version ?? "?"}; model ${this.parakeetHealth.modelPresent ? path.basename(this.parakeetHealth.modelPath) : "missing"}`
          : "Not checked yet; run the doctor.",
        hint:
          this.config.sttEngine === "parakeet"
            ? "Set the nemo-speech path and model in Setup → Transcription, or switch to Whisper."
            : "Optional alternate engine."
      },
      {
        id: "stt_active",
        label: "Active transcription engine",
        status: (() => {
          const ready =
            this.config.sttEngine === "parakeet"
              ? this.parakeetHealth?.available === true
              : this.pythonHealth?.available === true;
          return ready ? "ok" : "warning";
        })(),
        detail:
          this.config.sttEngine === "parakeet"
            ? `Parrot (Parakeet) · ${path.basename(this.config.parakeetModel)} · ${this.config.parakeetDevice} · concurrency ${this.config.parakeetConcurrency}`
            : `Whisper (faster-whisper) · ${this.config.sttModel} · ${this.config.sttDevice}/${this.config.sttComputeType} · beam ${this.config.sttBeamSize}`,
        hint:
          this.config.sttEngine === "parakeet"
            ? "If this is not ready, open Setup → Transcription and choose Whisper, or run npm run setup:python."
            : "If this is not ready, run npm run setup:python or choose Parrot in Setup → Transcription."
      },
      {
        id: "llm",
        label: "AI summaries",
        status: !llmStatus.enabled || llmStatus.configured ? "info" : "warning",
        detail: !llmStatus.enabled
          ? "Off. Summaries are optional and stay local unless DeepSeek is chosen."
          : llmStatus.configured
            ? `Configured: ${llmStatus.provider === "deepseek" ? "DeepSeek cloud" : llmStatus.provider === "ollama" ? "Ollama" : llmStatus.provider === "llamacpp" ? "llama.cpp" : "Local server"} · ${llmStatus.model}${llmStatus.provider === "ollama" || llmStatus.provider === "llamacpp" ? ` · ${llmStatus.contextTokens.toLocaleString()} context tokens · reasoning ${llmStatus.thinkingEffort}${llmStatus.gpuLayers == null ? " · automatic GPU layers" : ` · ${llmStatus.gpuLayers} GPU layers`}` : ""}. Connection and generation have not been checked by the doctor.`
            : "Enabled, but the provider settings are incomplete.",
        hint: !llmStatus.enabled
          ? "Turn it on in Setup → AI summary when you want recaps."
          : "Open Setup → AI summary and test the connection. Generate a sample recap to check the selected model."
      },
      {
        id: "llamacpp",
        label: "llama.cpp server",
        status:
          llmStatus.provider !== "llamacpp"
            ? "info"
            : this.llamacpp.snapshot().state === "running" || this.llamacpp.snapshot().state === "external"
              ? "ok"
              : this.llamacpp.snapshot().state === "error"
                ? "warning"
                : "info",
        detail:
          llmStatus.provider !== "llamacpp"
            ? "Optional. Choose llama.cpp in Setup to use it."
            : `${this.llamacpp.snapshot().state}${this.llamacpp.snapshot().lastError ? `: ${this.llamacpp.snapshot().lastError}` : ""}`,
        hint:
          llmStatus.provider !== "llamacpp"
            ? undefined
            : this.llamacpp.snapshot().state === "stopped"
              ? "Choose the executable and model file, then start the server."
              : undefined
      },
      {
        id: "dave",
        label: "Discord voice dependencies",
        status: "info",
        detail:
          generateDependencyReport()
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) => line && !/^-+$/.test(line))
            .slice(0, 5)
            .join(" · ") || "Dependency report available"
      },
      {
        id: "sessions_dir",
        label: "Session storage",
        status: sessionsWritable ? "ok" : "error",
        detail: `${this.config.sessionsDir} (${sessionsWritable ? "writable" : "not writable"})`,
        hint: sessionsWritable ? undefined : "Check the directory permissions or move SESSIONS_DIR."
      }
    ];
    return checks;
  }

  async init(): Promise<void> {
    this.applyStoredSettings();
    this.ensureBridgeSettings();
    const recovery = await this.sessions.reconcileOnStartup();
    this.store.seedRosterFromPeople();
    this.wireEvents();
    this.registerPlugins();
    this.registerHooks();
    this.registerRoutes();
    await this.registerStatic();
    this.startStatusLoop();
    await this.llamacpp.cleanupStale();
    if (this.config.llamacppAutostart && this.config.llmProvider === "llamacpp") {
      void this.llamacpp.start().catch((error) => {
        this.fastify.log.warn({ err: error }, "Could not autostart llama-server");
      });
    }
    void this.refreshPythonHealth().then(() => this.emitStatus());
    void this.discord.start();
    const all = await this.sessions.list();
    this.currentSessionId = all.find((session) => !session.archived)?.sessionId ?? all[0]?.sessionId ?? null;
    for (const sessionId of recovery.needsProcessing) {
      void this.jobs.enqueue(sessionId, "run_all").catch((error) => {
        this.fastify.log.warn({ err: error, sessionId }, "Could not auto-process recovered session");
      });
    }
  }

  /**
   * Validate the whole settings payload before writing anything. The route used
   * to update fields as it walked the body, so a bad field near the end could
   * leave earlier fields partially saved.
   */
  private validateSettingsBody(body: Record<string, unknown>): void {
    if ("foundryDataPath" in body) {
      const value = body.foundryDataPath;
      if (value !== null && typeof value !== "string") apiError("invalid_foundry_path", "That Foundry folder path is not valid.");
      if (typeof value === "string" && value.trim()) {
        let isDirectory = false;
        try {
          isDirectory = fs.statSync(value.trim()).isDirectory();
        } catch {
          isDirectory = false;
        }
        if (!isDirectory) apiError("foundry_path_missing", `Foundry data path does not exist: ${value.trim()}`);
      }
    }
    if ("discordBotName" in body) {
      const value = body.discordBotName;
      if (typeof value !== "string") apiError("invalid_bot_name", "That bot name is not valid text.");
      if (value.trim().length > 32) apiError("invalid_bot_name", "The bot name is too long. 32 characters is the limit.");
    }
    if ("discordActivityType" in body) {
      const value = str(body.discordActivityType);
      if (!["playing", "listening", "watching", "competing"].includes(value ?? "")) {
        apiError("invalid_activity_type", "Pick an activity type: playing, listening, watching, or competing.");
      }
    }
    if ("discordActivityText" in body) {
      const value = body.discordActivityText;
      if (typeof value !== "string") apiError("invalid_activity_text", "That activity line is not valid text.");
      if (value.trim().length > 128) apiError("invalid_activity_text", "That activity line is too long. 128 characters is the limit.");
    }
    if ("discordActivityDynamic" in body && bool(body.discordActivityDynamic) == null) {
      apiError("invalid_activity_dynamic", "That option needs to be on or off.");
    }
    if ("sttEngine" in body) {
      const value = str(body.sttEngine)?.toLowerCase();
      if (value !== "parakeet" && value !== "parrot" && value !== "whisper" && value !== "faster-whisper") {
        apiError("invalid_engine", "Pick Parrot or Whisper as the engine.");
      }
    }
    if ("sttModel" in body && !str(body.sttModel)) apiError("invalid_model", "Choose a Whisper model.");
    if ("sttDevice" in body) {
      const value = str(body.sttDevice);
      if (value !== "cuda" && value !== "cpu") apiError("invalid_device", "Pick CUDA or CPU.");
    }
    if ("sttComputeType" in body && !str(body.sttComputeType)) apiError("invalid_compute_type", "Pick a compute type.");
    if ("sttLanguage" in body && !str(body.sttLanguage)) apiError("invalid_language", "Pick a spoken language.");
    if ("sttBeamSize" in body) {
      const value = num(body.sttBeamSize);
      if (value == null || value < 1 || value > 10) apiError("invalid_beam_size", "Beam size runs from 1 to 10.");
    }
    if ("sttVadFilter" in body && bool(body.sttVadFilter) == null) apiError("invalid_vad_filter", "That option needs to be on or off.");
    if ("sttNoSpeechThreshold" in body) {
      const value = num(body.sttNoSpeechThreshold);
      if (value == null || value < 0 || value > 1) apiError("invalid_no_speech_threshold", "The no-speech threshold runs from 0 to 1.");
    }
    if ("sttLogProbThreshold" in body) {
      const value = num(body.sttLogProbThreshold);
      if (value == null || value < -5 || value > 0) apiError("invalid_logprob_threshold", "The log-probability threshold runs from -5 to 0.");
    }
    if ("sttCompressionRatioThreshold" in body) {
      const value = num(body.sttCompressionRatioThreshold);
      if (value == null || value < 1 || value > 10) {
        apiError("invalid_compression_threshold", "The compression-ratio threshold runs from 1 to 10.");
      }
    }
    if ("sttPromptExtra" in body && typeof body.sttPromptExtra !== "string") {
      apiError("invalid_prompt_extra", "That extra prompt is not valid text.");
    }
    if ("sttHotwordsExtra" in body && typeof body.sttHotwordsExtra !== "string") {
      apiError("invalid_hotwords_extra", "Those hotwords are not valid text.");
    }
    if ("parakeetPath" in body && !str(body.parakeetPath)) apiError("invalid_parakeet_path", "Point at the nemo-speech runtime.");
    if ("parakeetModel" in body && !str(body.parakeetModel)) apiError("invalid_parakeet_model", "Choose a Parrot model.");
    if ("parakeetDevice" in body) {
      const value = str(body.parakeetDevice);
      if (value !== "cuda" && value !== "cpu") apiError("invalid_parakeet_device", "Pick CUDA or CPU.");
    }
    if ("parakeetConcurrency" in body) {
      const value = num(body.parakeetConcurrency);
      if (value == null || value < 1 || value > 16) {
        apiError("invalid_parakeet_concurrency", "Concurrency runs from 1 to 16.");
      }
    }
    if ("rollContextBeforeMs" in body) {
      const value = num(body.rollContextBeforeMs);
      if (value == null || value < 0 || value > 300_000) apiError("invalid_roll_context", "Speech before a roll can be 0 to 300 seconds.");
    }
    if ("rollContextAfterMs" in body) {
      const value = num(body.rollContextAfterMs);
      if (value == null || value < 0 || value > 300_000) apiError("invalid_roll_context", "Speech after a roll can be 0 to 300 seconds.");
    }
    if ("recentContextSeconds" in body) {
      const value = num(body.recentContextSeconds);
      if (value == null || value < 15 || value > 1800) apiError("invalid_recent_context", "The brief can cover 15 to 1,800 seconds.");
    }
    if ("llmEnabled" in body && bool(body.llmEnabled) == null) apiError("invalid_llm_enabled", "That option needs to be on or off.");
    let providerForValidation: LlmProvider = this.config.llmProvider;
    if ("llmProvider" in body) {
      const value = str(body.llmProvider);
      if (value !== "ollama" && value !== "llamacpp" && value !== "deepseek" && value !== "local") {
        apiError("invalid_llm_provider", "Pick llama.cpp, Ollama, DeepSeek, or a local OpenAI-compatible server.");
      }
      providerForValidation = value;
    }
    if ("llmBaseUrl" in body && providerForValidation !== "deepseek") {
      const raw = str(body.llmBaseUrl);
      if (raw) {
        if (providerForValidation === "ollama") normalizeOllamaBaseUrl(raw);
        else validateLlmBaseUrl(raw);
      }
    }
    if ("llmCloudEnabled" in body && bool(body.llmCloudEnabled) == null) {
      apiError("invalid_llm_cloud", "That option needs to be on or off.");
    }
    if ("llmMaxInputChars" in body) {
      const value = num(body.llmMaxInputChars);
      if (value == null || value < 4_000 || value > 200_000) {
        apiError("invalid_llm_max_input", "The summary input limit runs from 4,000 to 200,000 characters.");
      }
    }
    if ("llmTimeoutMs" in body) {
      const value = num(body.llmTimeoutMs);
      if (value == null || value < 5000 || value > 300000) apiError("invalid_llm_timeout", "The timeout runs from 5 to 300 seconds.");
    }
    if ("llmContextTokens" in body) {
      const value = num(body.llmContextTokens);
      if (value == null || value < 4_096 || value > 131_072) {
        apiError("invalid_llm_context", "The context window runs from 4,096 to 131,072 tokens.");
      }
    }
    if ("llmThinkingEffort" in body) {
      const value = str(body.llmThinkingEffort);
      if (value !== "off" && value !== "low" && value !== "medium" && value !== "high") {
        apiError("invalid_llm_thinking", "Pick off, low, medium, or high for reasoning effort.");
      }
    }
    if ("llamacppNcpuMoe" in body) {
      const value = num(body.llamacppNcpuMoe);
      if (value == null || value < 0 || value > 999 || !Number.isInteger(value)) {
        apiError("invalid_llamacpp_ncpu_moe", "Use a whole number of MoE layers from 0 to 999.");
      }
    }
    if ("llamacppKvCache" in body) {
      const value = str(body.llamacppKvCache);
      if (value !== "f16" && value !== "q8_0" && value !== "q4_0") {
        apiError("invalid_llamacpp_kv", "Pick f16, q8_0, or q4_0 for the KV cache.");
      }
    }
    if ("llamacppFlashAttn" in body && bool(body.llamacppFlashAttn) == null) {
      apiError("invalid_llamacpp_flash", "That option needs to be on or off.");
    }
    if ("llamacppExe" in body) {
      const value = str(body.llamacppExe);
      if (!value || value.length > 1_000) apiError("invalid_llamacpp_exe", "Choose the llama-server executable.");
      if ((value.includes("\\") || value.includes("/")) && (!fs.existsSync(value) || !fs.statSync(value).isFile())) {
        apiError("llamacpp_exe_missing", "The llama-server executable could not be found. Check the path and try again.");
      }
    }
    if ("llamacppModelPath" in body && body.llamacppModelPath != null) {
      const value = str(body.llamacppModelPath);
      if (!value || value.length > 1_000) apiError("invalid_llamacpp_model", "Choose the model file for llama.cpp.");
      if (!fs.existsSync(value) || !fs.statSync(value).isFile()) {
        apiError("llamacpp_model_missing", "The model file could not be found. Check the path and try again.");
      }
    }
    if ("llamacppPort" in body) {
      const value = num(body.llamacppPort);
      if (value == null || value < 1 || value > 65_535 || !Number.isInteger(value)) {
        apiError("invalid_llamacpp_port", "The llama-server port runs from 1 to 65,535.");
      }
    }
    if ("llamacppAutostart" in body && bool(body.llamacppAutostart) == null) {
      apiError("invalid_llamacpp_autostart", "That option needs to be on or off.");
    }
    if ("llmGpuLayers" in body && body.llmGpuLayers != null) {
      const value = num(body.llmGpuLayers);
      if (value == null || value < 0 || value > 999 || !Number.isInteger(value)) {
        apiError("invalid_llm_gpu_layers", "Use a whole number of video card layers from 0 to 999, or leave it automatic.");
      }
    }
    if ("foundryLiveEnabled" in body && bool(body.foundryLiveEnabled) == null) {
      apiError("invalid_live_enabled", "That option needs to be on or off.");
    }
    if ("foundryLiveMarkers" in body && bool(body.foundryLiveMarkers) == null) {
      apiError("invalid_live_markers", "That option needs to be on or off.");
    }
  }

  private applyStoredSettings(): void {    const foundry = this.store.getSetting<string | null>("foundry_data_path", null);
    if (foundry) this.config.foundryDataPath = foundry;
    const guild = this.store.getSetting<string | null>("default_guild_id", null);
    if (guild) this.config.defaultGuildId = guild;
    const botName = this.store.getSetting<string | null>("discord_bot_name", null);
    if (typeof botName === "string") this.config.discordBotName = botName;
    const activityType = this.store.getSetting<string | null>("discord_activity_type", null);
    if (["playing", "listening", "watching", "competing"].includes(activityType ?? "")) {
      this.config.discordActivityType = activityType as AppConfig["discordActivityType"];
    }
    const activityText = this.store.getSetting<string | null>("discord_activity_text", null);
    if (typeof activityText === "string") this.config.discordActivityText = activityText;
    const activityDynamic = this.store.getSetting<boolean | null>("discord_activity_dynamic", null);
    if (typeof activityDynamic === "boolean") this.config.discordActivityDynamic = activityDynamic;
    const model = this.store.getSetting<string | null>("stt_model", null);
    if (model) this.config.sttModel = model;
    const device = this.store.getSetting<string | null>("stt_device", null);
    if (device === "cuda" || device === "cpu") this.config.sttDevice = device;
    const computeType = this.store.getSetting<string | null>("stt_compute_type", null);
    if (computeType) this.config.sttComputeType = computeType;
    const language = this.store.getSetting<string | null>("stt_language", null);
    if (language) this.config.sttLanguage = language;
    const engine = this.store.getSetting<string | null>("stt_engine", null);
    if (engine === "parakeet" || engine === "faster-whisper") this.config.sttEngine = engine;
    const parakeetPath = this.store.getSetting<string | null>("parakeet_path", null);
    if (parakeetPath) this.config.parakeetPath = parakeetPath;
    const parakeetModel = this.store.getSetting<string | null>("parakeet_model", null);
    if (parakeetModel) this.config.parakeetModel = parakeetModel;
    const parakeetDevice = this.store.getSetting<string | null>("parakeet_device", null);
    if (parakeetDevice === "cuda" || parakeetDevice === "cpu") this.config.parakeetDevice = parakeetDevice;
    const parakeetConcurrency = this.store.getSetting<number | null>("parakeet_concurrency", null);
    if (typeof parakeetConcurrency === "number" && parakeetConcurrency >= 1 && parakeetConcurrency <= 16) {
      this.config.parakeetConcurrency = Math.trunc(parakeetConcurrency);
    }
    const beamSize = this.store.getSetting<number | null>("stt_beam_size", null);
    if (typeof beamSize === "number" && beamSize >= 1 && beamSize <= 10) this.config.sttBeamSize = Math.trunc(beamSize);
    const vadFilter = this.store.getSetting<boolean | null>("stt_vad_filter", null);
    if (typeof vadFilter === "boolean") this.config.sttVadFilter = vadFilter;
    const noSpeech = this.store.getSetting<number | null>("stt_no_speech_threshold", null);
    if (typeof noSpeech === "number" && noSpeech >= 0 && noSpeech <= 1) this.config.sttNoSpeechThreshold = noSpeech;
    const logProb = this.store.getSetting<number | null>("stt_log_prob_threshold", null);
    if (typeof logProb === "number" && logProb >= -5 && logProb <= 0) this.config.sttLogProbThreshold = logProb;
    const compression = this.store.getSetting<number | null>("stt_compression_ratio_threshold", null);
    if (typeof compression === "number" && compression >= 1 && compression <= 10) {
      this.config.sttCompressionRatioThreshold = compression;
    }
    const promptExtra = this.store.getSetting<string | null>("stt_prompt_extra", null);
    if (typeof promptExtra === "string") this.config.sttPromptExtra = promptExtra;
    const hotwordsExtra = this.store.getSetting<string | null>("stt_hotwords_extra", null);
    if (typeof hotwordsExtra === "string") this.config.sttHotwordsExtra = hotwordsExtra;
    const rollBefore = this.store.getSetting<number | null>("roll_context_before_ms", null);
    if (typeof rollBefore === "number" && rollBefore >= 0 && rollBefore <= 300_000) this.config.rollContextBeforeMs = Math.trunc(rollBefore);
    const rollAfter = this.store.getSetting<number | null>("roll_context_after_ms", null);
    if (typeof rollAfter === "number" && rollAfter >= 0 && rollAfter <= 300_000) this.config.rollContextAfterMs = Math.trunc(rollAfter);
    const recentSeconds = this.store.getSetting<number | null>("recent_context_seconds", null);
    if (typeof recentSeconds === "number" && recentSeconds >= 15 && recentSeconds <= 1800) {
      this.config.recentContextSeconds = Math.trunc(recentSeconds);
    }
    const llmEnabled = this.store.getSetting<boolean | null>("llm_enabled", null);
    if (typeof llmEnabled === "boolean") this.config.llmEnabled = llmEnabled;
    const llmBaseUrl = this.store.getSetting<string | null>("llm_base_url", null);
    if (typeof llmBaseUrl === "string") this.config.llmBaseUrl = llmBaseUrl || null;
    const llmModel = this.store.getSetting<string | null>("llm_model", null);
    if (typeof llmModel === "string") this.config.llmModel = llmModel || null;
    const llmProvider = this.store.getSetting<string | null>("llm_provider", null);
    if (llmProvider === "ollama" || llmProvider === "llamacpp" || llmProvider === "deepseek" || llmProvider === "local") {
      this.config.llmProvider = llmProvider;
    }
    const llmCloudEnabled = this.store.getSetting<boolean | null>("llm_cloud_enabled", null);
    if (typeof llmCloudEnabled === "boolean") this.config.llmCloudEnabled = llmCloudEnabled;
    const llmMaxInputChars = this.store.getSetting<number | null>("llm_max_input_chars", null);
    if (typeof llmMaxInputChars === "number" && llmMaxInputChars >= 4_000 && llmMaxInputChars <= 200_000) {
      this.config.llmMaxInputChars = Math.trunc(llmMaxInputChars);
    }
    const llmTimeoutMs = this.store.getSetting<number | null>("llm_timeout_ms", null);
    if (typeof llmTimeoutMs === "number" && llmTimeoutMs >= 5000 && llmTimeoutMs <= 300000) {
      this.config.llmTimeoutMs = Math.trunc(llmTimeoutMs);
    }
    const llmContextTokens = this.store.getSetting<number | null>("llm_context_tokens", null);
    if (typeof llmContextTokens === "number" && llmContextTokens >= 4096 && llmContextTokens <= 131072) {
      this.config.llmContextTokens = Math.trunc(llmContextTokens);
    }
    const llmThinkingEffort = this.store.getSetting<string | null>("llm_thinking_effort", null);
    if (llmThinkingEffort === "off" || llmThinkingEffort === "low" || llmThinkingEffort === "medium" || llmThinkingEffort === "high") {
      this.config.llmThinkingEffort = llmThinkingEffort;
    }
    const llmGpuLayers = this.store.getSetting<number | null>("llm_gpu_layers", -1);
    if (llmGpuLayers !== -1) {
      this.config.llmGpuLayers =
        llmGpuLayers == null
          ? null
          : Number.isInteger(llmGpuLayers) && llmGpuLayers >= 0 && llmGpuLayers <= 999
            ? llmGpuLayers
            : this.config.llmGpuLayers;
    }
    const llamacppNcpuMoe = this.store.getSetting<number | null>("llamacpp_n_cpu_moe", null);
    if (typeof llamacppNcpuMoe === "number" && Number.isInteger(llamacppNcpuMoe) && llamacppNcpuMoe >= 0 && llamacppNcpuMoe <= 999) {
      this.config.llamacppNcpuMoe = llamacppNcpuMoe;
    }
    const llamacppKvCache = this.store.getSetting<string | null>("llamacpp_kv_cache", null);
    if (llamacppKvCache === "f16" || llamacppKvCache === "q8_0" || llamacppKvCache === "q4_0") {
      this.config.llamacppKvCache = llamacppKvCache;
    }
    const llamacppFlashAttn = this.store.getSetting<boolean | null>("llamacpp_flash_attn", null);
    if (typeof llamacppFlashAttn === "boolean") this.config.llamacppFlashAttn = llamacppFlashAttn;
    const llamacppExe = this.store.getSetting<string | null>("llamacpp_exe", null);
    if (llamacppExe) this.config.llamacppExe = llamacppExe;
    const llamacppModelPath = this.store.getSetting<string | null>("llamacpp_model_path", null);
    if (llamacppModelPath !== null) this.config.llamacppModelPath = llamacppModelPath || null;
    const llamacppPort = this.store.getSetting<number | null>("llamacpp_port", null);
    if (typeof llamacppPort === "number" && llamacppPort >= 1 && llamacppPort <= 65_535) {
      this.config.llamacppPort = llamacppPort;
    }
    const llamacppAutostart = this.store.getSetting<boolean | null>("llamacpp_autostart", null);
    if (typeof llamacppAutostart === "boolean") this.config.llamacppAutostart = llamacppAutostart;
    const testSeconds = this.store.getSetting<number | null>("capture_test_max_seconds", null);
    if (typeof testSeconds === "number" && testSeconds >= 5 && testSeconds <= 600) {
      this.config.captureTestMaxSeconds = Math.trunc(testSeconds);
    }
  }

  private registerPlugins(): void {
    void this.fastify.register(fastifyCookie);
    void this.fastify.register(fastifyMultipart, {
      limits: { fileSize: MAX_UPLOAD, files: 1, fields: 10, parts: 12 }
    });
    // Fastify rejects an empty JSON body by default. A few commands (doctor,
    // module install, capture-test stop) intentionally post no body, so treat
    // that as an empty object instead of a 400.
    this.fastify.addContentTypeParser("application/json", { parseAs: "string" }, (_request, body, done) => {
      const raw = String(body ?? "").trim();
      if (!raw) {
        done(null, {});
        return;
      }
      try {
        done(null, JSON.parse(raw));
      } catch {
        const error = new Error("That request was not valid JSON.") as Error & { statusCode: number; code: string };
        error.statusCode = 400;
        error.code = "invalid_json";
        done(error, undefined);
      }
    });
  }

  private registerHooks(): void {
    this.fastify.addHook("onRequest", async (request, reply) => {
      const liveBridge =
        request.url === "/api/foundry/live" ||
        request.url.startsWith("/api/foundry/commands") ||
        request.url.startsWith("/api/foundry/control") ||
        request.url.startsWith("/api/foundry/player-drafts");
      const origin = request.headers.origin;
      if (origin && !liveBridge) {
        const allowed = new Set([
          `http://127.0.0.1:${this.config.port}`,
          `http://localhost:${this.config.port}`
        ]);
        if (!allowed.has(origin)) {
          return reply.code(403).send({ error: { code: "origin_forbidden", message: "Cross-origin requests are not allowed", details: {} } });
        }
      }
      const method = request.method.toUpperCase();
      if (["POST", "PUT", "PATCH", "DELETE"].includes(method)) {
        const contentType = String(request.headers["content-type"] ?? "");
        const hasBody = Number(request.headers["content-length"] ?? 0) > 0 || request.headers["transfer-encoding"];
        if (hasBody && !contentType.includes("application/json") && !contentType.includes("multipart/form-data")) {
          return reply.code(415).send({
            error: { code: "unsupported_media_type", message: "That request needs a JSON body", details: {} }
          });
        }
      }
      if (this.authRequired() && request.url.startsWith("/api") && !request.url.startsWith("/api/auth") && !liveBridge) {
        const cookie = request.cookies[SESSION_COOKIE];
        if (!cookie || !safeEqual(cookie, this.cookieValue()!)) {
          return reply.code(401).send({ error: { code: "unauthorized", message: "Dashboard authentication required", details: {} } });
        }
      }
    });

    this.fastify.addHook("onSend", async (request, reply, payload) => {
      if (
        request.url === "/api/foundry/live" ||
        request.url.startsWith("/api/foundry/commands") ||
        request.url.startsWith("/api/foundry/control") ||
        request.url.startsWith("/api/foundry/player-drafts")
      ) {
        reply.header("Access-Control-Allow-Origin", "*");
        reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        reply.header("Access-Control-Allow-Headers", "content-type,x-tablerecords-token");
        reply.header("Access-Control-Max-Age", "600");
      }
      reply.header(
        "Content-Security-Policy",
        "default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'"
      );
      reply.header("X-Content-Type-Options", "nosniff");
      reply.header("Referrer-Policy", "no-referrer");
      reply.header("Cache-Control", "no-store");
      return payload;
    });

    this.fastify.setErrorHandler((error, _request, reply) => {
      const err = error as Error & { statusCode?: number; code?: string; details?: unknown };
      const statusCode = err.statusCode ?? (err.name === "PathSafetyError" ? 400 : 500);
      const code = err.code ?? (statusCode >= 500 ? "internal_error" : "request_error");
      if (statusCode >= 500) this.fastify.log.error({ err }, "request failed");
      const details = err.details ?? {};
      return reply.code(statusCode).send({
        error: {
          code,
          message: statusCode >= 500 && code === "internal_error" ? "Internal server error" : err.message,
          details
        }
      });
    });
  }

  private async summarizeWithFallback(
    request: Parameters<LlmService["summarize"]>[0]
  ): Promise<LlmSummary> {
    try {
      return await this.llm.summarize(request);
    } catch (error) {
      const effort = request.thinkingEffort ?? this.config.llmThinkingEffort;
      if (
        error instanceof LlmError &&
        error.code === "llm_empty_response" &&
        effort !== "off"
      ) {
        return this.llm.summarize({ ...request, thinkingEffort: "off" });
      }
      throw error;
    }
  }

  private async semanticMissingFacts(required: string[], summary: string): Promise<string[]> {
    if (required.length === 0) return [];
    const candidates = required.slice(0, 60);
    try {
      const result = await this.llm.summarize({
        system: SUMMARY_COVERAGE_SYSTEM,
        user: `# Numbered facts\n\n${candidates.map((value, index) => `${index + 1}. ${value}`).join("\n")}\n\n# Summary\n\n${summary}`,
        maxTokens: 700,
        json: true,
        jsonSchema: SUMMARY_COVERAGE_SCHEMA,
        thinkingEffort: "off"
      });
      const parsed = JSON.parse(result.text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "")) as {
        coveredIds?: unknown;
        missingIds?: unknown;
      };
      if (!Array.isArray(parsed.coveredIds) || !Array.isArray(parsed.missingIds)) return candidates;
      const covered = new Set(
        parsed.coveredIds
          .filter((value): value is number => typeof value === "number" && Number.isInteger(value))
          .map((value) => value - 1)
      );
      return candidates.filter((_, index) => !covered.has(index));
    } catch {
      return candidates;
    }
  }

  private assertLlamaCppStartAllowed(): void {
    if (this.config.llmProvider !== "llamacpp") {
      apiError("llamacpp_not_selected", "Choose llama.cpp as the provider before starting its server.", 409);
    }
    if (!this.config.llmBaseUrl) apiError("llamacpp_address_missing", "Set the llama.cpp address first.", 409);
    let port = this.config.llamacppPort;
    try {
      port = Number(new URL(this.config.llmBaseUrl).port || 80);
    } catch {
      apiError("llamacpp_address_invalid", "That llama.cpp address is not valid.", 400);
    }
    if (port !== this.config.llamacppPort) {
      apiError("llamacpp_port_mismatch", `The llama.cpp address must use port ${this.config.llamacppPort}.`, 409);
    }
  }

  private registerRoutes(): void {
    const app = this.fastify;

    app.get("/api/auth/status", async (request) => {
      const cookie = request.cookies[SESSION_COOKIE];
      return {
        required: this.authRequired(),
        authenticated: !this.authRequired() || Boolean(cookie && safeEqual(cookie, this.cookieValue()!))
      };
    });

    app.post("/api/auth", async (request, reply) => {
      if (!this.authRequired()) return reply.code(204).send();
      const ip = request.ip;
      const now = Date.now();
      const attempts = (this.authAttempts.get(ip) ?? []).filter((ts) => now - ts < 60_000);
      if (attempts.length >= 5) return reply.code(429).send({ error: { code: "rate_limited", message: "Too many attempts; wait a minute", details: {} } });
      attempts.push(now);
      this.authAttempts.set(ip, attempts);
      if (!isRecord(request.body) || !str(request.body.token)) {
        return reply.code(400).send({ error: { code: "token_required", message: "A token is required", details: {} } });
      }
      if (!safeEqual(str(request.body.token)!, this.config.dashboardToken!)) {
        return reply.code(401).send({ error: { code: "invalid_token", message: "That token did not match.", details: {} } });
      }
      this.authAttempts.delete(ip);
      reply.setCookie(SESSION_COOKIE, this.cookieValue()!, {
        path: "/",
        httpOnly: true,
        sameSite: "strict",
        maxAge: 60 * 60 * 24 * 30
      });
      return reply.code(204).send();
    });

    app.delete("/api/auth", async (_request, reply) => {
      reply.clearCookie(SESSION_COOKIE, { path: "/" });
      return reply.code(204).send();
    });

    app.get("/api/status", async () => this.buildStatus());

    app.get("/api/events", async (request, reply) => {
      reply.hijack();
      reply.raw.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache, no-transform",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no"
      });
      this.sse.add(reply.raw);
      const status = await this.buildStatus();
      reply.raw.write(`event: status\ndata: ${JSON.stringify(status)}\n\n`);
      request.raw.on("close", () => {
        try {
          reply.raw.end();
        } catch {
          // ignore
        }
      });
    });

    app.get("/api/health", async () => ({
      checks: this.doctorChecks(),
      ranAtMs: Date.now()
    }));

    app.post("/api/doctor/run", async () => {
      await this.refreshPythonHealth();
      return { checks: this.doctorChecks(), ranAtMs: Date.now() };
    });

    app.get("/api/settings", async () => this.settingsPayload());

    app.put("/api/settings", async (request) => {
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      this.validateSettingsBody(request.body);
      if ("foundryDataPath" in request.body) {
        const value = request.body.foundryDataPath;
        if (value !== null && typeof value !== "string") apiError("invalid_foundry_path", "That Foundry folder path is not valid.");
        if (typeof value === "string" && value.trim()) {
          const trimmed = value.trim();
          let isDirectory = false;
          try {
            isDirectory = fs.statSync(trimmed).isDirectory();
          } catch {
            isDirectory = false;
          }
          if (!isDirectory) {
            apiError("foundry_path_missing", `Foundry data path does not exist: ${trimmed}`);
          }
          this.store.setSetting("foundry_data_path", path.resolve(trimmed));
          this.config.foundryDataPath = path.resolve(trimmed);
        } else {
          this.store.setSetting("foundry_data_path", null);
          this.config.foundryDataPath = null;
        }
      }
      if ("defaultGuildId" in request.body) {
        this.store.setSetting("default_guild_id", str(request.body.defaultGuildId));
        this.config.defaultGuildId = str(request.body.defaultGuildId);
      }
      if ("defaultVoiceChannelId" in request.body) {
        this.store.setSetting("default_voice_channel_id", str(request.body.defaultVoiceChannelId));
      }
      if ("discordBotName" in request.body) {
        const value = String(request.body.discordBotName ?? "").trim().slice(0, 32);
        this.store.setSetting("discord_bot_name", value);
        this.config.discordBotName = value;
      }
      if ("discordActivityType" in request.body) {
        const value = str(request.body.discordActivityType) as AppConfig["discordActivityType"];
        this.store.setSetting("discord_activity_type", value);
        this.config.discordActivityType = value;
      }
      if ("discordActivityText" in request.body) {
        const value = String(request.body.discordActivityText ?? "").trim().slice(0, 128);
        this.store.setSetting("discord_activity_text", value);
        this.config.discordActivityText = value;
      }
      if ("discordActivityDynamic" in request.body) {
        const value = bool(request.body.discordActivityDynamic);
        if (value == null) apiError("invalid_activity_dynamic", "That option needs to be on or off.");
        this.store.setSetting("discord_activity_dynamic", value);
        this.config.discordActivityDynamic = value;
      }
      if ("sttEngine" in request.body) {
        const raw = str(request.body.sttEngine)?.toLowerCase();
        const value: AppConfig["sttEngine"] =
          raw === "whisper" || raw === "faster-whisper" ? "faster-whisper" : "parakeet";
        this.store.setSetting("stt_engine", value);
        this.config.sttEngine = value;
      }
      if ("parakeetPath" in request.body) {
        const value = str(request.body.parakeetPath);
        if (!value) apiError("invalid_parakeet_path", "Point at the nemo-speech runtime.");
        this.store.setSetting("parakeet_path", value);
        this.config.parakeetPath = value;
      }
      if ("parakeetModel" in request.body) {
        const value = str(request.body.parakeetModel);
        if (!value) apiError("invalid_parakeet_model", "Choose a Parrot model.");
        this.store.setSetting("parakeet_model", value);
        this.config.parakeetModel = path.resolve(value);
      }
      if ("parakeetDevice" in request.body) {
        const value = str(request.body.parakeetDevice);
        if (value !== "cuda" && value !== "cpu") apiError("invalid_parakeet_device", "Pick CUDA or CPU.");
        this.store.setSetting("parakeet_device", value);
        this.config.parakeetDevice = value;
      }
      if ("parakeetConcurrency" in request.body) {
        const value = num(request.body.parakeetConcurrency);
        if (value == null || value < 1 || value > 16) {
          apiError("invalid_parakeet_concurrency", "Concurrency runs from 1 to 16.");
        }
        this.store.setSetting("parakeet_concurrency", Math.trunc(value));
        this.config.parakeetConcurrency = Math.trunc(value);
      }
      if ("sttModel" in request.body) {
        const value = str(request.body.sttModel);
        if (!value) apiError("invalid_model", "Choose a Whisper model.");
        this.store.setSetting("stt_model", value);
        this.config.sttModel = value;
      }
      if ("sttDevice" in request.body) {
        const value = str(request.body.sttDevice);
        if (value !== "cuda" && value !== "cpu") apiError("invalid_device", "Pick CUDA or CPU.");
        this.store.setSetting("stt_device", value);
        this.config.sttDevice = value;
      }
      if ("sttComputeType" in request.body) {
        const value = str(request.body.sttComputeType);
        if (!value) apiError("invalid_compute_type", "Pick a compute type.");
        this.store.setSetting("stt_compute_type", value);
        this.config.sttComputeType = value;
      }
      if ("sttLanguage" in request.body) {
        const value = str(request.body.sttLanguage);
        if (!value) apiError("invalid_language", "Pick a spoken language.");
        this.store.setSetting("stt_language", value);
        this.config.sttLanguage = value;
      }
      if ("sttBeamSize" in request.body) {
        const value = num(request.body.sttBeamSize);
        if (value == null || value < 1 || value > 10) apiError("invalid_beam_size", "Beam size runs from 1 to 10.");
        this.store.setSetting("stt_beam_size", Math.trunc(value));
        this.config.sttBeamSize = Math.trunc(value);
      }
      if ("sttVadFilter" in request.body) {
        const value = bool(request.body.sttVadFilter);
        if (value == null) apiError("invalid_vad_filter", "That option needs to be on or off.");
        this.store.setSetting("stt_vad_filter", value);
        this.config.sttVadFilter = value;
      }
      if ("sttNoSpeechThreshold" in request.body) {
        const value = num(request.body.sttNoSpeechThreshold);
        if (value == null || value < 0 || value > 1) apiError("invalid_no_speech_threshold", "The no-speech threshold runs from 0 to 1.");
        this.store.setSetting("stt_no_speech_threshold", value);
        this.config.sttNoSpeechThreshold = value;
      }
      if ("sttLogProbThreshold" in request.body) {
        const value = num(request.body.sttLogProbThreshold);
        if (value == null || value < -5 || value > 0) apiError("invalid_logprob_threshold", "The log-probability threshold runs from -5 to 0.");
        this.store.setSetting("stt_log_prob_threshold", value);
        this.config.sttLogProbThreshold = value;
      }
      if ("sttCompressionRatioThreshold" in request.body) {
        const value = num(request.body.sttCompressionRatioThreshold);
        if (value == null || value < 1 || value > 10) {
          apiError("invalid_compression_threshold", "The compression-ratio threshold runs from 1 to 10.");
        }
        this.store.setSetting("stt_compression_ratio_threshold", value);
        this.config.sttCompressionRatioThreshold = value;
      }
      if ("sttPromptExtra" in request.body) {
        const value = str(request.body.sttPromptExtra) ?? "";
        this.store.setSetting("stt_prompt_extra", value);
        this.config.sttPromptExtra = value;
      }
      if ("sttHotwordsExtra" in request.body) {
        const value = str(request.body.sttHotwordsExtra) ?? "";
        this.store.setSetting("stt_hotwords_extra", value);
        this.config.sttHotwordsExtra = value;
      }
      if ("rollContextBeforeMs" in request.body) {
        const value = num(request.body.rollContextBeforeMs);
        if (value == null || value < 0 || value > 300_000) apiError("invalid_roll_context", "Speech before a roll can be 0 to 300 seconds.");
        this.store.setSetting("roll_context_before_ms", Math.trunc(value));
        this.config.rollContextBeforeMs = Math.trunc(value);
      }
      if ("rollContextAfterMs" in request.body) {
        const value = num(request.body.rollContextAfterMs);
        if (value == null || value < 0 || value > 300_000) apiError("invalid_roll_context", "Speech after a roll can be 0 to 300 seconds.");
        this.store.setSetting("roll_context_after_ms", Math.trunc(value));
        this.config.rollContextAfterMs = Math.trunc(value);
      }
      if ("recentContextSeconds" in request.body) {
        const value = num(request.body.recentContextSeconds);
        if (value == null || value < 15 || value > 1800) apiError("invalid_recent_context", "The brief can cover 15 to 1,800 seconds.");
        this.store.setSetting("recent_context_seconds", Math.trunc(value));
        this.config.recentContextSeconds = Math.trunc(value);
      }
      if (
        ["llmProvider", "llmEnabled", "llmCloudEnabled", "llmBaseUrl", "llmModel", "llmTimeoutMs", "llmMaxInputChars", "llmContextTokens", "llmGpuLayers", "llamacppNcpuMoe", "llamacppKvCache", "llamacppFlashAttn", "llamacppExe", "llamacppModelPath", "llamacppPort", "llamacppAutostart", "llmThinkingEffort"].some(
          (key) => key in (request.body as Record<string, unknown>)
        )
      ) {
        let nextProvider = this.config.llmProvider;
        let nextEnabled = this.config.llmEnabled;
        let nextCloudEnabled = this.config.llmCloudEnabled;
        let nextBaseUrl = this.config.llmBaseUrl;
        let nextModel = this.config.llmModel;
        let nextTimeout = this.config.llmTimeoutMs;
        let nextMaxInputChars = this.config.llmMaxInputChars;
        let nextContextTokens = this.config.llmContextTokens;
        let nextGpuLayers = this.config.llmGpuLayers;
        let nextNcpuMoe = this.config.llamacppNcpuMoe;
        let nextKvCache = this.config.llamacppKvCache;
        let nextFlashAttn = this.config.llamacppFlashAttn;
        let nextExe = this.config.llamacppExe;
        let nextModelPath = this.config.llamacppModelPath;
        let nextPort = this.config.llamacppPort;
        let nextAutostart = this.config.llamacppAutostart;
        let nextThinkingEffort = this.config.llmThinkingEffort;
        if ("llmProvider" in request.body) {
          const value = str(request.body.llmProvider);
          if (value !== "ollama" && value !== "llamacpp" && value !== "deepseek" && value !== "local") {
            apiError("invalid_llm_provider", "Pick llama.cpp, Ollama, DeepSeek, or a local OpenAI-compatible server.");
          }
          nextProvider = value;
        }
        if ("llmEnabled" in request.body) {
          const value = bool(request.body.llmEnabled);
          if (value == null) apiError("invalid_llm_enabled", "That option needs to be on or off.");
          nextEnabled = value;
        }
        if ("llmCloudEnabled" in request.body) {
          const value = bool(request.body.llmCloudEnabled);
          if (value == null) apiError("invalid_llm_cloud", "That option needs to be on or off.");
          nextCloudEnabled = value;
        }
        if ("llmBaseUrl" in request.body) {
          const raw = str(request.body.llmBaseUrl);
          nextBaseUrl = raw && nextProvider !== "deepseek"
            ? nextProvider === "ollama"
              ? normalizeOllamaBaseUrl(raw)
              : validateLlmBaseUrl(raw)
            : null;
        }
        if (nextProvider === "deepseek") nextBaseUrl = DEEPSEEK_BASE_URL;
        if ("llmModel" in request.body) {
          nextModel = str(request.body.llmModel);
        }
        if ("llmTimeoutMs" in request.body) {
          const value = num(request.body.llmTimeoutMs);
          if (value == null || value < 5000 || value > 300000) apiError("invalid_llm_timeout", "The timeout runs from 5 to 300 seconds.");
          nextTimeout = Math.trunc(value);
        }
        if ("llmMaxInputChars" in request.body) {
          const value = num(request.body.llmMaxInputChars);
          if (value == null || value < 4_000 || value > 200_000) {
            apiError("invalid_llm_max_input", "The summary input limit runs from 4,000 to 200,000 characters.");
          }
          nextMaxInputChars = Math.trunc(value);
        }
        if ("llmContextTokens" in request.body) {
          const value = num(request.body.llmContextTokens);
          if (value == null || value < 4_096 || value > 131_072) {
            apiError("invalid_llm_context", "The context window runs from 4,096 to 131,072 tokens.");
          }
          nextContextTokens = Math.trunc(value);
        }
        if ("llmThinkingEffort" in request.body) {
          const value = str(request.body.llmThinkingEffort);
          if (value !== "off" && value !== "low" && value !== "medium" && value !== "high") {
            apiError("invalid_llm_thinking", "Pick off, low, medium, or high for reasoning effort.");
          }
          nextThinkingEffort = value;
        }
        if ("llmGpuLayers" in request.body) {
          if (request.body.llmGpuLayers == null || request.body.llmGpuLayers === "") {
            nextGpuLayers = null;
          } else {
            const value = num(request.body.llmGpuLayers);
            if (value == null || value < 0 || value > 999 || !Number.isInteger(value)) {
              apiError("invalid_llm_gpu_layers", "Use a whole number of video card layers from 0 to 999, or leave it automatic.");
            }
            nextGpuLayers = Math.trunc(value);
          }
        }
        if ("llamacppNcpuMoe" in request.body) {
          const value = num(request.body.llamacppNcpuMoe);
          if (value == null || value < 0 || value > 999 || !Number.isInteger(value)) {
            apiError("invalid_llamacpp_ncpu_moe", "Use a whole number of MoE layers from 0 to 999.");
          }
          nextNcpuMoe = Math.trunc(value);
        }
        if ("llamacppKvCache" in request.body) {
          const value = str(request.body.llamacppKvCache);
          if (value !== "f16" && value !== "q8_0" && value !== "q4_0") {
            apiError("invalid_llamacpp_kv", "Pick f16, q8_0, or q4_0 for the KV cache.");
          }
          nextKvCache = value;
        }
        if ("llamacppFlashAttn" in request.body) {
          const value = bool(request.body.llamacppFlashAttn);
          if (value == null) apiError("invalid_llamacpp_flash", "That option needs to be on or off.");
          nextFlashAttn = value;
        }
        if ("llamacppExe" in request.body) {
          nextExe = str(request.body.llamacppExe) ?? this.config.llamacppExe;
        }
        if ("llamacppModelPath" in request.body) {
          nextModelPath = str(request.body.llamacppModelPath);
        }
        if ("llamacppPort" in request.body) {
          const value = num(request.body.llamacppPort);
          if (value == null || value < 1 || value > 65_535 || !Number.isInteger(value)) {
            apiError("invalid_llamacpp_port", "The llama-server port runs from 1 to 65,535.");
          }
          nextPort = Math.trunc(value);
        }
        if ("llamacppAutostart" in request.body) {
          const value = bool(request.body.llamacppAutostart);
          if (value == null) apiError("invalid_llamacpp_autostart", "That option needs to be on or off.");
          nextAutostart = value;
        }
        if (nextPort !== this.config.llamacppPort && nextProvider === "llamacpp" && nextBaseUrl) {
          try {
            const url = new URL(nextBaseUrl);
            const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
            const explicitBase = "llmBaseUrl" in (request.body as Record<string, unknown>);
            if (loopback && (!explicitBase || url.port === String(this.config.llamacppPort) || (!url.port && this.config.llamacppPort === 80))) {
              url.port = String(nextPort);
              nextBaseUrl = url.toString().replace(/\/$/, "");
            }
          } catch {
            // The address validation above already rejects an unusable URL.
          }
        }
        this.store.setSetting("llm_provider", nextProvider);
        this.store.setSetting("llm_enabled", nextEnabled);
        this.store.setSetting("llm_cloud_enabled", nextCloudEnabled);
        this.store.setSetting("llm_base_url", nextBaseUrl);
        this.store.setSetting("llm_model", nextModel);
        this.store.setSetting("llm_timeout_ms", nextTimeout);
        this.store.setSetting("llm_max_input_chars", nextMaxInputChars);
        this.store.setSetting("llm_context_tokens", nextContextTokens);
        this.store.setSetting("llm_gpu_layers", nextGpuLayers);
        this.store.setSetting("llamacpp_n_cpu_moe", nextNcpuMoe);
        this.store.setSetting("llamacpp_kv_cache", nextKvCache);
        this.store.setSetting("llamacpp_flash_attn", nextFlashAttn);
        this.store.setSetting("llamacpp_exe", nextExe);
        this.store.setSetting("llamacpp_model_path", nextModelPath);
        this.store.setSetting("llamacpp_port", nextPort);
        this.store.setSetting("llamacpp_autostart", nextAutostart);
        this.store.setSetting("llm_thinking_effort", nextThinkingEffort);
        this.config.llmProvider = nextProvider;
        this.config.llmEnabled = nextEnabled;
        this.config.llmCloudEnabled = nextCloudEnabled;
        this.config.llmBaseUrl = nextBaseUrl;
        this.config.llmModel = nextModel;
        this.config.llmTimeoutMs = nextTimeout;
        this.config.llmMaxInputChars = nextMaxInputChars;
        this.config.llmContextTokens = nextContextTokens;
        this.config.llmGpuLayers = nextGpuLayers;
        this.config.llamacppNcpuMoe = nextNcpuMoe;
        this.config.llamacppKvCache = nextKvCache;
        this.config.llamacppFlashAttn = nextFlashAttn;
        this.config.llamacppExe = nextExe;
        this.config.llamacppModelPath = nextModelPath;
        this.config.llamacppPort = nextPort;
        this.config.llamacppAutostart = nextAutostart;
        this.config.llmThinkingEffort = nextThinkingEffort;
      }
      if ("foundryLiveEnabled" in request.body) {
        const value = bool(request.body.foundryLiveEnabled);
        if (value == null) apiError("invalid_live_enabled", "That option needs to be on or off.");
        this.liveEnabled = value;
        this.store.setSetting("foundry_live_enabled", value);
        this.saveBridgeStatus();
        this.sse.broadcast("foundry.live", this.liveStatusSnapshot());
      }
      if ("foundryLiveMarkers" in request.body) {
        const value = bool(request.body.foundryLiveMarkers);
        if (value == null) apiError("invalid_live_markers", "That option needs to be on or off.");
        this.liveMarkers = value;
        this.store.setSetting("foundry_live_markers", value);
        this.saveBridgeStatus();
        this.sse.broadcast("foundry.live", this.liveStatusSnapshot());
      }
      if (
        ["discordBotName", "discordActivityType", "discordActivityText", "discordActivityDynamic"].some(
          (key) => key in (request.body as Record<string, unknown>)
        )
      ) {
        void this.discord.refreshPresence().catch(() => undefined);
      }
      if (
        ["sttEngine", "sttModel", "parakeetPath", "parakeetModel", "parakeetDevice", "sttDevice"].some(
          (key) => key in (request.body as Record<string, unknown>)
        )
      ) {
        void this.refreshPythonHealth().then(() => this.emitStatus()).catch(() => undefined);
      }
      return this.settingsPayload();
    });

    app.get("/api/llm/models", async () => ({
      provider: this.config.llmProvider,
      models: await this.llm.listModels()
    }));

    app.post("/api/llm/test", async () => this.llm.testConnection());

    app.get("/api/llamacpp/status", async () => this.llamacpp.refresh());
    app.post<{ Body: { kind?: unknown } }>("/api/llamacpp/browse", async (request) => {
      const kind = str(request.body?.kind);
      if (kind !== "exe" && kind !== "model") {
        apiError("invalid_browse_kind", "Choose the executable or model file.", 400);
      }
      const filter =
        kind === "exe"
          ? "llama-server (llama-server.exe)|llama-server.exe|Programs (*.exe)|*.exe|All files (*.*)|*.*"
          : "GGUF models (*.gguf)|*.gguf|All files (*.*)|*.*";
      const script =
        "Add-Type -AssemblyName System.Windows.Forms; " +
        "$d = New-Object System.Windows.Forms.OpenFileDialog; " +
        `$d.Filter = '${filter}'; ` +
        "$d.CheckFileExists = $true; " +
        "if ($d.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { Write-Output $d.FileName }";
      const selected = await new Promise<string>((resolve, reject) => {
        execFile(
          "powershell.exe",
          ["-NoProfile", "-STA", "-Command", script],
          { windowsHide: false, timeout: 120_000, encoding: "utf8" },
          (error, stdout) => {
            if (error) reject(error);
            else resolve(String(stdout).trim());
          }
        );
      }).catch((error: unknown) => {
        apiError(
          "llamacpp_browse_failed",
          error instanceof Error ? error.message : "The file picker could not be opened.",
          502
        );
      });
      return { path: selected || null };
    });
    app.post("/api/llamacpp/start", async () => {
      this.assertLlamaCppStartAllowed();
      try {
        return await this.llamacpp.start();
      } catch (error) {
        apiError("llamacpp_start_failed", error instanceof Error ? error.message : String(error), 502);
      }
    });
    app.post("/api/llamacpp/restart", async () => {
      this.assertLlamaCppStartAllowed();
      try {
        return await this.llamacpp.restart();
      } catch (error) {
        apiError("llamacpp_start_failed", error instanceof Error ? error.message : String(error), 502);
      }
    });
    app.post("/api/llamacpp/stop", async () => this.llamacpp.stop());

    app.get("/api/foundry/live/status", async () => ({ status: this.liveStatusSnapshot() }));

    app.post("/api/foundry/bridge/rotate", async () => {
      if (this.bridgeTokenManagedByEnv()) {
        apiError("token_managed_by_env", "FOUNDRY_BRIDGE_TOKEN is set in .env; change it there to rotate the token", 409);
      }
      this.bridgeToken = crypto.randomBytes(24).toString("hex");
      this.store.setSetting("foundry_bridge_token", this.bridgeToken);
      return { token: this.bridgeToken };
    });

    app.get("/api/discord/guilds", async () => {
      const guilds = await this.discord.listGuilds();
      return { configured: this.discord.configured, guilds };
    });

    app.get<{ Params: { guildId: string } }>("/api/discord/guilds/:guildId/channels", async (request) => {
      if (!this.discord.clientReady) apiError("discord_not_ready", "The Discord bot is not connected. Add its token in Setup, then restart.", 409);
      const voiceChannels = await this.discord.listVoiceChannels(request.params.guildId);
      return { voiceChannels };
    });

    app.get<{ Params: { channelId: string } }>("/api/discord/channels/:channelId/members", async (request) => {
      if (!this.discord.clientReady) apiError("discord_not_ready", "Discord bot is not ready", 409);
      const members = await this.discord.listChannelMembers(request.params.channelId);
      return { members };
    });

    app.post("/api/discord/join", async (request) => {
      if (this.recorder.isActive()) apiError("invalid_state", "Stop recording before changing channels.", 409);
      if (!this.discord.clientReady) apiError("discord_not_ready", "The Discord bot is not connected. Add its token in Setup, then restart.", 409);
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const guildId = str(request.body.guildId);
      const channelId = str(request.body.channelId);
      if (!guildId || !channelId) apiError("missing_channel", "Pick a server and a voice channel first.");
      try {
        await this.discord.join(guildId, channelId);
      } catch (error) {
        apiError("discord_join_failed", (error as Error).message, 409);
      }
      return this.buildStatus();
    });

    app.post("/api/discord/leave", async () => {
      if (this.recorder.isActive()) apiError("invalid_state", "Stop recording first, then leave the voice channel.", 409);
      this.discord.leave();
      return this.buildStatus();
    });

    app.post("/api/capture-test/start", async (request) => {
      if (this.recorder.isActive()) apiError("invalid_state", "Capture is already active", 409);
      if (!this.discord.clientReady) apiError("discord_not_ready", "The Discord bot is not connected. Add its token in Setup, then restart.", 409);
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const guildId = str(request.body.guildId);
      const channelId = str(request.body.channelId);
      if (!guildId || !channelId) apiError("missing_channel", "Pick a server and a voice channel first.");
      if (!this.discord.connectionReady() || this.discord.channelId() !== channelId) {
        try {
          await this.discord.join(guildId, channelId);
        } catch (error) {
          apiError("discord_join_failed", (error as Error).message, 409);
        }
      }
      const testId = `test_${Date.now()}`;
      const dir = path.join(this.config.sessionsDir, "_capture-tests", testId);
      await fsp.mkdir(path.join(dir, "discord", "audio"), { recursive: true });
      await this.recorder.start({ sessionId: testId, sessionDir: dir, testId });
      const timer = setTimeout(() => {
        void this.finishCaptureTest("timeout").catch(() => undefined);
      }, this.config.captureTestMaxSeconds * 1000);
      timer.unref?.();
      this.activeTest = { testId, startedAtMs: Date.now(), dir, timer };
      return { testId, startedAtMs: this.activeTest.startedAtMs };
    });

    app.post("/api/capture-test/stop", async () => {
      if (!this.activeTest) apiError("invalid_state", "No capture test is active", 409);
      return this.finishCaptureTest("manual");
    });

    app.get("/api/foundry/worlds", async () => {
      const worlds = await listFoundryWorlds(this.foundryPath());
      return { worlds, foundryDataPath: this.foundryPath() };
    });

    app.get("/api/foundry/macro", async (_request, reply) => {
      const file = path.join(this.config.projectRoot, "foundry-macros", "table-records-export.js");
      if (!(await pathExists(file))) apiError("macro_missing", "Macro file is missing", 404);
      reply.header("Content-Disposition", 'attachment; filename="table-records-export.js"');
      reply.type("text/javascript");
      return reply.send(fs.createReadStream(file));
    });

    app.post("/api/foundry/module/install", async () => {
      const source = path.join(this.config.projectRoot, "foundry-module");
      if (!(await pathExists(path.join(source, "module.json")))) {
        apiError("module_missing", "foundry-module/module.json is missing from this build", 404);
      }
      const root = this.foundryPath();
      if (!root) apiError("foundry_path_missing", "Set the Foundry data path in Setup before installing the module", 400);
      const modulesDir = await findModulesDir(root);
      if (!modulesDir) apiError("modules_path_missing", "Could not resolve a Foundry modules directory", 400);
      await fsp.mkdir(modulesDir, { recursive: true });
      const installedTo = path.join(modulesDir, "table-records-bridge");
      const existing = await fsp.lstat(installedTo).catch(() => null);
      if (existing?.isSymbolicLink()) {
        return {
          installedTo,
          modulesDir,
          note: "The module is already linked into Foundry; the installer left the junction in place."
        };
      }
      await fsp.cp(source, installedTo, { recursive: true, force: true });
      return {
        installedTo,
        modulesDir,
        note: "Restart Foundry or return to the setup screen so it rescans modules, then enable TableRecords Bridge."
      };
    });

    app.options("/api/foundry/live", async (_request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type,x-tablerecords-token");
      reply.header("Access-Control-Max-Age", "600");
      return reply.code(204).send();
    });

    app.options("/api/foundry/commands", async (_request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "GET, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type,x-tablerecords-token");
      reply.header("Access-Control-Max-Age", "600");
      return reply.code(204).send();
    });

    app.get("/api/foundry/commands", async (request) => {
      const token = typeof request.headers["x-tablerecords-token"] === "string" ? request.headers["x-tablerecords-token"] : "";
      if (!token || !this.bridgeToken || !safeEqual(token, this.bridgeToken)) {
        apiError("invalid_bridge_token", "The Foundry bridge token is invalid", 401);
      }
      if (!this.liveEnabled) return { commands: [] };
      const now = Date.now();
      const commands = this.bridgeCommands.filter((command) => now - command.createdAtMs < 2 * 60_000);
      this.bridgeCommands = [];
      return { commands, serverTimeMs: now };
    });

    app.options("/api/foundry/control", async (_request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type,x-tablerecords-token");
      reply.header("Access-Control-Max-Age", "600");
      return reply.code(204).send();
    });

    app.options("/api/foundry/player-drafts", async (_request, reply) => {
      reply.header("Access-Control-Allow-Origin", "*");
      reply.header("Access-Control-Allow-Methods", "POST, OPTIONS");
      reply.header("Access-Control-Allow-Headers", "content-type,x-tablerecords-token");
      reply.header("Access-Control-Max-Age", "600");
      return reply.code(204).send();
    });

    app.post("/api/foundry/player-drafts", async (request) => {
      if (!this.liveEnabled) {
        apiError("live_disabled", "The Foundry bridge is disabled in the dashboard settings", 403);
      }
      const token = typeof request.headers["x-tablerecords-token"] === "string" ? request.headers["x-tablerecords-token"] : "";
      if (!token || !this.bridgeToken || !safeEqual(token, this.bridgeToken)) {
        apiError("invalid_bridge_token", "The Foundry bridge token is invalid", 401);
      }
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const body = request.body;
      const kind = playerDraftKind(body.kind);
      if (!kind) apiError("invalid_draft_kind", "Choose recap, names, or clues.");
      const windowSeconds = num(body.windowSeconds) ?? 180;
      if (windowSeconds < 30 || windowSeconds > 900) {
        apiError("invalid_window", "The draft window runs from 30 seconds to 15 minutes.");
      }
      const worldId = isRecord(body.world) ? str(body.world.id) : str(body.worldId);
      if (!worldId) apiError("world_required", "The Foundry world is missing from that request.");
      const requestedSessionId = str(body.sessionId);
      let session: SessionRecord | null = null;
      if (requestedSessionId) {
        session = await this.sessions.get(requestedSessionId).catch(() => null);
        if (!session) apiError("session_not_found", "That session was not found.", 404);
      } else {
        const all = await this.sessions.list();
        const matches = all
          .filter((item) => !item.archived && item.world.id === worldId)
          .sort((a, b) => (b.startedAtMs ?? 0) - (a.startedAtMs ?? 0));
        session =
          matches.find((item) => LIVE_ACTIVE_STATUSES.has(item.status)) ??
          matches.find((item) => ["captured", "processing", "ready", "error"].includes(item.status)) ??
          matches[0] ??
          null;
      }
      if (!session) {
        apiError("no_session", "No TableRecords session exists for this Foundry world yet. Start a recording first.", 404);
      }
      if (session.world.id !== worldId) {
        apiError("session_world_mismatch", "That session belongs to a different Foundry world.", 409);
      }
      if (!LIVE_TARGET_STATUSES.has(session.status)) {
        apiError("session_not_ready", "That session has not started recording yet.", 409);
      }
      if (this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before generating a player draft.", 409);
      }
      if (this.playerDraftBusy) {
        apiError("draft_busy", "A player draft is already being generated. Wait for it to finish.", 409);
      }
      const llmStatus = this.llm.status();
      if (!llmStatus.enabled) apiError("llm_disabled", "AI summaries are off in Setup.", 409);
      if (!llmStatus.configured) {
        apiError(
          "llm_not_configured",
          llmStatus.provider === "deepseek"
            ? "Turn on cloud summaries and add a DeepSeek key before using DeepSeek."
            : "Choose a model in Setup first.",
          409
        );
      }
      this.playerDraftBusy = true;
      try {
        return await createPlayerDraft({
          config: this.config,
          session,
          sessionDir: this.sessions.sessionDir(session.sessionId),
          llm: this.llm,
          kind,
          windowSeconds,
          endMs: num(body.endMs) ?? undefined,
          transcribe: bool(body.transcribe) ?? true
        });
      } catch (error) {
        if (error instanceof PlayerDraftError) apiError(error.code, error.message, error.statusCode);
        throw error;
      } finally {
        this.playerDraftBusy = false;
      }
    });

    app.post("/api/foundry/live", async (request) => {
      if (!this.liveEnabled) {
        apiError("live_disabled", "Foundry live bridge is disabled in the dashboard settings", 403);
      }
      const token = typeof request.headers["x-tablerecords-token"] === "string" ? request.headers["x-tablerecords-token"] : "";
      if (!token || !this.bridgeToken || !safeEqual(token, this.bridgeToken)) {
        apiError("invalid_bridge_token", "The Foundry bridge token is invalid", 401);
      }
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const body = request.body;
      if (body.schema !== "tablerecords.foundry-live/v1") {
        apiError("unsupported_schema", "Expected tablerecords.foundry-live/v1");
      }
      const messages = body.messages === undefined ? [] : body.messages;
      if (!Array.isArray(messages)) apiError("invalid_messages", "That message payload is not valid.");
      if (messages.length > 500) apiError("too_many_messages", "Send at most 500 messages per request");
      const eventsInput = body.events === undefined ? [] : body.events;
      if (!Array.isArray(eventsInput)) apiError("invalid_events", "That event payload is not valid.");
      if (eventsInput.length > 50) apiError("too_many_events", "Send at most 50 events per request");
      const liveBreakEvents = normalizeLiveBreakEvents(eventsInput);
      const consentPayload = isRecord(body.consent);
      const note = str(body.note)?.slice(0, 500) ?? null;
      const releaseLive = await this.acquireLiveLock();
      try {
      const nowMs = Date.now();
      const requestedSessionId = str(body.sessionId);
      let session: SessionRecord | null = null;
      if (requestedSessionId) {
        session = await this.sessions.get(requestedSessionId).catch(() => null);
        if (!session) apiError("session_not_found", `Session not found: ${requestedSessionId}`, 404);
        if (!LIVE_TARGET_STATUSES.has(session.status) && !(consentPayload && ["draft", "error"].includes(session.status))) {
          apiError("session_not_ready", `Session ${session.sessionId} is ${session.status}; start a recording or target a finalized session explicitly`, 409);
        }
      } else {
        // Without an explicit target, only follow the session that is actually recording.
        // Falling back to "most recent session" quietly wrote post-game notes into yesterday's file.
        if (this.currentSessionId) {
          const current = await this.sessions.get(this.currentSessionId).catch(() => null);
          if (current && LIVE_ACTIVE_STATUSES.has(current.status)) session = current;
        }
        if (!session) {
          const all = await this.sessions.list();
          session = all.find((item) => LIVE_ACTIVE_STATUSES.has(item.status)) ?? null;
        }
      }
      const state = normalizeLiveState(body.state);
      const roster = normalizeLiveRoster(body.roster);
      const rosterProvided = Object.hasOwn(body, "roster");
      const moduleVersion = str(body.moduleVersion);
      const foundryVersion = str(body.foundryVersion) ?? session?.foundryVersion ?? null;
      const world: WorldRef | null = isRecord(body.world) && str(body.world.id)
        ? { id: str(body.world.id)!, title: str(body.world.title) ?? str(body.world.id)! }
        : session?.world ?? null;
      const system: SystemRef | null = isRecord(body.system) && str(body.system.id)
        ? { id: str(body.system.id)!, version: str(body.system.version) }
        : session?.system ?? null;
      if (session && world && liveRefConflict(world.id, session.world.id)) {
        this.bridgeStatus.lastError = `World mismatch: Foundry sent ${world.id}, session expects ${session.world.id}`;
        this.saveBridgeStatus();
        apiError("world_mismatch", this.bridgeStatus.lastError, 409);
      }
      if (session && system && liveRefConflict(system.id, session.system.id)) {
        this.bridgeStatus.lastError = `System mismatch: Foundry sent ${system.id}, session expects ${session.system.id}`;
        this.saveBridgeStatus();
        apiError("system_mismatch", this.bridgeStatus.lastError, 409);
      }
      const consentInput = isRecord(body.consent) ? body.consent : null;
      let consentAccepted = false;
      let consentResponses = 0;
      let consentSessionId: string | null = null;
      if (consentInput) {
        const consentWorld = world ?? session?.world ?? null;
        if (!consentWorld) apiError("consent_world_required", "consent requires a Foundry world", 400);
        const noticeVersion = str(consentInput.noticeVersion) ?? CONSENT_NOTICE_VERSION;
        let target = session;
        if (!target) {
          const all = await this.sessions.list();
          target =
            all.find(
              (item) =>
                item.world.id === consentWorld.id &&
                !item.archived &&
                ["draft", "error", "recording", "joining", "stopping"].includes(item.status)
            ) ?? null;
        }
        if (consentInput.promptSent === true) {
          const prompt = this.store.recordConsentPrompt(
            consentWorld.id,
            nowMs,
            noticeVersion,
            str(consentInput.promptedBy) ?? state?.userName ?? null
          );
          if (target && ["draft", "error"].includes(target.status) && !target.consent.confirmed) {
            target = await this.sessions.confirmConsent(target, {
              method: "foundry",
              confirmedBy: "Foundry player consent prompt",
              atMs: prompt.promptedAtMs,
              promptedAtMs: prompt.promptedAtMs,
              noticeVersion: prompt.noticeVersion,
              notes: `${target.consent.notes ? `${target.consent.notes}\n` : ""}Consent prompt sent to players in Foundry; consent is assumed unless a player opted out.`
            });
            this.sse.broadcast("session.updated", { sessionId: target.sessionId, status: target.status });
          } else if (target) {
            target = {
              ...target,
              consent: {
                ...target.consent,
                promptedAtMs: prompt.promptedAtMs,
                noticeVersion: prompt.noticeVersion
              }
            };
            await this.sessions.save(target);
            await this.sessions.writeConsentRecord(target.sessionId);
            this.sse.broadcast("session.updated", { sessionId: target.sessionId, status: target.status });
          }
          consentAccepted = true;
        }
        const responses = Array.isArray(consentInput.responses) ? consentInput.responses.slice(0, 200) : [];
        for (const response of responses) {
          if (!isRecord(response)) continue;
          const foundryUserId = str(response.foundryUserId);
          if (!foundryUserId) continue;
          this.store.upsertConsentPreference({
            worldId: consentWorld.id,
            foundryUserId,
            displayName: str(response.foundryUserName) ?? null,
            optOut: response.optOut === true,
            noticeVersion,
            updatedAtMs: nowMs
          });
          consentResponses += 1;
        }
        if (consentResponses > 0) consentAccepted = true;
        if (consentResponses > 0 && !this.store.getConsentPrompt(consentWorld.id)) {
          this.store.recordConsentPrompt(consentWorld.id, nowMs, noticeVersion, "Foundry player consent response");
        }
        if (target) {
          consentSessionId = target.sessionId;
          if (
            consentResponses > 0 &&
            !target.consent.confirmed &&
            ["draft", "error"].includes(target.status)
          ) {
            target = await this.sessions.confirmConsent(target, {
              method: "foundry",
              confirmedBy: "Foundry player consent response",
              atMs: nowMs,
              promptedAtMs: this.store.getConsentPrompt(consentWorld.id)?.promptedAtMs ?? nowMs,
              noticeVersion,
              notes: `${target.consent.notes ? `${target.consent.notes}\n` : ""}Players answered the Foundry consent notice; consent is assumed for players who did not respond.`
            });
          }
          const people = await this.sessions.applyConsentPreferences(
            target.sessionId,
            this.store.listConsentPreferences(consentWorld.id)
          );
          if (this.recorder.activeSessionId === target.sessionId) {
            this.recorder.setOptOutUsers(
              people
                .filter(personIsOptedOut)
                .map((person) => person.discordUserId)
                .filter((id): id is string => Boolean(id))
            );
          }
          this.sse.broadcast("session.updated", { sessionId: target.sessionId, status: target.status });
        }
      }
      this.bridgeStatus.lastSeenAtMs = nowMs;
      this.bridgeStatus.moduleVersion = moduleVersion;
      this.bridgeStatus.foundryVersion = foundryVersion;
      this.bridgeStatus.world = world;
      this.bridgeStatus.system = system;
      this.bridgeStatus.paused = state ? state.paused : this.bridgeStatus.paused;
      if (state) {
        this.bridgeStatus.scene = state.scene;
        this.bridgeStatus.combat = state.combat;
      }
      if (roster) this.bridgeStatus.roster = roster;
      if (rosterProvided && !roster) this.bridgeStatus.roster = null;
      const hadBridgeError = Boolean(this.bridgeStatus.lastError);
      this.bridgeStatus.lastError = null;

      if (!session) {
        this.bridgeStatus.targetSessionId = null;
        this.bridgeStatus.eventCount = 0;
        if (messages.length > 0 || liveBreakEvents.events.length > 0 || note || hadBridgeError) this.saveBridgeStatus();
        this.sse.broadcast("foundry.live", this.liveStatusSnapshot());
        return {
          accepted: true,
          acceptedMessages: 0,
          skippedMessages: messages.length,
          duplicateMessages: 0,
          noteAccepted: false,
          eventsAccepted: 0,
          eventsSkipped: liveBreakEvents.skipped,
          consentAccepted,
          consentResponses,
          consentSessionId,
          sessionId: null,
          reason:
            consentAccepted || consentResponses > 0
              ? "consent_recorded"
              : messages.length > 0 || liveBreakEvents.events.length > 0 || note
                ? "no_active_session"
                : "connected_without_session",
          status: this.liveStatusSnapshot()
        };
      }

      this.bridgeStatus.targetSessionId = session.sessionId;
      const dir = this.sessions.sessionDir(session.sessionId);
      const liveFile = path.join(dir, "foundry", "live-events.jsonl");
      const stateFile = path.join(dir, "foundry", "live-state.json");
      const previousState = await readJson<FoundryLiveState>(stateFile);
      const nextScene = state ? state.scene : previousState?.scene ?? null;
      const nextCombat = state ? state.combat : previousState?.combat ?? null;
      const nextPaused = state ? state.paused : previousState?.paused ?? false;
      const stateChanged =
        !previousState ||
        previousState.scene?.id !== nextScene?.id ||
        previousState.scene?.name !== nextScene?.name ||
        previousState.combat?.id !== nextCombat?.id ||
        previousState.combat?.round !== nextCombat?.round ||
        previousState.combat?.active !== nextCombat?.active ||
        previousState.paused !== nextPaused;
      let acceptedMessages = 0;
      let skippedMessages = 0;
      let duplicateMessages = 0;
      let messageCount = 0;
      try {
        const existing = await readJsonl<FoundryEvent>(liveFile);
        const known = new Set(existing.items.map((event) => event.eventId));
        const built = buildLiveFoundryEvents({
          messages,
          session,
          world: world ?? session.world,
          system: system ?? session.system,
          foundryVersion
        });
        skippedMessages = built.skipped;
        const fresh = built.events.filter((event) => !known.has(event.eventId));
        duplicateMessages = built.events.length - fresh.length;
        for (const event of fresh) await appendJsonl(liveFile, event);
        acceptedMessages = fresh.length;
        messageCount = existing.items.length + fresh.length;
        this.bridgeStatus.eventCount = messageCount;
        await writeJsonAtomic(stateFile, {
          schema: "tablerecords.foundry-live-state/v1",
          sessionId: session.sessionId,
          lastSeenAtMs: nowMs,
          moduleVersion,
          foundryVersion,
          world: world ?? session.world,
          system: system ?? session.system,
          scene: nextScene,
          combat: nextCombat,
          paused: nextPaused,
          roster: rosterProvided ? roster : previousState?.roster ?? null,
          messageCount,
          updatedAtMs: nowMs
        } satisfies FoundryLiveState);
      } catch (error) {
        this.bridgeStatus.lastError = error instanceof Error ? error.message : String(error);
        this.saveBridgeStatus();
        this.sse.broadcast("foundry.live", this.liveStatusSnapshot());
        throw error;
      }

      if (statusAllowsLiveMarkers(session.status) && this.liveMarkers) {
        try {
          const markers: Array<{ kind: MarkerKind; label: string }> = [];
          if (previousState?.scene?.id !== nextScene?.id && nextScene?.name) {
            markers.push({ kind: "scene", label: `Foundry scene: ${nextScene.name}` });
          }
          const previousCombat = previousState?.combat ?? null;
          const previousActive = previousCombat?.active === true;
          const nextActive = nextCombat?.active === true;
          if (nextActive && nextCombat && (!previousActive || previousCombat?.id !== nextCombat.id)) {
            markers.push({ kind: "combat", label: `Combat: ${nextCombat.name}${nextCombat.round ? ` (round ${nextCombat.round})` : ""}` });
          } else if (previousActive && !nextActive) {
            markers.push({ kind: "combat", label: `Combat ended: ${previousCombat?.name ?? "Combat"}` });
          }
          for (const marker of markers) {
            const created = await this.sessions.addMarker(session.sessionId, marker.kind, nowMs, marker.label);
            this.sse.broadcast("marker.created", created);
          }
        } catch (error) {
          this.bridgeStatus.lastError = `Auto-marker failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      let noteAccepted = false;
      if (note) {
        try {
          const created = await this.sessions.addMarker(session.sessionId, "note", nowMs, note, true);
          this.sse.broadcast("marker.created", created);
          noteAccepted = true;
        } catch (error) {
          this.bridgeStatus.lastError = `Mental note failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      let eventsAccepted = 0;
      if (liveBreakEvents.events.length > 0) {
        try {
          const markers = this.store.listMarkers(session.sessionId);
          for (const event of liveBreakEvents.events) {
            const open = openBreakStart(markers);
            if (event.phase === "start" && open && Math.abs(open.tsMs - event.atMs) <= 5_000) continue;
            if (
              event.phase === "end" &&
              !open &&
              markers.some(
                (marker) =>
                  marker.kind === "break" &&
                  /^break time over\b/i.test(marker.label) &&
                  Math.abs(marker.tsMs - event.atMs) <= 5_000
              )
            ) {
              continue;
            }
            const earliest = session.startedAtMs ?? nowMs - 12 * 60 * 60_000;
            const atMs = Math.min(nowMs + 60_000, Math.max(earliest, event.atMs));
            const created = await this.sessions.addMarker(
              session.sessionId,
              "break",
              atMs,
              breakMarkerLabel(event, open?.tsMs ?? null)
            );
            markers.push(created);
            eventsAccepted += 1;
            this.sse.broadcast("marker.created", created);
          }
        } catch (error) {
          this.bridgeStatus.lastError = `Break marker failed: ${error instanceof Error ? error.message : String(error)}`;
        }
      }

      if (acceptedMessages > 0 || noteAccepted || eventsAccepted > 0 || stateChanged || rosterProvided || hadBridgeError) {
        this.saveBridgeStatus();
      }
      this.sse.broadcast("foundry.live", this.liveStatusSnapshot());
      if (acceptedMessages > 0 || noteAccepted || eventsAccepted > 0 || stateChanged || rosterProvided) {
        this.sse.broadcast("session.updated", { sessionId: session.sessionId });
      }
      return {
        accepted: true,
        acceptedMessages,
        skippedMessages,
        duplicateMessages,
        noteAccepted,
        eventsAccepted,
        eventsSkipped: liveBreakEvents.skipped,
        consentAccepted,
        consentResponses,
        consentSessionId,
        sessionId: session.sessionId,
        status: this.liveStatusSnapshot()
      };
      } finally {
        releaseLive();
      }
    });

    app.get("/api/sessions", async () => {
      const sessions = await this.sessions.list();
      const summaries = await Promise.all(
        sessions.map(async (session) => {
          const detail = await this.sessions.detail(session.sessionId).catch(() => null);
          return {
            sessionId: session.sessionId,
            title: session.title,
            status: session.status,
            archived: Boolean(session.archived),
            campaign: sessionCampaign(session),
            system: session.system,
            world: session.world,
            createdAtMs: session.createdAtMs,
            startedAtMs: session.startedAtMs,
            stoppedAtMs: session.stoppedAtMs,
            counts: detail?.counts ?? null,
            foundryImported: Boolean(detail?.foundrySummary)
          };
        })
      );
      return { sessions: summaries };
    });

    app.get<{ Querystring: { worldId?: string } }>("/api/people/roster", async (request) => {
      const worldId = str(request.query.worldId);
      if (!worldId) apiError("world_required", "Pick a Foundry world.");
      return { profiles: this.store.listRoster(worldId) };
    });

    app.get("/api/people", async () => {
      const sessions = await this.sessions.list();
      const entries = new Map<string, PeopleDirectoryEntry>();
      const ensureEntry = (key: string): PeopleDirectoryEntry => {
        const existing = entries.get(key);
        if (existing) return existing;
        const entry: PeopleDirectoryEntry = {
          key,
          discordUserId: null,
          discordName: null,
          foundryUserId: null,
          foundryUserName: null,
          characters: [],
          roles: [],
          consent: "assumed",
          games: [],
          appearances: [],
          profiles: [],
          lastActivityMs: 0
        };
        entries.set(key, entry);
        return entry;
      };
      const addUnique = (list: string[], value: string | null | undefined) => {
        const trimmed = value?.trim();
        if (trimmed && !list.includes(trimmed)) list.push(trimmed);
      };
      for (const session of sessions) {
        const file = await readJson<PeopleFile>(path.join(this.sessions.sessionDir(session.sessionId), "people.json"));
        const campaign = sessionCampaign(session);
        for (const person of file?.people ?? []) {
          const key = person.discordUserId
            ? `discord:${person.discordUserId}`
            : `name:${(person.discordName ?? person.character ?? person.personId).trim().toLowerCase()}`;
          const entry = ensureEntry(key);
          if (!entry.discordUserId && person.discordUserId) entry.discordUserId = person.discordUserId;
          if (!entry.discordName && person.discordName) entry.discordName = person.discordName;
          if (!entry.foundryUserId && person.foundryUserId) entry.foundryUserId = person.foundryUserId;
          if (!entry.foundryUserName && person.foundryUserName) entry.foundryUserName = person.foundryUserName;
          addUnique(entry.characters, person.character);
          if (!entry.roles.includes(person.role)) entry.roles.push(person.role);
          addUnique(entry.games, campaign);
          const status = personConsentStatus(person);
          if (status === "opted_out") entry.consent = "opted_out";
          else if (status === "opted_in" && entry.consent !== "opted_out") entry.consent = "opted_in";
          entry.appearances.push({
            sessionId: session.sessionId,
            title: session.title,
            campaign,
            worldId: session.world.id,
            createdAtMs: session.createdAtMs,
            role: person.role,
            character: person.character,
            consentStatus: status,
            consentSource: person.consentSource
          });
          entry.lastActivityMs = Math.max(entry.lastActivityMs, session.createdAtMs);
        }
      }
      for (const profile of this.store.listAllRoster()) {
        const entry = ensureEntry(`discord:${profile.discordUserId}`);
        if (!entry.discordUserId) entry.discordUserId = profile.discordUserId;
        if (!entry.discordName && profile.discordName) entry.discordName = profile.discordName;
        if (!entry.foundryUserId && profile.foundryUserId) entry.foundryUserId = profile.foundryUserId;
        if (!entry.foundryUserName && profile.foundryUserName) entry.foundryUserName = profile.foundryUserName;
        addUnique(entry.characters, profile.character);
        if (!entry.roles.includes(profile.role)) entry.roles.push(profile.role);
        if (!entry.profiles.some((item) => item.profileId === profile.profileId)) entry.profiles.push(profile);
      }
      const people = [...entries.values()]
        .map((entry) => ({
          ...entry,
          appearances: entry.appearances.sort((a, b) => b.createdAtMs - a.createdAtMs),
          games: [...entry.games].sort((a, b) => a.localeCompare(b))
        }))
        .sort((a, b) => {
          if (a.consent === "opted_out" && b.consent !== "opted_out") return -1;
          if (b.consent === "opted_out" && a.consent !== "opted_out") return 1;
          const left = (a.discordName ?? a.foundryUserName ?? a.discordUserId ?? a.key).toLowerCase();
          const right = (b.discordName ?? b.foundryUserName ?? b.discordUserId ?? b.key).toLowerCase();
          return left.localeCompare(right);
        });
      return { people, games: [...new Set(people.flatMap((person) => person.games))].sort((a, b) => a.localeCompare(b)) };
    });

    app.post("/api/sessions", async (request, reply) => {
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const body = request.body;
      const worlds = await listFoundryWorlds(this.foundryPath());
      const worldId = str(body.worldId);
      const world = worldId ? worlds.find((item) => item.id === worldId) : worlds.length === 1 ? worlds[0] : undefined;
      if (worldId && !world) apiError("world_not_found", `Foundry world not found: ${worldId}`, 404);
      const guildId = str(body.guildId);
      const channelId = str(body.voiceChannelId);
      const guild = guildId ? { id: guildId, name: str(body.guildName) ?? guildId } : null;
      const voiceChannel = channelId ? { id: channelId, name: str(body.voiceChannelName) ?? channelId } : null;
      const participantsRaw = Array.isArray(body.participants) ? body.participants : [];
      const participants = participantsRaw.filter(isRecord).slice(0, 100).map((person) => {
        const role: Person["role"] = person.role === "gm" || person.role === "observer" ? person.role : "player";
        return {
          discordUserId: str(person.discordUserId),
          discordName: str(person.discordName),
          character: str(person.character),
          role,
          consent: person.consent !== false,
          consentStatus:
            person.consentStatus === "opted_out" || person.consentStatus === "opted_in" || person.consentStatus === "assumed"
              ? (person.consentStatus as "assumed" | "opted_in" | "opted_out")
              : undefined
        };
      });
      const consentRaw = isRecord(body.consent) ? body.consent : {};
      const session = await this.sessions.create({
        title: str(body.title) ?? undefined,
        date: str(body.date) ?? undefined,
        campaign: str(body.campaign) ?? undefined,
        world,
        guild,
        voiceChannel,
        participants,
        consent: {
          confirmed: consentRaw.confirmed === true,
          confirmedBy: str(consentRaw.confirmedBy) ?? "GM",
          notes: str(consentRaw.notes) ?? "",
          method: consentRaw.method === "foundry" ? "foundry" : "gm_tick",
          noticeVersion: str(consentRaw.noticeVersion) ?? CONSENT_NOTICE_VERSION
        },
        notes: str(body.notes) ?? ""
      });
      this.currentSessionId = session.sessionId;
      this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
      return reply.code(201).send(await this.sessions.detail(session.sessionId));
    });

    app.get<{ Params: { id: string } }>("/api/sessions/:id", async (request) => this.sessions.detail(request.params.id));

    app.get<{ Params: { id: string } }>("/api/sessions/:id/storage", async (request) => {
      const session = await this.sessions.get(request.params.id);
      return measureSessionStorage(this.sessions.sessionDir(session.sessionId));
    });

    app.patch<{ Params: { id: string } }>("/api/sessions/:id", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const body = request.body;
      const keys = Object.keys(body);
      const notesOnly = keys.length > 0 && keys.every((key) => key === "notes" || key === "campaign");
      if (!["draft", "error"].includes(session.status) && !notesOnly) {
        apiError("invalid_state", "Session metadata is editable only while draft or error", 409);
      }
      const next: SessionRecord = { ...session };
      if ("campaign" in body) {
        const campaign = str(body.campaign)?.trim();
        next.campaign = campaign ? campaign.slice(0, 120) : undefined;
      }
      if ("title" in body) {
        const title = str(body.title);
        if (!title) apiError("invalid_title", "Give the session a title.");
        next.title = title.slice(0, 200);
      }
      if ("notes" in body) next.notes = (str(body.notes) ?? "").slice(0, 10_000);
      if (isRecord(body.consent)) {
        const confirmed = body.consent.confirmed === true;
        next.consent = {
          ...session.consent,
          confirmed,
          confirmedAtMs: confirmed ? session.consent.confirmedAtMs ?? Date.now() : null,
          confirmedBy: confirmed ? str(body.consent.confirmedBy) ?? session.consent.confirmedBy ?? "GM" : null,
          notes: str(body.consent.notes) ?? session.consent.notes,
          method: confirmed
            ? body.consent.method === "foundry"
              ? "foundry"
              : session.consent.method ?? "gm_tick"
            : undefined,
          noticeVersion: confirmed
            ? str(body.consent.noticeVersion) ?? session.consent.noticeVersion ?? CONSENT_NOTICE_VERSION
            : undefined
        };
      }
      await this.sessions.save(next);
      await this.sessions.writeConsentRecord(next.sessionId);
      this.sse.broadcast("session.updated", { sessionId: next.sessionId, status: next.status });
      return this.sessions.detail(next.sessionId);
    });

    app.put<{ Params: { id: string } }>("/api/sessions/:id/merge-settings", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before changing roll context", 409);
      }
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const before = num(request.body.rollContextBeforeMs);
      const after = num(request.body.rollContextAfterMs);
      if (before == null || before < 0 || before > 300_000) apiError("invalid_roll_context", "Speech before a roll can be 0 to 300 seconds.");
      if (after == null || after < 0 || after > 300_000) apiError("invalid_roll_context", "Speech after a roll can be 0 to 300 seconds.");
      const updated = await this.sessions.setMergeSettings(session.sessionId, before, after);
      this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: updated.status });
      return this.sessions.detail(session.sessionId);
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/archive", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (["joining", "recording", "stopping"].includes(session.status)) {
        apiError("invalid_state", "Stop the recording before archiving this session", 409);
      }
      const body = isRecord(request.body) ? request.body : {};
      const archived = "archived" in body ? bool(body.archived) : true;
      if (archived == null) apiError("invalid_archived", "That option needs to be on or off.");
      const updated = await this.sessions.setArchived(session.sessionId, archived);
      if (archived && this.currentSessionId === session.sessionId) this.currentSessionId = null;
      this.sse.broadcast("session.updated", { sessionId: updated.sessionId, status: updated.status });
      return this.sessions.detail(session.sessionId);
    });

    app.delete<{ Params: { id: string }; Querystring: { confirm?: string } }>("/api/sessions/:id", async (request, reply) => {
      const session = await this.sessions.get(request.params.id);
      if (request.query.confirm !== session.sessionId) {
        apiError("confirmation_required", "Confirm with the session ID to delete this session.", 409);
      }
      await this.sessions.deleteSession(session.sessionId);
      if (this.currentSessionId === session.sessionId) this.currentSessionId = null;
      this.sse.broadcast("session.deleted", { sessionId: session.sessionId });
      return reply.code(204).send();
    });

    app.put<{ Params: { id: string } }>("/api/sessions/:id/people", async (request) => {
      await this.sessions.get(request.params.id);
      if (this.store.listJobs(request.params.id).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before changing people mapping", 409);
      }
      if (!isRecord(request.body) || !Array.isArray(request.body.people)) {
        apiError("invalid_people", "That people list is not valid.");
      }
      const people = request.body.people.filter(isRecord).slice(0, 100).map((person) => ({
        personId: str(person.personId) ?? "",
        role: person.role === "gm" || person.role === "observer" ? person.role : "player",
        discordUserId: str(person.discordUserId),
        discordName: str(person.discordName),
        foundryUserId: str(person.foundryUserId),
        foundryUserName: str(person.foundryUserName),
        character: str(person.character),
        aliases: Array.isArray(person.aliases) ? person.aliases.map(String) : [],
        consent: person.consent !== false,
        consentStatus:
          person.consentStatus === "opted_out" || person.consentStatus === "opted_in" || person.consentStatus === "assumed"
            ? person.consentStatus
            : person.consent === false
              ? "opted_out"
              : undefined,
        consentSource:
          person.consentSource === "foundry" || person.consentSource === "gm" || person.consentSource === "dashboard"
            ? person.consentSource
            : undefined,
        consentUpdatedAtMs: num(person.consentUpdatedAtMs) ?? undefined
      })) as Person[];
      const savedPeople = await this.sessions.updatePeople(request.params.id, people);
      if (this.recorder.activeSessionId === request.params.id) {
        this.recorder.setOptOutUsers(
          savedPeople
            .filter(personIsOptedOut)
            .map((person) => person.discordUserId)
            .filter((id): id is string => Boolean(id))
        );
      }
      this.sse.broadcast("session.updated", { sessionId: request.params.id });
      return this.sessions.detail(request.params.id);
    });

    const startRecordingSession = async (sessionId: string, promptPlayers: boolean) => {

      let session = await this.sessions.get(sessionId);
      if (this.recorder.isActive()) apiError("invalid_state", "Capture is already active", 409);
      if (!["draft", "error"].includes(session.status)) apiError("invalid_state", `This session is not ready to start yet.`, 409);
      const foundryPrompt = this.store.getConsentPrompt(session.world.id);
      const promptFresh = foundryPrompt != null && Date.now() - foundryPrompt.promptedAtMs < 24 * 60 * 60_000;
      if (promptPlayers) {
        const bridge = this.liveStatusSnapshot();
        if (!bridge.enabled || !bridge.connected) {
          apiError("bridge_not_connected", "The Foundry bridge is not connected; enable the module and token in Setup first", 409);
        }
        if (!versionAtLeast(bridge.moduleVersion, FOUNDRY_CONSENT_COMMAND_VERSION)) {
          apiError(
            "module_outdated",
            `Foundry is running module ${bridge.moduleVersion ?? "unknown"}; install ${FOUNDRY_CONSENT_COMMAND_VERSION} and refresh the Foundry client to prompt players from the dashboard`,
            409
          );
        }
        const promptedAtMs = Date.now();
        this.store.recordConsentPrompt(
          session.world.id,
          promptedAtMs,
          CONSENT_NOTICE_VERSION,
          "GM start prompt"
        );
        this.queueBridgeCommand("prompt_consent", {
          sessionId: session.sessionId,
          worldId: session.world.id,
          noticeVersion: CONSENT_NOTICE_VERSION
        });
        if (!session.consent.confirmed) {
          session = await this.sessions.confirmConsent(session, {
            method: "foundry",
            confirmedBy: "Foundry player consent prompt",
            atMs: promptedAtMs,
            promptedAtMs,
            noticeVersion: CONSENT_NOTICE_VERSION,
            notes: `${session.consent.notes ? `${session.consent.notes}\n` : ""}Consent prompt sent to players in Foundry; consent is assumed unless a player opted out.`
          });
          this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
        }
      }
      if (!session.consent.confirmed && promptFresh) {
        session = await this.sessions.confirmConsent(session, {
          method: "foundry",
          confirmedBy: "Foundry player consent prompt",
          atMs: foundryPrompt!.promptedAtMs,
          promptedAtMs: foundryPrompt!.promptedAtMs,
          noticeVersion: foundryPrompt!.noticeVersion,
          notes: `${session.consent.notes ? `${session.consent.notes}\n` : ""}Consent prompt sent to players in Foundry; consent is assumed unless a player opted out.`
        });
        this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
      }
      if (!session.consent.confirmed) apiError("consent_required", "Show players the recording notice before you start.", 409);
      if (!session.voiceChannel?.id) apiError("channel_required", "Pick a voice channel first.", 400);
      if (!this.discord.clientReady) apiError("discord_not_ready", "The Discord bot is not connected. Add its token in Setup, then restart.", 409);
      const manifest = await readJsonl(path.join(this.sessions.sessionDir(session.sessionId), "discord", "manifest.jsonl"));
      if (session.status === "error" && manifest.items.length > 0) {
        apiError("capture_exists", "This session already has captured audio; create a new session to re-record", 409);
      }
      const guildId = session.guild?.id;
      if (!guildId) apiError("guild_required", "Pick a Discord server first.", 400);
      const people = await this.sessions.applyConsentPreferences(
        session.sessionId,
        this.store.listConsentPreferences(session.world.id)
      );
      const optOutUserIds = people
        .filter(personIsOptedOut)
        .map((person) => person.discordUserId)
        .filter((id): id is string => Boolean(id));
      const joining = await this.sessions.setStatus(session, "joining");
      this.sse.broadcast("session.updated", { sessionId: joining.sessionId, status: "joining" });
      try {
        if (!this.discord.connectionReady() || this.discord.channelId() !== session.voiceChannel.id) {
          await this.discord.join(guildId, session.voiceChannel.id);
        }
        const startedAtMs = Date.now();
        await this.recorder.start({
          sessionId: joining.sessionId,
          sessionDir: this.sessions.sessionDir(joining.sessionId),
          optOutUserIds
        });
        const recording = await this.sessions.setStatus(joining, "recording", { startedAtMs, stoppedAtMs: null });
        this.currentSessionId = recording.sessionId;
        this.sse.broadcast("session.updated", { sessionId: recording.sessionId, status: "recording" });
        await this.emitStatus();
        return this.buildStatus();
      } catch (error) {
        await this.recorder.stop("manual").catch(() => undefined);
        const failed = await this.sessions.setStatus(joining, "error", {
          stoppedAtMs: Date.now(),
          notes: `${joining.notes ?? ""}\nStart failed: ${(error as Error).message}`.trim()
        });
        this.discord.leave();
        this.sse.broadcast("session.updated", { sessionId: failed.sessionId, status: "error" });
        apiError("start_failed", (error as Error).message, 409);
      }
    };

    app.post<{ Params: { id: string }; Body?: { promptPlayers?: boolean } }>("/api/sessions/:id/start", async (request) => {
      const promptPlayers = isRecord(request.body) && request.body.promptPlayers === true;
      return startRecordingSession(request.params.id, promptPlayers);
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/pause", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (session.status !== "recording" || this.recorder.activeSessionId !== session.sessionId) {
        apiError("invalid_state", "That session is not recording.", 409);
      }
      await this.recorder.pause();
      this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: "recording", paused: true });
      await this.emitStatus();
      return this.buildStatus();
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/resume", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (session.status !== "recording" || this.recorder.activeSessionId !== session.sessionId) {
        apiError("invalid_state", "That session is not recording.", 409);
      }
      await this.recorder.resume();
      this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: "recording", paused: false });
      await this.emitStatus();
      return this.buildStatus();
    });

    const stopRecordingSession = async (sessionId: string) => {

      const session = await this.sessions.get(sessionId);
      if (!["recording", "joining", "stopping"].includes(session.status)) {
        apiError("invalid_state", `Session is not recording (status ${session.status})`, 409);
      }
      if (session.status === "joining") {
        await this.sessions.setStatus(session, "error", { stoppedAtMs: Date.now() });
        this.discord.leave();
        return this.buildStatus();
      }
      const stopping = await this.sessions.setStatus(session, "stopping");
      this.sse.broadcast("session.updated", { sessionId: stopping.sessionId, status: "stopping" });
      try {
        const diag = await this.recorder.stop("stop");
        const refreshed = await this.sessions.refreshRecordingStats(session.sessionId);
        const captured = await this.sessions.setStatus(refreshed, "captured", {
          stoppedAtMs: Date.now(),
          recording: {
            ...refreshed.recording,
            utteranceCount: diag.utteranceCount,
            totalBytes: diag.totalBytes,
            decryptionFailures: diag.decryptionFailures,
            reconnectCount: diag.reconnectCount
          }
        });
        this.sse.broadcast("session.updated", { sessionId: captured.sessionId, status: "captured" });
        this.discord.leave();
        await this.emitStatus();
        return this.buildStatus();
      } catch (error) {
        await this.sessions
          .setStatus(stopping, "error", {
            stoppedAtMs: Date.now(),
            notes: `${stopping.notes ?? ""}\nStop failed: ${(error as Error).message}`.trim()
          })
          .catch(() => undefined);
        this.discord.leave();
        apiError("stop_failed", (error as Error).message, 500);
      }
    };

    app.post<{ Params: { id: string } }>("/api/sessions/:id/stop", async (request) => {
      return stopRecordingSession(request.params.id);
    });

    app.post<{ Body?: { action?: unknown; sessionId?: unknown; promptPlayers?: unknown } }>("/api/foundry/control", async (request) => {
      const token = typeof request.headers["x-tablerecords-token"] === "string" ? request.headers["x-tablerecords-token"] : "";
      if (!token || !this.bridgeToken || !safeEqual(token, this.bridgeToken)) {
        apiError("unauthorized", "Bridge authentication required", 401);
      }
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const action = str(request.body.action)?.trim();
      if (action === "status") {
        return {
          ok: true,
          state: this.recorder.captureState,
          sessionId: this.recorder.activeSessionId ?? this.currentSessionId
        };
      }
      const requested = str(request.body.sessionId)?.trim() || null;
      const sessionId = requested || this.recorder.activeSessionId || this.currentSessionId;
      if (!sessionId) apiError("no_session", "No TableRecords session is selected.", 409);
      if (action === "start") {
        return startRecordingSession(sessionId, request.body.promptPlayers !== false);
      }
      if (action === "stop") {
        return stopRecordingSession(sessionId);
      }
      if (action === "pause" || action === "resume") {
        const session = await this.sessions.get(sessionId);
        if (session.status !== "recording" || this.recorder.activeSessionId !== session.sessionId) {
          apiError("invalid_state", "That session is not recording.", 409);
        }
        if (action === "pause") await this.recorder.pause();
        else await this.recorder.resume();
        await this.emitStatus();
        return this.buildStatus();
      }
      apiError("invalid_action", "Use start, pause, resume, or stop.", 400);
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/markers", async (request, reply) => {
      const session = await this.sessions.get(request.params.id);
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const kind = str(request.body.kind) as MarkerKind | null;
      if (!kind || !MARKER_KINDS.has(kind)) apiError("invalid_marker_kind", "Pick a moment type: scene, break, combat, note, or other.");
      const mentalNote = bool(request.body.mentalNote) === true;
      const tsMs = num(request.body.tsMs) ?? Date.now();
      const label = str(request.body.label) ?? "";
      const marker = await this.sessions.addMarker(session.sessionId, kind, tsMs, label, mentalNote);
      this.sse.broadcast("marker.created", marker);
      return reply.code(201).send(marker);
    });

    app.delete<{ Params: { id: string; markerId: string } }>("/api/sessions/:id/markers/:markerId", async (request, reply) => {
      await this.sessions.deleteMarker(request.params.id, request.params.markerId);
      return reply.code(204).send();
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/foundry/import", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (["draft", "joining", "recording", "stopping"].includes(session.status)) {
        apiError("invalid_state", "Stop recording before importing Foundry data", 409);
      }
      if (this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before importing Foundry data", 409);
      }
      const file = await request.file();
      if (!file) apiError("file_required", "Upload one .json macro export as multipart field 'file'");
      if (!file.filename.toLowerCase().endsWith(".json")) apiError("invalid_file_type", "Only .json macro exports are accepted");
      const buffer = await file.toBuffer();
      if (buffer.length > MAX_UPLOAD) apiError("file_too_large", "Foundry export exceeds 64 MiB");
      let raw: string;
      try {
        raw = buffer.toString("utf8");
      } catch {
        apiError("invalid_encoding", "That file is not valid JSON.");
      }
      const summary = await importFoundryExport({
        sessionDir: this.sessions.sessionDir(session.sessionId),
        session,
        rawText: raw
      });
      this.sse.broadcast("foundry.imported", summary);
      await this.emitStatus();
      return summary;
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/context/recent", async (request, reply) => {
      const session = await this.sessions.get(request.params.id);
      const body = isRecord(request.body) ? request.body : {};
      let windowSeconds = this.config.recentContextSeconds;
      if ("windowSeconds" in body) {
        const value = num(body.windowSeconds);
        if (value == null) apiError("invalid_window", "The brief window needs a number of seconds.");
        windowSeconds = clampRecentSeconds(value);
      }
      let transcribe = true;
      if ("transcribe" in body) {
        const value = bool(body.transcribe);
        if (value == null) apiError("invalid_transcribe", "That option needs to be on or off.");
        transcribe = value;
      }
      if (transcribe) {
        // Fail fast when a transcription is already running; queueing behind it
        // is the job runner's job, not something a long-poll request should wait on.
        const probe = this.jobs.tryClaimTranscription(session.sessionId);
        if (!probe) apiError("transcription_active", "Another transcription is already running for this session", 409);
        probe();
      }
      const job = await this.jobs.enqueue(session.sessionId, "context", {
        windowSeconds,
        transcribe,
        endMs: num(body.endMs) ?? undefined
      });
      if (bool(body.queue) === true) return reply.code(202).send(job);
      const finished = await this.jobs.waitForJob(job.jobId);
      if (finished.status !== "done" || !finished.result) {
        const code = finished.status === "cancelled" ? "cancelled" : finished.error?.code ?? "context_failed";
        apiError(code, finished.error?.message ?? "GM context job did not complete", 502);
      }
      const result = finished.result as {
        generatedAtMs?: number;
        counts?: unknown;
        transcription?: { transcribed?: number };
      };
      this.sse.broadcast("recent.context", {
        sessionId: session.sessionId,
        jobId: job.jobId,
        generatedAtMs: result.generatedAtMs,
        counts: result.counts,
        transcribed: result.transcription?.transcribed ?? 0
      });
      if ((result.transcription?.transcribed ?? 0) > 0) {
        this.sse.broadcast("session.updated", { sessionId: session.sessionId });
      }
      return finished.result;
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/context/jobs", async (request, reply) => {
      const session = await this.sessions.get(request.params.id);
      const body = isRecord(request.body) ? request.body : {};
      let windowSeconds = this.config.recentContextSeconds;
      if ("windowSeconds" in body) {
        const value = num(body.windowSeconds);
        if (value == null) apiError("invalid_window", "The brief window needs a number of seconds.");
        windowSeconds = clampRecentSeconds(value);
      }
      let transcribe = true;
      if ("transcribe" in body) {
        const value = bool(body.transcribe);
        if (value == null) apiError("invalid_transcribe", "That option needs to be on or off.");
        transcribe = value;
      }
      const job = await this.jobs.enqueue(session.sessionId, "context", {
        windowSeconds,
        transcribe,
        endMs: num(body.endMs) ?? undefined
      });
      return reply.code(202).send(job);
    });
    app.post<{ Params: { id: string } }>("/api/sessions/:id/llm/summarize", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (["draft", "joining", "stopping"].includes(session.status)) {
        apiError("invalid_state", `LLM summaries need an active or finalized capture (status ${session.status})`, 409);
      }
      if (this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before requesting an LLM summary", 409);
      }
      const llmStatus = this.llm.status();
      if (!llmStatus.enabled) apiError("llm_disabled", "LLM summaries are disabled in Setup", 409);
      if (!llmStatus.configured) {
        apiError(
          "llm_not_configured",
          llmStatus.provider === "deepseek"
            ? "Turn on cloud summaries and add a DeepSeek key to the environment file before using DeepSeek"
            : "Choose a model in Setup first",
          409
        );
      }
      const body = isRecord(request.body) ? request.body : {};
      const presetId = "preset" in body ? summaryPreset(body.preset) : "gm-prep";
      if (!presetId) apiError("invalid_preset", "Pick a summary preset.");
      const scopeId: LlmSummaryScope = "scope" in body ? summaryScope(body.scope) ?? "recent" : "recent";
      const preset = SUMMARY_PRESETS[presetId];
      const progressId = str(body.progressId)?.slice(0, 100) || null;
      const reportProgress = (
        phase: "preparing" | "chunk" | "reduce" | "final" | "done",
        completed: number,
        total: number,
        label: string
      ): void => {
        if (!progressId) return;
        this.sse.broadcast("llm.progress", {
          progressId,
          sessionId: session.sessionId,
          phase,
          completed,
          total,
          label
        });
      };
      reportProgress("preparing", 0, 1, "Preparing the session brief");
      const nowMs = Date.now();
      let windowSeconds = this.config.recentContextSeconds;
      if ("windowSeconds" in body) {
        const value = num(body.windowSeconds);
        if (value == null) apiError("invalid_window", "The brief window needs a number of seconds.");
        windowSeconds = clampRecentSeconds(value);
      }
      const dir = this.sessions.sessionDir(session.sessionId);
      const markers = this.store.listMarkers(session.sessionId);
      const endMs = session.stoppedAtMs ?? nowMs;
      let windowStartMs: number | undefined;
      let windowEndMs: number | undefined;
      let windowLabel: string | undefined;
      if (scopeId === "scene") {
        const scene = [...markers]
          .filter((marker) => marker.kind === "scene" && marker.tsMs <= endMs)
          .sort((a, b) => a.tsMs - b.tsMs)
          .at(-1);
        windowStartMs = scene?.tsMs ?? Math.max(session.startedAtMs ?? endMs, endMs - 15 * 60_000);
        windowEndMs = endMs;
        windowLabel = scene ? "current scene" : "current scene (last 15 minutes)";
      } else if (scopeId === "session") {
        windowStartMs = session.startedAtMs ?? Math.max(0, endMs - 3_600_000);
        windowEndMs = endMs;
        windowLabel = "whole session";
      } else {
        const window = resolveRecentWindow(session, windowSeconds, num(body.endMs) ?? nowMs);
        windowStartMs = window.startMs;
        windowEndMs = window.endMs;
        windowLabel = window.label;
      }
      const [sources, imported, live, peopleFile] = await Promise.all([
        readRecentSource(dir),
        readJsonl<FoundryEvent>(path.join(dir, "foundry", "events.jsonl")),
        readJsonl<FoundryEvent>(path.join(dir, "foundry", "live-events.jsonl")),
        readJson<PeopleFile>(path.join(dir, "people.json"))
      ]);
      const brief = buildRecentContext({
        session,
        people: peopleFile?.people ?? [],
        transcripts: sources.transcripts,
        foundryEvents: [...imported.items, ...live.items],
        markers,
        windowStartMs,
        windowEndMs,
        windowLabel,
        includeSessionNotes: false,
        transcription: {
          requested: false,
          candidates: 0,
          transcribed: 0,
          alreadyPresent: 0,
          failed: 0,
          errors: []
        }
      });
      const inputBudget = summaryInputCharBudget(
        this.config.llmContextTokens,
        this.config.llmMaxInputChars,
        this.config.llmThinkingEffort
      );
      const merged = mergeRecords(
        session,
        peopleFile?.people ?? [],
        sources.transcripts,
        [...imported.items, ...live.items],
        markers
      );
      const ledgerTimeline = merged.timeline.filter(
        (event) => event.tsMs >= brief.window.startMs && event.tsMs <= brief.window.endMs
      );
      const extraBudget = Math.max(2_000, Math.min(22_000, Math.floor(inputBudget * 0.55)));
      const notesBudget = Math.min(16_000, Math.floor(extraBudget * 0.75));
      const ledger = buildSummaryLedger(
        ledgerTimeline,
        peopleFile?.people ?? [],
        session.timeZone,
        Math.max(1_000, extraBudget - notesBudget)
      );
      let notes = summaryNotesBlock(session.notes, notesBudget);
      const noteSplit = splitNotesByHeadings(session.notes, notesBudget);
      if (noteSplit.chunks.length > 1) {
        const digests: string[] = [];
        for (let index = 0; index < noteSplit.chunks.length; index += 1) {
          reportProgress("preparing", index, noteSplit.chunks.length, `Condensing notes ${index + 1} of ${noteSplit.chunks.length}`);
          const digest = await this.llm.summarize({
            system:
              "Condense these GM session notes factually. Preserve every heading, name, place, clue, decision, and unresolved question. " +
              "Do not invent anything. Return Markdown.",
            user: noteSplit.chunks[index]!,
            maxTokens: 600,
            thinkingEffort: "off"
          });
          digests.push(digest.text);
        }
        notes = {
          markdown: `## GM session notes\n\n${digests.join("\n\n")}`,
          chars: digests.join("\n\n").length,
          truncated: false,
          headings: noteSplit.headings
        };
      }
      let fixedContext = [ledger.markdown, notes.markdown].filter(Boolean).join("\n\n");
      const trimmed = trimSummaryBrief(brief.markdown, Math.max(1_000, inputBudget - 250));
      let summary: LlmSummary;
      let chunks = 1;
      let trimmedPortions = 0;
      let finalTrimmed = false;
      const extractedFacts = emptySummaryFacts();
      const finalSectionLabels =
        presetId === "gm-prep"
          ? ["Current situation", "People and clues", "Open threads", "GM reminders"]
          : presetId === "recap"
            ? ["What happened", "People", "Open questions"]
            : presetId === "rules"
              ? ["Questions raised", "Rulings", "Still unresolved"]
              : [];
      const chunkStartedAtMs = Date.now();
      if (
        scopeId !== "recent" &&
        windowStartMs != null &&
        windowEndMs != null &&
        brief.markdown.length > inputBudget
      ) {
        const target = Math.max(6_000, inputBudget - 500);
        chunks = summaryChunkCount(brief.markdown.length, target, 64);
        const windows: Array<{ startMs: number; endMs: number }> = Array.from({ length: chunks }, (_, index) => ({
          startMs: windowStartMs + Math.floor(((windowEndMs - windowStartMs) * index) / chunks),
          endMs:
            index === chunks - 1
              ? windowEndMs
              : windowStartMs + Math.floor(((windowEndMs - windowStartMs) * (index + 1)) / chunks)
        }));
        const buildPortion = (startMs: number, endMs: number, index: number, total: number) =>
          buildRecentContext({
            session,
            people: peopleFile?.people ?? [],
            transcripts: sources.transcripts,
            foundryEvents: [...imported.items, ...live.items],
            markers,
            windowStartMs: startMs,
            windowEndMs: endMs,
            windowLabel: `portion ${index + 1} of ${total}`,
            includeSessionNotes: false,
            transcription: {
              requested: false,
              candidates: 0,
              transcribed: 0,
              alreadyPresent: 0,
              failed: 0,
              errors: []
            }
          });
        // Dense windows are split until they fit. Equal-time slicing alone can
        // put a whole combat into one portion and silently trim its tail.
        for (let index = 0; index < windows.length && windows.length < 64; ) {
          const window = windows[index]!;
          if (window.endMs - window.startMs <= 2_000) {
            index += 1;
            continue;
          }
          const candidate = buildPortion(window.startMs, window.endMs, index, Math.max(chunks, windows.length));
          if (candidate.markdown.length <= target || windows.length >= 64) {
            index += 1;
            continue;
          }
          const middle = window.startMs + Math.floor((window.endMs - window.startMs) / 2);
          windows.splice(index, 1, { startMs: window.startMs, endMs: middle }, { startMs: middle, endMs: window.endMs });
        }
        chunks = windows.length;
        let portions: string[] = [];
        for (let index = 0; index < chunks; index += 1) {
          reportProgress("chunk", index, chunks, `Summarizing portion ${index + 1} of ${chunks}`);
          const window = windows[index]!;
          const portionBrief = buildPortion(window.startMs, window.endMs, index, chunks);
          const portionText = trimSummaryBrief(portionBrief.markdown, target);
          if (portionText.trimmed) trimmedPortions += 1;
          const portion = await this.summarizeWithFallback({
            system: SUMMARY_CHUNK_SYSTEM,
            user: portionText.markdown,
            maxTokens: 700
          });
          portions.push(`## Portion ${index + 1}\n\n${portion.text}`);
          try {
            const factsText = await this.llm.summarize({
              system: SUMMARY_FACTS_SYSTEM,
              user: portionText.markdown,
              maxTokens: 1_200,
              json: true,
              jsonSchema: SUMMARY_FACTS_SCHEMA,
              thinkingEffort: "off"
            });
            const parsedFacts = parseSummaryFacts(factsText.text);
            if (parsedFacts) mergeSummaryFacts(extractedFacts, parsedFacts);
          } catch {
            // A failed extraction must not fail the summary; the prose portion remains.
          }
        }
        reportProgress("chunk", chunks, chunks, "Portion summaries ready");
        let rounds = 0;
        while (portions.length > 1 && portions.join("\n\n").length > target && rounds < 8) {
          const groupSize = Math.max(2, Math.floor(target / 2_800));
          const reduced: string[] = [];
          for (let index = 0; index < portions.length; index += groupSize) {
            reportProgress("reduce", index, portions.length, `Reducing summaries, round ${rounds + 1}`);
            const group = portions.slice(index, index + groupSize).join("\n\n");
            const merged = await this.summarizeWithFallback({
              system: SUMMARY_CHUNK_SYSTEM,
              user: `# Portion summaries\n\n${group}`,
              maxTokens: 700
            });
            reduced.push(merged.text);
          }
          portions = reduced;
          rounds += 1;
        }
        const factsBlock = summaryFactsBlock(extractedFacts, 8_000);
        if (factsBlock) fixedContext = [fixedContext, factsBlock].filter(Boolean).join("\n\n");
        const portionBudget = Math.max(1_000, target - fixedContext.length - 200);
        const reduced = trimSummaryBrief(portions.join("\n\n"), portionBudget);
        if (reduced.trimmed) finalTrimmed = true;
        const reducedBrief = reduced.markdown;
        const finalBrief = [fixedContext, "## Portion summaries", reducedBrief].filter(Boolean).join("\n\n");
        const finalTrim = trimSummaryBrief(finalBrief, Math.max(2_000, inputBudget - 250));
        if (finalTrim.trimmed) finalTrimmed = true;
        const finalInput = finalTrim.markdown;
        const finalSystem = `${preset.system} This is a whole-session synthesis: use up to 900 words and preserve every relevant ledger fact.`;
        const finalSections = !preset.json ? finalSectionLabels : [];
        let lastSummary: LlmSummary | null = null;
        if (finalSections.length > 0) {
          const sectionTexts: string[] = [];
          for (let index = 0; index < finalSections.length; index += 1) {
            const label = finalSections[index]!;
            reportProgress("final", index, finalSections.length, `Writing ${label.toLowerCase()}`);
            const section = await this.summarizeWithFallback({
              system: `${finalSystem} Return only the "${label}" section, with that heading. Do not repeat the other sections.`,
              user: `${summaryUserPrompt(presetId, finalInput)}\n\nWrite only the "${label}" section.`,
              maxTokens: 900
            });
            lastSummary = section;
            const body = section.text
              .trim()
              .replace(new RegExp(`^#{1,4}\\s*${label}\\s*\\n+`, "i"), "")
              .trim();
            sectionTexts.push(`## ${label}\n\n${body}`);
          }
          summary = {
            ...(lastSummary as LlmSummary),
            text: sectionTexts.join("\n\n"),
            elapsedMs: Date.now() - chunkStartedAtMs
          };
        } else {
          reportProgress("final", 0, 1, "Writing the final notes");
          summary = await this.summarizeWithFallback({
            system: finalSystem,
            user: summaryUserPrompt(presetId, finalInput),
            maxTokens: Math.max(preset.maxTokens, 1_800),
            json: preset.json,
            jsonSchema: preset.jsonSchema
          });
          summary = { ...summary, elapsedMs: Date.now() - chunkStartedAtMs };
        }
      } else {
        const room = Math.max(0, inputBudget - 250 - trimmed.markdown.length - 100);
        const extraTrim = room > 0 ? trimSummaryBrief(fixedContext, room) : null;
        if (extraTrim?.trimmed) finalTrimmed = true;
        const extra = extraTrim?.markdown ?? "";
        const finalBrief = [trimmed.markdown, extra].filter(Boolean).join("\n\n");
        reportProgress("final", 0, 1, "Writing the final notes");
        summary = await this.summarizeWithFallback({
          system: preset.system,
          user: summaryUserPrompt(presetId, finalBrief),
          maxTokens: preset.maxTokens,
          json: preset.json,
          jsonSchema: preset.jsonSchema
        });
      }
      let coverage: LlmSummaryRecord["coverage"];
      if (!preset.json) {
        const sectionFor = new Map<string, string>();
        const addRequired = (values: string[], section: string) => {
          for (const value of values) {
            const clean = value.trim();
            if (clean.length > 1 && !sectionFor.has(clean)) sectionFor.set(clean, section);
          }
        };
        addRequired(ledger.requiredPeople, "People and clues");
        addRequired(ledger.requiredMarkers, "GM reminders");
        addRequired(ledger.requiredMentalNotes, "GM reminders");
        addRequired(notes.headings, "GM reminders");
        addRequired(extractedFacts.names, "People and clues");
        addRequired(extractedFacts.places, "People and clues");
        addRequired(extractedFacts.items, "People and clues");
        addRequired(extractedFacts.clues, "People and clues");
        addRequired(extractedFacts.decisions, "Open threads");
        addRequired(extractedFacts.questions, "Open threads");
        const required = [...sectionFor.keys()];
        const substringMissing = required.filter((value) => !summary.text.toLowerCase().includes(value.toLowerCase()));
        let remaining = substringMissing.length > 0
          ? await this.semanticMissingFacts(substringMissing, summary.text)
          : [];
        let repaired = 0;
        const expectedHeadings = chunks > 1 && !preset.json ? finalSectionLabels : [];
        for (let attempt = 0; attempt < 3 && remaining.length > 0; attempt += 1) {
          reportProgress("final", attempt, 3, `Repairing missing facts, pass ${attempt + 1}`);
          let accepted = false;
          try {
            const repair = await this.summarizeWithFallback({
              system:
                "You are correcting a tabletop session summary. Add every missing fact under the most appropriate existing heading. " +
                "Do not remove or reword established facts. Return the complete corrected summary in Markdown.",
              user: `# Existing summary\n\n${summary.text}\n\n# Missing facts\n\n${remaining.map((value) => `- ${value}`).join("\n")}`,
              maxTokens: 2_000,
              thinkingEffort: "off"
            });
            const retainsHeadings = expectedHeadings.every((heading) =>
              repair.text.toLowerCase().includes(heading.toLowerCase())
            );
            const stillMissing = required.filter((value) => !repair.text.toLowerCase().includes(value.toLowerCase()));
            if (retainsHeadings && stillMissing.length < remaining.length) {
              summary = { ...summary, text: repair.text, model: repair.model };
              repaired += remaining.length - stillMissing.length;
              remaining = stillMissing;
              accepted = true;
            }
          } catch {
            // Try the next pass, then fall back to appending the remaining facts.
          }
          if (!accepted) break;
        }
        if (remaining.length > 0) {
          const unplaced: string[] = [];
          for (const fact of remaining) {
            const section = sectionFor.get(fact);
            if (presetId === "gm-prep" && section) {
              summary = { ...summary, text: insertFactUnderHeading(summary.text, section, fact) };
              repaired += 1;
            } else {
              unplaced.push(fact);
            }
          }
          if (unplaced.length > 0) {
            summary = {
              ...summary,
              text: `${summary.text.trim()}\n\n## Additional facts\n\n${unplaced.map((value) => `- ${value}`).join("\n")}`
            };
            repaired += unplaced.length;
          }
          remaining = required.filter((value) => !summary.text.toLowerCase().includes(value.toLowerCase()));
        }
        coverage = { checked: required.length, missing: remaining, repaired };
      }
      let structured: unknown | null = null;
      if (preset.json) {
        try {
          structured = parseStructuredSummary(summary.text);
        } catch (error) {
          if (error instanceof SummaryFormatError) {
            throw new LlmError("llm_invalid_json", `${error.message}. Try the clue board again or use another preset.`, 502);
          }
          throw error;
        }
      }
      const record: LlmSummaryRecord = {
        schema: "tablerecords.llm-summary/v2",
        summaryId: `llm_${crypto.randomUUID()}`,
        sessionId: session.sessionId,
        provider: llmStatus.provider,
        model: summary.model,
        preset: presetId,
        scope: scopeId,
        window: brief.window,
        promptVersion: SUMMARY_PROMPT_VERSION,
        briefChars: brief.markdown.length,
        estimatedTokens: estimateTokens(brief.markdown),
        trimmed: trimmedPortions > 0 || ledger.truncated || notes.truncated || finalTrimmed || (chunks === 1 && trimmed.trimmed),
        portionsTrimmed: trimmedPortions,
        ledgerChars: ledger.markdown.length,
        notesChars: notes.chars,
        coverage,
        chunks,
        summary: summary.text,
        structured,
        elapsedMs: summary.elapsedMs,
        createdAtMs: Date.now()
      };
      await appendLlmSummary(dir, record);
      reportProgress("done", 1, 1, "Summary ready");
      return record;
    });

    app.get<{ Params: { id: string } }>("/api/sessions/:id/llm/summaries", async (request) => {
      const session = await this.sessions.get(request.params.id);
      return { summaries: await listLlmSummaries(this.sessions.sessionDir(session.sessionId)) };
    });

    app.get<{ Params: { id: string; summaryId: string } }>(
      "/api/sessions/:id/llm/summaries/:summaryId",
      async (request) => {
        const session = await this.sessions.get(request.params.id);
        const summaries = await listLlmSummaries(this.sessions.sessionDir(session.sessionId));
        const found = summaries.find((item) => item.summaryId === request.params.summaryId);
        if (!found) apiError("not_found", "That summary was not found.", 404);
        return found;
      }
    );

    app.get<{ Params: { id: string } }>("/api/sessions/:id/jobs", async (request) => {
      await this.sessions.get(request.params.id);
      return { jobs: this.store.listJobs(request.params.id) };
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/jobs", async (request, reply) => {
      await this.sessions.get(request.params.id);
      if (!isRecord(request.body)) apiError("invalid_body", "That request was not a JSON object.");
      const type = str(request.body.type) as JobType | null;
      if (!type) apiError("job_type_required", "Pick a job type.");
      const requestBody = isRecord(request.body) ? request.body : {};
      const extras =
        type === "context"
          ? {
              windowSeconds: num(requestBody.windowSeconds) ?? this.config.recentContextSeconds,
              transcribe: bool(requestBody.transcribe) ?? true,
              endMs: num(requestBody.endMs) ?? undefined
            }
          : {};
      const job = await this.jobs.enqueue(request.params.id, type, extras);
      return reply.code(202).send(job);
    });

    app.get<{ Params: { jobId: string } }>("/api/jobs/:jobId", async (request) => {
      const job = this.store.getJob(request.params.jobId);
      if (!job) apiError("not_found", `Job not found: ${request.params.jobId}`, 404);
      return job;
    });

    app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/cancel", async (request) => this.jobs.cancel(request.params.jobId));

    app.post<{ Params: { jobId: string } }>("/api/jobs/:jobId/retry", async (request, reply) => {
      const job = await this.jobs.retry(request.params.jobId);
      return reply.code(202).send(job);
    });

    app.get<{ Params: { jobId: string }; Querystring: { afterSeq?: string; limit?: string } }>(
      "/api/jobs/:jobId/logs",
      async (request) => {
        const afterSeq = Number.parseInt(request.query.afterSeq ?? "0", 10) || 0;
        const limit = Math.min(1000, Math.max(1, Number.parseInt(request.query.limit ?? "200", 10) || 200));
        return { jobId: request.params.jobId, lines: await this.jobs.logs(request.params.jobId, afterSeq, limit) };
      }
    );

    app.get<{ Params: { id: string } }>("/api/sessions/:id/outputs", async (request) => {
      await this.sessions.get(request.params.id);
      const dir = path.join(this.sessions.sessionDir(request.params.id), "outputs");
      const outputs: Array<{ name: string; sizeBytes: number; modifiedAtMs: number; previewable: boolean }> = [];
      for (const name of OUTPUT_FILES) {
        try {
          const stat = await fsp.stat(path.join(dir, name));
          outputs.push({
            name,
            sizeBytes: stat.size,
            modifiedAtMs: stat.mtimeMs,
            previewable: name.endsWith(".md") || name.endsWith(".csv")
          });
        } catch {
          // not generated yet
        }
      }
      return { outputs };
    });

    app.get<{ Params: { id: string; fileName: string }; Querystring: { download?: string } }>(
      "/api/sessions/:id/outputs/:fileName",
      async (request, reply) => {
        await this.sessions.get(request.params.id);
        const name = request.params.fileName;
        if (!(OUTPUT_FILES as readonly string[]).includes(name)) apiError("not_found", "Output file is not in the allowlist", 404);
        const file = path.join(this.sessions.sessionDir(request.params.id), "outputs", name);
        if (!(await pathExists(file))) apiError("not_found", "Output has not been generated yet", 404);
        reply.type(name.endsWith(".csv") ? "text/csv; charset=utf-8" : "text/markdown; charset=utf-8");
        const disposition = request.query.download === "1" ? "attachment" : "inline";
        reply.header("Content-Disposition", `${disposition}; filename="${name}"`);
        return reply.send(fs.createReadStream(file));
      }
    );

    app.post<{ Params: { id: string } }>("/api/sessions/:id/review-audio", async (request) => {
      const session = await this.sessions.get(request.params.id);
      if (["joining", "recording", "stopping"].includes(session.status)) {
        apiError("invalid_state", "Stop the recording before building review audio", 409);
      }
      if (this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before building review audio", 409);
      }
      const dir = this.sessions.sessionDir(session.sessionId);
      const manifest = await readJsonl<DiscordUtterance>(path.join(dir, "discord", "manifest.jsonl"));
      try {
        const result = await buildReviewAudio({
          config: this.config,
          session,
          sessionDir: dir,
          manifest: manifest.items
        });
        this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
        return result;
      } catch (error) {
        if (error instanceof ReviewAudioError) apiError(error.code, error.message, error.statusCode);
        throw error;
      }
    });

    const ensureReviewForStorage = async (session: SessionRecord, dir: string): Promise<void> => {
      if (await reviewAudioReady(dir)) return;
      const manifest = await readJsonl<DiscordUtterance>(path.join(dir, "discord", "manifest.jsonl"));
      await buildReviewAudio({
        config: this.config,
        session,
        sessionDir: dir,
        manifest: manifest.items
      });
      this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
    };

    const assertStorageAllowed = async (sessionId: string): Promise<SessionRecord> => {
      const session = await this.sessions.get(sessionId);
      if (["joining", "recording", "stopping"].includes(session.status)) {
        apiError("invalid_state", "Stop the recording before changing stored audio", 409);
      }
      if (this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running")) {
        apiError("job_active", "Wait for the active processing job before changing stored audio", 409);
      }
      return session;
    };

    app.post<{ Params: { id: string } }>("/api/sessions/:id/audio/compact", async (request) => {
      const session = await assertStorageAllowed(request.params.id);
      const dir = this.sessions.sessionDir(session.sessionId);
      const state = await readAudioStorage(dir);
      if (state.state === "removed") apiError("audio_removed", "The clip audio has already been removed", 409);
      if (state.state === "compacted") return { before: state, after: state, converted: 0 };
      try {
        await ensureReviewForStorage(session, dir);
        const result = await compactSessionAudio({ session, sessionDir: dir });
        this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
        return result;
      } catch (error) {
        if (error instanceof AudioStorageError) apiError(error.code, error.message, error.statusCode);
        if (error instanceof ReviewAudioError) apiError(error.code, error.message, error.statusCode);
        throw error;
      }
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/audio/remove", async (request) => {
      const session = await assertStorageAllowed(request.params.id);
      const dir = this.sessions.sessionDir(session.sessionId);
      const state = await readAudioStorage(dir);
      if (state.state === "removed") return { before: state, after: state };
      try {
        await ensureReviewForStorage(session, dir);
        const result = await removeSessionAudio({ session, sessionDir: dir });
        this.sse.broadcast("session.updated", { sessionId: session.sessionId, status: session.status });
        return result;
      } catch (error) {
        if (error instanceof AudioStorageError) apiError(error.code, error.message, error.statusCode);
        if (error instanceof ReviewAudioError) apiError(error.code, error.message, error.statusCode);
        throw error;
      }
    });

    app.get<{ Params: { id: string; fileName: string } }>(
      "/api/sessions/:id/review-audio/:fileName/waveform",
      async (request, reply) => {
        const session = await this.sessions.get(request.params.id);
        const dir = this.sessions.sessionDir(session.sessionId);
        const manifest = await readJson<ReviewAudioManifest>(path.join(dir, "review", "manifest.json"));
        const entry = manifest?.files.find((file) => file.name === request.params.fileName);
        if (!entry || !entry.name.endsWith(".mp3")) apiError("not_found", "Review audio file not found", 404);
        const file = await resolveExistingInside(path.join(dir, "review"), entry.name);
        try {
          const png = await ensureReviewWaveform({
            config: this.config,
            sessionDir: dir,
            input: file,
            name: entry.name
          });
          reply.header("Cache-Control", "private, max-age=86400");
          reply.type("image/png");
          return reply.send(fs.createReadStream(png));
        } catch (error) {
          if (error instanceof ReviewAudioError) apiError(error.code, error.message, error.statusCode);
          throw error;
        }
      }
    );

    app.get<{ Params: { id: string; fileName: string } }>("/api/sessions/:id/review-audio/:fileName", async (request, reply) => {
      const session = await this.sessions.get(request.params.id);
      const dir = this.sessions.sessionDir(session.sessionId);
      const manifest = await readJson<ReviewAudioManifest>(path.join(dir, "review", "manifest.json"));
      const entry = manifest?.files.find((file) => file.name === request.params.fileName);
      if (!entry || !entry.name.endsWith(".mp3")) apiError("not_found", "Review audio file not found", 404);
      const file = await resolveExistingInside(path.join(dir, "review"), entry.name);
      reply.header("Content-Disposition", `inline; filename="${entry.name}"`);
      return streamMedia(request, reply, file, "audio/mpeg");
    });

    app.get<{ Params: { id: string; utteranceId: string } }>("/api/sessions/:id/audio/:utteranceId", async (request, reply) => {
      await this.sessions.get(request.params.id);
      const dir = this.sessions.sessionDir(request.params.id);
      const manifest = await readJsonl<{ utteranceId: string; file: string }>(path.join(dir, "discord", "manifest.jsonl"));
      const record = manifest.items.find((item) => item.utteranceId === request.params.utteranceId);
      if (!record) apiError("not_found", "Utterance not found", 404);
      const file = await resolveExistingInside(dir, record.file);
      if (!file.toLowerCase().endsWith(".wav")) apiError("not_found", "Utterance is not a WAV file", 404);
      return streamMedia(request, reply, file, "audio/wav");
    });

    app.post<{ Params: { id: string } }>("/api/sessions/:id/open-folder", async (request, reply) => {
      const dir = this.sessions.sessionDir(request.params.id);
      await this.sessions.get(request.params.id);
      execFile("explorer.exe", [dir], { windowsHide: false }, () => undefined);
      return reply.code(204).send();
    });
  }

  private async finishCaptureTest(reason: "manual" | "timeout"): Promise<unknown> {
    const test = this.activeTest;
    if (!test) apiError("invalid_state", "No capture test is active", 409);
    if (test.timer) clearTimeout(test.timer);
    this.activeTest = null;
    const diagnostics = await this.recorder.stop("manual");
    this.discord.leave();
    this.sse.broadcast("capture-test.finished", { ...diagnostics, testId: test.testId, reason });
    await this.emitStatus();
    return {
      testId: test.testId,
      startedAtMs: test.startedAtMs,
      reason,
      utteranceCount: diagnostics.utteranceCount,
      totalBytes: diagnostics.totalBytes,
      decryptionFailures: diagnostics.decryptionFailures,
      speakers: diagnostics.speakers,
      warnings: diagnostics.warnings,
      health: diagnostics.health,
      state: diagnostics.state
    };
  }

  private settingsPayload(): Record<string, unknown> {
    return {
      settings: {
        foundryDataPath: this.foundryPath(),
        defaultGuildId: this.store.getSetting("default_guild_id", this.config.defaultGuildId),
        defaultVoiceChannelId: this.store.getSetting("default_voice_channel_id", null),
        discordBotName: this.config.discordBotName,
        discordActivityType: this.config.discordActivityType,
        discordActivityText: this.config.discordActivityText,
        discordActivityDynamic: this.config.discordActivityDynamic,
        sttEngine: this.config.sttEngine,
        sttModel: this.config.sttModel,
        sttDevice: this.config.sttDevice,
        sttComputeType: this.config.sttComputeType,
        sttLanguage: this.config.sttLanguage,
        sttBeamSize: this.config.sttBeamSize,
        sttVadFilter: this.config.sttVadFilter,
        sttNoSpeechThreshold: this.config.sttNoSpeechThreshold,
        sttLogProbThreshold: this.config.sttLogProbThreshold,
        sttCompressionRatioThreshold: this.config.sttCompressionRatioThreshold,
        sttPromptExtra: this.config.sttPromptExtra,
        sttHotwordsExtra: this.config.sttHotwordsExtra,
        parakeetPath: this.config.parakeetPath,
        parakeetModel: this.config.parakeetModel,
        parakeetDevice: this.config.parakeetDevice,
        parakeetConcurrency: this.config.parakeetConcurrency,
        rollContextBeforeMs: this.config.rollContextBeforeMs,
        rollContextAfterMs: this.config.rollContextAfterMs,
        recentContextSeconds: this.config.recentContextSeconds,
        sttModelDir: this.config.sttModelDir,
        captureTestMaxSeconds: this.config.captureTestMaxSeconds
      },
      llm: this.llm.status(),
      llamacpp: this.llamacpp.snapshot(),
      foundryBridge: {
        token: this.bridgeToken,
        tokenManagedByEnv: this.bridgeTokenManagedByEnv(),
        status: this.liveStatusSnapshot()
      },
      env: {
        port: this.config.port,
        host: this.config.host,
        projectRoot: this.config.projectRoot,
        discordTokenConfigured: Boolean(this.config.discordToken),
        discordClientId: this.config.discordClientId,
        dashboardTokenConfigured: Boolean(this.config.dashboardToken),
        pythonPath: this.config.pythonPath,
        sessionsDir: this.config.sessionsDir,
        dataDir: this.config.dataDir,
        timeZone: this.config.timeZone,
        webBuildPresent: ensureWebBuild(this.config),
        version: APP_VERSION
      }
    };
  }

  private async registerStatic(): Promise<void> {
    if (fs.existsSync(path.join(this.config.webDir, "index.html"))) {
      await this.fastify.register(fastifyStatic, {
        root: this.config.webDir,
        prefix: "/",
        wildcard: true,
        index: ["index.html"]
      });
    }
    this.fastify.setNotFoundHandler(async (request, reply) => {
      if (request.url.startsWith("/api/")) {
        return reply.code(404).send({ error: { code: "not_found", message: "API endpoint not found", details: {} } });
      }
      const indexFile = path.join(this.config.webDir, "index.html");
      if (fs.existsSync(indexFile)) {
        reply.type("text/html; charset=utf-8");
        return reply.send(fs.createReadStream(indexFile));
      }
      reply.type("text/html; charset=utf-8");
      return reply.send(`<!doctype html><html><body style="font-family:system-ui;background:#111;color:#eee;padding:2rem">
        <h1>TableRecords API is running</h1>
        <p>The dashboard build is missing. Run <code>npm run build:web</code>, then refresh.</p>
        <p>API: <a style="color:#7dd3fc" href="/api/status">/api/status</a></p></body></html>`);
    });
  }

  async listen(): Promise<string> {
    await this.fastify.listen({ host: this.config.host, port: this.config.port });
    return `${this.config.host}:${this.config.port}`;
  }

  async close(): Promise<void> {
    this.closing = true;
    if (this.statusTimer) clearTimeout(this.statusTimer);
    this.statusTimer = null;
    if (this.activeTest?.timer) clearTimeout(this.activeTest.timer);
    this.recorder.abort();
    await this.llamacpp.stop().catch(() => undefined);
    await this.jobs.shutdown();
    this.sse.close();
    await this.discord.stop();
    await this.fastify.close();
    this.store.close();
  }
}
