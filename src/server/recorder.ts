import { EventEmitter } from "node:events";
import fsp from "node:fs/promises";
import path from "node:path";
import prism from "prism-media";
import {
  EndBehaviorType,
  VoiceConnectionStatus,
  type AudioReceiveStream,
  type VoiceConnection
} from "@discordjs/voice";
import type { DiscordService } from "./discord.js";
import type { AppConfig } from "./config.js";
import type { DiscordUtterance, StreamEnd } from "../core/types.js";
import { appendJsonl, ensureDir } from "../core/paths.js";
import { newUtteranceId } from "../core/ids.js";
import { trimWavTrailingSilence, WavWriter } from "../core/wav.js";
import { isSilentUtterance, VoiceActivityMeter } from "../core/vad.js";

export type CaptureState = "idle" | "recording" | "stopping" | "error";
export type CaptureHealth = "ok" | "warning" | "error";

export interface CaptureSpeaker {
  discordUserId: string;
  displayName: string;
  character?: string | null;
  speaking: boolean;
  capturedMs: number;
  voicedMs: number;
  utteranceCount: number;
  silentCount: number;
  bytes: number;
  lastUtteranceAtMs: number | null;
  decryptionFailures: number;
}

export interface CaptureDiagnostics {
  state: CaptureState;
  sessionId: string | null;
  testId: string | null;
  startedAtMs: number | null;
  elapsedMs: number;
  health: CaptureHealth;
  utteranceCount: number;
  silentUtteranceCount: number;
  totalBytes: number;
  decryptionFailures: number;
  reconnectCount: number;
  speakingEventCount: number;
  lastPacketAtMs: number | null;
  speakers: CaptureSpeaker[];
  warnings: string[];
  error: string | null;
}

interface SpeakerState {
  displayName: string;
  speaking: boolean;
  capturedMs: number;
  voicedMs: number;
  utteranceCount: number;
  silentCount: number;
  bytes: number;
  lastUtteranceAtMs: number | null;
  decryptionFailures: number;
}

interface ActiveUtterance {
  userId: string;
  utteranceId: string;
  displayName: string;
  startMs: number;
  relFile: string;
  writer: WavWriter;
  meter: VoiceActivityMeter;
  stream: AudioReceiveStream;
  decoder: prism.opus.Decoder;
  stopReason: "stop" | "manual" | null;
  ended: boolean;
  discard: boolean;
  failures: number;
  promise: Promise<void>;
}

export interface StartCaptureOptions {
  sessionId: string;
  sessionDir: string;
  testId?: string;
  /** Discord user IDs who opted out; they are never subscribed or recorded. */
  optOutUserIds?: string[];
}

export class RecorderService extends EventEmitter {
  readonly config: AppConfig;
  readonly discord: DiscordService;
  private state: CaptureState = "idle";
  private sessionId: string | null = null;
  private testId: string | null = null;
  private sessionDir: string | null = null;
  private startedAtMs: number | null = null;
  private active = new Map<string, ActiveUtterance>();
  private pendingStarts = new Set<string>();
  private optedOutUsers = new Set<string>();
  private speakers = new Map<string, SpeakerState>();
  private speakingHandler: ((userId: string) => void) | null = null;
  private connectionStateHandler: (() => void) | null = null;
  private totalUtteranceCount = 0;
  private silentUtteranceCount = 0;
  private totalBytes = 0;
  private decryptionFailures = 0;
  private lastDecryptionAtMs: number | null = null;
  private reconnectCount = 0;
  private speakingEventCount = 0;
  private firstSpeakingAtMs: number | null = null;
  private lastPacketAtMs: number | null = null;
  private error: string | null = null;
  private warnings: string[] = [];
  private stopReason: "stop" | "manual" | null = null;

  constructor(config: AppConfig, discord: DiscordService) {
    super();
    this.config = config;
    this.discord = discord;
  }

  get activeSessionId(): string | null {
    return this.sessionId;
  }

  get captureState(): CaptureState {
    return this.state;
  }

  isActive(): boolean {
    return this.state === "recording" || this.state === "stopping";
  }

  isOptedOut(userId: string): boolean {
    return this.optedOutUsers.has(userId);
  }

  setOptOutUsers(userIds: Iterable<string>): void {
    this.optedOutUsers = new Set([...userIds].filter(Boolean));
    for (const [userId, active] of this.active.entries()) {
      if (!this.optedOutUsers.has(userId)) continue;
      active.discard = true;
      active.stopReason = "manual";
      try {
        active.stream.destroy();
        active.decoder.destroy();
      } catch {
        // already gone
      }
    }
  }

  /** Count a DAVE/Opus decryption failure reported by the voice receiver. */
  noteDecryptionFailure(message: string): void {
    if (this.state !== "recording") return;
    this.decryptionFailures += 1;
    this.lastDecryptionAtMs = Date.now();
    this.addWarning(`Voice decryption failure: ${message}`);
    this.emit("decryptionFailure", { userId: "voice", message });
  }

  private addWarning(message: string): void {
    if (this.warnings.length < 100) this.warnings.push(message);
  }

  async start(options: StartCaptureOptions): Promise<void> {
    if (this.isActive()) throw new Error("Capture is already active");
    const connection = this.discord.voiceConnection;
    if (!connection || connection.state.status !== VoiceConnectionStatus.Ready) {
      throw new Error("Voice connection is not ready; join a voice channel first");
    }
    this.reset();
    this.optedOutUsers = new Set((options.optOutUserIds ?? []).filter(Boolean));
    this.state = "recording";
    this.sessionId = options.sessionId;
    this.testId = options.testId ?? null;
    this.sessionDir = options.sessionDir;
    this.startedAtMs = Date.now();
    this.stopReason = null;
    await ensureDir(path.join(options.sessionDir, "discord", "audio"));

    this.speakingHandler = (userId: string) => this.onSpeakingStart(userId);
    connection.receiver.speaking.on("start", this.speakingHandler);
    this.connectionStateHandler = () => this.onConnectionState(connection);
    connection.on("stateChange", this.connectionStateHandler);
    this.emit("state");
  }

  private reset(): void {
    this.active.clear();
    this.pendingStarts.clear();
    this.optedOutUsers.clear();
    this.speakers.clear();
    this.totalUtteranceCount = 0;
    this.silentUtteranceCount = 0;
    this.totalBytes = 0;
    this.decryptionFailures = 0;
    this.lastDecryptionAtMs = null;
    this.reconnectCount = 0;
    this.speakingEventCount = 0;
    this.firstSpeakingAtMs = null;
    this.lastPacketAtMs = null;
    this.error = null;
    this.warnings = [];
  }

  /**
   * Discord emits "start" again after a short pause. If the previous stream is
   * still open (the configured silence window), keep writing to it; if it has
   * already ended but is still finalizing, queue one restart so the first
   * syllable of the next sentence is not dropped.
   */
  private onSpeakingStart(userId: string): void {
    if (this.state !== "recording") return;
    if (this.discord.botStatus().userId === userId) return;
    if (this.optedOutUsers.has(userId)) return;
    const existing = this.active.get(userId);
    if (existing) {
      if (!existing.ended) return;
      if (this.pendingStarts.has(userId)) return;
      this.pendingStarts.add(userId);
      void existing.promise.finally(() => {
        this.pendingStarts.delete(userId);
        if (this.state === "recording") this.onSpeakingStart(userId);
      });
      return;
    }
    this.beginUtterance(userId);
  }

  private beginUtterance(userId: string): void {
    if (this.state !== "recording") return;
    if (this.active.has(userId)) return;
    this.speakingEventCount += 1;
    if (this.firstSpeakingAtMs == null) this.firstSpeakingAtMs = Date.now();
    let stream: AudioReceiveStream | undefined;
    try {
      stream = this.discord.voiceConnection?.receiver.subscribe(userId, {
        end: { behavior: EndBehaviorType.AfterSilence, duration: this.config.captureSilenceMs }
      });
    } catch (error) {
      const warning = `Could not subscribe to ${userId}: ${error instanceof Error ? error.message : String(error)}`;
      this.addWarning(warning);
      this.emit("captureWarning", warning);
      return;
    }
    if (!stream) return;
    const utteranceId = newUtteranceId();
    const startMs = Date.now();
    const userDir = /^\d{5,30}$/.test(userId) ? userId : "unknown";
    const relFile = `discord/audio/${userDir}/${startMs}-${utteranceId}.wav`;
    const writer = new WavWriter(path.join(this.sessionDir!, relFile));
    const decoder = new prism.opus.Decoder({ rate: 48_000, channels: 2, frameSize: 960 });
    const meter = new VoiceActivityMeter({ floorDbfs: this.config.captureNoiseFloorDbfs });
    const speaker = this.ensureSpeaker(userId);
    speaker.speaking = true;
    const active: ActiveUtterance = {
      userId,
      utteranceId,
      displayName: speaker.displayName,
      startMs,
      relFile,
      writer,
      meter,
      stream,
      decoder,
      stopReason: null,
      ended: false,
      discard: false,
      failures: 0,
      promise: Promise.resolve()
    };
    this.active.set(userId, active);

    void this.discord.memberName(userId).then((name) => {
      active.displayName = name;
      speaker.displayName = name;
    });

    active.promise = this.runUtterance(active)
      .catch((error) => {
        this.error = error instanceof Error ? error.message : String(error);
        this.emit("captureError", this.error);
      })
      .finally(() => {
        speaker.speaking = false;
        this.active.delete(userId);
      });
  }

  private ensureSpeaker(userId: string): SpeakerState {
    let speaker = this.speakers.get(userId);
    if (!speaker) {
      speaker = {
        displayName: userId,
        speaking: false,
        capturedMs: 0,
        voicedMs: 0,
        utteranceCount: 0,
        silentCount: 0,
        bytes: 0,
        lastUtteranceAtMs: null,
        decryptionFailures: 0
      };
      this.speakers.set(userId, speaker);
      this.discord.memberName(userId).then((name) => {
        speaker!.displayName = name;
      }).catch(() => undefined);
    }
    return speaker;
  }

  private async runUtterance(active: ActiveUtterance): Promise<void> {
    const { stream, decoder, writer, userId } = active;
    const onError = (error: Error) => {
      if (active.stopReason || this.stopReason) return;
      const message = error.message || String(error);
      active.failures += 1;
      this.decryptionFailures += 1;
      this.lastDecryptionAtMs = Date.now();
      this.speakers.get(userId)!.decryptionFailures += 1;
      this.addWarning(`Audio error for ${userId}: ${message}`);
      this.emit("decryptionFailure", { userId, message });
    };
    stream.on("error", onError);
    decoder.on("error", onError);
    stream.pipe(decoder);
    let streamEnd: StreamEnd = "silence";
    try {
      for await (const chunk of decoder as AsyncIterable<Buffer>) {
        active.meter.write(chunk);
        await writer.write(chunk);
        this.lastPacketAtMs = Date.now();
      }
    } catch (error) {
      onError(error as Error);
      streamEnd = "error";
    } finally {
      active.ended = true;
      if (active.discard) {
        try {
          writer.abort();
        } catch {
          // already closed
        }
        await fsp.rm(path.join(this.sessionDir!, active.relFile), { force: true }).catch(() => undefined);
      }
      if (!active.discard) {
      if (active.stopReason === "stop" || this.stopReason === "stop") streamEnd = "stop";
      else if (active.stopReason === "manual") streamEnd = "manual";
      const result = await writer.finalize().catch(() => ({ bytes: 0, dataBytes: 0, durationMs: 0 }));
      const stats = active.meter.stats();
      const silent = isSilentUtterance(stats, { minVoicedMs: this.config.captureMinVoicedMs });
      let trim = { trimmedMs: 0, durationMs: result.durationMs, dataBytes: result.dataBytes };
      if (result.dataBytes > 0) {
        trim = await trimWavTrailingSilence(path.join(this.sessionDir!, active.relFile), {
          thresholdDbfs: this.config.captureNoiseFloorDbfs,
          paddingMs: this.config.captureTrimPaddingMs
        }).catch(() => trim);
      }
      const durationMs = result.dataBytes > 0 ? trim.durationMs : 0;
      const bytes = result.dataBytes > 0 ? 44 + trim.dataBytes : result.bytes;
      const endMs = active.startMs + durationMs;
      const record: DiscordUtterance = {
        schema: "tablerecords.discord-utterance/v1",
        sessionId: this.testId ?? this.sessionId ?? "unknown",
        utteranceId: active.utteranceId,
        discordUserId: userId,
        displayName: active.displayName,
        file: active.relFile,
        startMs: active.startMs,
        endMs,
        durationMs,
        sampleRate: 48_000,
        channels: 2,
        format: "wav",
        encoding: "pcm_s16le",
        bytes,
        streamEnd,
        decryptionFailures: active.failures,
        voicedMs: stats.voicedMs,
        peakDbfs: stats.peakDbfs,
        rmsDbfs: stats.rmsDbfs,
        silent,
        trimmedMs: trim.trimmedMs,
        createdAtMs: Date.now()
      };
      const manifest = path.join(this.sessionDir!, "discord", "manifest.jsonl");
      await appendJsonl(manifest, record);
      const speaker = this.speakers.get(userId);
      if (speaker) {
        speaker.utteranceCount += 1;
        speaker.bytes += bytes;
        speaker.capturedMs += durationMs;
        speaker.voicedMs += stats.voicedMs;
        speaker.lastUtteranceAtMs = record.createdAtMs;
        speaker.decryptionFailures += active.failures;
        if (silent) speaker.silentCount += 1;
      }
      this.totalUtteranceCount += 1;
      this.totalBytes += bytes;
      if (silent) this.silentUtteranceCount += 1;
      this.emit("utterance", record);
      }
    }
  }

  private onConnectionState(connection: VoiceConnection): void {
    if (this.state !== "recording" && this.state !== "stopping") return;
    if (connection.state.status === VoiceConnectionStatus.Disconnected) {
      this.reconnectCount += 1;
      this.addWarning("Voice connection disconnected during capture.");
      this.emit("captureWarning", "Voice connection disconnected during capture.");
      if (this.reconnectCount <= 1) {
        try {
          connection.rejoin();
        } catch (error) {
          this.error = `Voice reconnect failed: ${error instanceof Error ? error.message : String(error)}`;
          this.emit("captureError", this.error);
        }
      }
    }
    if (connection.state.status === VoiceConnectionStatus.Destroyed) {
      this.error = "Voice connection was destroyed during capture.";
      this.emit("captureError", this.error);
    }
  }

  private health(): CaptureHealth {
    if (this.state === "error") return "error";
    if (this.state !== "recording" && this.state !== "stopping") return "ok";
    if (this.discord.voiceStatus().state !== "ready") return "error";
    if (this.lastDecryptionAtMs && Date.now() - this.lastDecryptionAtMs < 60_000) return "error";
    if (
      this.speakingEventCount > 0 &&
      this.totalBytes === 0 &&
      this.firstSpeakingAtMs != null &&
      Date.now() - this.firstSpeakingAtMs > 30_000
    ) {
      return "error";
    }
    if (this.reconnectCount > 0) return "warning";
    if (this.lastDecryptionAtMs) return "warning";
    if (this.totalUtteranceCount >= 20 && this.silentUtteranceCount / this.totalUtteranceCount >= 0.8) {
      return "warning";
    }
    if (
      this.startedAtMs &&
      Date.now() - this.startedAtMs > 10 * 60_000 &&
      this.totalUtteranceCount === 0 &&
      this.discord.voiceStatus().state === "ready"
    ) {
      return "warning";
    }
    return "ok";
  }

  diagnostics(): CaptureDiagnostics {
    const now = Date.now();
    const speakers: CaptureSpeaker[] = [...this.speakers.entries()].map(([discordUserId, speaker]) => ({
      discordUserId,
      displayName: speaker.displayName,
      speaking: speaker.speaking,
      capturedMs: speaker.capturedMs,
      voicedMs: speaker.voicedMs,
      utteranceCount: speaker.utteranceCount,
      silentCount: speaker.silentCount,
      bytes: speaker.bytes,
      lastUtteranceAtMs: speaker.lastUtteranceAtMs,
      decryptionFailures: speaker.decryptionFailures
    }));
    return {
      state: this.state,
      sessionId: this.sessionId,
      testId: this.testId,
      startedAtMs: this.startedAtMs,
      elapsedMs: this.startedAtMs ? now - this.startedAtMs : 0,
      health: this.health(),
      utteranceCount: this.totalUtteranceCount,
      silentUtteranceCount: this.silentUtteranceCount,
      totalBytes: this.totalBytes,
      decryptionFailures: this.decryptionFailures,
      reconnectCount: this.reconnectCount,
      speakingEventCount: this.speakingEventCount,
      lastPacketAtMs: this.lastPacketAtMs,
      speakers,
      warnings: [...this.warnings].slice(-20),
      error: this.error
    };
  }

  async stop(reason: "stop" | "manual" = "stop"): Promise<CaptureDiagnostics> {
    if (!this.isActive()) return this.diagnostics();
    this.state = "stopping";
    this.stopReason = reason;
    const connection = this.discord.voiceConnection;
    if (connection && this.speakingHandler) {
      connection.receiver.speaking.off("start", this.speakingHandler);
      this.speakingHandler = null;
    }
    if (connection && this.connectionStateHandler) {
      connection.off("stateChange", this.connectionStateHandler);
      this.connectionStateHandler = null;
    }
    for (const active of this.active.values()) {
      active.stopReason = reason === "stop" ? "stop" : "manual";
      try {
        active.stream.destroy();
        active.decoder.destroy();
      } catch {
        // ignore
      }
    }
    const waits = [...this.active.values()].map((active) => active.promise.catch(() => undefined));
    if (waits.length > 0) {
      await Promise.race([
        Promise.allSettled(waits),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
    }
    this.state = "idle";
    this.emit("state");
    return this.diagnostics();
  }

  /** Synchronous best-effort shutdown used on process exit. */
  abort(): void {
    for (const active of this.active.values()) {
      active.stopReason = "stop";
      try {
        active.stream.destroy();
        active.writer.abort();
      } catch {
        // ignore
      }
    }
    this.active.clear();
    this.state = "idle";
  }
}
