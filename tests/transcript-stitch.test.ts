import { describe, expect, it } from "vitest";
import type { TranscriptRecord } from "../src/core/types.js";
import {
  annotateTranscript,
  isFillerOnly,
  isRepetitiveText,
  normalizeTranscriptText,
  stitchTranscripts
} from "../src/core/transcript.js";

function record(overrides: Partial<TranscriptRecord> & Pick<TranscriptRecord, "utteranceId" | "discordUserId" | "text" | "startMs" | "endMs">): TranscriptRecord {
  return {
    schema: "tablerecords.transcript/v1",
    sessionId: "session",
    sttJobId: `stt_${overrides.utteranceId}`,
    batchJobId: "batch",
    speaker: overrides.discordUserId,
    character: null,
    rawText: overrides.text,
    corrections: [],
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
    createdAtMs: 1,
    ...overrides
  };
}

describe("transcript text normalization", () => {
  it("removes standalone ampersands and collapses stutters", () => {
    expect(normalizeTranscriptText("Names & G.O.A.T.")).toBe("Names G.O.A.T.");
    expect(normalizeTranscriptText("I I I do shifty eyes.")).toBe("I do shifty eyes.");
    expect(normalizeTranscriptText("D&D is fine.")).toBe("D&D is fine.");
  });

  it("detects short backchannel-only clips as filler", () => {
    expect(isFillerOnly("Yeah.")).toBe(true);
    expect(isFillerOnly("Okay. Right.")).toBe(true);
    expect(isFillerOnly("No.")).toBe(false);
    expect(isFillerOnly("Thank you.")).toBe(false);
    expect(annotateTranscript(record({ utteranceId: "u1", discordUserId: "A", text: "Yeah.", startMs: 0, endMs: 600 })).flags).toContain("filler");
  });

  it("detects degenerate decoder loops", () => {
    expect(isRepetitiveText("Names G.O.A.T. Names G.O.A.T. Names G.O.A.T. Names G.O.A.T.")).toBe(true);
    expect(isRepetitiveText("Duke Duke Duke Duke")).toBe(true);
    expect(isRepetitiveText("no no no")).toBe(false);
    expect(isRepetitiveText("I think we should check the other door before the guards arrive.")).toBe(false);
  });
});

describe("same-speaker gap stitching", () => {
  it("joins two sentences separated by a short pause", () => {
    const stitched = stitchTranscripts([
      record({ utteranceId: "u1", discordUserId: "A", text: "I can be very persuasive.", startMs: 1000, endMs: 2500 }),
      record({ utteranceId: "u2", discordUserId: "A", text: "Just smile and say thank you.", startMs: 4000, endMs: 5500 })
    ]);
    expect(stitched).toHaveLength(1);
    expect(stitched[0]!.text).toBe("I can be very persuasive. Just smile and say thank you.");
    expect(stitched[0]!.startMs).toBe(1000);
    expect(stitched[0]!.endMs).toBe(5500);
    expect(stitched[0]!.utteranceIds).toEqual(["u1", "u2"]);
    expect(stitched[0]!.utteranceId).toBe("u1");
  });

  it("does not join across a longer pause", () => {
    const stitched = stitchTranscripts([
      record({ utteranceId: "u1", discordUserId: "A", text: "First.", startMs: 0, endMs: 1000 }),
      record({ utteranceId: "u2", discordUserId: "A", text: "Second.", startMs: 5000, endMs: 6000 })
    ]);
    expect(stitched).toHaveLength(2);
  });

  it("does not join when another speaker interjects", () => {
    const stitched = stitchTranscripts([
      record({ utteranceId: "u1", discordUserId: "A", text: "First.", startMs: 0, endMs: 1000 }),
      record({ utteranceId: "u2", discordUserId: "B", text: "Wait.", startMs: 1500, endMs: 2000 }),
      record({ utteranceId: "u3", discordUserId: "A", text: "Second.", startMs: 2500, endMs: 3500 })
    ]);
    expect(stitched.map((item) => item.utteranceId)).toEqual(["u1", "u2", "u3"]);
  });

  it("does not join across a roll", () => {
    const stitched = stitchTranscripts(
      [
        record({ utteranceId: "u1", discordUserId: "A", text: "I shoot.", startMs: 0, endMs: 1000 }),
        record({ utteranceId: "u2", discordUserId: "A", text: "Two successes.", startMs: 2000, endMs: 3000 })
      ],
      { blockers: [{ tsMs: 1500 }] }
    );
    expect(stitched).toHaveLength(2);
  });

  it("marks merged filler as filler", () => {
    const stitched = stitchTranscripts([
      record({ utteranceId: "u1", discordUserId: "A", text: "Yeah.", startMs: 0, endMs: 500 }),
      record({ utteranceId: "u2", discordUserId: "A", text: "Okay.", startMs: 1200, endMs: 1700 })
    ]);
    expect(stitched).toHaveLength(1);
    expect(stitched[0]!.flags).toContain("filler");
  });
});
