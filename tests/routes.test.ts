import { describe, expect, it } from "vitest";
import { parseRoute, routeUrl } from "../src/web/routes.js";

describe("dashboard routes", () => {
  it("parses top-level views, selected sessions, tabs, and people", () => {
    expect(parseRoute("/")).toMatchObject({ view: "record", sessionId: null, tab: "overview" });
    expect(parseRoute("/sessions")).toMatchObject({ view: "sessions", sessionId: null });
    expect(parseRoute("/people")).toMatchObject({ view: "people" });
    expect(parseRoute("/setup")).toMatchObject({ view: "setup" });
    expect(parseRoute("/sessions?session=2026-11-01-demo&tab=files")).toMatchObject({
      view: "sessions",
      sessionId: "2026-11-01-demo",
      tab: "files"
    });
    expect(parseRoute("/sessions?session=2026-11-01-demo&tab=stats")).toMatchObject({
      view: "sessions",
      sessionId: "2026-11-01-demo",
      tab: "stats"
    });
    expect(parseRoute("/sessions/2026-11-01-demo")).toMatchObject({
      view: "sessions",
      sessionId: "2026-11-01-demo"
    });
    expect(parseRoute("/people?person=discord%3A123")).toMatchObject({
      view: "people",
      personKey: "discord:123"
    });
    expect(parseRoute("/sessions?tab=not-a-tab").tab).toBe("overview");
    expect(parseRoute("/unknown").view).toBe("record");
  });

  it("builds a stable URL and round-trips it", () => {
    expect(routeUrl({ view: "record", sessionId: null, tab: "overview", personKey: null })).toBe("/");
    expect(
      routeUrl({ view: "sessions", sessionId: "s1", tab: "files", personKey: null })
    ).toBe("/sessions?session=s1&tab=files");
    expect(
      routeUrl({ view: "people", sessionId: "s1", tab: "overview", personKey: "discord:123" })
    ).toBe("/people?session=s1&person=discord%3A123");
    const route = parseRoute("/people?session=s1&person=discord%3A123");
    expect(routeUrl(route)).toBe("/people?session=s1&person=discord%3A123");
  });
});
