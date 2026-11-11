import fsp from "node:fs/promises";
import path from "node:path";
import type { DiscordUtterance, ReviewAudioManifest, SessionRecord } from "../core/types.js";
import { WAV_HEADER_BYTES, inspectWav, wavHeader } from "../core/wav.js";
import { readJson, readJsonl, resolveExistingInside, writeFileAtomic, writeJsonAtomic, writeJsonl } from "../core/paths.js";

export class AudioStorageError extends Error {
  override name = "AudioStorageError";
  readonly code: string;
  readonly statusCode: number;

  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

export interface AudioStorageState {
  state: "available" | "compacted" | "removed";
  clipCount: number;
  bytes: number;
  compactedAtMs?: number;
  removedAtMs?: number;
}

interface RemovedMarker {
  schema: "tablerecords.audio-removed/v1";
  sessionId: string;
  removedAtMs: number;
  clipCount: number;
  bytes: number;
}

interface CompactedMarker {
  schema: "tablerecords.audio-compacted/v1";
  sessionId: string;
  compactedAtMs: number;
  clipCount: number;
  bytesBefore: number;
  bytesAfter: number;
}

const REMOVED_MARKER = path.join("discord", "audio-removed.json");
const COMPACTED_MARKER = path.join("discord", "audio-compacted.json");
const MANIFEST = path.join("discord", "manifest.jsonl");

export interface StorageCategory {
  id: string;
  label: string;
  bytes: number;
  files: number;
}

export interface SessionStorageReport {
  totalBytes: number;
  totalFiles: number;
  categories: StorageCategory[];
  audio: AudioStorageState;
}

/**
 * Walk the session directory once and group bytes by purpose. This is a
 * read-only report used by the storage panel; it never follows symlinks.
 */
export async function measureSessionStorage(sessionDir: string): Promise<SessionStorageReport> {
  const labels: Record<string, string> = {
    clips: "Per-clip audio",
    review: "Review tracks",
    stt: "STT intermediates",
    outputs: "Rendered outputs",
    foundry: "Foundry data",
    context: "Context briefs",
    jobs: "Job logs",
    other: "Other files"
  };
  const sums = new Map<string, { bytes: number; files: number }>();
  const add = (id: string, bytes: number) => {
    const current = sums.get(id) ?? { bytes: 0, files: 0 };
    current.bytes += bytes;
    current.files += 1;
    sums.set(id, current);
  };
  const walk = async (dir: string, relative: string): Promise<void> => {
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const nextRelative = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), nextRelative);
      } else if (entry.isFile()) {
        const stat = await fsp.stat(path.join(dir, entry.name)).catch(() => null);
        if (!stat) continue;
        const category = nextRelative.startsWith("discord/audio/")
          ? "clips"
          : nextRelative.startsWith("review/")
            ? "review"
            : nextRelative.startsWith("stt/")
              ? "stt"
              : nextRelative.startsWith("outputs/")
                ? "outputs"
                : nextRelative.startsWith("foundry/")
                  ? "foundry"
                  : nextRelative.startsWith("context/")
                    ? "context"
                    : nextRelative.startsWith("jobs/")
                      ? "jobs"
                      : "other";
        add(category, stat.size);
      }
    }
  };
  await walk(sessionDir, "");
  const audio = await readAudioStorage(sessionDir);
  const categories = [...sums.entries()]
    .map(([id, value]) => ({ id, label: labels[id] ?? id, bytes: value.bytes, files: value.files }))
    .sort((a, b) => b.bytes - a.bytes);
  return {
    totalBytes: categories.reduce((sum, item) => sum + item.bytes, 0),
    totalFiles: categories.reduce((sum, item) => sum + item.files, 0),
    categories,
    audio
  };
}

export async function readAudioStorage(sessionDir: string): Promise<AudioStorageState> {
  const removed = await readJson<RemovedMarker>(path.join(sessionDir, REMOVED_MARKER));
  if (removed?.schema === "tablerecords.audio-removed/v1") {
    return {
      state: "removed",
      clipCount: removed.clipCount,
      bytes: removed.bytes,
      removedAtMs: removed.removedAtMs
    };
  }
  const compacted = await readJson<CompactedMarker>(path.join(sessionDir, COMPACTED_MARKER));
  const manifest = await readJsonl<DiscordUtterance>(path.join(sessionDir, MANIFEST));
  const bytes = manifest.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  if (compacted?.schema === "tablerecords.audio-compacted/v1") {
    return {
      state: "compacted",
      clipCount: manifest.items.length || compacted.clipCount,
      bytes: bytes || compacted.bytesAfter,
      compactedAtMs: compacted.compactedAtMs
    };
  }
  return { state: "available", clipCount: manifest.items.length, bytes };
}

/** Confirm the review mix exists, covers every listed file, and is newer than the clip manifest. */
export async function reviewAudioReady(sessionDir: string): Promise<boolean> {
  const manifest = await readJson<ReviewAudioManifest>(path.join(sessionDir, "review", "manifest.json"));
  if (!manifest?.files?.length) return false;
  for (const file of manifest.files) {
    try {
      await resolveExistingInside(path.join(sessionDir, "review"), file.name);
    } catch {
      return false;
    }
  }
  try {
    const reviewStat = await fsp.stat(path.join(sessionDir, "review", "manifest.json"));
    const clipStat = await fsp.stat(path.join(sessionDir, MANIFEST));
    return reviewStat.mtimeMs >= clipStat.mtimeMs;
  } catch {
    // No clip manifest means the clips were removed; the review files are the source.
    return true;
  }
}

/**
 * Collapse per-utterance WAVs to 16 kHz mono PCM. Speech-to-text already works
 * at 16 kHz and the browser plays the smaller files; this is roughly a 6x
 * reduction with no extra codec dependency. Review audio must be built first:
 * it is the full-fidelity copy and the fallback when clips are later removed.
 */
export async function compactSessionAudio(params: {
  session: SessionRecord;
  sessionDir: string;
}): Promise<{ before: AudioStorageState; after: AudioStorageState; converted: number }> {
  const { session, sessionDir } = params;
  if (!(await reviewAudioReady(sessionDir))) {
    throw new AudioStorageError("review_required", "Build the review audio before compacting clips", 409);
  }
  const before = await readAudioStorage(sessionDir);
  if (before.state === "removed") throw new AudioStorageError("audio_removed", "The clip audio has already been removed", 409);
  if (before.state === "compacted") {
    return { before, after: before, converted: 0 };
  }
  const manifestPath = path.join(sessionDir, MANIFEST);
  const manifest = await readJsonl<DiscordUtterance>(manifestPath);
  if (manifest.items.length === 0) throw new AudioStorageError("no_audio", "No clips to compact", 409);

  let converted = 0;
  let bytesAfter = 0;
  for (const item of manifest.items) {
    const file = await resolveExistingInside(sessionDir, item.file);
    const info = await inspectWav(file);
    if (info.sampleRate === 16_000 && info.channels === 1) {
      item.sampleRate = 16_000;
      item.channels = 1;
      item.bytes = info.dataBytes + WAV_HEADER_BYTES;
      item.durationMs = info.durationMs;
      bytesAfter += item.bytes;
      continue;
    }
    if (info.sampleRate !== 48_000 || info.channels !== 2 || info.bitsPerSample !== 16) {
      throw new AudioStorageError(
        "unsupported_audio",
        `That clip is not 48 kHz stereo 16-bit WAV, so it was not compacted.`,
        409
      );
    }
    const source = await fsp.readFile(file);
    const dataBytes = Math.min(info.dataBytes, source.length - WAV_HEADER_BYTES);
    const frames = Math.floor(dataBytes / 4);
    const outFrames = Math.max(1, Math.floor(frames / 3));
    const pcm = Buffer.alloc(outFrames * 2);
    for (let index = 0; index < outFrames; index += 1) {
      let sum = 0;
      for (let sub = 0; sub < 3; sub += 1) {
        const frame = index * 3 + sub;
        if (frame >= frames) break;
        const offset = WAV_HEADER_BYTES + frame * 4;
        sum += source.readInt16LE(offset) + source.readInt16LE(offset + 2);
      }
      const value = Math.max(-32768, Math.min(32767, Math.round(sum / 6)));
      pcm.writeInt16LE(value, index * 2);
    }
    const out = Buffer.concat([wavHeader(pcm.length, 16_000, 1, 16), pcm]);
    await writeFileAtomic(file, out);
    item.sampleRate = 16_000;
    item.channels = 1;
    item.bytes = out.length;
    item.durationMs = Math.round((outFrames / 16_000) * 1000);
    bytesAfter += out.length;
    converted += 1;
  }
  await writeJsonl(manifestPath, manifest.items);
  const compacted: CompactedMarker = {
    schema: "tablerecords.audio-compacted/v1",
    sessionId: session.sessionId,
    compactedAtMs: Date.now(),
    clipCount: manifest.items.length,
    bytesBefore: before.bytes,
    bytesAfter
  };
  await writeJsonAtomic(path.join(sessionDir, COMPACTED_MARKER), compacted);
  // Compaction rewrites the manifest but not the audio content; keep the saved
  // full-quality mix "current" so it is not rebuilt unnecessarily.
  const reviewManifest = path.join(sessionDir, "review", "manifest.json");
  const now = new Date();
  await fsp.utimes(reviewManifest, now, now).catch(() => undefined);
  return {
    before,
    after: {
      state: "compacted",
      clipCount: compacted.clipCount,
      bytes: bytesAfter,
      compactedAtMs: compacted.compactedAtMs
    },
    converted
  };
}

/**
 * Delete the per-utterance WAVs after the review mix is safely on disk. The
 * manifest is moved out of the way (for audit) and a marker records what was
 * removed; transcripts and outputs are untouched.
 */
export async function removeSessionAudio(params: {
  session: SessionRecord;
  sessionDir: string;
}): Promise<{ before: AudioStorageState; after: AudioStorageState }> {
  const { session, sessionDir } = params;
  const before = await readAudioStorage(sessionDir);
  if (before.state === "removed") return { before, after: before };
  if (!(await reviewAudioReady(sessionDir))) {
    throw new AudioStorageError("review_required", "Build the review audio before deleting clips", 409);
  }
  const manifestPath = path.join(sessionDir, MANIFEST);
  const manifest = await readJsonl<DiscordUtterance>(manifestPath);
  const clipCount = manifest.items.length;
  const bytes = manifest.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0);
  await fsp.rm(path.join(sessionDir, "discord", "audio"), { recursive: true, force: true });
  const removed: RemovedMarker = {
    schema: "tablerecords.audio-removed/v1",
    sessionId: session.sessionId,
    removedAtMs: Date.now(),
    clipCount,
    bytes
  };
  if (clipCount > 0) {
    await fsp.rename(manifestPath, path.join(sessionDir, "discord", "manifest.removed.jsonl")).catch(async () => {
      await fsp.rm(manifestPath, { force: true });
    });
  }
  await writeJsonAtomic(path.join(sessionDir, REMOVED_MARKER), removed);
  return {
    before,
    after: { state: "removed", clipCount, bytes, removedAtMs: removed.removedAtMs }
  };
}
