import { describe, expect, it } from "vitest";
import {
  SUMMARY_PRESETS,
  estimateTokens,
  parseStructuredSummary,
  summaryChunkCount,
  summaryInputCharBudget,
  summaryPreset,
  summaryScope,
  trimSummaryBrief
} from "../src/core/llmPrompts.js";

describe("LLM summary prompts and budget", () => {
  it("has a fixed prompt for every preset and validates ids", () => {
    expect(summaryPreset("gm-prep")).toBe("gm-prep");
    expect(summaryPreset("clue-board")).toBe("clue-board");
    expect(summaryPreset("nope")).toBeNull();
    expect(summaryScope("scene")).toBe("scene");
    expect(summaryScope("session")).toBe("session");
    expect(summaryScope("nope")).toBeNull();
    expect(SUMMARY_PRESETS["clue-board"].json).toBe(true);
    expect(SUMMARY_PRESETS["clue-board"].system).toContain("JSON");
  });

  it("splits a four-hour session without the old 12-chunk truncation", () => {
    expect(summaryChunkCount(252_977, 40_000)).toBe(7);
    expect(summaryChunkCount(1_000_000, 40_000)).toBe(25);
    expect(summaryChunkCount(3_000_000, 40_000)).toBe(64);
    expect(summaryChunkCount(40_000, 40_000)).toBe(1);
  });

  it("reserves room for output and thinking when sizing the input", () => {
    const off = summaryInputCharBudget(16_384, 40_000, "off");
    const low = summaryInputCharBudget(16_384, 40_000, "low");
    const medium = summaryInputCharBudget(16_384, 40_000, "medium");
    const high = summaryInputCharBudget(16_384, 40_000, "high");
    expect(off).toBe(40_000);
    expect(high).toBeLessThan(off);
    expect(low).toBe(high);
    expect(medium).toBe(high);
    expect(summaryInputCharBudget(4_096, 40_000, "high")).toBeLessThan(8_000);
    expect(summaryInputCharBudget(131_072, 200_000, "off")).toBe(200_000);
  });

  it("trims a long brief and marks it", () => {
    const brief = `# GM context\n\n## Timeline\n\n${"- a long line of speech\n".repeat(500)}`;
    const trimmed = trimSummaryBrief(brief, 4_000);
    expect(trimmed.trimmed).toBe(true);
    expect(trimmed.originalChars).toBe(brief.length);
    expect(trimmed.markdown.length).toBeLessThan(brief.length);
    expect(trimmed.markdown).toContain("Brief trimmed");
    expect(estimateTokens(trimmed.markdown)).toBeGreaterThan(0);
  });

  it("parses and normalizes a structured clue board", () => {
    const parsed = parseStructuredSummary(
      "```json\n" +
        JSON.stringify({
          situation: "The crew is hiding in a cantina.",
          npcs: [{ name: "Veyra", note: "Nervous" }, "not an npc"],
          clues: ["A broken datapad", 12],
          threads: ["Who owns the cantina?"],
          reminders: ["Roll initiative next time"]
        }) +
        "\n```"
    );
    expect(parsed).toMatchObject({
      situation: "The crew is hiding in a cantina.",
      npcs: [{ name: "Veyra", note: "Nervous" }],
      clues: ["A broken datapad"],
      threads: ["Who owns the cantina?"],
      reminders: ["Roll initiative next time"]
    });
  });

  it("rejects a malformed clue board", () => {
    expect(() => parseStructuredSummary("not json")).toThrow();
    expect(() => parseStructuredSummary(JSON.stringify({ npcs: [] }))).toThrow();
  });
});
