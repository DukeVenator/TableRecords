import { useEffect, useState } from "react";
import type { Guild, HealthCheck, SettingsPayload, Status, World } from "./types";
import { Button, Card, Field, Pill } from "./components";
import { botInviteUrl, buildSetupSteps, setupProgress, DISCORD_DEVELOPER_PORTAL, type SetupStep } from "./setupStatus";

export interface SetupWizardProps {
  settings: SettingsPayload | null;
  status: Status | null;
  checks: HealthCheck[];
  guilds: Guild[];
  worlds: World[];
  captureTestPassed: boolean;
  busy: string | null;
  onClose: () => void;
  onRefresh: () => void;
  onSaveSettings: (payload: Record<string, unknown>) => void;
  onInstallModule: () => void;
  onGoRecord: () => void;
  onGoSessions: () => void;
  onGoSetup: () => void;
  onAudioTest: () => void;
  onMarkAudioTest: (passed: boolean) => void;
}

export function SetupWizard(props: SetupWizardProps) {
  const [foundryPath, setFoundryPath] = useState(props.settings?.settings.foundryDataPath ?? "");
  const [engine, setEngine] = useState<"parakeet" | "faster-whisper">(
    props.settings?.settings.sttEngine ?? "parakeet"
  );
  const [inviteCopied, setInviteCopied] = useState(false);
  useEffect(() => {
    if (props.settings) setEngine(props.settings.settings.sttEngine);
  }, [props.settings?.settings.sttEngine]);
  const steps = buildSetupSteps({
    settings: props.settings,
    status: props.status,
    guilds: props.guilds,
    worlds: props.worlds,
    captureTestPassed: props.captureTestPassed
  });
  const progress = setupProgress(steps);
  const percent = progress.total === 0 ? 0 : Math.round((progress.done / progress.total) * 100);
  const inviteUrl = botInviteUrl(props.settings?.env.discordClientId ?? null);
  const tokenConfigured = Boolean(props.settings?.env.discordTokenConfigured);

  const copyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2500);
    } catch {
      // The link is selectable if the clipboard is blocked.
    }
  };

  const stepBody = (step: SetupStep) => {
    if (step.id === "token") {
      if (step.done) {
        return (
          <>
            <p className="small">The token is configured, so the bot can connect.</p>
            <p className="muted small">The token itself is never shown in this dashboard.</p>
          </>
        );
      }
      return (
        <>
          <ol className="steps">
            <li>Open the Discord developer portal and create an application.</li>
            <li>Add a bot, then copy its token.</li>
            <li>
              Put <code>DISCORD_TOKEN=…</code> in the project&apos;s <code>.env</code> file.
            </li>
            <li>
              Restart the dashboard (<code>npm run dashboard</code>), then press <strong>Check again</strong>.
            </li>
          </ol>
          <a className="btn small" href={DISCORD_DEVELOPER_PORTAL} target="_blank" rel="noreferrer">
            Open Discord apps
          </a>
        </>
      );
    }
    if (step.id === "invite") {
      return tokenConfigured ? (
        <>
          <p className="small">
            {step.done
              ? `The bot is in ${props.guilds.length} ${props.guilds.length === 1 ? "server" : "servers"}.`
              : "Invite the bot to the server where you play."}
          </p>
          <Field label="Invite link" hint="View Channel, Connect, Speak. No message permissions are needed.">
            <div className="token-row">
              <input
                readOnly
                className="mono"
                value={inviteUrl ?? "The token did not contain a readable application ID"}
                onFocus={(event) => event.target.select()}
              />
              <Button variant="small" disabled={!inviteUrl} onClick={() => void copyInvite()}>
                {inviteCopied ? "Copied ✓" : "Copy"}
              </Button>
              {inviteUrl && (
                <a className="btn small" href={inviteUrl} target="_blank" rel="noreferrer">Open</a>
              )}
            </div>
          </Field>
        </>
      ) : (
        <p className="muted small">Finish the token step first; the invite link is built from it.</p>
      );
    }
    if (step.id === "audio") {
      return (
        <>
          <p className="small">
            {step.done
              ? "Audio test is complete."
              : "The guided test joins your voice channel, records for 10 seconds, then asks whether you spoke."}
          </p>
          <div className="button-row">
            <Button variant="small" onClick={props.onAudioTest}>
              {step.done ? "Run audio test again" : "Run audio test"}
            </Button>
            <Button variant="ghost small" onClick={props.onGoRecord}>Open Record</Button>
            <label className="checkbox" title="Mark the audio test complete without running it again">
              <input
                type="checkbox"
                checked={props.captureTestPassed}
                onChange={(event) => props.onMarkAudioTest(event.target.checked)}
              />
              <span className="small">I already tested</span>
            </label>
          </div>
        </>
      );
    }
    if (step.id === "speech") {
      const activeEngine = props.status?.stt.engine ?? "parakeet";
      const activeLabel = activeEngine === "parakeet" ? "Parrot (Parakeet)" : "Whisper";
      const activeReady = props.status?.stt.state === "ready";
      return (
        <>
          <p className="small">
            {activeReady
              ? `${activeLabel} is ready.`
              : `${activeLabel} is not ready${props.status?.stt.error ? `: ${props.status.stt.error}` : "."} Choose an engine below; both run locally.`}
          </p>
          <Field label="Engine" hint="Parrot is the default. You can switch at any time; the next transcription uses the saved engine.">
            <select
              value={engine}
              disabled={Boolean(props.busy)}
              onChange={(event) => {
                const value = event.target.value as "parakeet" | "faster-whisper";
                setEngine(value);
                props.onSaveSettings({ sttEngine: value });
              }}
            >
              <option value="parakeet">Parrot (Parakeet, built in)</option>
              <option value="faster-whisper">Whisper (faster-whisper)</option>
            </select>
          </Field>
          <p className="muted small">
            {engine === "parakeet"
              ? "Parrot needs the nemo-speech runtime and a .gguf model. If that is not installed, switch to Whisper and run npm run setup:python."
              : "Whisper needs the Python environment from npm run setup:python. It can run on the graphics card or the processor."}
          </p>
          <div className="button-row">
            {activeEngine === "parakeet" && !activeReady && (
              <Button
                variant="small"
                disabled={Boolean(props.busy)}
                onClick={() => {
                  setEngine("faster-whisper");
                  props.onSaveSettings({ sttEngine: "faster-whisper" });
                }}
              >
                Use Whisper instead
              </Button>
            )}
            {activeEngine === "faster-whisper" && !activeReady && (
              <Button
                variant="small"
                disabled={Boolean(props.busy)}
                onClick={() => {
                  setEngine("parakeet");
                  props.onSaveSettings({ sttEngine: "parakeet" });
                }}
              >
                Use Parrot instead
              </Button>
            )}
            <Button variant="small" onClick={props.onRefresh}>Check again</Button>
            <Button variant="ghost small" onClick={props.onGoSetup}>Open transcription settings</Button>
          </div>
        </>
      );
    }
    if (step.id === "ai") {
      const llm = props.settings?.llm;
      const provider = llm?.provider === "deepseek" ? "DeepSeek cloud" : llm?.provider === "ollama" ? "Ollama" : llm?.provider === "llamacpp" ? "llama.cpp" : "a local server";
      return (
        <>
          <p className="small">
            {!llm?.enabled
              ? "Optional. Local recaps stay off until you turn them on."
              : llm.configured
                ? `${provider} is configured with ${llm.model ?? "its default model"}.`
                : "Enabled, but no model is selected yet."}
          </p>
          <p className="muted small">
            The brief is sent only when you press Summarize. Audio never leaves this computer. A 27B model needs about
            17 GB of video memory; a 9B model is the lighter fallback.
          </p>
          <div className="button-row">
            <Button variant="small" onClick={props.onGoSetup}>Open AI summary settings</Button>
            <Button variant="ghost small" onClick={props.onRefresh}>Check again</Button>
          </div>
        </>
      );
    }
    if (step.id === "foundry") {
      return (
        <>
          <p className="small">
            {step.done
              ? `${props.worlds.length} ${props.worlds.length === 1 ? "world" : "worlds"} detected.`
              : "Choose the folder where Foundry stores its worlds. TableRecords needs it so the dashboard can install the bridge for you."}
          </p>
          <Field label="Foundry folder" hint="Usually C:\Users\you\AppData\Local\FoundryVTT">
            <div className="token-row">
              <input
                value={foundryPath}
                onChange={(event) => setFoundryPath(event.target.value)}
                placeholder="C:\Users\you\AppData\Local\FoundryVTT"
              />
              <Button
                variant="small"
                disabled={Boolean(props.busy) || !foundryPath.trim()}
                onClick={() => props.onSaveSettings({ foundryDataPath: foundryPath.trim() || null })}
              >
                Save
              </Button>
            </div>
          </Field>
          <div className="button-row">
            <Button
              variant="small"
              disabled={Boolean(props.busy) || !props.settings?.settings.foundryDataPath}
              onClick={props.onInstallModule}
            >
              Install module
            </Button>
            <Button variant="ghost small" onClick={props.onGoSessions}>Open Sessions</Button>
          </div>
        </>
      );
    }
    return (
      <>
        <p className="small">
          {step.done
            ? "The bridge is connected and sending rolls and scene changes."
            : "We recommend the bridge. It sends rolls and scene changes while you play. Install the module from Setup, turn it on in Foundry, then check again."}
        </p>
        <p className="muted small">
          If you want a lighter setup, or Foundry cannot reach the dashboard, use the macro export after the session.
        </p>
        <div className="button-row">
          {!step.done && <Button variant="small" onClick={props.onInstallModule}>Install module</Button>}
          <Button variant="small" onClick={props.onRefresh}>Check again</Button>
          <a
            className="btn ghost small"
            href="https://github.com/DukeVenator/TableRecords/blob/main/foundry-macros/table-records-export.js"
            target="_blank"
            rel="noreferrer"
          >
            Use the macro instead
          </a>
        </div>
      </>
    );
  };

  return (
    <div className="page wizard">
      <div className="page-heading">
        <div>
          <h1>Setup wizard</h1>
          <p className="muted">Get the bot recording and transcribing. Foundry and AI summaries are optional and can wait.</p>
        </div>
        <Button variant="ghost" onClick={props.onClose}>Close</Button>
      </div>

      <Card title="Progress" subtitle={`Step ${progress.done} of ${progress.total}`}>
        <div className="progress wizard-progress">
          <span style={{ width: `${percent}%` }} />
        </div>
        <p className="muted small">
          {progress.done === progress.total
            ? "Everything required is ready. Close this and start a session."
            : "You can close this at any time; Setup has the same checklist and a button to reopen it."}
        </p>
      </Card>

      <div className="wizard-steps">
        {steps.map((step, index) => (
          <Card
            key={step.id}
            title={`${index + 1}. ${step.title}`}
            actions={
              <div className="button-row">
                {step.optional && <Pill tone="idle">optional</Pill>}
                <Pill tone={step.done ? "ok" : step.optional ? "idle" : "warn"}>
                  {step.done ? "done" : step.optional ? "later" : "to do"}
                </Pill>
              </div>
            }
          >
            {stepBody(step)}
          </Card>
        ))}
      </div>

      <div className="button-row wizard-footer">
        <Button onClick={props.onRefresh}>Check again</Button>
        <Button variant="primary" onClick={props.onClose}>Back to TableRecords</Button>
      </div>
    </div>
  );
}
