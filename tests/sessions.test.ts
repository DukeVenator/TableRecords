import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { inspectWav } from "../src/core/wav.js";

const cleanups: Array<() => void> = [];

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("session manager", () => {
  it("creates a canonical session directory, people mapping, and marker mirror", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-session-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    cleanups.push(() => store.close());
    const manager = new SessionManager(config, store);
    const session = await manager.create({
      title: "Test Session",
      world: {
        id: "swffg-cartel",
        title: "Cartel",
        system: "starwarsffg",
        systemVersion: "2.0",
        foundryVersion: "14.369.0",
        path: ""
      },
      guild: { id: "g1", name: "Table" },
      voiceChannel: { id: "v1", name: "Voice" },
      participants: [
        { discordUserId: "U1", discordName: "Alice", character: "Veyra", role: "player", consent: true },
        { discordUserId: "U2", discordName: "GM", role: "gm", consent: true }
      ],
      consent: { confirmed: true, confirmedBy: "GM", notes: "All agreed." },
      notes: "Test notes"
    });
    expect(session.status).toBe("draft");
    expect(session.sessionId).toMatch(/^\d{4}-\d{2}-\d{2}-swffg-cartel-test-session/);
    const dir = manager.sessionDir(session.sessionId);
    for (const relative of ["session.json", "people.json", "consent.md", "discord", "foundry", "stt", "merged", "outputs", "jobs"]) {
      await expect(fsp.access(path.join(dir, relative))).resolves.toBeUndefined();
    }
    const detail = await manager.detail(session.sessionId);
    expect(detail.people).toHaveLength(2);
    expect(detail.people[1]?.role).toBe("gm");
    const marker = await manager.addMarker(session.sessionId, "combat", 1793430310000, "Stormtroopers");
    expect(marker.kind).toBe("combat");
    const markersFile = await fsp.readFile(path.join(dir, "markers.jsonl"), "utf8");
    expect(markersFile).toContain("Stormtroopers");
    expect(store.getSessionRow(session.sessionId)?.status).toBe("draft");
    expect(store.listMarkers(session.sessionId)).toHaveLength(1);
  });

  it("merges manual and spoken mental notes into session detail", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-session-notes-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    cleanups.push(() => store.close());
    const manager = new SessionManager(config, store);
    const session = await manager.create({
      title: "Notes",
      participants: [],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const dir = manager.sessionDir(session.sessionId);
    await fsp.writeFile(
      path.join(dir, "stt", "transcript.jsonl"),
      `${JSON.stringify({
        schema: "tablerecords.transcript/v1",
        sessionId: session.sessionId,
        utteranceId: "u_note",
        sttJobId: "stt_note",
        batchJobId: "job",
        discordUserId: "U1",
        speaker: "GM",
        character: null,
        text: "Mental note: the crime lord owes us a favour.",
        rawText: "Mental note: the crime lord owes us a favour.",
        corrections: [],
        startMs: 1_793_430_310_000,
        endMs: 1_793_430_312_000,
        words: [],
        stt: { engine: "fake", engineVersion: "1", model: "m", device: "cpu", computeType: "int8", language: "en", languageProbability: 1, avgLogprob: -0.1, noSpeechProb: 0 },
        flags: [],
        createdAtMs: 1
      })}\n`,
      "utf8"
    );
    await manager.addMarker(session.sessionId, "note", 1_793_430_315_000, "Manual reminder", true);
    const detail = await manager.detail(session.sessionId);
    expect(detail.mentalNotes.map((note) => [note.source, note.text])).toEqual([
      ["spoken", "the crime lord owes us a favour."],
      ["manual", "Manual reminder"]
    ]);
  });

  it("archives, restores, and deletes sessions without removing active recordings", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-session-archive-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    cleanups.push(() => store.close());
    const manager = new SessionManager(config, store);
    const session = await manager.create({ title: "Archive me", participants: [], consent: { confirmed: true } });
    const dir = manager.sessionDir(session.sessionId);
    const archived = await manager.setArchived(session.sessionId, true);
    expect(archived.archived).toBe(true);
    expect(store.getSessionRow(session.sessionId)?.archived).toBe(1);
    expect((await manager.get(session.sessionId)).archived).toBe(true);
    await manager.setArchived(session.sessionId, false);
    expect((await manager.get(session.sessionId)).archived).toBe(false);

    await manager.setStatus(session, "recording", { startedAtMs: Date.now() });
    await expect(manager.deleteSession(session.sessionId)).rejects.toMatchObject({ code: "invalid_state" });
    await manager.setStatus(session, "captured", { stoppedAtMs: Date.now() });
    await manager.deleteSession(session.sessionId);
    await expect(fsp.access(dir)).rejects.toBeTruthy();
    expect(store.getSessionRow(session.sessionId)).toBeNull();
  });

  it("marks an interrupted recording as error on restart instead of pretending it is active", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-recover-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    cleanups.push(() => store.close());
    const manager = new SessionManager(config, store);
    const session = await manager.create({
      title: "Interrupted",
      world: {
        id: "swffg-cartel",
        title: "Cartel",
        system: "starwarsffg",
        systemVersion: "2.0",
        foundryVersion: null,
        path: ""
      },
      consent: { confirmed: true },
      participants: []
    });
    await manager.setStatus(session, "recording", { startedAtMs: Date.now() });
    const recovered = await manager.reconcileOnStartup();
    expect(recovered.interrupted).toBe(1);
    expect(recovered.needsProcessing).toEqual([]);
    const after = await manager.get(session.sessionId);
    expect(after.status).toBe("error");
    expect(after.stoppedAtMs).toBeTruthy();
    expect(after.notes).toContain("Interrupted capture recovered");
  });

  it("keeps participant IDs unique when multiple sessions share a player name", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-session-unique-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    cleanups.push(() => store.close());
    const manager = new SessionManager(config, store);
    const world = {
      id: "swffg-cartel",
      title: "Cartel",
      system: "starwarsffg",
      systemVersion: "2.0",
      foundryVersion: null,
      path: ""
    };
    const first = await manager.create({ title: "First", world, participants: [{ discordUserId: "U1", discordName: "Alice" }] });
    const second = await manager.create({ title: "Second", world, participants: [{ discordUserId: "U1", discordName: "Alice" }] });
    const firstPeople = (await manager.detail(first.sessionId)).people;
    const secondPeople = (await manager.detail(second.sessionId)).people;
    expect(firstPeople).toHaveLength(1);
    expect(secondPeople).toHaveLength(1);
    expect(firstPeople[0]?.personId).not.toBe(secondPeople[0]?.personId);
    expect(store.listSessionRows()).toHaveLength(2);
  });

  it("repairs an unfinalized WAV and appends a recoverable manifest record", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-wav-recovery-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    cleanups.push(() => store.close());
    const manager = new SessionManager(config, store);
    const session = await manager.create({
      title: "Crash Recovery",
      world: {
        id: "swffg-cartel",
        title: "Cartel",
        system: "starwarsffg",
        systemVersion: "2.0",
        foundryVersion: null,
        path: ""
      },
      consent: { confirmed: true },
      participants: [{ discordUserId: "U1", discordName: "Alice" }]
    });
    const dir = manager.sessionDir(session.sessionId);
    const audioDir = path.join(dir, "discord", "audio", "U1");
    await fsp.mkdir(audioDir, { recursive: true });
    const startMs = 1793430365000;
    const file = path.join(audioDir, `${startMs}-u_recover.wav`);
    const pcm = Buffer.alloc(48_000 * 2 * 2, 0);
    await fsp.writeFile(file, Buffer.concat([Buffer.alloc(44), pcm]));
    await manager.setStatus(session, "recording", { startedAtMs: startMs });
    const result = await manager.reconcileOnStartup();
    expect(result.interrupted).toBe(1);
    expect(result.needsProcessing).toContain(session.sessionId);
    const manifest = (await fsp.readFile(path.join(dir, "discord", "manifest.jsonl"), "utf8")).trim().split(/\r?\n/);
    expect(manifest).toHaveLength(1);
    const record = JSON.parse(manifest[0]!) as { utteranceId: string; bytes: number; durationMs: number; streamEnd: string };
    expect(record.utteranceId).toBe("u_recover");
    expect(record.streamEnd).toBe("error");
    expect(record.bytes).toBe(44 + pcm.length);
    expect(record.durationMs).toBe(1000);
    const info = await inspectWav(file);
    expect(info.dataBytes).toBe(pcm.length);
    expect(info.durationMs).toBe(1000);
  });
});
