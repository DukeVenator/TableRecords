import { useCallback, useEffect, useRef, useState } from "react";
import type { CaptureTestResult, Guild, Status, VoiceChannel } from "./types";
import { api } from "./api";
import { Button, Field, Modal, Pill } from "./components";
import { formatBytes } from "./format";
import { audioTestSucceeded } from "./audioTest";

const TEST_SECONDS = 10;

type Stage = "choose" | "starting" | "running" | "stopping" | "review" | "success" | "failed";

export interface AudioTestWizardProps {
  status: Status | null;
  guilds: Guild[];
  initialGuildId: string;
  initialChannelId: string;
  initialChannels: VoiceChannel[];
  busy: string | null;
  onStart: (guildId: string, channelId: string) => Promise<boolean>;
  onStop: () => Promise<CaptureTestResult | null>;
  onComplete: (passed: boolean) => void;
  onClose: () => void;
}

export function AudioTestWizard(props: AudioTestWizardProps) {
  const [stage, setStage] = useState<Stage>("choose");
  const [guildId, setGuildId] = useState(props.initialGuildId || props.guilds[0]?.id || "");
  const [channelId, setChannelId] = useState(props.initialChannelId);
  const [channels, setChannels] = useState<VoiceChannel[]>(props.initialChannels);
  const [loadingChannels, setLoadingChannels] = useState(false);
  const [channelsError, setChannelsError] = useState<string | null>(null);
  const [result, setResult] = useState<CaptureTestResult | null>(null);
  const [deadlineMs, setDeadlineMs] = useState<number | null>(null);
  const [nowMs, setNowMs] = useState(Date.now());
  const [error, setError] = useState<string | null>(null);
  const finishing = useRef(false);

  const currentChannel = channels.find((channel) => channel.id === channelId) ?? null;
  const botReady = props.status?.bot.state === "ready";
  const captureBusy = ["recording", "joining", "stopping"].includes(props.status?.capture.state ?? "");

  useEffect(() => {
    if (!guildId) return;
    let cancelled = false;
    setLoadingChannels(true);
    setChannelsError(null);
    void api<{ voiceChannels: VoiceChannel[] }>(`/api/discord/guilds/${guildId}/channels`)
      .then((response) => {
        if (cancelled) return;
        setChannels(response.voiceChannels);
        setChannelId((current) => {
          const preferred =
            response.voiceChannels.find((channel) => channel.id === current) ??
            response.voiceChannels.find((channel) => channel.id === props.status?.voice.channelId) ??
            [...response.voiceChannels].sort((a, b) => b.memberCount - a.memberCount)[0];
          return preferred?.id ?? "";
        });
      })
      .catch((caught: unknown) => {
        if (!cancelled) setChannelsError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setLoadingChannels(false);
      });
    return () => {
      cancelled = true;
    };
  }, [guildId, props.status?.voice.channelId]);

  useEffect(() => {
    if (stage !== "running" || !deadlineMs) return;
    const timer = window.setInterval(() => setNowMs(Date.now()), 250);
    return () => window.clearInterval(timer);
  }, [stage, deadlineMs]);

  const finish = useCallback(async () => {
    if (finishing.current) return;
    finishing.current = true;
    setStage("stopping");
    try {
      const captured = await props.onStop();
      setResult(captured);
      setDeadlineMs(null);
      setStage("review");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      setStage("choose");
      setDeadlineMs(null);
    } finally {
      finishing.current = false;
    }
  }, [props]);

  useEffect(() => {
    if (stage === "running" && deadlineMs && nowMs >= deadlineMs) {
      void finish();
    }
  }, [stage, deadlineMs, nowMs, finish]);

  const start = async () => {
    if (!guildId || !channelId) return;
    setError(null);
    setResult(null);
    setStage("starting");
    const started = await props.onStart(guildId, channelId);
    if (!started) {
      setStage("choose");
      return;
    }
    setNowMs(Date.now());
    setDeadlineMs(Date.now() + TEST_SECONDS * 1000);
    setStage("running");
  };

  const retry = () => {
    setResult(null);
    setError(null);
    setDeadlineMs(null);
    setStage("choose");
  };

  const close = () => {
    if (stage === "running" || stage === "starting" || stage === "stopping") {
      void props.onStop().finally(props.onClose);
    } else {
      props.onClose();
    }
  };

  const secondsLeft = deadlineMs ? Math.max(0, Math.ceil((deadlineMs - nowMs) / 1000)) : TEST_SECONDS;

  return (
    <Modal title="Audio test" onClose={close}>
      <div className="audio-test-wizard">
        {stage === "choose" && (
          <>
            <p className="small">
              The bot joins the voice channel, listens for {TEST_SECONDS} seconds, then asks whether you spoke. Channels with people in them are preselected.
            </p>
            <div className="form-grid">
              <Field label="Discord server">
                <select
                  value={guildId}
                  onChange={(event) => {
                    setGuildId(event.target.value);
                    setChannelId("");
                  }}
                >
                  {props.guilds.map((guild) => (
                    <option key={guild.id} value={guild.id}>{guild.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Voice channel" hint={loadingChannels ? "Loading channels…" : "Pick the channel you are in."}>
                <select value={channelId} onChange={(event) => setChannelId(event.target.value)} disabled={loadingChannels}>
                  {channels.length === 0 && <option value="">No voice channels available</option>}
                  {channels.map((channel) => (
                    <option key={channel.id} value={channel.id}>
                      {channel.name} — {channel.memberCount} {channel.memberCount === 1 ? "person" : "people"} in channel
                    </option>
                  ))}
                </select>
              </Field>
            </div>
            {channelsError && <p className="bad-text small">{channelsError}</p>}
            {currentChannel && currentChannel.memberCount === 0 && (
              <p className="muted small">No one is in this channel right now. Join it in Discord before starting, or pick another channel.</p>
            )}
            {!botReady && <p className="warn-text small">The Discord bot is not connected. Add its token in Setup first.</p>}
            {captureBusy && <p className="warn-text small">The bot is already recording. Stop that recording before running an audio test.</p>}
            <div className="button-row">
              <Button
                variant="primary"
                disabled={!botReady || captureBusy || !guildId || !channelId || loadingChannels || Boolean(props.busy)}
                onClick={() => void start()}
              >
                Join {currentChannel ? currentChannel.name : "channel"} & start test
              </Button>
              <Button variant="ghost" onClick={close}>Cancel</Button>
            </div>
            <p className="muted tiny">
              This is a test only. It is not attached to a session, and the temporary test audio is separate from your recordings.
            </p>
          </>
        )}

        {(stage === "starting" || stage === "running" || stage === "stopping") && (
          <div className="audio-test-prompt">
            <span className={`audio-test-dot ${stage === "running" ? "on" : ""}`} />
            <h2>{stage === "starting" ? "Joining the channel…" : stage === "stopping" ? "Finishing the test…" : "Talk now"}</h2>
            <p className="small">
              {stage === "running"
                ? `The bot is listening in ${currentChannel?.name ?? "your voice channel"}. Say a sentence or two so we can confirm audio reaches it.`
                : "Give it a moment; the bot is connecting or saving the test."}
            </p>
            {stage === "running" && <div className="audio-test-countdown">{secondsLeft}s</div>}
            {stage === "running" && (
              <Button variant="danger" onClick={() => void finish()}>Stop early</Button>
            )}
          </div>
        )}

        {stage === "review" && (
          <div className="audio-test-review">
            <h2>Did you talk during the test?</h2>
            <p className="small">
              {result && result.totalBytes > 0
                ? "The bot captured some audio. Confirm it was you and we will mark the setup step complete."
                : "This test only counts after you confirm you spoke and audio arrived."}
            </p>
            <div className="button-row">
              <Button
                variant="primary"
                onClick={() => {
                  if (audioTestSucceeded(result, true)) {
                    setStage("success");
                    props.onComplete(true);
                  } else {
                    setStage("failed");
                  }
                }}
              >
                Yes, I talked
              </Button>
              <Button variant="ghost" onClick={retry}>No, let me retry</Button>
            </div>
          </div>
        )}

        {stage === "success" && (
          <div className="audio-test-result ok">
            <Pill tone="ok">audio captured</Pill>
            <h2>Audio test complete</h2>
            <p className="small">
              {result?.utteranceCount ?? 0} {result?.utteranceCount === 1 ? "clip" : "clips"} · {formatBytes(result?.totalBytes ?? 0)} captured. This setup step is now complete.
            </p>
            {result?.speakers.map((speaker) => (
              <div className="small" key={speaker.displayName}>
                {speaker.displayName}: {speaker.utteranceCount} {speaker.utteranceCount === 1 ? "clip" : "clips"} · {formatBytes(speaker.bytes)}
              </div>
            ))}
            <div className="button-row">
              <Button variant="primary" onClick={props.onClose}>Done</Button>
              <Button variant="ghost" onClick={retry}>Test again</Button>
            </div>
          </div>
        )}

        {stage === "failed" && (
          <div className="audio-test-result bad">
            <Pill tone="warn">no audio</Pill>
            <h2>No audio reached the bot</h2>
            <p className="small">
              Check that you are in {currentChannel?.name ?? "the selected channel"}, that the bot has Connect and Speak, and that your microphone is unmuted. You can try again or mark the step manually.
            </p>
            {result?.warnings.map((warning, index) => (
              <p className="warn-text small" key={index}>{warning}</p>
            ))}
            <div className="button-row">
              <Button variant="primary" onClick={retry}>Try again</Button>
              <Button variant="ghost" onClick={props.onClose}>Close</Button>
            </div>
          </div>
        )}

        {error && <p className="bad-text small">{error}</p>}
      </div>
    </Modal>
  );
}
