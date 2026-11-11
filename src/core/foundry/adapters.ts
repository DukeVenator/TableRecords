import type { FoundryEvent } from "../types.js";

export interface FfgCounts extends Record<string, number> {
  success: number;
  failure: number;
  advantage: number;
  threat: number;
  triumph: number;
  despair: number;
  light: number;
  dark: number;
}

export interface AddedResult {
  type?: string;
  symbol?: string;
  value?: number;
  negative?: boolean;
}

export interface RollSummary {
  system: string;
  formula: string;
  total: number | null;
  summary: string;
  ffg: FfgCounts | null;
  warnings: string[];
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function asNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function normalizeFfg(raw: unknown): FfgCounts | null {
  if (!isRecord(raw)) return null;
  const keys: Array<keyof FfgCounts> = [
    "success",
    "failure",
    "advantage",
    "threat",
    "triumph",
    "despair",
    "light",
    "dark"
  ];
  const out = {} as FfgCounts;
  for (const key of keys) {
    const value = asNumber(raw[key]);
    out[key] = value == null ? 0 : Math.trunc(value);
  }
  return out;
}

function plural(count: number, singular: string, pluralForm: string): string {
  return `${count} ${Math.abs(count) === 1 ? singular : pluralForm}`;
}

/** Deterministic FFG narrative-dice summary. Numeric total is never the outcome. */
export function formatFfg(counts: FfgCounts, added: AddedResult[] = []): string {
  const parts: string[] = [];
  if (counts.success !== 0) parts.push(plural(counts.success, "Success", "Successes"));
  if (counts.failure !== 0) parts.push(plural(counts.failure, "Failure", "Failures"));
  if (counts.advantage !== 0) parts.push(plural(counts.advantage, "Advantage", "Advantages"));
  if (counts.threat !== 0) parts.push(plural(counts.threat, "Threat", "Threats"));
  if (counts.triumph !== 0) parts.push(plural(counts.triumph, "Triumph", "Triumphs"));
  if (counts.despair !== 0) parts.push(plural(counts.despair, "Despair", "Despairs"));
  if (counts.light !== 0) parts.push(plural(counts.light, "Light", "Light"));
  if (counts.dark !== 0) parts.push(plural(counts.dark, "Dark", "Dark"));

  if (parts.length === 0) parts.push("No net symbols");
  const base = parts.join(", ");

  const extras: string[] = [];
  for (const item of added) {
    const symbol = asString(item.symbol) ?? asString(item.type);
    const value = asNumber(item.value);
    if (!symbol || value == null || value === 0) continue;
    const signed = item.negative ? -Math.abs(value) : value;
    extras.push(`${signed > 0 ? "+" : ""}${signed} ${symbol}`);
  }
  return extras.length > 0 ? `${base} (added ${extras.join(", ")})` : base;
}

function rollClass(roll: Record<string, unknown>): string {
  return asString(roll.class) ?? asString(roll.type) ?? "Roll";
}

/**
 * Summarize a foundry Roll JSON object for the active system. Raw JSON is always
 * preserved by the caller. FFG detection also works when the system id is unknown.
 */
export function summarizeRoll(raw: unknown, systemId: string): RollSummary {
  if (typeof raw === "string") {
    try {
      return summarizeRoll(JSON.parse(raw), systemId);
    } catch {
      return {
        system: systemId,
        formula: "",
        total: null,
        summary: "Unparseable roll JSON",
        ffg: null,
        warnings: ["roll_json_invalid"]
      };
    }
  }
  if (!isRecord(raw)) {
    return { system: systemId, formula: "", total: null, summary: "No roll data", ffg: null, warnings: ["roll_invalid"] };
  }

  const formula = asString(raw.formula) ?? "";
  const total = asNumber(raw.total);
  const ffgRaw = normalizeFfg(raw.ffg);
  const isFfg =
    ffgRaw !== null ||
    rollClass(raw).toLowerCase().includes("ffg") ||
    systemId.toLowerCase().includes("starwars");

  if (isFfg) {
    const warnings: string[] = [];
    if (!ffgRaw) warnings.push("ffg_missing");
    const added = Array.isArray(raw.addedResults)
      ? raw.addedResults.filter(isRecord).map((item) => ({
          type: asString(item.type) ?? undefined,
          symbol: asString(item.symbol) ?? undefined,
          value: asNumber(item.value) ?? undefined,
          negative: item.negative === true
        }))
      : [];
    const summary = ffgRaw
      ? formatFfg(ffgRaw, added)
      : formula
        ? `${formula} (symbols unavailable)`
        : "FFG roll (symbols unavailable)";
    return {
      system: systemId,
      formula,
      total,
      summary,
      ffg: ffgRaw,
      warnings
    };
  }

  const label = asString(raw.flavorText) ?? asString(raw.data && isRecord(raw.data) ? raw.data.name : null);
  const summary =
    total != null
      ? `${total}${formula ? ` (${formula})` : ""}${label ? ` — ${label}` : ""}`
      : formula || "Roll";
  return { system: systemId, formula, total, summary, ffg: null, warnings: [] };
}

export function summarizeEvent(event: FoundryEvent): RollSummary[] {
  return event.rolls.map((roll) => summarizeRoll(roll, event.system));
}

export function firstRollSummary(event: FoundryEvent): string {
  const summaries = summarizeEvent(event);
  if (summaries.length === 0) return "";
  return summaries.map((summary) => summary.summary).join("; ");
}
