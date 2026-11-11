import { formatClock } from "./render.js";
import type { Person, TimelineEvent } from "./types.js";

export interface SummaryLedger {
  markdown: string;
  rolls: number;
  markers: number;
  mentalNotes: number;
  people: number;
  requiredPeople: string[];
  requiredMarkers: string[];
  requiredMentalNotes: string[];
  truncated: boolean;
}

function clean(value: string | null | undefined): string {
  return (value ?? "").replace(/\s+/g, " ").trim();
}

function actorName(event: TimelineEvent): string {
  const name = clean(event.actor?.name) || "Unknown";
  const character = clean(event.actor?.character);
  return character && character !== name ? `${name} (${character})` : name;
}

/**
 * A compact, deterministic list of facts that must survive the map-reduce
 * stage. It deliberately excludes ordinary speech so it stays small, but it
 * keeps every roll, marker, mental note, and mapped person.
 */
export function buildSummaryLedger(
  timeline: TimelineEvent[],
  people: Person[],
  timeZone: string,
  maxChars = 12_000
): SummaryLedger {
  const lines: string[] = ["## Deterministic fact ledger", ""];
  const requiredPeople: string[] = [];
  if (people.length > 0) {
    lines.push("### People");
    for (const person of people) {
      const name = clean(person.discordName) || clean(person.discordUserId) || "Unknown";
      const character = clean(person.character);
      requiredPeople.push(name);
      if (character) requiredPeople.push(character);
      lines.push(`- ${person.role.toUpperCase()}: ${name}${character ? ` as ${character}` : ""}`);
    }
    lines.push("");
  }

  const rolls = timeline.filter((event) => event.type === "roll");
  const markers = timeline.filter((event) => event.type === "marker");
  const mentalNotes = timeline.filter((event) => event.mentalNote);

  if (rolls.length > 0) {
    lines.push("### Rolls");
    for (const event of rolls) {
      const detail = clean(event.roll?.summary) || clean(event.text) || "Roll";
      const formula = clean(event.roll?.formula);
      lines.push(`- [${formatClock(event.tsMs, timeZone)}] ${actorName(event)}: ${detail}${formula ? ` (${formula})` : ""}`);
    }
    lines.push("");
  }

  const requiredMarkers: string[] = [];
  if (markers.length > 0) {
    lines.push("### Markers");
    for (const event of markers) {
      const kind = clean(event.marker?.kind) || "note";
      const label = clean(event.marker?.label);
      // Scene labels are useful context but are not required summary facts.
      if (label && (event.marker?.mentalNote || kind !== "scene")) requiredMarkers.push(label);
      lines.push(`- [${formatClock(event.tsMs, timeZone)}] ${kind}${label ? `: ${label}` : ""}`);
    }
    lines.push("");
  }

  const requiredMentalNotes: string[] = [];
  if (mentalNotes.length > 0) {
    lines.push("### Mental notes");
    for (const event of mentalNotes) {
      const text = clean(event.mentalNote?.text ?? event.text);
      if (text) {
        requiredMentalNotes.push(text);
        lines.push(`- [${formatClock(event.tsMs, timeZone)}] ${actorName(event)}: ${text}`);
      }
    }
    lines.push("");
  }

  let truncated = false;
  let body = lines.join("\n").trimEnd();
  if (body.length > maxChars) {
    const cut = body.slice(0, maxChars);
    const boundary = Math.max(cut.lastIndexOf("\n- "), cut.lastIndexOf("\n### "));
    body = `${(boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut).trimEnd()}\n\n> Ledger truncated at the configured limit.`;
    truncated = true;
  }

  return {
    markdown: body,
    rolls: rolls.length,
    markers: markers.length,
    mentalNotes: mentalNotes.length,
    people: people.length,
    requiredPeople,
    requiredMarkers,
    requiredMentalNotes,
    truncated
  };
}

export function splitNotesByHeadings(
  notes: string | null | undefined,
  maxChars: number
): { chunks: string[]; headings: string[] } {
  const text = (notes ?? "").trim();
  if (!text) return { chunks: [], headings: [] };
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
  if (text.length <= maxChars) return { chunks: [text], headings };

  const sections = text.split(/(?=^#{1,6}\s)/m).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };
  for (const section of sections) {
    if (section.length > maxChars) {
      push();
      const paragraphs = section.split(/\n{2,}/);
      for (const paragraph of paragraphs) {
        if (paragraph.length > maxChars) {
          for (let index = 0; index < paragraph.length; index += maxChars) {
            chunks.push(paragraph.slice(index, index + maxChars));
          }
        } else if (`${current}\n\n${paragraph}`.length > maxChars) {
          push();
          current = paragraph;
        } else {
          current = current ? `${current}\n\n${paragraph}` : paragraph;
        }
      }
    } else if (`${current}\n${section}`.length > maxChars) {
      push();
      current = section;
    } else {
      current = current ? `${current}\n${section}` : section;
    }
  }
  push();
  return { chunks, headings };
}

export function summaryNotesBlock(
  notes: string | null | undefined,
  maxChars = 12_000
): { markdown: string; chars: number; truncated: boolean; headings: string[] } {
  const text = (notes ?? "").trim();
  const headings = [...text.matchAll(/^#{1,6}\s+(.+)$/gm)].map((match) => match[1]!.trim()).filter(Boolean);
  if (!text) return { markdown: "", chars: 0, truncated: false, headings: [] };
  if (text.length <= maxChars) {
    return { markdown: `## GM session notes\n\n${text}`, chars: text.length, truncated: false, headings };
  }
  const cut = text.slice(0, maxChars);
  const boundary = Math.max(cut.lastIndexOf("\n## "), cut.lastIndexOf("\n- "), cut.lastIndexOf("\n"));
  const body = (boundary > maxChars * 0.5 ? cut.slice(0, boundary) : cut).trimEnd();
  return {
    markdown: `## GM session notes\n\n${body}\n\n> Session notes truncated at the configured limit.`,
    chars: body.length,
    truncated: true,
    headings
  };
}
