import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { SessionRecord } from "../src/core/types.js";
import { buildFoundryImport, FoundryImportError } from "../src/core/foundry/import.js";
import { buildLiveFoundryEvents } from "../src/core/foundry/live.js";
import { formatFfg, summarizeRoll } from "../src/core/foundry/adapters.js";
import { htmlToText } from "../src/core/text.js";

const fixtures = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixtures", "foundry");

function session(overrides: Partial<SessionRecord> = {}): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId: "2026-01-01-demo-world-demo-session",
    title: "Test",
    status: "captured",
    system: { id: "starwarsffg", version: "2.0" },
    world: { id: "swffg-cartel", title: "Cartel" },
    foundryVersion: "14.369.0",
    timeZone: "UTC",
    createdAtMs: 1793430000000,
    startedAtMs: 1793430300000,
    stoppedAtMs: 1793430480000,
    guild: { id: "g", name: "G" },
    voiceChannel: { id: "v", name: "V" },
    consent: { confirmed: true, confirmedAtMs: 1, confirmedBy: "GM", participants: [], notes: "" },
    merge: { filterMarginMs: 0 },
    recording: {
      utteranceCount: 0,
      totalBytes: 0,
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
    },
    ...overrides
  };
}

describe("FFG narrative-dice import and rendering", () => {
  it("imports prepared rolls, filters the session window, and preserves ffg symbols", async () => {
    const raw = await fsp.readFile(path.join(fixtures, "starwars-export.json"), "utf8");
    const built = buildFoundryImport(raw, session());
    expect(built.summary.messageCount).toBe(3);
    expect(built.summary.rollMessageCount).toBe(2);
    expect(built.summary.rollCount).toBe(2);
    expect(built.summary.outOfWindowCount).toBe(1);
    expect(built.summary.system.id).toBe("starwarsffg");
    expect(built.events.every((event) => event.schema === "tablerecords.foundry-event/v1")).toBe(true);
    const first = built.events.find((event) => event.eventId === "msg_ffg_001");
    expect(first?.type).toBe("roll");
    const summary = summarizeRoll(first?.rolls[0], "starwarsffg");
    expect(summary.ffg).toMatchObject({ success: 2, advantage: 1, triumph: 1 });
    expect(summary.summary).toBe("2 Successes, 1 Advantage, 1 Triumph");
    expect(summary.warnings).toEqual([]);
    const chat = built.events.find((event) => event.eventId === "msg_ffg_003");
    expect(chat?.type).toBe("chat");
    expect(chat?.contentText).toContain("Imperials");
    expect(chat?.visibility.whisper).toContain("GMUSER0000000000000");
  });

  it("never uses numeric total as a FFG outcome and warns when ffg is absent", () => {
    const result = summarizeRoll({ class: "RollFFG", formula: "1eP", total: 42 }, "starwarsffg");
    expect(result.summary).toContain("symbols unavailable");
    expect(result.warnings).toContain("ffg_missing");
    expect(result.summary).not.toContain("42");
  });

  it("formats added results separately", () => {
    expect(
      formatFfg(
        { success: 1, failure: 0, advantage: 0, threat: 0, triumph: 0, despair: 0, light: 0, dark: 0 },
        [{ symbol: "Boost", value: 1 }]
      )
    ).toBe("1 Success (added +1 Boost)");
  });
});

describe("SFRPG import and generic rendering", () => {
  it("uses total/formula and preserves multiple rolls per message", async () => {
    const raw = await fsp.readFile(path.join(fixtures, "sfrpg-export.json"), "utf8");
    const base = session({
      system: { id: "sfrpg", version: "14.0.2" },
      world: { id: "demo-world", title: "Demo World" },
      startedAtMs: 1792817600000,
      stoppedAtMs: 1792817900000
    });
    const built = buildFoundryImport(raw, base);
    expect(built.summary.messageCount).toBe(2);
    expect(built.summary.rollCount).toBe(2);
    const first = built.events[0]!;
    expect(first.type).toBe("roll");
    expect(summarizeRoll(first.rolls[0], "sfrpg").total).toBe(33);
    expect(summarizeRoll(first.rolls[0], "sfrpg").summary).toContain("33 (1d20 + 19 + 2)");
    expect(summarizeRoll(built.events[1]!.rolls[0], "sfrpg").summary).toBe("8 (1d6 + 3)");
  });
});

describe("live Foundry messages", () => {
  it("recovers rollsRaw, filters invalid messages, and deduplicates ids", () => {
    const result = buildLiveFoundryEvents({
      session: session(),
      world: { id: "swffg-cartel", title: "Cartel" },
      system: { id: "starwarsffg", version: "2.0" },
      foundryVersion: "14.369.0",
      messages: [
        {
          messageId: "msg_live_raw",
          timestampMs: 1793430350000,
          author: { id: "u1", name: "Alice" },
          speaker: { alias: "Veyra" },
          content: "<p>Laser rifle</p>",
          rolls: [],
          rollsRaw: ['{"class":"RollFFG","formula":"2eP","ffg":{"success":2}}']
        },
        { messageId: "msg_live_raw", timestampMs: 1793430350000, rolls: [] },
        { messageId: "missing_timestamp", rolls: [] },
        { messageId: "outside", timestampMs: 1, rolls: [] }
      ]
    });
    expect(result.events).toHaveLength(1);
    expect(result.events[0]?.type).toBe("roll");
    expect(result.events[0]?.source.kind).toBe("module");
    expect(result.events[0]?.rolls[0]).toMatchObject({ class: "RollFFG" });
    expect(result.skipped).toBe(3);
  });
});

describe("validation and HTML conversion", () => {
  it("rejects unknown schemas", () => {
    expect(() => buildFoundryImport(JSON.stringify({ schema: "other", messages: [] }), session())).toThrow(FoundryImportError);
  });

  it("rejects invalid JSON", () => {
    expect(() => buildFoundryImport("{", session())).toThrow(/not valid JSON/);
  });

  it("converts Foundry chat HTML to compact text", () => {
    expect(htmlToText("<p>Hello &amp; <strong>welcome</strong></p><p>Second&nbsp;line</p>")).toBe("Hello & welcome\nSecond line");
  });
});




