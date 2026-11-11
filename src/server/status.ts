import fs from "node:fs";
import type { AppConfig } from "./config.js";
import type { Store } from "./store.js";
import type { SessionManager } from "./sessions.js";
import type { DiscordService } from "./discord.js";
import type { RecorderService } from "./recorder.js";
import type { PythonHealth } from "./stt.js";
import type { ParakeetHealth } from "./parakeet.js";
import type { FoundryImportSummary, FoundryLiveStatus, PeopleFile, SessionRecord } from "../core/types.js";
import { APP_SCHEMA, APP_VERSION } from "./config.js";
import { readJson } from "../core/paths.js";
import path from "node:path";
import { systemLabel } from "./foundryWorlds.js";

export interface StatusSnapshot {
  schema: typeof APP_SCHEMA;
  generatedAtMs: number;
  server: { version: string; startedAtMs: number; uptimeMs: number };
  bot: ReturnType<DiscordService["botStatus"]>;
  voice: ReturnType<DiscordService["voiceStatus"]>;
  capture: ReturnType<RecorderService["diagnostics"]> & {
    displayState: string;
    characterByUser: Record<string, string | null>;
  };
  session: {
    currentId: string | null;
    title: string | null;
    system: string | null;
    systemLabel: string | null;
    worldId: string | null;
    status: SessionRecord["status"] | null;
  };
  foundry: {
    imported: boolean;
    messageCount: number;
    rollCount: number;
    importedAtMs: number | null;
    warnings: string[];
    live: FoundryLiveStatus;
  };
  jobs: {
    queued: number;
    running: number;
    failed: number;
    active: ReturnType<Store["activeJob"]>;
  };
  stt: {
    engine: "faster-whisper" | "parakeet";
    available: boolean;
    device: string;
    model: string;
    modelPresent: boolean;
    state: string;
    error: string | null;
  };
  disk: { freeBytes: number | null };
  warnings: Array<{ code: string; message: string }>;
}

export interface StatusDeps {
  config: AppConfig;
  store: Store;
  sessions: SessionManager;
  discord: DiscordService;
  recorder: RecorderService;
  pythonHealth: PythonHealth | null;
  parakeetHealth: ParakeetHealth | null;
  startedAtMs: number;
  currentSessionId: string | null;
  foundryLive: FoundryLiveStatus;
}

function diskFreeBytes(dir: string): number | null {
  try {
    const stats = fs.statfsSync(dir);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    return null;
  }
}

function defaultPeople(): PeopleFile {
  return { schema: "tablerecords.people/v1", sessionId: "", people: [] };
}

export async function buildStatus(deps: StatusDeps): Promise<StatusSnapshot> {
  const now = Date.now();
  const capture = deps.recorder.diagnostics();
  const bot = deps.discord.botStatus();
  const voice = deps.discord.voiceStatus();
  let session: SessionRecord | null = null;
  if (deps.currentSessionId) {
    session = await deps.sessions.get(deps.currentSessionId).catch(() => null);
  }
  if (!session) {
    const all = await deps.sessions.list();
    session =
      all.find((item) => ["recording", "joining", "stopping"].includes(item.status)) ??
      all.find((item) => item.status === "processing") ??
      all.find((item) => !item.archived) ??
      all[0] ??
      null;
  }
  const people = session
    ? (await readJson<PeopleFile>(path.join(deps.sessions.sessionDir(session.sessionId), "people.json"))) ?? defaultPeople()
    : defaultPeople();
  const characterByUser: Record<string, string | null> = {};
  for (const person of people.people) {
    if (person.discordUserId) characterByUser[person.discordUserId] = person.character;
  }
  let foundry: FoundryImportSummary | null = null;
  if (session) {
    foundry = await readJson<FoundryImportSummary>(
      path.join(deps.sessions.sessionDir(session.sessionId), "foundry", "import-summary.json")
    );
  }

  const speakerMap = new Map(capture.speakers.map((speaker) => [speaker.discordUserId, speaker]));
  if (voice.channelId) {
    const members = await deps.discord.listChannelMembers(voice.channelId).catch(() => []);
    for (const member of members) {
      if (speakerMap.has(member.userId)) continue;
      speakerMap.set(member.userId, {
        discordUserId: member.userId,
        displayName: member.displayName,
        speaking: false,
        capturedMs: 0,
        voicedMs: 0,
        utteranceCount: 0,
        silentCount: 0,
        bytes: 0,
        lastUtteranceAtMs: null,
        decryptionFailures: 0
      });
    }
  }
  const speakers = [...speakerMap.values()].map((speaker) => ({
    ...speaker,
    character: characterByUser[speaker.discordUserId] ?? null
  }));

  const warnings: Array<{ code: string; message: string }> = [];
  const freeBytes = diskFreeBytes(deps.config.dataDir);
  if (freeBytes != null && freeBytes < 2_000_000_000) {
    warnings.push({
      code: "disk_low",
      message: `Only ${(freeBytes / 1_000_000_000).toFixed(1)} GB free on the data drive.`
    });
  }
  if (!bot.configured) {
    warnings.push({
      code: "discord_token_missing",
      message: "No bot token yet. Add DISCORD_TOKEN to .env and restart to record voice."
    });
  } else if (bot.state === "error") {
    warnings.push({ code: "discord_error", message: bot.error ?? "Discord bot login failed." });
  }
  if (voice.error) warnings.push({ code: "voice_error", message: voice.error });
  if (capture.health === "error") {
    warnings.push({ code: "capture_unhealthy", message: capture.error ?? "Audio capture is reporting an error. Check the live speakers and the log." });
  }
  for (const warning of capture.warnings.slice(-3)) warnings.push({ code: "capture_warning", message: warning });
  const parakeet = deps.config.sttEngine === "parakeet";
  const sttAvailable = parakeet ? (deps.parakeetHealth?.available ?? false) : (deps.pythonHealth?.available ?? false);
  const sttModelPresent = parakeet ? (deps.parakeetHealth?.modelPresent ?? false) : (deps.pythonHealth?.modelPresent ?? false);
  const sttError = parakeet ? (deps.parakeetHealth?.error ?? null) : (deps.pythonHealth?.error ?? null);
  const sttDevice = parakeet
    ? deps.config.parakeetDevice
    : deps.pythonHealth?.cudaDeviceCount
      ? "cuda"
      : deps.config.sttDevice;
  if (!sttAvailable) {
    warnings.push({
      code: "stt_unavailable",
      message: parakeet
        ? "Parrot (Parakeet) is selected but the nemo-speech runtime or model is missing. Set them in Setup → Transcription, or switch to Whisper."
        : "Whisper is selected but Python STT is not set up yet. Run npm run setup:python or switch to Parrot."
    });
  } else if (!sttModelPresent) {
    warnings.push({
      code: "stt_model_missing",
      message: `The speech model ${parakeet ? path.basename(deps.config.parakeetModel) : deps.config.sttModel} is not downloaded yet. The first transcription may take a while or fail.`
    });
  }
  if (foundry?.warnings?.length) {
    for (const warning of foundry.warnings) {
      if (warning.code === "outside_window") continue;
      warnings.push({ code: warning.code, message: warning.message });
    }
  }
  if (deps.foundryLive.lastError) {
    warnings.push({ code: "foundry_live_error", message: `Foundry live bridge: ${deps.foundryLive.lastError}` });
  }

  const jobs = deps.store.countJobs();
  const active = deps.store.activeJob();
  const displayState = capture.state === "idle" ? "idle" : capture.state === "recording" ? "recording" : capture.state;
  return {
    schema: APP_SCHEMA,
    generatedAtMs: now,
    server: { version: APP_VERSION, startedAtMs: deps.startedAtMs, uptimeMs: now - deps.startedAtMs },
    bot,
    voice,
    capture: {
      ...capture,
      speakers,
      displayState,
      characterByUser
    },
    session: {
      currentId: session?.sessionId ?? null,
      title: session?.title ?? null,
      system: session?.system.id ?? null,
      systemLabel: session ? systemLabel(session.system.id) : null,
      worldId: session?.world.id ?? null,
      status: session?.status ?? null
    },
    foundry: {
      imported: Boolean(foundry),
      messageCount: foundry?.messageCount ?? 0,
      rollCount: foundry?.rollCount ?? 0,
      importedAtMs: foundry?.importedAtMs ?? null,
      warnings: foundry?.warnings?.map((warning) => warning.message) ?? [],
      live: deps.foundryLive
    },
    jobs: { ...jobs, active },
    stt: {
      engine: deps.config.sttEngine,
      available: sttAvailable,
      device: sttDevice,
      model: parakeet ? path.basename(deps.config.parakeetModel) : deps.config.sttModel,
      modelPresent: sttModelPresent,
      state: sttAvailable
        ? sttError
          ? "error"
          : !sttModelPresent
            ? "model_missing"
            : sttDevice === "cuda" || deps.pythonHealth?.cudaDeviceCount
              ? "ready"
              : "cpu_only"
        : "unavailable",
      error: sttError
    },
    disk: { freeBytes },
    warnings
  };
}
