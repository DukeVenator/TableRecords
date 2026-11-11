import { test, expect, type Page } from "@playwright/test";

const SESSION = "2026-01-01-demo-world-demo-session";
const BRIEF_SESSION = "2026-01-01-demo-world-demo-session";
const SUMMARY = {
  schema: "tablerecords.llm-summary/v2",
  summaryId: "llm_e2e_fixture",
  sessionId: SESSION,
  provider: "ollama",
  model: "e2e-model",
  preset: "gm-prep",
  scope: "session",
  window: {
    seconds: 13_887,
    startMs: 1_793_500_766_353,
    endMs: 1_793_514_653_729,
    label: "whole session"
  },
  promptVersion: "2026-11-02.1",
  briefChars: 252_977,
  estimatedTokens: 63_245,
  trimmed: true,
  chunks: 7,
  summary: "## Current situation\n\nThe crew escaped the cantina with the datapad.\n\n## People\n\n- **Veyra** — pilot.\n\n## Open threads\n\n- Who hired the bounty hunter?",
  structured: null,
  elapsedMs: 4_200,
  createdAtMs: Date.now()
};

const consoleErrors = new WeakMap<Page, string[]>();
const allowedConsoleErrors = new WeakMap<Page, RegExp[]>();

test.beforeEach(async ({ page }) => {
  const errors: string[] = [];
  consoleErrors.set(page, errors);
  allowedConsoleErrors.set(page, []);
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  page.on("pageerror", (error) => errors.push(error.message));
});

test.afterEach(async ({ page }) => {
  const allowed = allowedConsoleErrors.get(page) ?? [];
  const unexpected = (consoleErrors.get(page) ?? []).filter((message) => !allowed.some((pattern) => pattern.test(message)));
  expect(unexpected).toEqual([]);
});

test("Sessions overview owns the full summary controls and hides the window outside recent scope", async ({ page }) => {
  await page.goto(`/sessions?session=${SESSION}&tab=overview`);
  const panel = page.locator(".ai-summary-panel");
  await expect(panel).toBeVisible();
  await expect(panel.getByText("AI summary", { exact: true })).toBeVisible();
  await expect(panel.getByLabel("Summary window")).toBeVisible();

  await panel.getByLabel("Summary scope").selectOption("session");
  await expect(panel.getByLabel("Summary window")).toHaveCount(0);
  await expect(panel).toContainText("No window applies");
  await expect(page.getByRole("button", { name: "Summarize" })).toBeEnabled();

  await panel.getByLabel("Summary scope").selectOption("scene");
  await expect(panel.getByLabel("Summary window")).toHaveCount(0);
  await panel.getByLabel("Summary scope").selectOption("recent");
  await expect(panel.getByLabel("Summary window")).toBeVisible();
});

test("Record exposes the brief and AI summary as separate controls", async ({ page }) => {
  await page.goto(`/?session=${BRIEF_SESSION}`);
  const brief = page.locator(".brief-block");
  const ai = page.locator(".ai-summary-block");
  await expect(brief).toBeVisible();
  await expect(ai).toBeVisible();
  await expect(brief.getByLabel("Brief window")).toBeVisible();
  await expect(brief.getByRole("button", { name: "Transcribe & brief" })).toBeEnabled();
  await expect(ai.getByLabel("Summary scope")).toBeVisible();
  await expect(ai.getByLabel("Summary preset")).toBeVisible();

  await ai.getByLabel("Summary scope").selectOption("session");
  await expect(ai.getByLabel("Summary window")).toHaveCount(0);
  await expect(ai).toContainText("No window applies");
  await expect(brief.getByLabel("Brief window")).toBeVisible();

  await brief.getByRole("button", { name: "Transcribe & brief" }).click();
  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible({ timeout: 30_000 });
  await expect(modal).toContainText("Session brief");
  await expect(modal.locator(".recent-context-text")).toContainText("GM context");
  await expect(modal.getByRole("button", { name: "Copy for your AI assistant" })).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
});

test("whole-session summary renders Markdown, metadata, and opens from history", async ({ page }) => {
  await page.route(`**/api/sessions/${SESSION}/llm/summarize`, async (route) => {
    const body = route.request().postDataJSON() as { scope?: string; preset?: string };
    expect(body.scope).toBe("session");
    expect(body.preset).toBe("gm-prep");
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify(SUMMARY)
    });
  });

  await page.goto(`/?session=${SESSION}`);
  const ai = page.locator(".ai-summary-block");
  await ai.getByLabel("Summary scope").selectOption("session");
  await ai.getByLabel("Summary preset").selectOption("gm-prep");
  await ai.getByRole("button", { name: "Summarize" }).click();

  const modal = page.getByRole("dialog");
  await expect(modal).toBeVisible();
  await expect(modal).toContainText("whole session");
  await expect(modal).toContainText("7 portions");
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  await page.keyboard.press("Shift+Tab");
  expect(await page.evaluate(() => Boolean(document.activeElement?.closest('[role="dialog"]')))).toBe(true);
  const rendered = modal.locator(".llm-summary-rendered");
  await expect(rendered.getByRole("heading", { name: "Current situation" })).toBeVisible();
  await expect(rendered.getByText("Veyra", { exact: false })).toBeVisible();
  await expect(rendered).not.toContainText("**");

  await page.keyboard.press("Escape");
  await expect(modal).toBeHidden();
  expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  await expect(ai.getByRole("button", { name: "Summarize" })).toBeFocused();

  await page.getByText(/^Summary history \(\d+\)$/).click();
  const row = page.locator(".llm-history-row").first();
  await expect(row).toContainText("Whole session");
  await expect(row).toContainText("7 portions");
  await row.click();
  await expect(page.getByRole("dialog")).toContainText("Current situation");
  await page.keyboard.press("Escape");
  await expect(page.getByRole("dialog")).toBeHidden();
});

test("Setup offers local and cloud providers with the cloud warning", async ({ page }) => {
  await page.goto("/setup");
  await expect(page.getByText("AI summary (optional)", { exact: false })).toBeVisible();
  const provider = page.getByLabel("Provider", { exact: true });
  await provider.selectOption("ollama");
  await expect(provider).toHaveValue("ollama");
  await provider.selectOption("llamacpp");
  await expect(page.getByText("Usually http://127.0.0.1:9931/v1", { exact: false })).toBeVisible();
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("off");
  await expect(page.getByLabel("MoE layers on the processor")).toBeVisible();
  await expect(page.getByLabel("KV cache type")).toHaveValue(/^(f16|q8_0|q4_0)$/);
  await expect(page.getByText("Flash attention", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Server executable")).toBeVisible();
  await expect(page.getByLabel("Model file")).toBeVisible();
  await expect(page.getByRole("button", { name: "Start server" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Stop server" })).toBeDisabled();
  await provider.selectOption("deepseek");
  await expect(page.getByText("Allow cloud summaries", { exact: false })).toBeVisible();
  await expect(page.getByText("The session brief is sent to DeepSeek", { exact: false })).toBeVisible();
  await expect(page.getByText("Endpoint", { exact: true })).toBeVisible();
  await provider.selectOption("local");
  await expect(page.getByText("Allow cloud summaries", { exact: false })).toHaveCount(0);
  await page.getByLabel("Address").fill("http://127.0.0.1:1234/v1");
  await expect(page.getByText("Usually http://127.0.0.1:1234/v1 for LM Studio.", { exact: false })).toBeVisible();
  expect(await page.getByLabel("Context window (tokens)").inputValue()).toMatch(/^\d+$/);
  expect(await page.getByLabel("Layers on the video card").inputValue()).toMatch(/^\d*$/);

  await page.getByRole("button", { name: "Use deep summary settings" }).click();
  await expect(provider).toHaveValue("llamacpp");
  await expect(page.getByLabel("Context window (tokens)")).toHaveValue("65536");
  await expect(page.getByLabel("Input limit (characters)")).toHaveValue("100000");
  await expect(page.getByLabel("Reasoning effort")).toHaveValue("off");

  await page.getByRole("button", { name: "Run checks" }).first().click();
  await page.getByText(/The other \d+ checks passed/).click();
  await expect(page.locator(".check-list").getByText("AI summaries", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/Connection and generation have not been checked by the doctor/)).toBeVisible();
});

test("People filters the directory and shows career stats", async ({ page }) => {
  await page.goto("/people");
  await expect(page.locator(".people-index")).toBeVisible();
  await expect(page.locator(".people-detail").getByText("Career stats", { exact: true })).toBeVisible();

  await page.getByPlaceholder("Name or character").fill("Alice");
  await expect(page.locator(".person-row")).toHaveCount(1);
  await page.locator(".person-row").first().click();
  await expect(page.locator(".people-detail").getByRole("heading", { name: "Alice" })).toBeVisible();
  await expect(page.locator(".people-detail")).toContainText("Veyra Sol");
});

test("Setup wizard opens from Setup and returns", async ({ page }) => {
  await page.goto("/setup");
  await page.getByRole("button", { name: "Setup wizard" }).click();
  await expect(page.getByRole("heading", { name: "Setup wizard" })).toBeVisible();
  await expect(page.getByText(/^Step \d+ of 4$/)).toBeVisible();
  await expect(page.getByRole("heading", { name: /AI summaries/ })).toBeVisible();
  await expect(page.getByRole("button", { name: "Open AI summary settings" })).toBeVisible();
  await page.getByRole("button", { name: "Back to TableRecords" }).click();
  await expect(page.getByRole("heading", { name: "Setup", exact: true })).toBeVisible();
});

test("a failed summary keeps the controls usable and explains the problem", async ({ page }) => {
  allowedConsoleErrors.get(page)!.push(/status of 500/);
  await page.route(`**/api/sessions/${SESSION}/llm/summarize`, (route) =>
    route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "boom" }) })
  );
  await page.goto(`/?session=${SESSION}`);
  const ai = page.locator(".ai-summary-block");
  const summarize = ai.getByRole("button", { name: "Summarize" });
  await summarize.click();
  await expect(page.locator(".toast")).toContainText("The dashboard hit an error");
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(summarize).toBeEnabled();
});

test.describe("mobile layout", () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test("Sessions, Record, and Setup do not overflow horizontally", async ({ page }) => {
    for (const path of [
      `/sessions?session=${SESSION}&tab=overview`,
      `/?session=${SESSION}`,
      "/setup"
    ]) {
      await page.goto(path);
      await expect(page.locator("main")).toBeVisible();
      if (path.startsWith("/sessions")) {
        await expect(page.locator(".ai-summary-panel")).toBeVisible({ timeout: 30_000 });
        const copyId = page.getByRole("button", { name: "Copy ID" });
        await expect(copyId).toBeVisible();
        const box = await copyId.boundingBox();
        expect(box, "Copy ID sits on screen").not.toBeNull();
        expect(box!.x + box!.width, "Copy ID stays inside the viewport").toBeLessThanOrEqual(390);
      } else if (path.startsWith("/?")) {
        await expect(page.locator(".ai-summary-block")).toBeVisible({ timeout: 30_000 });
      }
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      expect(overflow, `${path} horizontal overflow`).toBeLessThanOrEqual(1);
    }
  });

  test("Sessions and People switch between the list and the detail", async ({ page }) => {
    await page.goto(`/sessions?session=${SESSION}&tab=overview`);
    await expect(page.locator(".ai-summary-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".session-list-card")).toBeHidden();
    await page.getByRole("button", { name: "← All games" }).click();
    await expect(page.locator(".session-list-card")).toBeVisible();
    await expect(page.locator(".session-detail")).toBeHidden();
    await page.locator(".session-row").nth(1).click();
    await expect(page.locator(".ai-summary-panel")).toBeVisible({ timeout: 30_000 });
    await expect(page.locator(".session-list-card")).toBeHidden();

    await page.goto("/people");
    await expect(page.locator(".people-index")).toBeVisible();
    await page.locator(".person-row").first().click();
    await expect(page.getByText("Career stats", { exact: true })).toBeVisible();
    await expect(page.locator(".people-index")).toBeHidden();
    await page.getByRole("button", { name: "← All people" }).click();
    await expect(page.locator(".people-index")).toBeVisible();
  });

  test("the summary controls remain usable at 390px", async ({ page }) => {
    await page.goto(`/sessions?session=${SESSION}&tab=overview`);
    const panel = page.locator(".ai-summary-panel");
    await expect(panel).toBeVisible({ timeout: 30_000 });
    await expect(panel.getByLabel("Summary scope")).toBeVisible();
    await expect(panel.getByLabel("Summary preset")).toBeVisible();
    await expect(panel.getByRole("button", { name: "Summarize" })).toBeVisible();
    await panel.getByLabel("Summary scope").selectOption("session");
    await expect(panel.getByLabel("Summary window")).toHaveCount(0);
  });
});

test("@live Ollama models and connection test", async ({ request }) => {
  test.skip(process.env.QA_LLM !== "1", "Set QA_LLM=1 with Ollama running to exercise the live model");
  const settings = await request.get("/api/settings");
  const llm = (await settings.json()) as { llm: { enabled: boolean; configured: boolean; provider: string } };
  test.skip(!llm.llm.enabled || !llm.llm.configured, "AI summaries are not configured");
  const models = await request.get("/api/llm/models");
  expect(models.ok()).toBeTruthy();
  const modelBody = (await models.json()) as { models: Array<{ id: string }> };
  expect(modelBody.models.length).toBeGreaterThan(0);
  const testResponse = await request.post("/api/llm/test", { data: {} });
  expect(testResponse.ok()).toBeTruthy();
  expect(await testResponse.json()).toMatchObject({ ok: true, provider: "ollama" });
});


