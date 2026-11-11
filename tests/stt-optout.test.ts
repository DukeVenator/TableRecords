import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { runSttBatch } from "../src/server/sttBatch.js";
import type { DiscordUtterance, PeopleFile, SessionRecord } from "../src/core/types.js";

function session(sessionId: string): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId,
    title: "STT Opt-out Test",
    status: "captured",
    system: { id: "starwarsffg", version: "2.0" },
    world: { id: "swffg-cartel", title: "Cartel" },
    foundryVersion: "14.369.0",
    timeZone: "UTC",
    createdAtMs: 1,
    startedAtMs: 1,
    stoppedAtMs: 2,
    guild: null,
    voiceChannel: null,
    consent: {
      confirmed: true,
      confirmedAtMs: 1,
      confirmedBy: "Foundry",
      participants: ["U1", "U2"],
      notes: "",
      method: "foundry"
    },
    merge: { filterMarginMs: 300_000 },
    recording: {
      utteranceCount: 2,
      totalBytes: 100,
      decryptionFailures: 0,
      reconnectCount: 0,
      nodeVersion: "26",
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
    }
  };
}

describe("STT opt-out filtering", () => {
  it("never sends an opted-out player's clips to the model", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-stt-optout-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models"),
      pythonPath: path.join(root, "missing-python.exe"),
      sttEngine: "faster-whisper"
    });
    const sessionId = "2026-11-01-stt-optout";
    const sessionDir = path.join(root, "sessions", sessionId);
    await fsp.mkdir(path.join(sessionDir, "stt"), { recursive: true });
    const people: PeopleFile = {
      schema: "tablerecords.people/v1",
      sessionId,
      people: [
        {
          personId: "p1",
          role: "player",
          discordUserId: "U1",
          discordName: "Alice",
          foundryUserId: null,
          foundryUserName: null,
          character: "Veyra",
          aliases: [],
          consent: true,
          consentStatus: "assumed"
        },
        {
          personId: "p2",
          role: "player",
          discordUserId: "U2",
          discordName: "Bob",
          foundryUserId: null,
          foundryUserName: null,
          character: "Korrin",
          aliases: [],
          consent: false,
          consentStatus: "opted_out"
        }
      ]
    };
    await fsp.writeFile(path.join(sessionDir, "people.json"), JSON.stringify(people));
    const utterances: DiscordUtterance[] = [
      {
        schema: "tablerecords.discord-utterance/v1",
        sessionId,
        utteranceId: "u1",
        discordUserId: "U2",
        displayName: "Bob",
        file: "discord/audio/U2/u1.wav",
        startMs: 1,
        endMs: 2,
        durationMs: 1,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: 44,
        streamEnd: "silence",
        decryptionFailures: 0,
        createdAtMs: 1
      }
    ];
    const result = await runSttBatch({
      config,
      session: session(sessionId),
      sessionDir,
      utterances,
      batchJobId: "test"
    });
    expect(result.records).toEqual([]);
    expect(result.skippedOptOut).toBe(1);
    expect(result.written).toBe(0);
  });
});

