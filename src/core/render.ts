import path from "node:path";
import type { FfgCounts } from "./foundry/adapters.js";
import type { PeopleFile, Person, SessionRecord, TimelineEvent } from "./types.js";
import { readJson, readJsonl, writeFileAtomic } from "./paths.js";
import { csvEscape, markdownCell } from "./text.js";
import { CONSENT_NOTICE_TEXT, consentMethodLabel, displayPerson, optedOutPeople, optOutNoticeLines } from "./consent.js";

export const OUTPUT_FILES = [
  "transcript.md",
  "chronology.md",
  "rolls.csv",
  "roll-sync.md",
  "mental-notes.md",
  "stats.md",
  "notes-ready.md"
] as const;
export type OutputFile = (typeof OUTPUT_FILES)[number];

export interface RenderResult {
  files: Array<{ name: OutputFile; sizeBytes: number }>;
  eventCount: number;
}

export function formatLocalDateTime(tsMs: number, timeZone: string): string {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23"
    }).formatToParts(new Date(tsMs));
    const get = (type: string) => parts.find((part) => part.type === type)?.value ?? "00";
    return `${get("year")}-${get("month")}-${get("day")} ${get("hour")}:${get("minute")}:${get("second")}`;
  } catch {
    return new Date(tsMs).toISOString().replace("T", " ").slice(0, 19);
  }
}

export function formatClock(tsMs: number, timeZone: string): string {
  return formatLocalDateTime(tsMs, timeZone).slice(11);
}

export function formatDuration(ms: number): string {
  const safe = Math.max(0, Math.round(ms));
  const seconds = Math.floor(safe / 1000);
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}h ${m}m ${s}s`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}

function actorName(event: TimelineEvent): string {
  if (!event.actor) return "—";
  if (event.actor.character && event.actor.character !== event.actor.name) {
    return `${event.actor.name} (${event.actor.character})`;
  }
  return event.actor.name;
}

function actorCharacter(event: TimelineEvent): string {
  return event.actor?.character ?? event.actor?.name ?? "";
}

function eventLine(event: TimelineEvent, timeZone: string): string {
  const clock = formatClock(event.tsMs, timeZone);
  if (event.type === "marker") {
    const kind = event.marker?.mentalNote ? "MENTAL NOTE" : "MARKER";
    return `- **[${clock}] ${kind}** — ${event.marker?.kind ?? "note"}${event.marker?.label ? `: ${event.marker.label}` : ""}`;
  }
  if (event.type === "speech") {
    return `- **[${clock}] ${markdownCell(actorName(event))}:** ${event.text ?? ""}${event.mentalNote ? " **[mental note]**" : ""}`;
  }
  if (event.type === "roll") {
    const summary = event.roll?.summary ?? "Roll";
    const formula = event.roll?.formula ? ` \`${event.roll.formula}\`` : "";
    return `- **[${clock}] ROLL** — ${markdownCell(actorName(event))} — ${event.text || "Roll"} — **${summary}**${formula}`;
  }
  return `- **[${clock}] CHAT** — ${markdownCell(actorName(event))}: ${event.text ?? ""}`;
}

function relativeMs(deltaMs: number): string {
  const sign = deltaMs < 0 ? "-" : "+";
  const value = Math.abs(deltaMs);
  return value < 1000 ? `${sign}${value}ms` : `${sign}${(value / 1000).toFixed(1)}s`;
}

function rollRows(event: TimelineEvent): Array<{
  formula: string;
  total: number | null;
  summary: string;
  ffg: FfgCounts | null;
  raw: unknown;
}> {
  if (!event.roll) return [];
  if (Array.isArray(event.roll.rolls) && event.roll.rolls.length > 0) {
    return event.roll.rolls.map((roll) => ({
      formula: roll.formula,
      total: roll.total,
      summary: roll.summary,
      ffg: (roll.ffg as FfgCounts | null) ?? null,
      raw: roll.raw
    }));
  }
  return [
    {
      formula: event.roll.formula,
      total: event.roll.total,
      summary: event.roll.summary,
      ffg: (event.roll.ffg as FfgCounts | null) ?? null,
      raw: event.roll.raw
    }
  ];
}

export function renderTimeline(
  session: SessionRecord,
  timeline: TimelineEvent[],
  timeZone = session.timeZone,
  people: Person[] = []
): Record<OutputFile, string> {
  const title = session.title;
  const optedOut = optedOutPeople(people);
  const privacyLines = optOutNoticeLines(people);

  const transcript = [
    `# Transcript — ${title}`,
    "",
    `Session \`${session.sessionId}\` · ${timeline.filter((e) => e.type === "speech").length} utterances`,
    `- Recording consent: ${consentMethodLabel(session)}`,
    ...(optedOut.length > 0 ? ["", ...privacyLines] : []),
    "",
    ...timeline.filter((e) => e.type === "speech").map((event) => {
      const clock = formatClock(event.tsMs, timeZone);
      return `**[${clock}] ${actorName(event)}**  \n${event.text ?? ""}\n`;
    })
  ].join("\n");

  const chronology = [
    `# Chronology — ${title}`,
    "",
    `Session \`${session.sessionId}\` · ${timeline.length} events`,
    ...(optedOut.length > 0 ? ["", ...privacyLines] : []),
    "",
    ...timeline.map((event) => eventLine(event, timeZone))
  ].join("\n");

  const rollLines: string[] = [];
  for (const event of timeline) {
    const context = event.roll?.voiceContext;
    const beforeContext = context?.before
      .map((line) => `${relativeMs(line.tsMs - event.tsMs)} ${line.speaker}: ${line.text}`)
      .join(" | ") ?? "";
    const afterContext = context?.after
      .map((line) => `${relativeMs(line.tsMs - event.tsMs)} ${line.speaker}: ${line.text}`)
      .join(" | ") ?? "";
    for (const roll of rollRows(event)) {
      rollLines.push(
        [
          event.tsMs,
          formatLocalDateTime(event.tsMs, timeZone),
          actorName(event),
          actorCharacter(event),
          event.roll?.system ?? session.system.id,
          event.text ?? "",
          roll.formula,
          roll.total ?? "",
          roll.summary,
          roll.ffg?.success ?? "",
          roll.ffg?.failure ?? "",
          roll.ffg?.advantage ?? "",
          roll.ffg?.threat ?? "",
          roll.ffg?.triumph ?? "",
          roll.ffg?.despair ?? "",
          roll.ffg?.light ?? "",
          roll.ffg?.dark ?? "",
          event.sourceId,
          beforeContext,
          afterContext,
          context?.nearestSpeechGapMs ?? "",
          context?.confidence ?? "none"
        ]
          .map(csvEscape)
          .join(",")
      );
    }
  }
  const rollsCsv = [
    "timestampMs,displayTime,player,character,system,flavor,formula,total,summary,success,failure,advantage,threat,triumph,despair,light,dark,sourceMessageId,voiceBefore,voiceAfter,nearestSpeechGapMs,syncConfidence",
    ...rollLines
  ].join("\r\n");

  const speech = timeline.filter((event) => event.type === "speech");
  const totalSpeechMs = speech.reduce((sum, event) => sum + Math.max(0, (event.speech?.endMs ?? event.tsMs) - event.tsMs), 0);
  const words = speech.reduce((sum, event) => sum + (event.text?.trim().split(/\s+/).filter(Boolean).length ?? 0), 0);
  const speakers = new Map<string, { name: string; utterances: number; talkMs: number; words: number; character: string }>();
  for (const event of speech) {
    const key = event.actor?.discordUserId ?? event.actor?.name ?? "unknown";
    const current = speakers.get(key) ?? {
      name: event.actor?.name ?? "Unknown",
      utterances: 0,
      talkMs: 0,
      words: 0,
      character: event.actor?.character ?? ""
    };
    current.utterances += 1;
    current.talkMs += Math.max(0, (event.speech?.endMs ?? event.tsMs) - event.tsMs);
    current.words += event.text?.trim().split(/\s+/).filter(Boolean).length ?? 0;
    current.character = event.actor?.character ?? current.character;
    speakers.set(key, current);
  }
  const ffgTotals: FfgCounts = {
    success: 0,
    failure: 0,
    advantage: 0,
    threat: 0,
    triumph: 0,
    despair: 0,
    light: 0,
    dark: 0
  };
  for (const event of timeline) {
    if (event.type !== "roll" || !event.roll?.ffg) continue;
    for (const key of Object.keys(ffgTotals) as Array<keyof FfgCounts>) {
      ffgTotals[key] = (ffgTotals[key] ?? 0) + (event.roll.ffg[key] ?? 0);
    }
  }
  const rollEvents = timeline.filter((event) => event.type === "roll");
  const mentalNoteEvents = timeline.filter((event) => event.mentalNote);
  const rollsWithContext = rollEvents.filter((event) => {
    const context = event.roll?.voiceContext;
    return Boolean(context && context.before.length + context.after.length > 0);
  });
  const stats = [
    `# Stats — ${title}`,
    "",
    `| Metric | Value |`,
    `|---|---|`,
    `| Session | \`${session.sessionId}\` |`,
    `| System | ${session.system.id} ${session.system.version ?? ""} |`,
    `| Events | ${timeline.length} |`,
    `| Speech utterances | ${speech.length} |`,
    `| Speech time | ${formatDuration(totalSpeechMs)} |`,
    `| Transcribed words | ${words} |`,
    `| Roll messages | ${rollEvents.length} |`,
    `| Rolls with nearby speech | ${rollsWithContext.length} |`,
    `| Mental notes | ${mentalNoteEvents.length} |`,
    `| Chat messages | ${timeline.filter((event) => event.type === "chat").length} |`,
    `| Markers | ${timeline.filter((event) => event.type === "marker").length} |`,
    `| Recording consent | ${consentMethodLabel(session)} |`,
    `| Opted out (not recorded) | ${optedOut.length} |`,
    "",
    ...(optedOut.length > 0
      ? ["## Not recorded", "", ...optedOut.map((person) => `- ${displayPerson(person)} — player did not want to be recorded.`), ""]
      : []),
    `## Speakers`,
    "",
    `| Speaker | Character | Speech lines | Talk time | Words |`,
    `|---|---|---:|---:|---:|`,
    ...[...speakers.values()].map(
      (value) =>
        `| ${markdownCell(value.name)} | ${markdownCell(value.character)} | ${value.utterances} | ${formatDuration(value.talkMs)} | ${value.words} |`
    ),
    "",
    ...(session.system.id === "starwarsffg" || rollEvents.some((event) => event.roll?.system === "starwarsffg")
      ? [
          `## FFG narrative dice symbols`,
          "",
          `| Symbol | Total |`,
          `|---|---:|`,
          ...Object.entries(ffgTotals).map(([key, value]) => `| ${key} | ${value} |`)
        ]
      : [])
  ].join("\n");

  const rollSync = [
    `# Roll sync — ${title}`,
    "",
    `Session \`${session.sessionId}\` · ${rollEvents.length} roll event(s) · speech context ${Math.round((session.merge.rollContextBeforeMs ?? 20_000) / 1000)}s before / ${Math.round((session.merge.rollContextAfterMs ?? 10_000) / 1000)}s after`,
    "",
    ...rollEvents.flatMap((event) => {
      const context = event.roll?.voiceContext;
      const lines = [
        `## ${formatClock(event.tsMs, timeZone)} — ${actorName(event)} — ${event.text || "Roll"}`,
        "",
        `**${event.roll?.summary ?? "Roll"}**${event.roll?.formula ? ` \`${event.roll.formula}\`` : ""}`,
        `- sync confidence: **${context?.confidence ?? "none"}**${context?.nearestSpeechGapMs != null ? ` (nearest speech ${relativeMs(context.nearestSpeechGapMs)})` : ""}`,
        ""
      ];
      if (!context || context.before.length + context.after.length === 0) {
        lines.push("_No speech within the configured context window._", "");
        return lines;
      }
      if (context.before.length > 0) {
        lines.push("Before:");
        for (const line of context.before) {
          lines.push(`- ${relativeMs(line.tsMs - event.tsMs)} **${markdownCell(line.speaker)}${line.character && line.character !== line.speaker ? ` (${markdownCell(line.character)})` : ""}**: ${line.text}`);
        }
        lines.push("");
      }
      if (context.after.length > 0) {
        lines.push("After:");
        for (const line of context.after) {
          lines.push(`- ${relativeMs(line.tsMs - event.tsMs)} **${markdownCell(line.speaker)}${line.character && line.character !== line.speaker ? ` (${markdownCell(line.character)})` : ""}**: ${line.text}`);
        }
        lines.push("");
      }
      return lines;
    })
  ].join("\n");

  const mentalNotes = [
    `# Mental notes — ${title}`,
    "",
    `Session \`${session.sessionId}\` · ${mentalNoteEvents.length} note(s)`,
    "",
    ...mentalNoteEvents.map((event) => {
      const source = event.mentalNote?.source === "manual" ? "manual marker" : "spoken";
      const speaker = event.mentalNote?.speaker;
      const character = event.mentalNote?.character;
      const who = speaker ? (character && character !== speaker ? `${speaker} (${character})` : speaker) : null;
      return `- **${formatLocalDateTime(event.tsMs, timeZone)}** — ${source}${who ? ` — ${markdownCell(who)}` : ""} — ${event.mentalNote?.text ?? event.text ?? ""}`;
    })
  ].join("\n");

  const speechEvents = timeline.filter((event) => event.type === "speech");
  const noteRollEvents = timeline.filter((event) => event.type === "roll");
  const noteChatEvents = timeline.filter((event) => event.type === "chat");
  const durationMs =
    session.startedAtMs != null && session.stoppedAtMs != null
      ? Math.max(0, session.stoppedAtMs - session.startedAtMs)
      : timeline.length > 1
        ? Math.max(0, timeline[timeline.length - 1]!.tsMs - timeline[0]!.tsMs)
        : 0;
  const filler = /^(?:yeah|yep|yea|okay|ok|right|sure|thanks|thank you|mm+|uh+|um+|huh|what|no|yes|bad|good|nothing|cool|nice|wow)[.!?]*$/i;
  const substantiveSpeech = (event: TimelineEvent): boolean => {
    if (event.mentalNote) return true;
    const text = (event.text ?? "").trim();
    if (!text) return false;
    if (filler.test(text)) return false;
    const words = text.split(/\s+/).filter(Boolean).length;
    const duration = event.speech?.endMs != null ? event.speech.endMs - event.tsMs : 0;
    if (words < 3 && duration < 2_500 && !/[?!]/.test(text)) return false;
    return true;
  };
  const includedSpeech = speechEvents.filter(substantiveSpeech).length;
  const castLines = people.length > 0
    ? people.map((person) => {
        const name = person.discordName ?? person.foundryUserName ?? person.discordUserId ?? "Unnamed player";
        const character = person.character ? ` — ${person.character}` : "";
        const opted = person.consentStatus === "opted_out" || person.consent === false ? " · opted out" : "";
        const role = person.role === "gm" ? "GM" : person.role === "observer" ? "Observer" : "Player";
        return `- **${name}**${character} — ${role}${opted}`;
      })
    : ["- No people mapping was saved for this session."];

  const notesLines: string[] = [
    `# Session notes: ${title}`,
    "",
    "Event log for the GM. No summaries, just what happened.",
    "",
    `Short “yeah” and “okay” replies are left out. The full transcript is in \`transcript.md\`.`,
    "",
    `- **Session:** \`${session.sessionId}\``,
    `- **System:** ${session.system.id} ${session.system.version ?? ""}`,
    `- **World:** ${session.world.title}`,
    `- **Captured:** ${session.startedAtMs ? formatLocalDateTime(session.startedAtMs, timeZone) : "not started"}`,
    `- **Length:** ${formatDuration(durationMs)}`,
    `- **Content:** ${includedSpeech} of ${speechEvents.length} speech lines, ${noteRollEvents.length} rolls, ${noteChatEvents.length} chat`,
    "",
    "## Cast",
    "",
    ...castLines,
    "",
    "## Recording consent",
    "",
    `- Method: ${consentMethodLabel(session)}`,
    ...(optedOut.length > 0
      ? optedOut.map((person) => `- ${displayPerson(person)} — did not want to be recorded; no speech is included.`)
      : ["- No opt-outs recorded."]),
    "",
    "## Timeline",
    ""
  ];

  for (const event of timeline) {
    const clock = formatClock(event.tsMs, timeZone);
    if (event.type === "marker" && !event.marker?.mentalNote) {
      const kind = event.marker?.kind ?? "note";
      const rawLabel = event.marker?.label?.trim() || kind;
      const label = rawLabel.replace(/^Foundry scene:\s*/i, "");
      if (kind === "break") {
        const heading = /^break time (?:called|over)\b/i.test(label) ? label : `Break: ${label}`;
        notesLines.push(`### ${clock} — ${heading}`, "");
      } else if (["scene", "combat"].includes(kind)) {
        notesLines.push(`### ${clock} — ${kind.charAt(0).toUpperCase()}${kind.slice(1)}: ${label}`, "");
      } else {
        notesLines.push(`> **${kind}** ${clock}${label !== kind ? ` — ${label}` : ""}`, "");
      }
      continue;
    }
    if (event.type === "speech") {
      if (!substantiveSpeech(event)) continue;
      notesLines.push(
        `- **[${clock}] ${markdownCell(actorName(event))}:** ${(event.text ?? "").replace(/\r?\n/g, " ")}${event.mentalNote ? " **[mental note]**" : ""}`
      );
      continue;
    }
    if (event.type === "roll") {
      const rolls = rollRows(event);
      rolls.forEach((roll, index) => {
        const label = rolls.length > 1 ? `Roll ${index + 1} — ` : "Roll — ";
        const formula = roll.formula ? ` · \`${roll.formula}\`` : "";
        notesLines.push(`- **[${clock}] ${label}${markdownCell(actorName(event))}:** ${roll.summary}${formula}`);
      });
      continue;
    }
    if (event.type === "chat") {
      notesLines.push(`- **[${clock}] Chat — ${markdownCell(actorName(event))}:** ${(event.text ?? "").replace(/\r?\n/g, " ")}`);
    }
  }

  if (optedOut.length > 0) {
    notesLines.push("", "## Consent notice", "", CONSENT_NOTICE_TEXT.replace(/\r?\n/g, " "));
  }

  const notes = notesLines.join("\n");

  return {
    "transcript.md": `${transcript}\n`,
    "chronology.md": `${chronology}\n`,
    "rolls.csv": `${rollsCsv}\n`,
    "roll-sync.md": `${rollSync}\n`,
    "mental-notes.md": `${mentalNotes}\n`,
    "stats.md": `${stats}\n`,
    "notes-ready.md": `${notes}\n`
  };
}

export async function renderSession(sessionDir: string, session: SessionRecord): Promise<RenderResult> {
  const { items } = await readJsonl<TimelineEvent>(path.join(sessionDir, "merged", "timeline.jsonl"));
  const peopleFile = await readJson<PeopleFile>(path.join(sessionDir, "people.json"));
  const rendered = renderTimeline(session, items, session.timeZone, peopleFile?.people ?? []);
  const files: RenderResult["files"] = [];
  for (const name of OUTPUT_FILES) {
    const body = rendered[name];
    await writeFileAtomic(path.join(sessionDir, "outputs", name), body);
    files.push({ name, sizeBytes: Buffer.byteLength(body, "utf8") });
  }
  return { files, eventCount: items.length };
}


