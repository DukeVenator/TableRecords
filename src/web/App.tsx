import { useCallback, useEffect, useRef, useState } from "react";
import { ApiError, api, del, patch, post, put, upload } from "./api";
import { humanMessage } from "./errors";
import type {
  CaptureTestResult,
  Guild,
  HealthCheck,
  Job,
  LlmProgress,
  LlmSummaryPreset,
  LlmSummaryResult,
  LlmSummaryScope,
  OutputFile,
  RecentContextResult,
  RosterPerson,
  SessionDetail,
  SessionSummary,
  SettingsPayload,
  Status,
  VoiceChannel,
  VoiceMember,
  World
} from "./types";
import { RecordView } from "./RecordView";
import { SessionsView } from "./SessionsView";
import { PeopleView } from "./PeopleView";
import { MarkdownView, markdownHeadings } from "./markdown";
import { parseRoute, routeUrl, type AppView, type SessionTab } from "./routes";
import { SetupView } from "./SetupView";
import { SetupWizard } from "./SetupWizard";
import { AudioTestWizard } from "./AudioTestWizard";
import { Button, LlmSummaryModal, LogView, Modal, Pill, RecentContextModal } from "./components";
import { formatDateTime, formatTime, jobLabel } from "./format";

type Toast = { tone: "ok" | "warn" | "bad"; message: string } | null;
type LogLine = { seq: number; tsMs: number; level: string; line: string };
type CaptureTestResultState = CaptureTestResult | null;

export default function App() {
  const [initialRoute] = useState(() => parseRoute(window.location.href));
  const [authRequired, setAuthRequired] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [bootError, setBootError] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [view, setView] = useState<AppView>(initialRoute.view);
  const [sessionTab, setSessionTab] = useState<SessionTab>(initialRoute.tab);
  const [peopleKey, setPeopleKey] = useState<string | null>(initialRoute.personKey);
  const [wizardOpen, setWizardOpen] = useState(false);
  const [audioWizardOpen, setAudioWizardOpen] = useState(false);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<SessionDetail | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [outputs, setOutputs] = useState<OutputFile[]>([]);
  const [settings, setSettings] = useState<SettingsPayload | null>(null);
  const [worlds, setWorlds] = useState<World[]>([]);
  const [guilds, setGuilds] = useState<Guild[]>([]);
  const [channels, setChannels] = useState<VoiceChannel[]>([]);
  const [roster, setRoster] = useState<RosterPerson[]>([]);
  const [voiceMembers, setVoiceMembers] = useState<VoiceMember[]>([]);
  const [guildId, setGuildId] = useState("");
  const [channelId, setChannelId] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [toast, setToast] = useState<Toast>(null);
  const [markerLabel, setMarkerLabel] = useState("");
  const [captureTest, setCaptureTest] = useState<CaptureTestResultState>(null);
  const [lastTestPassedAtMs, setLastTestPassedAtMs] = useState<number | null>(() => {
    const raw = Number(window.localStorage.getItem("tablerecords.lastAudioTestPassedAt") ?? "");
    return Number.isFinite(raw) && raw > 0 ? raw : null;
  });
  const [logJobId, setLogJobId] = useState<string | null>(null);
  const [logs, setLogs] = useState<LogLine[]>([]);
  const [preview, setPreview] = useState<{ name: string; text: string; sessionId: string } | null>(null);
  const [previewMode, setPreviewMode] = useState<"rendered" | "source">("rendered");
  const previewBodyRef = useRef<HTMLDivElement | null>(null);
  const previewSessionDetail =
    preview && detail?.session.sessionId === preview.sessionId ? detail : null;
  const previewHeadings = preview ? markdownHeadings(preview.text) : [];
  const previewMoments = previewSessionDetail?.markers ?? [];
  const [checks, setChecks] = useState<HealthCheck[]>([]);
  const [checksRanAtMs, setChecksRanAtMs] = useState<number | null>(null);
  const [recentSeconds, setRecentSeconds] = useState(180);
  const [recentContext, setRecentContext] = useState<RecentContextResult | null>(null);
  const [llmSummary, setLlmSummary] = useState<LlmSummaryResult | null>(null);
  const [llmProgress, setLlmProgress] = useState<LlmProgress | null>(null);
  const llmProgressId = useRef<string | null>(null);
  const [llmSummaries, setLlmSummaries] = useState<LlmSummaryResult[]>([]);
  const [llmPreset, setLlmPreset] = useState<LlmSummaryPreset>("gm-prep");
  const [llmScope, setLlmScope] = useState<LlmSummaryScope>("recent");
  const selectedRef = useRef<string | null>(null);
  const initialSessionRef = useRef<string | null>(initialRoute.sessionId);
  const liveDetailTimer = useRef<number | null>(null);
  const botReadyRefresh = useRef(false);
  const pendingContextJobs = useRef<Set<string>>(new Set());
  selectedRef.current = selectedId;

  const showToast = useCallback((tone: "ok" | "warn" | "bad", message: string) => {
    setToast({ tone, message });
    window.setTimeout(() => setToast((current) => (current?.message === message ? null : current)), 6000);
  }, []);

  const rememberAudioTest = useCallback((result: CaptureTestResultState) => {
    if (result && result.totalBytes > 0) {
      const now = Date.now();
      setLastTestPassedAtMs(now);
      window.localStorage.setItem("tablerecords.lastAudioTestPassedAt", String(now));
    } else {
      setLastTestPassedAtMs(null);
      window.localStorage.removeItem("tablerecords.lastAudioTestPassedAt");
    }
  }, []);

  const handleError = useCallback(
    (error: unknown) => {
      if (error instanceof ApiError && error.status === 401) {
        setAuthRequired(true);
        setAuthed(false);
        return;
      }
      showToast("bad", humanMessage(error));
    },
    [showToast]
  );

  const refreshRoster = useCallback(async (worldId: string) => {
    const result = await api<{ profiles: RosterPerson[] }>(`/api/people/roster?worldId=${encodeURIComponent(worldId)}`);
    setRoster(result.profiles);
  }, []);

  const runTask = useCallback(
    async (label: string, task: () => Promise<void>) => {
      setBusy(label);
      try {
        await task();
      } catch (error) {
        handleError(error);
      } finally {
        if (label === "llm") {
          llmProgressId.current = null;
          setLlmProgress(null);
        }
        setBusy(null);
      }
    },
    [handleError]
  );

  const loadSessions = useCallback(async (): Promise<SessionSummary[]> => {
    const result = await api<{ sessions: SessionSummary[] }>("/api/sessions");
    setSessions(result.sessions);
    return result.sessions;
  }, []);

  const loadDetail = useCallback(async (sessionId: string) => {
    const [nextDetail, nextJobs, nextOutputs, nextLlm] = await Promise.all([
      api<SessionDetail>(`/api/sessions/${sessionId}`),
      api<{ jobs: Job[] }>(`/api/sessions/${sessionId}/jobs`),
      api<{ outputs: OutputFile[] }>(`/api/sessions/${sessionId}/outputs`),
      api<{ summaries: LlmSummaryResult[] }>(`/api/sessions/${sessionId}/llm/summaries`).catch(() => ({ summaries: [] }))
    ]);
    setDetail(nextDetail);
    setJobs(nextJobs.jobs);
    setOutputs(nextOutputs.outputs);
    setLlmSummaries(nextLlm.summaries);
  }, []);

  const loadChannels = useCallback(async (nextGuildId: string) => {
    if (!nextGuildId) {
      setChannels([]);
      return;
    }
    const result = await api<{ voiceChannels: VoiceChannel[] }>(`/api/discord/guilds/${nextGuildId}/channels`);
    setChannels(result.voiceChannels);
  }, []);

  const loadSetupData = useCallback(async () => {
    const [nextSettings, nextWorlds, nextGuilds, health] = await Promise.all([
      api<SettingsPayload>("/api/settings"),
      api<{ worlds: World[] }>("/api/foundry/worlds"),
      api<{ guilds: Guild[] }>("/api/discord/guilds"),
      api<{ checks: HealthCheck[]; ranAtMs: number }>("/api/health")
    ]);
    setSettings(nextSettings);
    setWorlds(nextWorlds.worlds);
    setGuilds(nextGuilds.guilds);
    setChecks(health.checks);
    setChecksRanAtMs(health.ranAtMs);
    const nextGuildId = nextSettings.settings.defaultGuildId || nextGuilds.guilds[0]?.id || "";
    setGuildId((current) => current || nextGuildId);
    if (nextGuildId) {
      const channelResult = await api<{ voiceChannels: VoiceChannel[] }>(`/api/discord/guilds/${nextGuildId}/channels`).catch(() => ({ voiceChannels: [] }));
      setChannels(channelResult.voiceChannels);
      setChannelId((current) => current || nextSettings.settings.defaultVoiceChannelId || channelResult.voiceChannels[0]?.id || "");
    }
  }, []);

  const boot = useCallback(async () => {
    setBootError(null);
    try {
      const nextStatus = await api<Status>("/api/status");
      setStatus(nextStatus);
      setAuthed(true);
      setAuthRequired(false);
      const nextSessions = await loadSessions();
      const requested = initialSessionRef.current;
      const preferred = requested && nextSessions.some((session) => session.sessionId === requested)
        ? requested
        : nextStatus.session.currentId && nextSessions.some((session) => session.sessionId === nextStatus.session.currentId)
          ? nextStatus.session.currentId
          : nextSessions[0]?.sessionId ?? null;
      setSelectedId((current) => current && nextSessions.some((session) => session.sessionId === current) ? current : preferred);
      void loadSetupData().catch(handleError);
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setAuthRequired(true);
        setAuthed(false);
      } else {
        setBootError(humanMessage(error));
      }
    }
  }, [loadSessions, loadSetupData, handleError]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!authed) return;
    const next = routeUrl({ view, sessionId: selectedId, tab: sessionTab, personKey: peopleKey });
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.replaceState(null, "", next);
    }
  }, [authed, view, selectedId, sessionTab, peopleKey]);

  useEffect(() => {
    const onPopState = () => {
      const route = parseRoute(window.location.href);
      setView(route.view);
      setSelectedId(route.sessionId);
      setSessionTab(route.tab);
      setPeopleKey(route.personKey);
      setWizardOpen(false);
    };
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setJobs([]);
      setOutputs([]);
      setVoiceMembers([]);
      return;
    }
    void loadDetail(selectedId).catch(handleError);
  }, [selectedId, loadDetail, handleError]);

  useEffect(() => {
    const worldId = detail?.session.world.id;
    if (!worldId) {
      setRoster([]);
      return;
    }
    let cancelled = false;
    void refreshRoster(worldId)
      .catch(() => {
        if (!cancelled) setRoster([]);
      });
    return () => {
      cancelled = true;
    };
  }, [detail?.session.world.id, refreshRoster]);

  useEffect(() => {
    if (!authed) return;
    const events = new EventSource("/api/events");
    events.addEventListener("status", (event) => {
      try {
        setStatus(JSON.parse((event as MessageEvent).data) as Status);
      } catch {
        // ignore malformed event
      }
    });
    events.addEventListener("session.updated", () => {
      void loadSessions().catch(() => undefined);
      if (selectedRef.current) void loadDetail(selectedRef.current).catch(() => undefined);
    });
    events.addEventListener("llm.progress", (event) => {
      try {
        const progress = JSON.parse((event as MessageEvent).data) as LlmProgress;
        if (progress.progressId === llmProgressId.current) setLlmProgress(progress);
      } catch {
        // ignore malformed event
      }
    });
    events.addEventListener("session.deleted", (event) => {
      try {
        const deleted = JSON.parse((event as MessageEvent).data) as { sessionId?: string };
        if (deleted.sessionId && deleted.sessionId === selectedRef.current) {
          setSelectedId(null);
          setDetail(null);
          setJobs([]);
          setOutputs([]);
        }
        void loadSessions().catch(() => undefined);
      } catch {
        // ignore malformed event
      }
    });
    events.addEventListener("job.updated", (event) => {
      try {
        const job = JSON.parse((event as MessageEvent).data) as Job;
        if (job.sessionId !== selectedRef.current) return;
        setJobs((current) => {
          const index = current.findIndex((item) => item.jobId === job.jobId);
          if (index < 0) return [job, ...current];
          const next = [...current];
          next[index] = job;
          return next;
        });
        if (["done", "failed", "cancelled"].includes(job.status)) {
          // A job can finish without a session status transition (for example a
          // merge on an already-ready session), so refresh outputs explicitly.
          void loadDetail(job.sessionId).catch(() => undefined);
          if (job.type === "context" && pendingContextJobs.current.delete(job.jobId)) {
            if (job.status === "done" && job.result) {
              const result = job.result as unknown as RecentContextResult;
              setRecentContext(result);
              showToast("ok", `Brief ready (${result.counts?.events ?? 0} moments)`);
            } else {
              showToast("bad", job.error?.message ?? "The brief did not finish");
            }
          }
        }
      } catch {
        // ignore
      }
    });
    events.addEventListener("job.log", (event) => {
      try {
        const line = JSON.parse((event as MessageEvent).data) as { jobId: string; seq: number; tsMs: number; level: string; line: string };
        setLogJobId((currentJob) => {
          if (currentJob === line.jobId) {
            setLogs((current) => (current.some((item) => item.seq === line.seq) ? current : [...current, line]));
          }
          return currentJob;
        });
      } catch {
        // ignore
      }
    });
    events.addEventListener("marker.created", () => {
      if (selectedRef.current) void loadDetail(selectedRef.current).catch(() => undefined);
    });
    events.addEventListener("review.updated", (event) => {
      try {
        const data = JSON.parse((event as MessageEvent).data) as { sessionId?: string };
        if (data.sessionId && data.sessionId === selectedRef.current) {
          void loadDetail(data.sessionId).catch(() => undefined);
          showToast("ok", "Review audio ready");
        }
      } catch {
        // ignore malformed event
      }
    });
    events.addEventListener("foundry.imported", () => {
      if (selectedRef.current) void loadDetail(selectedRef.current).catch(() => undefined);
    });
    events.addEventListener("foundry.live", (event) => {
      try {
        const status = JSON.parse((event as MessageEvent).data) as SettingsPayload["foundryBridge"]["status"];
        setSettings((current) => (current ? { ...current, foundryBridge: { ...current.foundryBridge, status } } : current));
        const target = status.targetSessionId;
        if (target && target === selectedRef.current) {
          if (liveDetailTimer.current) window.clearTimeout(liveDetailTimer.current);
          liveDetailTimer.current = window.setTimeout(() => {
            liveDetailTimer.current = null;
            if (target === selectedRef.current) void loadDetail(target).catch(() => undefined);
          }, 900);
        }
      } catch {
        // ignore malformed event
      }
    });
    events.addEventListener("warning", (event) => {
      try {
        const warning = JSON.parse((event as MessageEvent).data) as { message: string };
        showToast("warn", warning.message);
      } catch {
        // ignore
      }
    });
    events.addEventListener("capture-test.finished", (event) => {
      try {
        const result = JSON.parse((event as MessageEvent).data) as CaptureTestResult;
        setCaptureTest(result);
        rememberAudioTest(result);
      } catch {
        // ignore
      }
      void api<Status>("/api/status").then(setStatus).catch(() => undefined);
    });
    return () => {
      events.close();
      if (liveDetailTimer.current) window.clearTimeout(liveDetailTimer.current);
    };
  }, [authed, loadSessions, loadDetail, showToast, rememberAudioTest]);

  useEffect(() => {
    if (!authed) {
      botReadyRefresh.current = false;
      return;
    }
    if (status?.bot.state === "ready" && guilds.length === 0 && !botReadyRefresh.current) {
      botReadyRefresh.current = true;
      void loadSetupData().catch(() => undefined);
    }
  }, [authed, status?.bot.state, guilds.length, loadSetupData]);

  useEffect(() => {
    if (settings) setRecentSeconds(settings.settings.recentContextSeconds);
  }, [settings?.settings.recentContextSeconds]);

  useEffect(() => {
    if (!settings) return;
    if (settings.env.discordTokenConfigured) {
      window.localStorage.removeItem("tablerecords.setupWizardDismissed");
      return;
    }
    if (wizardOpen) return;
    if (window.localStorage.getItem("tablerecords.setupWizardDismissed") === "1") return;
    setWizardOpen(true);
  }, [settings, wizardOpen]);

  const closeWizard = () => {
    window.localStorage.setItem("tablerecords.setupWizardDismissed", "1");
    setWizardOpen(false);
    window.scrollTo({ top: 0 });
  };

  const pushRoute = (
    nextView: AppView,
    nextSessionId: string | null = selectedRef.current,
    nextTab: SessionTab = sessionTab,
    nextPersonKey: string | null = peopleKey
  ) => {
    const next = routeUrl({ view: nextView, sessionId: nextSessionId, tab: nextTab, personKey: nextPersonKey });
    if (`${window.location.pathname}${window.location.search}` !== next) {
      window.history.pushState(null, "", next);
    }
  };

  const openView = (next: AppView) => {
    setWizardOpen(false);
    setView(next);
    pushRoute(next);
    window.scrollTo({ top: 0 });
  };

  const goToRecord = () => openView("record");

  const goToSessions = () => openView("sessions");

  const refreshPeopleChanges = () => {
    void loadSessions();
    if (selectedRef.current) void loadDetail(selectedRef.current).catch(() => undefined);
  };

  const selectSession = (sessionId: string) => {
    setWizardOpen(false);
    setSelectedId(sessionId);
    setView("sessions");
    pushRoute("sessions", sessionId);
    window.scrollTo({ top: 0 });
  };

  const openSession = (sessionId: string) => selectSession(sessionId);

  const changeSessionTab = (next: SessionTab) => {
    setSessionTab(next);
    if (view === "sessions") pushRoute("sessions", selectedRef.current, next);
  };

  const selectPerson = (key: string) => {
    setPeopleKey(key);
    if (view === "people") pushRoute("people", selectedRef.current, sessionTab, key);
  };

  useEffect(() => {
    if (!detail || guilds.length === 0) return;
    const session = detail.session;
    const sessionGuild = session.guild?.id;
    if (!sessionGuild || !guilds.some((guild) => guild.id === sessionGuild)) return;
    if (!guildId) {
      setGuildId(sessionGuild);
      if (session.voiceChannel?.id) setChannelId(session.voiceChannel.id);
    } else if (guildId === sessionGuild && !channelId && session.voiceChannel?.id) {
      setChannelId(session.voiceChannel.id);
    }
  }, [detail, guilds, guildId, channelId]);

  useEffect(() => {
    if (guildId && authed) {
      void loadChannels(guildId).catch(() => {
        setChannels([]);
      });
    }
  }, [guildId, authed, loadChannels]);

  const auth = async (token: string) => {
    try {
      await post<void>("/api/auth", { token });
      await boot();
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        setBootError("That token did not match.");
        return;
      }
      handleError(error);
    }
  };

  const join = () =>
    runTask("join", async () => {
      if (!guildId || !channelId) throw new Error("Select a server and a voice channel first.");
      const next = await post<Status>(`/api/discord/join`, { guildId, channelId });
      setStatus(next);
      showToast("ok", "Joined the voice channel");
    });

  const leave = () =>
    runTask("leave", async () => {
      const next = await post<Status>("/api/discord/leave");
      setStatus(next);
      showToast("ok", "Left the voice channel");
    });

  const startSession = (sessionId: string, promptPlayers = false) =>
    runTask("start", async () => {
      const next = await post<Status>(`/api/sessions/${sessionId}/start`, { promptPlayers });
      setStatus(next);
      await loadDetail(sessionId);
      await loadSessions();
      showToast("ok", promptPlayers ? "Recording started · consent prompt sent to Foundry" : "Recording started");
    });

  const stopSession = (sessionId: string) =>
    runTask("stop", async () => {
      if (!window.confirm("Stop and save this recording? You can still build the notes afterwards.")) return;
      const next = await post<Status>(`/api/sessions/${sessionId}/stop`);
      setStatus(next);
      await loadDetail(sessionId);
      await loadSessions();
      showToast("ok", "Recording saved");
    });

  const addMarker = (sessionId: string, kind: string, mentalNote = false) =>
    runTask("marker", async () => {
      await post(`/api/sessions/${sessionId}/markers`, { kind, mentalNote, label: markerLabel || undefined });
      setMarkerLabel("");
      await loadDetail(sessionId);
      showToast("ok", `${mentalNote ? "Note to self" : kind} added`);
    });

  const deleteMarker = (sessionId: string, markerId: string) =>
    runTask("marker-delete", async () => {
      if (!window.confirm("Delete this marker?")) return;
      await del(`/api/sessions/${sessionId}/markers/${markerId}`);
      await loadDetail(sessionId);
      showToast("ok", "Marker deleted");
    });

  const enqueue = (sessionId: string, type: string) =>
    runTask("enqueue", async () => {
      const job = await post<Job>(`/api/sessions/${sessionId}/jobs`, { type });
      setJobs((current) => [job, ...current]);
      showToast("ok", type === "run_all" ? "Building notes" : `${jobLabel(type)} queued`);
    });

  const buildRecent = (sessionId: string, windowSeconds: number) =>
    runTask("recent", async () => {
      const job = await post<Job>(`/api/sessions/${sessionId}/context/jobs`, {
        windowSeconds,
        transcribe: true
      });
      pendingContextJobs.current.add(job.jobId);
      setJobs((current) => [job, ...current.filter((item) => item.jobId !== job.jobId)]);
      showToast(
        "ok",
        job.progress.queuePosition && job.progress.queuePosition > 1
          ? `Brief queued (#${job.progress.queuePosition})`
          : "Brief queued"
      );
    });

  const openContextJob = async (jobId: string) => {
    try {
      const job = await api<Job>(`/api/jobs/${jobId}`);
      if (job.status !== "done" || !job.result) {
        throw new Error(job.error?.message ?? "The brief is not ready yet");
      }
      setRecentContext(job.result as unknown as RecentContextResult);
    } catch (error) {
      handleError(error);
    }
  };

  const summarizeLocally = (sessionId: string, windowSeconds: number) =>
    runTask("llm", async () => {
      const progressId = crypto.randomUUID();
      llmProgressId.current = progressId;
      setLlmProgress({
        progressId,
        sessionId,
        phase: "preparing",
        completed: 0,
        total: 1,
        label: "Preparing the session brief"
      });
      const result = await post<LlmSummaryResult>(`/api/sessions/${sessionId}/llm/summarize`, {
        windowSeconds,
        preset: llmPreset,
        scope: llmScope,
        progressId
      });
      setLlmSummary(result);
      setLlmSummaries((current) => [result, ...current.filter((item) => item.summaryId !== result.summaryId)]);
      showToast("ok", "Summary ready");
    });

  const cancelJob = (jobId: string) =>
    runTask("cancel", async () => {
      if (!window.confirm("Stop this build? Files already written may stay.")) return;
      const job = await post<Job>(`/api/jobs/${jobId}/cancel`);
      setJobs((current) => current.map((item) => (item.jobId === job.jobId ? job : item)));
    });

  const retryJob = (jobId: string) =>
    runTask("retry", async () => {
      const job = await post<Job>(`/api/jobs/${jobId}/retry`);
      setJobs((current) => [job, ...current]);
      showToast("ok", "Running again");
    });

  const showLogs = async (jobId: string) => {
    setLogJobId(jobId);
    setLogs([]);
    try {
      const result = await api<{ lines: LogLine[] }>(`/api/jobs/${jobId}/logs?limit=500`);
      setLogs(result.lines);
    } catch (error) {
      handleError(error);
    }
  };

  const previewOutput = async (sessionId: string, name: string) => {
    try {
      const response = await fetch(`/api/sessions/${sessionId}/outputs/${name}`, { credentials: "same-origin" });
      if (!response.ok) throw new Error(`Could not load ${name}`);
      const text = await response.text();
      setPreview({ name, text, sessionId });
      setPreviewMode(/\.md$/i.test(name) ? "rendered" : "source");
      requestAnimationFrame(() => {
        if (previewBodyRef.current) previewBodyRef.current.scrollTop = 0;
      });
    } catch (error) {
      handleError(error);
    }
  };

  const scrollPreviewHeading = (id: string) => {
    const container = previewBodyRef.current;
    const target = container?.querySelector<HTMLElement>(`#${CSS.escape(id)}`) ?? document.getElementById(id);
    target?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const scrollPreviewClock = (clock: string) => {
    const container = previewBodyRef.current;
    if (!container) return;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node) {
      if (node.textContent?.includes(clock)) {
        const target = node.parentElement;
        if (target) {
          target.scrollIntoView({ behavior: "smooth", block: "center" });
          target.classList.add("preview-flash");
          window.setTimeout(() => target.classList.remove("preview-flash"), 1200);
        }
        return;
      }
      node = walker.nextNode();
    }
  };

  const importFoundry = (sessionId: string, file: File) =>
    runTask("import", async () => {
      const summary = await upload<{ messageCount: number; rollCount: number }>(`/api/sessions/${sessionId}/foundry/import`, file);
      await loadDetail(sessionId);
      await loadSessions();
      showToast("ok", `Imported ${summary.rollCount} ${summary.rollCount === 1 ? "roll" : "rolls"} and ${summary.messageCount} chat ${summary.messageCount === 1 ? "line" : "lines"}`);
    });

  const savePeople = async (sessionId: string, people: SessionDetail["people"]): Promise<SessionDetail["people"] | undefined> => {
    setBusy("people");
    try {
      const next = await put<SessionDetail>(`/api/sessions/${sessionId}/people`, { people });
      setDetail(next);
      await refreshRoster(next.session.world.id);
      showToast("ok", "People mapping saved");
      return next.people;
    } catch (error) {
      handleError(error);
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const createSession = async (payload: Record<string, unknown>): Promise<boolean> => {
    setBusy("create");
    try {
      const created = await post<SessionDetail>("/api/sessions", payload);
      selectSession(created.session.sessionId);
      await refreshRoster(created.session.world.id);
      await loadSessions();
      setView("sessions");
      showToast("ok", "Session created");
      return true;
    } catch (error) {
      handleError(error);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const updateSession = (sessionId: string, payload: Record<string, unknown>) =>
    runTask("update", async () => {
      const next = await patch<SessionDetail>(`/api/sessions/${sessionId}`, payload);
      setDetail(next);
      await loadSessions();
      showToast("ok", "Session updated");
    });

  const updateMergeSettings = (sessionId: string, beforeMs: number, afterMs: number) =>
    runTask("merge-settings", async () => {
      const next = await put<SessionDetail>(`/api/sessions/${sessionId}/merge-settings`, {
        rollContextBeforeMs: beforeMs,
        rollContextAfterMs: afterMs
      });
      setDetail(next);
      showToast("ok", "Roll timing saved");
    });

  const archiveSession = (sessionId: string, archived: boolean) =>
    runTask("archive", async () => {
      const next = await post<SessionDetail>(`/api/sessions/${sessionId}/archive`, { archived });
      setDetail(next);
      await loadSessions();
      showToast("ok", archived ? "Session archived" : "Session restored");
    });

  const deleteSession = (sessionId: string) =>
    runTask("delete", async () => {
      const confirmation = window.prompt(`Type the session ID to permanently delete it:\n${sessionId}`);
      if (confirmation !== sessionId) {
        if (confirmation !== null) showToast("warn", "Delete cancelled; the ID did not match");
        return;
      }
      await del(`/api/sessions/${sessionId}?confirm=${encodeURIComponent(sessionId)}`);
      setSelectedId(null);
      setDetail(null);
      setJobs([]);
      setOutputs([]);
      await loadSessions();
      showToast("ok", "Session deleted");
    });

  const buildReviewAudio = (sessionId: string) =>
    runTask("review-audio", async () => {
      const result = await post<{ files: Array<{ label: string }> }>(`/api/sessions/${sessionId}/review-audio`, {});
      await loadDetail(sessionId);
      showToast("ok", `Review audio ready: ${result.files.map((file) => file.label).join(", ")}`);
    });

  const compactAudio = (sessionId: string) =>
    runTask("compact-audio", async () => {
      const result = await post<{ converted: number; after: { bytes: number } }>(`/api/sessions/${sessionId}/audio/compact`, {});
      await loadDetail(sessionId);
      showToast("ok", result.converted > 0 ? `Compacted ${result.converted} clip(s)` : "Clips are already compacted");
    });

  const removeAudio = (sessionId: string) =>
    runTask("remove-audio", async () => {
      await post(`/api/sessions/${sessionId}/audio/remove`, {});
      await loadDetail(sessionId);
      showToast("ok", "Clip audio removed; review tracks kept");
    });

  const loadVoiceMembers = (sessionId: string) =>
    runTask("voice-members", async () => {
      const channelId = detail?.session.sessionId === sessionId ? detail.session.voiceChannel?.id : null;
      if (!channelId) {
        showToast("warn", "Pick a voice channel for this session first");
        return;
      }
      const result = await api<{ members: VoiceMember[] }>(`/api/discord/channels/${channelId}/members`);
      setVoiceMembers(result.members.filter((member) => !member.isBot));
      showToast("ok", `${result.members.filter((member) => !member.isBot).length} people in the channel`);
    });

  const saveSettings = (payload: Record<string, unknown>) =>
    runTask("settings", async () => {
      const next = await put<SettingsPayload>("/api/settings", payload);
      const keys = Object.keys(payload);
      const bridgeOnly = keys.length > 0 && keys.every((key) => key === "foundryLiveEnabled" || key === "foundryLiveMarkers");
      setSettings((current) => (bridgeOnly && current ? { ...current, foundryBridge: next.foundryBridge } : next));
      const worldsResult = await api<{ worlds: World[] }>("/api/foundry/worlds");
      setWorlds(worldsResult.worlds);
      showToast("ok", "Settings saved");
    });

  const rotateBridgeToken = async (): Promise<string | undefined> => {
    setBusy("rotate");
    try {
      const result = await post<{ token: string }>("/api/foundry/bridge/rotate");
      setSettings((current) =>
        current ? { ...current, foundryBridge: { ...current.foundryBridge, token: result.token } } : current
      );
      showToast("ok", "New token created. Paste it into the Foundry module settings.");
      return result.token;
    } catch (error) {
      handleError(error);
      return undefined;
    } finally {
      setBusy(null);
    }
  };

  const installFoundryModule = () =>
    runTask("module-install", async () => {
      const result = await post<{ installedTo: string; note: string }>("/api/foundry/module/install");
      showToast("ok", `Module installed. ${result.note}`);
    });

  const runDoctor = () =>
    runTask("doctor", async () => {
      const result = await post<{ checks: HealthCheck[]; ranAtMs: number }>("/api/doctor/run");
      setChecks(result.checks);
      setChecksRanAtMs(result.ranAtMs);
      showToast("ok", "Checks complete");
    });

  const startCaptureTest = async (
    targetGuildId: string = guildId,
    targetChannelId: string = channelId
  ): Promise<boolean> => {
    if (!targetGuildId || !targetChannelId) {
      showToast("warn", "Select a server and voice channel first");
      return false;
    }
    setBusy("test");
    setCaptureTest(null);
    try {
      await post<{ testId: string }>("/api/capture-test/start", {
        guildId: targetGuildId,
        channelId: targetChannelId
      });
      showToast("ok", "Audio test started — say something at the table");
      const next = await api<Status>("/api/status");
      setStatus(next);
      return true;
    } catch (error) {
      handleError(error);
      return false;
    } finally {
      setBusy(null);
    }
  };

  const stopCaptureTest = async (): Promise<CaptureTestResultState> => {
    setBusy("test-stop");
    try {
      const result = await post<CaptureTestResult>("/api/capture-test/stop");
      setCaptureTest(result);
      rememberAudioTest(result);
      const next = await api<Status>("/api/status");
      setStatus(next);
      showToast(
        result && result.totalBytes > 0 ? "ok" : "bad",
        result
          ? result.totalBytes > 0
            ? `Audio test passed — ${result.utteranceCount} ${result.utteranceCount === 1 ? "clip" : "clips"} captured`
            : "Audio test failed — no audio reached the bot"
          : "No test result"
      );
      return result;
    } catch (error) {
      handleError(error);
      return null;
    } finally {
      setBusy(null);
    }
  };

  const markAudioTestComplete = useCallback((passed: boolean) => {
    if (passed) {
      const now = Date.now();
      setLastTestPassedAtMs(now);
      window.localStorage.setItem("tablerecords.lastAudioTestPassedAt", String(now));
      showToast("ok", "Audio test marked complete");
    } else {
      setLastTestPassedAtMs(null);
      window.localStorage.removeItem("tablerecords.lastAudioTestPassedAt");
      showToast("warn", "Audio test marked as not done");
    }
  }, [showToast]);

  const logout = async () => {
    await del("/api/auth");
    setAuthed(false);
    setAuthRequired(true);
  };

  if (!authed) {
    return (
      <AuthScreen
        required={authRequired}
        error={bootError}
        onAuth={auth}
        onRetry={() => void boot()}
      />
    );
  }

  const activeView = view;
  const audioTestPassed = lastTestPassedAtMs != null && Date.now() - lastTestPassedAtMs < 24 * 60 * 60_000;
  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark">TR</span>
          <div>
            <strong>TableRecords</strong>
            <div className="muted tiny">local Discord + Foundry capture</div>
          </div>
        </div>
        <nav>
          <button className={activeView === "record" ? "active" : ""} onClick={() => openView("record")}>Record</button>
          <button className={activeView === "sessions" ? "active" : ""} onClick={() => openView("sessions")}>Sessions</button>
          <button className={activeView === "people" ? "active" : ""} onClick={() => openView("people")}>People</button>
          <button className={activeView === "setup" ? "active" : ""} onClick={() => openView("setup")}>Setup</button>
        </nav>
        <div className="top-status">
          <Pill tone={status?.bot.state === "ready" ? "ok" : status?.bot.configured ? "warn" : "bad"}>
            Discord {status?.bot.state === "ready" ? "connected" : status?.bot.configured ? "starting" : "off"}
          </Pill>
          <Pill tone={status?.voice.state === "ready" ? "ok" : status?.voice.state === "error" ? "bad" : "idle"}>
            Voice {status?.voice.state === "ready" ? "connected" : "off"}
          </Pill>
          {status?.foundry.live.enabled && (
            <Pill tone={status.foundry.live.connected ? "ok" : "warn"}>
              Foundry {status.foundry.live.connected ? "live" : "waiting"}
            </Pill>
          )}
          {status?.capture.state === "recording" && <Pill tone="bad">REC {formatDateTime(status.capture.startedAtMs)}</Pill>}
        </div>
      </header>

      <main>
        {wizardOpen && settings ? (
          <SetupWizard
            settings={settings}
            status={status}
            checks={checks}
            guilds={guilds}
            worlds={worlds}
            captureTestPassed={audioTestPassed}
            busy={busy}
            onClose={closeWizard}
            onRefresh={() => void loadSetupData()}
            onSaveSettings={(payload) => saveSettings(payload)}
            onInstallModule={() => void installFoundryModule()}
            onGoRecord={goToRecord}
            onGoSessions={goToSessions}
            onGoSetup={() => openView("setup")}
            onAudioTest={() => setAudioWizardOpen(true)}
            onMarkAudioTest={markAudioTestComplete}
          />
        ) : (
          <>
        {activeView === "record" && (
          <RecordView
            status={status}
            detail={detail}
            jobs={jobs}
            outputs={outputs}
            guilds={guilds}
            channels={channels}
            guildId={guildId}
            channelId={channelId}
            busy={busy}
            markerLabel={markerLabel}
            captureTest={captureTest}
            onGuild={(value) => { setGuildId(value); setChannelId(""); }}
            onChannel={setChannelId}
            onJoin={join}
            onLeave={leave}
            onStart={startSession}
            onStop={stopSession}
            onMarker={(sessionId, kind, mentalNote) => void addMarker(sessionId, kind, mentalNote)}
            onDeleteMarker={(sessionId, markerId) => void deleteMarker(sessionId, markerId)}
            onMarkerLabel={setMarkerLabel}
            onEnqueue={(sessionId, type) => void enqueue(sessionId, type)}
            onCaptureTestStart={() => void startCaptureTest()}
            onCaptureTestStop={() => void stopCaptureTest()}
            onSessions={() => openView("sessions")}
            onSetup={() => openView("setup")}
            onConfirmConsent={(sessionId) =>
              void updateSession(sessionId, {
                consent: {
                  confirmed: true,
                  confirmedBy: detail?.session.consent.confirmedBy ?? "GM",
                  notes: detail?.session.consent.notes ?? "Consent recorded from the dashboard.",
                  method: "gm_tick",
                  noticeVersion: "2026-11-01"
                }
              })
            }
            recentSeconds={recentSeconds}
            onRecentSeconds={setRecentSeconds}
            onRecentContext={(sessionId, windowSeconds) => void buildRecent(sessionId, windowSeconds)}
            onOpenContext={(jobId) => void openContextJob(jobId)}
            llmEnabled={settings?.llm.enabled ?? false}
            llmConfigured={settings?.llm.configured ?? false}
            llmPreset={llmPreset}
            llmScope={llmScope}
            llmSummaries={llmSummaries}
            onLlmPreset={setLlmPreset}
            onLlmScope={setLlmScope}
            onLlmSummary={(sessionId, windowSeconds) => void summarizeLocally(sessionId, windowSeconds)}
            onOpenLlmSummary={setLlmSummary}
          />
        )}
        {activeView === "sessions" && (
          <SessionsView
            sessions={sessions}
            selectedId={selectedId}
            detail={detail}
            jobs={jobs}
            outputs={outputs}
            worlds={worlds}
            guilds={guilds}
            channels={channels}
            guildId={guildId}
            channelId={channelId}
            busy={busy}
            markerLabel={markerLabel}
            botReady={status?.bot.state === "ready"}
            onSelect={selectSession}
            onGuild={(value) => { setGuildId(value); setChannelId(""); }}
            onChannel={setChannelId}
            onCreate={createSession}
            onStart={startSession}
            onStop={stopSession}
            onMarker={(sessionId, kind, mentalNote) => void addMarker(sessionId, kind, mentalNote)}
            onDeleteMarker={(sessionId, markerId) => void deleteMarker(sessionId, markerId)}
            onMarkerLabel={setMarkerLabel}
            onMergeSettings={updateMergeSettings}
            onArchive={archiveSession}
            onDelete={deleteSession}
            onBuildReviewAudio={buildReviewAudio}
            onCompactAudio={compactAudio}
            onRemoveAudio={removeAudio}
            roster={roster}
            voiceMembers={voiceMembers}
            onLoadVoiceMembers={loadVoiceMembers}
            onSavePeople={savePeople}
            onImport={importFoundry}
            onEnqueue={(sessionId, type) => void enqueue(sessionId, type)}
            onCancel={(jobId) => void cancelJob(jobId)}
            onRetry={(jobId) => void retryJob(jobId)}
            onLogs={(jobId) => void showLogs(jobId)}
            onPreview={(sessionId, name) => void previewOutput(sessionId, name)}
            onUpdate={updateSession}
            tab={sessionTab}
            onTab={changeSessionTab}
            llmEnabled={settings?.llm.enabled ?? false}
            llmConfigured={settings?.llm.configured ?? false}
            llmPreset={llmPreset}
            llmScope={llmScope}
            llmSummaries={llmSummaries}
            recentSeconds={recentSeconds}
            onRecentSeconds={setRecentSeconds}
            onLlmPreset={setLlmPreset}
            onLlmScope={setLlmScope}
            onLlmSummary={(sessionId, windowSeconds) => void summarizeLocally(sessionId, windowSeconds)}
            onOpenLlmSummary={setLlmSummary}
          />
        )}
        {activeView === "people" && (
          <PeopleView
            sessions={sessions}
            selectedKey={peopleKey}
            onSelectPerson={selectPerson}
            onNotify={showToast}
            onOpenSession={openSession}
            onChanged={refreshPeopleChanges}
          />
        )}
        {activeView === "setup" && (
          <SetupView
            settings={settings}
            status={status}
            checks={checks}
            checksRanAtMs={checksRanAtMs}
            worlds={worlds}
            guilds={guilds}
            busy={busy}
            captureTestPassed={audioTestPassed}
            onDoctor={() => void runDoctor()}
            onSaveSettings={(payload) => saveSettings(payload)}
            onRotateBridgeToken={rotateBridgeToken}
            onInstallModule={() => void installFoundryModule()}
            onRefresh={() => void loadSetupData()}
            onLogout={() => void logout()}
            onGoRecord={goToRecord}
            onOpenWizard={() => setWizardOpen(true)}
            onAudioTest={() => setAudioWizardOpen(true)}
            onMarkAudioTest={markAudioTestComplete}
          />
        )}
          </>
        )}
      </main>

      {toast && (
        <div className={`toast ${toast.tone}`} onClick={() => setToast(null)}>
          {toast.message}
        </div>
      )}

      {audioWizardOpen && (
        <AudioTestWizard
          status={status}
          guilds={guilds}
          initialGuildId={guildId}
          initialChannelId={channelId || status?.voice.channelId || ""}
          initialChannels={channels}
          busy={busy}
          onStart={startCaptureTest}
          onStop={stopCaptureTest}
          onComplete={markAudioTestComplete}
          onClose={() => setAudioWizardOpen(false)}
        />
      )}

      {logJobId && (
        <Modal title={`Job log: ${logJobId}`} onClose={() => setLogJobId(null)}>
          <LogView lines={logs} />
        </Modal>
      )}
      {preview && (
        <Modal title={preview.name} onClose={() => setPreview(null)}>
          {/\.md$/i.test(preview.name) ? (
            <>
              <div className="preview-toolbar">
                <div className="button-row">
                  <Button
                    variant={previewMode === "rendered" ? "small primary" : "small"}
                    onClick={() => setPreviewMode("rendered")}
                  >
                    Preview
                  </Button>
                  <Button
                    variant={previewMode === "source" ? "small primary" : "small"}
                    onClick={() => setPreviewMode("source")}
                  >
                    Markdown source
                  </Button>
                </div>
                <span className="muted tiny">{preview.text.length.toLocaleString()} characters</span>
              </div>
              {previewMode === "rendered" ? (
                <div className="preview-reader">
                  {(previewHeadings.length > 0 || previewMoments.length > 0) && (
                    <nav className="preview-nav" aria-label="Document navigation">
                      {previewHeadings.length > 0 && (
                        <div className="preview-nav-block">
                          <div className="preview-nav-title">Contents</div>
                          {previewHeadings.map((heading) => (
                            <button
                              key={heading.id}
                              type="button"
                              className="preview-nav-link"
                              title={heading.text}
                              style={{ paddingLeft: `${8 + (heading.level - 1) * 10}px` }}
                              onClick={() => scrollPreviewHeading(heading.id)}
                            >
                              {heading.text}
                            </button>
                          ))}
                        </div>
                      )}
                      {previewMoments.length > 0 && (
                        <div className="preview-nav-block">
                          <div className="preview-nav-title">Session moments</div>
                          {previewMoments.map((marker) => {
                            const clock = formatTime(marker.tsMs, previewSessionDetail?.session.timeZone);
                            const colors: Record<string, string> = {
                              scene: "#f5b942",
                              break: "#60a5fa",
                              combat: "#f472b6",
                              note: "#a78bfa",
                              mental_note: "#34d399"
                            };
                            return (
                              <button
                                key={marker.markerId}
                                type="button"
                                className="preview-nav-link preview-moment"
                                onClick={() => scrollPreviewClock(clock)}
                                title={`${clock} — ${marker.label || marker.kind}`}
                              >
                                <span style={{ background: colors[marker.kind] ?? "#94a3b8" }} />
                                <span className="preview-moment-time">{clock}</span>
                                <span className="preview-moment-label">{marker.label || marker.kind}</span>
                              </button>
                            );
                          })}
                        </div>
                      )}
                    </nav>
                  )}
                  <div className="preview-content" ref={previewBodyRef}>
                    <MarkdownView text={preview.text} />
                  </div>
                </div>
              ) : (
                <pre className="preview">{preview.text}</pre>
              )}
            </>
          ) : (
            <pre className="preview">{preview.text}</pre>
          )}
          {preview && (
            <div className="button-row">
              <a
                className="btn primary small"
                href={`/api/sessions/${preview.sessionId}/outputs/${preview.name}?download=1`}
                download={preview.name}
              >
                Download {preview.name}
              </a>
            </div>
          )}
        </Modal>
      )}
      {llmProgress && <LlmProgressBanner progress={llmProgress} />}
      {recentContext && <RecentContextModal result={recentContext} onClose={() => setRecentContext(null)} />}
      {llmSummary && <LlmSummaryModal result={llmSummary} onClose={() => setLlmSummary(null)} />}
    </div>
  );
}

function LlmProgressBanner({ progress }: { progress: LlmProgress }) {
  const percent =
    progress.phase === "done"
      ? 100
      : progress.phase === "final"
        ? 95
        : progress.phase === "reduce"
          ? 70 + Math.round(20 * (progress.completed / Math.max(1, progress.total)))
          : progress.phase === "chunk"
            ? 5 + Math.round(65 * (progress.completed / Math.max(1, progress.total)))
            : 5;
  return (
    <div className="llm-progress" role="status" aria-live="polite">
      <div className="llm-progress-head">
        <strong>AI summary</strong>
        <span>{percent}%</span>
      </div>
      <p>{progress.label}</p>
      <div className="progress" aria-hidden="true">
        <span style={{ width: `${percent}%` }} />
      </div>
    </div>
  );
}

function AuthScreen({
  required,
  error,
  onAuth,
  onRetry
}: {
  required: boolean;
  error: string | null;
  onAuth: (token: string) => Promise<void>;
  onRetry: () => void;
}) {
  const [token, setToken] = useState("");
  const [submitting, setSubmitting] = useState(false);
  return (
    <div className="auth-shell">
      <div className="auth-card">
        <div className="brand">
          <span className="brand-mark">TR</span>
          <div>
            <strong>TableRecords</strong>
            <div className="muted tiny">local session capture</div>
          </div>
        </div>
        {required ? (
          <>
            <h1>Dashboard locked</h1>
            <p className="muted">This dashboard is locked. Enter the token from your .env file. The browser keeps it for this session only.</p>
            <form
              onSubmit={(event) => {
                event.preventDefault();
                setSubmitting(true);
                void onAuth(token).finally(() => setSubmitting(false));
              }}
            >
              <input type="password" value={token} onChange={(event) => setToken(event.target.value)} placeholder="Dashboard token" autoFocus />
              <button className="btn primary" type="submit" disabled={submitting || !token}>
                {submitting ? "Unlocking…" : "Unlock dashboard"}
              </button>
            </form>
          </>
        ) : (
          <>
            <h1>Cannot reach the local server</h1>
            <p className="muted">{error ?? "Check that npm run dashboard is running on 127.0.0.1:17300."}</p>
            <button className="btn primary" onClick={onRetry}>Retry</button>
          </>
        )}
        {error && required && <p className="bad-text small">{error}</p>}
      </div>
    </div>
  );
}
