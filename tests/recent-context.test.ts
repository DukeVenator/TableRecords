import { describe, expect, it } from "vitest";
import type { FoundryEvent, Marker, SessionRecord, TranscriptRecord } from "../src/core/types.js";
import { buildRecentContext, clampRecentSeconds, resolveRecentWindow } from "../src/core/recent.js";

const T0 = 1_793_430_000_000;

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId: "2026-11-01-recent",
    title: "Recent Context Test",
    status: "recording",
    system: { id: "starwarsffg", version: "2.0" },
    world: { id: "swffg-cartel", title: "Cartel" },
    foundryVersion: "14.369.0",
    timeZone: "UTC",
    createdAtMs: T0,
    startedAtMs: T0,
    stoppedAtMs: null,
    guild: null,
    voiceChannel: null,
    consent: { confirmed: true, confirmedAtMs: T0, confirmedBy: "GM", participants: ["U1", "U2"], notes: "" },
    merge: { filterMarginMs: 300_000, rollContextBeforeMs: 20_000, rollContextAfterMs: 10_000 },
    recording: {
      utteranceCount: 0,
      totalBytes: 0,
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
    },
    notes: "The crew is hiding in the cantina.",
    ...overrides
  };
}

function transcript(utteranceId: string, startMs: number, text: string): TranscriptRecord {
  return {
    schema: "tablerecords.transcript/v1",
    sessionId: "2026-11-01-recent",
    utteranceId,
    sttJobId: `stt_${utteranceId}`,
    batchJobId: "job",
    discordUserId: "U1",
    speaker: "Alice",
    character: "Veyra Sol",
    text,
    rawText: text,
    corrections: [],
    startMs,
    endMs: startMs + 1_500,
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
      noSpeechProb: 0.01
    },
    flags: [],
    createdAtMs: T0
  };
}

function roll(timestampMs: number): FoundryEvent {
  return {
    schema: "tablerecords.foundry-event/v1",
    sessionId: "2026-11-01-recent",
    eventId: "msg_roll",
    type: "roll",
    timestampMs,
    author: { id: "F1", name: "Alice" },
    speaker: { alias: "Veyra Sol", actorId: "A1", actorName: "Veyra Sol", tokenName: "Veyra Sol" },
    system: "starwarsffg",
    systemVersion: "2.0",
    flavor: "Blaster attack",
    contentText: "Blaster attack",
    visibility: { whisper: [], blind: false },
    rolls: [
      {
        class: "RollFFG",
        formula: "2eP+1eA",
        total: 0,
        ffg: { success: 2, failure: 0, advantage: 1, threat: 0, triumph: 1, despair: 0, light: 0, dark: 0 }
      }
    ],
    source: { kind: "macro", file: "foundry/export.json" }
  };
}

describe("recent GM context", () => {
  it("clamps the window and picks the live versus finished end", () => {
    expect(clampRecentSeconds(0)).toBe(15);
    expect(clampRecentSeconds(90)).toBe(90);
    expect(clampRecentSeconds(9_000)).toBe(1800);
    const live = resolveRecentWindow(session(), 180, T0 + 500_000);
    expect(live.endMs).toBe(T0 + 500_000);
    expect(live.startMs).toBe(T0 + 320_000);
    const finished = resolveRecentWindow(session({ status: "captured", stoppedAtMs: T0 + 200_000 }), 180, T0 + 500_000);
    expect(finished.endMs).toBe(T0 + 200_000);
    expect(finished.label).toBe("last 3 min");
  });

  it("builds a copyable brief with mental notes, rolls, and nearby speech", () => {
    const now = T0 + 240_000;
    const result = buildRecentContext({
      session: session(),
      endMs: now,
      windowSeconds: 180,
      people: [
        {
          personId: "p1",
          role: "player",
          discordUserId: "U1",
          discordName: "Alice",
          foundryUserId: "F1",
          foundryUserName: "Alice",
          character: "Veyra Sol",
          aliases: ["Vey"],
          consent: true
        }
      ],
      transcripts: [
        transcript("u_old", T0 - 60_000, "This should be outside the window."),
        transcript("u1", now - 8_000, "I line up a shot at the door."),
        transcript("u2", now - 3_500, "Watch the vents, they always come from the vents."),
        transcript("u3", now - 1_000, "Mental note: the crime lord owes us a favour.")
      ],
      foundryEvents: [roll(now - 4_500)],
      markers: [
        {
          schema: "tablerecords.marker/v1",
          markerId: "m1",
          sessionId: "2026-11-01-recent",
          tsMs: now - 20_000,
          kind: "scene",
          label: "Cantina back room",
          createdAtMs: now - 20_000
        } satisfies Marker,
        {
          schema: "tablerecords.marker/v1",
          markerId: "m2",
          sessionId: "2026-11-01-recent",
          tsMs: now - 2_000,
          kind: "note",
          label: "Remember the hidden door",
          mentalNote: true,
          createdAtMs: now - 2_000
        } satisfies Marker
      ]
    });

    expect(result.window.endMs).toBe(now);
    expect(result.counts.speech).toBe(3);
    expect(result.counts.rolls).toBe(1);
    expect(result.counts.mentalNotes).toBe(2);
    expect(result.counts.rollsWithVoiceContext).toBe(1);
    expect(result.markdown).toContain("GM context: Recent Context Test");
    expect(result.markdown).toContain("Cantina back room");
    expect(result.markdown).toContain("Mental note: the crime lord owes us a favour.");
    expect(result.markdown).toContain("Remember the hidden door");
    expect(result.markdown).toContain("2 Successes");
    expect(result.markdown).toContain("voice sync: **high**");
    expect(result.markdown).toContain("Alice (Veyra Sol)");
    expect(result.markdown).not.toContain("This should be outside the window.");
    expect(result.markdown).toContain("Facts only");
  });
});

