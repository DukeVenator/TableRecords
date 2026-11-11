import path from "node:path";
import type {
  FoundryEvent,
  Marker,
  PeopleFile,
  Person,
  SessionRecord,
  TimelineActor,
  TimelineEvent,
  TranscriptRecord,
  VoiceContextLine
} from "./types.js";
import { readJsonl, readJson, writeJsonl } from "./paths.js";
import { firstRollSummary, summarizeRoll, type FfgCounts } from "./foundry/adapters.js";
import { detectSpokenMentalNote } from "./notes.js";
import { stitchTranscripts } from "./transcript.js";
import { personIsOptedOut } from "./consent.js";

export const EXCLUDED_TRANSCRIPT_FLAGS = new Set([
  "empty",
  "no_speech",
  "repetitive",
  "filler",
  "short_low_confidence",
  "boilerplate",
  "timestamp_suspicious"
]);

const TYPE_PRIORITY: Record<TimelineEvent["type"], number> = {
  marker: 0,
  roll: 1,
  speech: 2,
  chat: 3
};

export interface MergeResult {
  timeline: TimelineEvent[];
  counts: {
    speech: number;
    roll: number;
    chat: number;
    marker: number;
    mentalNotes: number;
    rollsWithVoiceContext: number;
    excludedTranscripts: number;
    optedOutTranscripts: number;
    foundryEvents: number;
  };
  warnings: string[];
}

function actorForSpeech(person: Person | undefined, transcript: TranscriptRecord): TimelineActor {
  return {
    discordUserId: transcript.discordUserId,
    foundryUserId: person?.foundryUserId ?? null,
    name: person?.discordName ?? transcript.speaker ?? `Unknown (${transcript.discordUserId})`,
    character: person?.character ?? transcript.character ?? null,
    role: person?.role ?? "player"
  };
}

function findPersonByFoundryId(people: Person[], foundryUserId: string | null): Person | undefined {
  if (!foundryUserId) return undefined;
  return people.find((person) => person.foundryUserId === foundryUserId);
}

function findPersonByDiscordId(people: Person[], discordUserId: string | null): Person | undefined {
  if (!discordUserId) return undefined;
  return people.find((person) => person.discordUserId === discordUserId);
}

function actorForFoundry(event: FoundryEvent, people: Person[]): TimelineActor {
  const person = findPersonByFoundryId(people, event.author.id);
  const name = event.author.name ?? event.speaker.alias ?? event.speaker.actorName ?? "Unknown";
  return {
    discordUserId: person?.discordUserId ?? null,
    foundryUserId: event.author.id ?? person?.foundryUserId ?? null,
    name,
    character: event.speaker.actorName ?? event.speaker.alias ?? person?.character ?? null,
    role: person?.role ?? "player"
  };
}

function aggregateFfg(rolls: unknown[]): FfgCounts | null {
  let total: FfgCounts | null = null;
  for (const roll of rolls) {
    const summary = summarizeRoll(roll, "");
    if (!summary.ffg) continue;
    if (!total) {
      total = { ...summary.ffg };
    } else {
      for (const key of Object.keys(total) as Array<keyof FfgCounts>) {
        total[key] = (total[key] ?? 0) + (summary.ffg[key] ?? 0);
      }
    }
  }
  return total;
}

function buildRoll(event: FoundryEvent): NonNullable<TimelineEvent["roll"]> {  const summaries = event.rolls.map((roll) => summarizeRoll(roll, event.system));
  const ffg = aggregateFfg(event.rolls);
  return {
    system: event.system,
    formula: summaries.map((item) => item.formula).filter(Boolean).join(" | "),
    summary: summaries.length ? summaries.map((item) => item.summary).join("; ") : firstRollSummary(event),
    total: summaries.length === 1 ? summaries[0]!.total : null,
    ffg: ffg ?? undefined,
    raw: event.rolls[0] ?? null,
    rolls: summaries.map((item, index) => ({
      formula: item.formula,
      total: item.total,
      summary: item.summary,
      ffg: item.ffg,
      raw: event.rolls[index] ?? null
    }))
  };
}

function buildVoiceContext(
  rollTsMs: number,
  speechEvents: TimelineEvent[],
  beforeMs: number,
  afterMs: number
): NonNullable<NonNullable<TimelineEvent["roll"]>["voiceContext"]> {
  const toLine = (event: TimelineEvent): VoiceContextLine => ({
    utteranceId: event.speech?.utteranceId ?? event.sourceId,
    tsMs: event.tsMs,
    endMs: event.speech?.endMs ?? event.tsMs,
    speaker: event.actor?.name ?? "Unknown",
    character: event.actor?.character ?? null,
    text: event.text ?? ""
  });
  const before = speechEvents
    .filter((event) => event.tsMs <= rollTsMs && rollTsMs - event.tsMs <= beforeMs)
    .sort((a, b) => b.tsMs - a.tsMs)
    .slice(0, 3)
    .reverse()
    .map(toLine);
  const after = speechEvents
    .filter((event) => event.tsMs > rollTsMs && event.tsMs - rollTsMs <= afterMs)
    .sort((a, b) => a.tsMs - b.tsMs)
    .slice(0, 3)
    .map(toLine);

  const gaps: number[] = [];
  const lastBefore = before.at(-1);
  if (lastBefore) gaps.push(Math.max(0, rollTsMs - lastBefore.endMs));
  const firstAfter = after[0];
  if (firstAfter) gaps.push(Math.max(0, firstAfter.tsMs - rollTsMs));
  const nearestSpeechGapMs = gaps.length ? Math.min(...gaps) : null;
  const confidence: "high" | "medium" | "low" | "none" =
    nearestSpeechGapMs == null
      ? "none"
      : nearestSpeechGapMs <= 3_000
        ? "high"
        : nearestSpeechGapMs <= 10_000
          ? "medium"
          : "low";
  return { beforeMs, afterMs, before, after, nearestSpeechGapMs, confidence };
}

export function mergeRecords(
  session: SessionRecord,
  people: Person[],
  transcripts: TranscriptRecord[],
  foundryEvents: FoundryEvent[],
  markers: Marker[]
): MergeResult {
  const events: TimelineEvent[] = [];
  const warnings: string[] = [];
  let excludedTranscripts = 0;
  let optedOutTranscripts = 0;
  const optedOutDiscordIds = new Set(
    people.filter(personIsOptedOut).map((person) => person.discordUserId).filter((id): id is string => Boolean(id))
  );
  const marginMs = Math.max(0, Math.trunc(session.merge?.filterMarginMs ?? 300_000));
  const inSessionWindow = (tsMs: number): boolean => {
    if (session.startedAtMs == null || session.stoppedAtMs == null) return true;
    return tsMs >= session.startedAtMs - marginMs && tsMs <= session.stoppedAtMs + marginMs;
  };

  const latestTranscripts = new Map<string, TranscriptRecord>();
  for (const transcript of transcripts) {
    if (!transcript || transcript.schema !== "tablerecords.transcript/v1" || !transcript.utteranceId) {
      warnings.push("Ignored a transcript record with an invalid schema or utterance id.");
      continue;
    }
    latestTranscripts.set(transcript.utteranceId, transcript);
  }

  const latestFoundry = new Map<string, FoundryEvent>();
  for (const event of foundryEvents) {
    if (!event || event.schema !== "tablerecords.foundry-event/v1" || !event.eventId) continue;
    latestFoundry.set(event.eventId, event);
  }

  // Gap joining is a merge concern, not just a capture concern: it also fixes
  // sessions recorded before the capture window was widened. A roll or marker
  // inside the pause breaks the join so a roll cannot swallow the reaction on
  // either side of it.
  const eligibleTranscripts = [...latestTranscripts.values()].filter((transcript) => {
    if (optedOutDiscordIds.has(transcript.discordUserId)) {
      optedOutTranscripts += 1;
      return false;
    }
    return true;
  });
  const stitched = stitchTranscripts(eligibleTranscripts, {
    gapMs: session.merge?.stitchGapMs ?? 2000,
    blockers: [
      ...[...latestFoundry.values()].filter((event) => event.type === "roll").map((event) => ({ tsMs: event.timestampMs })),
      ...markers.filter((marker) => marker?.schema === "tablerecords.marker/v1").map((marker) => ({ tsMs: marker.tsMs }))
    ]
  });

  for (const transcript of stitched) {
    const flags = Array.isArray(transcript.flags) ? transcript.flags : [];
    if (flags.some((flag) => EXCLUDED_TRANSCRIPT_FLAGS.has(flag))) {
      excludedTranscripts += 1;
      continue;
    }
    if (!transcript.text?.trim()) {
      excludedTranscripts += 1;
      continue;
    }
    if (!inSessionWindow(transcript.startMs)) {
      excludedTranscripts += 1;
      warnings.push(`Excluded transcript ${transcript.utteranceId} outside the session window.`);
      continue;
    }
    const person = findPersonByDiscordId(people, transcript.discordUserId);
    const noteText = detectSpokenMentalNote(transcript.text);
    events.push({
      schema: "tablerecords.timeline/v1",
      sessionId: session.sessionId,
      seq: 0,
      tsMs: Math.trunc(transcript.startMs),
      type: "speech",
      sourceId: transcript.utteranceId,
      actor: actorForSpeech(person, transcript),
      text: transcript.text.trim(),
      mentalNote: noteText
        ? {
            text: noteText,
            source: "spoken",
            speaker: transcript.speaker,
            character: transcript.character
          }
        : undefined,
      speech: {
        utteranceId: transcript.utteranceId,
        endMs: Math.trunc(transcript.endMs),
        flags
      },
      source: "transcript"
    });
  }

  for (const event of latestFoundry.values()) {
    const actor = actorForFoundry(event, people);
    if (event.type === "roll" && event.rolls.length > 0) {
      events.push({
        schema: "tablerecords.timeline/v1",
        sessionId: session.sessionId,
        seq: 0,
        tsMs: Math.trunc(event.timestampMs),
        type: "roll",
        sourceId: event.eventId,
        actor,
        text: event.contentText || event.flavor || "",
        roll: buildRoll(event),
        source: "foundry"
      });
    } else {
      events.push({
        schema: "tablerecords.timeline/v1",
        sessionId: session.sessionId,
        seq: 0,
        tsMs: Math.trunc(event.timestampMs),
        type: "chat",
        sourceId: event.eventId,
        actor,
        text: event.contentText || event.flavor || "",
        chat: {
          contentText: event.contentText,
          whisper: event.visibility.whisper,
          blind: event.visibility.blind
        },
        source: "foundry"
      });
    }
  }

  for (const marker of markers) {
    if (!marker || marker.schema !== "tablerecords.marker/v1" || !marker.markerId) continue;
    events.push({
      schema: "tablerecords.timeline/v1",
      sessionId: session.sessionId,
      seq: 0,
      tsMs: Math.trunc(marker.tsMs),
      type: "marker",
      sourceId: marker.markerId,
      text: marker.label,
      mentalNote: marker.mentalNote
        ? {
            text: marker.label || "Mental note",
            source: "manual",
            markerId: marker.markerId
          }
        : undefined,
      marker: { kind: marker.kind, label: marker.label, mentalNote: marker.mentalNote },
      source: "marker"
    });
  }

  const speechEvents = events.filter((event) => event.type === "speech");
  const beforeMs = Math.max(0, Math.trunc(session.merge?.rollContextBeforeMs ?? 20_000));
  const afterMs = Math.max(0, Math.trunc(session.merge?.rollContextAfterMs ?? 10_000));
  for (const event of events) {
    if (event.type !== "roll" || !event.roll) continue;
    event.roll.voiceContext = buildVoiceContext(event.tsMs, speechEvents, beforeMs, afterMs);
  }

  events.sort(
    (a, b) => a.tsMs - b.tsMs || TYPE_PRIORITY[a.type] - TYPE_PRIORITY[b.type] || a.sourceId.localeCompare(b.sourceId)
  );
  events.forEach((event, index) => {
    event.seq = index + 1;
  });

  return {
    timeline: events,
    counts: {
      speech: events.filter((event) => event.type === "speech").length,
      roll: events.filter((event) => event.type === "roll").length,
      chat: events.filter((event) => event.type === "chat").length,
      marker: events.filter((event) => event.type === "marker").length,
      mentalNotes: events.filter((event) => event.mentalNote).length,
      rollsWithVoiceContext: events.filter(
        (event) => event.type === "roll" && (event.roll?.voiceContext?.before.length ?? 0) + (event.roll?.voiceContext?.after.length ?? 0) > 0
      ).length,
      excludedTranscripts,
      optedOutTranscripts,
      foundryEvents: latestFoundry.size
    },
    warnings
  };
}

export async function mergeSession(sessionDir: string, session: SessionRecord): Promise<MergeResult> {
  const transcript = await readJsonl<TranscriptRecord>(path.join(sessionDir, "stt", "transcript.jsonl"));
  const foundry = await readJsonl<FoundryEvent>(path.join(sessionDir, "foundry", "events.jsonl"));
  const live = await readJsonl<FoundryEvent>(path.join(sessionDir, "foundry", "live-events.jsonl"));
  const markerRead = await readJsonl<Marker>(path.join(sessionDir, "markers.jsonl"));
  const peopleFile = await readJson<PeopleFile>(path.join(sessionDir, "people.json"));
  const people = peopleFile?.people ?? [];

  const result = mergeRecords(session, people, transcript.items, [...foundry.items, ...live.items], markerRead.items);
  result.warnings.push(
    ...transcript.errors.map((error) => `transcript.jsonl line ${error.line}: ${error.message}`),
    ...foundry.errors.map((error) => `events.jsonl line ${error.line}: ${error.message}`),
    ...live.errors.map((error) => `live-events.jsonl line ${error.line}: ${error.message}`),
    ...markerRead.errors.map((error) => `markers.jsonl line ${error.line}: ${error.message}`)
  );
  await writeJsonl(path.join(sessionDir, "merged", "timeline.jsonl"), result.timeline);
  return result;
}
