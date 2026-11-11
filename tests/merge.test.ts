import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { FoundryEvent, Marker, PeopleFile, SessionRecord, TranscriptRecord } from "../src/core/types.js";
import { mergeSession } from "../src/core/merge.js";
import { renderSession } from "../src/core/render.js";

function session(_dir: string): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId: "2026-01-01-demo-world-test",
    title: "Merge Test",
    status: "captured",
    system: { id: "starwarsffg", version: "2.0" },
    world: { id: "swffg-cartel", title: "Cartel" },
    foundryVersion: "14.369.0",
    timeZone: "UTC",
    createdAtMs: 1793430000000,
    startedAtMs: 1793430300000,
    stoppedAtMs: 1793430600000,
    guild: null,
    voiceChannel: null,
    consent: { confirmed: true, confirmedAtMs: 1, confirmedBy: "GM", participants: [], notes: "" },
    merge: { filterMarginMs: 300000 },
    recording: {
      utteranceCount: 2,
      totalBytes: 100,
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
    }
  };
}

describe("merge and render", () => {
  it("merges speech, rolls, chat, and markers by absolute timestamp and renders outputs", async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-merge-"));
    await fsp.mkdir(path.join(dir, "stt"), { recursive: true });
    await fsp.mkdir(path.join(dir, "foundry"), { recursive: true });
    await fsp.mkdir(path.join(dir, "merged"), { recursive: true });
    await fsp.mkdir(path.join(dir, "outputs"), { recursive: true });
    const s = session(dir);

    const people: PeopleFile = {
      schema: "tablerecords.people/v1",
      sessionId: s.sessionId,
      people: [
        {
          personId: "p_alice",
          role: "player",
          discordUserId: "U_ALICE",
          discordName: "Alice",
          foundryUserId: "F_ALICE",
          foundryUserName: "Alice",
          character: "Veyra Sol",
          aliases: [],
          consent: true
        }
      ]
    };
    await fsp.writeFile(path.join(dir, "people.json"), JSON.stringify(people));

    const transcripts: TranscriptRecord[] = [
      {
        schema: "tablerecords.transcript/v1",
        sessionId: s.sessionId,
        utteranceId: "u1",
        sttJobId: "stt1",
        batchJobId: "job1",
        discordUserId: "U_ALICE",
        speaker: "Alice",
        character: "Veyra Sol",
        text: "I try the engineering check.",
        rawText: "I try the engineering check.",
        corrections: [],
        startMs: 1793430310000,
        endMs: 1793430312000,
        words: [],
        stt: {
          engine: "faster-whisper",
          engineVersion: "1.2.1",
          model: "large-v3-turbo",
          device: "cuda",
          computeType: "float16",
          language: "en",
          languageProbability: 1,
          avgLogprob: -0.3,
          noSpeechProb: 0.01
        },
        flags: [],
        createdAtMs: 1
      },
      {
        schema: "tablerecords.transcript/v1",
        sessionId: s.sessionId,
        utteranceId: "u2",
        sttJobId: "stt2",
        batchJobId: "job1",
        discordUserId: "U_ALICE",
        speaker: "Alice",
        character: "Veyra Sol",
        text: "noise",
        rawText: "noise",
        corrections: [],
        startMs: 1793430320000,
        endMs: 1793430320100,
        words: [],
        stt: {
          engine: "faster-whisper",
          engineVersion: "1.2.1",
          model: "large-v3-turbo",
          device: "cuda",
          computeType: "float16",
          language: "en",
          languageProbability: 1,
          avgLogprob: -2,
          noSpeechProb: 0.9
        },
        flags: ["no_speech"],
        createdAtMs: 1
      }
    ];
    await fsp.writeFile(path.join(dir, "stt", "transcript.jsonl"), transcripts.map((item) => JSON.stringify(item)).join("\n") + "\n");

    const event: FoundryEvent = {
      schema: "tablerecords.foundry-event/v1",
      sessionId: s.sessionId,
      eventId: "msg1",
      type: "roll",
      timestampMs: 1793430315000,
      author: { id: "F_ALICE", name: "Alice" },
      speaker: { alias: "Veyra Sol", actorId: "A1", actorName: "Veyra Sol", tokenName: "Veyra Sol" },
      system: "starwarsffg",
      systemVersion: "2.0",
      flavor: "Laser rifle attack",
      contentText: "Laser rifle attack",
      visibility: { whisper: [], blind: false },
      rolls: [
        {
          class: "RollFFG",
          formula: "2eP+1eA",
          total: 0,
          ffg: { success: 2, failure: 0, advantage: 1, threat: 0, triumph: 1, despair: 0, light: 0, dark: 0 },
          hasFFG: true
        }
      ],
      source: { kind: "macro", file: "foundry/export.json" }
    };
    await fsp.writeFile(path.join(dir, "foundry", "events.jsonl"), JSON.stringify(event) + "\n");

    const marker: Marker = {
      schema: "tablerecords.marker/v1",
      markerId: "m1",
      sessionId: s.sessionId,
      tsMs: 1793430305000,
      kind: "scene",
      label: "Cantina back room",
      createdAtMs: 1793430306000
    };
    await fsp.writeFile(path.join(dir, "markers.jsonl"), JSON.stringify(marker) + "\n");

    const merged = await mergeSession(dir, s);
    expect(merged.timeline.map((item) => item.type)).toEqual(["marker", "speech", "roll"]);
    expect(merged.timeline.map((item) => item.seq)).toEqual([1, 2, 3]);
    expect(merged.counts.excludedTranscripts).toBe(1);
    expect(merged.timeline[1]?.actor?.character).toBe("Veyra Sol");
    expect(merged.timeline[2]?.roll?.summary).toContain("2 Successes");

    const rendered = await renderSession(dir, s);
    expect(rendered.files.map((file) => file.name)).toEqual([
      "transcript.md",
      "chronology.md",
      "rolls.csv",
      "roll-sync.md",
      "mental-notes.md",
      "stats.md",
      "notes-ready.md"
    ]);
    const chronology = await fsp.readFile(path.join(dir, "outputs", "chronology.md"), "utf8");
    expect(chronology).toContain("MARKER");
    expect(chronology).toContain("I try the engineering check.");
    expect(chronology).toContain("2 Successes, 1 Advantage, 1 Triumph");
    expect(chronology).not.toContain("noise");
    const csv = await fsp.readFile(path.join(dir, "outputs", "rolls.csv"), "utf8");
    expect(csv.split("\r\n")).toHaveLength(2);
    expect(csv).toContain("msg1");
    const stats = await fsp.readFile(path.join(dir, "outputs", "stats.md"), "utf8");
    expect(stats).toContain("Alice");
    expect(stats).toContain("Speech utterances | 1");
    const notes = await fsp.readFile(path.join(dir, "outputs", "notes-ready.md"), "utf8");
    expect(notes).toContain("Event log for the GM");
    expect(notes).toContain("## Cast");
    expect(notes).toContain("## Timeline");
    expect(notes).toContain("I try the engineering check.");
    expect(notes).toContain("2 Successes");
    expect(notes).not.toContain("sourceId:");
  });
});


