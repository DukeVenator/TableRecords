import path from "node:path";
import type {
  FoundryEvent,
  FoundryExport,
  FoundryImportSummary,
  FoundryMessage,
  SessionRecord,
  SystemRef,
  WorldRef
} from "../types.js";
import { htmlToText } from "../text.js";
import { asNumber, asString, isRecord } from "./adapters.js";
import { writeFileAtomic, writeJsonAtomic, writeJsonl } from "../paths.js";

export class FoundryImportError extends Error {
  override name = "FoundryImportError";
  readonly code: string;
  readonly statusCode = 400;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export interface BuiltFoundryImport {
  export: FoundryExport;
  events: FoundryEvent[];
  summary: FoundryImportSummary;
}

function parseWorld(value: unknown): WorldRef {
  if (!isRecord(value) || !asString(value.id)) {
    throw new FoundryImportError("invalid_world", "Export is missing world.id");
  }
  return { id: asString(value.id)!, title: asString(value.title) ?? asString(value.id)! };
}

function parseSystem(value: unknown): SystemRef {
  if (!isRecord(value) || !asString(value.id)) {
    throw new FoundryImportError("invalid_system", "Export is missing system.id");
  }
  return { id: asString(value.id)!, version: asString(value.version) };
}

function normalizeRolls(value: unknown, warnings: Array<{ code: string; message: string }>, messageId: string): unknown[] {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    warnings.push({ code: "rolls_invalid", message: `Message ${messageId} has a non-array rolls field; ignored.` });
    return [];
  }
  const out: unknown[] = [];
  for (const roll of value) {
    if (typeof roll === "string") {
      try {
        out.push(JSON.parse(roll));
        warnings.push({
          code: "roll_string_parsed",
          message: `Message ${messageId} contained a serialized roll string; parsed for compatibility.`
        });
      } catch {
        warnings.push({
          code: "roll_string_invalid",
          message: `Message ${messageId} contained an unparseable roll string; preserved raw data was dropped.`
        });
      }
      continue;
    }
    if (isRecord(roll)) out.push(roll);
  }
  return out;
}

/** Validate and normalize a macro export. Pure: no filesystem writes. */
export function buildFoundryImport(rawText: string, session: SessionRecord, importedAtMs = Date.now()): BuiltFoundryImport {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText.replace(/^\uFEFF/, ""));
  } catch (error) {
    throw new FoundryImportError("invalid_json", `Uploaded file is not valid JSON: ${(error as Error).message}`);
  }
  if (!isRecord(parsed)) throw new FoundryImportError("invalid_export", "Export root must be a JSON object");
  if (parsed.schema !== "tablerecords.foundry-export/v1") {
    throw new FoundryImportError(
      "unsupported_schema",
      `Unsupported export schema ${String(parsed.schema)}; expected tablerecords.foundry-export/v1`
    );
  }
  if (!Array.isArray(parsed.messages)) {
    throw new FoundryImportError("invalid_messages", "Export must contain a messages array");
  }

  const world = parseWorld(parsed.world);
  const system = parseSystem(parsed.system);
  const warnings: Array<{ code: string; message: string }> = [];
  if (Array.isArray(parsed.warnings)) {
    for (const warning of parsed.warnings) {
      if (!isRecord(warning)) continue;
      warnings.push({
        code: asString(warning.code) ?? "export_warning",
        message: asString(warning.message) ?? "Export warning"
      });
    }
  }

  const messages: FoundryMessage[] = [];
  const normalizedMessages: Array<{ message: FoundryMessage; rolls: unknown[] }> = [];
  for (let index = 0; index < parsed.messages.length; index += 1) {
    const raw = parsed.messages[index];
    if (!isRecord(raw)) {
      warnings.push({ code: "message_invalid", message: `Message at index ${index} is not an object; skipped.` });
      continue;
    }
    const messageId = asString(raw.messageId);
    if (!messageId) {
      warnings.push({ code: "message_id_missing", message: `Message at index ${index} has no messageId; skipped.` });
      continue;
    }
    const timestampMs = asNumber(raw.timestampMs);
    if (timestampMs == null) {
      warnings.push({
        code: "timestamp_invalid",
        message: `Message ${messageId} has no numeric timestampMs; skipped (timestamps are never guessed).`
      });
      continue;
    }
    if (raw.rollParseError) {
      warnings.push({
        code: "roll_parse_error",
        message: `Message ${messageId}: ${String(raw.rollParseError)}`
      });
    }
    const rolls = normalizeRolls(raw.rolls, warnings, messageId);
    const message: FoundryMessage = {
      ...raw,
      messageId,
      timestampMs,
      rolls,
      author: isRecord(raw.author)
        ? { id: asString(raw.author.id), name: asString(raw.author.name) }
        : { id: null, name: null },
      speaker: isRecord(raw.speaker)
        ? {
            scene: asString(raw.speaker.scene),
            token: asString(raw.speaker.token),
            actor: asString(raw.speaker.actor),
            alias: asString(raw.speaker.alias)
          }
        : {},
      whisper: Array.isArray(raw.whisper) ? raw.whisper.filter((id): id is string => typeof id === "string") : [],
      blind: raw.blind === true
    };
    messages.push(message);
    normalizedMessages.push({ message, rolls });
  }

  const startedAtMs = asNumber(session.startedAtMs);
  const stoppedAtMs = asNumber(session.stoppedAtMs);
  const marginMs = Math.max(0, Math.trunc(session.merge?.filterMarginMs ?? 300_000));
  const windowed = startedAtMs != null && stoppedAtMs != null;
  if (!windowed) {
    warnings.push({
      code: "no_session_window",
      message: "Session has no start/stop times; all exported messages were included."
    });
  }
  const windowStart = windowed ? startedAtMs! - marginMs : null;
  const windowEnd = windowed ? stoppedAtMs! + marginMs : null;

  const eventById = new Map<string, FoundryEvent>();
  let outOfWindowCount = 0;
  for (const { message, rolls } of normalizedMessages) {
    if (windowStart != null && windowEnd != null) {
      if (message.timestampMs < windowStart || message.timestampMs > windowEnd) {
        outOfWindowCount += 1;
        continue;
      }
    }
    const speaker = message.speaker ?? {};
    const event: FoundryEvent = {
      schema: "tablerecords.foundry-event/v1",
      sessionId: session.sessionId,
      eventId: message.messageId,
      type: rolls.length > 0 ? "roll" : "chat",
      timestampMs: message.timestampMs,
      author: {
        id: message.author?.id ?? null,
        name: message.author?.name ?? null
      },
      speaker: {
        alias: asString(message.speakerName) ?? speaker.alias ?? null,
        actorId: asString(message.actorId) ?? speaker.actor ?? null,
        actorName: asString(message.actorName) ?? null,
        tokenName: asString(message.tokenName) ?? null
      },
      system: system.id,
      systemVersion: system.version,
      flavor: asString(message.flavor),
      contentText: htmlToText(message.content),
      visibility: { whisper: message.whisper ?? [], blind: message.blind === true },
      flags: message.flags ?? {},
      rolls,
      source: { kind: "macro", file: "foundry/export.json" }
    };
    eventById.set(event.eventId, event);
  }

  const events = [...eventById.values()];
  if (outOfWindowCount > 0) {
    warnings.push({
      code: "outside_window",
      message: `${outOfWindowCount} message(s) outside the session window (${marginMs} ms margin) were excluded.`
    });
  }

  const rollMessageCount = events.filter((event) => event.rolls.length > 0).length;
  const rollCount = events.reduce((sum, event) => sum + event.rolls.length, 0);
  const timestamps = events.map((event) => event.timestampMs);
  const summary: FoundryImportSummary = {
    schema: "tablerecords.foundry-import-summary/v1",
    sessionId: session.sessionId,
    importedAtMs,
    sourceFile: "foundry/export.json",
    foundryVersion: asString(parsed.foundryVersion),
    world,
    system,
    messageCount: events.length,
    rollMessageCount,
    rollCount,
    firstTimestampMs: timestamps.length ? Math.min(...timestamps) : null,
    lastTimestampMs: timestamps.length ? Math.max(...timestamps) : null,
    outOfWindowCount,
    warnings
  };

  const exportFile: FoundryExport = {
    schema: "tablerecords.foundry-export/v1",
    exportedAtMs: asNumber(parsed.exportedAtMs) ?? importedAtMs,
    exportedBy: isRecord(parsed.exportedBy)
      ? { id: asString(parsed.exportedBy.id), name: asString(parsed.exportedBy.name) }
      : undefined,
    foundryVersion: asString(parsed.foundryVersion),
    world,
    system,
    messages,
    warnings: Array.isArray(parsed.warnings) ? (parsed.warnings as FoundryExport["warnings"]) : []
  };

  return { export: exportFile, events, summary };
}

export async function importFoundryExport(params: {
  sessionDir: string;
  session: SessionRecord;
  rawText: string;
  importedAtMs?: number;
}): Promise<FoundryImportSummary> {
  const built = buildFoundryImport(params.rawText, params.session, params.importedAtMs);
  const foundryDir = path.join(params.sessionDir, "foundry");
  await writeFileAtomic(path.join(foundryDir, "export.json"), params.rawText.endsWith("\n") ? params.rawText : `${params.rawText}\n`);
  await writeJsonl(path.join(foundryDir, "events.jsonl"), built.events);
  await writeJsonAtomic(path.join(foundryDir, "import-summary.json"), built.summary);
  return built.summary;
}
