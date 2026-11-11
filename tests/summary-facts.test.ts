import { describe, expect, it } from "vitest";
import {
  emptySummaryFacts,
  mergeSummaryFacts,
  parseSummaryFacts,
  summaryFactsBlock
} from "../src/core/llmPrompts.js";

describe("summary facts", () => {
  it("parses a JSON fact index and drops empty values", () => {
    const facts = parseSummaryFacts(
      '```json\n{"names":["Veyra",""],"places":["Kesh Hub"],"items":[],"clues":["The manifest is fake"],"decisions":["Take the deal"],"questions":["Who hired the hunter?"]}\n```'
    );
    expect(facts).toEqual({
      names: ["Veyra"],
      places: ["Kesh Hub"],
      items: [],
      clues: ["The manifest is fake"],
      decisions: ["Take the deal"],
      questions: ["Who hired the hunter?"]
    });
  });

  it("merges without duplicates and formats a block", () => {
    const target = emptySummaryFacts();
    mergeSummaryFacts(target, {
      names: ["Veyra"],
      places: ["Kesh Hub"],
      items: ["Manifest"],
      clues: [],
      decisions: [],
      questions: []
    });
    mergeSummaryFacts(target, {
      names: ["veyra"],
      places: [],
      items: [],
      clues: ["The manifest is fake"],
      decisions: [],
      questions: []
    });
    expect(target.names).toEqual(["Veyra"]);
    expect(summaryFactsBlock(target)).toContain("Clues");
    expect(summaryFactsBlock(target)).toContain("The manifest is fake");
  });

  it("returns null for malformed JSON", () => {
    expect(parseSummaryFacts("not json")).toBeNull();
  });
});
