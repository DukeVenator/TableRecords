import { describe, expect, it } from "vitest";
import { detectSpokenMentalNote } from "../src/core/notes.js";
import { mergeRecords } from "../src/core/merge.js";
import { renderTimeline } from "../src/core/render.js";
import type {
  FoundryEvent,
  Marker,
  Person,
  SessionRecord,
  TranscriptRecord
} from "../src/core/types.js";

function session(): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId: "2026-11-01-notes-sync",
    title: "Notes and sync",
    status: "captured",
    system: { id: "starwarsffg", version: "2.0" },
    world: { id: "swffg-cartel", title: "Cartel" },
    foundryVersion: "14.369.0",
    timeZone: "UTC",
    createdAtMs: 1,
    startedAtMs: 0,
    stoppedAtMs: 60_000,
    guild: null,
    voiceChannel: null,
    consent: { confirmed: true, confirmedAtMs: 1, confirmedBy: "GM", participants: [], notes: "" },
    merge: { filterMarginMs: 0, rollContextBeforeMs: 20_000, rollContextAfterMs: 10_000 },
    recording: {
      utteranceCount: 2,
      totalBytes: 100,
      decryptionFailures: 0,
      reconnectCount: 0,
      nodeVersion: "24",
      discordJsVersion: "14",
      voiceVersion: "0.19.2",
      daveyVersion: "0.1.12"
    },
    files: {
      manifest: "discord/manifest.jsonl",
      foundryExport: "foundry/export.json",
      transcript: "stt/transcript.jsonl",
      timeline: "merged/timeline.jsonl",
      outputsDir: "outputs/"
    }
  };
}

function transcript(utteranceId: string, startMs: number, endMs: number, text: string): TranscriptRecord {
  return {
    schema: "tablerecords.transcript/v1",
    sessionId: "2026-11-01-notes-sync",
    utteranceId,
    sttJobId: `stt_${utteranceId}`,
    batchJobId: "job",
    discordUserId: "U1",
    speaker: "Alice",
    character: "Veyra",
    text,
    rawText: text,
    corrections: [],
    startMs,
    endMs,
    words: [],
    stt: {
      engine: "faster-whisper",
      engineVersion: "1.2.1",
      model: "large-v3-turbo",
      device: "cuda",
      computeType: "float16",
      language: "en",
      languageProbability: 1,
      avgLogprob: -0.2,
      noSpeechProb: 0
    },
    flags: [],
    createdAtMs: 1
  };
}

describe("mental notes and roll/voice sync", () => {
  it("detects deliberate spoken notes without matching ordinary mentions", () => {
    expect(detectSpokenMentalNote("Mental note: the captain is lying.")).toBe("the captain is lying.");
    expect(detectSpokenMentalNote("Okay, mental note — buy more dice.")).toBe("buy more dice.");
    expect(detectSpokenMentalNote("GM note: the door is trapped")).toBe("the door is trapped");
    expect(detectSpokenMentalNote("Note to self: ask about the bounty")).toBe("ask about the bounty");
    expect(detectSpokenMentalNote("I am making a mental note about this")).toBeNull();
    expect(detectSpokenMentalNote("Mental note")).toBeNull();
  });

  it("marks spoken/manual notes and attaches nearby speech to rolls", () => {
    const people: Person[] = [
      {
        personId: "p_alice",
        role: "player",
        discordUserId: "U1",
        discordName: "Alice",
        foundryUserId: "F1",
        foundryUserName: "Alice",
        character: "Veyra",
        aliases: [],
        consent: true
      }
    ];
    const roll: FoundryEvent = {
      schema: "tablerecords.foundry-event/v1",
      sessionId: "2026-11-01-notes-sync",
      eventId: "roll1",
      type: "roll",
      timestampMs: 6_000,
      author: { id: "F1", name: "Alice" },
      speaker: { alias: "Veyra", actorId: "A1", actorName: "Veyra", tokenName: "Veyra" },
      system: "starwarsffg",
      systemVersion: "2.0",
      flavor: "Laser rifle",
      contentText: "Laser rifle",
      visibility: { whisper: [], blind: false },
      rolls: [
        {
          class: "RollFFG",
          formula: "1eP",
          total: 0,
          ffg: { success: 1, failure: 0, advantage: 0, threat: 0, triumph: 0, despair: 0, light: 0, dark: 0 }
        }
      ],
      source: { kind: "macro", file: "foundry/export.json" }
    };
    const manual: Marker = {
      schema: "tablerecords.marker/v1",
      markerId: "m_note",
      sessionId: "2026-11-01-notes-sync",
      tsMs: 7_000,
      kind: "note",
      label: "The captain has a backup.",
      mentalNote: true,
      createdAtMs: 7_001
    };
    const breakMarker: Marker = {
      schema: "tablerecords.marker/v1",
      markerId: "m_break",
      sessionId: "2026-11-01-notes-sync",
      tsMs: 3_000,
      kind: "break",
      label: "Break time called by Gamemaster",
      createdAtMs: 3_001
    };
    const result = mergeRecords(
      session(),
      people,
      [
        transcript("u_note", 1_000, 2_000, "Mental note: the captain is lying."),
        transcript("u_roll", 5_000, 5_500, "I shoot the captain.")
      ],
      [roll],
      [manual, breakMarker]
    );

    const spoken = result.timeline.find((event) => event.sourceId === "u_note");
    expect(spoken?.mentalNote).toMatchObject({ text: "the captain is lying.", source: "spoken" });
    const rollEvent = result.timeline.find((event) => event.sourceId === "roll1");
    expect(rollEvent?.roll?.voiceContext?.before.map((line) => line.utteranceId)).toContain("u_roll");
    expect(rollEvent?.roll?.voiceContext?.confidence).toBe("high");
    expect(rollEvent?.roll?.voiceContext?.before.at(-1)?.text).toBe("I shoot the captain.");
    expect(result.counts.mentalNotes).toBe(2);
    expect(result.counts.rollsWithVoiceContext).toBe(1);

    const rendered = renderTimeline(session(), result.timeline);
    expect(rendered["mental-notes.md"]).toContain("the captain is lying.");
    expect(rendered["mental-notes.md"]).toContain("The captain has a backup.");
    expect(rendered["roll-sync.md"]).toContain("I shoot the captain.");
    expect(rendered["roll-sync.md"]).toContain("high");
    expect(rendered["rolls.csv"]).toContain("syncConfidence");
    expect(rendered["rolls.csv"]).toContain("high");
    expect(rendered["stats.md"]).toContain("Mental notes | 2");
    expect(rendered["notes-ready.md"]).toContain("the captain is lying.");
    expect(rendered["notes-ready.md"]).toContain("[mental note]");
    expect(rendered["notes-ready.md"]).toContain("### 00:00:03 — Break time called by Gamemaster");
    expect(rendered["notes-ready.md"]).not.toContain("Break: Break time called");
  });
});

