import { DatabaseSync } from "node:sqlite";
import path from "node:path";
import fs from "node:fs";
import type {
  ConsentPreference,
  ConsentPromptRecord,
  Job,
  JobProgress,
  JobStatus,
  JobType,
  Marker,
  MarkerKind,
  Person,
  RosterPerson,
  SessionRecord
} from "../core/types.js";
import { newPersonId } from "../core/ids.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS sessions (
  session_id       TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  system_id        TEXT NOT NULL,
  system_version   TEXT,
  world_id         TEXT,
  world_title      TEXT,
  foundry_version  TEXT,
  status           TEXT NOT NULL,
  archived         INTEGER NOT NULL DEFAULT 0,
  campaign         TEXT,
  created_at_ms    INTEGER NOT NULL,
  started_at_ms    INTEGER,
  stopped_at_ms    INTEGER,
  dir              TEXT NOT NULL UNIQUE,
  guild_id         TEXT,
  voice_channel_id TEXT,
  consent_json     TEXT NOT NULL DEFAULT '{}',
  metadata_json    TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE IF NOT EXISTS people (
  person_id         TEXT PRIMARY KEY,
  session_id        TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('gm','player','observer')),
  discord_user_id   TEXT,
  discord_name      TEXT,
  foundry_user_id   TEXT,
  foundry_user_name TEXT,
  character_name    TEXT,
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  consent           INTEGER NOT NULL DEFAULT 1,
  UNIQUE (session_id, discord_user_id)
);
CREATE TABLE IF NOT EXISTS people_roster (
  profile_id        TEXT PRIMARY KEY,
  world_id          TEXT NOT NULL,
  discord_user_id   TEXT NOT NULL,
  discord_name      TEXT,
  foundry_user_id   TEXT,
  foundry_user_name TEXT,
  character_name    TEXT,
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  role              TEXT NOT NULL CHECK (role IN ('gm','player','observer')),
  updated_at_ms     INTEGER NOT NULL,
  UNIQUE (world_id, discord_user_id)
);
CREATE TABLE IF NOT EXISTS jobs (
  job_id         TEXT PRIMARY KEY,
  session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  type           TEXT NOT NULL CHECK (type IN ('transcribe','merge','render','run_all','context')),
  status         TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
  progress_json  TEXT NOT NULL DEFAULT '{}',
  request_json   TEXT NOT NULL DEFAULT '{}',
  result_json    TEXT,
  error_json     TEXT,
  log_file       TEXT NOT NULL,
  created_at_ms  INTEGER NOT NULL,
  started_at_ms  INTEGER,
  finished_at_ms INTEGER
);
CREATE TABLE IF NOT EXISTS consent_prompt (
  world_id       TEXT PRIMARY KEY,
  prompted_at_ms INTEGER NOT NULL,
  notice_version TEXT NOT NULL,
  prompted_by    TEXT
);
CREATE TABLE IF NOT EXISTS consent_preferences (
  world_id        TEXT NOT NULL,
  foundry_user_id TEXT NOT NULL,
  display_name    TEXT,
  opt_out         INTEGER NOT NULL,
  notice_version  TEXT,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (world_id, foundry_user_id)
);
CREATE TABLE IF NOT EXISTS markers (
  marker_id     TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ts_ms         INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('scene','break','combat','note','other')),
  label         TEXT NOT NULL DEFAULT '',
  mental_note   INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_jobs_session_created ON jobs(session_id, created_at_ms);
CREATE INDEX IF NOT EXISTS idx_markers_session_ts   ON markers(session_id, ts_ms);
CREATE INDEX IF NOT EXISTS idx_people_session       ON people(session_id);
CREATE INDEX IF NOT EXISTS idx_sessions_created     ON sessions(created_at_ms);
`;

interface SessionRow {
  session_id: string;
  title: string;
  system_id: string;
  system_version: string | null;
  world_id: string | null;
  world_title: string | null;
  foundry_version: string | null;
  status: string;
  archived: number;
  created_at_ms: number;
  started_at_ms: number | null;
  stopped_at_ms: number | null;
  dir: string;
  guild_id: string | null;
  voice_channel_id: string | null;
  consent_json: string;
  metadata_json: string;
}

interface JobRow {
  job_id: string;
  session_id: string;
  type: JobType;
  status: JobStatus;
  progress_json: string;
  request_json: string;
  result_json: string | null;
  error_json: string | null;
  log_file: string;
  created_at_ms: number;
  started_at_ms: number | null;
  finished_at_ms: number | null;
}

function toJob(row: JobRow): Job {
  let progress: JobProgress = { phase: "transcribe", completed: 0, total: 0, percent: 0 };
  try {
    progress = JSON.parse(row.progress_json) as JobProgress;
  } catch {
    // keep default
  }
  return {
    schema: "tablerecords.job/v1",
    jobId: row.job_id,
    sessionId: row.session_id,
    type: row.type,
    status: row.status,
    progress,
    request: safeJson(row.request_json, {}),
    result: row.result_json ? safeJson(row.result_json, null) : null,
    error: row.error_json ? safeJson(row.error_json, null) : null,
    logFile: row.log_file,
    createdAtMs: row.created_at_ms,
    startedAtMs: row.started_at_ms,
    finishedAtMs: row.finished_at_ms
  };
}

function safeJson<T>(value: string, fallback: T): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

export class Store {
  readonly db: DatabaseSync;

  constructor(file: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    this.db = new DatabaseSync(file);
    this.db.exec("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const columns = this.db.prepare("PRAGMA table_info(markers)").all() as unknown as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "mental_note")) {
      this.db.exec("ALTER TABLE markers ADD COLUMN mental_note INTEGER NOT NULL DEFAULT 0");
    }
    const sessionColumns = this.db.prepare("PRAGMA table_info(sessions)").all() as unknown as Array<{ name: string }>;
    if (!sessionColumns.some((column) => column.name === "archived")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN archived INTEGER NOT NULL DEFAULT 0");
    }
    if (!sessionColumns.some((column) => column.name === "campaign")) {
      this.db.exec("ALTER TABLE sessions ADD COLUMN campaign TEXT");
    }
    // SQLite cannot widen a CHECK constraint in place. Rebuild only when the
    // existing jobs table predates the GM-context job type.
    const jobsSql = this.db
      .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='jobs'")
      .get() as { sql?: string } | undefined;
    if (jobsSql?.sql && !jobsSql.sql.includes("'context'")) {
      this.db.exec(`
        PRAGMA foreign_keys=OFF;
        BEGIN;
        DROP INDEX IF EXISTS idx_jobs_session_created;
        ALTER TABLE jobs RENAME TO jobs_legacy;
        CREATE TABLE jobs (
          job_id         TEXT PRIMARY KEY,
          session_id     TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
          type           TEXT NOT NULL CHECK (type IN ('transcribe','merge','render','run_all','context')),
          status         TEXT NOT NULL CHECK (status IN ('queued','running','done','failed','cancelled')),
          progress_json  TEXT NOT NULL DEFAULT '{}',
          request_json   TEXT NOT NULL DEFAULT '{}',
          result_json    TEXT,
          error_json     TEXT,
          log_file       TEXT NOT NULL,
          created_at_ms  INTEGER NOT NULL,
          started_at_ms  INTEGER,
          finished_at_ms INTEGER
        );
        INSERT INTO jobs SELECT * FROM jobs_legacy;
        DROP TABLE jobs_legacy;
        CREATE INDEX IF NOT EXISTS idx_jobs_session_created ON jobs(session_id, created_at_ms);
        COMMIT;
        PRAGMA foreign_keys=ON;
      `);
    }
  }

  close(): void {
    this.db.close();
  }

  upsertSession(session: SessionRecord): void {
    this.db
      .prepare(
        `INSERT INTO sessions
          (session_id,title,system_id,system_version,world_id,world_title,foundry_version,status,archived,campaign,created_at_ms,
           started_at_ms,stopped_at_ms,dir,guild_id,voice_channel_id,consent_json,metadata_json)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON CONFLICT(session_id) DO UPDATE SET
           title=excluded.title, system_id=excluded.system_id, system_version=excluded.system_version,
           world_id=excluded.world_id, world_title=excluded.world_title, foundry_version=excluded.foundry_version,
           status=excluded.status, archived=excluded.archived, campaign=excluded.campaign,
           created_at_ms=excluded.created_at_ms,
           started_at_ms=excluded.started_at_ms, stopped_at_ms=excluded.stopped_at_ms,
           guild_id=excluded.guild_id, voice_channel_id=excluded.voice_channel_id,
           consent_json=excluded.consent_json, metadata_json=excluded.metadata_json`
      )
      .run(
        session.sessionId,
        session.title,
        session.system.id,
        session.system.version,
        session.world.id,
        session.world.title,
        session.foundryVersion,
        session.status,
        session.archived ? 1 : 0,
        session.campaign ?? null,
        session.createdAtMs,
        session.startedAtMs,
        session.stoppedAtMs,
        session.sessionId,
        session.guild?.id ?? null,
        session.voiceChannel?.id ?? null,
        JSON.stringify(session.consent),
        JSON.stringify({ notes: session.notes ?? "" })
      );
  }

  listSessionRows(): SessionRow[] {
    return this.db.prepare("SELECT * FROM sessions ORDER BY created_at_ms DESC").all() as unknown as SessionRow[];
  }

  getSessionRow(sessionId: string): SessionRow | null {
    return (this.db.prepare("SELECT * FROM sessions WHERE session_id = ?").get(sessionId) as unknown as SessionRow) ?? null;
  }

  deleteSession(sessionId: string): void {
    this.db.prepare("DELETE FROM sessions WHERE session_id = ?").run(sessionId);
  }

  replacePeople(sessionId: string, people: Person[]): void {
    this.db.exec("BEGIN");
    try {
      this.db.prepare("DELETE FROM people WHERE session_id = ?").run(sessionId);
      const insert = this.db.prepare(
        `INSERT INTO people
          (person_id,session_id,role,discord_user_id,discord_name,foundry_user_id,foundry_user_name,character_name,aliases_json,consent)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      for (const person of people) {
        insert.run(
          person.personId,
          sessionId,
          person.role,
          person.discordUserId,
          person.discordName,
          person.foundryUserId,
          person.foundryUserName,
          person.character,
          JSON.stringify(person.aliases ?? []),
          person.consent ? 1 : 0
        );
      }
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  personIdBelongsToOtherSession(personId: string, sessionId: string): boolean {
    const row = this.db
      .prepare("SELECT 1 AS found FROM people WHERE person_id = ? AND session_id <> ? LIMIT 1")
      .get(personId, sessionId) as { found?: number } | undefined;
    return row?.found === 1;
  }

  listRoster(worldId: string): RosterPerson[] {
    const rows = this.db
      .prepare("SELECT * FROM people_roster WHERE world_id = ? ORDER BY COALESCE(discord_name, discord_user_id) COLLATE NOCASE")
      .all(worldId) as unknown as Array<{
      profile_id: string;
      world_id: string;
      discord_user_id: string;
      discord_name: string | null;
      foundry_user_id: string | null;
      foundry_user_name: string | null;
      character_name: string | null;
      aliases_json: string;
      role: RosterPerson["role"];
      updated_at_ms: number;
    }>;
    return rows.map((row) => ({
      profileId: row.profile_id,
      worldId: row.world_id,
      discordUserId: row.discord_user_id,
      discordName: row.discord_name,
      foundryUserId: row.foundry_user_id,
      foundryUserName: row.foundry_user_name,
      character: row.character_name,
      aliases: safeJson<string[]>(row.aliases_json, []),
      role: row.role,
      updatedAtMs: row.updated_at_ms
    }));
  }

  listAllRoster(): RosterPerson[] {
    const rows = this.db
      .prepare("SELECT * FROM people_roster ORDER BY world_id, COALESCE(discord_name, discord_user_id) COLLATE NOCASE")
      .all() as unknown as Array<{
      profile_id: string;
      world_id: string;
      discord_user_id: string;
      discord_name: string | null;
      foundry_user_id: string | null;
      foundry_user_name: string | null;
      character_name: string | null;
      aliases_json: string;
      role: RosterPerson["role"];
      updated_at_ms: number;
    }>;
    return rows.map((row) => ({
      profileId: row.profile_id,
      worldId: row.world_id,
      discordUserId: row.discord_user_id,
      discordName: row.discord_name,
      foundryUserId: row.foundry_user_id,
      foundryUserName: row.foundry_user_name,
      character: row.character_name,
      aliases: safeJson<string[]>(row.aliases_json, []),
      role: row.role,
      updatedAtMs: row.updated_at_ms
    }));
  }

  upsertRosterPerson(worldId: string, person: Person): RosterPerson | null {
    if (!person.discordUserId) return null;
    const existing = this.db
      .prepare("SELECT profile_id FROM people_roster WHERE world_id = ? AND discord_user_id = ?")
      .get(worldId, person.discordUserId) as { profile_id?: string } | undefined;
    const profileId = existing?.profile_id ?? newPersonId(person.discordName ?? person.discordUserId);
    const updatedAtMs = Date.now();
    if (existing?.profile_id) {
      this.db
        .prepare(
          `UPDATE people_roster SET discord_name=?, foundry_user_id=?, foundry_user_name=?, character_name=?,
             aliases_json=?, role=?, updated_at_ms=? WHERE profile_id=?`
        )
        .run(
          person.discordName,
          person.foundryUserId,
          person.foundryUserName,
          person.character,
          JSON.stringify(person.aliases ?? []),
          person.role,
          updatedAtMs,
          profileId
        );
    } else {
      this.db
        .prepare(
          `INSERT INTO people_roster
            (profile_id,world_id,discord_user_id,discord_name,foundry_user_id,foundry_user_name,character_name,aliases_json,role,updated_at_ms)
           VALUES (?,?,?,?,?,?,?,?,?,?)`
        )
        .run(
          profileId,
          worldId,
          person.discordUserId,
          person.discordName,
          person.foundryUserId,
          person.foundryUserName,
          person.character,
          JSON.stringify(person.aliases ?? []),
          person.role,
          updatedAtMs
        );
    }
    return {
      profileId,
      worldId,
      discordUserId: person.discordUserId,
      discordName: person.discordName,
      foundryUserId: person.foundryUserId,
      foundryUserName: person.foundryUserName,
      character: person.character,
      aliases: person.aliases ?? [],
      role: person.role,
      updatedAtMs
    };
  }

  seedRosterFromPeople(): void {
    const existing = this.db.prepare("SELECT COUNT(*) AS count FROM people_roster").get() as { count: number };
    if (existing.count > 0) return;
    const rows = this.db
      .prepare(
        `SELECT p.*, s.world_id AS roster_world_id
           FROM people p JOIN sessions s ON s.session_id = p.session_id
          WHERE p.discord_user_id IS NOT NULL AND p.discord_user_id <> ''
          ORDER BY s.created_at_ms ASC`
      )
      .all() as unknown as Array<{
      session_id: string;
      role: RosterPerson["role"];
      discord_user_id: string;
      discord_name: string | null;
      foundry_user_id: string | null;
      foundry_user_name: string | null;
      character_name: string | null;
      aliases_json: string;
      consent: number;
      roster_world_id: string;
    }>;
    for (const row of rows) {
      this.upsertRosterPerson(row.roster_world_id, {
        personId: "",
        role: row.role,
        discordUserId: row.discord_user_id,
        discordName: row.discord_name,
        foundryUserId: row.foundry_user_id,
        foundryUserName: row.foundry_user_name,
        character: row.character_name,
        aliases: safeJson<string[]>(row.aliases_json, []),
        consent: row.consent === 1
      });
    }
  }

  recordConsentPrompt(worldId: string, promptedAtMs: number, noticeVersion: string, promptedBy: string | null): ConsentPromptRecord {
    this.db
      .prepare(
        `INSERT INTO consent_prompt (world_id,prompted_at_ms,notice_version,prompted_by)
         VALUES (?,?,?,?)
         ON CONFLICT(world_id) DO UPDATE SET
           prompted_at_ms=excluded.prompted_at_ms,
           notice_version=excluded.notice_version,
           prompted_by=excluded.prompted_by`
      )
      .run(worldId, promptedAtMs, noticeVersion, promptedBy);
    return { worldId, promptedAtMs, noticeVersion, promptedBy };
  }

  getConsentPrompt(worldId: string): ConsentPromptRecord | null {
    const row = this.db.prepare("SELECT * FROM consent_prompt WHERE world_id = ?").get(worldId) as
      | { world_id: string; prompted_at_ms: number; notice_version: string; prompted_by: string | null }
      | undefined;
    return row
      ? {
          worldId: row.world_id,
          promptedAtMs: row.prompted_at_ms,
          noticeVersion: row.notice_version,
          promptedBy: row.prompted_by
        }
      : null;
  }

  upsertConsentPreference(preference: ConsentPreference): ConsentPreference {
    this.db
      .prepare(
        `INSERT INTO consent_preferences (world_id,foundry_user_id,display_name,opt_out,notice_version,updated_at_ms)
         VALUES (?,?,?,?,?,?)
         ON CONFLICT(world_id,foundry_user_id) DO UPDATE SET
           display_name=excluded.display_name,
           opt_out=excluded.opt_out,
           notice_version=excluded.notice_version,
           updated_at_ms=excluded.updated_at_ms`
      )
      .run(
        preference.worldId,
        preference.foundryUserId,
        preference.displayName,
        preference.optOut ? 1 : 0,
        preference.noticeVersion,
        preference.updatedAtMs
      );
    return preference;
  }

  listConsentPreferences(worldId: string): ConsentPreference[] {
    const rows = this.db
      .prepare("SELECT * FROM consent_preferences WHERE world_id = ? ORDER BY display_name COLLATE NOCASE ASC")
      .all(worldId) as unknown as Array<{
      world_id: string;
      foundry_user_id: string;
      display_name: string | null;
      opt_out: number;
      notice_version: string | null;
      updated_at_ms: number;
    }>;
    return rows.map((row) => ({
      worldId: row.world_id,
      foundryUserId: row.foundry_user_id,
      displayName: row.display_name,
      optOut: row.opt_out === 1,
      noticeVersion: row.notice_version,
      updatedAtMs: row.updated_at_ms
    }));
  }

  insertJob(job: Job): void {
    this.db
      .prepare(
        `INSERT INTO jobs (job_id,session_id,type,status,progress_json,request_json,result_json,error_json,log_file,created_at_ms,started_at_ms,finished_at_ms)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`
      )
      .run(
        job.jobId,
        job.sessionId,
        job.type,
        job.status,
        JSON.stringify(job.progress),
        JSON.stringify(job.request),
        job.result ? JSON.stringify(job.result) : null,
        job.error ? JSON.stringify(job.error) : null,
        job.logFile,
        job.createdAtMs,
        job.startedAtMs,
        job.finishedAtMs
      );
  }

  updateJob(job: Job): void {
    this.db
      .prepare(
        `UPDATE jobs SET status=?, progress_json=?, result_json=?, error_json=?, started_at_ms=?, finished_at_ms=? WHERE job_id=?`
      )
      .run(
        job.status,
        JSON.stringify(job.progress),
        job.result ? JSON.stringify(job.result) : null,
        job.error ? JSON.stringify(job.error) : null,
        job.startedAtMs,
        job.finishedAtMs,
        job.jobId
      );
  }

  getJob(jobId: string): Job | null {
    const row = this.db.prepare("SELECT * FROM jobs WHERE job_id = ?").get(jobId) as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  listJobs(sessionId?: string): Job[] {
    const rows = sessionId
      ? (this.db.prepare("SELECT * FROM jobs WHERE session_id = ? ORDER BY created_at_ms DESC").all(sessionId) as unknown as JobRow[])
      : (this.db.prepare("SELECT * FROM jobs ORDER BY created_at_ms DESC").all() as unknown as JobRow[]);
    return rows.map(toJob);
  }

  nextQueuedJob(): Job | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'queued' ORDER BY created_at_ms ASC LIMIT 1")
      .get() as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  countJobs(): { queued: number; running: number; failed: number } {
    const row = this.db
      .prepare(
        `SELECT
          SUM(CASE WHEN status='queued' THEN 1 ELSE 0 END) AS queued,
          SUM(CASE WHEN status='running' THEN 1 ELSE 0 END) AS running,
          SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed
         FROM jobs`
      )
      .get() as unknown as { queued: number | null; running: number | null; failed: number | null };
    return { queued: row?.queued ?? 0, running: row?.running ?? 0, failed: row?.failed ?? 0 };
  }

  activeJob(): Job | null {
    const row = this.db
      .prepare("SELECT * FROM jobs WHERE status = 'running' ORDER BY started_at_ms DESC LIMIT 1")
      .get() as unknown as JobRow | undefined;
    return row ? toJob(row) : null;
  }

  markRunningJobsInterrupted(nowMs = Date.now()): number {
    const result = this.db
      .prepare(
        `UPDATE jobs SET status='failed', error_json=?, finished_at_ms=?
         WHERE status='running'`
      )
      .run(JSON.stringify({ code: "interrupted", message: "Server restarted while the job was running." }), nowMs);
    return Number(result.changes ?? 0);
  }

  insertMarker(marker: Marker): void {
    this.db
      .prepare(
        "INSERT INTO markers (marker_id,session_id,ts_ms,kind,label,mental_note,created_at_ms) VALUES (?,?,?,?,?,?,?)"
      )
      .run(
        marker.markerId,
        marker.sessionId,
        marker.tsMs,
        marker.kind,
        marker.label,
        marker.mentalNote ? 1 : 0,
        marker.createdAtMs
      );
  }

  listMarkers(sessionId: string): Marker[] {
    const rows = this.db
      .prepare("SELECT * FROM markers WHERE session_id = ? ORDER BY ts_ms ASC")
      .all(sessionId) as unknown as Array<{
      marker_id: string;
      session_id: string;
      ts_ms: number;
      kind: MarkerKind;
      label: string;
      mental_note: number;
      created_at_ms: number;
    }>;
    return rows.map((row) => ({
      schema: "tablerecords.marker/v1",
      markerId: row.marker_id,
      sessionId: row.session_id,
      tsMs: row.ts_ms,
      kind: row.kind,
      label: row.label,
      mentalNote: row.mental_note === 1,
      createdAtMs: row.created_at_ms
    }));
  }

  deleteMarker(sessionId: string, markerId: string): boolean {
    const result = this.db.prepare("DELETE FROM markers WHERE session_id=? AND marker_id=?").run(sessionId, markerId);
    return Number(result.changes ?? 0) > 0;
  }

  getSetting<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value_json FROM settings WHERE key = ?").get(key) as unknown as
      | { value_json: string }
      | undefined;
    return row ? safeJson(row.value_json, fallback) : fallback;
  }

  setSetting(key: string, value: unknown): void {
    this.db
      .prepare(
        `INSERT INTO settings (key,value_json,updated_at_ms) VALUES (?,?,?)
         ON CONFLICT(key) DO UPDATE SET value_json=excluded.value_json, updated_at_ms=excluded.updated_at_ms`
      )
      .run(key, JSON.stringify(value), Date.now());
  }

  allSettings(): Record<string, unknown> {
    const rows = this.db.prepare("SELECT key,value_json FROM settings").all() as unknown as Array<{
      key: string;
      value_json: string;
    }>;
    const out: Record<string, unknown> = {};
    for (const row of rows) out[row.key] = safeJson(row.value_json, null);
    return out;
  }
}
