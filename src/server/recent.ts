import type { AppConfig } from "./config.js";
import path from "node:path";
import type { DiscordUtterance, PeopleFile, SessionRecord, TranscriptRecord } from "../core/types.js";
import { readJson, readJsonl, writeFileAtomic } from "../core/paths.js";
import { personIsOptedOut } from "../core/consent.js";
import { runSttBatch, SttBatchError, SttCancelledError, type SttProgressEvent } from "./sttBatch.js";

export class RecentContextError extends Error {
  override name = "RecentContextError";
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface RecentTranscriptionResult {
  candidates: number;
  transcribed: number;
  alreadyPresent: number;
  failed: number;
  skippedSilent?: number;
  skippedOptOut?: number;
  errors: string[];
  elapsedMs: number;
}

/**
 * Transcribe only the utterances overlapping a recent window and merge the new
 * records into the canonical transcript. The full-session transcript is never
 * replaced: existing records survive, new records win by utterance id, and the
 * result is sorted by capture time.
 */
export async function transcribeRecentWindow(params: {
  config: AppConfig;
  session: SessionRecord;
  sessionDir: string;
  manifest: DiscordUtterance[];
  existing: TranscriptRecord[];
  startMs: number;
  endMs: number;
  onProgress?: (event: SttProgressEvent) => void;
  onLog?: (level: "INFO" | "WARN" | "DEBUG", message: string) => void;
  onChild?: (child: import("node:child_process").ChildProcessWithoutNullStreams) => void;
  isCancelled?: () => boolean;
}): Promise<RecentTranscriptionResult> {
  const { config, session, sessionDir, manifest, existing, startMs, endMs } = params;
  const startedAtMs = Date.now();
  const windowUtterances = manifest
    .filter((utterance) => utterance.startMs <= endMs && utterance.endMs >= startMs)
    .sort((a, b) => a.startMs - b.startMs);
  const existingIds = new Set(existing.map((record) => record.utteranceId));
  const missing = windowUtterances.filter((utterance) => !existingIds.has(utterance.utteranceId));
  const alreadyPresent = windowUtterances.length - missing.length;
  if (missing.length === 0) {
    return {
      candidates: windowUtterances.length,
      transcribed: 0,
      alreadyPresent,
      failed: 0,
      skippedSilent: 0,
      skippedOptOut: 0,
      errors: [],
      elapsedMs: Date.now() - startedAtMs
    };
  }

  let batch;
  try {
    batch = await runSttBatch({
      config,
      session,
      sessionDir,
      utterances: missing,
      batchJobId: `recent_${Date.now().toString(36)}`,
      prefix: "recent-raw",
      onProgress: params.onProgress,
      onLog: params.onLog,
      onChild: params.onChild,
      isCancelled: params.isCancelled
    });
  } catch (error) {
    if (error instanceof SttBatchError) throw new RecentContextError(error.code, error.message, error.statusCode);
    if (error instanceof SttCancelledError) throw new RecentContextError("cancelled", "Recent transcription was cancelled", 409);
    throw error;
  }

  const byId = new Map<string, TranscriptRecord>();
  const peopleFile = await readJson<PeopleFile>(path.join(sessionDir, "people.json"));
  const optedOut = new Set(
    (peopleFile?.people ?? [])
      .filter(personIsOptedOut)
      .map((person) => person.discordUserId)
      .filter((id): id is string => Boolean(id))
  );
  for (const record of existing) {
    if (record?.utteranceId && !optedOut.has(record.discordUserId)) byId.set(record.utteranceId, record);
  }
  let transcribed = 0;
  for (const record of batch.records) {
    if (!record?.utteranceId || optedOut.has(record.discordUserId)) continue;
    byId.set(record.utteranceId, record);
    transcribed += 1;
  }
  const merged = [...byId.values()].sort((a, b) => a.startMs - b.startMs || a.utteranceId.localeCompare(b.utteranceId));
  await writeFileAtomic(
    path.join(sessionDir, "stt", "transcript.jsonl"),
    merged.map((record) => JSON.stringify(record)).join("\n") + (merged.length ? "\n" : "")
  );

  const errors = batch.errors.map((error) => `${error.utteranceId}: ${error.message}`);
  return {
    candidates: windowUtterances.length,
    transcribed,
    alreadyPresent,
    failed: Math.max(errors.length, missing.length - transcribed - (batch.skippedOptOut ?? 0)),
    skippedSilent: batch.skippedSilent,
    skippedOptOut: batch.skippedOptOut,
    errors,
    elapsedMs: Date.now() - startedAtMs
  };
}

export async function readRecentSource(sessionDir: string): Promise<{
  transcripts: TranscriptRecord[];
  manifest: DiscordUtterance[];
}> {
  const [transcript, manifest] = await Promise.all([
    readJsonl<TranscriptRecord>(path.join(sessionDir, "stt", "transcript.jsonl")),
    readJsonl<DiscordUtterance>(path.join(sessionDir, "discord", "manifest.jsonl"))
  ]);
  return { transcripts: transcript.items, manifest: manifest.items };
}
