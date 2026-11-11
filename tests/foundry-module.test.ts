import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const modulePath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "foundry-module",
  "scripts",
  "main.js"
);

async function loadBridge(
  overrides: Record<string, unknown> = {},
  fetchImpl?: (url: string, init: { body: string; headers: Record<string, string> }) => Promise<unknown>,
  breakTime: { active?: boolean; paused?: boolean; start?: number } = {}
): Promise<{
  context: Record<string, unknown>;
  requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }>;
  settings: Map<string, unknown>;
  breakSettings: Map<string, unknown>;
  hooks: Map<string, Array<(...args: unknown[]) => void>>;
  tableRecords: {
    flush: (force?: boolean) => Promise<unknown>;
    sendMentalNote: (text: string) => Promise<{ ok: boolean; reason?: string }>;
    queueStatus: () => { pending: number; flushing: boolean };
    breakState: () => { active: boolean; startedAtMs: number | null };
    openSetup: () => Promise<{ ok: boolean; reason?: string }>;
    generatePlayerDraft: (kind: string, windowSeconds: number) => Promise<{ ok: boolean; draft?: Record<string, unknown>; message?: string }>;
    publishPlayerPost: (draft: Record<string, unknown>, text: string) => Promise<{ ok: boolean; message?: string }>;
  };
  chatMessages: Array<Record<string, unknown>>;
}> {
  const source = await fsp.readFile(modulePath, "utf8");
  const once = new Map<string, (...args: unknown[]) => void>();
  const hooks = new Map<string, Array<(...args: unknown[]) => void>>();
  const settings = new Map<string, unknown>([
    ["dashboardUrl", "http://127.0.0.1:17300"],
    ["bridgeToken", "secret-bridge"],
    ["sessionId", ""],
    ["enabled", true],
    ["pushChat", true],
    ["pushRolls", true],
    ["followBreakTime", true],
    ["heartbeatSeconds", 30]
  ]);
  const breakSettings = new Map<string, unknown>([
    ["paused", breakTime.paused ?? false],
    ["start", breakTime.start ?? null]
  ]);
  for (const [key, value] of Object.entries(overrides)) settings.set(key, value);
  const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
  const chatMessages: Array<Record<string, unknown>> = [];
  const defaultFetch = async (url: string, init: { body: string; headers: Record<string, string> }) => {
    requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
    return {
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify({ accepted: true, acceptedMessages: 1, noteAccepted: true, eventsAccepted: 1, sessionId: "session-1" })
    };
  };
  const context = {
    console,
    Date,
    JSON,
    setTimeout: () => 1,
    clearTimeout: () => undefined,
    setInterval: () => 1,
    clearInterval: () => undefined,
    AbortController: undefined,
    fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => {
      const result = await (fetchImpl ? fetchImpl(url, init) : defaultFetch(url, init));
      if (fetchImpl) requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
      return result;
    },
    Hooks: {
      once: (name: string, fn: (...args: unknown[]) => void) => once.set(name, fn),
      on: (name: string, fn: (...args: unknown[]) => void) => {
        const list = hooks.get(name) ?? [];
        list.push(fn);
        hooks.set(name, list);
      }
    },
    game: {
      user: { id: "gm", name: "GM", isGM: true },
      users: {
        get: () => ({ id: "u1", name: "Alice" }),
        contents: [{ id: "u1", name: "Alice", isGM: false, character: { id: "a1", name: "Veyra" } }]
      },
      actors: {
        get: () => ({ id: "a1", name: "Veyra" }),
        contents: [{ id: "a1", name: "Veyra", type: "character", hasPlayerOwner: true }]
      },
      scenes: { current: { id: "s1", name: "Cantina" }, get: () => ({ id: "s1", name: "Cantina" }) },
      combat: null,
      paused: false,
      modules: {
        get: (id: string) =>
          id === "breaktime"
            ? { id, active: breakTime.active === true, version: "14.01" }
            : { id, active: false, version: "0.3.0" }
      },
      version: "14.369.0",
      world: { id: "world-a", title: "World A" },
      system: { id: "system-a", version: "1.0" },
      settings: {
        register: (_id: string, key: string, config: { default: unknown }) => {
          if (!settings.has(key)) settings.set(key, config.default);
        },
        get: (id: string, key: string) => (id === "breaktime" ? breakSettings.get(key) : settings.get(key)),
        set: async (id: string, key: string, value: unknown) => {
          if (id === "breaktime") breakSettings.set(key, value);
          else settings.set(key, value);
        }
      },
      keybindings: { register: () => undefined }
    },
    ui: { notifications: { info: () => undefined, warn: () => undefined } },
    ChatMessage: {
      create: async (payload: Record<string, unknown>) => {
        chatMessages.push(payload);
        return { id: "chat-created" };
      }
    }
  };
  vm.runInNewContext(source, context, { filename: modulePath });
  once.get("init")?.();
  once.get("ready")?.();
  return {
    context,
    requests,
    settings,
    breakSettings,
    hooks,
    tableRecords: (context.game as unknown as {
      tableRecords: {
        flush: (force?: boolean) => Promise<unknown>;
        sendMentalNote: (text: string) => Promise<{ ok: boolean; reason?: string }>;
        queueStatus: () => { pending: number; flushing: boolean };
        breakState: () => { active: boolean; startedAtMs: number | null };
        openSetup: () => Promise<{ ok: boolean; reason?: string }>;
        generatePlayerDraft: (kind: string, windowSeconds: number) => Promise<{ ok: boolean; draft?: Record<string, unknown>; message?: string }>;
        publishPlayerPost: (draft: Record<string, unknown>, text: string) => Promise<{ ok: boolean; message?: string }>;
      };
    }).tableRecords,
    chatMessages
  };
}

function chatMessage(id: string, rolls: unknown[] = []) {
  return {
    id,
    timestamp: 1_793_430_369_144,
    author: { id: "u1", name: "Alice" },
    speaker: { scene: "s1", token: "t1", actor: "a1", alias: "Veyra" },
    alias: "Veyra",
    flavor: "Test",
    content: "<p>Test</p>",
    whisper: [],
    blind: false,
    flags: {},
    rolls,
    _source: { author: "u1", rolls: [] }
  };
}

describe("Foundry live bridge module", () => {
  it("registers GM settings and posts canonical chat, rolls, state, and mental notes", async () => {
    const source = await fsp.readFile(modulePath, "utf8");
    const once = new Map<string, (...args: unknown[]) => void>();
    const on = new Map<string, Array<(...args: unknown[]) => void>>();
    const settings = new Map<string, unknown>([
      ["dashboardUrl", "http://127.0.0.1:17300"],
      ["bridgeToken", "secret-bridge"],
      ["enabled", true],
      ["pushChat", true],
      ["pushRolls", true],
      ["heartbeatSeconds", 30]
    ]);
    const requests: Array<{ url: string; body: Record<string, unknown>; headers: Record<string, string> }> = [];
    const message = {
      id: "msg_module_1",
      timestamp: 1_793_430_369_144,
      author: { id: "u_alice", name: "Alice" },
      speakerActor: { id: "a_veyra", name: "Veyra Sol" },
      speaker: { scene: "scene1", token: "token1", actor: "a_veyra", alias: "Veyra Sol" },
      alias: "Veyra Sol",
      style: 0,
      type: "base",
      flavor: "Laser rifle attack",
      content: "<p>attack</p>",
      whisper: [],
      blind: false,
      flags: {},
      rolls: [
        {
          toJSON: () => ({
            class: "RollFFG",
            formula: "2eP+1eA",
            total: 0,
            ffg: { success: 2, failure: 0, advantage: 1, threat: 0, triumph: 1, despair: 0, light: 0, dark: 0 }
          })
        }
      ],
      _source: { author: "u_alice", rolls: ['{"class":"RollFFG"}'] }
    };
    const scene = { id: "scene1", name: "Cantina", tokens: { get: () => ({ name: "Veyra Sol" }) } };
    const combat = { id: "combat1", name: "Hangar fight", round: 2, started: true };
    const context = {
      console,
      Date,
      JSON,
      setTimeout: () => 1,
      clearTimeout: () => undefined,
      setInterval: () => 1,
      clearInterval: () => undefined,
      AbortController: undefined as unknown,
      fetch: async (url: string, init: { body: string; headers: Record<string, string> }) => {
        requests.push({ url, body: JSON.parse(init.body) as Record<string, unknown>, headers: init.headers });
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () =>
            JSON.stringify({
              accepted: true,
              acceptedMessages: 1,
              skippedMessages: 0,
              duplicateMessages: 0,
              noteAccepted: true,
              sessionId: "session-1"
            })
        };
      },
      Hooks: {
        once: (name: string, fn: (...args: unknown[]) => void) => once.set(name, fn),
        on: (name: string, fn: (...args: unknown[]) => void) => {
          const list = on.get(name) ?? [];
          list.push(fn);
          on.set(name, list);
        }
      },
      game: {
        user: { id: "gm", name: "GM", isGM: true },
        users: {
          get: () => ({ id: "u_alice", name: "Alice" }),
          contents: [{ id: "u_alice", name: "Alice", isGM: false, character: { id: "a_veyra", name: "Veyra Sol" } }]
        },
        actors: {
          get: () => ({ id: "a_veyra", name: "Veyra Sol" }),
          contents: [{ id: "a_veyra", name: "Veyra Sol", type: "character", hasPlayerOwner: true }]
        },
        scenes: { current: scene, get: () => scene },
        combat,
        paused: false,
        modules: { get: () => ({ version: "0.3.0" }) },
        version: "14.369.0",
        world: { id: "swffg-cartel", title: "Cartel" },
        system: { id: "starwarsffg", version: "2.0" },
        settings: {
          register: (_id: string, key: string, config: { default: unknown }) => {
            if (!settings.has(key)) settings.set(key, config.default);
          },
          get: (_id: string, key: string) => settings.get(key)
        },
        keybindings: { register: () => undefined }
      },
      ui: { notifications: { info: () => undefined, warn: () => undefined } }
    };
    vm.runInNewContext(source, context, { filename: modulePath });

    once.get("init")?.();
    once.get("ready")?.();
    type TableRecordsApi = {
      flush: (force?: boolean) => Promise<unknown>;
      sendMentalNote: (text: string) => Promise<{ ok: boolean }>;
    };
    const tableRecords = (context.game as unknown as { tableRecords: TableRecordsApi }).tableRecords;
    expect(tableRecords).toBeTruthy();

    const chatHooks = on.get("createChatMessage") ?? [];
    expect(chatHooks).toHaveLength(2);
    chatHooks.at(-1)!(message);
    await tableRecords.flush(true);

    expect(requests.length).toBeGreaterThanOrEqual(1);
    const post = requests[0]!;
    expect(post.url).toBe("http://127.0.0.1:17300/api/foundry/live");
    expect(post.headers["x-tablerecords-token"]).toBe("secret-bridge");
    expect(post.body.schema).toBe("tablerecords.foundry-live/v1");
    const posted = post.body.messages as Array<{ messageId: string; rolls: Array<{ ffg: { success: number } }> }>;
    expect(posted[0]?.messageId).toBe("msg_module_1");
    expect(posted[0]?.rolls[0]?.ffg.success).toBe(2);
    expect(post.body.state).toMatchObject({ scene: { name: "Cantina" }, combat: { name: "Hangar fight" }, paused: false });
    expect(post.body.roster).toMatchObject({
      users: [{ id: "u_alice", name: "Alice", characterId: "a_veyra", characterName: "Veyra Sol" }],
      actors: [{ id: "a_veyra", name: "Veyra Sol", type: "character", hasPlayerOwner: true }]
    });

    const note = await tableRecords.sendMentalNote("Remember the hidden door");
    expect(note.ok).toBe(true);
    const noteRequest = requests.at(-1)!;
    expect(noteRequest.body.note).toBe("Remember the hidden door");
    expect(noteRequest.body.messages).toEqual([]);
  });

  it("keeps chat and roll settings independent, and respects the enabled switch", async () => {
    const chatOnly = await loadBridge({ pushChat: false });
    chatOnly.hooks.get("createChatMessage")?.at(-1)?.(chatMessage("chat-only"));
    await chatOnly.tableRecords.flush(true);
    expect((chatOnly.requests.at(-1)!.body.messages as unknown[])).toHaveLength(0);

    const rollsOnly = await loadBridge({ pushChat: false, pushRolls: true });
    rollsOnly.hooks.get("createChatMessage")?.at(-1)?.(chatMessage("roll-only", [{ toJSON: () => ({ class: "Roll", formula: "1d20" }) }]));
    await rollsOnly.tableRecords.flush(true);
    expect((rollsOnly.requests.at(-1)!.body.messages as unknown[])).toHaveLength(1);

    const chatWithoutRolls = await loadBridge({ pushChat: true, pushRolls: false });
    chatWithoutRolls.hooks.get("createChatMessage")?.at(-1)?.(chatMessage("roll-dropped", [{ toJSON: () => ({ class: "Roll", formula: "1d20" }) }]));
    await chatWithoutRolls.tableRecords.flush(true);
    expect((chatWithoutRolls.requests.at(-1)!.body.messages as unknown[])).toHaveLength(0);

    const disabled = await loadBridge({ enabled: false });
    expect(disabled.tableRecords.queueStatus()).toMatchObject({ pending: 0, flushing: false });
    const result = await disabled.tableRecords.sendMentalNote("do not send me");
    expect(result).toMatchObject({ ok: false, reason: "disabled" });
    expect(disabled.requests).toHaveLength(0);
  });

  it("still has the failed batch when the next flush runs, and forwards an explicit session id", async () => {
    let attempts = 0;
    const bridge = await loadBridge({ sessionId: "session-abc" }, async () => {
      attempts += 1;
      if (attempts === 1) {
        return { ok: false, status: 503, statusText: "Unavailable", text: async () => JSON.stringify({ error: { code: "http_error", message: "try later" } }) };
      }
      return { ok: true, status: 200, statusText: "OK", text: async () => JSON.stringify({ accepted: true, acceptedMessages: 1 }) };
    });
    bridge.hooks.get("createChatMessage")?.at(-1)?.(chatMessage("retry-me"));
    await bridge.tableRecords.flush(true);
    expect(attempts).toBe(1);
    await bridge.tableRecords.flush(true);
    expect(attempts).toBe(2);
    expect(bridge.requests.at(-1)!.body.sessionId).toBe("session-abc");
    expect((bridge.requests.at(-1)!.body.messages as Array<{ messageId: string }>)[0]?.messageId).toBe("retry-me");
  });

  it("sends the player consent prompt and posts it to the bridge", async () => {
    const bridge = await loadBridge();
    const api = bridge.tableRecords as unknown as {
      promptConsent: () => Promise<{ ok: boolean }>;
    };
    const result = await api.promptConsent();
    expect(result.ok).toBe(true);
    const consent = bridge.requests.at(-1)!.body.consent as {
      promptSent?: boolean;
      noticeVersion?: string;
    };
    expect(consent.promptSent).toBe(true);
    expect(consent.noticeVersion).toBe("2026-11-01");
    expect(bridge.settings.get("promptConsent")).toBe(true);
  });

  it("mirrors Break Time starts and ends as break events", async () => {
    const startedAtMs = Date.now() - 42_000;
    const bridge = await loadBridge({}, undefined, { active: true, paused: false, start: startedAtMs });
    const updateSetting = bridge.hooks.get("updateSetting")?.at(-1);
    expect(updateSetting).toBeTypeOf("function");
    expect(bridge.requests).toHaveLength(0);

    bridge.breakSettings.set("paused", true);
    updateSetting!({ key: "breaktime.paused", value: true });
    expect(bridge.tableRecords.breakState()).toMatchObject({ active: true, startedAtMs });
    const startEvent = (bridge.requests.at(-1)!.body.events as Array<Record<string, unknown>>)[0]!;
    expect(startEvent).toMatchObject({
      kind: "break",
      phase: "start",
      atMs: startedAtMs,
      actor: { id: "gm", name: "GM" }
    });

    bridge.breakSettings.set("paused", false);
    updateSetting!({ key: "breaktime.paused", value: false });
    expect(bridge.tableRecords.breakState()).toMatchObject({ active: false, startedAtMs: null });
    const endEvent = (bridge.requests.at(-1)!.body.events as Array<Record<string, unknown>>)[0]!;
    expect(endEvent).toMatchObject({ kind: "break", phase: "end", startedAtMs });

    const reloaded = await loadBridge({}, undefined, { active: true, paused: true, start: startedAtMs });
    const reloadEvent = (reloaded.requests.at(-1)!.body.events as Array<Record<string, unknown>>)[0]!;
    expect(reloadEvent).toMatchObject({ kind: "break", phase: "start", atMs: startedAtMs });
    expect(reloaded.tableRecords.breakState()).toMatchObject({ active: true, startedAtMs });
  });

  it("does not mirror Break Time when the break module or follow setting is off", async () => {
    const inactive = await loadBridge({}, undefined, { active: false, paused: false, start: Date.now() - 1000 });
    inactive.hooks.get("updateSetting")?.at(-1)?.({ key: "breaktime.paused", value: true });
    expect(inactive.requests).toHaveLength(0);

    const disabled = await loadBridge({ followBreakTime: false }, undefined, {
      active: true,
      paused: false,
      start: Date.now() - 1000
    });
    disabled.hooks.get("updateSetting")?.at(-1)?.({ key: "breaktime.paused", value: true });
    expect(disabled.requests).toHaveLength(0);
  });

  it("marks a configured world as set up and exposes the setup wizard API", async () => {
    const bridge = await loadBridge({}, undefined, { active: false, paused: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(bridge.settings.get("setupSeen")).toBe(true);
    expect(bridge.settings.get("setupComplete")).toBe(true);

    const result = await bridge.tableRecords.openSetup();
    expect(result).toMatchObject({ ok: false, reason: "no_dialog" });
  });

  it("walks through the setup wizard and saves the dashboard connection", async () => {
    const bridge = await loadBridge({ bridgeToken: "" });
    let calls = 0;
    const dialog = {
      wait: async (config: {
        buttons: Array<{ action?: string; callback?: (event: unknown, button: unknown) => unknown }>;
      }) => {
        calls += 1;
        if (calls === 1) return "start";
        if (calls === 2) {
          const next = config.buttons.find((button) => button.action === "next");
          return next?.callback?.(null, {
            form: {
              elements: {
                dashboardUrl: { value: "http://127.0.0.1:17300/" },
                bridgeToken: { value: " new-token " },
                sessionId: { value: "" },
                enabled: { checked: true },
                promptConsent: { checked: true },
                publishRoster: { checked: true },
                followBreakTime: { checked: true }
              }
            }
          });
        }
        return "finish";
      }
    };
    (bridge.context as { foundry?: unknown }).foundry = {
      applications: { api: { DialogV2: dialog } }
    };
    const result = await bridge.tableRecords.openSetup();
    expect(result).toMatchObject({ ok: true });
    expect(bridge.settings.get("dashboardUrl")).toBe("http://127.0.0.1:17300");
    expect(bridge.settings.get("bridgeToken")).toBe("new-token");
    expect(bridge.settings.get("setupComplete")).toBe(true);
  });

  it("previews a player draft and posts only the reviewed text with a generated flag", async () => {
    const draft = {
      schema: "tablerecords.player-draft/v1",
      draftId: "draft-1",
      kind: "recap",
      label: "Recap last 3 minutes",
      provider: "ollama",
      model: "qwen3.5:27b-q4_K_M",
      text: "## Recap\n\nThe crew found the blue code.",
      window: { startMs: 1000, endMs: 181000, seconds: 180, label: "last 3 min" },
      warnings: []
    };
    const bridge = await loadBridge({}, async (url) => ({
      ok: true,
      status: 200,
      statusText: "OK",
      text: async () =>
        url.endsWith("/api/foundry/player-drafts")
          ? JSON.stringify(draft)
          : JSON.stringify({ accepted: true })
    }));
    bridge.hooks.get("createChatMessage")?.at(-1)?.({
      ...chatMessage("generated-post"),
      flags: { "table-records-bridge": { playerPost: true } }
    });
    expect(bridge.tableRecords.queueStatus().pending).toBe(0);

    const generated = await bridge.tableRecords.generatePlayerDraft("recap", 180);
    expect(generated.ok).toBe(true);
    const request = bridge.requests.find((item) => item.url.endsWith("/api/foundry/player-drafts"));
    expect(request?.headers["x-tablerecords-token"]).toBe("secret-bridge");
    expect(request?.body).toMatchObject({
      kind: "recap",
      windowSeconds: 180,
      world: { id: "world-a" }
    });

    expect(bridge.chatMessages).toHaveLength(0);
    const published = await bridge.tableRecords.publishPlayerPost(
      draft,
      "<script>alert(1)</script> @UUID[JournalEntry.x] [[/r 1d6]]"
    );
    expect(published.ok).toBe(true);
    expect(bridge.chatMessages).toHaveLength(1);
    const message = bridge.chatMessages[0] as {
      content: string;
      flags: Record<string, { playerPost: boolean; draftId: string }>;
    };
    expect(message.content).toContain("AI-assisted recap, reviewed by the GM.");
    expect(message.content).not.toContain("<script>");
    expect(message.content).toContain("&lt;script&gt;");
    expect(message.content).toContain("@\u200B");
    expect(message.content).toContain("[\u200B[");
    expect(message.flags["table-records-bridge"]).toMatchObject({ playerPost: true, draftId: "draft-1" });
  });
});
