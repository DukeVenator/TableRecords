/**
 * Seed a deterministic demo session with synthetic audio, a transcript, and a
 * FFG narrative-dice macro export. No Discord or GPU needed.
 *
 *   npm run demo
 */
import fsp from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { WavWriter } from "../src/core/wav.js";
import type { DiscordUtterance, TranscriptRecord } from "../src/core/types.js";
import { importFoundryExport } from "../src/core/foundry/import.js";
import { mergeSession } from "../src/core/merge.js";
import { renderSession } from "../src/core/render.js";
import { newPersonId } from "../src/core/ids.js";

const START = 1793430300000;
const STOP = 1793430480000;

function sinePcm(durationMs: number, frequency: number, rate = 48_000, channels = 2): Buffer {
  const frames = Math.round((durationMs / 1000) * rate);
  const buf = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const envelope = Math.min(1, i / (rate * 0.02), (frames - i) / (rate * 0.02));
    const value = Math.round(Math.sin(2 * Math.PI * frequency * t) * 0.16 * 32767 * Math.max(0, envelope));
    buf.writeInt16LE(value, i * channels * 2);
    buf.writeInt16LE(value, i * channels * 2 + 2);
  }
  return buf;
}

async function writeUtterance(
  sessionDir: string,
  user: string,
  utteranceId: string,
  startMs: number,
  durationMs: number,
  frequency: number
): Promise<DiscordUtterance> {
  const rel = `discord/audio/${user}/${startMs}-${utteranceId}.wav`;
  const writer = new WavWriter(path.join(sessionDir, rel));
  await writer.write(sinePcm(durationMs, frequency));
  const result = await writer.finalize();
  return {
    schema: "tablerecords.discord-utterance/v1",
    sessionId: "demo",
    utteranceId,
    discordUserId: user,
    displayName: user === "USERALICE00000000001" ? "Alice" : user === "USERBEN0000000000002" ? "Ben" : "GM",
    file: rel,
    startMs,
    endMs: startMs + result.durationMs,
    durationMs: result.durationMs,
    sampleRate: 48_000,
    channels: 2,
    format: "wav",
    encoding: "pcm_s16le",
    bytes: result.bytes,
    streamEnd: "silence",
    decryptionFailures: 0,
    createdAtMs: startMs + result.durationMs + 500
  };
}

function transcript(
  sessionId: string,
  utterance: DiscordUtterance,
  person: { speaker: string; character: string | null },
  text: string
): TranscriptRecord {
  return {
    schema: "tablerecords.transcript/v1",
    sessionId,
    utteranceId: utterance.utteranceId,
    sttJobId: `stt_demo_${utterance.utteranceId}`,
    batchJobId: "job_demo",
    discordUserId: utterance.discordUserId,
    speaker: person.speaker,
    character: person.character,
    text,
    rawText: text,
    corrections: [],
    startMs: utterance.startMs,
    endMs: utterance.endMs,
    words: [],
    stt: {
      engine: "faster-whisper",
      engineVersion: "demo",
      model: "demo",
      device: "cpu",
      computeType: "int8",
      language: "en",
      languageProbability: 1,
      avgLogprob: -0.2,
      noSpeechProb: 0.01
    },
    flags: [],
    createdAtMs: Date.now()
  };
}

async function main(): Promise<void> {
  const config = loadConfig();
  const store = new Store(config.dbFile);
  const sessions = new SessionManager(config, store);
  const session = await sessions.create({
    title: "Demo — Table Session",
    world: {
      id: "swffg-cartel",
      title: "Demo World",
      system: "starwarsffg",
      systemVersion: "2.0",
      foundryVersion: "14.369.0",
      path: ""
    },
    guild: { id: "demo-guild", name: "Demo Table" },
    voiceChannel: { id: "demo-voice", name: "Demo Table" },
    participants: [
      { discordUserId: "USERALICE00000000001", discordName: "Alice", character: "Veyra Sol", role: "player" },
      { discordUserId: "USERBEN0000000000002", discordName: "Ben", character: "Korrin", role: "player" },
      { discordUserId: "GMUSER0000000000000", discordName: "GM", role: "gm" }
    ],
    consent: {
      confirmed: true,
      confirmedBy: "GM",
      notes: "Demo session; synthetic audio and fixture Foundry export. No real participants."
    },
    notes: "Seeded by npm run demo for dashboard and pipeline verification."
  });
  const dir = sessions.sessionDir(session.sessionId);
  const people = [
    {
      personId: newPersonId("alice"),
      role: "player" as const,
      discordUserId: "USERALICE00000000001",
      discordName: "Alice",
      foundryUserId: "USERALICE00000000001",
      foundryUserName: "Alice",
      character: "Veyra Sol",
      aliases: ["Al"],
      consent: true
    },
    {
      personId: newPersonId("ben"),
      role: "player" as const,
      discordUserId: "USERBEN0000000000002",
      discordName: "Ben",
      foundryUserId: "USERBEN0000000000002",
      foundryUserName: "Ben",
      character: "Korrin",
      aliases: [],
      consent: true
    },
    {
      personId: newPersonId("gm"),
      role: "gm" as const,
      discordUserId: "GMUSER0000000000000",
      discordName: "GM",
      foundryUserId: "GMUSER0000000000000",
      foundryUserName: "GM",
      character: null,
      aliases: [],
      consent: true
    }
  ];
  await sessions.updatePeople(session.sessionId, people);

  const alice = await writeUtterance(dir, "USERALICE00000000001", "u_demo_alice", START + 65_000, 2_200, 220);
  const ben = await writeUtterance(dir, "USERBEN0000000000002", "u_demo_ben", START + 70_000, 1_800, 330);
  const gm = await writeUtterance(dir, "GMUSER0000000000000", "u_demo_gm", START + 80_000, 2_500, 440);
  const note = await writeUtterance(dir, "USERALICE00000000001", "u_demo_note", START + 95_000, 1_900, 260);
  for (const utterance of [alice, ben, gm, note]) {
    utterance.sessionId = session.sessionId;
  }
  const manifest = [alice, ben, gm, note];
  await fsp.writeFile(
    path.join(dir, "discord", "manifest.jsonl"),
    manifest.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8"
  );
  const transcripts = [
    transcript(session.sessionId, alice, { speaker: "Alice", character: "Veyra Sol" }, "I'll try the engineering check on the airlock."),
    transcript(session.sessionId, ben, { speaker: "Ben", character: "Korrin" }, "Cover me. I'm slicing the terminal."),
    transcript(session.sessionId, gm, { speaker: "GM", character: null }, "The cantina goes quiet as the Imperials enter. Everyone give me a Perception check."),
    transcript(session.sessionId, note, { speaker: "Alice", character: "Veyra Sol" }, "Mental note: the crime lord owes us a favour.")
  ];
  await fsp.writeFile(
    path.join(dir, "stt", "transcript.jsonl"),
    transcripts.map((item) => JSON.stringify(item)).join("\n") + "\n",
    "utf8"
  );

  const captured = await sessions.setStatus(session, "captured", {
    startedAtMs: START,
    stoppedAtMs: STOP,
    merge: { ...session.merge, filterMarginMs: 0 },
    recording: {
      ...session.recording,
      utteranceCount: manifest.length,
      totalBytes: manifest.reduce((sum, item) => sum + item.bytes, 0)
    }
  });
  await sessions.addMarker(session.sessionId, "scene", START + 90_000, "Cantina back room");
  await sessions.addMarker(session.sessionId, "combat", START + 110_000, "Stormtroopers arrive");
  await sessions.addMarker(session.sessionId, "note", START + 100_000, "Remember the hidden door", true);

  const raw = await fsp.readFile(path.join(config.projectRoot, "tests", "fixtures", "foundry", "starwars-export.json"), "utf8");
  const summary = await importFoundryExport({ sessionDir: dir, session: captured, rawText: raw });
  const merged = await mergeSession(dir, captured);
  const rendered = await renderSession(dir, captured);
  await sessions.setStatus(captured, "ready");

  console.log(`Demo session: ${session.sessionId}`);
  console.log(`Directory:    ${dir}`);
  console.log(`Foundry:      ${summary.messageCount} messages, ${summary.rollCount} rolls`);
  console.log(`Timeline:     ${merged.timeline.length} events`);
  console.log(`Outputs:      ${rendered.files.map((file) => file.name).join(", ")}`);
  store.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
