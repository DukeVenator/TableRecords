import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/server/config.js";

describe("STT engine configuration", () => {
  it("defaults to Parrot (Parakeet) unless whisper is requested", () => {
    const previous = process.env.STT_ENGINE;
    delete process.env.STT_ENGINE;
    try {
      const config = loadConfig({ projectRoot: "C:\\tablerecords-test" });
      expect(config.sttEngine).toBe("parakeet");
    } finally {
      if (previous === undefined) delete process.env.STT_ENGINE;
      else process.env.STT_ENGINE = previous;
    }
  });

  it("selects Parakeet independently from the faster-whisper stack", () => {
    const config = loadConfig({
      projectRoot: "C:\\tablerecords-test",
      sttEngine: "parakeet",
      parakeetPath: "C:\\tools\\nemo-speech\\bin\\nemo-speech.exe",
      parakeetModel: "C:\\models\\parakeet.q8_0.gguf",
      parakeetDevice: "cuda:0",
      parakeetConcurrency: 8
    });
    expect(config.sttEngine).toBe("parakeet");
    expect(config.parakeetPath).toContain("nemo-speech.exe");
    expect(config.parakeetModel).toContain("parakeet.q8_0.gguf");
    expect(config.parakeetDevice).toBe("cuda:0");
    expect(config.parakeetConcurrency).toBe(8);
  });

  it("accepts an explicit faster-whisper override", () => {
    const config = loadConfig({ projectRoot: "C:\\tablerecords-test", sttEngine: "faster-whisper" });
    expect(config.sttEngine).toBe("faster-whisper");
    expect(config.parakeetConcurrency).toBeGreaterThan(0);
  });

  it("clamps optional Whisper fine-tuning values", () => {
    const config = loadConfig({
      projectRoot: "C:\\tablerecords-test",
      sttBeamSize: 99,
      sttNoSpeechThreshold: -1,
      sttLogProbThreshold: -99,
      sttCompressionRatioThreshold: 99,
      sttPromptExtra: "Extra context",
      sttHotwordsExtra: "Harbor, Old Town"
    });
    expect(config.sttBeamSize).toBe(10);
    expect(config.sttNoSpeechThreshold).toBe(0);
    expect(config.sttLogProbThreshold).toBe(-5);
    expect(config.sttCompressionRatioThreshold).toBe(10);
    expect(config.sttPromptExtra).toBe("Extra context");
    expect(config.sttHotwordsExtra).toBe("Harbor, Old Town");
  });
});

