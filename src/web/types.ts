export interface BotStatus {
  configured: boolean;
  state: string;
  userId: string | null;
  username: string | null;
  displayName?: string | null;
  activity?: string | null;
  gatewayPingMs: number | null;
  error: string | null;
}

export interface VoiceStatus {
  state: string;
  guildId: string | null;
  guildName: string | null;
  channelId: string | null;
  channelName: string | null;
  privacyCode: string | null;
  daveEnabled: boolean;
  error: string | null;
}

export interface Speaker {
  discordUserId: string;
  displayName: string;
  character?: string | null;
  speaking: boolean;
  capturedMs: number;
  voicedMs?: number;
  utteranceCount: number;
  silentCount?: number;
  bytes: number;
  lastUtteranceAtMs: number | null;
  decryptionFailures: number;
}

export interface Capture {
  state: string;
  sessionId: string | null;
  testId: string | null;
  startedAtMs: number | null;
  elapsedMs: number;
  health: string;
  utteranceCount: number;
  silentUtteranceCount?: number;
  totalBytes: number;
  decryptionFailures: number;
  reconnectCount: number;
  speakingEventCount: number;
  lastPacketAtMs: number | null;
  speakers: Speaker[];
  warnings: string[];
  error: string | null;
}

export interface JobProgress {
  phase: string;
  completed: number;
  total: number;
  percent: number;
  detail?: string;
  queuePosition?: number;
  stageIndex?: number;
  stageTotal?: number;
  elapsedMs?: number;
  etaMs?: number | null;
}

export interface ActiveJob {
  jobId: string;
  sessionId: string;
  type: string;
  status: string;
  progress: JobProgress;
  startedAtMs: number | null;
}

export interface Status {
  generatedAtMs: number;
  server: { version: string; startedAtMs: number; uptimeMs: number };
  bot: BotStatus;
  voice: VoiceStatus;
  capture: Capture;
  session: {
    currentId: string | null;
    title: string | null;
    system: string | null;
    systemLabel: string | null;
    worldId: string | null;
    status: string | null;
  };
  foundry: {
    imported: boolean;
    messageCount: number;
    rollCount: number;
    importedAtMs: number | null;
    warnings: string[];
    live: FoundryLiveStatus;
  };
  jobs: { queued: number; running: number; failed: number; active: ActiveJob | null };
  stt: { engine: "faster-whisper" | "parakeet"; available: boolean; device: string; model: string; modelPresent: boolean; state: string; error: string | null };
  disk: { freeBytes: number | null };
  warnings: Array<{ code: string; message: string }>;
}

export interface Person {
  personId: string;
  role: "gm" | "player" | "observer";
  discordUserId: string | null;
  discordName: string | null;
  foundryUserId: string | null;
  foundryUserName: string | null;
  character: string | null;
  aliases: string[];
  consent: boolean;
  consentStatus?: "assumed" | "opted_in" | "opted_out";
  consentSource?: "assumed" | "foundry" | "gm" | "dashboard";
  consentUpdatedAtMs?: number;
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
  role: "gm" | "player" | "observer";
  updatedAtMs: number;
}

export interface VoiceMember {
  userId: string;
  displayName: string;
  username: string;
  isBot: boolean;
}

export interface Marker {
  markerId: string;
  sessionId: string;
  tsMs: number;
  kind: string;
  label: string;
  mentalNote?: boolean;
  createdAtMs: number;
}

export interface SessionRecord {
  schema: string;
  sessionId: string;
  title: string;
  status: string;
  archived?: boolean;
  campaign?: string;
  system: { id: string; version: string | null };
  world: { id: string; title: string };
  foundryVersion: string | null;
  timeZone: string;
  createdAtMs: number;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  guild: { id: string; name: string } | null;
  voiceChannel: { id: string; name: string } | null;
  consent: {
    confirmed: boolean;
    confirmedAtMs: number | null;
    confirmedBy: string | null;
    participants: string[];
    notes: string;
    method?: "foundry" | "gm_tick";
    noticeVersion?: string;
    promptedAtMs?: number;
  };
  merge: {
    filterMarginMs: number;
    rollContextBeforeMs?: number;
    rollContextAfterMs?: number;
    stitchGapMs?: number;
  };
  recording: {
    utteranceCount: number;
    totalBytes: number;
    decryptionFailures: number;
    reconnectCount: number;
  };
  notes?: string;
}

export interface FoundryImportSummary {
  messageCount: number;
  rollMessageCount: number;
  rollCount: number;
  importedAtMs: number;
  firstTimestampMs: number | null;
  lastTimestampMs: number | null;
  outOfWindowCount: number;
  system: { id: string; version: string | null };
  world: { id: string; title: string };
  warnings: Array<{ code: string; message: string }>;
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
  sessionId: string;
  lastSeenAtMs: number;
  moduleVersion: string | null;
  foundryVersion: string | null;
  world: { id: string; title: string };
  system: { id: string; version: string | null };
  scene: { id: string | null; name: string | null } | null;
  combat: { id: string; name: string; round: number | null; active: boolean } | null;
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
  world: { id: string; title: string } | null;
  system: { id: string; version: string | null } | null;
  scene: { id: string | null; name: string | null } | null;
  combat: { id: string; name: string; round: number | null; active: boolean } | null;
  paused: boolean | null;
  roster: FoundryLiveRoster | null;
  targetSessionId: string | null;
  eventCount: number;
  lastError: string | null;
}

export type LlmProvider = "ollama" | "llamacpp" | "deepseek" | "local";
export type LlmThinkingEffort = "off" | "low" | "medium" | "high";
export type LlmSummaryPreset = "recap" | "gm-prep" | "clue-board" | "rules";
export type LlmSummaryScope = "recent" | "scene" | "session";

export interface LlmStatus {
  enabled: boolean;
  configured: boolean;
  provider: LlmProvider;
  baseUrl: string | null;
  model: string | null;
  timeoutMs: number;
  localOnly: boolean;
  cloudEnabled: boolean;
  apiKeyConfigured: boolean;
  maxInputChars: number;
  contextTokens: number;
  gpuLayers: number | null;
  llamacppNcpuMoe: number;
  llamacppKvCache: "f16" | "q8_0" | "q4_0";
  llamacppFlashAttn: boolean;
  thinkingEffort: LlmThinkingEffort;
}

export interface LlmModelInfo {
  id: string;
  name: string;
  sizeBytes?: number;
}

export interface LlmConnectionTest {
  ok: true;
  provider: LlmProvider;
  latencyMs: number;
  models: number;
}

export interface LlmSummaryResult {
  schema: string;
  summaryId: string;
  sessionId: string;
  provider: LlmProvider;
  model: string;
  preset: LlmSummaryPreset;
  scope: LlmSummaryScope;
  window: { seconds: number; startMs: number; endMs: number; label: string };
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

export interface ReviewAudioFile {
  name: string;
  label: string;
  kind: "master" | "speaker";
  speakerId?: string;
  speakerName?: string;
  durationMs: number;
  sizeBytes: number;
}

export interface SessionDetail {
  session: SessionRecord;
  people: Person[];
  markers: Marker[];
  mentalNotes: Array<{
    tsMs: number;
    text: string;
    source: "spoken" | "manual";
    speaker?: string;
    character?: string | null;
    markerId?: string;
  }>;
  reviewAudio: ReviewAudioFile[];
  utterances: Array<{
    utteranceId: string;
    discordUserId: string;
    displayName: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    bytes: number;
    words: number;
  }>;
  counts: {
    utterances: number;
    audioBytes: number;
    transcriptRecords: number;
    foundryEvents: number;
    timelineEvents: number;
    outputs: number;
  };
  foundrySummary: FoundryImportSummary | null;
  foundryLive: FoundryLiveState | null;
  audio: {
    state: "available" | "compacted" | "removed";
    clipCount: number;
    bytes: number;
    compactedAtMs?: number;
    removedAtMs?: number;
  };
  outputsStale: boolean;
  outputsStaleReason: string | null;
  consentPrompt: {
    worldId: string;
    promptedAtMs: number;
    noticeVersion: string;
    promptedBy: string | null;
  } | null;
}

export interface SessionStorageReport {
  totalBytes: number;
  totalFiles: number;
  categories: Array<{ id: string; label: string; bytes: number; files: number }>;
  audio: SessionDetail["audio"];
}

export interface PeopleDirectoryAppearance {
  sessionId: string;
  title: string;
  campaign: string;
  worldId: string;
  createdAtMs: number;
  role: Person["role"];
  character: string | null;
  consentStatus: "assumed" | "opted_in" | "opted_out";
  consentSource?: string;
}

export interface PeopleDirectoryEntry {
  key: string;
  discordUserId: string | null;
  discordName: string | null;
  foundryUserId: string | null;
  foundryUserName: string | null;
  characters: string[];
  roles: Array<Person["role"]>;
  consent: "assumed" | "opted_in" | "opted_out";
  games: string[];
  appearances: PeopleDirectoryAppearance[];
  profiles: RosterPerson[];
  lastActivityMs: number;
}

export interface CaptureTestResult {
  testId: string;
  utteranceCount: number;
  totalBytes: number;
  decryptionFailures: number;
  speakers: Array<{ displayName: string; utteranceCount: number; bytes: number }>;
  warnings: string[];
  health: string;
}

export interface SessionSummary {
  sessionId: string;
  title: string;
  status: string;
  archived?: boolean;
  campaign: string;
  system: { id: string; version: string | null };
  world: { id: string; title: string };
  createdAtMs: number;
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  counts: SessionDetail["counts"] | null;
  foundryImported: boolean;
}

export interface Job {
  schema: string;
  jobId: string;
  sessionId: string;
  type: string;
  status: string;
  progress: JobProgress;
  request: Record<string, unknown>;
  result: Record<string, unknown> | null;
  error: { code: string; message: string } | null;
  createdAtMs: number;
  startedAtMs: number | null;
  finishedAtMs: number | null;
}

export interface OutputFile {
  name: string;
  sizeBytes: number;
  modifiedAtMs: number;
  previewable: boolean;
}

export interface World {
  id: string;
  title: string;
  system: string;
  systemVersion: string | null;
  foundryVersion: string | null;
  path: string;
}

export interface Guild {
  id: string;
  name: string;
}

export interface VoiceChannel {
  id: string;
  name: string;
  parentName: string | null;
  memberCount: number;
  userLimit: number;
  permissions: { viewChannel: boolean; connect: boolean; speak: boolean };
}

export interface LlmProgress {
  progressId: string;
  sessionId: string;
  phase: "preparing" | "chunk" | "reduce" | "final" | "done";
  completed: number;
  total: number;
  label: string;
}

export interface LlamaCppStatus {
  state: "stopped" | "starting" | "running" | "external" | "error";
  managed: boolean;
  healthy: boolean;
  restartRequired: boolean;
  pid: number | null;
  port: number;
  exe: string;
  modelPath: string | null;
  autostart: boolean;
  lastError: string | null;
  logTail: string[];
}

export interface SettingsPayload {
  settings: {
    foundryDataPath: string | null;
    defaultGuildId: string | null;
    defaultVoiceChannelId: string | null;
    discordBotName: string;
    discordActivityType: "playing" | "listening" | "watching" | "competing";
    discordActivityText: string;
    discordActivityDynamic: boolean;
    sttEngine: "faster-whisper" | "parakeet";
    sttModel: string;
    sttDevice: string;
    sttComputeType: string;
    sttLanguage: string;
    sttBeamSize: number;
    sttVadFilter: boolean;
    sttNoSpeechThreshold: number;
    sttLogProbThreshold: number;
    sttCompressionRatioThreshold: number;
    sttPromptExtra: string;
    sttHotwordsExtra: string;
    parakeetPath: string;
    parakeetModel: string;
    parakeetDevice: string;
    parakeetConcurrency: number;
    rollContextBeforeMs: number;
    rollContextAfterMs: number;
    recentContextSeconds: number;
    sttModelDir: string;
    captureTestMaxSeconds: number;
  };
  llm: LlmStatus;
  llamacpp: LlamaCppStatus;
  foundryBridge: {
    token: string;
    tokenManagedByEnv: boolean;
    status: FoundryLiveStatus;
  };
  env: {
    port: number;
    host: string;
    projectRoot: string;
    discordTokenConfigured: boolean;
    discordClientId: string | null;
    dashboardTokenConfigured: boolean;
    pythonPath: string;
    sessionsDir: string;
    dataDir: string;
    timeZone: string;
    webBuildPresent: boolean;
    version: string;
  };
}

export interface HealthCheck {
  id: string;
  label: string;
  status: string;
  detail: string;
  hint?: string;
}

export interface RecentContextResult {
  schema: string;
  sessionId: string;
  window: { seconds: number; startMs: number; endMs: number; label: string };
  generatedAtMs: number;
  counts: {
    events: number;
    speech: number;
    rolls: number;
    chat: number;
    markers: number;
    mentalNotes: number;
    rollsWithVoiceContext: number;
    optedOut: number;
  };
  transcription: {
    requested: boolean;
    candidates: number;
    transcribed: number;
    alreadyPresent: number;
    failed: number;
    skippedSilent?: number;
    skippedReason?: string;
    errors: string[];
  };
  markdown: string;
}
