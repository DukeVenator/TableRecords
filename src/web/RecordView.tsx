import { useEffect, useState } from "react";
import type {
  Job,
  LlmSummaryPreset,
  LlmSummaryResult,
  LlmSummaryScope,
  OutputFile,
  Status,
  VoiceChannel,
  Guild,
  SessionDetail
} from "./types";
import {
  Button,
  Card,
  Disclosure,
  Empty,
  MarkerBar,
  MomentList,
  Pill,
  SpeakerTable,
  Stat,
  Warnings,
  markersToMoments,
  type Moment
} from "./components";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatDuration,
  formatEta,
  formatLength,
  formatRelative,
  formatTime,
  jobLabel,
  sessionStatusLabel,
  statusTone,
  summaryPresetLabel,
  summaryScopeLabel,
  systemName
} from "./format";
import { FOUNDRY_CONSENT_COMMAND_VERSION, versionAtLeast } from "../core/version.js";

export interface RecordProps {
  status: Status | null;
  detail: SessionDetail | null;
  jobs: Job[];
  outputs: OutputFile[];
  guilds: Guild[];
  channels: VoiceChannel[];
  guildId: string;
  channelId: string;
  busy: string | null;
  markerLabel: string;
  captureTest: {
    testId: string;
    utteranceCount: number;
    totalBytes: number;
    decryptionFailures: number;
    speakers: Array<{ displayName: string; utteranceCount: number; bytes: number }>;
    warnings: string[];
    health: string;
  } | null;
  onGuild: (value: string) => void;
  onChannel: (value: string) => void;
  onJoin: () => void;
  onLeave: () => void;
  onStart: (sessionId: string, promptPlayers?: boolean) => void;
  onStop: (sessionId: string) => void;
  onMarker: (sessionId: string, kind: string, mentalNote?: boolean) => void;
  onDeleteMarker: (sessionId: string, markerId: string) => void;
  onMarkerLabel: (value: string) => void;
  onEnqueue: (sessionId: string, type: string) => void;
  onSessions: () => void;
  onSetup: () => void;
  onConfirmConsent: (sessionId: string) => void;
  onCaptureTestStart: () => void;
  onCaptureTestStop: () => void;
  recentSeconds: number;
  onRecentSeconds: (value: number) => void;
  onRecentContext: (sessionId: string, windowSeconds: number) => void;
  onOpenContext: (jobId: string) => void;
  llmEnabled: boolean;
  llmConfigured: boolean;
  llmPreset: LlmSummaryPreset;
  llmScope: LlmSummaryScope;
  llmSummaries: LlmSummaryResult[];
  onLlmPreset: (value: LlmSummaryPreset) => void;
  onLlmScope: (value: LlmSummaryScope) => void;
  onLlmSummary: (sessionId: string, windowSeconds: number) => void;
  onOpenLlmSummary: (summary: LlmSummaryResult) => void;
}

export function RecordView(props: RecordProps) {
  const { status, detail, jobs, outputs, busy } = props;
  const [promptChoice, setPromptChoice] = useState<boolean | null>(null);
  const activeSessionId = detail?.session.sessionId ?? null;
  useEffect(() => {
    setPromptChoice(null);
  }, [activeSessionId]);
  if (!status) {
    return <div className="loading">Connecting to TableRecords…</div>;
  }
  const session = detail?.session ?? null;
  const capture = status.capture;
  const sessionId = session?.sessionId ?? null;
  const isThisRecording = Boolean(sessionId && capture.sessionId === sessionId && capture.state === "recording");
  const isTestActive = Boolean(capture.testId && capture.state === "recording");
  const voiceReady = status.voice.state === "ready";
  const botReady = status.bot.state === "ready";
  const foundryPromptFresh =
    detail?.consentPrompt != null && Date.now() - detail.consentPrompt.promptedAtMs < 24 * 60 * 60_000;
  const consentSatisfied = Boolean(session && (session.consent.confirmed || foundryPromptFresh));
  const bridgeConnected = Boolean(status.foundry.live.enabled && status.foundry.live.connected);
  const promptSupported =
    bridgeConnected && versionAtLeast(status.foundry.live.moduleVersion, FOUNDRY_CONSENT_COMMAND_VERSION);
  const promptPlayers = promptChoice ?? promptSupported;
  const canStart =
    Boolean(session) &&
    botReady &&
    ["draft", "error"].includes(session!.status) &&
    (consentSatisfied || (promptSupported && promptPlayers)) &&
    Boolean(session!.voiceChannel) &&
    !capture.state.includes("recording");
  const canProcess = Boolean(session) && !["draft", "joining", "recording", "stopping"].includes(session!.status);

  const connectedChannel = props.channels.find((channel) => channel.id === status.voice.channelId) ?? null;
  const peopleInVoice = connectedChannel?.memberCount ?? capture.speakers.length;
  const lastHeardMs = capture.lastPacketAtMs
    ?? capture.speakers.reduce<number | null>((latest, speaker) => {
      if (!speaker.lastUtteranceAtMs) return latest;
      return latest == null ? speaker.lastUtteranceAtMs : Math.max(latest, speaker.lastUtteranceAtMs);
    }, null);
  const rollsCaptured = detail?.foundryLive?.messageCount ?? detail?.foundrySummary?.rollCount ?? 0;
  const rollsSource = detail?.foundryLive
    ? "captured live"
    : detail?.foundrySummary
      ? "from the Foundry export"
      : "none yet";

  const startedMs = session?.startedAtMs ?? null;
  const stoppedMs = session?.stoppedAtMs ?? null;
  const sessionLengthMs = startedMs ? (stoppedMs ?? (isThisRecording ? Date.now() : startedMs)) - startedMs : 0;
  const builtAtMs = outputs.length > 0 ? Math.max(...outputs.map((file) => file.modifiedAtMs)) : null;
  const notesBytes = outputs.reduce((sum, file) => sum + file.sizeBytes, 0);

  const healthTone = capture.health === "error" ? "bad" : capture.health === "warning" ? "warn" : "ok";
  const healthLabel = capture.health === "error" ? "Problem" : capture.health === "warning" ? "Check" : "Good";
  const healthDetail =
    capture.decryptionFailures > 0
      ? `${capture.decryptionFailures} decrypt ${capture.decryptionFailures === 1 ? "error" : "errors"}`
      : (capture.silentUtteranceCount ?? 0) > 0
        ? `${capture.silentUtteranceCount} silent clips skipped`
        : "No decrypt errors";

  const recentOptions = [...new Set([60, 180, 300, 600, 900, props.recentSeconds])].sort((a, b) => a - b);
  const recentLabel = (seconds: number) =>
    seconds % 60 === 0 ? `Last ${seconds / 60} minute${seconds === 60 ? "" : "s"}` : `Last ${seconds} seconds`;
  const contextJob = jobs.find((job) => job.type === "context" && job.sessionId === sessionId) ?? null;
  const contextBusy = Boolean(contextJob && ["queued", "running"].includes(contextJob.status));
  const activeJob = status.jobs.active;

  const moments: Moment[] = detail
    ? [
        ...markersToMoments(detail.markers),
        ...detail.mentalNotes
          .filter((note) => note.source === "spoken")
          .map((note) => ({
            key: `spoken-${note.tsMs}-${note.text}`,
            tsMs: note.tsMs,
            label: "Spoken note",
            detail: note.text,
            tone: "warn" as const
          }))
      ]
        .sort((a, b) => b.tsMs - a.tsMs)
        .slice(0, 8)
    : [];

  const primaryFile = (name: string) => outputs.find((file) => file.name === name) ?? null;

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Record</h1>
          <p className="muted">Records your table&apos;s Discord voice. Audio, notes, and rolls stay on this computer.</p>
        </div>
      </div>

      <Warnings warnings={status.warnings} />

      {activeJob && (
        <div className="active-job-banner">
          <div className="active-job-head">
            <Pill tone="warn">Working</Pill>
            <strong>{jobLabel(activeJob.type)}</strong>
            <span>{activeJob.progress.detail ?? activeJob.progress.phase}</span>
          </div>
          <div className="progress">
            <span style={{ width: `${Math.max(0, Math.min(100, activeJob.progress.percent || 0))}%` }} />
          </div>
          <div className="active-job-meta muted tiny">
            <span>{Math.round(activeJob.progress.percent || 0)}%</span>
            {activeJob.progress.etaMs != null && <span>{formatEta(activeJob.progress.etaMs)}</span>}
          </div>
        </div>
      )}

      <div className="status-strip">
        <div className="status-cell">
          <span>Recording</span>
          <strong className={isThisRecording ? "mono" : undefined}>
            {isThisRecording ? formatDuration(capture.elapsedMs) : "Not recording"}
          </strong>
          <small>{isThisRecording ? "Live" : session?.status === "ready" ? "Saved for this session" : "Ready when you are"}</small>
        </div>
        <div className="status-cell">
          <span>Audio</span>
          <strong className={healthTone === "bad" ? "bad-text" : healthTone === "warn" ? "warn-text" : "ok-text"}>
            {healthLabel}
          </strong>
          <small className={capture.decryptionFailures > 0 ? "bad-text" : undefined}>{healthDetail}</small>
        </div>
        <div className="status-cell">
          <span>In voice</span>
          <strong>{voiceReady ? `${peopleInVoice} ${peopleInVoice === 1 ? "person" : "people"}` : "Not connected"}</strong>
          <small>{status.voice.channelName ?? "Join a channel below"}</small>
        </div>
        <div className="status-cell">
          <span>Last heard</span>
          <strong>{lastHeardMs ? formatRelative(lastHeardMs) : "—"}</strong>
          <small>{capture.speakers.length > 0 ? `${capture.speakers.length} heard this session` : "No speech yet"}</small>
        </div>
        <div className="status-cell">
          <span>Rolls</span>
          <strong>{rollsCaptured > 0 ? rollsCaptured : "—"}</strong>
          <small>{rollsSource}</small>
        </div>
      </div>

      <div className="grid two">
        <Card
          title={session?.title ?? "No session yet"}
          subtitle={session ? `${formatDate(session.createdAtMs, session.timeZone)} · ${systemName(session.system.id)} · ${session.world.title}` : "Create a session before you record"}
          actions={session && <Pill tone={statusTone(session.status)}>{sessionStatusLabel(session.status)}</Pill>}
        >
          {!session ? (
            <Empty title="Create a session first">
              A session holds one recording, its consent record, and its notes.
              <div className="button-row empty-actions">
                <Button variant="primary" onClick={props.onSessions}>Go to Sessions</Button>
              </div>
            </Empty>
          ) : (
            <>
              <div className="session-facts">
                <Stat label="Started" value={startedMs ? formatTime(startedMs, session.timeZone) : "—"} sub={startedMs ? formatDate(startedMs, session.timeZone) : "not yet"} />
                <Stat label="Length" value={sessionLengthMs > 0 ? formatLength(sessionLengthMs) : "—"} sub={detail ? `${detail.people.length} ${detail.people.length === 1 ? "person" : "people"}` : undefined} />
                <Stat
                  label="Consent"
                  value={consentSatisfied ? (session.consent.method === "foundry" || foundryPromptFresh ? "Notice sent" : "Confirmed") : "Not confirmed"}
                  sub={detail && detail.people.some((person) => person.consentStatus === "opted_out") ? "someone opted out" : undefined}
                />
                <Stat
                  label="Notes"
                  value={outputs.length === 0 ? "Not built" : detail?.outputsStale ? "Out of date" : "Built"}
                  sub={outputs.length > 0 ? `${formatBytes(notesBytes)}${builtAtMs ? ` · ${formatRelative(builtAtMs)}` : ""}` : builtAtMs ? formatRelative(builtAtMs) : undefined}
                />
              </div>

              {["draft", "error"].includes(session.status) && bridgeConnected && !promptSupported && (
                <div className="preflight">
                  <strong>Foundry module needs an update.</strong>
                  <p className="small">
                    Foundry is running module {status.foundry.live.moduleVersion ?? "unknown"}. Install module{" "}
                    {FOUNDRY_CONSENT_COMMAND_VERSION} from Setup, then refresh the Foundry client to prompt players
                    from here. Meanwhile, confirm the notice manually.
                  </p>
                  <div className="button-row">
                    <Button variant="small" onClick={props.onSetup}>Open Setup</Button>
                  </div>
                </div>
              )}

              {["draft", "error"].includes(session.status) && promptSupported && (
                <div className="start-consent">
                  <label className="checkbox">
                    <input
                      type="checkbox"
                      checked={promptPlayers}
                      onChange={(event) => setPromptChoice(event.target.checked)}
                    />
                    <span>Prompt players in Foundry when recording starts</span>
                  </label>
                  {promptPlayers && (
                    <p className="muted tiny">
                      Recording starts immediately. Players who opt out are dropped from capture as the bridge reports them.
                    </p>
                  )}
                </div>
              )}

              <div className="button-row session-actions">
                {isThisRecording ? (
                  <Button variant="danger" disabled={Boolean(busy)} onClick={() => props.onStop(session.sessionId)}>
                    {busy === "stop" ? "Saving…" : "Stop and save"}
                  </Button>
                ) : ["draft", "error"].includes(session.status) ? (
                  <Button
                    variant="primary"
                    disabled={!canStart || Boolean(busy)}
                    onClick={() => props.onStart(session.sessionId, promptPlayers)}
                  >
                    {busy === "start" ? "Starting…" : "Start recording"}
                  </Button>
                ) : session.status === "processing" ? (
                  <span className="muted small">Processing the recording…</span>
                ) : session.status === "stopping" ? (
                  <span className="muted small">Saving the recording…</span>
                ) : (
                  <>
                    <Button variant="primary" onClick={props.onSessions}>Open session</Button>
                    {canProcess && (outputs.length === 0 || detail?.outputsStale) && (
                      <Button disabled={Boolean(busy)} onClick={() => props.onEnqueue(session.sessionId, "run_all")}>
                        Build notes
                      </Button>
                    )}
                  </>
                )}
                {isThisRecording && <span className="live-label"><span className="speaking-dot on" /> recording</span>}
              </div>

              {isThisRecording && sessionId && (
                <div className="recording-brief">
                  <span className="muted small">Need a brief while recording?</span>
                  <select value={props.recentSeconds} onChange={(event) => props.onRecentSeconds(Number(event.target.value))}>
                    {recentOptions.map((seconds) => (
                      <option key={seconds} value={seconds}>last {recentLabel(seconds)}</option>
                    ))}
                  </select>
                  <Button
                    variant="ghost"
                    disabled={Boolean(busy) || contextBusy}
                    onClick={() => props.onRecentContext(sessionId, props.recentSeconds)}
                  >
                    {contextBusy ? "Transcribing…" : "Transcribe & brief"}
                  </Button>
                  {contextJob?.status === "done" && (
                    <Button variant="ghost" onClick={() => props.onOpenContext(contextJob.jobId)}>Open latest</Button>
                  )}
                </div>
              )}

              {["draft", "error"].includes(session.status) && !canStart && (
                <div className="preflight">
                  {!botReady ? (
                    <>
                      <strong>The Discord bot is not connected.</strong>
                      <p className="small">Add the bot token, then restart the dashboard. <button className="link" onClick={props.onSetup}>Open Setup</button></p>
                    </>
                  ) : !consentSatisfied ? (
                    <>
                      <strong>Show players the recording notice first.</strong>
                      <p className="small">
                        {promptSupported
                          ? "Tick the prompt box above to send the notice through Foundry, or confirm that you have shown it another way."
                          : bridgeConnected
                            ? "Foundry is running an older module that cannot receive the prompt. Install the current module and refresh Foundry, or confirm the notice manually."
                            : "The Foundry bridge is not connected. Confirm that you have shown players the notice, or open Setup and connect the module."}
                      </p>
                      <div className="button-row">
                        <Button variant="small" onClick={() => props.onConfirmConsent(session.sessionId)}>I have shown the notice</Button>
                        <Button variant="ghost small" onClick={props.onSessions}>Review in Sessions</Button>
                      </div>
                    </>
                  ) : !session.voiceChannel ? (
                    <>
                      <strong>This session has no voice channel.</strong>
                      <p className="small">Pick a channel in Sessions, or join one below and start from there.</p>
                    </>
                  ) : null}
                </div>
              )}
            </>
          )}
        </Card>

        <Card title="Voice channel" subtitle="The bot only listens; it never speaks.">
          <div className="form-grid">
            <label className="field">
              <span>Discord server</span>
              <select value={props.guildId} onChange={(event) => props.onGuild(event.target.value)} disabled={voiceReady || capture.state === "recording"}>
                <option value="">Select a server…</option>
                {props.guilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>{guild.name}</option>
                ))}
              </select>
            </label>
            <label className="field">
              <span>Channel</span>
              <select value={props.channelId} onChange={(event) => props.onChannel(event.target.value)} disabled={voiceReady || capture.state === "recording"}>
                <option value="">Select a channel…</option>
                {props.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>
                    {channel.parentName ? `${channel.parentName} / ` : ""}{channel.name} ({channel.memberCount})
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="button-row">
            <Button variant="primary" disabled={voiceReady || Boolean(busy) || capture.state === "recording" || !props.channelId || !botReady} onClick={props.onJoin}>
              {busy === "join" ? "Joining…" : "Join"}
            </Button>
            <Button disabled={!voiceReady || Boolean(busy) || capture.state === "recording"} onClick={props.onLeave}>Leave</Button>
            <Button variant="ghost" disabled={Boolean(busy) || capture.state === "recording" || !botReady || !props.channelId} onClick={props.onCaptureTestStart}>
              {isTestActive ? "Test running…" : "Test audio"}
            </Button>
            {isTestActive && <Button variant="danger" disabled={Boolean(busy)} onClick={props.onCaptureTestStop}>Stop test</Button>}
          </div>
          {!status.bot.configured && (
            <p className="muted small">No bot token yet. Add <code>DISCORD_TOKEN</code> to <code>.env</code> and restart to record voice.</p>
          )}
          {status.voice.error && <p className="bad-text small">{status.voice.error}</p>}
          {props.captureTest && (
            <div className={`test-result ${props.captureTest.totalBytes > 0 ? "ok" : "bad"}`}>
              <strong>{props.captureTest.totalBytes > 0 ? "Audio test passed" : "No audio reached the bot"}</strong>
              {props.captureTest.totalBytes > 0 ? (
                <>
                  <div className="small">
                    {props.captureTest.utteranceCount} {props.captureTest.utteranceCount === 1 ? "clip" : "clips"} · {formatBytes(props.captureTest.totalBytes)} captured
                  </div>
                  {props.captureTest.speakers.map((speaker) => (
                    <div className="small" key={speaker.displayName}>
                      {speaker.displayName}: {speaker.utteranceCount} {speaker.utteranceCount === 1 ? "clip" : "clips"} · {formatBytes(speaker.bytes)}
                    </div>
                  ))}
                </>
              ) : (
                <div className="small">
                  Check that the bot can Connect and Speak in this channel, and that it is not server-muted.
                </div>
              )}
              <div className="muted tiny">
                {props.captureTest.decryptionFailures} decrypt {props.captureTest.decryptionFailures === 1 ? "error" : "errors"} · test {props.captureTest.testId}
              </div>
              {props.captureTest.warnings.map((warning, index) => (
                <div className="warn-text tiny" key={index}>{warning}</div>
              ))}
            </div>
          )}
          <Disclosure summary="Connection details">
            <ul className="detail-list">
              <li>
                <span>DAVE encryption</span>
                <span>{status.voice.daveEnabled ? "on" : "off"}</span>
              </li>
              <li>
                <span>Privacy code</span>
                <span className="mono">{status.voice.privacyCode ?? "—"}</span>
              </li>
              <li>
                <span>Decryption failures</span>
                <span className={capture.decryptionFailures > 0 ? "bad-text" : undefined}>{capture.decryptionFailures}</span>
              </li>
              <li>
                <span>Reconnects</span>
                <span>{capture.reconnectCount}</span>
              </li>
              <li>
                <span>Speaking events</span>
                <span>{capture.speakingEventCount}</span>
              </li>
              {status.bot.gatewayPingMs != null && (
                <li>
                  <span>Gateway ping</span>
                  <span>{status.bot.gatewayPingMs} ms</span>
                </li>
              )}
              {capture.testId && (
                <li>
                  <span>Test ID</span>
                  <span className="mono tiny">{capture.testId}</span>
                </li>
              )}
              {status.voice.guildId && (
                <li>
                  <span>Server / channel ID</span>
                  <span className="mono tiny">{status.voice.guildId} / {status.voice.channelId ?? "—"}</span>
                </li>
              )}
              {status.bot.userId && (
                <li>
                  <span>Bot</span>
                  <span className="tiny">{status.bot.username ?? "—"} · {status.bot.userId}</span>
                </li>
              )}
            </ul>
          </Disclosure>
        </Card>
      </div>

      <div className="grid two">
        <Card title="Mark a moment" subtitle="Scene changes, breaks, combat, or something to remember later.">
        {sessionId ? (
          <>
            <MarkerBar
              label={props.markerLabel}
              onLabelChange={props.onMarkerLabel}
              disabled={Boolean(busy)}
              onAdd={(kind, mentalNote) => props.onMarker(sessionId, kind, mentalNote)}
            />
            <MomentList
              moments={moments}
              timeZone={session?.timeZone}
              onDelete={(markerId) => props.onDeleteMarker(sessionId, markerId)}
              empty="Nothing marked yet. Say “note to self…” or use the buttons above."
            />
          </>
        ) : (
          <Empty title="Select a session" />
        )}
        </Card>

        <Card title="Who is being heard" subtitle="Live from the voice channel.">
          <SpeakerTable speakers={capture.speakers} />
        </Card>
      </div>

      <div className="grid two">
        <Card title="Session brief" subtitle="A deterministic brief, or an AI summary you can review.">
          {sessionId ? (
            <div className="recent-context-controls">
              <div className="brief-block">
                <div className="button-row">
                  <label className="field compact-field">
                    <span>Brief window</span>
                    <select aria-label="Brief window" value={props.recentSeconds} onChange={(event) => props.onRecentSeconds(Number(event.target.value))}>
                      {recentOptions.map((seconds) => (
                        <option key={seconds} value={seconds}>last {recentLabel(seconds)}</option>
                      ))}
                    </select>
                  </label>
                  <Button
                    variant="primary"
                    disabled={Boolean(busy) || contextBusy || ["draft", "joining", "stopping"].includes(session!.status)}
                    onClick={() => props.onRecentContext(sessionId, props.recentSeconds)}
                  >
                    {contextBusy ? (contextJob?.status === "queued" ? "Waiting…" : "Transcribing…") : "Transcribe & brief"}
                  </Button>
                  {contextJob?.status === "done" && (
                    <Button variant="ghost" onClick={() => props.onOpenContext(contextJob.jobId)}>Open latest</Button>
                  )}
                </div>
                <p className="muted small">
                  Transcribes missing clips in that window and opens a copyable Markdown brief for an external agent.
                  No AI model is needed.
                </p>
              </div>

              <div className="ai-summary-block">
                <div className="ai-summary-block-head">
                  <h3>AI summary</h3>
                  <p className="muted small">
                    {props.llmScope === "recent"
                      ? `Uses the ${recentLabel(props.recentSeconds)} window above.`
                      : "Uses the selected scope. No window applies."}
                  </p>
                </div>
                <div className="button-row">
                  <label className="field compact-field">
                    <span>Scope</span>
                    <select aria-label="Summary scope" value={props.llmScope} onChange={(event) => props.onLlmScope(event.target.value as LlmSummaryScope)}>
                      <option value="recent">Recent window</option>
                      <option value="scene">Current scene</option>
                      <option value="session">Whole session</option>
                    </select>
                  </label>
                  <label className="field compact-field">
                    <span>Preset</span>
                    <select aria-label="Summary preset" value={props.llmPreset} onChange={(event) => props.onLlmPreset(event.target.value as LlmSummaryPreset)}>
                      <option value="gm-prep">GM prep</option>
                      <option value="recap">Session recap</option>
                      <option value="clue-board">Clue board</option>
                      <option value="rules">Rules log</option>
                    </select>
                  </label>
                  {props.llmEnabled ? (
                    <Button
                      variant="ghost"
                      disabled={Boolean(busy) || contextBusy || !props.llmConfigured || ["draft", "joining", "stopping"].includes(session!.status)}
                      title={!props.llmConfigured ? "Configure an AI provider in Setup first" : undefined}
                      onClick={() => props.onLlmSummary(sessionId, props.recentSeconds)}
                    >
                      {busy === "llm" ? "Summarizing…" : "Summarize"}
                    </Button>
                  ) : (
                    <span className="muted small">AI summaries are off in Setup.</span>
                  )}
                </div>
              </div>
              {contextJob && contextBusy && (
                <div className="context-job">
                  <div className="context-job-head">
                    <Pill tone="warn">{contextJob.status === "queued" ? "Waiting" : "Working"}</Pill>
                    <span className="small">{contextJob.progress.detail ?? "Preparing the brief"}</span>
                  </div>
                  <div className="progress">
                    <span style={{ width: `${Math.max(0, Math.min(100, contextJob.progress.percent || 0))}%` }} />
                  </div>
                </div>
              )}
              {props.llmSummaries.length > 0 && (
                <Disclosure summary={`Summary history (${props.llmSummaries.length})`}>
                  <div className="llm-history">
                    {props.llmSummaries.map((item) => (
                      <button className="llm-history-row" key={item.summaryId} onClick={() => props.onOpenLlmSummary(item)}>
                        <span>
                          <strong>{summaryPresetLabel(item.preset)}</strong>
                          <span className="muted tiny">
                            {" "}
                            · {summaryScopeLabel(item.scope)}
                            {item.window.label.toLowerCase() === summaryScopeLabel(item.scope).toLowerCase()
                              ? ""
                              : ` · ${item.window.label}`}
                          </span>
                        </span>
                        <span className="muted tiny">
                          {item.provider === "deepseek" ? "DeepSeek" : item.provider === "ollama" ? "Ollama" : item.provider === "llamacpp" ? "llama.cpp" : "Local"} ·{" "}
                          {item.model} · {formatRelative(item.createdAtMs)}
                          {item.chunks > 1 ? ` · ${item.chunks} portions` : item.trimmed ? " · trimmed" : ""}
                        </span>
                      </button>
                    ))}
                  </div>
                </Disclosure>
              )}
              <Disclosure summary="What goes in the brief?">
                <p className="muted small">
                  The brief uses the last window. The AI summary uses the selected scope and preset; when its scope is
                  recent, it uses the same window. New speech is transcribed first; anything already transcribed is reused.
                  The summary is a convenience, not a record.
                </p>
              </Disclosure>
            </div>
          ) : (
            <Empty title="Select a session" />
          )}
        </Card>

        <Card title="Files" subtitle={detail ? `${outputs.length} ${outputs.length === 1 ? "file" : "files"} · ${formatBytes(notesBytes)}` : undefined}>
          {!detail ? (
            <Empty title="Select a session" />
          ) : outputs.length === 0 ? (
            <div>
              <p className="muted small">
                No notes have been built yet. They are created from the recording and the Foundry rolls.
              </p>
              {canProcess && sessionId && (
                <Button disabled={Boolean(busy)} onClick={() => props.onEnqueue(sessionId, "run_all")}>Build notes</Button>
              )}
            </div>
          ) : (
            <>
              <p className="muted small">
                {detail.outputsStale
                  ? `Out of date${detail.outputsStaleReason ? ` — ${detail.outputsStaleReason}` : ""}. Rebuild before you use them.`
                  : `Last built ${formatDateTime(builtAtMs, session?.timeZone)}.`}
              </p>
              <ul className="quick-files">
                {[
                  { name: "transcript.md", label: "Session transcript", description: "Everything that was said, in order." },
                  { name: "notes-ready.md", label: "Session notes", description: "A readable timeline with short backchannels trimmed." },
                  { name: "rolls.csv", label: "Rolls", description: "Every roll, ready for a spreadsheet." }
                ].map((item) => {
                  const file = primaryFile(item.name);
                  if (!file) return null;
                  return (
                    <li key={item.name}>
                      <div>
                        <strong>{item.label}</strong>
                        <div className="muted tiny">{item.description}</div>
                      </div>
                      <a className="btn small" href={`/api/sessions/${sessionId}/outputs/${item.name}?download=1`} download={item.name}>Download</a>
                    </li>
                  );
                })}
              </ul>
              <div className="button-row">
                <Button variant="ghost" onClick={props.onSessions}>All files</Button>
                {detail.outputsStale && canProcess && sessionId && (
                  <Button disabled={Boolean(busy)} onClick={() => props.onEnqueue(sessionId, "run_all")}>Rebuild</Button>
                )}
              </div>
              <Disclosure summary={`Every generated file (${outputs.length})`}>
                <ul className="output-links">
                  {outputs.map((file) => (
                    <li key={file.name}>
                      <span className="mono tiny">{file.name}</span>
                      <a className="btn small" href={`/api/sessions/${sessionId}/outputs/${file.name}?download=1`} download={file.name}>
                        Download
                      </a>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}
