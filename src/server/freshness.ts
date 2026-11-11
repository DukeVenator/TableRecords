import fsp from "node:fs/promises";
import path from "node:path";

const OUTPUT_FILES = [
  "transcript.md",
  "chronology.md",
  "rolls.csv",
  "roll-sync.md",
  "mental-notes.md",
  "stats.md",
  "notes-ready.md"
] as const;

const SOURCE_FILES: Array<{ label: string; file: string }> = [
  { label: "new audio", file: "discord/manifest.jsonl" },
  { label: "transcripts", file: "stt/transcript.jsonl" },
  { label: "Foundry events", file: "foundry/events.jsonl" },
  { label: "live Foundry events", file: "foundry/live-events.jsonl" },
  { label: "Foundry import", file: "foundry/import-summary.json" },
  { label: "markers", file: "markers.jsonl" },
  { label: "player mapping", file: "people.json" },
  { label: "merged timeline", file: "merged/timeline.jsonl" }
];

export interface OutputFreshness {
  stale: boolean;
  reason: string | null;
  outputModifiedAtMs: number | null;
  newerSources: string[];
}

async function mtimeMs(file: string): Promise<number | null> {
  try {
    return (await fsp.stat(file)).mtimeMs;
  } catch {
    return null;
  }
}

/**
 * Outputs are derived files. A render timestamp older than the manifest,
 * transcript, Foundry events, mapping, markers, or timeline means the panel is
 * showing an old view even though the files are still readable.
 */
export async function outputFreshness(sessionDir: string): Promise<OutputFreshness> {
  let outputModifiedAtMs: number | null = null;
  let outputCount = 0;
  for (const name of OUTPUT_FILES) {
    const mtime = await mtimeMs(path.join(sessionDir, "outputs", name));
    if (mtime == null) continue;
    outputCount += 1;
    outputModifiedAtMs = Math.max(outputModifiedAtMs ?? 0, mtime);
  }
  if (outputCount === 0 || outputModifiedAtMs == null) {
    return { stale: false, reason: null, outputModifiedAtMs: null, newerSources: [] };
  }

  const newerSources: string[] = [];
  for (const source of SOURCE_FILES) {
    const mtime = await mtimeMs(path.join(sessionDir, source.file));
    // Filesystem timestamps are coarse; a source written in the same second as
    // the render is not proof of a stale view.
    if (mtime != null && mtime > outputModifiedAtMs + 1000) newerSources.push(source.label);
  }
  return {
    stale: newerSources.length > 0,
    reason: newerSources.length > 0 ? newerSources.join(", ") : null,
    outputModifiedAtMs,
    newerSources
  };
}
