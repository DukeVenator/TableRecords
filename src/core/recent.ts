import type {
  FoundryEvent,
  Marker,
  Person,
  SessionRecord,
  TimelineEvent,
  TranscriptRecord
} from "./types.js";
import { mergeRecords } from "./merge.js";
import { formatClock, formatLocalDateTime } from "./render.js";
import { markdownCell } from "./text.js";
import { consentMethodLabel, displayPerson, optedOutPeople } from "./consent.js";

export const RECENT_DEFAULT_SECONDS = 180;
export const RECENT_MIN_SECONDS = 15;
export const RECENT_MAX_SECONDS = 1800;

export interface RecentContextInput {
  session: SessionRecord;
  people: Person[];
  transcripts: TranscriptRecord[];
  foundryEvents: FoundryEvent[];
  markers: Marker[];
  windowSeconds?: number;
  endMs?: number;
  windowStartMs?: number;
  windowEndMs?: number;
  windowLabel?: string;
  generatedAtMs?: number;
  transcription?: RecentTranscriptionInfo;
  /** Long-session summaries append notes separately so they are not duplicated in every portion. */
  includeSessionNotes?: boolean;
}

export interface RecentTranscriptionInfo {
  requested: boolean;
  candidates: number;
  transcribed: number;
  alreadyPresent: number;
  failed: number;
  skippedSilent?: number;
  skippedOptOut?: number;
  skippedReason?: string;
  errors: string[];
}

export interface RecentContextResult {
  schema: "tablerecords.recent-context/v1";
  sessionId: string;
  window: {
    seconds: number;
    startMs: number;
    endMs: number;
    label: string;
  };
  generatedAtMs: number;
  counts: {
    events: number;
    speech: number;
    rolls: number;
    chat: number;
    markers: number;
    mentalNotes: number;
    rollsWithVoiceContext: number;
    optedOut: number;
  };
  transcription: RecentTranscriptionInfo;
  markdown: string;
}

export function clampRecentSeconds(value: unknown, fallback = RECENT_DEFAULT_SECONDS): number {
  const parsed = typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : fallback;
  return Math.min(RECENT_MAX_SECONDS, Math.max(RECENT_MIN_SECONDS, parsed));
}

export function recentWindowLabel(seconds: number): string {
  if (seconds % 60 === 0) return `last ${seconds / 60} min`;
  return `last ${seconds}s`;
}

/**
 * The live capture window ends "now"; a finished session ends at its stop time.
 * This keeps the same button useful during play and while reviewing the tail.
 */
export function resolveRecentWindow(
  session: SessionRecord,
  seconds: number,
  nowMs = Date.now()
): { startMs: number; endMs: number; seconds: number; label: string } {
  const safeSeconds = clampRecentSeconds(seconds);
  const recording = session.status === "recording" || session.status === "joining" || session.status === "stopping";
  const endMs = recording ? nowMs : session.stoppedAtMs ?? session.startedAtMs ?? nowMs;
  return {
    startMs: endMs - safeSeconds * 1000,
    endMs,
    seconds: safeSeconds,
    label: recentWindowLabel(safeSeconds)
  };
}

function compact(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim();
}

function actorLabel(event: TimelineEvent): string {
  const name = event.actor?.name ?? "Unknown";
  const character = event.actor?.character;
  return character && character !== name ? `${markdownCell(name)} (${markdownCell(character)})` : markdownCell(name);
}

function relativeMs(deltaMs: number): string {
  const sign = deltaMs < 0 ? "-" : "+";
  const value = Math.abs(deltaMs);
  return value < 1000 ? `${sign}${value}ms` : `${sign}${(value / 1000).toFixed(1)}s`;
}

function rollHeadline(event: TimelineEvent, timeZone: string): string {
  const roll = event.roll;
  return `**[${formatClock(event.tsMs, timeZone)}] ROLL** — ${actorLabel(event)} — ${compact(event.text || event.roll?.summary) || "Roll"} — **${roll?.summary ?? "Roll"}**${roll?.formula ? ` \`${roll.formula}\`` : ""}`;
}

function rollLine(event: TimelineEvent, timeZone: string): string[] {
  const roll = event.roll;
  const lines = [`- ${rollHeadline(event, timeZone)}`];
  const context = roll?.voiceContext;
  if (context && context.before.length + context.after.length > 0) {
    const nearby = [...context.before, ...context.after]
      .sort((a, b) => a.tsMs - b.tsMs)
      .map((line) => `${relativeMs(line.tsMs - event.tsMs)} ${line.speaker}: ${compact(line.text)}`)
      .join(" | ");
    lines.push(`  - voice sync: **${context.confidence}**${context.nearestSpeechGapMs != null ? ` (${relativeMs(context.nearestSpeechGapMs)})` : ""} — ${nearby}`);
  } else {
    lines.push(`  - voice sync: **none** — no speech inside the configured roll window`);
  }
  return lines;
}

function eventLines(event: TimelineEvent, timeZone: string): string[] {
  const clock = formatClock(event.tsMs, timeZone);
  if (event.type === "marker") {
    const label = event.marker?.mentalNote ? "MENTAL NOTE" : "MARKER";
    return [`- **[${clock}] ${label}** — ${event.marker?.kind ?? "note"}${event.marker?.label ? `: ${compact(event.marker.label)}` : ""}`];
  }
  if (event.type === "speech") {
    return [`- **[${clock}] ${actorLabel(event)}:** ${compact(event.text)}${event.mentalNote ? " **[mental note]**" : ""}`];
  }
  if (event.type === "roll") return rollLine(event, timeZone);
  return [`- **[${clock}] CHAT** — ${actorLabel(event)}: ${compact(event.text)}`];
}

function peopleLines(people: Person[]): string[] {
  if (people.length === 0) return ["_No people mapping recorded._"];
  const order = { gm: 0, player: 1, observer: 2 } as const;
  return [...people]
    .sort((a, b) => order[a.role] - order[b.role] || (a.discordName ?? "").localeCompare(b.discordName ?? ""))
    .map((person) => {
      const name = person.discordName ?? person.discordUserId ?? "Unknown";
      const character = person.character ? ` as **${markdownCell(person.character)}**` : "";
      const aliases = Array.isArray(person.aliases) && person.aliases.length > 0 ? ` (aliases: ${person.aliases.map(markdownCell).join(", ")})` : "";
      return `- ${person.role.toUpperCase()}: ${markdownCell(name)}${character}${aliases}`;
    });
}

/** Pure deterministic brief designed to be copied into an external assistant. */
export function buildRecentContext(input: RecentContextInput): RecentContextResult {
  const { session, people, transcripts, foundryEvents, markers } = input;
  const explicitWindow =
    input.windowStartMs != null && input.windowEndMs != null
      ? {
          startMs: Math.min(input.windowStartMs, input.windowEndMs),
          endMs: Math.max(input.windowStartMs, input.windowEndMs),
          seconds: Math.max(0, Math.round(Math.abs(input.windowEndMs - input.windowStartMs) / 1000)),
          label: input.windowLabel ?? "selected window"
        }
      : null;
  const window = explicitWindow ?? resolveRecentWindow(session, input.windowSeconds ?? RECENT_DEFAULT_SECONDS, input.endMs);
  const generatedAtMs = input.generatedAtMs ?? Date.now();
  const sourceEvents = foundryEvents.filter((event) => {
    const bridge = event.flags?.["table-records-bridge"];
    return !(bridge && typeof bridge === "object" && (bridge as Record<string, unknown>).playerPost === true);
  });
  const merged = mergeRecords(session, people, transcripts, sourceEvents, markers);
  const inWindow = merged.timeline.filter((event) => event.tsMs >= window.startMs && event.tsMs <= window.endMs);
  const beforeWindow = merged.timeline.filter((event) => event.tsMs < window.startMs);
  const speech = inWindow.filter((event) => event.type === "speech");
  const rolls = inWindow.filter((event) => event.type === "roll");
  const chats = inWindow.filter((event) => event.type === "chat");
  const windowMarkers = inWindow.filter((event) => event.type === "marker");
  const notes = inWindow.filter((event) => event.mentalNote);
  const voiceSynced = rolls.filter((event) => {
    const context = event.roll?.voiceContext;
    return Boolean(context && context.before.length + context.after.length > 0);
  });
  const transcription = input.transcription ?? {
    requested: false,
    candidates: speech.length,
    transcribed: 0,
    alreadyPresent: speech.length,
    failed: 0,
    errors: []
  };
  const optedOut = optedOutPeople(people);

  const lastMarker = [...beforeWindow, ...windowMarkers].reverse().find((event) => event.type === "marker");
  const lastRoll = [...beforeWindow, ...inWindow].reverse().find((event) => event.type === "roll");
  const lines: string[] = [
    `# GM context: ${session.title}`,
    "",
    "_Session extract for the assistant. Facts only, with roll labels._",
    "",
    `- Session: \`${session.sessionId}\``,
    `- Game: ${session.system.id} ${session.system.version ?? ""} · world ${session.world.title} (\`${session.world.id}\`)`,
    `- Window: ${formatLocalDateTime(window.startMs, session.timeZone)} → ${formatLocalDateTime(window.endMs, session.timeZone)} (${window.label})`,
    `- Events in window: ${inWindow.length} (${speech.length} speech, ${rolls.length} rolls, ${chats.length} chat, ${windowMarkers.length} markers)`,
    `- Generated: ${formatLocalDateTime(generatedAtMs, session.timeZone)}`
  ];
  if (session.notes?.trim() && input.includeSessionNotes !== false) {
    lines.push(`- Session notes: ${compact(session.notes).slice(0, 6_000)}`);
  }
  lines.push(
    "",
    "## Cast",
    "",
    ...peopleLines(people),
    "",
    "## Recording consent",
    "",
    `- Method: ${consentMethodLabel(session)}`,
    ...(optedOut.length > 0
      ? optedOut.map((person) => `- **Not recorded:** ${displayPerson(person)} — player did not want to be recorded; their speech is absent from this brief.`)
      : ["- All mapped players are included. Consent is assumed unless a player opts out."]),
    "",
    "## Last known situation",
    "",
    `- Last marker: ${lastMarker ? `${formatClock(lastMarker.tsMs, session.timeZone)} — ${compact(lastMarker.marker?.label) || lastMarker.marker?.kind || "marker"}` : "no marker yet"}`,
    `- Latest roll: ${lastRoll ? rollHeadline(lastRoll, session.timeZone) : "no roll yet"}`,
    "",
    "## Mental notes",
    "",
    ...(notes.length > 0
      ? notes.map((event) => {
          const note = event.mentalNote!;
          const source = note.source === "manual" ? "manual marker" : "spoken";
          const who = note.speaker ? ` — ${markdownCell(note.speaker)}` : "";
          return `- **[${formatClock(event.tsMs, session.timeZone)}]** ${source}${who}: ${compact(note.text)}`;
        })
      : ["_No mental notes in this window._"]),
    "",
    "## Timeline",
    "",
    ...(inWindow.length > 0
      ? inWindow.flatMap((event) => eventLines(event, session.timeZone))
      : ["_No transcribed speech, rolls, chat, or markers in this window._"]),
    ""
  );

  if (speech.length === 0) {
    lines.push(
      "> Transcription note: no speech was available in this window. Use the dashboard's recent-context action to transcribe the captured tail first.",
      ""
    );
  }
  if (transcription.failed > 0) {
    lines.push(`> Transcription note: ${transcription.failed} utterance(s) failed. See the dashboard toast/job log for details.`, "");
  }
  if (merged.warnings.length > 0) {
    lines.push("## Warnings", "", ...merged.warnings.slice(0, 8).map((warning) => `- ${warning}`), "");
  }

  return {
    schema: "tablerecords.recent-context/v1",
    sessionId: session.sessionId,
    window,
    generatedAtMs,
    counts: {
      events: inWindow.length,
      speech: speech.length,
      rolls: rolls.length,
      chat: chats.length,
      markers: windowMarkers.length,
      mentalNotes: notes.length,
      rollsWithVoiceContext: voiceSynced.length,
      optedOut: optedOut.length
    },
    transcription,
    markdown: `${lines.join("\n").trim()}\n`
  };
}
