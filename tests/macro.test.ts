import { describe, expect, it } from "vitest";
import fsp from "node:fs/promises";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const macroPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "foundry-macros",
  "table-records-export.js"
);

describe("Foundry export macro", () => {
  it("runs against mocked Foundry globals and exports canonical prepared rolls", async () => {
    const source = await fsp.readFile(macroPath, "utf8");
    let saved: { data: string; type: string; filename: string } | null = null;
    const roll = {
      toJSON: () => ({
        class: "RollFFG",
        formula: "2eP+1eA",
        total: 0,
        ffg: { success: 2, failure: 0, advantage: 1, threat: 0, triumph: 1, despair: 0, light: 0, dark: 0 },
        hasFFG: true,
        hasStandard: false,
        data: { name: "Laser rifle" },
        addedResults: [],
        flavorText: "Laser rifle attack"
      })
    };
    const message = {
      id: "msg_macro_1",
      timestamp: 1793430369144,
      author: { id: "u_alice", name: "Alice" },
      speakerActor: { id: "a_veyra", name: "Veyra Sol" },
      speaker: { scene: "scene1", token: "token1", actor: "a_veyra", alias: "Veyra Sol" },
      alias: "Veyra Sol",
      style: 0,
      type: "base",
      system: {},
      flavor: "Laser rifle attack",
      content: "<p>attack</p>",
      whisper: [],
      blind: false,
      flags: {},
      rolls: [roll],
      _source: { author: "u_alice", rolls: ['{"class":"RollFFG"}'] }
    };
    const context = {
      console,
      Date,
      JSON,
      game: {
        messages: { contents: [message] },
        users: { get: () => ({ id: "u_alice", name: "Alice" }) },
        actors: { get: () => ({ id: "a_veyra", name: "Veyra Sol" }) },
        scenes: { get: () => ({ tokens: { get: () => ({ name: "Veyra Sol" }) } }) },
        user: { id: "gm", name: "GM" },
        version: "14.369.0",
        world: { id: "swffg-cartel", title: "Cartel" },
        system: { id: "starwarsffg", version: "2.0" }
      },
      foundry: {
        utils: {
          saveDataToFile: (data: string, type: string, filename: string) => {
            saved = { data, type, filename };
          }
        }
      },
      ui: { notifications: { error: () => undefined, info: () => undefined } }
    };
    vm.runInNewContext(source, context, { filename: macroPath });
    expect(saved).not.toBeNull();
    const payload = JSON.parse(saved!.data) as {
      schema: string;
      messages: Array<{ messageId: string; timestampMs: number; rolls: Array<{ ffg: { success: number } }>; rollsRaw: string[] }>;
    };
    expect(payload.schema).toBe("tablerecords.foundry-export/v1");
    expect(payload.messages[0]?.messageId).toBe("msg_macro_1");
    expect(payload.messages[0]?.timestampMs).toBe(1793430369144);
    expect(payload.messages[0]?.rolls[0]?.ffg.success).toBe(2);
    expect(payload.messages[0]?.rollsRaw).toHaveLength(1);
    expect(saved!.filename).toContain("tablerecords-foundry-swffg-cartel-");
  });
});
