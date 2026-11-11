import { describe, expect, it } from "vitest";
import { audioTestSucceeded } from "../src/web/audioTest.js";

describe("guided audio test", () => {
  it("marks complete only when the user confirms speech and clips were captured", () => {
    expect(audioTestSucceeded({ totalBytes: 12_000, utteranceCount: 2 }, true)).toBe(true);
    expect(audioTestSucceeded({ totalBytes: 12_000, utteranceCount: 2 }, false)).toBe(false);
    expect(audioTestSucceeded({ totalBytes: 0, utteranceCount: 0 }, true)).toBe(false);
    expect(audioTestSucceeded({ totalBytes: 12_000, utteranceCount: 0 }, true)).toBe(false);
    expect(audioTestSucceeded(null, true)).toBe(false);
  });
});
