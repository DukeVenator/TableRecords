import { describe, expect, it } from "vitest";
import { computeSessionStats } from "../src/web/sessionStats.js";

describe("session stats", () => {
  it("aggregates talk time, turns, words, and speaker shares", () => {
    const stats = computeSessionStats({
      startedAtMs: 0,
      stoppedAtMs: 120_000,
      people: [
        { personId: "p1", discordUserId: "u1", discordName: "Alice", character: "Veyra", role: "player", consentStatus: "assumed" },
        { personId: "p2", discordUserId: "u2", discordName: "Ben", character: "Korrin", role: "player", consentStatus: "assumed" },
        { personId: "p3", discordUserId: "u3", discordName: "Cara", character: null, role: "observer", consentStatus: "opted_out" }
      ],
      utterances: [
        { utteranceId: "a1", discordUserId: "u1", displayName: "Alice", startMs: 0, endMs: 10_000, durationMs: 10_000, words: 20 },
        { utteranceId: "a2", discordUserId: "u1", displayName: "Alice", startMs: 12_000, endMs: 20_000, durationMs: 8_000, words: 15 },
        { utteranceId: "b1", discordUserId: "u2", displayName: "Ben", startMs: 25_000, endMs: 40_000, durationMs: 15_000, words: 30 },
        { utteranceId: "a3", discordUserId: "u1", displayName: "Alice", startMs: 45_000, endMs: 50_000, durationMs: 5_000, words: 5 }
      ],
      rollCount: 7,
      mentalNotes: 2
    });
    expect(stats.durationMs).toBe(120_000);
    expect(stats.speechMs).toBe(38_000);
    expect(stats.silenceMs).toBe(82_000);
    expect(stats.utterances).toBe(4);
    expect(stats.words).toBe(70);
    expect(stats.turns).toBe(3);
    expect(stats.mostTalkative?.name).toBe("Alice");
    expect(stats.longestTurn).toMatchObject({ durationMs: 20_000, atMs: 0 });
    expect(stats.rollCount).toBe(7);
    const alice = stats.speakers.find((speaker) => speaker.name === "Alice")!;
    const ben = stats.speakers.find((speaker) => speaker.name === "Ben")!;
    const cara = stats.speakers.find((speaker) => speaker.name === "Cara")!;
    expect(alice).toMatchObject({ utterances: 3, talkMs: 23_000, words: 40, turns: 2 });
    expect(ben).toMatchObject({ utterances: 1, talkMs: 15_000, words: 30, turns: 1 });
    expect(cara).toMatchObject({ utterances: 0, talkMs: 0, consentStatus: "opted_out" });
    expect(alice.share).toBeCloseTo(23 / 38);
  });

  it("counts overlapping speech and tolerates missing timings", () => {
    const stats = computeSessionStats({
      startedAtMs: 0,
      stoppedAtMs: 30_000,
      people: [],
      utterances: [
        { utteranceId: "a", discordUserId: "u1", displayName: "A", startMs: 0, endMs: 10_000, durationMs: 10_000, words: 3 },
        { utteranceId: "b", discordUserId: "u2", displayName: "B", startMs: 5_000, endMs: 15_000, durationMs: 10_000, words: 4 }
      ]
    });
    expect(stats.speechMs).toBe(15_000);
    expect(stats.overlapMs).toBe(5_000);
    expect(stats.combinedTalkMs).toBe(20_000);
    expect(stats.quietest?.name).toBe("B");
    expect(stats.speakers.map((speaker) => speaker.name).sort()).toEqual(["A", "B"]);
  });
});
