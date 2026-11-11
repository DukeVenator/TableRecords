import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import type { AppConfig } from "./config.js";
import type { DiscordUtterance, PeopleFile, SessionRecord, SttJob, TranscriptRecord } from "../core/types.js";
import { newSttJobId } from "../core/ids.js";
import { ensureDir, pathExists, readJsonl, resolveExistingInside, writeFileAtomic, writeJsonl } from "../core/paths.js";
import { vocabularyFor } from "../core/vocabulary.js";
import { sanitizedChildEnv } from "./childEnv.js";
import { annotateTranscript } from "../core/transcript.js";
import { personIsOptedOut } from "../core/consent.js";

export class SttBatchError extends Error {
  override name = "SttBatchError";
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 502) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class SttCancelledError extends Error {
  override name = "SttCancelledError";
}

export interface SttProgressEvent {
  done: number;
  total: number;
  utteranceId?: string;
  stage?: string;
  message?: string;
}

export interface SttBatchResult {
  records: TranscriptRecord[];
  errors: Array<{ utteranceId: string; message: string }>;
  skippedSilent: number;
  skippedOptOut: number;
  total: number;
  written: number;
  elapsedMs: number;
}

export interface SttBatchOptions {
  config: AppConfig;
  session: SessionRecord;
  sessionDir: string;
  utterances: DiscordUtterance[];
  batchJobId: string;
  /** File prefix under stt/; defaults to "transcript". */
  prefix?: string;
  onProgress?: (event: SttProgressEvent) => void;
  onLog?: (level: "INFO" | "WARN" | "DEBUG", message: string) => void;
  onChild?: (child: ChildProcessWithoutNullStreams) => void;
  isCancelled?: () => boolean;
}

export function sttEngineLabel(config: AppConfig): string {
  return config.sttEngine === "parakeet" ? "parakeet" : "faster-whisper";
}

export function sttModelLabel(config: AppConfig): string {
  return config.sttEngine === "parakeet" ? path.basename(config.parakeetModel) : config.sttModel;
}

function sttDeviceLabel(config: AppConfig): string {
  return config.sttEngine === "parakeet" ? config.parakeetDevice : config.sttDevice;
}

function sttComputeLabel(config: AppConfig): string {
  return config.sttEngine === "parakeet" ? "q8_0" : config.sttComputeType;
}

/** Clips below the capture VAD floor never reach the model. */
export function isSkippedUtterance(utterance: DiscordUtterance): boolean {
  return utterance.silent === true;
}

/**
 * Run one STT batch with the configured engine. Both the full-session job and
 * the recent-context window use this path so Parakeet/faster-whisper selection
 * cannot silently diverge, and so progress is reported the same way.
 */
export async function runSttBatch(options: SttBatchOptions): Promise<SttBatchResult> {
  const { config, session, sessionDir, utterances, batchJobId } = options;
  const prefix = options.prefix ?? "transcript";
  const startedAtMs = Date.now();
  const onLog = options.onLog ?? (() => undefined);
  const onProgress = options.onProgress ?? (() => undefined);
  const isCancelled = options.isCancelled ?? (() => false);
  const peopleFile = await fsp
    .readFile(path.join(sessionDir, "people.json"), "utf8")
    .then((raw) => JSON.parse(raw) as PeopleFile)
    .catch(() => ({ schema: "tablerecords.people/v1", sessionId: session.sessionId, people: [] }) as PeopleFile);
  const optedOutIds = new Set(
    peopleFile.people.filter(personIsOptedOut).map((person) => person.discordUserId).filter((id): id is string => Boolean(id))
  );
  const skippedSilent = utterances.filter(isSkippedUtterance).length;
  const skippedOptOut = utterances.filter(
    (utterance) => !isSkippedUtterance(utterance) && optedOutIds.has(utterance.discordUserId)
  ).length;
  const candidates = utterances.filter(
    (utterance) => !isSkippedUtterance(utterance) && !optedOutIds.has(utterance.discordUserId)
  );
  if (candidates.length === 0) {
    if (skippedOptOut > 0) onLog("INFO", `Skipped ${skippedOptOut} clip(s) from opted-out players.`);
    return { records: [], errors: [], skippedSilent, skippedOptOut, total: 0, written: 0, elapsedMs: 0 };
  }
  if (!(await pathExists(config.pythonPath))) {
    throw new SttBatchError(
      "python_missing",
      `Python executable not found at ${config.pythonPath}. Run npm run setup:python or set PYTHON_PATH.`,
      409
    );
  }
  if (config.sttEngine === "parakeet") {
    const runtimeIsPath = path.isAbsolute(config.parakeetPath) || /[\\/]/.test(config.parakeetPath);
    if (runtimeIsPath && !(await pathExists(config.parakeetPath))) {
      throw new SttBatchError("parakeet_runtime_missing", `nemo-speech not found at ${config.parakeetPath}; set NEMO_SPEECH_PATH.`);
    }
    if (!(await pathExists(config.parakeetModel))) {
      throw new SttBatchError("parakeet_model_missing", `Parakeet model not found at ${config.parakeetModel}; set PARAKEET_MODEL.`);
    }
  }

  const vocabulary = vocabularyFor(session.system.id, peopleFile.people);
  const promptText = [vocabulary.prompt, config.sttPromptExtra.trim()].filter(Boolean).join("\n");
  const extraHotwords = config.sttHotwordsExtra
    .split(/[,\n]/)
    .map((word) => word.trim())
    .filter(Boolean);
  const hotwords = [...new Set([...vocabulary.hotwords, ...extraHotwords])];
  await ensureDir(path.join(sessionDir, "stt"));
  const promptFile = path.join(sessionDir, "stt", "prompt.txt");
  const hotwordsFile = path.join(sessionDir, "stt", "hotwords.txt");
  await writeFileAtomic(promptFile, `${promptText}\n`);
  await writeFileAtomic(hotwordsFile, `${hotwords.join(", ")}\n`);

  const usable: DiscordUtterance[] = [];
  const fileErrors: Array<{ utteranceId: string; message: string }> = [];
  for (const utterance of candidates) {
    try {
      await resolveExistingInside(sessionDir, utterance.file);
      usable.push(utterance);
    } catch (error) {
      fileErrors.push({ utteranceId: utterance.utteranceId, message: (error as Error).message });
    }
  }
  if (usable.length === 0) {
    return {
      records: [],
      errors: fileErrors,
      skippedSilent,
      skippedOptOut,
      total: candidates.length,
      written: 0,
      elapsedMs: Date.now() - startedAtMs
    };
  }

  const jobs: SttJob[] = usable.map((utterance) => {
    const person = peopleFile.people.find((item) => item.discordUserId === utterance.discordUserId);
    return {
      schema: "tablerecords.stt-job/v1",
      sttJobId: newSttJobId(),
      batchJobId,
      sessionId: session.sessionId,
      utteranceId: utterance.utteranceId,
      audioFile: utterance.file,
      discordUserId: utterance.discordUserId,
      speakerLabel: person?.discordName ?? utterance.displayName ?? utterance.discordUserId,
      character: person?.character ?? null,
      language: config.sttLanguage,
      startMs: utterance.startMs,
      endMs: utterance.endMs,
      model: sttModelLabel(config),
      device: sttDeviceLabel(config),
      computeType: sttComputeLabel(config),
      beamSize: config.sttBeamSize,
      wordTimestamps: true,
      vadFilter: config.sttVadFilter,
      noSpeechThreshold: config.sttNoSpeechThreshold,
      logProbThreshold: config.sttLogProbThreshold,
      compressionRatioThreshold: config.sttCompressionRatioThreshold,
      prompt: promptText,
      hotwords
    };
  });

  const jobsFile = path.join(sessionDir, "stt", prefix === "transcript" ? "jobs.jsonl" : `${prefix}-jobs.jsonl`);
  const outFile = path.join(sessionDir, "stt", `${prefix}.jsonl`);
  const errorsFile = path.join(sessionDir, "stt", `${prefix}-errors.jsonl`);
  await writeJsonl(jobsFile, jobs);

  const parakeet = config.sttEngine === "parakeet";
  const args = parakeet
    ? [
        path.join(config.projectRoot, "python", "transcribe_parakeet_jobs.py"),
        "--jobs",
        jobsFile,
        "--out",
        outFile,
        "--errors",
        errorsFile,
        "--nemo-speech",
        config.parakeetPath,
        "--model",
        config.parakeetModel,
        "--device",
        config.parakeetDevice,
        "--concurrency",
        String(config.parakeetConcurrency),
        "--language",
        config.sttLanguage,
        "--prompt-file",
        promptFile,
        "--hotwords-file",
        hotwordsFile
      ]
    : [
        path.join(config.projectRoot, "python", "transcribe_jobs.py"),
        "--jobs",
        jobsFile,
        "--out",
        outFile,
        "--errors",
        errorsFile,
        "--model",
        config.sttModel,
        "--device",
        config.sttDevice,
        "--compute-type",
        config.sttComputeType,
        "--language",
        config.sttLanguage,
        "--prompt-file",
        promptFile,
        "--hotwords-file",
        hotwordsFile,
        "--download-root",
        config.sttModelDir
      ];
  if (!parakeet && process.env.STT_LOCAL_FILES_ONLY === "1") args.push("--local-files-only");

  onLog(
    "INFO",
    `STT started (${sttEngineLabel(config)}): ${usable.length === candidates.length ? `${usable.length} clips` : `${usable.length} of ${candidates.length} clips`}, ${skippedSilent} silent skipped, ${skippedOptOut} opted-out skipped, ${sttModelLabel(config)} on ${sttDeviceLabel(config)}/${sttComputeLabel(config)}`
  );
  onProgress({ done: 0, total: usable.length, stage: "starting" });

  const child = spawn(config.pythonPath, args, {
    cwd: config.projectRoot,
    windowsHide: true,
    env: sanitizedChildEnv({
      PYTHONIOENCODING: "utf-8",
      PYTHONUNBUFFERED: "1",
      HF_HOME: config.sttModelDir
    })
  });
  options.onChild?.(child);

  let stdoutDone = false;
  let lastError = "";
  let stderrTail = "";
  let stderrLines = 0;
  let lastActivityAt = Date.now();
  let watchdogFired = false;
  const watchdog = setInterval(() => {
    if (Date.now() - lastActivityAt < 15 * 60_000) return;
    watchdogFired = true;
    lastError = "STT process stopped producing output for 15 minutes";
    try {
      child.kill();
    } catch {
      // already gone
    }
    setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {
        // already gone
      }
    }, 3000).unref?.();
  }, 30_000);
  watchdog.unref?.();

  const stdoutReader = readline.createInterface({ input: child.stdout });
  const stderrReader = readline.createInterface({ input: child.stderr });
  stdoutReader.on("line", (line) => {
    if (!line.trim()) return;
    lastActivityAt = Date.now();
    try {
      const message = JSON.parse(line) as Record<string, unknown>;
      if (message.type === "start") {
        onLog(
          "INFO",
          `STT model ready: ${String(message.total)} item(s), ${String(message.device)}/${String(message.computeType)}${message.model ? ` · ${path.basename(String(message.model))}` : ""}`
        );
      } else if (message.type === "stage") {
        onLog("INFO", `STT stage: ${String(message.stage)}`);
        onProgress({ done: 0, total: usable.length, stage: String(message.stage) });
      } else if (message.type === "progress") {
        const done = Number(message.done) || 0;
        const total = Number(message.total) || usable.length;
        onProgress({
          done,
          total,
          utteranceId: message.utteranceId ? String(message.utteranceId) : undefined,
          stage: "transcribe"
        });
      } else if (message.type === "error") {
        lastError = String(message.message ?? "STT error");
        onLog("WARN", `STT error for ${String(message.utteranceId)}: ${lastError}`);
      } else if (message.type === "done") {
        stdoutDone = true;
      }
    } catch {
      onLog("DEBUG", `STT stdout: ${line}`);
    }
  });
  stderrReader.on("line", (line) => {
    if (!line.trim()) return;
    lastActivityAt = Date.now();
    stderrTail = `${stderrTail}\n${line}`.slice(-6000);
    stderrLines += 1;
    // Model loaders are chatty; keep diagnostics and the first lines, skip the
    // per-file banner spam that would otherwise bury the job log.
    const important = stderrLines <= 12 || /error|failed|warn|exception|vad|model/i.test(line);
    if (important) onLog("INFO", `stt: ${line}`);
  });

  const exitCode = await new Promise<number>((resolve) => {
    child.on("error", (error) => {
      lastError = error.message;
      resolve(-1);
    });
    child.on("close", (code) => resolve(code ?? -1));
  });
  stdoutReader.close();
  stderrReader.close();
  clearInterval(watchdog);
  if (isCancelled()) throw new SttCancelledError("Job cancelled");
  if (watchdogFired) throw new SttBatchError("stt_timeout", "STT process stopped producing output for 15 minutes");
  if (exitCode !== 0) {
    throw new SttBatchError(
      "stt_process_failed",
      `STT process exited with code ${exitCode}${lastError ? `: ${lastError}` : ""}${stderrTail ? `\n${stderrTail.slice(-1200)}` : ""}`
    );
  }
  if (!stdoutDone) throw new SttBatchError("stt_protocol_error", "STT process exited without a done message");

  const transcript = await readJsonl<TranscriptRecord>(outFile);
  const errorRecords = await readJsonl<{ utteranceId?: string; message?: string }>(errorsFile);
  const byId = new Map<string, TranscriptRecord>();
  for (const record of transcript.items) {
    if (!record?.utteranceId) continue;
    byId.set(record.utteranceId, annotateTranscript(record));
  }
  const errors = [
    ...fileErrors,
    ...errorRecords.items.map((error) => ({
      utteranceId: error.utteranceId ?? "unknown",
      message: error.message ?? "transcription failed"
    }))
  ];
  const records = [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.utteranceId.localeCompare(b.utteranceId));
  onProgress({ done: usable.length, total: usable.length, stage: "done" });
  return {
    records,
    errors,
    skippedSilent,
    skippedOptOut,
    total: candidates.length,
    written: records.length,
    elapsedMs: Date.now() - startedAtMs
  };
}
