import { describe, expect, it } from "vitest";
import { buildSummaryLedger, splitNotesByHeadings, summaryNotesBlock } from "../src/core/summaryLedger.js";
import type { Person, TimelineEvent } from "../src/core/types.js";

const person: Person = {
  personId: "p1",
  role: "player",
  discordUserId: "u1",
  discordName: "Veyra",
  foundryUserId: null,
  foundryUserName: null,
  character: "Veyra",
  aliases: [],
  consent: true
};

function event(overrides: Partial<TimelineEvent>): TimelineEvent {
  return {
    schema: "tablerecords.timeline/v1",
    sessionId: "s1",
    seq: 0,
    tsMs: Date.UTC(2026, 10, 10, 4, 0, 0),
    type: "chat",
    sourceId: "x",
    source: "foundry",
    ...overrides
  };
}

describe("summary ledger", () => {
  it("keeps rolls, markers, mental notes, and people", () => {
    const ledger = buildSummaryLedger(
      [
        event({
          type: "roll",
          actor: { discordUserId: "u1", foundryUserId: null, name: "Veyra", character: "Veyra", role: "player" },
          roll: { system: "ffg", formula: "2eA", summary: "2 Success", total: 2, raw: {} }
        }),
        event({ type: "marker", tsMs: Date.UTC(2026, 10, 10, 4, 1, 0), marker: { kind: "scene", label: "Kesh Hub" } }),
        event({
          type: "speech",
          actor: { discordUserId: "u1", foundryUserId: null, name: "Veyra", character: "Veyra", role: "player" },
          text: "I remind the group",
          mentalNote: { text: "Remember the manifest", source: "spoken" }
        })
      ],
      [person],
      "UTC"
    );
    expect(ledger.rolls).toBe(1);
    expect(ledger.markers).toBe(1);
    expect(ledger.mentalNotes).toBe(1);
    expect(ledger.markdown).toContain("Veyra");
    expect(ledger.markdown).toContain("2 Success");
    expect(ledger.markdown).toContain("Kesh Hub");
    expect(ledger.markdown).toContain("Remember the manifest");
  });

  it("preserves notes beyond the old 1,200-character cap", () => {
    const notes = `## Opening\n\n${"A".repeat(2_400)}`;
    const block = summaryNotesBlock(notes);
    expect(block.truncated).toBe(false);
    expect(block.chars).toBeGreaterThan(2_000);
    expect(block.markdown).toContain("A".repeat(2_400));
  });

  it("splits long notes at headings without dropping the tail", () => {
    const notes = `## Opening\n\n${"A".repeat(600)}\n\n## Ending\n\nTAIL_NOTE`;
    const split = splitNotesByHeadings(notes, 500);
    expect(split.chunks.length).toBeGreaterThan(1);
    expect(split.chunks.join("\n")).toContain("TAIL_NOTE");
    expect(split.headings).toEqual(["Opening", "Ending"]);
  });

  it("marks a ledger that exceeds its budget", () => {
    const ledger = buildSummaryLedger(
      Array.from({ length: 300 }, (_, index) =>
        event({ type: "roll", tsMs: Date.UTC(2026, 10, 10, 4, index, 0), roll: { system: "ffg", formula: "2eA", summary: `Success ${index}`, total: 2, raw: {} } })
      ),
      [],
      "UTC",
      500
    );
    expect(ledger.truncated).toBe(true);
    expect(ledger.markdown.length).toBeLessThan(1_000);
  });
});
