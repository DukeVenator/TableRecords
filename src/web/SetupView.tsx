import { useEffect, useRef, useState } from "react";
import type {
  Guild,
  HealthCheck,
  LlmConnectionTest,
  LlmModelInfo,
  LlmProvider,
  LlmThinkingEffort,
  LlamaCppStatus,
  SettingsPayload,
  Status,
  World
} from "./types";
import { api, post } from "./api";
import { Button, Card, Disclosure, Field, Pill, Stat } from "./components";
import { formatBytes, formatDateTime, formatRelative, statusTone, sttStateLabel } from "./format";
import { DISCORD_DEVELOPER_PORTAL, botInviteUrl, buildSetupSteps, setupProgress, type SetupStep } from "./setupStatus";
import { FOUNDRY_CONSENT_COMMAND_VERSION, versionAtLeast } from "../core/version.js";
import { summaryInputCharBudget } from "../core/llmPrompts.js";

export interface SetupProps {
  settings: SettingsPayload | null;
  status: Status | null;
  checks: HealthCheck[];
  checksRanAtMs: number | null;
  worlds: World[];
  guilds: Guild[];
  busy: string | null;
  captureTestPassed: boolean;
  onDoctor: () => void;
  onSaveSettings: (payload: Record<string, unknown>) => Promise<void> | void;
  onRotateBridgeToken: () => Promise<string | undefined>;
  onInstallModule: () => void;
  onRefresh: () => void;
  onLogout: () => void;
  onGoRecord: () => void;
  onOpenWizard: () => void;
  onAudioTest: () => void;
  onMarkAudioTest: (passed: boolean) => void;
}

export function SetupView(props: SetupProps) {
  const [foundryPath, setFoundryPath] = useState("");
  const [botName, setBotName] = useState("Scribblespark");
  const [activityType, setActivityType] = useState<"playing" | "listening" | "watching" | "competing">("watching");
  const [activityText, setActivityText] = useState("");
  const [activityDynamic, setActivityDynamic] = useState(true);
  const [engine, setEngine] = useState<"parakeet" | "faster-whisper">("parakeet");
  const [model, setModel] = useState("large-v3-turbo");
  const [device, setDevice] = useState("cuda");
  const [computeType, setComputeType] = useState("float16");
  const [language, setLanguage] = useState("en");
  const [beamSize, setBeamSize] = useState(5);
  const [vadFilter, setVadFilter] = useState(false);
  const [noSpeechThreshold, setNoSpeechThreshold] = useState(0.6);
  const [logProbThreshold, setLogProbThreshold] = useState(-1);
  const [compressionRatioThreshold, setCompressionRatioThreshold] = useState(2.4);
  const [promptExtra, setPromptExtra] = useState("");
  const [hotwordsExtra, setHotwordsExtra] = useState("");
  const [parakeetPath, setParakeetPath] = useState("nemo-speech");
  const [parakeetModel, setParakeetModel] = useState("");
  const [parakeetDevice, setParakeetDevice] = useState("cuda");
  const [parakeetConcurrency, setParakeetConcurrency] = useState(4);
  const [rollBeforeSeconds, setRollBeforeSeconds] = useState(20);
  const [rollAfterSeconds, setRollAfterSeconds] = useState(10);
  const [recentSeconds, setRecentSeconds] = useState(180);
  const [liveEnabled, setLiveEnabled] = useState(false);
  const [liveMarkers, setLiveMarkers] = useState(true);
  const [llmEnabled, setLlmEnabled] = useState(false);
  const [llmProvider, setLlmProvider] = useState<LlmProvider>("ollama");
  const [llmCloudEnabled, setLlmCloudEnabled] = useState(false);
  const [llmBaseUrl, setLlmBaseUrl] = useState("http://127.0.0.1:11434");
  const [llmModel, setLlmModel] = useState("");
  const [llmTimeoutSeconds, setLlmTimeoutSeconds] = useState(60);
  const [llmMaxInputChars, setLlmMaxInputChars] = useState(40_000);
  const [llmContextTokens, setLlmContextTokens] = useState(16_384);
  const [llmGpuLayers, setLlmGpuLayers] = useState<number | null>(null);
  const [llamacppNcpuMoe, setLlamacppNcpuMoe] = useState(0);
  const [llamacppKvCache, setLlamacppKvCache] = useState<"f16" | "q8_0" | "q4_0">("q8_0");
  const [llamacppFlashAttn, setLlamacppFlashAttn] = useState(true);
  const [llamacppExe, setLlamacppExe] = useState("llama-server.exe");
  const [llamacppModelPath, setLlamacppModelPath] = useState("");
  const [llamacppPort, setLlamacppPort] = useState(9931);
  const [llamacppAutostart, setLlamacppAutostart] = useState(false);
  const [llamacppBusy, setLlamacppBusy] = useState<string | null>(null);
  const [liveLlama, setLiveLlama] = useState<LlamaCppStatus | null>(null);
  const [llmThinkingEffort, setLlmThinkingEffort] = useState<LlmThinkingEffort>("off");
  const [llmModels, setLlmModels] = useState<LlmModelInfo[]>([]);
  const [llmModelsBusy, setLlmModelsBusy] = useState(false);
  const [llmModelsError, setLlmModelsError] = useState<string | null>(null);
  const [llmTest, setLlmTest] = useState<LlmConnectionTest | null>(null);
  const [tokenCopied, setTokenCopied] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);
  const lastSettingsRef = useRef<SettingsPayload["settings"] | null>(null);
  const foundryInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!props.settings) return;
    if (lastSettingsRef.current === props.settings.settings) return;
    lastSettingsRef.current = props.settings.settings;
    setFoundryPath(props.settings.settings.foundryDataPath ?? "");
    setBotName(props.settings.settings.discordBotName);
    setActivityType(props.settings.settings.discordActivityType);
    setActivityText(props.settings.settings.discordActivityText);
    setActivityDynamic(props.settings.settings.discordActivityDynamic);
    setEngine(props.settings.settings.sttEngine);
    setModel(props.settings.settings.sttModel);
    setDevice(props.settings.settings.sttDevice);
    setComputeType(props.settings.settings.sttComputeType);
    setLanguage(props.settings.settings.sttLanguage);
    setBeamSize(props.settings.settings.sttBeamSize);
    setVadFilter(props.settings.settings.sttVadFilter);
    setNoSpeechThreshold(props.settings.settings.sttNoSpeechThreshold);
    setLogProbThreshold(props.settings.settings.sttLogProbThreshold);
    setCompressionRatioThreshold(props.settings.settings.sttCompressionRatioThreshold);
    setPromptExtra(props.settings.settings.sttPromptExtra);
    setHotwordsExtra(props.settings.settings.sttHotwordsExtra);
    setParakeetPath(props.settings.settings.parakeetPath);
    setParakeetModel(props.settings.settings.parakeetModel);
    setParakeetDevice(props.settings.settings.parakeetDevice);
    setParakeetConcurrency(props.settings.settings.parakeetConcurrency);
    setRollBeforeSeconds(Math.round(props.settings.settings.rollContextBeforeMs / 1000));
    setRollAfterSeconds(Math.round(props.settings.settings.rollContextAfterMs / 1000));
    setRecentSeconds(props.settings.settings.recentContextSeconds);
  }, [props.settings]);

  useEffect(() => {
    if (!props.settings) return;
    setLiveEnabled(props.settings.foundryBridge.status.enabled);
    setLiveMarkers(props.settings.foundryBridge.status.markers);
  }, [
    props.settings?.foundryBridge.token,
    props.settings?.foundryBridge.status.enabled,
    props.settings?.foundryBridge.status.markers
  ]);

  useEffect(() => {
    if (llmProvider !== "llamacpp") return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await api<LlamaCppStatus>("/api/llamacpp/status");
        if (!cancelled) setLiveLlama(status);
      } catch {
        // Keep the last known status when a poll fails.
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 5_000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [llmProvider]);

  useEffect(() => {
    if (!props.settings) return;
    setLlmEnabled(props.settings.llm.enabled);
    setLlmProvider(props.settings.llm.provider);
    setLlmCloudEnabled(props.settings.llm.cloudEnabled);
    setLlmBaseUrl(props.settings.llm.baseUrl ?? "http://127.0.0.1:11434");
    setLlmModel(props.settings.llm.model ?? "");
    setLlmTimeoutSeconds(Math.round(props.settings.llm.timeoutMs / 1000));
    setLlmMaxInputChars(props.settings.llm.maxInputChars);
    setLlmContextTokens(props.settings.llm.contextTokens);
    setLlmGpuLayers(props.settings.llm.gpuLayers);
    setLlamacppNcpuMoe(props.settings.llm.llamacppNcpuMoe);
    setLlamacppKvCache(props.settings.llm.llamacppKvCache);
    setLlamacppFlashAttn(props.settings.llm.llamacppFlashAttn);
    setLlamacppExe(props.settings.llamacpp.exe);
    setLlamacppModelPath(props.settings.llamacpp.modelPath ?? "");
    setLlamacppPort(props.settings.llamacpp.port);
    setLlamacppAutostart(props.settings.llamacpp.autostart);
    setLiveLlama(props.settings.llamacpp);
    setLlmThinkingEffort(props.settings.llm.thinkingEffort);
  }, [
    props.settings?.llm.enabled,
    props.settings?.llm.provider,
    props.settings?.llm.cloudEnabled,
    props.settings?.llm.baseUrl,
    props.settings?.llm.model,
    props.settings?.llm.timeoutMs,
    props.settings?.llm.maxInputChars,
    props.settings?.llm.contextTokens,
    props.settings?.llm.gpuLayers,
    props.settings?.llm.llamacppNcpuMoe,
    props.settings?.llm.llamacppKvCache,
    props.settings?.llm.llamacppFlashAttn,
    props.settings?.llamacpp.exe,
    props.settings?.llamacpp.modelPath,
    props.settings?.llamacpp.port,
    props.settings?.llamacpp.autostart,
    props.settings?.llm.thinkingEffort
  ]);

  if (!props.settings) {
    return <div className="loading">Loading setup…</div>;
  }
  const env = props.settings.env;
  const bridge = props.settings.foundryBridge;
  const bridgeStatus = bridge.status;
  const engineLabel = engine === "parakeet" ? "Parrot (Parakeet)" : "Whisper (faster-whisper)";
  const problems = props.checks.filter((check) => check.status === "warning" || check.status === "error");
  const healthy = props.checks.filter((check) => check.status !== "warning" && check.status !== "error");

  const llamaStatus = liveLlama ?? props.settings?.llamacpp ?? null;
  const effectiveInputBudget = summaryInputCharBudget(llmContextTokens, llmMaxInputChars, llmThinkingEffort);
  const llmPayload = () => ({
    llmEnabled,
    llmProvider,
    llmCloudEnabled,
    llmBaseUrl: llmProvider === "deepseek" ? null : llmBaseUrl.trim() || null,
    llmModel: llmModel.trim() || null,
    llmTimeoutMs: Math.round(llmTimeoutSeconds * 1000),
    llmMaxInputChars: Math.round(llmMaxInputChars),
    llmContextTokens: Math.round(llmContextTokens),
    llmGpuLayers,
    llamacppNcpuMoe,
    llamacppKvCache,
    llamacppFlashAttn,
    llamacppExe,
    llamacppModelPath: llamacppModelPath.trim() || null,
    llamacppPort: Math.round(llamacppPort),
    llamacppAutostart,
    llmThinkingEffort
  });

  const changeLlmProvider = (next: LlmProvider) => {
    setLlmProvider(next);
    setLlmModels([]);
    setLlmTest(null);
    setLlmModelsError(null);
    if (next === "ollama") setLlmBaseUrl("http://127.0.0.1:11434");
    else if (next === "llamacpp") setLlmBaseUrl("http://127.0.0.1:9931/v1");
    else if (next === "local" && (llmBaseUrl.includes(":11434") || llmBaseUrl.includes("api.deepseek.com"))) {
      setLlmBaseUrl("http://127.0.0.1:1234/v1");
    }
  };

  const checkLlmModels = async () => {
    setLlmModelsBusy(true);
    setLlmModelsError(null);
    setLlmTest(null);
    try {
      await props.onSaveSettings(llmPayload());
      const result = await api<{ models: LlmModelInfo[] }>("/api/llm/models");
      setLlmModels(result.models);
      if (!llmModel && result.models[0]) setLlmModel(result.models[0].id);
    } catch (error) {
      setLlmModelsError(error instanceof Error ? error.message : "The model list could not be loaded.");
    } finally {
      setLlmModelsBusy(false);
    }
  };

  const testLlmConnection = async () => {
    setLlmModelsBusy(true);
    setLlmModelsError(null);
    try {
      await props.onSaveSettings(llmPayload());
      const result = await post<LlmConnectionTest>("/api/llm/test");
      setLlmTest(result);
    } catch (error) {
      setLlmModelsError(error instanceof Error ? error.message : "The connection test failed.");
    } finally {
      setLlmModelsBusy(false);
    }
  };
  const llamaServerAction = async (action: "start" | "stop" | "restart") => {
    setLlamacppBusy(action);
    setLlmModelsError(null);
    try {
      await props.onSaveSettings(llmPayload());
      const status = await post<LlamaCppStatus>(`/api/llamacpp/${action}`);
      setLiveLlama(status);
      props.onRefresh();
    } catch (error) {
      setLlmModelsError(error instanceof Error ? error.message : "The llama-server action failed.");
    } finally {
      setLlamacppBusy(null);
    }
  };

  const browseLlamaFile = async (kind: "exe" | "model") => {
    setLlamacppBusy("browse");
    setLlmModelsError(null);
    try {
      const result = await post<{ path: string | null }>("/api/llamacpp/browse", { kind });
      if (result.path) {
        if (kind === "exe") setLlamacppExe(result.path);
        else setLlamacppModelPath(result.path);
      }
    } catch (error) {
      setLlmModelsError(error instanceof Error ? error.message : "The file picker could not be opened.");
    } finally {
      setLlamacppBusy(null);
    }
  };

  const applyDeepSummaryProfile = () => {
    setLlmProvider("llamacpp");
    setLlmBaseUrl("http://127.0.0.1:9931/v1");
    setLlmModel("qwen3.5-35b-a3b");
    setLlmContextTokens(65536);
    setLlmMaxInputChars(100000);
    setLlmGpuLayers(99);
    setLlamacppNcpuMoe(20);
    setLlamacppKvCache("q8_0");
    setLlamacppFlashAttn(true);
    setLlmThinkingEffort("off");
  };

  const changeLlamaPort = (nextPort: number) => {
    const previousPort = llamacppPort;
    setLlamacppPort(nextPort);
    setLlmBaseUrl((current) => {
      try {
        const url = new URL(current);
        const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname);
        if (loopback && Number(url.port || 80) === previousPort) {
          url.port = String(nextPort);
          return url.toString().replace(/\/$/, "");
        }
      } catch {
        // Keep the current address when it is not a valid URL.
      }
      return current;
    });
  };

  const steps = buildSetupSteps({
    settings: props.settings,
    status: props.status,
    guilds: props.guilds,
    worlds: props.worlds,
    captureTestPassed: props.captureTestPassed
  });
  const progress = setupProgress(steps);
  const inviteUrl = botInviteUrl(env.discordClientId);

  const copyBridgeToken = async () => {
    try {
      await navigator.clipboard.writeText(bridge.token);
      setTokenCopied(true);
      window.setTimeout(() => setTokenCopied(false), 2500);
    } catch {
      // The token is visible and selectable if clipboard access is blocked.
    }
  };

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2500);
    } catch {
      // The link is visible and selectable if clipboard access is blocked.
    }
  };

  const stepAction = (action: SetupStep["action"]) => {
    if (action === "portal") {
      return (
        <a className="btn small" href={DISCORD_DEVELOPER_PORTAL} target="_blank" rel="noreferrer">
          Open Discord apps
        </a>
      );
    }
    if (action === "invite") {
      return inviteUrl ? (
        <a className="btn small" href={inviteUrl} target="_blank" rel="noreferrer">Open invite</a>
      ) : (
        <Button variant="small" disabled>Needs a token</Button>
      );
    }
    if (action === "record") {
      return <Button variant="small" onClick={props.onGoRecord}>Open Record</Button>;
    }
    if (action === "audio") {
      return (
        <div className="button-row">
          <Button variant="small" onClick={props.onAudioTest}>Run audio test</Button>
          <label className="checkbox" title="Mark the audio test complete without running it again">
            <input
              type="checkbox"
              checked={props.captureTestPassed}
              onChange={(event) => props.onMarkAudioTest(event.target.checked)}
            />
            <span className="small">tested</span>
          </label>
        </div>
      );
    }
    if (action === "ai") {
      return <Button variant="small" onClick={() => document.getElementById("ai-summary-settings")?.scrollIntoView({ behavior: "smooth", block: "start" })}>Open AI settings</Button>;
    }
    if (action === "foundry") {
      return (
        <Button
          variant="small"
          onClick={() => {
            foundryInputRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
            foundryInputRef.current?.focus();
          }}
        >
          Set folder
        </Button>
      );
    }
    if (action === "module") {
      return (
        <Button variant="small" disabled={Boolean(props.busy) || !props.settings?.settings.foundryDataPath} onClick={props.onInstallModule}>
          Install module
        </Button>
      );
    }
    if (action === "recheck") {
      return <Button variant="small" onClick={props.onRefresh}>Check again</Button>;
    }
    return null;
  };

  const saveBotIdentity = () =>
    props.onSaveSettings({
      discordBotName: botName,
      discordActivityType: activityType,
      discordActivityText: activityText,
      discordActivityDynamic: activityDynamic
    });

  const saveTranscription = () =>
    props.onSaveSettings({
      sttEngine: engine,
      sttModel: model,
      sttDevice: device,
      sttComputeType: computeType,
      sttLanguage: language,
      sttBeamSize: beamSize,
      sttVadFilter: vadFilter,
      sttNoSpeechThreshold: noSpeechThreshold,
      sttLogProbThreshold: logProbThreshold,
      sttCompressionRatioThreshold: compressionRatioThreshold,
      sttPromptExtra: promptExtra,
      sttHotwordsExtra: hotwordsExtra,
      parakeetPath,
      parakeetModel,
      parakeetDevice,
      parakeetConcurrency
    });

  const saveNotes = () =>
    props.onSaveSettings({
      rollContextBeforeMs: Math.round(rollBeforeSeconds * 1000),
      rollContextAfterMs: Math.round(rollAfterSeconds * 1000),
      recentContextSeconds: Math.round(recentSeconds)
    });

  const checkRow = (check: HealthCheck) => (
    <div className="check" key={check.id}>
      <Pill tone={statusTone(check.status === "warning" ? "processing" : check.status === "error" ? "error" : check.status)}>
        {check.status === "ok" ? "ok" : check.status}
      </Pill>
      <div>
        <strong>{check.label}</strong>
        <div className="muted small">{check.detail}</div>
        {check.hint && <div className="hint small">{check.hint}</div>}
      </div>
    </div>
  );

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Setup</h1>
          <p className="muted">Checks and connections for this computer.</p>
        </div>
        <div className="button-row">
          <Button variant="ghost" onClick={props.onOpenWizard}>Setup wizard</Button>
          <Button variant="primary" disabled={Boolean(props.busy)} onClick={props.onDoctor}>
            {props.busy === "doctor" ? "Checking…" : "Run checks"}
          </Button>
          <Button variant="ghost" onClick={props.onRefresh}>Refresh</Button>
        </div>
      </div>

      <Card
        title="Status"
        subtitle={props.checksRanAtMs ? `Last checked ${formatRelative(props.checksRanAtMs)}` : "Loading checks"}
        actions={
          problems.length === 0 ? <Pill tone="ok">all good</Pill> : <Pill tone="warn">{problems.length} to look at</Pill>
        }
      >
        {props.status && (
          <div className="status-chips">
            <span>Disk {formatBytes(props.status.disk.freeBytes)} free</span>
            <span>
              {props.status.stt.engine === "parakeet" ? "Parrot" : "Whisper"}: {sttStateLabel(props.status.stt.state)}
            </span>
            <span>DAVE {props.status.voice.daveEnabled ? "on" : "off"}</span>
            <span>Version {env.version}</span>
          </div>
        )}
        {props.checks.length === 0 ? (
          <p className="muted">No checks yet. Run the checks above.</p>
        ) : (
          <>
            {problems.length === 0 ? (
              <p className="ok-text small">All checks passed.</p>
            ) : (
              <div className="check-list">{problems.map((check) => checkRow(check))}</div>
            )}
            {healthy.length > 0 && (
              <Disclosure summary={`The other ${healthy.length} checks passed`}>
                <div className="check-list">{healthy.map((check) => checkRow(check))}</div>
              </Disclosure>
            )}
          </>
        )}
      </Card>

      <Card
        title="Setup checklist"
        subtitle={`Step ${progress.done} of ${progress.total} · Foundry steps are optional`}
      >
        <ol className="checklist">
          {steps.map((step, index) => (
            <li key={step.id} className={step.done ? "done" : ""}>
              <span className={`check-index ${step.done ? "done" : ""}`}>{step.done ? "✓" : index + 1}</span>
              <div className="check-body">
                <div className="check-title">
                  <strong>{step.title}</strong>
                  {step.optional && <Pill tone="idle">optional</Pill>}
                  {step.done && <Pill tone="ok">done</Pill>}
                </div>
                <p className="muted small">{step.detail}</p>
              </div>
              <div className="check-action">{step.id === "module" && step.done ? null : stepAction(step.action)}</div>
            </li>
          ))}
        </ol>
      </Card>

      <Card
        title="Discord bot"
        subtitle="Invite the bot, then choose a server and channel on Record."
        actions={
          <Pill tone={props.status?.bot.state === "ready" ? "ok" : props.status?.bot.configured ? "warn" : "bad"}>
            {props.status?.bot.state === "ready" ? "connected" : props.status?.bot.configured ? "starting" : "no token"}
          </Pill>
        }
      >
        <div className="form-grid">
          <Field label="Application ID" hint="Read from the bot token. The token itself is never displayed.">
            <input readOnly value={env.discordClientId ?? "—"} />
          </Field>
          <Field label="Invite link" hint="View Channel, Connect, Speak. No message permissions are needed.">
            <div className="token-row">
              <input
                readOnly
                value={inviteUrl ?? "Add a valid DISCORD_TOKEN to .env to generate this link"}
                onFocus={(event) => event.target.select()}
                className="mono"
              />
              <Button variant="small" disabled={!inviteUrl} onClick={() => void copyInvite()}>
                {inviteCopied ? "Copied ✓" : "Copy"}
              </Button>
              {inviteUrl && (
                <a className="btn small" href={inviteUrl} target="_blank" rel="noreferrer">Open</a>
              )}
            </div>
          </Field>
        </div>
        <p className="muted small">
          {env.discordTokenConfigured
            ? "The bot token is configured. If the bot is not in your server yet, open the invite link."
            : "Create an application, copy its bot token into .env, restart the dashboard, then return for the invite link."}
        </p>
        <div className="button-row">
          <Button variant="small" onClick={props.onRefresh}>Check again</Button>
          <a className="btn small" href={DISCORD_DEVELOPER_PORTAL} target="_blank" rel="noreferrer">Discord apps</a>
        </div>
      </Card>

      <Card
        title="Bot personality"
        subtitle="Name and Discord activity for Scribblespark, the tiny overworked automaton."
        actions={<Pill tone={props.status?.bot.state === "ready" ? "ok" : "idle"}>{props.status?.bot.displayName ?? botName}</Pill>}
      >
        <div className="form-grid">
          <Field label="Bot display name" hint="Applied as the bot nickname in each server. Discord's account name is unchanged.">
            <input value={botName} maxLength={32} onChange={(event) => setBotName(event.target.value)} placeholder="Scribblespark" />
          </Field>
          <Field label="Activity type">
            <select value={activityType} onChange={(event) => setActivityType(event.target.value as typeof activityType)}>
              <option value="playing">Playing</option>
              <option value="listening">Listening to</option>
              <option value="watching">Watching</option>
              <option value="competing">Competing in</option>
            </select>
          </Field>
          <Field label="Activity text" hint="128 characters. Leave blank to hide the activity.">
            <input
              value={activityText}
              maxLength={128}
              onChange={(event) => setActivityText(event.target.value)}
              placeholder="every adventure (and slowly destroying this computer)"
            />
          </Field>
          <div className="field">
            <span>Live activity</span>
            <label className="checkbox">
              <input type="checkbox" checked={activityDynamic} onChange={(event) => setActivityDynamic(event.target.checked)} />
              <span className="small">Update while recording, testing, processing, or listening</span>
            </label>
            <small>Off keeps the base text all the time.</small>
          </div>
        </div>
        <p className="muted small">
          Preview: <strong>{activityType === "listening" ? "Listening to" : activityType === "watching" ? "Watching" : activityType === "competing" ? "Competing in" : "Playing"} {activityText || "…"}</strong>
          {activityDynamic ? " · changes while the bot is busy." : " · stays constant."}
        </p>
        <div className="button-row">
          <Button variant="small" disabled={Boolean(props.busy)} onClick={saveBotIdentity}>Save personality</Button>
          <span className="muted tiny">Nickname changes may take a moment in Discord.</span>
        </div>
      </Card>

      <div className="grid two">
        <Card
          title="Transcription"
          subtitle={`Engine: ${engineLabel}`}
          actions={
            <Pill tone={props.status?.stt.state === "ready" ? "ok" : props.status?.stt.state ? "warn" : "idle"}>
              {sttStateLabel(props.status?.stt.state)}
            </Pill>
          }
        >
          <div className="form-grid">
            <Field label="Engine" hint="Both run on this computer. Parrot is the default.">
              <select value={engine} onChange={(event) => setEngine(event.target.value as typeof engine)}>
                <option value="parakeet">Parrot (Parakeet, built in)</option>
                <option value="faster-whisper">Whisper (faster-whisper)</option>
              </select>
            </Field>
            <Field label="Spoken language" hint="The language at your table, usually English.">
              <input value={language} onChange={(event) => setLanguage(event.target.value)} placeholder="en" />
            </Field>
          </div>
          <p className="muted small">
            {props.status?.stt.engine === engine ? (
              props.status.stt.state === "ready" ? (
                <>Ready: {props.status.stt.model} on {props.status.stt.device}.</>
              ) : (
                <>Not ready: {sttStateLabel(props.status.stt.state)}.{props.status.stt.error ? ` ${props.status.stt.error}` : ""}</>
              )
            ) : (
              <>Save to switch the active engine. The status above still describes {props.status?.stt.engine === "parakeet" ? "Parrot" : "Whisper"}.</>
            )}
          </p>

          {engine === "parakeet" ? (
            <>
              <div className="form-grid">
                <Field label="Parrot model" hint="Path to the .gguf model used by nemo-speech.">
                  <input value={parakeetModel} onChange={(event) => setParakeetModel(event.target.value)} className="mono" />
                </Field>
                <Field label="nemo-speech runtime" hint="Executable name on PATH, or a full path.">
                  <input value={parakeetPath} onChange={(event) => setParakeetPath(event.target.value)} className="mono" />
                </Field>
                <Field label="Device" hint="CUDA is much faster; CPU is a fallback.">
                  <select value={parakeetDevice} onChange={(event) => setParakeetDevice(event.target.value)}>
                    <option value="cuda">Graphics card</option>
                    <option value="cpu">Processor</option>
                  </select>
                </Field>
                <Field label="Concurrency" hint="Clips decoded in parallel. Lower this if the GPU runs out of memory.">
                  <input
                    type="number"
                    min={1}
                    max={16}
                    value={parakeetConcurrency}
                    onChange={(event) => setParakeetConcurrency(Number(event.target.value))}
                  />
                </Field>
              </div>
              <p className="muted small">
                Parrot uses the hotwords and prompt hints below to spell character and place names. Its per-clip timestamps come from nemo-speech.
              </p>
            </>
          ) : (
            <>
              <div className="form-grid">
                <Field label="Whisper model">
                  <select value={model} onChange={(event) => setModel(event.target.value)}>
                    <option value="large-v3-turbo">Large v3 turbo (default)</option>
                    <option value="large-v3">Large v3</option>
                    <option value="medium.en">Medium (English)</option>
                    <option value="small.en">Small (English)</option>
                    <option value="tiny.en">Tiny (test only)</option>
                  </select>
                </Field>
                <Field label="Device" hint="The graphics card is much faster.">
                  <select value={device} onChange={(event) => setDevice(event.target.value)}>
                    <option value="cuda">Graphics card</option>
                    <option value="cpu">Processor</option>
                  </select>
                </Field>
                <Field label="Precision" hint="Lower precision uses less memory and is slightly less accurate.">
                  <select value={computeType} onChange={(event) => setComputeType(event.target.value)}>
                    <option value="float16">float16</option>
                    <option value="int8_float16">int8_float16</option>
                    <option value="int8">int8</option>
                    <option value="float32">float32</option>
                  </select>
                </Field>
                <Field label="Beam size" hint="Higher can improve accuracy at the cost of speed. 1–10.">
                  <input
                    type="number"
                    min={1}
                    max={10}
                    value={beamSize}
                    onChange={(event) => setBeamSize(Number(event.target.value))}
                  />
                </Field>
              </div>
              <Disclosure summary="Whisper fine tuning">
                <div className="form-grid">
                  <Field label="No-speech threshold" hint="0–1. Higher keeps more quiet clips.">
                    <input
                      type="number"
                      min={0}
                      max={1}
                      step={0.05}
                      value={noSpeechThreshold}
                      onChange={(event) => setNoSpeechThreshold(Number(event.target.value))}
                    />
                  </Field>
                  <Field label="Log-probability threshold" hint="-5–0. Lower accepts more low-confidence speech.">
                    <input
                      type="number"
                      min={-5}
                      max={0}
                      step={0.1}
                      value={logProbThreshold}
                      onChange={(event) => setLogProbThreshold(Number(event.target.value))}
                    />
                  </Field>
                  <Field label="Compression-ratio threshold" hint="1–10. Lower flags repetitive output sooner.">
                    <input
                      type="number"
                      min={1}
                      max={10}
                      step={0.1}
                      value={compressionRatioThreshold}
                      onChange={(event) => setCompressionRatioThreshold(Number(event.target.value))}
                    />
                  </Field>
                  <div className="field">
                    <span>Silero VAD</span>
                    <label className="checkbox">
                      <input type="checkbox" checked={vadFilter} onChange={(event) => setVadFilter(event.target.checked)} />
                      <span className="small">Filter silence inside each clip</span>
                    </label>
                    <small>Off by default. Turn on if clips contain long pauses.</small>
                  </div>
                </div>
              </Disclosure>
            </>
          )}

          <Disclosure summary="Vocabulary hints">
            <Field label="Extra prompt" hint="Whisper only. Appended to the automatic system/character prompt.">
              <input value={promptExtra} onChange={(event) => setPromptExtra(event.target.value)} placeholder="Optional context for the model" />
            </Field>
            <Field label="Extra hotwords" hint="Both engines. Comma-separated names appended to automatic hotwords.">
              <input value={hotwordsExtra} onChange={(event) => setHotwordsExtra(event.target.value)} placeholder="Harbor, Old Town, Veyra" />
            </Field>
          </Disclosure>

          <div className="button-row">
            <Button variant="small" disabled={Boolean(props.busy)} onClick={saveTranscription}>
              Save transcription settings
            </Button>
            <Button variant="ghost small" onClick={props.onDoctor}>
              Run checks
            </Button>
          </div>
          <p className="muted small">Changes apply to the next transcription. Existing transcripts keep their engine metadata.</p>
        </Card>

        <Card title="Notes" subtitle="How speech is combined with rolls.">
          <div className="form-grid">
            <Field label="Speech before a roll (seconds)" hint="Speech leading up to a roll is attached to it.">
              <input type="number" min={0} max={300} value={rollBeforeSeconds} onChange={(event) => setRollBeforeSeconds(Number(event.target.value))} />
            </Field>
            <Field label="Speech after a roll (seconds)" hint="Reactions after a roll are attached to it.">
              <input type="number" min={0} max={300} value={rollAfterSeconds} onChange={(event) => setRollAfterSeconds(Number(event.target.value))} />
            </Field>
            <Field label="Brief length" hint="The default window for the session brief.">
              <select value={recentSeconds} onChange={(event) => setRecentSeconds(Number(event.target.value))}>
                <option value={60}>1 minute</option>
                <option value={180}>3 minutes</option>
                <option value={300}>5 minutes</option>
                <option value={600}>10 minutes</option>
                <option value={900}>15 minutes</option>
              </select>
            </Field>
          </div>
          <div className="button-row">
            <Button variant="small" disabled={Boolean(props.busy)} onClick={saveNotes}>Save</Button>
          </div>
          <p className="muted small">Changes apply to the next build, not to notes that already exist.</p>
        </Card>
      </div>

      <Card
        title="Foundry"
        subtitle="We recommend the bridge. The macro is a lighter option."
        actions={
          <div className="button-row">
            <Pill tone={bridgeStatus.connected ? "ok" : bridgeStatus.enabled ? "warn" : "idle"}>
              {bridgeStatus.connected ? "connected" : bridgeStatus.enabled ? "waiting for Foundry" : "off"}
            </Pill>
            {bridgeStatus.connected && (
              <span className="muted tiny" title="Version reported by the running Foundry client">
                module {bridgeStatus.moduleVersion ?? "?"}
              </span>
            )}
          </div>
        }
      >
        <div className="form-grid">
          <Field label="Foundry folder" hint="Where Foundry keeps its worlds: usually the FoundryVTT data folder.">
            <input
              ref={foundryInputRef}
              value={foundryPath}
              onChange={(event) => setFoundryPath(event.target.value)}
              placeholder="C:\Users\you\AppData\Local\FoundryVTT"
            />
          </Field>
        </div>
        <div className="button-row">
          <Button variant="small" disabled={Boolean(props.busy)} onClick={() => props.onSaveSettings({ foundryDataPath: foundryPath || null })}>
            Save folder
          </Button>
          <Button variant="small" disabled={Boolean(props.busy) || !props.settings?.settings.foundryDataPath} onClick={props.onInstallModule}>
            {props.busy === "module-install" ? "Installing…" : "Install module into Foundry"}
          </Button>
          {!bridgeStatus.connected && bridgeStatus.lastSeenAtMs && (
            <span className="muted tiny">last seen {formatRelative(bridgeStatus.lastSeenAtMs)}</span>
          )}
        </div>

        <div className="bridge-status">
          <span className="muted small">
            {bridgeStatus.connected
              ? "Foundry is sending rolls, scene changes, and the player list."
              : "Foundry is not connected. If you want a lighter setup, use the macro below."}
          </span>
          {bridgeStatus.lastError && <span className="bad-text small">{bridgeStatus.lastError}</span>}
        </div>
        {bridgeStatus.connected && !versionAtLeast(bridgeStatus.moduleVersion, FOUNDRY_CONSENT_COMMAND_VERSION) && (
          <p className="warn-text small">
            Foundry is running module {bridgeStatus.moduleVersion ?? "unknown"}. Install{" "}
            {FOUNDRY_CONSENT_COMMAND_VERSION} and refresh Foundry. Until you do, the consent prompt has to be
            confirmed by hand.
          </p>
        )}

        <div className="form-grid">
          <Field label="Bridge token" hint={bridge.tokenManagedByEnv ? "Set by FOUNDRY_BRIDGE_TOKEN in .env" : "Paste this into Foundry → Configure Settings → TableRecords Bridge"}>
            <div className="token-row">
              <input className="mono" readOnly value={bridge.token} onFocus={(event) => event.target.select()} />
              <Button variant="small" onClick={() => void copyBridgeToken()}>{tokenCopied ? "Copied ✓" : "Copy"}</Button>
              <Button
                variant="small"
                disabled={Boolean(props.busy) || bridge.tokenManagedByEnv}
                onClick={() => void props.onRotateBridgeToken()}
              >
                Rotate
              </Button>
            </div>
          </Field>
        </div>
        <div className="bridge-options">
          <label className="checkbox">
            <input type="checkbox" checked={liveEnabled} onChange={(event) => setLiveEnabled(event.target.checked)} />
            <span>Accept rolls from Foundry while you play</span>
          </label>
          <label className="checkbox">
            <input type="checkbox" checked={liveMarkers} onChange={(event) => setLiveMarkers(event.target.checked)} />
            <span>Mark scene changes and combat automatically</span>
          </label>
        </div>
        <div className="button-row">
          <Button variant="small" disabled={Boolean(props.busy)} onClick={() => props.onSaveSettings({ foundryLiveEnabled: liveEnabled, foundryLiveMarkers: liveMarkers })}>
            Save Foundry settings
          </Button>
        </div>

        <Disclosure summary="How to set up the Foundry bridge">
          <ol className="steps">
            <li>Click <strong>Install module into Foundry</strong>, then restart Foundry.</li>
            <li>Enable <strong>TableRecords Bridge</strong> in Foundry&apos;s module settings and paste the token above.</li>
            <li>On Record, tick <strong>Prompt players in Foundry when recording starts</strong>. The dashboard sends the notice through the bridge, so no console command is needed.</li>
          </ol>
          <p className="muted small">
            The bridge also adds <strong>Alt+M</strong> for a note to self, and can show scene and combat markers. It never
            sends audio. Leave the module&apos;s Session ID blank to follow the active recording.
          </p>
          {props.worlds.length > 0 && (
            <Disclosure summary={`Detected worlds (${props.worlds.length})`}>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>World</th>
                      <th>System</th>
                      <th>Version</th>
                    </tr>
                  </thead>
                  <tbody>
                    {props.worlds.map((world) => (
                      <tr key={world.id}>
                        <td>
                          <strong>{world.title}</strong>
                          <div className="muted tiny mono">{world.id}</div>
                        </td>
                        <td>{world.system}</td>
                        <td>{world.systemVersion ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Disclosure>
          )}
        </Disclosure>

        <Disclosure summary="Macro fallback">
          <p className="muted small">
            Use this if you want a lighter setup, or if Foundry cannot reach the dashboard.
          </p>
          <ol className="steps">
            <li>
              <a
                href="https://github.com/DukeVenator/TableRecords/blob/main/foundry-macros/table-records-export.js"
                target="_blank"
                rel="noreferrer"
              >
                Open the macro
              </a>{" "}
              and paste it into a Foundry script macro.
            </li>
            <li>Run it as GM after the last roll.</li>
            <li>Open the session, choose the Rolls tab in Sessions, and upload the JSON.</li>
          </ol>
        </Disclosure>
      </Card>

      <span id="ai-summary-settings" />
      <Card title="AI summary (optional)" subtitle="Ollama on this computer, DeepSeek cloud, or another local OpenAI-compatible server.">
        <div className="bridge-status">
          <Pill tone={!props.settings.llm.enabled ? "idle" : props.settings.llm.configured ? "ok" : "warn"}>
            {!props.settings.llm.enabled ? "off" : props.settings.llm.configured ? "ready" : "needs setup"}
          </Pill>
          <span className="muted small">
            {props.settings.llm.enabled
              ? "Summaries are sent only when you press Summarize."
              : "No AI calls are made while this is off."}
          </span>
        </div>
        <div className="button-row">
          <Button variant="small" type="button" onClick={applyDeepSummaryProfile}>
            Use deep summary settings
          </Button>
          <span className="muted small">35B on llama.cpp, 64k context, 100k input, thinking off for reliable extraction.</span>
        </div>
        <div className="form-grid">
          <Field label="Allow AI summaries">
            <span className="checkbox">
              <input type="checkbox" checked={llmEnabled} onChange={(event) => setLlmEnabled(event.target.checked)} />
              <span>Enabled</span>
            </span>
          </Field>
          <Field label="Provider">
            <select value={llmProvider} onChange={(event) => changeLlmProvider(event.target.value as LlmProvider)}>
              <option value="llamacpp">llama.cpp on this computer</option>
              <option value="ollama">Ollama on this computer</option>
              <option value="local">Other local OpenAI-compatible</option>
              <option value="deepseek">DeepSeek cloud</option>
            </select>
          </Field>
          {llmProvider !== "deepseek" ? (
            <Field
              label="Address"
              hint={
                llmProvider === "ollama"
                  ? "Usually http://127.0.0.1:11434."
                  : llmProvider === "llamacpp"
                    ? "Usually http://127.0.0.1:9931/v1 for llama-server."
                    : "Usually http://127.0.0.1:1234/v1 for LM Studio."
              }
            >
              <input value={llmBaseUrl} onChange={(event) => setLlmBaseUrl(event.target.value)} placeholder="http://127.0.0.1:11434" />
            </Field>
          ) : (
            <Field label="Endpoint" hint="DeepSeek's hosted API. The session brief leaves this computer.">
              <input value="https://api.deepseek.com" readOnly />
            </Field>
          )}
          <Field
            label="Model"
            hint={
              llmProvider === "deepseek"
                ? "deepseek-flash is the current default."
                : llmProvider === "llamacpp"
                  ? "Use the alias passed to llama-server, for example qwen3.5-35b-a3b."
                  : "For example qwen3.5:27b-q4_K_M or qwen3.5:9b-q8_0."
            }
          >
            <input
              value={llmModel}
              list="llm-model-options"
              onChange={(event) => setLlmModel(event.target.value)}
              placeholder={
                llmProvider === "deepseek"
                  ? "deepseek-flash"
                  : llmProvider === "llamacpp"
                    ? "qwen3.5-35b-a3b"
                    : "qwen3.5:27b-q4_K_M"
              }
            />
            <datalist id="llm-model-options">
              {llmModels.map((item) => (
                <option key={item.id} value={item.id} />
              ))}
            </datalist>
          </Field>
          <Field label="Timeout (seconds)">
            <input type="number" min={5} max={300} value={llmTimeoutSeconds} onChange={(event) => setLlmTimeoutSeconds(Number(event.target.value))} />
          </Field>
          <Field
            label="Input limit (characters)"
            hint={`Long briefs are split into portions. At this context and reasoning effort, each prompt can use about ${effectiveInputBudget.toLocaleString()} characters.`}
          >
            <input type="number" min={4000} max={200000} step={1000} value={llmMaxInputChars} onChange={(event) => setLlmMaxInputChars(Number(event.target.value))} />
          </Field>
          <Field
            label="Context window (tokens)"
            hint="Runs from 4,096 to 131,072. A larger window uses more video memory. Reasoning tokens share this window."
          >
            <input
              type="number"
              min={4096}
              max={131072}
              step={1024}
              value={llmContextTokens}
              onChange={(event) => setLlmContextTokens(Number(event.target.value))}
            />
          </Field>
          <Field
            label="Layers on the video card"
            hint={
              llmProvider === "llamacpp"
                ? "Use this value for -ngl when starting llama-server. Leave blank for automatic."
                : "Leave blank to let Ollama decide; 0 runs on the processor only."
            }
          >
            <input
              type="number"
              min={0}
              max={999}
              step={1}
              value={llmGpuLayers ?? ""}
              placeholder="Automatic"
              onChange={(event) => setLlmGpuLayers(event.target.value === "" ? null : Number(event.target.value))}
            />
          </Field>
          {llmProvider === "llamacpp" && (
            <>
              <Field
                label="MoE layers on the processor"
                hint="Use this value for --n-cpu-moe. It moves the first layers' expert weights to system memory."
              >
                <input
                  type="number"
                  min={0}
                  max={999}
                  step={1}
                  value={llamacppNcpuMoe}
                  onChange={(event) => setLlamacppNcpuMoe(Number(event.target.value))}
                />
              </Field>
              <Field label="KV cache type" hint="Use this value for -ctk and -ctv. q8_0 saves memory with little quality loss.">
                <select
                  value={llamacppKvCache}
                  onChange={(event) => setLlamacppKvCache(event.target.value as "f16" | "q8_0" | "q4_0")}
                >
                  <option value="f16">f16</option>
                  <option value="q8_0">q8_0</option>
                  <option value="q4_0">q4_0</option>
                </select>
              </Field>
              <Field label="Flash attention" hint="Use this value for -fa when starting llama-server.">
                <span className="checkbox">
                  <input
                    type="checkbox"
                    checked={llamacppFlashAttn}
                    onChange={(event) => setLlamacppFlashAttn(event.target.checked)}
                  />
                  <span>On</span>
                </span>
              </Field>
              <Field label="Server executable" hint="Full path to llama-server.exe, or a name on PATH.">
                <input value={llamacppExe} onChange={(event) => setLlamacppExe(event.target.value)} placeholder="llama-server.exe" />
                <Button variant="small" type="button" disabled={Boolean(props.busy) || Boolean(llamacppBusy)} onClick={() => void browseLlamaFile("exe")}>
                  {llamacppBusy === "browse" ? "Opening…" : "Browse"}
                </Button>
              </Field>
              <Field label="Model file" hint="Full path to the .gguf file. It is never uploaded.">
                <input value={llamacppModelPath} onChange={(event) => setLlamacppModelPath(event.target.value)} placeholder="C:\Models\Qwen3.5-35B-A3B-Q4_K_M.gguf" />
                <Button variant="small" type="button" disabled={Boolean(props.busy) || Boolean(llamacppBusy)} onClick={() => void browseLlamaFile("model")}>
                  {llamacppBusy === "browse" ? "Opening…" : "Browse"}
                </Button>
              </Field>
              <Field label="Server port" hint="The address above must use the same port.">
                <input type="number" min={1} max={65535} value={llamacppPort} onChange={(event) => changeLlamaPort(Number(event.target.value))} />
              </Field>
              <Field label="Start with the dashboard" hint="Only when llama.cpp is the selected provider.">
                <span className="checkbox">
                  <input
                    type="checkbox"
                    checked={llamacppAutostart}
                    onChange={(event) => setLlamacppAutostart(event.target.checked)}
                  />
                  <span>Automatic</span>
                </span>
              </Field>
            </>
          )}
          <Field label="Reasoning effort" hint="Thinking models spend extra tokens on reasoning. High needs more context and time.">
            <select
              value={llmThinkingEffort}
              onChange={(event) => setLlmThinkingEffort(event.target.value as LlmThinkingEffort)}
            >
              <option value="off">Off</option>
              <option value="low">Low</option>
              <option value="medium">Medium</option>
              <option value="high">High</option>
            </select>
          </Field>
        </div>
        {llmProvider === "llamacpp" && (
          <>
            <p className="muted small">
              llama.cpp sets context and placement when <code>llama-server</code> starts. The values above map to
              <code>-c</code>, <code>-ngl</code>, <code>--n-cpu-moe</code>, <code>-ctk/-ctv</code>, and <code>-fa</code>.
              Thinking effort is sent with each request.
            </p>
            <div className="bridge-status">
              <Pill
                tone={
                  llamaStatus?.state === "running" || llamaStatus?.state === "external"
                    ? "ok"
                    : llamaStatus?.state === "error"
                      ? "bad"
                      : llamaStatus?.state === "starting"
                        ? "warn"
                        : "idle"
                }
              >
                {llamaStatus?.state ?? "unknown"}
              </Pill>
              <span className="muted small">
                {llamaStatus?.pid
                  ? `Managed process ${llamaStatus.pid} on port ${llamaStatus.port}.`
                  : llamaStatus?.state === "external"
                    ? `Using the server already running on port ${llamaStatus.port}.`
                    : "No managed server is running."}
              </span>
            </div>
            {llamaStatus?.restartRequired && (
              <p className="warn-text small">
                The saved launch settings differ from the running server. Restart it to apply them.
              </p>
            )}
            {llamaStatus?.lastError && <p className="bad-text small">{llamaStatus.lastError}</p>}
            <div className="button-row">
              <Button
                variant="small"
                disabled={Boolean(props.busy) || Boolean(llamacppBusy)}
                onClick={() => void llamaServerAction("start")}
              >
                {llamacppBusy === "start" ? "Starting…" : "Start server"}
              </Button>
              <Button
                variant="small"
                disabled={Boolean(props.busy) || Boolean(llamacppBusy) || !llamaStatus?.managed}
                onClick={() => void llamaServerAction("stop")}
              >
                {llamacppBusy === "stop" ? "Stopping…" : "Stop server"}
              </Button>
              {llamaStatus?.restartRequired && (
                <Button
                  variant="small"
                  disabled={Boolean(props.busy) || Boolean(llamacppBusy)}
                  onClick={() => void llamaServerAction("restart")}
                >
                  {llamacppBusy === "restart" ? "Restarting…" : "Restart server"}
                </Button>
              )}
            </div>
          </>
        )}
        {llmProvider === "deepseek" && (
          <div className="tr-cloud-settings">
            <span className="checkbox">
              <input type="checkbox" checked={llmCloudEnabled} onChange={(event) => setLlmCloudEnabled(event.target.checked)} />
              <span>Allow cloud summaries</span>
            </span>
            <p className="warn-text small">
              The session brief is sent to DeepSeek. Audio is never sent, and this only happens when you press Summarize.
            </p>
            {!props.settings.llm.apiKeyConfigured && (
              <p className="bad-text small">
                The DeepSeek key is not configured. Add it to the dashboard environment file and restart the dashboard.
              </p>
            )}
          </div>
        )}
        <div className="button-row">
          <Button variant="small" disabled={Boolean(props.busy) || llmModelsBusy} onClick={() => void props.onSaveSettings(llmPayload())}>
            Save
          </Button>
          <Button variant="small" disabled={Boolean(props.busy) || llmModelsBusy} onClick={() => void checkLlmModels()}>
            {llmModelsBusy ? "Checking…" : "Check models"}
          </Button>
          <Button variant="small" disabled={Boolean(props.busy) || llmModelsBusy} onClick={() => void testLlmConnection()}>
            Test connection
          </Button>
          <span className="muted small">{llmProvider === "deepseek" ? "Cloud only when both switches are on." : "The address must be on this computer."}</span>
        </div>
        {llmModels.length > 0 && (
          <p className="muted small">
            {llmModels.length} model{llmModels.length === 1 ? "" : "s"} found. Pick one above or type a name.
          </p>
        )}
        {llmModelsError && <p className="warn-text small">{llmModelsError}</p>}
        {llmTest && (
          <p className="ok-text small">
            Connected to {llmTest.provider === "deepseek" ? "DeepSeek" : "the local model server"} in {(llmTest.latencyMs / 1000).toFixed(1)}s.
            {llmTest.models > 0 ? ` ${llmTest.models} model${llmTest.models === 1 ? "" : "s"} available.` : ""}
          </p>
        )}
      </Card>

      <Disclosure summary="Advanced: files and versions" className="advanced-page">
        <div className="grid two">
          <div>
            <h3>This computer</h3>
            <div className="session-facts">
              <Stat label="Version" value={env.version} />
              <Stat label="Dashboard" value={`${env.host}:${env.port}`} />
              <Stat label="Time zone" value={env.timeZone} />
              <Stat label="Web build" value={env.webBuildPresent ? "present" : "missing"} />
              <Stat label="Python" value={<span className="mono tiny">{env.pythonPath}</span>} />
              <Stat label="Sessions" value={<span className="mono tiny">{env.sessionsDir}</span>} />
              <Stat label="Whisper models" value={<span className="mono tiny">{props.settings.settings.sttModelDir}</span>} />
              <Stat label="Discord token" value={env.discordTokenConfigured ? "configured" : "missing"} />
              <Stat label="Dashboard token" value={env.dashboardTokenConfigured ? "enabled" : "disabled"} />
            </div>
            {env.dashboardTokenConfigured && (
              <div className="button-row">
                <Button variant="ghost" onClick={props.onLogout}>Lock dashboard</Button>
              </div>
            )}
            <p className="muted small">
              <code>DISCORD_TOKEN</code> and <code>DASHBOARD_TOKEN</code> are read from <code>.env</code> only. They are never
              written to the database, session files, or browser storage.
            </p>
          </div>
          <div>
            <h3>Setup checklist</h3>
            <p className="muted small">
              The checklist above tracks the bot token, the invite, the audio test, Foundry, and speech-to-text.
              These raw values stay here for troubleshooting.
            </p>
            <h3>Discord servers</h3>
            {props.guilds.length === 0 ? (
              <p className="muted small">No servers visible to the bot. Check that the bot was invited with View Channel, Connect, and Speak.</p>
            ) : (
              <div className="guild-list">
                {props.guilds.map((guild) => (
                  <div className="guild" key={guild.id}>
                    <strong>{guild.name}</strong>
                    <span className="mono tiny">{guild.id}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </Disclosure>

      <Disclosure summary="How recording works" className="advanced-page">
        <div className="settings-guide">
          <div>
            <strong>Capture</strong>
            <p className="muted small">
              Discord voice is recorded per speaker, so each person keeps their own track. Short pauses stay in the same
              turn; trailing silence is trimmed. Someone who opts out is never recorded.
            </p>
          </div>
          <div>
            <strong>Transcription</strong>
            <p className="muted small">
              Speech is transcribed on this computer with Parakeet or Whisper. No audio leaves the machine.
            </p>
          </div>
          <div>
            <strong>Notes and privacy</strong>
            <p className="muted small">
              Notes, transcripts, and audio stay in the session folder. Local AI summaries stay on this machine;
              DeepSeek cloud is off unless both switches are on, and only when you press Summarize. Nothing is used for training.
            </p>
          </div>
        </div>
      </Disclosure>

      <p className="muted tiny page-foot">Checks last ran {props.checksRanAtMs ? formatDateTime(props.checksRanAtMs) : "never"}.</p>
    </div>
  );
}
