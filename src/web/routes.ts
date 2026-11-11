export type AppView = "record" | "sessions" | "people" | "setup";
export type SessionTab = "overview" | "stats" | "people" | "rolls" | "files" | "activity";

export interface RouteState {
  view: AppView;
  sessionId: string | null;
  tab: SessionTab;
  personKey: string | null;
}

const VIEWS = new Set<AppView>(["record", "sessions", "people", "setup"]);
const TABS = new Set<SessionTab>(["overview", "stats", "people", "rolls", "files", "activity"]);

function single(value: string | null): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function parseRoute(input: string): RouteState {
  let url: URL;
  try {
    url = new URL(input, "http://localhost");
  } catch {
    return { view: "record", sessionId: null, tab: "overview", personKey: null };
  }
  const parts = url.pathname.split("/").filter(Boolean);
  const first = parts[0]?.toLowerCase() ?? "";
  const view: AppView = VIEWS.has(first as AppView) ? (first as AppView) : "record";
  const tabValue = url.searchParams.get("tab")?.toLowerCase() ?? "";
  const tab: SessionTab = TABS.has(tabValue as SessionTab) ? (tabValue as SessionTab) : "overview";
  return {
    view,
    sessionId: single(url.searchParams.get("session")) ?? (view === "sessions" ? single(parts[1] ?? null) : null),
    tab,
    personKey: single(url.searchParams.get("person"))
  };
}

export function routeUrl(state: RouteState): string {
  const path = state.view === "record" ? "/" : `/${state.view}`;
  const params = new URLSearchParams();
  if (state.sessionId) params.set("session", state.sessionId);
  if (state.view === "sessions" && state.tab !== "overview") params.set("tab", state.tab);
  if (state.view === "people" && state.personKey) params.set("person", state.personKey);
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}
