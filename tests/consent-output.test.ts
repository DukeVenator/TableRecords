import { describe, expect, it } from "vitest";
import type { Person, SessionRecord, TranscriptRecord } from "../src/core/types.js";
import { mergeRecords } from "../src/core/merge.js";
import { renderTimeline } from "../src/core/render.js";
import { buildRecentContext } from "../src/core/recent.js";

const T0 = 1_793_430_000_000;

function person(overrides: Partial<Person> & Pick<Person, "personId" | "discordUserId" | "discordName">): Person {
  return {
    role: "player",
    foundryUserId: null,
    foundryUserName: null,
    character: null,
    aliases: [],
    consent: true,
    consentStatus: "assumed",
    consentSource: "dashboard",
    ...overrides
  };
}

function transcript(utteranceId: string, discordUserId: string, text: string, startMs: number): TranscriptRecord {
  return {
    schema: "tablerecords.transcript/v1",
    sessionId: "consent-session",
    utteranceId,
    sttJobId: `stt_${utteranceId}`,
    batchJobId: "job",
    discordUserId,
    speaker: discordUserId,
    character: null,
    text,
    rawText: text,
    corrections: [],
    startMs,
    endMs: startMs + 1000,
    words: [],
    stt: {
      engine: "fake",
      engineVersion: "1",
      model: "fake",
      device: "cpu",
      computeType: "int8",
      language: "en",
      languageProbability: null,
      avgLogprob: null,
      noSpeechProb: null
    },
    flags: [],
    createdAtMs: T0
  };
}

function session(): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId: "consent-session",
    title: "Consent Output Test",
    status: "captured",
    system: { id: "starwarsffg", version: "2.0" },
    world: { id: "swffg-cartel", title: "Cartel" },
    foundryVersion: "14.369.0",
    timeZone: "UTC",
    createdAtMs: T0,
    startedAtMs: T0,
    stoppedAtMs: T0 + 60_000,
    guild: null,
    voiceChannel: null,
    consent: {
      confirmed: true,
      confirmedAtMs: T0,
      confirmedBy: "Foundry player consent prompt",
      participants: ["U1", "U2"],
      notes: "",
      method: "foundry",
      noticeVersion: "2026-11-01",
      promptedAtMs: T0
    },
    merge: { filterMarginMs: 300_000 },
    recording: {
      utteranceCount: 2,
      totalBytes: 100,
      decryptionFailures: 0,
      reconnectCount: 0,
      nodeVersion: "26",
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

describe("opted-out players in outputs", () => {
  const people = [
    person({ personId: "p1", discordUserId: "U1", discordName: "Alice", character: "Veyra" }),
    person({
      personId: "p2",
      discordUserId: "U2",
      discordName: "Bob",
      character: "Korrin",
      consent: false,
      consentStatus: "opted_out",
      consentSource: "foundry"
    })
  ];

  it("excludes their transcripts and notes why in transcript/chronology/stats", () => {
    const merged = mergeRecords(
      session(),
      people,
      [
        transcript("u1", "U1", "I line up a shot.", T0 + 1000),
        transcript("u2", "U2", "I will stay out of this recording.", T0 + 2000)
      ],
      [],
      []
    );
    expect(merged.counts.speech).toBe(1);
    expect(merged.counts.optedOutTranscripts).toBe(1);

    const rendered = renderTimeline(session(), merged.timeline, "UTC", people);
    expect(rendered["transcript.md"]).toContain("I line up a shot.");
    expect(rendered["transcript.md"]).not.toContain("I will stay out of this recording.");
    expect(rendered["transcript.md"]).toContain("Bob (Korrin)");
    expect(rendered["transcript.md"]).toContain("did not want to be recorded");
    expect(rendered["chronology.md"]).toContain("did not want to be recorded");
    expect(rendered["stats.md"]).toContain("Opted out (not recorded) | 1");
    expect(rendered["notes-ready.md"]).toContain("Recording consent");
  });

  it("notes opted-out players in the recap brief", () => {
    const merged = mergeRecords(
      session(),
      people,
      [transcript("u1", "U1", "I line up a shot.", T0 + 1000)],
      [],
      []
    );
    const brief = buildRecentContext({
      session: session(),
      people,
      transcripts: [transcript("u1", "U1", "I line up a shot.", T0 + 1000)],
      foundryEvents: [],
      markers: [],
      windowSeconds: 180,
      endMs: T0 + 60_000
    });
    expect(merged.counts.speech).toBe(1);
    expect(brief.counts.optedOut).toBe(1);
    expect(brief.markdown).toContain("Not recorded");
    expect(brief.markdown).toContain("Bob (Korrin)");
    expect(brief.markdown).toContain("did not want to be recorded");
  });
});

