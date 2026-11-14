import { test, expect } from "@playwright/test";
import fsp from "node:fs/promises";
import path from "node:path";

const MODULE_PATH = path.join(process.cwd(), "foundry-module", "scripts", "main.js");

declare global {
  interface Window {
    __fire: (name: string, ...args: unknown[]) => void;
    __posts: Array<{ content: string; flags: Record<string, Record<string, unknown>> }>;
  }
}

test("Foundry GM tools preview a draft and post only the edited text", async ({ page }) => {
  const source = await fsp.readFile(MODULE_PATH, "utf8");
  const css = await fsp.readFile(path.join(process.cwd(), "foundry-module", "styles", "bridge.css"), "utf8");
  await page.setContent('<div id="chat-controls"></div>');
  await page.addStyleTag({ content: css });
  await page.addStyleTag({
    content: "body{margin:0;background:#141414;color:#eee;font-family:system-ui,sans-serif}#chat-controls{padding:8px;width:320px}"
  });
  await page.addScriptTag({
    content: `(() => {
      const hooks = new Map();
      window.__fire = (name, ...args) => {
        for (const fn of hooks.get(name) ?? []) fn(...args);
      };
      window.Hooks = {
        once: (name, fn) => {
          const list = hooks.get(name) ?? [];
          list.push(fn);
          hooks.set(name, list);
        },
        on: (name, fn) => {
          const list = hooks.get(name) ?? [];
          list.push(fn);
          hooks.set(name, list);
        }
      };
      window.__posts = [];
      window.ChatMessage = {
        create: async (payload) => {
          window.__posts.push(payload);
          return { id: "posted-1" };
        }
      };
      window.ui = { notifications: { info: () => undefined, warn: () => undefined } };
      window.fetch = async (url) => {
        if (String(url).includes("/api/foundry/player-drafts")) {
          return {
            ok: true,
            status: 201,
            statusText: "Created",
            text: async () => JSON.stringify({
              schema: "tablerecords.player-draft/v1",
              draftId: "draft-ui-1",
              kind: "clues",
              label: "Clues mentioned",
              provider: "ollama",
              model: "test-model",
              text: "## Clues mentioned\\n\\n- The blue code.",
              window: { startMs: 1000, endMs: 181000, seconds: 180, label: "last 3 min" },
              warnings: []
            })
          };
        }
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => JSON.stringify({ accepted: true, commands: [] })
        };
      };
      window.game = {
        user: { id: "gm", name: "GM", isGM: true },
        users: { get: () => null, contents: [] },
        actors: { get: () => null, contents: [] },
        scenes: { current: null },
        combat: null,
        paused: false,
        modules: { get: (id) => ({ id, active: false, version: "0.4.2" }) },
        version: "14.369.0",
        world: { id: "world-a", title: "World A" },
        system: { id: "system-a", version: "1.0" },
        settings: {
          register: () => undefined,
          get: (_id, key) => {
            if (key === "bridgeToken") return "secret-bridge";
            if (key === "setupComplete" || key === "setupSeen") return true;
            return undefined;
          },
          set: async () => undefined
        },
        keybindings: { register: () => undefined }
      };
    })();`
  });
  await page.addScriptTag({ content: source });
  await page.evaluate(() => {
    window.__fire("init");
    window.__fire("ready");
  });

  await page.getByRole("button", { name: "TableRecords GM tools" }).click();
  await expect(page.getByRole("heading", { name: "TableRecords GM tools" })).toBeVisible();
  await page.getByRole("button", { name: "Clues mentioned" }).click();
  await expect(page.locator(".tr-gm-text")).toHaveValue(/The blue code/);
  await expect(page.getByRole("button", { name: "Recap" })).toBeEnabled();
  await page.screenshot({ path: "screenshots/qa/foundry-gm-tools.png" });
  expect(await page.evaluate(() => window.__posts.length)).toBe(0);

  await page.locator(".tr-gm-text").fill("Edited **clue** for players.");
  await page.getByRole("button", { name: "Post to players" }).click();
  await expect(page.locator(".tr-gm-panel")).toBeHidden();

  const post = await page.evaluate(() => window.__posts[0]);
  expect(post?.content).toContain("Edited **clue** for players.");
  expect(post?.content).toContain("AI-assisted clues list, reviewed by the GM.");
  expect(post?.flags["table-records-bridge"]).toMatchObject({ playerPost: true, draftId: "draft-ui-1" });
});
