import fsp from "node:fs/promises";
import path from "node:path";
import type {
  ConsentPreference,
  ConsentPromptRecord,
  ConsentSource,
  ConsentStatus,
  DiscordUtterance,
  FoundryEvent,
  FoundryImportSummary,
  FoundryLiveState,
  FoundryWorld,
  Marker,
  MarkerKind,
  PeopleFile,
  Person,
  PersonRole,
  ReviewAudioFile,
  ReviewAudioManifest,
  SessionConsent,
  SessionMentalNote,
  SessionRecord,
  SessionStatus,
  TranscriptRecord
} from "../core/types.js";
import {
  CONSENT_NOTICE_TEXT,
  CONSENT_NOTICE_VERSION,
  displayPerson,
  normalizeConsentStatus,
  personConsentStatus,
  personIsOptedOut
} from "../core/consent.js";
import { localDateKey, makeSessionId, newMarkerId, newPersonId } from "../core/ids.js";
import { EXCLUDED_TRANSCRIPT_FLAGS } from "../core/merge.js";
import { outputFreshness } from "./freshness.js";
import { detectSpokenMentalNote } from "../core/notes.js";
import {
  appendJsonl,
  ensureDir,
  isInside,
  pathExists,
  readJson,
  readJsonl,
  writeJsonAtomic,
  writeJsonl,
  writeFileAtomic
} from "../core/paths.js";
import { inspectWav, wavHeader } from "../core/wav.js";
import { readAudioStorage } from "./audioStorage.js";
import type { AppConfig } from "./config.js";
import type { Store } from "./store.js";

export interface CreateSessionInput {
  title?: string;
  date?: string;
  campaign?: string;
  world?: FoundryWorld;
  guild?: { id: string; name: string } | null;
  voiceChannel?: { id: string; name: string } | null;
  participants?: Array<{
    discordUserId?: string | null;
    discordName?: string | null;
    character?: string | null;
    role?: PersonRole;
    consent?: boolean;
    consentStatus?: ConsentStatus;
  }>;
  consent?: {
    confirmed?: boolean;
    confirmedBy?: string;
    notes?: string;
    method?: "foundry" | "gm_tick";
    noticeVersion?: string;
  };
  notes?: string;
  timeZone?: string;
}

export interface SessionDetail {
  session: SessionRecord;
  people: Person[];
  markers: Marker[];
  mentalNotes: SessionMentalNote[];
  utterances: Array<{
    utteranceId: string;
    discordUserId: string;
    displayName: string;
    startMs: number;
    endMs: number;
    durationMs: number;
    bytes: number;
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
  reviewAudio: ReviewAudioFile[];
  audio: {
    state: "available" | "compacted" | "removed";
    clipCount: number;
    bytes: number;
    compactedAtMs?: number;
    removedAtMs?: number;
  };
  outputsStale: boolean;
  outputsStaleReason: string | null;
  /** World-scoped Foundry consent prompt, when one has been sent. */
  consentPrompt: ConsentPromptRecord | null;
}

export class SessionError extends Error {
  override name = "SessionError";
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, message: string, statusCode = 400) {
    super(message);
    this.code = code;
    this.statusCode = statusCode;
  }
}

function emptyRecording(): SessionRecord["recording"] {
  return {
    utteranceCount: 0,
    totalBytes: 0,
    decryptionFailures: 0,
    reconnectCount: 0,
    nodeVersion: process.versions.node,
    discordJsVersion: "14.28.0",
    voiceVersion: "0.19.2",
    daveyVersion: "0.1.12"
  };
}

/** Apply a world-scoped Foundry consent preference to one person. */
function applyConsentPreference(person: Person, preference: ConsentPreference): Person {
  const foundryMatch =
    (preference.foundryUserId && person.foundryUserId === preference.foundryUserId) ||
    (!person.foundryUserId &&
      preference.displayName &&
      (person.foundryUserName ?? person.discordName) &&
      (person.foundryUserName ?? person.discordName)!.toLowerCase() === preference.displayName.toLowerCase());
  if (!foundryMatch) return person;
  if (preference.optOut) {
    return {
      ...person,
      consent: false,
      consentStatus: "opted_out",
      consentSource: "foundry",
      consentUpdatedAtMs: preference.updatedAtMs
    };
  }
  // A GM/dashboard opt-out is explicit and must not be silently reversed by a
  // Foundry "continue" response. A prior Foundry opt-out can be cleared.
  if (person.consentStatus === "opted_out" && person.consentSource !== "foundry") return person;
  return {
    ...person,
    consent: true,
    consentStatus: "opted_in",
    consentSource: "foundry",
    consentUpdatedAtMs: preference.updatedAtMs
  };
}

function applyConsentPreferences(people: Person[], preferences: ConsentPreference[]): Person[] {
  if (preferences.length === 0) return people;
  return people.map((person) => preferences.reduce((current, preference) => applyConsentPreference(current, preference), person));
}

function collectMentalNotes(markers: Marker[], transcripts: TranscriptRecord[]): SessionMentalNote[] {
  const notes: SessionMentalNote[] = [];
  for (const marker of markers) {
    if (!marker.mentalNote) continue;
    notes.push({
      tsMs: marker.tsMs,
      text: marker.label || "Mental note",
      source: "manual",
      markerId: marker.markerId
    });
  }
  for (const transcript of transcripts) {
    if (transcript.schema !== "tablerecords.transcript/v1" || !transcript.utteranceId || !transcript.text) continue;
    const flags = Array.isArray(transcript.flags) ? transcript.flags : [];
    if (flags.some((flag) => EXCLUDED_TRANSCRIPT_FLAGS.has(flag))) continue;
    const text = detectSpokenMentalNote(transcript.text);
    if (!text) continue;
    notes.push({
      tsMs: Math.trunc(transcript.startMs),
      text,
      source: "spoken",
      speaker: transcript.speaker,
      character: transcript.character
    });
  }
  notes.sort((a, b) => a.tsMs - b.tsMs);
  const unique: SessionMentalNote[] = [];
  for (const note of notes) {
    const duplicate = unique.some(
      (existing) => existing.text.toLowerCase() === note.text.toLowerCase() && Math.abs(existing.tsMs - note.tsMs) <= 5000
    );
    if (!duplicate) unique.push(note);
  }
  return unique;
}

function newSessionRecord(params: {
  sessionId: string;
  title: string;
  campaign: string;
  world: FoundryWorld;
  guild: { id: string; name: string } | null;
  voiceChannel: { id: string; name: string } | null;
  consent: SessionConsent;
  notes: string;
  timeZone: string;
  nowMs: number;
  config: AppConfig;
}): SessionRecord {
  return {
    schema: "tablerecords.session/v1",
    sessionId: params.sessionId,
    title: params.title,
    status: "draft",
    campaign: params.campaign,
    system: { id: params.world.system, version: params.world.systemVersion },
    world: { id: params.world.id, title: params.world.title },
    foundryVersion: params.world.foundryVersion,
    timeZone: params.timeZone,
    createdAtMs: params.nowMs,
    startedAtMs: null,
    stoppedAtMs: null,
    guild: params.guild,
    voiceChannel: params.voiceChannel,
    consent: params.consent,
    merge: {
      filterMarginMs: 300_000,
      rollContextBeforeMs: params.config.rollContextBeforeMs,
      rollContextAfterMs: params.config.rollContextAfterMs,
      stitchGapMs: params.config.stitchGapMs
    },
    recording: emptyRecording(),
    files: {
      manifest: "discord/manifest.jsonl",
      foundryExport: "foundry/export.json",
      transcript: "stt/transcript.jsonl",
      timeline: "merged/timeline.jsonl",
      outputsDir: "outputs/"
    },
    notes: params.notes
  };
}

export class SessionManager {
  readonly config: AppConfig;
  readonly store: Store;
  private readonly activeSessions = new Set<string>();

  constructor(config: AppConfig, store: Store) {
    this.config = config;
    this.store = store;
  }

  sessionDir(sessionId: string): string {
    if (!/^[a-zA-Z0-9._-]{1,120}$/.test(sessionId)) {
      throw new SessionError("invalid_session_id", "That session ID does not look right. Copy it from Sessions.", 400);
    }
    const dir = path.resolve(this.config.sessionsDir, sessionId);
    if (!isInside(this.config.sessionsDir, dir)) {
      throw new SessionError("path_escape", "Session path escapes the sessions directory", 400);
    }
    return dir;
  }

  async list(): Promise<SessionRecord[]> {
    await ensureDir(this.config.sessionsDir);
    const entries = await fsp.readdir(this.config.sessionsDir, { withFileTypes: true });
    const sessions: SessionRecord[] = [];
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith("_") || entry.name.startsWith(".")) continue;
      const file = path.join(this.config.sessionsDir, entry.name, "session.json");
      const session = await readJson<SessionRecord>(file);
      if (session?.schema === "tablerecords.session/v1") sessions.push(session);
    }
    return sessions.sort((a, b) => b.createdAtMs - a.createdAtMs);
  }

  async get(sessionId: string): Promise<SessionRecord> {
    const session = await readJson<SessionRecord>(path.join(this.sessionDir(sessionId), "session.json"));
    if (!session || session.schema !== "tablerecords.session/v1") {
      throw new SessionError("not_found", `Session not found: ${sessionId}`, 404);
    }
    return session;
  }

  async setArchived(sessionId: string, archived: boolean): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    const next: SessionRecord = { ...session, archived };
    await this.save(next);
    return next;
  }

  async deleteSession(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    if (["joining", "recording", "stopping"].includes(session.status)) {
      throw new SessionError("invalid_state", "Stop the recording before deleting this session", 409);
    }
    if (this.store.listJobs(sessionId).some((job) => job.status === "queued" || job.status === "running")) {
      throw new SessionError("job_active", "Wait for the active processing job before deleting this session", 409);
    }
    const dir = this.sessionDir(sessionId);
    const trashRoot = path.join(this.config.sessionsDir, ".trash");
    await ensureDir(trashRoot);
    const trash = path.join(trashRoot, `${sessionId}-${Date.now()}`);
    await fsp.rename(dir, trash);
    try {
      this.store.deleteSession(sessionId);
    } catch (error) {
      await fsp.rename(trash, dir).catch(() => undefined);
      throw error;
    }
    await fsp.rm(trash, { recursive: true, force: true });
  }

  async detail(sessionId: string): Promise<SessionDetail> {
    const session = await this.get(sessionId);
    const dir = this.sessionDir(sessionId);
    const peopleFile = await readJson<PeopleFile>(path.join(dir, "people.json"));
    const markers = this.store.listMarkers(sessionId);
    const manifest = await readJsonl(path.join(dir, "discord", "manifest.jsonl"));
    const transcript = await readJsonl<TranscriptRecord>(path.join(dir, "stt", "transcript.jsonl"));
    const foundry = await readJsonl<FoundryEvent>(path.join(dir, "foundry", "events.jsonl"));
    const live = await readJsonl<FoundryEvent>(path.join(dir, "foundry", "live-events.jsonl"));
    const foundryLive = await readJson<FoundryLiveState>(path.join(dir, "foundry", "live-state.json"));
    const timeline = await readJsonl(path.join(dir, "merged", "timeline.jsonl"));
    const foundrySummary = await readJson<FoundryImportSummary>(path.join(dir, "foundry", "import-summary.json"));
    const reviewAudio = await readJson<ReviewAudioManifest>(path.join(dir, "review", "manifest.json"));
    let outputs = 0;
    try {
      outputs = (await fsp.readdir(path.join(dir, "outputs"))).filter((name) => !name.startsWith(".")).length;
    } catch {
      outputs = 0;
    }
    const freshness = await outputFreshness(dir);
    const utterances = manifest.items as Array<{
      utteranceId: string;
      discordUserId: string;
      displayName?: string;
      startMs: number;
      endMs: number;
      durationMs: number;
      bytes?: number;
    }>;
    const wordsByUtterance = new Map<string, number>();
    for (const record of transcript.items) {
      const text = record.text?.trim() ?? "";
      wordsByUtterance.set(record.utteranceId, text ? text.split(/\s+/).length : 0);
    }
    return {
      session,
      people: peopleFile?.people ?? [],
      markers,
      mentalNotes: collectMentalNotes(markers, transcript.items),
      utterances: utterances.map((item) => ({
        utteranceId: item.utteranceId,
        discordUserId: item.discordUserId,
        displayName: item.displayName ?? item.discordUserId,
        startMs: item.startMs,
        endMs: item.endMs,
        durationMs: item.durationMs,
        bytes: Number(item.bytes) || 0,
        words: wordsByUtterance.get(item.utteranceId) ?? 0
      })),
      counts: {
        utterances: utterances.length,
        audioBytes: utterances.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
        transcriptRecords: transcript.items.length,
        foundryEvents: new Set([...foundry.items, ...live.items].map((event) => event.eventId)).size,
        timelineEvents: timeline.items.length,
        outputs
      },
      foundrySummary: foundrySummary ?? null,
      foundryLive: foundryLive ?? null,
      reviewAudio: reviewAudio?.schema === "tablerecords.review-audio/v1" ? reviewAudio.files : [],
      audio: await readAudioStorage(dir),
      outputsStale: freshness.stale,
      outputsStaleReason: freshness.reason,
      consentPrompt: this.store.getConsentPrompt(session.world.id)
    };
  }

  async create(input: CreateSessionInput): Promise<SessionRecord> {
    const nowMs = Date.now();
    const world: FoundryWorld = input.world ?? {
      id: "unknown",
      title: "Unknown World",
      system: "generic",
      systemVersion: null,
      foundryVersion: null,
      path: ""
    };
    const timeZone = input.timeZone ?? this.config.timeZone;
    const dateKey =
      input.date && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : localDateKey(nowMs, timeZone);
    const title = (input.title?.trim() || `${world.title} — ${dateKey}`).slice(0, 200);
    const baseId = makeSessionId(title, world.id, timeZone, nowMs);
    let sessionId = baseId;
    for (let suffix = 2; await pathExists(this.sessionDir(sessionId)); suffix += 1) {
      sessionId = `${baseId.slice(0, 92)}-${suffix}`;
      if (suffix > 99) throw new SessionError("session_id_conflict", "Could not allocate a session ID", 500);
    }
    const dir = this.sessionDir(sessionId);
    const confirmed = input.consent?.confirmed === true;
    const participants = (input.participants ?? [])
      .map((person) => person.discordUserId)
      .filter((id): id is string => Boolean(id && id.trim()));
    const consent: SessionConsent = {
      confirmed,
      confirmedAtMs: confirmed ? nowMs : null,
      confirmedBy: confirmed ? input.consent?.confirmedBy ?? "GM" : null,
      participants: [...new Set(participants)],
      notes: (input.consent?.notes ?? "").slice(0, 4000),
      method: confirmed ? input.consent?.method ?? "gm_tick" : undefined,
      noticeVersion: confirmed ? input.consent?.noticeVersion ?? CONSENT_NOTICE_VERSION : undefined
    };
    const session = newSessionRecord({
      sessionId,
      title,
      campaign: (input.campaign?.trim() || (world.id === "unknown" ? "Unsorted" : world.title)).slice(0, 120),
      world,
      guild: input.guild ?? null,
      voiceChannel: input.voiceChannel ?? null,
      consent,
      notes: (input.notes ?? "").slice(0, 10_000),
      timeZone,
      nowMs,
      config: this.config
    });

    await ensureDir(dir);
    for (const sub of ["discord/audio", "foundry", "stt", "merged", "outputs", "jobs"]) {
      await ensureDir(path.join(dir, sub));
    }
    const people: Person[] = [];
    const seenDiscordIds = new Set<string>();
    for (const [index, person] of (input.participants ?? []).entries()) {
      const discordUserId = person.discordUserId?.trim() || null;
      if (discordUserId && seenDiscordIds.has(discordUserId)) continue;
      if (discordUserId) seenDiscordIds.add(discordUserId);
      const status = person.consentStatus
        ? normalizeConsentStatus(person.consentStatus)
        : person.consent === false
          ? "opted_out"
          : "assumed";
      people.push({
        personId: newPersonId(person.discordName ?? discordUserId ?? String(index + 1)),
        role: person.role === "gm" || person.role === "observer" ? person.role : "player",
        discordUserId,
        discordName: person.discordName?.trim() || null,
        foundryUserId: null,
        foundryUserName: null,
        character: person.character?.trim() || null,
        aliases: [],
        consent: status !== "opted_out",
        consentStatus: status,
        consentSource: "dashboard",
        consentUpdatedAtMs: nowMs
      });
    }
    const effectivePeople = applyConsentPreferences(people, this.store.listConsentPreferences(world.id));
    await writeJsonAtomic(path.join(dir, "session.json"), session);
    await writeJsonAtomic(path.join(dir, "people.json"), {
      schema: "tablerecords.people/v1",
      sessionId,
      people: effectivePeople
    } satisfies PeopleFile);
    await writeFileAtomic(path.join(dir, "consent.md"), this.consentMarkdown(session, effectivePeople));
    this.store.upsertSession(session);
    this.store.replacePeople(sessionId, effectivePeople);
    for (const person of effectivePeople) this.store.upsertRosterPerson(world.id, person);
    return session;
  }

  consentMarkdown(session: SessionRecord, people: Person[] = []): string {
    const optedOut = people.filter(personIsOptedOut);
    return `# Consent record — ${session.title}

- Session: \`${session.sessionId}\`
- Created: ${new Date(session.createdAtMs).toISOString()}
- Consent confirmed: ${session.consent.confirmed ? "yes" : "no"}
- Method: ${session.consent.method ?? (session.consent.confirmed ? "GM confirmation" : "—")}
- Confirmed by: ${session.consent.confirmedBy ?? "—"}
- Confirmed at: ${session.consent.confirmedAtMs ? new Date(session.consent.confirmedAtMs).toISOString() : "—"}
- Foundry prompt sent: ${session.consent.promptedAtMs ? new Date(session.consent.promptedAtMs).toISOString() : "—"}
- Notice version: ${session.consent.noticeVersion ?? CONSENT_NOTICE_VERSION}
- Participants (Discord IDs): ${session.consent.participants.join(", ") || "—"}

## Player choices

${
  people.length === 0
    ? "_No people mapping recorded._"
    : people
        .map(
          (person) =>
            `- ${displayPerson(person)} — **${personConsentStatus(person)}**${personIsOptedOut(person) ? " (not recorded)" : ""}`
        )
        .join("\n")
}

## Opted out

${optedOut.length === 0 ? "No players opted out." : optedOut.map((person) => `- ${displayPerson(person)} — player did not want to be recorded.`).join("\n")}

## Notice shown to players

${CONSENT_NOTICE_TEXT}

## Operational notes

Per-user Discord audio is recorded by a registered bot and transcribed locally.
Foundry chat and rolls visible to the GM, including private/blind rolls, are exported by the GM macro/module.
No cloud transcription or cloud LLM service is used. OBS and mixed-audio recording are not used.
Opted-out players are excluded from STT, merge, render, and recap/summary input.

## Notes

${session.consent.notes || "No additional notes."}

This snapshot follows the consent script in docs/PRIVACY.md. It is an operational record, not legal advice.
`;
  }

  async writeConsentRecord(sessionId: string): Promise<void> {
    const session = await this.get(sessionId);
    const people = (await readJson<PeopleFile>(path.join(this.sessionDir(sessionId), "people.json")))?.people ?? [];
    await writeFileAtomic(path.join(this.sessionDir(sessionId), "consent.md"), this.consentMarkdown(session, people));
  }

  async save(session: SessionRecord): Promise<void> {
    await writeJsonAtomic(path.join(this.sessionDir(session.sessionId), "session.json"), session);
    this.store.upsertSession(session);
  }

  async setStatus(session: SessionRecord, status: SessionStatus, patch: Partial<SessionRecord> = {}): Promise<SessionRecord> {
    const next: SessionRecord = { ...session, ...patch, status };
    await this.save(next);
    return next;
  }

  async updatePeople(sessionId: string, people: Person[]): Promise<Person[]> {
    const session = await this.get(sessionId);
    const existing = (await readJson<PeopleFile>(path.join(this.sessionDir(sessionId), "people.json")))?.people ?? [];
    const existingIds = new Set(existing.map((person) => person.personId));
    const existingById = new Map(existing.map((person) => [person.personId, person]));
    const usedIds = new Set<string>();
    const seenDiscordIds = new Set<string>();
    const sanitized: Person[] = [];
    const nowMs = Date.now();
    for (const [index, person] of people.entries()) {
      const discordUserId = person.discordUserId?.trim() || null;
      if (discordUserId && seenDiscordIds.has(discordUserId)) {
        throw new SessionError("duplicate_participant", `Discord user ${discordUserId} appears more than once`, 400);
      }
      if (discordUserId) seenDiscordIds.add(discordUserId);

      const requestedId = person.personId?.trim() || "";
      const reusable =
        requestedId &&
        !usedIds.has(requestedId) &&
        (existingIds.has(requestedId) || !this.store.personIdBelongsToOtherSession(requestedId, sessionId));
      const personId = reusable ? requestedId : newPersonId(person.discordName ?? String(index + 1));
      usedIds.add(personId);
      const previous = existingById.get(personId);
      const status: ConsentStatus = person.consentStatus
        ? normalizeConsentStatus(person.consentStatus)
        : person.consent === false
          ? "opted_out"
          : previous?.consentStatus ?? "assumed";
      const source: ConsentSource =
        person.consentSource === "foundry" || person.consentSource === "gm" || person.consentSource === "dashboard"
          ? person.consentSource
          : previous?.consentSource ?? "gm";
      sanitized.push({
        personId,
        role: ["gm", "player", "observer"].includes(person.role) ? person.role : "player",
        discordUserId,
        discordName: person.discordName?.trim() || null,
        foundryUserId: person.foundryUserId?.trim() || null,
        foundryUserName: person.foundryUserName?.trim() || null,
        character: person.character?.trim() || null,
        aliases: Array.isArray(person.aliases) ? person.aliases.map(String).slice(0, 20) : [],
        consent: person.consent !== false && status !== "opted_out",
        consentStatus: status,
        consentSource: source,
        consentUpdatedAtMs: person.consentUpdatedAtMs ?? nowMs
      });
    }
    const withPreferences = applyConsentPreferences(sanitized, this.store.listConsentPreferences(session.world.id));
    await writeJsonAtomic(path.join(this.sessionDir(sessionId), "people.json"), {
      schema: "tablerecords.people/v1",
      sessionId,
      people: withPreferences
    } satisfies PeopleFile);
    this.store.replacePeople(sessionId, withPreferences);
    for (const person of withPreferences) this.store.upsertRosterPerson(session.world.id, person);
    await this.writeConsentRecord(sessionId);
    return withPreferences;
  }

  async applyConsentPreferences(sessionId: string, preferences: ConsentPreference[]): Promise<Person[]> {
    const session = await this.get(sessionId);
    const people = (await readJson<PeopleFile>(path.join(this.sessionDir(sessionId), "people.json")))?.people ?? [];
    const next = applyConsentPreferences(people, preferences);
    const changed = next.some((person, index) => {
      const before = people[index];
      return !before || person.consentStatus !== before.consentStatus || person.consentSource !== before.consentSource;
    });
    if (!changed) return people;
    await writeJsonAtomic(path.join(this.sessionDir(sessionId), "people.json"), {
      schema: "tablerecords.people/v1",
      sessionId,
      people: next
    } satisfies PeopleFile);
    this.store.replacePeople(sessionId, next);
    for (const person of next) this.store.upsertRosterPerson(session.world.id, person);
    await this.writeConsentRecord(sessionId);
    return next;
  }

  async confirmConsent(
    session: SessionRecord,
    options: {
      method: "foundry" | "gm_tick";
      confirmedBy: string;
      atMs?: number;
      noticeVersion?: string;
      promptedAtMs?: number;
      notes?: string;
    }
  ): Promise<SessionRecord> {
    const atMs = options.atMs ?? Date.now();
    const next: SessionRecord = {
      ...session,
      consent: {
        ...session.consent,
        confirmed: true,
        confirmedAtMs: session.consent.confirmedAtMs ?? atMs,
        confirmedBy: options.confirmedBy.slice(0, 200),
        method: options.method,
        noticeVersion: options.noticeVersion ?? session.consent.noticeVersion ?? CONSENT_NOTICE_VERSION,
        promptedAtMs: options.promptedAtMs ?? session.consent.promptedAtMs,
        notes: options.notes ?? session.consent.notes
      }
    };
    await this.save(next);
    await this.writeConsentRecord(next.sessionId);
    return next;
  }

  async setMergeSettings(
    sessionId: string,
    beforeMs: number,
    afterMs: number
  ): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    const next: SessionRecord = {
      ...session,
      merge: {
        ...session.merge,
        rollContextBeforeMs: Math.max(0, Math.trunc(beforeMs)),
        rollContextAfterMs: Math.max(0, Math.trunc(afterMs))
      }
    };
    await this.save(next);
    return next;
  }

  async addMarker(sessionId: string, kind: MarkerKind, tsMs: number, label: string, mentalNote = false): Promise<Marker> {
    const session = await this.get(sessionId);
    const marker: Marker = {
      schema: "tablerecords.marker/v1",
      markerId: newMarkerId(),
      sessionId: session.sessionId,
      tsMs: Math.trunc(tsMs),
      kind: mentalNote ? "note" : kind,
      label: label.trim().slice(0, 500),
      mentalNote: mentalNote || undefined,
      createdAtMs: Date.now()
    };
    this.store.insertMarker(marker);
    await appendJsonl(path.join(this.sessionDir(sessionId), "markers.jsonl"), marker);
    return marker;
  }

  async deleteMarker(sessionId: string, markerId: string): Promise<void> {
    if (!this.store.deleteMarker(sessionId, markerId)) {
      throw new SessionError("not_found", `Marker not found: ${markerId}`, 404);
    }
    await writeJsonl(path.join(this.sessionDir(sessionId), "markers.jsonl"), this.store.listMarkers(sessionId));
  }

  async refreshRecordingStats(sessionId: string): Promise<SessionRecord> {
    const session = await this.get(sessionId);
    const dir = this.sessionDir(sessionId);
    const manifest = await readJsonl<{ bytes?: number; decryptionFailures?: number }>(path.join(dir, "discord", "manifest.jsonl"));
    const recording = {
      ...session.recording,
      utteranceCount: manifest.items.length,
      totalBytes: manifest.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
      decryptionFailures: manifest.items.reduce((sum, item) => sum + (Number(item.decryptionFailures) || 0), 0)
    };
    const next = { ...session, recording };
    await this.save(next);
    return next;
  }

  /** Recover sessions and jobs after a crash. Never pretends capture is still active. */
  async reconcileOnStartup(): Promise<{ sessions: number; interrupted: number; jobs: number; needsProcessing: string[] }> {
    const jobs = this.store.markRunningJobsInterrupted();
    const sessions = await this.list();
    let interrupted = 0;
    const needsProcessing: string[] = [];
    for (const session of sessions) {
      this.store.upsertSession(session);
      if (["joining", "recording", "stopping"].includes(session.status)) {
        const recovered = await this.recoverInterrupted(session);
        this.store.upsertSession(recovered.session);
        interrupted += 1;
        if (recovered.recoveredRecords > 0 || recovered.utteranceCount > 0) needsProcessing.push(session.sessionId);
      } else if (session.status === "processing") {
        const active = this.store.listJobs(session.sessionId).some((job) => job.status === "queued" || job.status === "running");
        if (!active) {
          const dir = this.sessionDir(session.sessionId);
          const timeline = await pathExists(path.join(dir, "merged", "timeline.jsonl"));
          const outputs = await pathExists(path.join(dir, "outputs", "notes-ready.md"));
          await this.setStatus(session, outputs ? "ready" : timeline ? "captured" : "captured");
          needsProcessing.push(session.sessionId);
        }
      }
    }
    return { sessions: sessions.length, interrupted, jobs, needsProcessing };
  }

  private async recoverInterrupted(session: SessionRecord): Promise<{ session: SessionRecord; recoveredRecords: number; utteranceCount: number }> {
    const dir = this.sessionDir(session.sessionId);
    const manifestPath = path.join(dir, "discord", "manifest.jsonl");
    const manifest = await readJsonl<DiscordUtterance>(manifestPath);
    const people = (await readJson<PeopleFile>(path.join(dir, "people.json")))?.people ?? [];
    const audioDir = path.join(dir, "discord", "audio");
    const audioFiles: string[] = [];
    try {
      for (const userDir of await fsp.readdir(audioDir, { withFileTypes: true })) {
        if (!userDir.isDirectory()) continue;
        for (const file of await fsp.readdir(path.join(audioDir, userDir.name))) {
          if (file.endsWith(".wav")) audioFiles.push(path.join(audioDir, userDir.name, file));
        }
      }
    } catch {
      // no audio directory
    }
    let recoveredRecords = 0;
    const known = new Set(manifest.items.map((item) => `${item.startMs}-${item.utteranceId}.wav`));
    for (const file of audioFiles) {
      const base = path.basename(file);
      if (known.has(base)) continue;
      const match = /^(\d{10,16})-(u_[A-Za-z0-9]+)\.wav$/.exec(base);
      if (!match) continue;
      const stat = await fsp.stat(file);
      if (stat.size <= 44) continue;
      const startMs = Number(match[1]);
      const utteranceId = match[2]!;
      const userId = path.basename(path.dirname(file));
      let sampleRate = 48_000;
      let channels = 2;
      let durationMs = Math.round((stat.size - 44) / 192);
      try {
        const info = await inspectWav(file);
        sampleRate = info.sampleRate;
        channels = info.channels;
        durationMs = info.durationMs;
      } catch {
        // The process died before finalizing the RIFF header. Repair it from
        // the file size so the WAV is playable and the manifest is recoverable.
        const dataBytes = stat.size - 44;
        const handle = await fsp.open(file, "r+");
        try {
          await handle.write(wavHeader(dataBytes, sampleRate, channels, 16), 0, 44, 0);
        } finally {
          await handle.close();
        }
      }
      const person = people.find((item) => item.discordUserId === userId);
      const record: DiscordUtterance = {
        schema: "tablerecords.discord-utterance/v1",
        sessionId: session.sessionId,
        utteranceId,
        discordUserId: userId,
        displayName: person?.discordName ?? userId,
        file: `discord/audio/${userId}/${base}`,
        startMs,
        endMs: startMs + durationMs,
        durationMs,
        sampleRate,
        channels,
        format: "wav",
        encoding: "pcm_s16le",
        bytes: stat.size,
        streamEnd: "error",
        decryptionFailures: 0,
        createdAtMs: Date.now()
      };
      await appendJsonl(manifestPath, record);
      manifest.items.push(record);
      known.add(base);
      recoveredRecords += 1;
    }
    const next: SessionRecord = {
      ...session,
      status: "error",
      stoppedAtMs: session.stoppedAtMs ?? Date.now(),
      recording: {
        ...session.recording,
        utteranceCount: manifest.items.length,
        totalBytes: manifest.items.reduce((sum, item) => sum + (Number(item.bytes) || 0), 0),
        decryptionFailures: manifest.items.reduce((sum, item) => sum + (Number(item.decryptionFailures) || 0), 0)
      },
      notes: `${session.notes ?? ""}\nInterrupted capture recovered on server restart; ${recoveredRecords} WAV file(s) were repaired and added to the manifest.`.trim()
    };
    await this.save(next);
    return { session: next, recoveredRecords, utteranceCount: manifest.items.length };
  }

  async assertExists(sessionId: string): Promise<SessionRecord> {
    return this.get(sessionId);
  }
}
