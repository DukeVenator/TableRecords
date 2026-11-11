import type { LlmSummaryPreset, LlmSummaryScope, LlmThinkingEffort } from "./types.js";

export const SUMMARY_PROMPT_VERSION = "2026-11-02.1";

export interface SummaryPresetDefinition {
  id: LlmSummaryPreset;
  label: string;
  description: string;
  system: string;
  maxTokens: number;
  json: boolean;
  jsonSchema?: Record<string, unknown>;
}

const BASE_SYSTEM =
  "You are a tabletop RPG session archivist. Use only facts present in the supplied deterministic session brief. " +
  "Never invent dice results, names, clues, outcomes, or player decisions. If the brief does not support a claim, leave it out. " +
  "Keep the answer concise and in Markdown unless the request asks for JSON.";

export const SUMMARY_FACTS_SCHEMA = {
  type: "object",
  properties: {
    names: { type: "array", items: { type: "string" } },
    places: { type: "array", items: { type: "string" } },
    items: { type: "array", items: { type: "string" } },
    clues: { type: "array", items: { type: "string" } },
    decisions: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } }
  },
  required: ["names", "places", "items", "clues", "decisions", "questions"],
  additionalProperties: false
} as const;

export const SUMMARY_COVERAGE_SCHEMA = {
  type: "object",
  properties: {
    coveredIds: { type: "array", items: { type: "number" } },
    missingIds: { type: "array", items: { type: "number" } }
  },
  required: ["coveredIds", "missingIds"],
  additionalProperties: false
} as const;

export const SUMMARY_COVERAGE_SYSTEM =
  "Check a summary against a numbered fact list. A fact is covered only when the summary states it or a clear paraphrase. " +
  "Do not mark a fact covered just because a name appears. Return JSON with coveredIds and missingIds using the supplied numbers.";

export const SUMMARY_FACTS_SYSTEM =
  "Extract only facts explicitly present in this session portion. Return JSON with arrays: names, places, items, clues, decisions, questions. " +
  "Use short exact phrases. Do not add interpretation, speculation, or facts from the wider session. Return an empty array when none exist.";

export interface SummaryFacts {
  names: string[];
  places: string[];
  items: string[];
  clues: string[];
  decisions: string[];
  questions: string[];
}

export function emptySummaryFacts(): SummaryFacts {
  return { names: [], places: [], items: [], clues: [], decisions: [], questions: [] };
}

function factList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter((item) => item.length > 1)
    .slice(0, 40);
}

export function parseSummaryFacts(text: string): SummaryFacts | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  try {
    const parsed = JSON.parse(cleaned) as Record<string, unknown>;
    return {
      names: factList(parsed.names),
      places: factList(parsed.places),
      items: factList(parsed.items),
      clues: factList(parsed.clues),
      decisions: factList(parsed.decisions),
      questions: factList(parsed.questions)
    };
  } catch {
    return null;
  }
}

export function mergeSummaryFacts(target: SummaryFacts, source: SummaryFacts): void {
  for (const key of Object.keys(target) as Array<keyof SummaryFacts>) {
    const seen = new Set(target[key].map((value) => value.toLowerCase()));
    for (const value of source[key]) {
      if (seen.has(value.toLowerCase())) continue;
      target[key].push(value);
      seen.add(value.toLowerCase());
    }
  }
}

export function summaryFactsBlock(facts: SummaryFacts, maxChars = 8_000): string {
  const sections: Array<[string, string[]]> = [
    ["Names", facts.names],
    ["Places", facts.places],
    ["Items", facts.items],
    ["Clues", facts.clues],
    ["Decisions", facts.decisions],
    ["Open questions", facts.questions]
  ];
  const lines = ["## Extracted entity and clue index", ""];
  for (const [label, values] of sections) {
    if (values.length === 0) continue;
    lines.push(`### ${label}`);
    for (const value of values) lines.push(`- ${value}`);
    lines.push("");
  }
  let text = lines.join("\n").trimEnd();
  if (text.length > maxChars) {
    text = `${text.slice(0, maxChars).trimEnd()}\n\n> Extracted index truncated at the configured limit.`;
  }
  return text;
}

export const SUMMARY_CHUNK_SYSTEM =
  "You are a tabletop RPG session archivist. Summarize this portion of a session brief factually. " +
  "Start with a 'Must keep' bullet list of names, rolls, clues, decisions, and unresolved questions, then write 150 to 300 words. " +
  "Do not invent anything and do not repeat the brief. Return Markdown.";

const CLUE_SCHEMA = {
  type: "object",
  properties: {
    situation: { type: "string" },
    npcs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          name: { type: "string" },
          note: { type: "string" }
        },
        required: ["name", "note"],
        additionalProperties: false
      }
    },
    clues: { type: "array", items: { type: "string" } },
    threads: { type: "array", items: { type: "string" } },
    reminders: { type: "array", items: { type: "string" } }
  },
  required: ["situation", "npcs", "clues", "threads", "reminders"],
  additionalProperties: false
} as const;

export const SUMMARY_PRESETS: Record<LlmSummaryPreset, SummaryPresetDefinition> = {
  recap: {
    id: "recap",
    label: "Session recap",
    description: "A short narrative of what happened, suitable for sharing with the table.",
    system:
      `${BASE_SYSTEM} Write a session recap with these headings: What happened, People, Open questions. ` +
      "Keep it under about 350 words. Do not expose hidden GM-only speculation as fact.",
    maxTokens: 900,
    json: false
  },
  "gm-prep": {
    id: "gm-prep",
    label: "GM prep",
    description: "Current situation, NPCs and clues, open threads, and reminders for the next session.",
    system:
      `${BASE_SYSTEM} Write GM preparation notes with these headings: Current situation, People and clues, ` +
      "Open threads, GM reminders. Separate what was established from what is still uncertain. Keep it under about 450 words.",
    maxTokens: 1200,
    json: false
  },
  "clue-board": {
    id: "clue-board",
    label: "Clue board",
    description: "A structured list of the situation, NPCs, clues, threads, and reminders.",
    system:
      `${BASE_SYSTEM} Return only a JSON object with the keys situation (string), npcs (array of objects with name and note), ` +
      "clues (array of strings), threads (array of strings), and reminders (array of strings). " +
      "Do not wrap the JSON in a code fence and do not add any other keys.",
    maxTokens: 1200,
    json: true,
    jsonSchema: CLUE_SCHEMA
  },
  rules: {
    id: "rules",
    label: "Rules log",
    description: "Rules questions raised, the ruling made, and anything left unresolved.",
    system:
      `${BASE_SYSTEM} Write a rules log with these headings: Questions raised, Rulings, Still unresolved. ` +
      "Quote only rules text that appears in the brief. Keep it under about 300 words.",
    maxTokens: 900,
    json: false
  }
};

export const SUMMARY_SCOPE_LABELS: Record<LlmSummaryScope, string> = {
  recent: "Recent window",
  scene: "Current scene",
  session: "Whole session"
};

export function summaryPreset(value: unknown): LlmSummaryPreset | null {
  return typeof value === "string" && value in SUMMARY_PRESETS ? (value as LlmSummaryPreset) : null;
}

export function summaryScope(value: unknown): LlmSummaryScope | null {
  return value === "recent" || value === "scene" || value === "session" ? value : null;
}

export class SummaryFormatError extends Error {
  override name = "SummaryFormatError";
}

export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function summaryUserPrompt(preset: LlmSummaryPreset, brief: string): string {
  return [
    `Task: ${SUMMARY_PRESETS[preset].label}.`,
    "Summarize the session brief between the tags. Do not copy or list the brief back. Return only the requested output.",
    "",
    "<brief>",
    brief,
    "</brief>"
  ].join("\n");
}

/**
 * Split a whole-session brief until each portion fits the configured input
 * limit. The cap only guards against pathological inputs; it must not silently
 * truncate a normal four-hour session.
 */
/**
 * Character budget for a single prompt, leaving room for output and for the
 * reasoning trace of a thinking model. The 3.6 ratio is a conservative
 * characters-per-token estimate for session prose plus Markdown.
 */
export function summaryInputCharBudget(
  contextTokens: number,
  configuredMaxInputChars: number,
  thinkingEffort: LlmThinkingEffort
): number {
  // Thinking models can use their whole completion block before the answer.
  // Reserve the same headroom for low, medium, and high so a small level cannot
  // produce an empty response.
  const thinkingReserve = thinkingEffort === "off" ? 1_800 : 5_600;
  const promptTokens = Math.max(2_048, contextTokens - thinkingReserve);
  return Math.max(4_000, Math.min(configuredMaxInputChars, Math.floor(promptTokens * 3.6)));
}

export function summaryChunkCount(briefChars: number, maxInputChars: number, maxChunks = 64): number {
  const target = Math.max(1, maxInputChars);
  if (briefChars <= target) return 1;
  return Math.min(maxChunks, Math.max(2, Math.ceil(briefChars / target)));
}

export function trimSummaryBrief(
  markdown: string,
  maxChars: number
): { markdown: string; trimmed: boolean; originalChars: number } {
  const originalChars = markdown.length;
  if (maxChars < 1 || originalChars <= maxChars) {
    return { markdown, trimmed: false, originalChars };
  }
  const cut = markdown.slice(0, maxChars);
  const section = Math.max(cut.lastIndexOf("\n## "), cut.lastIndexOf("\n- "));
  const body = (section > maxChars * 0.5 ? cut.slice(0, section) : cut).trimEnd();
  return {
    markdown: `${body}\n\n> Brief trimmed to fit the configured input limit. Later events may be missing.\n`,
    trimmed: true,
    originalChars
  };
}

function stringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (typeof item === "string" ? item.trim() : ""))
    .filter((item) => item.length > 0)
    .slice(0, 50);
}

function structuredValue(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SummaryFormatError("The clue board was not a JSON object");
  }
  const record = value as Record<string, unknown>;
  const situation = typeof record.situation === "string" ? record.situation.trim() : "";
  if (!situation) throw new SummaryFormatError("The clue board has no situation");
  const npcs = Array.isArray(record.npcs)
    ? record.npcs
        .map((item) => {
          if (!item || typeof item !== "object") return null;
          const npc = item as Record<string, unknown>;
          const name = typeof npc.name === "string" ? npc.name.trim() : "";
          if (!name) return null;
          return { name, note: typeof npc.note === "string" ? npc.note.trim() : "" };
        })
        .filter((item): item is { name: string; note: string } => item !== null)
        .slice(0, 50)
    : [];
  return {
    situation,
    npcs,
    clues: stringList(record.clues),
    threads: stringList(record.threads),
    reminders: stringList(record.reminders)
  };
}

export function parseStructuredSummary(text: string): Record<string, unknown> {
  const raw = text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new SummaryFormatError("The clue board was not valid JSON");
  }
  return structuredValue(parsed);
}
