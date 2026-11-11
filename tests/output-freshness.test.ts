import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { outputFreshness } from "../src/server/freshness.js";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";

const roots: string[] = [];
const stores: Store[] = [];
afterEach(async () => {
  while (stores.length) stores.pop()!.close();
  while (roots.length) await fsp.rm(roots.pop()!, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-freshness-"));
  roots.push(root);
  await fsp.mkdir(path.join(root, "outputs"), { recursive: true });
  await fsp.mkdir(path.join(root, "discord"), { recursive: true });
  await fsp.mkdir(path.join(root, "stt"), { recursive: true });
  await fsp.mkdir(path.join(root, "foundry"), { recursive: true });
  await fsp.mkdir(path.join(root, "merged"), { recursive: true });
  return root;
}

async function writeAt(file: string, ms: number): Promise<void> {
  await fsp.writeFile(file, "{}\n");
  await fsp.utimes(file, new Date(ms), new Date(ms));
}

describe("output freshness", () => {
  it("does not report stale when no outputs exist", async () => {
    const root = await fixture();
    const result = await outputFreshness(root);
    expect(result.stale).toBe(false);
    expect(result.outputModifiedAtMs).toBeNull();
  });

  it("ignores heartbeat/live-state changes and fresh outputs", async () => {
    const root = await fixture();
    const now = Date.now();
    await writeAt(path.join(root, "outputs", "notes-ready.md"), now - 20_000);
    await writeAt(path.join(root, "foundry", "live-state.json"), now);
    await writeAt(path.join(root, "discord", "manifest.jsonl"), now - 60_000);
    const result = await outputFreshness(root);
    expect(result.stale).toBe(false);
  });

  it("detects new audio, transcripts, mapping, and timeline newer than outputs", async () => {
    const root = await fixture();
    const now = Date.now();
    await writeAt(path.join(root, "outputs", "notes-ready.md"), now - 60_000);
    await writeAt(path.join(root, "outputs", "chronology.md"), now - 55_000);
    await writeAt(path.join(root, "discord", "manifest.jsonl"), now - 30_000);
    await writeAt(path.join(root, "stt", "transcript.jsonl"), now - 25_000);
    await writeAt(path.join(root, "people.json"), now - 20_000);
    await writeAt(path.join(root, "merged", "timeline.jsonl"), now - 15_000);
    const result = await outputFreshness(root);
    expect(result.stale).toBe(true);
    expect(result.newerSources).toEqual(["new audio", "transcripts", "player mapping", "merged timeline"]);
    expect(result.reason).toContain("new audio");
  });

  it("detects Foundry events and ignores a source written in the same second", async () => {
    const root = await fixture();
    const now = Date.now();
    await writeAt(path.join(root, "outputs", "notes-ready.md"), now - 10_000);
    await writeAt(path.join(root, "foundry", "events.jsonl"), now - 9_500);
    expect((await outputFreshness(root)).stale).toBe(false);
    await writeAt(path.join(root, "foundry", "events.jsonl"), now);
    const result = await outputFreshness(root);
    expect(result.stale).toBe(true);
    expect(result.reason).toBe("Foundry events");
  });

  it("exposes stale new audio in session detail after a manifest append", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-stale-detail-"));
    roots.push(root);
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    stores.push(store);
    const manager = new SessionManager(config, store);
    const session = await manager.create({ title: "Stale Detail", participants: [], consent: { confirmed: true } });
    const dir = manager.sessionDir(session.sessionId);
    await fsp.mkdir(path.join(dir, "outputs"), { recursive: true });
    const now = Date.now();
    await writeAt(path.join(dir, "outputs", "notes-ready.md"), now);
    expect((await manager.detail(session.sessionId)).outputsStale).toBe(false);
    await writeAt(path.join(dir, "discord", "manifest.jsonl"), now + 2_000);
    const detail = await manager.detail(session.sessionId);
    expect(detail.outputsStale).toBe(true);
    expect(detail.outputsStaleReason).toBe("new audio");
  });
});
