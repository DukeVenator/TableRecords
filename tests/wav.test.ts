import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { WavWriter, inspectWav, wavHeader } from "../src/core/wav.js";

describe("WAV writer", () => {
  it("writes a valid 48 kHz stereo PCM header and patches sizes on finalize", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-wav-"));
    const file = path.join(dir, "utterance.wav");
    const writer = new WavWriter(file);
    const frames = 48_000;
    const chunk = Buffer.alloc(frames * 2 * 2);
    for (let i = 0; i < frames; i += 1) {
      chunk.writeInt16LE(1000, i * 4);
      chunk.writeInt16LE(-1000, i * 4 + 2);
    }
    await writer.write(chunk);
    const result = await writer.finalize();
    expect(result.dataBytes).toBe(chunk.length);
    expect(result.bytes).toBe(44 + chunk.length);
    expect(result.durationMs).toBe(1000);
    const inspected = await inspectWav(file);
    expect(inspected.sampleRate).toBe(48_000);
    expect(inspected.channels).toBe(2);
    expect(inspected.dataBytes).toBe(chunk.length);
    const raw = await fsp.readFile(file);
    expect(raw.toString("ascii", 0, 4)).toBe("RIFF");
    expect(raw.toString("ascii", 8, 12)).toBe("WAVE");
    expect(raw.readUInt32LE(4)).toBe(36 + chunk.length);
    expect(raw.readUInt32LE(40)).toBe(chunk.length);
  });

  it("rejects oversized headers and negative data", () => {
    expect(() => wavHeader(-1)).toThrow();
    expect(() => wavHeader(0xffffffff)).toThrow();
  });

  it("keeps a zero-byte WAV diagnosable", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-wav-zero-"));
    const file = path.join(dir, "zero.wav");
    const writer = new WavWriter(file);
    const result = await writer.finalize();
    expect(result.dataBytes).toBe(0);
    expect(result.durationMs).toBe(0);
    expect((await fsp.stat(file)).size).toBe(44);
  });
});
