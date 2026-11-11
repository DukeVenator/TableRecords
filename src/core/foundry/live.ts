import type {
  FoundryEvent,
  FoundryLiveRoster,
  FoundryMessage,
  SessionRecord,
  SystemRef,
  WorldRef
} from "../types.js";
import { htmlToText } from "../text.js";
import { asNumber, asString, isRecord } from "./adapters.js";

export interface LiveMessageResult {
  events: FoundryEvent[];
  skipped: number;
  warnings: string[];
}

function normalizeRolls(value: unknown, messageId: string, warnings: string[]): unknown[] {
  if (!Array.isArray(value)) {
    warnings.push(`Message ${messageId} has a non-array rolls field; ignored.`);
    return [];
  }
  const out: unknown[] = [];
  for (const roll of value) {
    if (isRecord(roll)) {
      out.push(roll);
      continue;
    }
    if (typeof roll === "string") {
      try {
        const parsed = JSON.parse(roll) as unknown;
        if (isRecord(parsed)) out.push(parsed);
      } catch {
        warnings.push(`Message ${messageId} contained an unparseable serialized roll; dropped.`);
      }
    }
  }
  return out;
}

function normalizeMessage(raw: unknown): FoundryMessage | null {
  if (!isRecord(raw)) return null;
  const messageId = asString(raw.messageId);
  const timestampMs = asNumber(raw.timestampMs);
  if (!messageId || timestampMs == null) return null;
  return {
    ...raw,
    messageId,
    timestampMs,
    author: isRecord(raw.author) ? { id: asString(raw.author.id), name: asString(raw.author.name) } : { id: null, name: null },
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
}

/**
 * Convert live module messages into canonical Foundry events. Live play is
 * messy, so one bad message gets skipped and reported instead of rejecting the
 * whole batch.
 */
export function buildLiveFoundryEvents(params: {
  messages: unknown[];
  session: SessionRecord;
  world: WorldRef;
  system: SystemRef;
  foundryVersion: string | null;
}): LiveMessageResult {
  const events: FoundryEvent[] = [];
  const warnings: string[] = [];
  let skipped = 0;
  const seen = new Set<string>();
  const marginMs = Math.max(0, Math.trunc(params.session.merge?.filterMarginMs ?? 300_000));
  const windowed = params.session.startedAtMs != null && params.session.stoppedAtMs != null;
  const windowStart = windowed ? params.session.startedAtMs! - marginMs : null;
  const windowEnd = windowed ? params.session.stoppedAtMs! + marginMs : null;
  for (const raw of params.messages) {
    const message = normalizeMessage(raw);
    if (!message) {
      skipped += 1;
      continue;
    }
    if (seen.has(message.messageId)) {
      skipped += 1;
      continue;
    }
    if (windowStart != null && windowEnd != null && (message.timestampMs < windowStart || message.timestampMs > windowEnd)) {
      skipped += 1;
      continue;
    }
    seen.add(message.messageId);
    let rolls = normalizeRolls(message.rolls, message.messageId, warnings);
    if (rolls.length === 0 && Array.isArray(message.rollsRaw)) {
      rolls = normalizeRolls(message.rollsRaw, message.messageId, warnings);
    }
    const speaker = message.speaker ?? {};
    const event: FoundryEvent = {
      schema: "tablerecords.foundry-event/v1",
      sessionId: params.session.sessionId,
      eventId: message.messageId,
      type: rolls.length > 0 ? "roll" : "chat",
      timestampMs: message.timestampMs,
      author: { id: message.author?.id ?? null, name: message.author?.name ?? null },
      speaker: {
        alias: asString(message.speakerName) ?? speaker.alias ?? null,
        actorId: asString(message.actorId) ?? speaker.actor ?? null,
        actorName: asString(message.actorName) ?? null,
        tokenName: asString(message.tokenName) ?? null
      },
      system: params.system.id,
      systemVersion: params.system.version,
      flavor: asString(message.flavor),
      contentText: htmlToText(message.content),
      visibility: { whisper: message.whisper ?? [], blind: message.blind === true },
      flags: isRecord(message.flags) ? message.flags : {},
      rolls,
      source: { kind: "module", file: "foundry/live-events.jsonl" }
    };
    events.push(event);
  }
  return { events, skipped, warnings };
}

export interface LiveBreakEvent {
  eventId: string;
  kind: "break";
  phase: "start" | "end";
  atMs: number;
  actorName: string | null;
  label: string | null;
  startedAtMs: number | null;
}

export interface LiveBreakEventResult {
  events: LiveBreakEvent[];
  skipped: number;
}

function breakPhase(value: unknown): "start" | "end" | null {
  const phase = asString(value)?.toLowerCase();
  if (phase === "start" || phase === "begin" || phase === "started") return "start";
  if (phase === "end" || phase === "over" || phase === "ended" || phase === "stop") return "end";
  return null;
}

/** Normalize the small event queue the live module sends alongside chat. */
export function normalizeLiveBreakEvents(value: unknown[]): LiveBreakEventResult {
  const events: LiveBreakEvent[] = [];
  let skipped = 0;
  for (const raw of value) {
    if (!isRecord(raw) || asString(raw.kind) !== "break") {
      skipped += 1;
      continue;
    }
    const phase = breakPhase(raw.phase);
    if (!phase) {
      skipped += 1;
      continue;
    }
    const atMs = asNumber(raw.atMs) ?? Date.now();
    const actor = isRecord(raw.actor) ? asString(raw.actor.name) : asString(raw.actorName);
    const label = asString(raw.label)?.slice(0, 200) ?? null;
    events.push({
      eventId: asString(raw.eventId) ?? `break-${phase}-${atMs}-${events.length}`,
      kind: "break",
      phase,
      atMs,
      actorName: actor,
      label,
      startedAtMs: asNumber(raw.startedAtMs)
    });
  }
  return { events, skipped };
}

export function formatBreakLength(durationMs: number): string {
  const minutes = Math.max(0, Math.round(durationMs / 60_000));
  if (minutes < 1) return "less than a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest > 0 ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

export function breakMarkerLabel(event: LiveBreakEvent, openStartMs: number | null): string {
  const who = event.actorName ? ` by ${event.actorName}` : "";
  const note = event.label ? ` — ${event.label}` : "";
  if (event.phase === "start") return `Break time called${who}${note}`;
  const startMs = openStartMs ?? event.startedAtMs;
  const length = startMs != null && event.atMs > startMs ? ` after ${formatBreakLength(event.atMs - startMs)}` : "";
  return `Break time over${length}${note}`;
}

export function normalizeLiveRoster(value: unknown): FoundryLiveRoster | null {
  if (!isRecord(value)) return null;
  const users = Array.isArray(value.users)
    ? value.users
        .filter(isRecord)
        .map((user) => ({
          id: asString(user.id),
          name: asString(user.name),
          isGM: user.isGM === true,
          characterId: asString(user.characterId),
          characterName: asString(user.characterName)
        }))
        .filter((user): user is { id: string; name: string; isGM: boolean; characterId: string | null; characterName: string | null } => Boolean(user.id && user.name))
        .slice(0, 200)
    : [];
  const actors = Array.isArray(value.actors)
    ? value.actors
        .filter(isRecord)
        .map((actor) => ({
          id: asString(actor.id),
          name: asString(actor.name),
          type: asString(actor.type) ?? "character",
          hasPlayerOwner: actor.hasPlayerOwner === true
        }))
        .filter((actor): actor is { id: string; name: string; type: string; hasPlayerOwner: boolean } => Boolean(actor.id && actor.name))
        .slice(0, 500)
    : [];
  return users.length || actors.length ? { users, actors } : null;
}

export function normalizeLiveState(value: unknown): {
  scene: { id: string | null; name: string | null } | null;
  combat: { id: string; name: string; round: number | null; active: boolean } | null;
  paused: boolean;
  userId: string | null;
  userName: string | null;
} | null {
  if (!isRecord(value)) return null;
  const scene = isRecord(value.scene)
    ? { id: asString(value.scene.id), name: asString(value.scene.name) }
    : null;
  const combat = isRecord(value.combat)
    ? {
        id: asString(value.combat.id) ?? "",
        name: asString(value.combat.name) ?? "Combat",
        round: asNumber(value.combat.round),
        active: value.combat.active !== false
      }
    : null;
  return {
    scene,
    combat: combat && combat.id ? combat : null,
    paused: value.paused === true,
    userId: asString(value.userId),
    userName: asString(value.userName)
  };
}
