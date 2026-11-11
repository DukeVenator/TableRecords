import type { ChildProcessWithoutNullStreams } from "node:child_process";
import fsp from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config.js";
import type { Store } from "./store.js";
import type { SessionManager } from "./sessions.js";
import type {
  DiscordUtterance,
  FoundryEvent,
  Job,
  JobProgress,
  JobStage,
  JobType,
  PeopleFile,
  TranscriptRecord
} from "../core/types.js";
import { newJobId } from "../core/ids.js";
import { ensureDir, pathExists, readJson, readJsonl, writeJsonAtomic, writeJsonl } from "../core/paths.js";
import { mergeSession } from "../core/merge.js";
import { renderSession } from "../core/render.js";
import { buildRecentContext, clampRecentSeconds, resolveRecentWindow } from "../core/recent.js";
import { personIsOptedOut } from "../core/consent.js";
import { readRecentSource, transcribeRecentWindow, RecentContextError } from "./recent.js";
import { buildReviewAudio, ReviewAudioError } from "./reviewAudio.js";
import { synthesizeReviewUtterances } from "./reviewFallback.js";
import {
  runSttBatch,
  SttBatchError,
  SttCancelledError,
  sttEngineLabel,
  sttModelLabel,
  type SttProgressEvent
} from "./sttBatch.js";

export class JobError extends Error {
  override name = "JobError";
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export class JobCancelled extends Error {
  override name = "JobCancelled";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function formatElapsed(ms: number): string {
  if (ms > 0 && ms < 1000) return "<1s";
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${String(minutes).padStart(2, "0")}m`;
  if (minutes > 0) return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
  return `${seconds}s`;
}

function stagesFor(type: JobType): JobStage[] {
  if (type === "run_all") return ["transcribe", "merge", "render"];
  if (type === "context") return ["transcribe", "context"];
  if (type === "transcribe" || type === "merge" || type === "render") return [type];
  return [];
}

/** Stage-weighted overall progress so the bar never jumps backwards. */
function percentForStage(type: JobType, stage: JobStage, completed: number, total: number): number {
  const ratio = total > 0 ? Math.min(1, Math.max(0, completed / total)) : 0;
  if (type === "run_all") {
    if (stage === "transcribe") return Math.round(ratio * 70);
    if (stage === "merge") return 70 + Math.round(ratio * 20);
    if (stage === "render") return 90 + Math.round(ratio * 10);
  }
  if (type === "context") {
    if (stage === "transcribe") return Math.round(ratio * 80);
    if (stage === "context") return 90 + Math.round(ratio * 10);
  }
  return Math.round(ratio * 100);
}

interface JobLogLine {
  seq: number;
  tsMs: number;
  level: "INFO" | "WARN" | "ERROR" | "DEBUG";
  line: string;
}

const LOG_PREFIX = /^\[([^\]]+)\]\s+(INFO|WARN|ERROR|DEBUG)\s+(.*)$/;

function logStamp(tsMs: number): string {
  return new Date(tsMs).toISOString();
}

/**
 * Merge source detection lives here so enqueue and execution agree. The old
 * check only looked at the macro export, which made live-only sessions look empty.
 */
async function hasMergeSource(dir: string): Promise<boolean> {
  const [transcript, macro, live, markers, people] = await Promise.all([
    readJsonl(path.join(dir, "stt", "transcript.jsonl")),
    readJsonl(path.join(dir, "foundry", "events.jsonl")),
    readJsonl(path.join(dir, "foundry", "live-events.jsonl")),
    readJsonl(path.join(dir, "markers.jsonl")),
    readJson<PeopleFile>(path.join(dir, "people.json"))
  ]);
  if (transcript.items.length > 0 || macro.items.length > 0 || live.items.length > 0 || markers.items.length > 0) return true;
  // A session where every participant opted out still deserves a privacy-only
  // output set; the timeline is empty but render adds the consent note.
  return (people?.people ?? []).some(personIsOptedOut);
}

export async function readJobLogs(file: string, afterSeq = 0, limit = 200): Promise<JobLogLine[]> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return [];
  }
  const lines = raw.split(/\r?\n/).filter(Boolean);
  const out: JobLogLine[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const seq = index + 1;
    if (seq <= afterSeq) continue;
    const match = LOG_PREFIX.exec(lines[index]!);
    if (!match) {
      out.push({ seq, tsMs: 0, level: "INFO", line: lines[index]! });
    } else {
      out.push({
        seq,
        tsMs: Date.parse(match[1]!),
        level: match[2] as JobLogLine["level"],
        line: match[3]!
      });
    }
    if (out.length >= limit) break;
  }
  return out;
}

export class JobRunner {
  readonly config: AppConfig;
  readonly store: Store;
  readonly sessions: SessionManager;
  private readonly broadcast: (event: string, data: unknown) => void;
  private loopActive = false;
  private closing = false;
  private idleWaiters: Array<() => void> = [];
  private cancelled = new Set<string>();
  private children = new Map<string, ChildProcessWithoutNullStreams>();
  private logSeq = new Map<string, number>();
  private transcriptionLocks = new Set<string>();
  private reviewBuilds = new Set<string>();
  private jobWaiters = new Map<string, Set<(job: Job) => void>>();
  private lastProgressAt = new Map<string, number>();

  constructor(
    config: AppConfig,
    store: Store,
    sessions: SessionManager,
    broadcast: (event: string, data: unknown) => void
  ) {
    this.config = config;
    this.store = store;
    this.sessions = sessions;
    this.broadcast = broadcast;
  }

  async enqueue(sessionId: string, type: JobType, request: Record<string, unknown> = {}): Promise<Job> {
    if (this.closing) throw new JobError("server_closing", "Server is shutting down", 503);
    if (!["transcribe", "merge", "render", "run_all", "context"].includes(type)) {
      throw new JobError("invalid_type", `That job type is not recognised.`);
    }
    const session = await this.sessions.get(sessionId);
    const context = type === "context";
    if (!context && ["draft", "joining", "recording", "stopping"].includes(session.status)) {
      throw new JobError("invalid_state", `This session is not ready to process yet.`, 409);
    }
    if (context && ["draft", "joining", "stopping"].includes(session.status)) {
      throw new JobError("invalid_state", `There is no session to summarise yet. Start or finish a recording first.`, 409);
    }
    const dir = this.sessions.sessionDir(sessionId);
    if (type === "transcribe") {
      const manifest = await readJsonl(path.join(dir, "discord", "manifest.jsonl"));
      if (manifest.items.length === 0) {
        const transcript = await readJsonl(path.join(dir, "stt", "transcript.jsonl"));
        const hasReview = await pathExists(path.join(dir, "review", "manifest.json"));
        if (transcript.items.length === 0 && !hasReview) {
          throw new JobError("no_utterances", "No captured utterances or review tracks to transcribe");
        }
      }
    }
    if (type === "merge") {
      if (!(await hasMergeSource(dir))) {
        throw new JobError("no_source_events", "Merge needs a transcript, Foundry events, or markers");
      }
    }
    if (type === "render" && !(await pathExists(path.join(dir, "merged", "timeline.jsonl")))) {
      throw new JobError("no_timeline", "Render needs merged/timeline.jsonl; run merge first");
    }

    const queuePosition = this.store.countJobs().queued + 1;
    const jobId = newJobId();
    const job: Job = {
      schema: "tablerecords.job/v1",
      jobId,
      sessionId,
      type,
      status: "queued",
      progress: {
        phase: type === "context" ? "context" : type === "run_all" ? "transcribe" : type,
        completed: 0,
        total: 0,
        percent: 0,
        detail: queuePosition > 1 ? `Waiting in queue (#${queuePosition})` : "Queued",
        queuePosition
      },
      request: { filterMarginMs: session.merge.filterMarginMs, ...request },
      result: null,
      error: null,
      logFile: `jobs/${jobId}.log`,
      createdAtMs: Date.now(),
      startedAtMs: null,
      finishedAtMs: null
    };
    this.store.insertJob(job);
    await this.log(job, "INFO", `Queued ${type} for ${sessionId}`);
    if (!context) await this.setSessionProcessing(sessionId);
    this.broadcast("job.updated", job);
    await this.refreshQueuePositions();
    setImmediate(() => void this.kick());
    return job;
  }

  /**
   * One transcription at a time per session. Full jobs and the recent-context
   * button share this, otherwise two Python models fight over the GPU.
   */
  tryClaimTranscription(sessionId: string): (() => void) | null {
    if (this.transcriptionLocks.has(sessionId)) return null;
    this.transcriptionLocks.add(sessionId);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.transcriptionLocks.delete(sessionId);
    };
  }

  private async refreshQueuePositions(): Promise<void> {
    const queued = this.store
      .listJobs()
      .filter((job) => job.status === "queued")
      .sort((a, b) => a.createdAtMs - b.createdAtMs);
    for (let index = 0; index < queued.length; index += 1) {
      const job = queued[index]!;
      const queuePosition = index + 1;
      const detail = queuePosition === 1 ? "Next in queue" : `Waiting in queue (#${queuePosition})`;
      if (job.progress.queuePosition === queuePosition && job.progress.detail === detail) continue;
      job.progress = {
        ...job.progress,
        queuePosition,
        detail
      };
      this.store.updateJob(job);
      this.broadcast("job.updated", job);
    }
  }

  private notifyJobWaiters(job: Job): void {
    const waiters = this.jobWaiters.get(job.jobId);
    if (!waiters) return;
    this.jobWaiters.delete(job.jobId);
    for (const resolve of waiters) resolve(job);
  }

  /** Used by the legacy long-poll endpoint; jobs themselves never wait on it. */
  async waitForJob(jobId: string, timeoutMs = 30 * 60_000): Promise<Job> {
    const current = this.store.getJob(jobId);
    if (!current) throw new JobError("not_found", `That job is no longer there.`, 404);
    if (["done", "failed", "cancelled"].includes(current.status)) return current;
    return new Promise<Job>((resolve, reject) => {
      const set = this.jobWaiters.get(jobId) ?? new Set<(job: Job) => void>();
      const timer = setTimeout(() => {
        set.delete(done);
        reject(new JobError("job_timeout", `Timed out waiting for ${jobId}`, 504));
      }, timeoutMs);
      timer.unref?.();
      const done = (job: Job) => {
        clearTimeout(timer);
        resolve(job);
      };
      set.add(done);
      this.jobWaiters.set(jobId, set);
      // Close the race where the job finished between the first status read
      // and the waiter registration.
      const latest = this.store.getJob(jobId);
      if (latest && ["done", "failed", "cancelled"].includes(latest.status)) {
        clearTimeout(timer);
        set.delete(done);
        if (set.size === 0) this.jobWaiters.delete(jobId);
        resolve(latest);
      }
    });
  }

  private async acquireTranscription(job: Job): Promise<() => void> {
    const immediate = this.tryClaimTranscription(job.sessionId);
    if (immediate) return immediate;
    await this.log(job, "INFO", "Waiting for another transcription to finish");
    await this.updateStage(job, "transcribe", 0, 0, "Waiting for another transcription to finish");
    const deadline = Date.now() + 10 * 60_000;
    while (Date.now() < deadline) {
      if (this.cancelled.has(job.jobId) || this.closing) throw new JobCancelled("Job cancelled");
      await delay(500);
      const release = this.tryClaimTranscription(job.sessionId);
      if (release) return release;
    }
    throw new JobError("transcription_active", "Another transcription is already running for this session", 409);
  }

  private async setSessionProcessing(sessionId: string): Promise<void> {
    const session = await this.sessions.get(sessionId);
    if (["captured", "ready", "error", "processing"].includes(session.status)) {
      await this.sessions.setStatus(session, "processing");
      this.broadcast("session.updated", { sessionId, status: "processing" });
    }
  }

  private async refreshSessionStatus(sessionId: string): Promise<void> {
    const jobs = this.store.listJobs(sessionId);
    if (jobs.some((job) => job.status === "queued" || job.status === "running")) return;
    const session = await this.sessions.get(sessionId);
    const dir = this.sessions.sessionDir(sessionId);
    const timeline = await pathExists(path.join(dir, "merged", "timeline.jsonl"));
    const output = await pathExists(path.join(dir, "outputs", "notes-ready.md"));
    const status = output ? "ready" : timeline ? "captured" : session.status === "error" ? "error" : "captured";
    if (session.status !== status) {
      await this.sessions.setStatus(session, status);
      this.broadcast("session.updated", { sessionId, status });
    }
  }

  private async kick(): Promise<void> {
    if (this.loopActive || this.closing) return;
    this.loopActive = true;
    try {
      while (!this.closing) {
        const next = this.store.nextQueuedJob();
        if (!next) break;
        await this.execute(next);
      }
    } finally {
      this.loopActive = false;
      const waiters = this.idleWaiters.splice(0);
      for (const resolve of waiters) resolve();
    }
  }

  private async execute(initial: Job): Promise<void> {
    const fresh = this.store.getJob(initial.jobId);
    if (!fresh || fresh.status !== "queued" || this.cancelled.has(fresh.jobId)) return;
    fresh.status = "running";
    fresh.startedAtMs = Date.now();
    fresh.progress = {
      ...fresh.progress,
      queuePosition: undefined,
      detail: `Starting ${fresh.type === "context" ? "GM context" : fresh.type}`,
      elapsedMs: 0,
      etaMs: null
    };
    this.store.updateJob(fresh);
    this.broadcast("job.updated", fresh);
    await this.refreshQueuePositions();
    await this.log(fresh, "INFO", `Starting ${fresh.type}`);
    let releaseTranscription: (() => void) | null = null;

    try {
      if (fresh.type === "transcribe" || fresh.type === "run_all" || fresh.type === "context") {
        releaseTranscription = await this.acquireTranscription(fresh);
      }
      let result: Record<string, unknown>;
      if (fresh.type === "transcribe") result = await this.runTranscribe(fresh);
      else if (fresh.type === "merge") result = await this.runMerge(fresh);
      else if (fresh.type === "render") result = await this.runRender(fresh);
      else if (fresh.type === "context") result = await this.runContext(fresh);
      else result = await this.runAll(fresh);
      if (this.cancelled.has(fresh.jobId)) throw new JobCancelled("Job cancelled");
      fresh.status = "done";
      fresh.result = result;
      fresh.error = null;
      fresh.finishedAtMs = Date.now();
      fresh.progress = {
        ...fresh.progress,
        completed: fresh.progress.total,
        percent: 100,
        detail: `Completed in ${formatElapsed((fresh.finishedAtMs ?? Date.now()) - (fresh.startedAtMs ?? Date.now()))}`,
        elapsedMs: fresh.finishedAtMs - (fresh.startedAtMs ?? fresh.finishedAtMs),
        etaMs: null,
        queuePosition: undefined
      };
      this.store.updateJob(fresh);
      this.broadcast("job.updated", fresh);
      await this.log(fresh, "INFO", "Job completed");
      if (fresh.type === "transcribe" || fresh.type === "run_all") {
        void this.autoBuildReviewAudio(fresh.sessionId);
      }
    } catch (error) {
      if (error instanceof JobCancelled || error instanceof SttCancelledError || this.cancelled.has(fresh.jobId)) {
        fresh.status = "cancelled";
        fresh.finishedAtMs = Date.now();
        fresh.progress = { ...fresh.progress, detail: "Cancelled", etaMs: null, queuePosition: undefined };
        this.store.updateJob(fresh);
        this.broadcast("job.updated", fresh);
        await this.log(fresh, "WARN", "Job cancelled");
      } else {
        fresh.status = "failed";
        fresh.finishedAtMs = Date.now();
        fresh.error = {
          code:
            error instanceof JobError
              ? error.code
              : error instanceof SttBatchError || error instanceof RecentContextError
                ? error.code
                : "job_failed",
          message: error instanceof Error ? error.message : String(error)
        };
        fresh.progress = { ...fresh.progress, detail: fresh.error.message, etaMs: null, queuePosition: undefined };
        this.store.updateJob(fresh);
        this.broadcast("job.updated", fresh);
        await this.log(fresh, "ERROR", fresh.error.message);
      }
    } finally {
      releaseTranscription?.();
      this.children.delete(fresh.jobId);
      this.lastProgressAt.delete(fresh.jobId);
      await this.refreshQueuePositions();
      this.notifyJobWaiters(fresh);
      if (fresh.type !== "context") await this.refreshSessionStatus(fresh.sessionId);
    }
  }

  /**
   * The master mix is a review artefact, not a pipeline stage, so it is built in
   * the background after transcription instead of delaying the job's result.
   * A single build per session runs at a time; failures become a dashboard warning
   * rather than failing the transcript.
   */
  private async autoBuildReviewAudio(sessionId: string): Promise<void> {
    if (this.closing || this.reviewBuilds.has(sessionId)) return;
    this.reviewBuilds.add(sessionId);
    try {
      const dir = this.sessions.sessionDir(sessionId);
      const manifest = await readJsonl<DiscordUtterance>(path.join(dir, "discord", "manifest.jsonl"));
      if (manifest.items.length === 0) return;
      const reviewManifest = path.join(dir, "review", "manifest.json");
      const master = path.join(dir, "review", "master.mp3");
      if ((await pathExists(reviewManifest)) && (await pathExists(master))) {
        const clipStat = await fsp.stat(path.join(dir, "discord", "manifest.jsonl"));
        const reviewStat = await fsp.stat(reviewManifest);
        if (reviewStat.mtimeMs >= clipStat.mtimeMs) return;
      }
      const session = await this.sessions.get(sessionId);
      const result = await buildReviewAudio({
        config: this.config,
        session,
        sessionDir: dir,
        manifest: manifest.items
      });
      this.broadcast("session.updated", { sessionId, status: session.status });
      this.broadcast("review.updated", {
        sessionId,
        generatedAtMs: result.generatedAtMs,
        files: result.files.length
      });
    } catch (error) {
      if (error instanceof ReviewAudioError && error.code === "build_in_progress") return;
      this.broadcast("warning", {
        code: "review_audio_failed",
        message: `Review audio could not be built automatically: ${error instanceof Error ? error.message : String(error)}`
      });
    } finally {
      this.reviewBuilds.delete(sessionId);
    }
  }

  private async runAll(job: Job): Promise<Record<string, unknown>> {
    const dir = this.sessions.sessionDir(job.sessionId);
    const manifest = await readJsonl(path.join(dir, "discord", "manifest.jsonl"));
    const results: Record<string, unknown> = {};
    if (manifest.items.length > 0) {
      results.transcribe = await this.runTranscribe(job);
      // The master mix only needs the clips; start it as soon as the transcript
      // exists so a later merge/render failure does not leave it missing.
      void this.autoBuildReviewAudio(job.sessionId);
    } else {
      const transcript = await readJsonl(path.join(dir, "stt", "transcript.jsonl"));
      const hasReview = await pathExists(path.join(dir, "review", "manifest.json"));
      if (transcript.items.length > 0 || hasReview) {
        results.transcribe = await this.runTranscribe(job);
      } else {
        await this.log(job, "WARN", "No captured utterances; skipping transcription.");
        results.transcribe = { transcriptCount: 0, errorCount: 0, skipped: true };
      }
    }
    if (this.cancelled.has(job.jobId)) throw new JobCancelled("Job cancelled");
    results.merge = await this.runMerge(job);
    if (this.cancelled.has(job.jobId)) throw new JobCancelled("Job cancelled");
    results.render = await this.runRender(job);
    return results;
  }

  private async runTranscribe(job: Job): Promise<Record<string, unknown>> {
    const session = await this.sessions.get(job.sessionId);
    const dir = this.sessions.sessionDir(job.sessionId);
    const manifest = await readJsonl<DiscordUtterance>(path.join(dir, "discord", "manifest.jsonl"));
    let utterances = manifest.items;
    let cleanupReviewClips: (() => Promise<void>) | null = null;
    if (utterances.length === 0) {
      const existingTranscript = await readJsonl<TranscriptRecord>(path.join(dir, "stt", "transcript.jsonl"));
      if (existingTranscript.items.length > 0) {
        await this.log(
          job,
          "WARN",
          `No per-clip audio is stored; reusing the existing ${existingTranscript.items.length} transcript record(s).`
        );
        return { reusedTranscript: true, transcriptCount: existingTranscript.items.length };
      }
      const fallback = await synthesizeReviewUtterances({ config: this.config, session, sessionDir: dir });
      if (fallback.utterances.length === 0) {
        throw new JobError("no_utterances", "No clip audio and no saved speaker tracks to transcribe");
      }
      utterances = fallback.utterances;
      cleanupReviewClips = fallback.cleanup;
      await this.log(
        job,
        "WARN",
        `Per-clip audio is gone; transcribing ${utterances.length} window(s) cut from the saved speaker tracks.`
      );
    }
    const peopleFile =
      (await readJson<PeopleFile>(path.join(dir, "people.json"))) ?? {
        schema: "tablerecords.people/v1" as const,
        sessionId: job.sessionId,
        people: []
      };
    const byId = new Map(utterances.map((utterance) => [utterance.utteranceId, utterance]));
    const names = new Map<string, string>();
    for (const person of peopleFile.people) {
      if (person.discordUserId) names.set(person.discordUserId, person.discordName ?? person.character ?? person.discordUserId);
    }
    const optedOut = new Set(
      peopleFile.people.map((person) => (personIsOptedOut(person) ? person.discordUserId : null)).filter((id): id is string => Boolean(id))
    );
    const total = utterances.filter(
      (utterance) => utterance.silent !== true && !optedOut.has(utterance.discordUserId)
    ).length;
    await this.updateStage(job, "transcribe", 0, total, `Preparing ${total} captured clip(s)…`);
    const report = this.progressReporter(job, "transcribe", total, (event) => {
      if (event.stage === "starting") return "Starting the STT process…";
      if (event.stage === "loading-model") return `Loading ${sttModelLabel(this.config)}…`;
      if (event.stage === "collecting-results") return "Collecting STT results…";
      if (event.stage === "done") return "Finalizing transcript records…";
      const utterance = event.utteranceId ? byId.get(event.utteranceId) : undefined;
      const who = utterance ? names.get(utterance.discordUserId) ?? utterance.displayName : null;
      return `Transcribing ${event.done}/${event.total}${who ? ` · ${who}` : ""}`;
    });
    const result = await runSttBatch({
      config: this.config,
      session,
      sessionDir: dir,
      utterances,
      batchJobId: job.jobId,
      prefix: "transcript-raw",
      onProgress: report,
      onLog: (level, message) => {
        void this.log(job, level, message);
      },
      onChild: (child) => this.children.set(job.jobId, child),
      isCancelled: () => this.cancelled.has(job.jobId)
    });
    if (this.cancelled.has(job.jobId)) throw new JobCancelled("Job cancelled");
    await this.updateStage(job, "transcribe", total, total, `Writing ${result.records.length} transcript(s)…`);
    await writeJsonl(path.join(dir, "stt", "transcript.jsonl"), result.records);
    // The sidecar's raw output and its per-clip job list duplicate the canonical
    // transcript; drop them after a successful write to save space.
    await fsp.rm(path.join(dir, "stt", "transcript-raw.jsonl"), { force: true }).catch(() => undefined);
    await fsp.rm(path.join(dir, "stt", "transcript-raw-jobs.jsonl"), { force: true }).catch(() => undefined);
    if (result.errors.length === 0) {
      // The canonical transcript carries the STT metadata; keep the job spec only
      // when there were errors worth reproducing.
      await fsp.rm(path.join(dir, "stt", "jobs.jsonl"), { force: true }).catch(() => undefined);
      await fsp.rm(path.join(dir, "stt", "transcript-raw-errors.jsonl"), { force: true }).catch(() => undefined);
    }
    if (result.records.length === 0 && result.skippedOptOut === 0 && total > 0) {
      throw new JobError("no_transcript_records", `STT produced no transcript records (${result.errors.length} errors).`);
    }
    await this.log(
      job,
      "INFO",
      `Transcribed ${result.records.length} clip(s) with ${sttEngineLabel(this.config)} ${sttModelLabel(this.config)}; ${result.skippedSilent} silent skipped; ${result.skippedOptOut} opted-out skipped; ${result.errors.length} error(s); ${formatElapsed(result.elapsedMs)}`
    );
    await cleanupReviewClips?.();
    return {
      transcriptCount: result.records.length,
      errorCount: result.errors.length,
      skippedSilent: result.skippedSilent,
      skippedOptOut: result.skippedOptOut,
      engine: sttEngineLabel(this.config),
      model: sttModelLabel(this.config),
      elapsedMs: result.elapsedMs
    };
  }
  private async runMerge(job: Job): Promise<Record<string, unknown>> {
    const session = await this.sessions.get(job.sessionId);
    const dir = this.sessions.sessionDir(job.sessionId);
    if (!(await hasMergeSource(dir))) {
      throw new JobError("no_source_events", "Merge needs a transcript, Foundry events, or markers");
    }
    await this.updateStage(job, "merge", 0, 1, "Joining transcripts, rolls, chat, and markers…");
    const result = await mergeSession(dir, session);
    await this.updateStage(
      job,
      "merge",
      1,
      1,
      `Merged ${result.timeline.length} event(s); ${result.counts.excludedTranscripts} noisy transcript(s) excluded`
    );
    await this.log(job, "INFO", `Merged ${result.timeline.length} event(s): ${JSON.stringify(result.counts)}`);
    return { ...result.counts, warnings: result.warnings };
  }

  private async runRender(job: Job): Promise<Record<string, unknown>> {
    const session = await this.sessions.get(job.sessionId);
    const dir = this.sessions.sessionDir(job.sessionId);
    if (!(await pathExists(path.join(dir, "merged", "timeline.jsonl")))) {
      throw new JobError("no_timeline", "Render needs merged/timeline.jsonl; run merge first");
    }
    await this.updateStage(job, "render", 0, 1, "Rendering Markdown, CSV, and roll sync…");
    const result = await renderSession(dir, session);
    await this.updateStage(job, "render", 1, 1, `Rendered ${result.files.length} output file(s)`);
    await this.log(job, "INFO", `Rendered ${result.files.length} output file(s)`);
    return { files: result.files, eventCount: result.eventCount };
  }

  private async runContext(job: Job): Promise<Record<string, unknown>> {
    const session = await this.sessions.get(job.sessionId);
    const dir = this.sessions.sessionDir(job.sessionId);
    const request = job.request as { windowSeconds?: unknown; endMs?: unknown; transcribe?: unknown };
    const windowSeconds = clampRecentSeconds(Number(request.windowSeconds ?? this.config.recentContextSeconds));
    const endMs = typeof request.endMs === "number" && Number.isFinite(request.endMs) ? request.endMs : Date.now();
    const transcribe = request.transcribe !== false;
    const window = resolveRecentWindow(session, windowSeconds, endMs);
    const firstRead = await readRecentSource(dir);
    const windowUtterances = firstRead.manifest.filter(
      (utterance) => utterance.startMs <= window.endMs && utterance.endMs >= window.startMs
    );
    const existingIds = new Set(firstRead.transcripts.map((record) => record.utteranceId));
    const missing = windowUtterances.filter((utterance) => !existingIds.has(utterance.utteranceId));
    let transcription: {
      requested: boolean;
      candidates: number;
      transcribed: number;
      alreadyPresent: number;
      failed: number;
      skippedSilent?: number;
      skippedOptOut?: number;
      skippedReason?: string;
      errors: string[];
    } = {
      requested: transcribe,
      candidates: windowUtterances.length,
      transcribed: 0,
      alreadyPresent: windowUtterances.length - missing.length,
      failed: 0,
      errors: []
    };
    if (transcribe && missing.length > 0) {
      const report = this.progressReporter(job, "transcribe", missing.length, (event) => {
        if (event.stage === "starting") return "Starting the STT process…";
        if (event.stage === "loading-model") return `Loading ${sttModelLabel(this.config)}…`;
        if (event.stage === "collecting-results") return "Collecting window STT results…";
        if (event.stage === "done") return "Finishing window transcription…";
        return `Transcribing window ${event.done}/${event.total}`;
      });
      const result = await transcribeRecentWindow({
        config: this.config,
        session,
        sessionDir: dir,
        manifest: firstRead.manifest,
        existing: firstRead.transcripts,
        startMs: window.startMs,
        endMs: window.endMs,
        onProgress: report,
        onLog: (level, message) => {
          void this.log(job, level, message);
        },
        onChild: (child) => this.children.set(job.jobId, child),
        isCancelled: () => this.cancelled.has(job.jobId)
      });
      transcription = {
        ...transcription,
        ...result,
        requested: true,
        skippedReason:
          result.transcribed > 0
            ? undefined
            : result.failed > 0
              ? "transcription_failed"
              : (result.skippedOptOut ?? 0) >= missing.length
                ? "opted_out"
                : (result.skippedSilent ?? 0) >= missing.length
                  ? "silent_clips"
                  : "no_captured_audio"
      };
    } else if (!transcribe) {
      transcription.skippedReason = "transcription_not_requested";
    } else if (windowUtterances.length === 0) {
      transcription.skippedReason = "no_captured_audio";
    } else {
      transcription.skippedReason = "already_transcribed";
    }
    await this.updateStage(job, "context", 0, 1, "Building the deterministic GM brief…");
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
      markers: this.store.listMarkers(job.sessionId),
      windowSeconds,
      endMs: window.endMs,
      transcription
    });
    await writeJsonAtomic(path.join(dir, "context", `recent-${job.jobId}.json`), brief);
    await this.updateStage(job, "context", 1, 1, `Brief ready: ${brief.counts.events} events`);
    await this.log(
      job,
      "INFO",
      `GM context ready: ${brief.counts.events} event(s), ${brief.counts.speech} speech, ${brief.counts.rolls} roll(s); transcribed ${transcription.transcribed} window clip(s)`
    );
    return brief as unknown as Record<string, unknown>;
  }

  private progressReporter(
    job: Job,
    stage: JobStage,
    total: number,
    describe: (event: SttProgressEvent) => string
  ): (event: SttProgressEvent) => void {
    let lastAt = 0;
    return (event) => {
      const now = Date.now();
      const final = event.stage === "done" || (event.total > 0 && event.done >= event.total);
      if (!final && now - lastAt < 750) return;
      lastAt = now;
      void this.updateStage(job, stage, event.done, event.total || total, describe(event));
    };
  }

  private async updateStage(
    job: Job,
    stage: JobStage,
    completed: number,
    total: number,
    detail?: string
  ): Promise<void> {
    const now = Date.now();
    const elapsedMs = job.startedAtMs ? now - job.startedAtMs : 0;
    const safeTotal = Math.max(0, total);
    const safeCompleted = Math.max(0, Math.min(completed, safeTotal || completed));
    const percent = percentForStage(job.type, stage, safeCompleted, safeTotal);
    const etaMs =
      safeCompleted > 0 && safeTotal > safeCompleted
        ? Math.max(0, Math.round((elapsedMs / safeCompleted) * (safeTotal - safeCompleted)))
        : null;
    const stages = stagesFor(job.type);
    const index = stages.indexOf(stage);
    const progress: JobProgress = {
      phase: stage,
      completed: safeCompleted,
      total: safeTotal,
      percent,
      detail,
      stageIndex: index >= 0 ? index + 1 : undefined,
      stageTotal: stages.length,
      elapsedMs,
      etaMs
    };
    await this.updateProgress(job, progress);
  }

  private async updateProgress(job: Job, progress: JobProgress): Promise<void> {
    job.progress = progress;
    this.store.updateJob(job);
    this.broadcast("job.updated", job);
  }
  private async log(job: Job, level: JobLogLine["level"], line: string): Promise<void> {
    const tsMs = Date.now();
    const seq = (this.logSeq.get(job.jobId) ?? 0) + 1;
    this.logSeq.set(job.jobId, seq);
    const dir = this.sessions.sessionDir(job.sessionId);
    const file = path.join(dir, job.logFile);
    try {
      await ensureDir(path.dirname(file));
      await fsp.appendFile(file, `[${logStamp(tsMs)}] ${level} ${line.replace(/\r?\n/g, " ")}\n`, "utf8");
    } catch (error) {
      // A failed log must not strand a queued/running job; surface it over SSE.
      this.broadcast("warning", {
        code: "job_log_failed",
        message: `Could not write job log ${job.logFile}: ${error instanceof Error ? error.message : String(error)}`
      });
    }
    this.broadcast("job.log", { jobId: job.jobId, seq, tsMs, level, line });
  }

  async cancel(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw new JobError("not_found", `That job is no longer there.`, 404);
    if (job.status === "queued") {
      this.cancelled.add(jobId);
      job.status = "cancelled";
      job.finishedAtMs = Date.now();
      job.progress = { ...job.progress, detail: "Cancelled before start", etaMs: null, queuePosition: undefined };
      this.store.updateJob(job);
      this.broadcast("job.updated", job);
      await this.log(job, "WARN", "Cancelled before start");
    } else if (job.status === "running") {
      this.cancelled.add(jobId);
      const child = this.children.get(jobId);
      if (child) {
        try {
          child.kill();
        } catch {
          // ignore
        }
        setTimeout(() => {
          if (this.children.has(jobId)) {
            try {
              child?.kill("SIGKILL");
            } catch {
              // ignore
            }
          }
        }, 3000).unref?.();
      }
      job.status = "cancelled";
      job.finishedAtMs = Date.now();
      job.progress = { ...job.progress, detail: "Cancellation requested", etaMs: null, queuePosition: undefined };
      this.store.updateJob(job);
      this.broadcast("job.updated", job);
      await this.log(job, "WARN", "Cancellation requested; process stopped");
    } else {
      throw new JobError("invalid_state", `Job is already ${job.status}`, 409);
    }
    await this.refreshQueuePositions();
    this.notifyJobWaiters(job);
    if (job.type !== "context") await this.refreshSessionStatus(job.sessionId);
    return job;
  }

  async retry(jobId: string): Promise<Job> {
    const job = this.store.getJob(jobId);
    if (!job) throw new JobError("not_found", `That job is no longer there.`, 404);
    if (!["failed", "cancelled", "done"].includes(job.status)) {
      throw new JobError("invalid_state", `Only a failed or stopped job can be retried.`, 409);
    }
    const request = job.type === "context" ? { ...job.request } : {};
    return this.enqueue(job.sessionId, job.type, request);
  }

  async logs(jobId: string, afterSeq = 0, limit = 200): Promise<JobLogLine[]> {
    const job = this.store.getJob(jobId);
    if (!job) throw new JobError("not_found", `That job is no longer there.`, 404);
    const dir = this.sessions.sessionDir(job.sessionId);
    return readJobLogs(path.join(dir, job.logFile), afterSeq, limit);
  }

  async shutdown(): Promise<void> {
    this.closing = true;
    for (const child of this.children.values()) {
      try {
        child.kill();
      } catch {
        // ignore
      }
    }
    this.children.clear();
    if (this.loopActive) {
      await new Promise<void>((resolve) => this.idleWaiters.push(resolve));
    }
  }
}
