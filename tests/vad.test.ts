import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { VoiceActivityMeter, amplitudeToDbfs, isSilentUtterance } from "../src/core/vad.js";
import { trimWavTrailingSilence, wavHeader } from "../src/core/wav.js";

const RATE = 48_000;
const CHANNELS = 2;

function tone(ms: number, amplitude: number): Buffer {
  const frames = Math.round((RATE * ms) / 1000);
  const buffer = Buffer.alloc(frames * CHANNELS * 2);
  for (let frame = 0; frame < frames; frame += 1) {
    const value = Math.round(Math.sin((2 * Math.PI * 440 * frame) / RATE) * amplitude * 32767);
    buffer.writeInt16LE(value, frame * 4);
    buffer.writeInt16LE(value, frame * 4 + 2);
  }
  return buffer;
}

function silence(ms: number): Buffer {
  return Buffer.alloc(Math.round((RATE * ms) / 1000) * CHANNELS * 2);
}

describe("voice activity meter", () => {
  it("measures voiced frames and reports dBFS", () => {
    const meter = new VoiceActivityMeter();
    meter.write(tone(500, 0.2));
    meter.write(silence(500));
    const stats = meter.stats();
    expect(stats.frames).toBe(50);
    expect(stats.voicedMs).toBeGreaterThanOrEqual(480);
    expect(stats.voicedMs).toBeLessThanOrEqual(520);
    expect(stats.totalMs).toBe(1000);
    expect(stats.peakDbfs).toBeGreaterThan(-20);
    expect(stats.rmsDbfs).toBeLessThan(0);
  });

  it("keeps partial frames across arbitrary chunk boundaries", () => {
    const meter = new VoiceActivityMeter();
    const payload = tone(200, 0.1);
    let offset = 0;
    while (offset < payload.length) {
      const size = Math.min(777, payload.length - offset);
      meter.write(payload.subarray(offset, offset + size));
      offset += size;
    }
    const stats = meter.stats();
    expect(stats.voicedMs).toBe(200);
    expect(stats.totalMs).toBe(200);
  });

  it("does not call room tone voiced", () => {
    const meter = new VoiceActivityMeter();
    meter.write(silence(2000));
    const stats = meter.stats();
    expect(stats.voicedMs).toBe(0);
    expect(stats.peakDbfs).toBe(-120);
    expect(isSilentUtterance(stats, { minVoicedMs: 200 })).toBe(true);
  });

  it("converts amplitude to dBFS with a floor", () => {
    expect(amplitudeToDbfs(1)).toBe(0);
    expect(amplitudeToDbfs(0.5)).toBeCloseTo(-6.02, 1);
    expect(amplitudeToDbfs(0)).toBe(-120);
  });
});

describe("trailing silence trim", () => {
  it("removes only trailing silence and keeps a padding window", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-trim-"));
    const file = path.join(dir, "clip.wav");
    const voice = tone(500, 0.2);
    const data = Buffer.concat([voice, silence(2000)]);
    await fsp.writeFile(file, Buffer.concat([wavHeader(data.length), data]));

    const result = await trimWavTrailingSilence(file, { paddingMs: 300 });
    expect(result.trimmedMs).toBeGreaterThan(1500);
    expect(result.trimmedMs).toBeLessThan(1800);
    expect(result.durationMs).toBeGreaterThan(700);
    expect(result.durationMs).toBeLessThan(900);
    const raw = await fsp.readFile(file);
    expect(raw.length).toBe(44 + result.dataBytes);
    expect(raw.readUInt32LE(40)).toBe(result.dataBytes);
    // The leading voiced samples are untouched.
    expect(raw.readInt16LE(44 + 100 * 4)).toBe(voice.readInt16LE(100 * 4));
  });

  it("leaves a clip alone when it has no trailing silence to remove", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-trim-none-"));
    const file = path.join(dir, "clip.wav");
    const data = tone(400, 0.2);
    await fsp.writeFile(file, Buffer.concat([wavHeader(data.length), data]));
    const result = await trimWavTrailingSilence(file, { paddingMs: 300 });
    expect(result.trimmedMs).toBe(0);
    expect(result.dataBytes).toBe(data.length);
  });

  it("shortens a fully silent clip to the padding window", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-trim-silent-"));
    const file = path.join(dir, "clip.wav");
    const data = silence(2000);
    await fsp.writeFile(file, Buffer.concat([wavHeader(data.length), data]));
    const result = await trimWavTrailingSilence(file, { paddingMs: 300 });
    expect(result.durationMs).toBeGreaterThanOrEqual(280);
    expect(result.durationMs).toBeLessThanOrEqual(320);
    expect(result.trimmedMs).toBeGreaterThan(1600);
  });
});
