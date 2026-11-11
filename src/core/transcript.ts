import type { TranscriptRecord } from "./types.js";

/** Backchannels that ASR produces from room tone or a barely-open mic. */
const FILLER_TOKENS = new Set([
  "yeah",
  "yep",
  "yup",
  "okay",
  "ok",
  "k",
  "mm",
  "mmm",
  "mm-hmm",
  "mhm",
  "hmm",
  "hm",
  "uh",
  "uh-huh",
  "um",
  "erm",
  "ah",
  "oh",
  "right",
  "sure",
  "alright",
  "huh",
  "hey",
  "hi"
]);

const FILLER_MAX_MS = 1400;

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}'’\- ]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);
}

/**
 * Clean ASR output without changing its meaning:
 * - standalone ampersands (a common Parakeet artifact) disappear;
 * - immediate three-plus word stutters collapse to one word;
 * - whitespace and leading/trailing punctuation are normalized.
 */
export function normalizeTranscriptText(input: string): string {
  let text = (input ?? "")
    .replace(/\r/g, "")
    .replace(/\u00a0/g, " ")
    .replace(/\s+&\s+/g, " ")
    .replace(/^\s*&\s*/g, "")
    .replace(/\s*&\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/\b([\p{L}\p{N}'’-]+)(?:\s+\1\b){2,}/giu, "$1");
  text = text.replace(/^[\s.,;:!?…–—-]+/u, "").replace(/[\s,;:…–—-]+$/u, "").trim();
  return text;
}

export function isFillerOnly(text: string): boolean {
  const parts = tokens(text);
  if (parts.length === 0 || parts.length > 4) return false;
  return parts.every((part) => FILLER_TOKENS.has(part));
}

const REPEATABLE_WORDS = new Set(["no", "yes", "yeah", "okay", "ok", "wait", "stop", "go", "run", "help", "why", "what"]);

/**
 * Detect degenerate decoder loops such as "Names G.O.A.T. Names G.O.A.T. …".
 * Natural repetition ("no no no") is short and stays below these thresholds.
 */
export function isRepetitiveText(text: string): boolean {
  const parts = tokens(text);
  if (parts.length < 3) return false;
  const unique = new Set(parts).size;
  if (parts.length >= 4 && unique === 1 && !REPEATABLE_WORDS.has(parts[0]!)) return true;
  if (parts.length < 8) return false;
  if (unique <= 2) return true;
  if (unique / parts.length <= 0.3) return true;
  for (let size = 2; size <= 4; size += 1) {
    const counts = new Map<string, number>();
    for (let index = 0; index + size <= parts.length; index += 1) {
      const key = parts.slice(index, index + size).join(" ");
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    for (const count of counts.values()) {
      if (count >= 4 && count * size >= parts.length * 0.6) return true;
    }
  }
  return false;
}

/** Normalize text and add flags used by the merge/render exclusion list. */
export function annotateTranscript(record: TranscriptRecord): TranscriptRecord {
  const text = normalizeTranscriptText(record.text);
  const flags = new Set(Array.isArray(record.flags) ? record.flags : []);
  if (!text) flags.add("empty");
  const durationMs = Math.max(0, record.endMs - record.startMs);
  if (text && isFillerOnly(text) && (durationMs <= FILLER_MAX_MS || tokens(text).length <= 3)) flags.add("filler");
  if (text && isRepetitiveText(text)) flags.add("repetitive");
  return {
    ...record,
    text,
    rawText: record.rawText ?? record.text,
    flags: [...flags]
  };
}

export interface StitchOptions {
  gapMs?: number;
  maxMergedMs?: number;
  /** Rolls, chat, markers, etc. inside the gap break a merge. */
  blockers?: Array<{ tsMs: number }>;
}

/**
 * Join consecutive records from the same speaker when the pause between them
 * is short. This is the second half of gap handling: capture keeps a longer
 * silence window, and this catches sessions recorded before that change (or
 * any case where Discord gave us two streams).
 */
export function stitchTranscripts(records: TranscriptRecord[], options: StitchOptions = {}): TranscriptRecord[] {
  const gapMs = Math.max(0, options.gapMs ?? 2000);
  const maxMergedMs = Math.max(1000, options.maxMergedMs ?? 60_000);
  const blockers = options.blockers ?? [];
  const normalized = records.map(annotateTranscript).sort((a, b) => a.startMs - b.startMs || a.utteranceId.localeCompare(b.utteranceId));
  if (gapMs === 0 || normalized.length < 2) return normalized;

  const starts = normalized.map((record) => record.startMs);
  const hasInterjection = (left: TranscriptRecord, right: TranscriptRecord): boolean => {
    let low = 0;
    let high = starts.length;
    while (low < high) {
      const mid = (low + high) >> 1;
      if (starts[mid]! < left.endMs) low = mid + 1;
      else high = mid;
    }
    for (let index = low; index < normalized.length && normalized[index]!.startMs < right.startMs; index += 1) {
      const other = normalized[index]!;
      if (other.discordUserId === left.discordUserId) continue;
      if (other.startMs > left.endMs - 1) return true;
    }
    return blockers.some((blocker) => blocker.tsMs >= left.endMs && blocker.tsMs < right.startMs);
  };

  const merged: TranscriptRecord[] = [];
  for (const record of normalized) {
    const previous = merged.at(-1);
    const gap = previous ? record.startMs - previous.endMs : Number.POSITIVE_INFINITY;
    const canMerge =
      previous != null &&
      previous.discordUserId === record.discordUserId &&
      gap >= 0 &&
      gap <= gapMs &&
      record.endMs - previous.startMs <= maxMergedMs &&
      !hasInterjection(previous, record);
    if (!canMerge) {
      merged.push(record);
      continue;
    }
    const joined = annotateTranscript({
      ...previous,
      text: `${previous.text} ${record.text}`.trim(),
      rawText: `${previous.rawText ?? previous.text} ${record.rawText ?? record.text}`.trim(),
      endMs: record.endMs,
      words: [...(previous.words ?? []), ...(record.words ?? [])],
      flags: [...new Set([...(previous.flags ?? []), ...(record.flags ?? [])])],
      utteranceIds: [
        ...(previous.utteranceIds ?? [previous.utteranceId]),
        ...(record.utteranceIds ?? [record.utteranceId])
      ]
    });
    // A merged record keeps the first utterance id so its audio link and
    // timestamps remain valid; utteranceIds is the full provenance list.
    merged[merged.length - 1] = { ...joined, utteranceId: previous.utteranceId };
  }
  return merged;
}
