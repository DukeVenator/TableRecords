import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/e2e",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [
    ["list"],
    ["json", { outputFile: "docs/qa/playwright-results.json" }],
    ["html", { outputFolder: "playwright-report", open: "never" }]
  ],
  outputDir: "test-results",
  use: {
    baseURL: "http://127.0.0.1:17300",
    channel: "msedge",
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
    video: "off"
  },
  projects: [
    {
      name: "edge",
      use: { ...devices["Desktop Edge"], channel: "msedge", viewport: { width: 1440, height: 1000 } }
    }
  ]
});
