export type SessionStatus =
  | "draft"
  | "joining"
  | "recording"
  | "stopping"
  | "captured"
  | "processing"
  | "ready"
  | "error";

export type PersonRole = "gm" | "player" | "observer";
export type ConsentStatus = "assumed" | "opted_in" | "opted_out";
export type ConsentSource = "assumed" | "foundry" | "gm" | "dashboard";
export type MarkerKind = "scene" | "break" | "combat" | "note" | "other";
export type LlmProvider = "ollama" | "llamacpp" | "deepseek" | "local";
export type LlmThinkingEffort = "off" | "low" | "medium" | "high";
export type JobType = "transcribe" | "merge" | "render" | "run_all" | "context";
export type JobStatus = "queued" | "running" | "done" | "failed" | "cancelled";
export type JobStage = "transcribe" | "merge" | "render" | "context" | "queue";

export interface SystemRef {
  id: string;
  version: string | null;
}

export interface WorldRef {
  id: string;
  title: string;
}

export interface SessionConsent {
  confirmed: boolean;
  confirmedAtMs: number | null;
  confirmedBy: string | null;
  participants: string[];
  notes: string;
  /** How consent was established for this session. */
  method?: "foundry" | "gm_tick";
  noticeVersion?: string;
  /** When the Foundry player prompt was sent for this world. */
  promptedAtMs?: number;
}

export interface SessionRecordingStats {
  utteranceCount: number;
  totalBytes: number;
  decryptionFailures: number;
  reconnectCount: number;
  nodeVersion: string;
  discordJsVersion: string;
  voiceVersion: string;
  daveyVersion: string;
}

export interface SessionFiles {
  manifest: string;
  foundryExport: string;
  transcript: string;
  timeline: string;
  outputsDir: string;
}

export interface SessionRecord {
  schema: "tablerecords.session/v1";
  sessionId: string;
  title: string;
  status: SessionStatus;
  archived?: boolean;
  /** Free-form game/campaign label used to group sessions; defaults to the world title. */
  campaign?: string;
  system: SystemRef;
  world: WorldRef;
  foundryVersion: string | null;
  timeZone: string;
  createdAtMs: number;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  guild: { id: string; name: string } | null;
  voiceChannel: { id: string; name: string } | null;
  consent: SessionConsent;
  merge: {
    filterMarginMs: number;
    rollContextBeforeMs?: number;
    rollContextAfterMs?: number;
    /** Same-speaker gaps up to this are joined into one speech event. */
    stitchGapMs?: number;
  };
  recording: SessionRecordingStats;
  files: SessionFiles;
  notes?: string;
}

export interface Person {
  personId: string;
  role: PersonRole;
  discordUserId: string | null;
  discordName: string | null;
  foundryUserId: string | null;
  foundryUserName: string | null;
  character: string | null;
  aliases: string[];
  consent: boolean;
  /** Defaults to "assumed": consent is assumed unless the player opted out. */
  consentStatus?: ConsentStatus;
  consentSource?: ConsentSource;
  consentUpdatedAtMs?: number;
}

export interface PeopleFile {
  schema: "tablerecords.people/v1";
  sessionId: string;
  people: Person[];
}

export interface ConsentPromptRecord {
  worldId: string;
  promptedAtMs: number;
  noticeVersion: string;
  promptedBy: string | null;
}

export interface ConsentPreference {
  worldId: string;
  foundryUserId: string;
  displayName: string | null;
  optOut: boolean;
  noticeVersion: string | null;
  updatedAtMs: number;
}

export interface RosterPerson {
  profileId: string;
  worldId: string;
  discordUserId: string;
  discordName: string | null;
  foundryUserId: string | null;
  foundryUserName: string | null;
  character: string | null;
  aliases: string[];
  role: PersonRole;
  updatedAtMs: number;
}

export type StreamEnd = "silence" | "manual" | "stop" | "error";

export interface DiscordUtterance {
  schema: "tablerecords.discord-utterance/v1";
  sessionId: string;
  utteranceId: string;
  discordUserId: string;
  displayName: string;
  file: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  sampleRate: number;
  channels: number;
  format: "wav";
  encoding: "pcm_s16le";
  bytes: number;
  streamEnd: StreamEnd;
  decryptionFailures: number;
  /** Voiced energy measured at capture time; absent on older manifests. */
  voicedMs?: number;
  peakDbfs?: number;
  rmsDbfs?: number;
  /** No usable speech energy: keep the file for review, skip STT. */
  silent?: boolean;
  /** Trailing silence removed after the last voiced frame. */
  trimmedMs?: number;
  createdAtMs: number;
}

export interface SttJob {
  schema: "tablerecords.stt-job/v1";
  sttJobId: string;
  batchJobId: string;
  sessionId: string;
  utteranceId: string;
  audioFile: string;
  discordUserId: string;
  speakerLabel: string;
  character: string | null;
  language: string;
  startMs: number;
  endMs: number;
  model: string;
  device: string;
  computeType: string;
  beamSize: number;
  wordTimestamps: boolean;
  vadFilter: boolean;
  noSpeechThreshold?: number;
  logProbThreshold?: number;
  compressionRatioThreshold?: number;
  prompt?: string;
  hotwords?: string[];
}

export interface TranscriptWord {
  word: string;
  startMs: number;
  endMs: number;
  probability: number | null;
}

export interface TranscriptRecord {
  schema: "tablerecords.transcript/v1";
  sessionId: string;
  utteranceId: string;
  sttJobId: string;
  batchJobId: string;
  discordUserId: string;
  speaker: string;
  character: string | null;
  text: string;
  rawText: string;
  corrections: Array<{ from: string; to: string; rule: string }>;
  startMs: number;
  endMs: number;
  words: TranscriptWord[];
  stt: {
    engine: string;
    engineVersion: string;
    model: string;
    device: string;
    computeType: string;
    language: string;
    languageProbability: number | null;
    avgLogprob: number | null;
    noSpeechProb: number | null;
  };
  flags: string[];
  /** Present when several captured clips were stitched into this record. */
  utteranceIds?: string[];
  createdAtMs: number;
}

export interface FoundryAuthor {
  id: string | null;
  name: string | null;
}

export interface FoundrySpeaker {
  scene?: string | null;
  token?: string | null;
  actor?: string | null;
  alias?: string | null;
}

export interface FoundryMessage {
  messageId: string;
  timestampMs: number;
  author?: FoundryAuthor;
  speaker?: FoundrySpeaker;
  speakerName?: string | null;
  actorId?: string | null;
  actorName?: string | null;
  tokenName?: string | null;
  style?: number;
  type?: string;
  flavor?: string | null;
  content?: string | null;
  whisper?: string[];
  blind?: boolean;
  flags?: Record<string, unknown>;
  rolls?: unknown[];
  rollsRaw?: unknown[];
  rollParseError?: string | null;
  [key: string]: unknown;
}

export interface FoundryExport {
  schema: "tablerecords.foundry-export/v1";
  exportedAtMs: number;
  exportedBy?: { id: string | null; name: string | null };
  foundryVersion: string | null;
  world: WorldRef;
  system: SystemRef;
  messages: FoundryMessage[];
  warnings?: Array<{ code: string; message: string; messageId?: string }>;
}

export interface FoundryEvent {
  schema: "tablerecords.foundry-event/v1";
  sessionId: string;
  eventId: string;
  type: "roll" | "chat";
  timestampMs: number;
  author: { id: string | null; name: string | null };
  speaker: {
    alias: string | null;
    actorId: string | null;
    actorName: string | null;
    tokenName: string | null;
  };
  system: string;
  systemVersion: string | null;
  flavor: string | null;
  contentText: string;
  visibility: { whisper: string[]; blind: boolean };
  /** Message flags retained so private or generated posts can be excluded from player drafts. */
  flags?: Record<string, unknown>;
  rolls: unknown[];
  source: { kind: "macro" | "module"; file: string };
}

export interface FoundryImportSummary {
  schema: "tablerecords.foundry-import-summary/v1";
  sessionId: string;
  importedAtMs: number;
  sourceFile: string;
  foundryVersion: string | null;
  world: WorldRef;
  system: SystemRef;
  messageCount: number;
  rollMessageCount: number;
  rollCount: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
  outOfWindowCount: number;
  warnings: Array<{ code: string; message: string }>;
}

export interface TimelineActor {
  discordUserId: string | null;
  foundryUserId: string | null;
  name: string;
  character: string | null;
  role: PersonRole;
}

export interface VoiceContextLine {
  utteranceId: string;
  tsMs: number;
  endMs: number;
  speaker: string;
  character: string | null;
  text: string;
}

export interface MentalNote {
  text: string;
  source: "spoken" | "manual";
  speaker?: string;
  character?: string | null;
  markerId?: string;
}

export interface SessionMentalNote extends MentalNote {
  tsMs: number;
}

export interface ReviewAudioFile {
  name: string;
  label: string;
  kind: "master" | "speaker";
  speakerId?: string;
  speakerName?: string;
  durationMs: number;
  sizeBytes: number;
}

export interface ReviewAudioManifest {
  schema: "tablerecords.review-audio/v1";
  sessionId: string;
  generatedAtMs: number;
  durationMs: number;
  files: ReviewAudioFile[];
}

export interface TimelineEvent {
  schema: "tablerecords.timeline/v1";
  sessionId: string;
  seq: number;
  tsMs: number;
  type: "speech" | "roll" | "chat" | "marker";
  sourceId: string;
  actor?: TimelineActor;
  text?: string;
  speech?: { utteranceId: string; endMs: number; flags: string[] };
  mentalNote?: MentalNote;
  roll?: {
    system: string;
    formula: string;
    summary: string;
    total: number | null;
    ffg?: Record<string, number>;
    raw: unknown;
    rolls?: Array<{
      formula: string;
      total: number | null;
      summary: string;
      ffg: Record<string, number> | null;
      raw: unknown;
    }>;
    voiceContext?: {
      beforeMs: number;
      afterMs: number;
      before: VoiceContextLine[];
      after: VoiceContextLine[];
      nearestSpeechGapMs: number | null;
      confidence: "high" | "medium" | "low" | "none";
    };
  };
  chat?: { contentText: string; whisper: string[]; blind: boolean };
  marker?: { kind: MarkerKind; label: string; mentalNote?: boolean };
  source: "transcript" | "foundry" | "marker";
}

export interface Marker {
  schema: "tablerecords.marker/v1";
  markerId: string;
  sessionId: string;
  tsMs: number;
  kind: MarkerKind;
  label: string;
  mentalNote?: boolean;
  createdAtMs: number;
}

export interface JobProgress {
  phase: JobStage;
  completed: number;
  total: number;
  percent: number;
  /** Human-readable current step, e.g. "Transcribing 412/4947 · Alice". */
  detail?: string;
  /** 1-based position while queued; absent once running. */
  queuePosition?: number;
  stageIndex?: number;
  stageTotal?: number;
  elapsedMs?: number;
  etaMs?: number | null;
}

export interface Job {
  schema: "tablerecords.job/v1";
  jobId: string;
  sessionId: string;
  type: JobType;
  status: JobStatus;
  progress: JobProgress;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  logFile: string;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export interface FoundryWorld {
  id: string;
  title: string;
  system: string;
  systemVersion: string | null;
  foundryVersion: string | null;
  path: string;
}

export interface FoundryLiveScene {
  id: string | null;
  name: string | null;
}

export interface FoundryLiveCombat {
  id: string;
  name: string;
  round: number | null;
  active: boolean;
}

export interface FoundryLiveUser {
  id: string;
  name: string;
  isGM: boolean;
  characterId: string | null;
  characterName: string | null;
}

export interface FoundryLiveActor {
  id: string;
  name: string;
  type: string;
  hasPlayerOwner: boolean;
}

export interface FoundryLiveRoster {
  users: FoundryLiveUser[];
  actors: FoundryLiveActor[];
}

export interface FoundryLiveState {
  schema: "tablerecords.foundry-live-state/v1";
  sessionId: string;
  lastSeenAtMs: number;
  moduleVersion: string | null;
  foundryVersion: string | null;
  world: WorldRef;
  system: SystemRef;
  scene: FoundryLiveScene | null;
  combat: FoundryLiveCombat | null;
  paused: boolean;
  roster: FoundryLiveRoster | null;
  messageCount: number;
  updatedAtMs: number;
}

export interface FoundryLiveStatus {
  enabled: boolean;
  markers: boolean;
  connected: boolean;
  lastSeenAtMs: number | null;
  moduleVersion: string | null;
  foundryVersion: string | null;
  world: WorldRef | null;
  system: SystemRef | null;
  scene: FoundryLiveScene | null;
  combat: FoundryLiveCombat | null;
  paused: boolean | null;
  roster: FoundryLiveRoster | null;
  targetSessionId: string | null;
  eventCount: number;
  lastError: string | null;
}

export type LlmSummaryPreset = "recap" | "gm-prep" | "clue-board" | "rules";
export type LlmSummaryScope = "recent" | "scene" | "session";

export interface LlmSummaryWindow {
  seconds: number;
  startMs: number;
  endMs: number;
  label: string;
}

export interface LlmSummaryRecord {
  schema: "tablerecords.llm-summary/v2";
  summaryId: string;
  sessionId: string;
  provider: LlmProvider;
  model: string;
  preset: LlmSummaryPreset;
  scope: LlmSummaryScope;
  window: LlmSummaryWindow;
  promptVersion: string;
  briefChars: number;
  estimatedTokens: number;
  trimmed: boolean;
  portionsTrimmed?: number;
  ledgerChars?: number;
  notesChars?: number;
  coverage?: { checked: number; missing: string[]; repaired: number };
  chunks: number;
  summary: string;
  structured: unknown | null;
  elapsedMs: number;
  createdAtMs: number;
}
