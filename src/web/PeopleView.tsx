import { useEffect, useRef, useState } from "react";
import { api, put } from "./api";
import { Button, Card, Disclosure, Empty, Field, Pill, Stat } from "./components";
import { formatBytes, formatDate, formatLength } from "./format";
import type { PeopleDirectoryAppearance, PeopleDirectoryEntry, Person, SessionDetail, SessionSummary } from "./types";

type Tone = "ok" | "warn" | "bad";

interface PersonSessionStat {
  sessionId: string;
  title: string;
  game: string;
  atMs: number;
  role: Person["role"];
  character: string | null;
  talkMs: number;
  words: number;
  utterances: number;
  partyTalkMs: number;
  reviewBytes: number;
  reviewDurationMs: number;
  consentStatus: "assumed" | "opted_in" | "opted_out";
}

interface PersonStats {
  sessions: PersonSessionStat[];
  games: Array<{ name: string; sessions: number; talkMs: number; words: number }>;
  characters: Array<{ name: string; sessions: number; talkMs: number; words: number; lastAtMs: number }>;
  talkMs: number;
  words: number;
  utterances: number;
  partyTalkMs: number;
  reviewBytes: number;
  reviewDurationMs: number;
  reviewTracks: number;
  optedOutSessions: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
  roleCounts: Record<Person["role"], number>;
}

export interface PeopleViewProps {
  sessions: SessionSummary[];
  selectedKey: string | null;
  onSelectPerson: (key: string) => void;
  onNotify: (tone: Tone, message: string) => void;
  onOpenSession: (sessionId: string) => void;
  onChanged: () => void;
}

function displayName(person: PeopleDirectoryEntry): string {
  return person.discordName ?? person.foundryUserName ?? person.discordUserId ?? "Unnamed person";
}

function roleLabel(role: Person["role"]): string {
  return role === "gm" ? "GM" : role === "observer" ? "Observer" : "Player";
}

function personMatches(person: PeopleDirectoryEntry, candidate: Person): boolean {
  if (person.discordUserId) return candidate.discordUserId === person.discordUserId;
  const name = (candidate.discordName ?? candidate.foundryUserName ?? "").trim().toLowerCase();
  return name !== "" && name === (person.discordName ?? "").trim().toLowerCase();
}

function computePersonStats(
  selected: PeopleDirectoryEntry,
  details: Map<string, SessionDetail>
): PersonStats {
  const games = new Map<string, { name: string; sessions: number; talkMs: number; words: number }>();
  const characters = new Map<string, { name: string; sessions: number; talkMs: number; words: number; lastAtMs: number }>();
  const roleCounts: Record<Person["role"], number> = { gm: 0, player: 0, observer: 0 };
  let talkMs = 0;
  let words = 0;
  let utterances = 0;
  let partyTalkMs = 0;
  let reviewBytes = 0;
  let reviewDurationMs = 0;
  let reviewTracks = 0;
  let optedOutSessions = 0;
  let firstAtMs: number | null = null;
  let lastAtMs: number | null = null;
  const sessions: PersonSessionStat[] = [];

  for (const appearance of selected.appearances) {
    const detail = details.get(appearance.sessionId);
    const personEntry = detail?.people.find((candidate) => personMatches(selected, candidate));
    const discordUserId = personEntry?.discordUserId ?? selected.discordUserId;
    const displayName = (personEntry?.discordName ?? selected.discordName ?? "").trim().toLowerCase();
    const personUtterances = (detail?.utterances ?? []).filter((utterance) =>
      discordUserId ? utterance.discordUserId === discordUserId : utterance.displayName.trim().toLowerCase() === displayName
    );
    const personTalkMs = personUtterances.reduce(
      (sum, utterance) => sum + Math.max(0, utterance.endMs - utterance.startMs),
      0
    );
    const personWords = personUtterances.reduce((sum, utterance) => sum + (utterance.words ?? 0), 0);
    const sessionTalkMs = (detail?.utterances ?? []).reduce(
      (sum, utterance) => sum + Math.max(0, utterance.endMs - utterance.startMs),
      0
    );
    const reviewFile = (detail?.reviewAudio ?? []).find(
      (file) =>
        file.kind === "speaker" &&
        (file.speakerId === discordUserId ||
          (displayName !== "" && file.speakerName?.trim().toLowerCase() === displayName))
    );
    const character = personEntry?.character ?? appearance.character ?? null;
    const consentStatus = personEntry?.consentStatus ?? appearance.consentStatus;
    const game = appearance.campaign;
    const role = personEntry?.role ?? appearance.role;
    talkMs += personTalkMs;
    words += personWords;
    utterances += personUtterances.length;
    partyTalkMs += sessionTalkMs;
    if (reviewFile) {
      reviewBytes += reviewFile.sizeBytes;
      reviewDurationMs += reviewFile.durationMs;
      reviewTracks += 1;
    }
    if (consentStatus === "opted_out") optedOutSessions += 1;
    roleCounts[role] += 1;
    firstAtMs = firstAtMs == null ? appearance.createdAtMs : Math.min(firstAtMs, appearance.createdAtMs);
    lastAtMs = lastAtMs == null ? appearance.createdAtMs : Math.max(lastAtMs, appearance.createdAtMs);
    const gameStat = games.get(game) ?? { name: game, sessions: 0, talkMs: 0, words: 0 };
    gameStat.sessions += 1;
    gameStat.talkMs += personTalkMs;
    gameStat.words += personWords;
    games.set(game, gameStat);
    if (character) {
      const charStat =
        characters.get(character) ?? { name: character, sessions: 0, talkMs: 0, words: 0, lastAtMs: appearance.createdAtMs };
      charStat.sessions += 1;
      charStat.talkMs += personTalkMs;
      charStat.words += personWords;
      charStat.lastAtMs = Math.max(charStat.lastAtMs, appearance.createdAtMs);
      characters.set(character, charStat);
    }
    sessions.push({
      sessionId: appearance.sessionId,
      title: appearance.title,
      game,
      atMs: appearance.createdAtMs,
      role,
      character,
      talkMs: personTalkMs,
      words: personWords,
      utterances: personUtterances.length,
      partyTalkMs: sessionTalkMs,
      reviewBytes: reviewFile?.sizeBytes ?? 0,
      reviewDurationMs: reviewFile?.durationMs ?? 0,
      consentStatus
    });
  }

  return {
    sessions: sessions.sort((a, b) => b.atMs - a.atMs),
    games: [...games.values()].sort((a, b) => b.talkMs - a.talkMs || b.sessions - a.sessions),
    characters: [...characters.values()].sort((a, b) => b.sessions - a.sessions || b.talkMs - a.talkMs),
    talkMs,
    words,
    utterances,
    partyTalkMs,
    reviewBytes,
    reviewDurationMs,
    reviewTracks,
    optedOutSessions,
    firstAtMs,
    lastAtMs,
    roleCounts
  };
}

function AppearanceRow({
  appearance,
  stat,
  busy,
  onSave,
  onRemove,
  onOpen
}: {
  person: PeopleDirectoryEntry;
  appearance: PeopleDirectoryAppearance;
  stat?: PersonSessionStat;
  busy: boolean;
  onSave: (changes: { role: Person["role"]; character: string; record: boolean }) => void;
  onRemove: () => void;
  onOpen: () => void;
}) {
  const [role, setRole] = useState<Person["role"]>(appearance.role);
  const [character, setCharacter] = useState(appearance.character ?? "");
  const [record, setRecord] = useState(appearance.consentStatus !== "opted_out");
  const dirty = role !== appearance.role || character !== (appearance.character ?? "") || record !== (appearance.consentStatus !== "opted_out");
  return (
    <div className="person-appearance">
      <div className="person-appearance-title">
        <button className="link" onClick={onOpen}>
          {appearance.title}
        </button>
        <div className="muted tiny">
          {formatDate(appearance.createdAtMs)} · {appearance.campaign}
          {stat && stat.utterances > 0 ? ` · ${formatLength(stat.talkMs)} talk · ${stat.words.toLocaleString()} words` : ""}
          {stat && stat.reviewBytes > 0 ? ` · ${formatBytes(stat.reviewBytes)} review` : ""}
        </div>
      </div>
      <select value={role} disabled={busy} aria-label="Role" onChange={(event) => setRole(event.target.value as Person["role"])}>
        <option value="gm">GM</option>
        <option value="player">Player</option>
        <option value="observer">Observer</option>
      </select>
      <input
        value={character}
        disabled={busy}
        placeholder="Character"
        aria-label="Character"
        onChange={(event) => setCharacter(event.target.value)}
      />
      <label className="checkbox" title={record ? "Recorded" : "Opted out"}>
        <input type="checkbox" checked={record} disabled={busy} onChange={(event) => setRecord(event.target.checked)} />
        <span className="tiny">{record ? "recorded" : "opted out"}</span>
      </label>
      <div className="button-row">
        <Button
          variant="small"
          disabled={busy || !dirty}
          onClick={() => onSave({ role, character: character.trim(), record })}
        >
          Save
        </Button>
        <Button variant="ghost small" disabled={busy} onClick={onRemove} title="Remove from this recording">
          ×
        </Button>
      </div>
    </div>
  );
}

export function PeopleView(props: PeopleViewProps) {
  const [people, setPeople] = useState<PeopleDirectoryEntry[]>([]);
  const [games, setGames] = useState<string[]>([]);
  const [search, setSearch] = useState("");
  const [gameFilter, setGameFilter] = useState("all");
  const [loading, setLoading] = useState(true);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const [addSessionId, setAddSessionId] = useState("");
  const [addGame, setAddGame] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<PersonStats | null>(null);
  const [statsLoading, setStatsLoading] = useState(false);
  const [mobilePane, setMobilePane] = useState<"list" | "detail">(props.selectedKey ? "detail" : "list");
  const [statsVersion, setStatsVersion] = useState(0);
  const statsCache = useRef(new Map<string, PersonStats>());

  const load = async () => {
    setLoading(true);
    try {
      const data = await api<{ people: PeopleDirectoryEntry[]; games: string[] }>("/api/people");
      setPeople(data.people);
      setGames(data.games);
      setError(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
  }, []);

  useEffect(() => {
    setMobilePane(props.selectedKey ? "detail" : "list");
  }, [props.selectedKey]);

  useEffect(() => {
    if (loading || people.length === 0) return;
    if (props.selectedKey && people.some((person) => person.key === props.selectedKey)) return;
    if (window.matchMedia("(max-width: 1000px)").matches) return;
    props.onSelectPerson(people[0]!.key);
  }, [loading, people, props.selectedKey, props.onSelectPerson]);

  const selected = people.find((person) => person.key === props.selectedKey) ?? null;
  const appearanceKey = (selected?.appearances ?? []).map((appearance) => appearance.sessionId).join("|");

  useEffect(() => {
    if (!selected) {
      setStats(null);
      setStatsLoading(false);
      return;
    }
    const cacheKey = `${selected.key}:${statsVersion}:${appearanceKey}`;
    const cached = statsCache.current.get(cacheKey);
    if (cached) {
      setStats(cached);
      setStatsLoading(false);
      return;
    }
    let cancelled = false;
    setStats(null);
    setStatsLoading(true);
    void Promise.allSettled(
      selected.appearances.map((appearance) => api<SessionDetail>(`/api/sessions/${appearance.sessionId}`))
    )
      .then((results) => {
        if (cancelled) return;
        const details = new Map<string, SessionDetail>();
        results.forEach((result) => {
          if (result.status === "fulfilled") details.set(result.value.session.sessionId, result.value);
        });
        const computed = computePersonStats(selected, details);
        statsCache.current.set(cacheKey, computed);
        setStats(computed);
      })
      .catch((caught: unknown) => {
        if (!cancelled) setError(caught instanceof Error ? caught.message : String(caught));
      })
      .finally(() => {
        if (!cancelled) setStatsLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected?.key, statsVersion, appearanceKey]);
  const filtered = people.filter((person) => {
    if (gameFilter !== "all" && !person.games.includes(gameFilter)) return false;
    if (!search.trim()) return true;
    const needle = search.trim().toLowerCase();
    return [person.discordName, person.foundryUserName, person.discordUserId, ...person.characters, ...person.games]
      .filter(Boolean)
      .some((value) => String(value).toLowerCase().includes(needle));
  });
  const availableSessions = selected
    ? props.sessions.filter((session) => !selected.appearances.some((appearance) => appearance.sessionId === session.sessionId))
    : [];
  const grouped = new Map<string, PeopleDirectoryAppearance[]>();
  for (const appearance of selected?.appearances ?? []) {
    const list = grouped.get(appearance.campaign) ?? [];
    list.push(appearance);
    grouped.set(appearance.campaign, list);
  }

  const notifyError = (caught: unknown) => {
    const message = caught instanceof Error ? caught.message : String(caught);
    setError(message);
    props.onNotify("bad", message);
  };

  const saveAppearance = async (
    appearance: PeopleDirectoryAppearance,
    changes: { role: Person["role"]; character: string; record: boolean }
  ) => {
    if (!selected) return;
    setBusyKey(appearance.sessionId);
    try {
      const detail = await api<SessionDetail>(`/api/sessions/${appearance.sessionId}`);
      const next = detail.people.map((person) =>
        personMatches(selected, person)
          ? {
              ...person,
              role: changes.role,
              character: changes.character || null,
              consent: changes.record,
              consentStatus: changes.record ? ("assumed" as const) : ("opted_out" as const),
              consentSource: "dashboard" as const,
              consentUpdatedAtMs: Date.now()
            }
          : person
      );
      await put(`/api/sessions/${appearance.sessionId}/people`, { people: next });
      await load();
      setStatsVersion((value) => value + 1);
      props.onChanged();
      props.onNotify("ok", `Saved ${displayName(selected)} in ${appearance.title}`);
    } catch (caught) {
      notifyError(caught);
    } finally {
      setBusyKey(null);
    }
  };

  const removeAppearance = async (appearance: PeopleDirectoryAppearance) => {
    if (!selected) return;
    if (!window.confirm(`Remove ${displayName(selected)} from "${appearance.title}"? The recording and transcript stay; only the mapping is removed.`)) {
      return;
    }
    setBusyKey(appearance.sessionId);
    try {
      const detail = await api<SessionDetail>(`/api/sessions/${appearance.sessionId}`);
      const next = detail.people.filter((person) => !personMatches(selected, person));
      if (next.length === detail.people.length) throw new Error("That person was not found in the recording.");
      await put(`/api/sessions/${appearance.sessionId}/people`, { people: next });
      await load();
      setStatsVersion((value) => value + 1);
      props.onChanged();
      props.onNotify("ok", `Removed from ${appearance.title}`);
    } catch (caught) {
      notifyError(caught);
    } finally {
      setBusyKey(null);
    }
  };

  const addToSession = async () => {
    if (!selected || !addSessionId) return;
    if (!selected.discordUserId) {
      props.onNotify("warn", "Add a Discord user ID on a session before mapping this person.");
      return;
    }
    const target = props.sessions.find((session) => session.sessionId === addSessionId);
    if (!target) return;
    setBusyKey(target.sessionId);
    try {
      const detail = await api<SessionDetail>(`/api/sessions/${target.sessionId}`);
      if (detail.people.some((person) => personMatches(selected, person))) {
        props.onNotify("warn", "Already mapped to that recording");
        return;
      }
      const person: Person = {
        personId: "",
        role: selected.roles[0] ?? "player",
        discordUserId: selected.discordUserId,
        discordName: selected.discordName,
        foundryUserId: selected.foundryUserId,
        foundryUserName: selected.foundryUserName,
        character: selected.characters[0] ?? null,
        aliases: [],
        consent: true,
        consentStatus: "assumed",
        consentSource: "dashboard"
      };
      await put(`/api/sessions/${target.sessionId}/people`, { people: [...detail.people, person] });
      setAddSessionId("");
      await load();
      setStatsVersion((value) => value + 1);
      props.onChanged();
      props.onNotify("ok", `Added to ${target.title}`);
    } catch (caught) {
      notifyError(caught);
    } finally {
      setBusyKey(null);
    }
  };

  const addToGame = async () => {
    if (!selected || !addGame) return;
    if (!selected.discordUserId) {
      props.onNotify("warn", "Add a Discord user ID on a session before mapping this person.");
      return;
    }
    const targets = props.sessions.filter(
      (session) =>
        (session.campaign || session.world.title) === addGame &&
        !selected.appearances.some((appearance) => appearance.sessionId === session.sessionId)
    );
    if (targets.length === 0) {
      props.onNotify("warn", `Already mapped to every recording in ${addGame}`);
      return;
    }
    if (!window.confirm(`Add ${displayName(selected)} to ${targets.length} recording(s) in "${addGame}"?`)) return;
    setBusyKey(`game:${addGame}`);
    try {
      for (const target of targets) {
        const detail = await api<SessionDetail>(`/api/sessions/${target.sessionId}`);
        if (detail.people.some((person) => personMatches(selected, person))) continue;
        const person: Person = {
          personId: "",
          role: selected.roles[0] ?? "player",
          discordUserId: selected.discordUserId,
          discordName: selected.discordName,
          foundryUserId: selected.foundryUserId,
          foundryUserName: selected.foundryUserName,
          character: selected.characters[0] ?? null,
          aliases: [],
          consent: true,
          consentStatus: "assumed",
          consentSource: "dashboard"
        };
        await put(`/api/sessions/${target.sessionId}/people`, { people: [...detail.people, person] });
      }
      setAddGame("");
      await load();
      setStatsVersion((value) => value + 1);
      props.onChanged();
      props.onNotify("ok", `Mapped to ${targets.length} recording(s) in ${addGame}`);
    } catch (caught) {
      notifyError(caught);
    } finally {
      setBusyKey(null);
    }
  };

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>People</h1>
          <p className="muted">One place to map players to games, recordings, characters, and consent.</p>
        </div>
        <Button variant="ghost" onClick={() => void load()} disabled={loading}>
          {loading ? "Refreshing…" : "Refresh"}
        </Button>
      </div>

      {error && <p className="bad-text small">{error}</p>}

      <div className={`people-layout ${mobilePane === "list" ? "show-list" : "show-detail"}`}>
        <Card title="Directory" subtitle={`${people.length} ${people.length === 1 ? "person" : "people"}`} className="people-index">
          <div className="form-grid">
            <Field label="Search">
              <input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name or character" />
            </Field>
            <Field label="Game">
              <select value={gameFilter} onChange={(event) => setGameFilter(event.target.value)}>
                <option value="all">All games</option>
                {games.map((game) => (
                  <option key={game} value={game}>{game}</option>
                ))}
              </select>
            </Field>
          </div>
          {filtered.length === 0 ? (
            <Empty title={people.length === 0 ? "No people yet" : "No match"}>
              {people.length === 0 ? "Create a session and add people, or add them from a voice channel." : "Try another search or game."}
            </Empty>
          ) : (
            <div className="people-list">
              {filtered.map((person) => (
                <button
                  key={person.key}
                  className={`person-row ${props.selectedKey === person.key ? "active" : ""}`}
                  onClick={() => {
                    setMobilePane("detail");
                    props.onSelectPerson(person.key);
                  }}
                >
                  <div>
                    <strong>{displayName(person)}</strong>
                    <div className="muted tiny">
                      {person.characters.length > 0 ? person.characters.join(", ") : "no character"}
                      {person.games.length > 0 ? ` · ${person.games.length} ${person.games.length === 1 ? "game" : "games"}` : ""}
                    </div>
                  </div>
                  <div className="button-row">
                    {person.consent === "opted_out" && <Pill tone="bad">opted out</Pill>}
                    {person.consent === "opted_in" && <Pill tone="ok">opted in</Pill>}
                    <Pill tone="idle">{person.appearances.length}</Pill>
                  </div>
                </button>
              ))}
            </div>
          )}
        </Card>

        <div className="people-detail">
          <button className="pane-back" onClick={() => setMobilePane("list")}>← All people</button>
          {!selected ? (
            <Card title="Person"><Empty title="Select a person" /></Card>
          ) : (
            <>
              <Card
                title={displayName(selected)}
                subtitle={selected.games.length > 0 ? selected.games.join(" · ") : "Not mapped to a game yet"}
                actions={
                  <div className="button-row">
                    {selected.consent === "opted_out" && <Pill tone="bad">opted out</Pill>}
                    {selected.consent === "opted_in" && <Pill tone="ok">opted in</Pill>}
                    {selected.appearances[0] && (
                      <Button variant="ghost" onClick={() => props.onOpenSession(selected.appearances[0]!.sessionId)}>
                        Open latest
                      </Button>
                    )}
                  </div>
                }
              >
                <div className="session-facts">
                  <Stat label="Recordings" value={selected.appearances.length} />
                  <Stat label="Games" value={selected.games.length} />
                  <Stat label="Characters" value={selected.characters.length} />
                  <Stat label="Roles" value={selected.roles.map(roleLabel).join(", ") || "—"} />
                </div>
                <div className="form-grid">
                  <Field label="Discord name">
                    <input readOnly value={selected.discordName ?? ""} placeholder="not set" />
                  </Field>
                  <Field label="Discord user ID" hint="Used to match voice and per-session mappings.">
                    <input readOnly className="mono" value={selected.discordUserId ?? ""} placeholder="not set" />
                  </Field>
                  <Field label="Foundry user">
                    <input readOnly value={selected.foundryUserName ?? ""} placeholder="not set" />
                  </Field>
                  <Field label="Characters">
                    <input readOnly value={selected.characters.join(", ")} placeholder="not set" />
                  </Field>
                </div>
                {selected.profiles.length > 0 && (
                  <Disclosure summary={`Saved game profiles (${selected.profiles.length})`}>
                    <div className="profile-list">
                      {selected.profiles.map((profile) => (
                        <div className="profile-row" key={profile.profileId}>
                          <strong>{profile.worldId}</strong>
                          <span className="muted small">
                            {profile.role} · {profile.character ?? "no character"} · saved {formatDate(profile.updatedAtMs)}
                          </span>
                        </div>
                      ))}
                    </div>
                  </Disclosure>
                )}
              </Card>

              <Card
                title="Career stats"
                subtitle={statsLoading ? "Crunching sessions, transcripts, and review tracks…" : "Across every recorded appearance"}
              >
                {statsLoading ? (
                  <p className="muted small">Measuring talk time, characters, and review audio…</p>
                ) : !stats || stats.sessions.length === 0 ? (
                  <p className="muted small">No recorded sessions yet. Add this person to a recording to start their history.</p>
                ) : (
                  <>
                    <div className="session-facts">
                      <Stat label="Sessions" value={stats.sessions.length} sub={`${stats.games.length} ${stats.games.length === 1 ? "game" : "games"}`} />
                      <Stat
                        label="Talk time"
                        value={formatLength(stats.talkMs)}
                        sub={`${Math.round((stats.talkMs / Math.max(1, stats.partyTalkMs)) * 100)}% of table talk`}
                      />
                      <Stat
                        label="Turns"
                        value={stats.utterances.toLocaleString()}
                        sub={`${formatLength(stats.talkMs / Math.max(1, stats.utterances))} average`}
                      />
                      <Stat
                        label="Words"
                        value={stats.words.toLocaleString()}
                        sub={stats.talkMs > 0 ? `${Math.round((stats.words / stats.talkMs) * 60_000)} wpm` : undefined}
                      />
                      <Stat
                        label="Review audio"
                        value={formatBytes(stats.reviewBytes)}
                        sub={`${stats.reviewTracks} speaker ${stats.reviewTracks === 1 ? "track" : "tracks"}`}
                      />
                      <Stat
                        label="Characters"
                        value={stats.characters.length}
                        sub={
                          [
                            stats.roleCounts.gm > 0 ? `GM ×${stats.roleCounts.gm}` : null,
                            stats.roleCounts.player > 0 ? `Player ×${stats.roleCounts.player}` : null,
                            stats.roleCounts.observer > 0 ? `Observer ×${stats.roleCounts.observer}` : null
                          ]
                            .filter(Boolean)
                            .join(" · ") || undefined
                        }
                      />
                    </div>
                    <p className="muted small">
                      First spotted {stats.firstAtMs ? formatDate(stats.firstAtMs) : "—"}
                      {stats.lastAtMs ? ` · most recently ${formatDate(stats.lastAtMs)}` : ""}
                      {stats.optedOutSessions > 0
                        ? ` · opted out of ${stats.optedOutSessions} ${stats.optedOutSessions === 1 ? "session" : "sessions"}`
                        : ""}
                    </p>
                    <div className="people-breakdowns">
                      <section className="people-breakdown">
                        <h3>Characters played</h3>
                        {stats.characters.length === 0 ? (
                          <p className="muted small">No character recorded yet.</p>
                        ) : (
                          stats.characters.map((character) => (
                            <div className="people-stat-row" key={character.name}>
                              <div>
                                <strong>{character.name}</strong>
                                <span className="muted tiny">
                                  {character.sessions} {character.sessions === 1 ? "session" : "sessions"} ·{" "}
                                  {formatLength(character.talkMs)} · {character.words.toLocaleString()} words
                                </span>
                              </div>
                              <span className="muted tiny">last {formatDate(character.lastAtMs)}</span>
                            </div>
                          ))
                        )}
                      </section>
                      <section className="people-breakdown">
                        <h3>Games spotted in</h3>
                        {stats.games.map((game) => (
                          <div className="people-stat-row" key={game.name}>
                            <div>
                              <strong>{game.name}</strong>
                              <span className="muted tiny">
                                {game.sessions} {game.sessions === 1 ? "session" : "sessions"} ·{" "}
                                {formatLength(game.talkMs)} · {game.words.toLocaleString()} words
                              </span>
                            </div>
                            <span
                              className="people-share-bar"
                              title={`${Math.round((game.talkMs / Math.max(1, stats.talkMs)) * 100)}% of this person's talk time`}
                            >
                              <span style={{ width: `${Math.round((game.talkMs / Math.max(1, stats.talkMs)) * 100)}%` }} />
                            </span>
                          </div>
                        ))}
                      </section>
                    </div>
                  </>
                )}
              </Card>

              <Card title="Recordings" subtitle="Map this person to a session; changes apply to that session and its saved game profile.">
                {selected.appearances.length === 0 ? (
                  <Empty title="Not in any recording yet">Add this person to a recording below.</Empty>
                ) : (
                  [...grouped.entries()].map(([game, appearances]) => (
                    <section className="person-game" key={game}>
                      <h3>{game}</h3>
                      {appearances.map((appearance) => (
                        <AppearanceRow
                          key={appearance.sessionId}
                          person={selected}
                          appearance={appearance}
                          stat={stats?.sessions.find((item) => item.sessionId === appearance.sessionId)}
                          busy={busyKey === appearance.sessionId}
                          onSave={(changes) => void saveAppearance(appearance, changes)}
                          onRemove={() => void removeAppearance(appearance)}
                          onOpen={() => props.onOpenSession(appearance.sessionId)}
                        />
                      ))}
                    </section>
                  ))
                )}

                <div className="person-add">
                  <Field label="Add to a recording">
                    <div className="token-row">
                      <select value={addSessionId} onChange={(event) => setAddSessionId(event.target.value)}>
                        <option value="">Choose a recording…</option>
                        {availableSessions.map((session) => (
                          <option key={session.sessionId} value={session.sessionId}>
                            {session.title} — {session.campaign || session.world.title}
                          </option>
                        ))}
                      </select>
                      <Button
                        variant="small"
                        disabled={Boolean(busyKey) || !addSessionId || !selected.discordUserId}
                        onClick={() => void addToSession()}
                      >
                        Add
                      </Button>
                    </div>
                  </Field>
                  <Field label="Add to a whole game" hint="Adds this person to every recording in the game that does not already include them.">
                    <div className="token-row">
                      <select value={addGame} onChange={(event) => setAddGame(event.target.value)}>
                        <option value="">Choose a game…</option>
                        {games.map((game) => (
                          <option key={game} value={game}>{game}</option>
                        ))}
                      </select>
                      <Button
                        variant="small"
                        disabled={Boolean(busyKey) || !addGame || !selected.discordUserId}
                        onClick={() => void addToGame()}
                      >
                        Map to game
                      </Button>
                    </div>
                  </Field>
                  {!selected.discordUserId && (
                    <p className="warn-text small">Set a Discord user ID on a recording before adding this person elsewhere.</p>
                  )}
                </div>
              </Card>
            </>
          )}
        </div>
      </div>
    </div>
  );
}


