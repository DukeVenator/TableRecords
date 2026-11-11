import { afterEach, describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { loadConfig } from "../src/server/config.js";
import { Store } from "../src/server/store.js";
import { SessionManager } from "../src/server/sessions.js";
import { JobRunner } from "../src/server/jobs.js";
import type { FoundryEvent, Job, TranscriptRecord } from "../src/core/types.js";

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function waitForJob(runner: JobRunner, store: Store, jobId: string): Promise<Job> {
  for (let index = 0; index < 200; index += 1) {
    const job = store.getJob(jobId);
    if (job && ["done", "failed", "cancelled"].includes(job.status)) {
      // Let the runner's finally/refreshSessionStatus complete before returning.
      await new Promise((resolve) => setTimeout(resolve, 20));
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for job ${jobId}`);
}

describe("job runner", () => {
  it("moves merge → render through persisted states and writes outputs", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-jobs-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    const sessions = new SessionManager(config, store);
    const runner = new JobRunner(config, store, sessions, () => undefined);
    cleanup.push(async () => {
      await runner.shutdown();
      store.close();
      await fsp.rm(root, { recursive: true, force: true });
    });

    const session = await sessions.create({
      title: "Job Test",
      world: {
        id: "swffg-cartel",
        title: "Cartel",
        system: "starwarsffg",
        systemVersion: "2.0",
        foundryVersion: "14.369.0",
        path: ""
      },
      participants: [{ discordUserId: "U1", discordName: "Alice", character: "Veyra" }],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const dir = sessions.sessionDir(session.sessionId);
    const transcript: TranscriptRecord = {
      schema: "tablerecords.transcript/v1",
      sessionId: session.sessionId,
      utteranceId: "u_job",
      sttJobId: "stt_job",
      batchJobId: "job_source",
      discordUserId: "U1",
      speaker: "Alice",
      character: "Veyra",
      text: "The airlock is open.",
      rawText: "The airlock is open.",
      corrections: [],
      startMs: 1793430310000,
      endMs: 1793430311500,
      words: [],
      stt: {
        engine: "faster-whisper",
        engineVersion: "1.2.1",
        model: "large-v3-turbo",
        device: "cuda",
        computeType: "float16",
        language: "en",
        languageProbability: 1,
        avgLogprob: -0.2,
        noSpeechProb: 0.01
      },
      flags: [],
      createdAtMs: Date.now()
    };
    await fsp.writeFile(path.join(dir, "stt", "transcript.jsonl"), `${JSON.stringify(transcript)}\n`, "utf8");
    await sessions.setStatus(session, "captured", {
      startedAtMs: 1793430300000,
      stoppedAtMs: 1793430400000
    });

    const merge = await runner.enqueue(session.sessionId, "merge");
    const merged = await waitForJob(runner, store, merge.jobId);
    expect(merged.status).toBe("done");
    expect(merged.progress.percent).toBe(100);
    await expect(fsp.access(path.join(dir, "merged", "timeline.jsonl"))).resolves.toBeUndefined();

    const render = await runner.enqueue(session.sessionId, "render");
    const rendered = await waitForJob(runner, store, render.jobId);
    expect(rendered.status).toBe("done");
    for (const file of [
      "notes-ready.md",
      "chronology.md",
      "transcript.md",
      "rolls.csv",
      "roll-sync.md",
      "mental-notes.md",
      "stats.md"
    ]) {
      await expect(fsp.access(path.join(dir, "outputs", file))).resolves.toBeUndefined();
    }
    const after = await sessions.get(session.sessionId);
    expect(after.status).toBe("ready");
    const log = await fsp.readFile(path.join(dir, render.logFile), "utf8");
    expect(log).toContain("Job completed");

    const retry = await runner.retry(rendered.jobId);
    const retried = await waitForJob(runner, store, retry.jobId);
    expect(retried.status).toBe("done");
    expect(retried.jobId).not.toBe(rendered.jobId);
  });

  it("merges a session that only has live Foundry events", async () => {
    const root = await fsp.mkdtemp(path.join(os.tmpdir(), "tablerecords-live-jobs-"));
    const config = loadConfig({
      projectRoot: root,
      dataDir: path.join(root, "data"),
      sessionsDir: path.join(root, "sessions"),
      modelsDir: path.join(root, "models")
    });
    const store = new Store(config.dbFile);
    const sessions = new SessionManager(config, store);
    const runner = new JobRunner(config, store, sessions, () => undefined);
    cleanup.push(async () => {
      await runner.shutdown();
      store.close();
      await fsp.rm(root, { recursive: true, force: true });
    });

    const session = await sessions.create({
      title: "Live-only job",
      world: {
        id: "swffg-cartel",
        title: "Cartel",
        system: "starwarsffg",
        systemVersion: "2.0",
        foundryVersion: "14.369.0",
        path: ""
      },
      participants: [],
      consent: { confirmed: true, confirmedBy: "GM" }
    });
    const dir = sessions.sessionDir(session.sessionId);
    const event: FoundryEvent = {
      schema: "tablerecords.foundry-event/v1",
      sessionId: session.sessionId,
      eventId: "live-only-1",
      type: "chat",
      timestampMs: 1_793_430_320_000,
      author: { id: "F1", name: "Alice" },
      speaker: { alias: "Veyra", actorId: "A1", actorName: "Veyra", tokenName: "Veyra" },
      system: "starwarsffg",
      systemVersion: "2.0",
      flavor: null,
      contentText: "Only the live bridge caught this.",
      visibility: { whisper: [], blind: false },
      rolls: [],
      source: { kind: "module", file: "foundry/live-events.jsonl" }
    };
    await fsp.writeFile(path.join(dir, "foundry", "live-events.jsonl"), `${JSON.stringify(event)}\n`, "utf8");
    await sessions.setStatus(session, "captured", {
      startedAtMs: 1_793_430_300_000,
      stoppedAtMs: 1_793_430_400_000
    });

    const merge = await runner.enqueue(session.sessionId, "merge");
    const merged = await waitForJob(runner, store, merge.jobId);
    expect(merged.status).toBe("done");
    const timeline = await fsp.readFile(path.join(dir, "merged", "timeline.jsonl"), "utf8");
    expect(timeline).toContain("Only the live bridge caught this.");

    const render = await runner.enqueue(session.sessionId, "render");
    const rendered = await waitForJob(runner, store, render.jobId);
    expect(rendered.status).toBe("done");
    await expect(fsp.access(path.join(dir, "outputs", "chronology.md"))).resolves.toBeUndefined();

    const all = await runner.enqueue(session.sessionId, "run_all");
    const allDone = await waitForJob(runner, store, all.jobId);
    expect(allDone.status).toBe("done");
    expect(allDone.result).toMatchObject({ merge: { chat: 1 } });
  });
});
