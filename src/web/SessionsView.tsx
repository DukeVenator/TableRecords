import { useEffect, useRef, useState } from "react";
import { WaveformPlayer } from "./WaveformPlayer";
import { SessionStatsView } from "./SessionStatsView";
import { api } from "./api";
import { humanMessage } from "./errors";
import type {
  Guild,
  Job,
  LlmSummaryPreset,
  LlmSummaryResult,
  LlmSummaryScope,
  OutputFile,
  PeopleDirectoryEntry,
  Person,
  RosterPerson,
  SessionDetail,
  SessionStorageReport,
  SessionSummary,
  VoiceChannel,
  VoiceMember,
  World
} from "./types";
import {
  Button,
  Card,
  Disclosure,
  Empty,
  Field,
  JobPanel,
  MarkerBar,
  MomentList,
  Pill,
  Stat,
  markersToMoments,
  type Moment
} from "./components";
import {
  formatBytes,
  formatDate,
  formatDateTime,
  formatLength,
  formatRelative,
  sessionStatusLabel,
  statusTone,
  summaryPresetLabel,
  systemName
} from "./format";
import { CONSENT_NOTICE_TEXT, displayPerson, personConsentStatus, personIsOptedOut } from "../core/consent.js";

export interface SessionsProps {
  sessions: SessionSummary[];
  selectedId: string | null;
  detail: SessionDetail | null;
  jobs: Job[];
  outputs: OutputFile[];
  worlds: World[];
  guilds: Guild[];
  channels: VoiceChannel[];
  guildId: string;
  channelId: string;
  busy: string | null;
  markerLabel: string;
  botReady: boolean;
  onSelect: (id: string) => void;
  onGuild: (value: string) => void;
  onChannel: (value: string) => void;
  onCreate: (payload: Record<string, unknown>) => Promise<boolean> | boolean;
  onStart: (sessionId: string) => void;
  onStop: (sessionId: string) => void;
  onMarker: (sessionId: string, kind: string, mentalNote?: boolean) => void;
  onDeleteMarker: (sessionId: string, markerId: string) => void;
  onMarkerLabel: (value: string) => void;
  onMergeSettings: (sessionId: string, beforeMs: number, afterMs: number) => void;
  onArchive: (sessionId: string, archived: boolean) => void;
  onDelete: (sessionId: string) => void;
  onBuildReviewAudio: (sessionId: string) => void;
  onCompactAudio: (sessionId: string) => void;
  onRemoveAudio: (sessionId: string) => void;
  roster: RosterPerson[];
  voiceMembers: VoiceMember[];
  onLoadVoiceMembers: (sessionId: string) => void;
  onSavePeople: (sessionId: string, people: Person[]) => Promise<Person[] | void> | Person[] | void;
  onImport: (sessionId: string, file: File) => Promise<void> | void;
  onEnqueue: (sessionId: string, type: string) => void;
  onCancel: (jobId: string) => void;
  onRetry: (jobId: string) => void;
  onLogs: (jobId: string) => void;
  onPreview: (sessionId: string, name: string) => void;
  onUpdate: (sessionId: string, payload: Record<string, unknown>) => void;
  tab: SessionsTab;
  onTab: (tab: SessionsTab) => void;
  llmEnabled: boolean;
  llmConfigured: boolean;
  llmPreset: LlmSummaryPreset;
  llmScope: LlmSummaryScope;
  llmSummaries: LlmSummaryResult[];
  recentSeconds: number;
  onRecentSeconds: (value: number) => void;
  onLlmPreset: (value: LlmSummaryPreset) => void;
  onLlmScope: (value: LlmSummaryScope) => void;
  onLlmSummary: (sessionId: string, windowSeconds: number) => void;
  onOpenLlmSummary: (summary: LlmSummaryResult) => void;
}

export type SessionsTab = "overview" | "stats" | "people" | "rolls" | "files" | "activity";

interface NewParticipant {
  key: string;
  discordName: string;
  discordUserId: string;
  character: string;
  role: Person["role"];
  consentStatus: "assumed" | "opted_in" | "opted_out";
}

const STORAGE_COLORS: Record<string, string> = {
  clips: "#45d6c3",
  review: "#f5b942",
  stt: "#a78bfa",
  outputs: "#60a5fa",
  foundry: "#f472b6",
  context: "#34d399",
  jobs: "#94a3b8",
  other: "#64748b"
};

const SUMMARY_WINDOWS = [60, 180, 300, 600, 900] as const;

function summaryWindowLabel(seconds: number): string {
  return seconds % 60 === 0 ? `${seconds / 60} min` : `${seconds}s`;
}

const FILE_GROUPS: Array<{ id: string; title: string; description: string; files: Array<[string, string]> }> = [
  {
    id: "notes",
    title: "Read after the session",
    description: "The written record of the night.",
    files: [
      ["transcript.md", "Everything that was said, in order."],
      ["notes-ready.md", "A readable session timeline with short backchannels trimmed."],
      ["chronology.md", "What happened, in time order."]
    ]
  },
  {
    id: "rolls",
    title: "Rolls",
    description: "Dice and the speech around them.",
    files: [
      ["rolls.csv", "Every roll, ready for a spreadsheet."],
      ["roll-sync.md", "Which lines of speech belong to each roll."]
    ]
  },
  {
    id: "reference",
    title: "Reference",
    description: "Small summaries you may want later.",
    files: [
      ["mental-notes.md", "Everything marked “note to self”."],
      ["stats.md", "Session totals and the consent record."]
    ]
  }
];

export function SessionsView(props: SessionsProps) {
  const { detail, busy } = props;
  const [showCreate, setShowCreate] = useState(false);
  const [foundryMatchMessage, setFoundryMatchMessage] = useState<string | null>(null);
  const tab = props.tab;
  const [storage, setStorage] = useState<SessionStorageReport | null>(null);
  const storageSessionRef = useRef<string | null>(null);
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [mobilePane, setMobilePane] = useState<"list" | "detail">(props.selectedId ? "detail" : "list");
  const [showMapping, setShowMapping] = useState(false);
  const [title, setTitle] = useState("");
  const [campaign, setCampaign] = useState("");
  const [worldId, setWorldId] = useState("");
  const worldInitialized = useRef(false);
  const [notes, setNotes] = useState("");
  const [gmName, setGmName] = useState("GM");
  const [gmDiscordId, setGmDiscordId] = useState("");
  const [participants, setParticipants] = useState<NewParticipant[]>([]);
  const [directory, setDirectory] = useState<PeopleDirectoryEntry[]>([]);
  const [copyNote, setCopyNote] = useState<string | null>(null);
  const [copyingSession, setCopyingSession] = useState(false);
  const participantKey = useRef(0);
  const [consent, setConsent] = useState(false);
  const [consentBy, setConsentBy] = useState("GM");
  const [people, setPeople] = useState<Person[]>([]);
  const [titleDraft, setTitleDraft] = useState("");
  const [campaignDraft, setCampaignDraft] = useState("");
  const [notesDraft, setNotesDraft] = useState("");
  const [rollBefore, setRollBefore] = useState(20);
  const [rollAfter, setRollAfter] = useState(10);
  const [importing, setImporting] = useState(false);
  const lastSession = useRef<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    setMobilePane(props.selectedId ? "detail" : "list");
  }, [props.selectedId]);

  useEffect(() => {
    if (!showCreate || directory.length > 0) return;
    let cancelled = false;
    void api<{ people: PeopleDirectoryEntry[] }>("/api/people")
      .then((result) => {
        if (!cancelled) setDirectory(result.people);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [showCreate, directory.length]);

  useEffect(() => {
    if (detail && detail.session.sessionId !== lastSession.current) {
      lastSession.current = detail.session.sessionId;
      setPeople(detail.people);
      setTitleDraft(detail.session.title);
      setCampaignDraft(detail.session.campaign ?? detail.session.world.title);
      setNotesDraft(detail.session.notes ?? "");
      setRollBefore(Math.round((detail.session.merge.rollContextBeforeMs ?? 20_000) / 1000));
      setRollAfter(Math.round((detail.session.merge.rollContextAfterMs ?? 10_000) / 1000));
      setShowMapping(false);
    }
  }, [detail]);

  const notesBytes = props.outputs.reduce((sum, file) => sum + file.sizeBytes, 0);
  const notesSignature = props.outputs.map((file) => `${file.name}:${file.sizeBytes}`).join("|");

  useEffect(() => {
    if (!detail) {
      setStorage(null);
      storageSessionRef.current = null;
      return;
    }
    if (storageSessionRef.current !== detail.session.sessionId) {
      storageSessionRef.current = detail.session.sessionId;
      setStorage(null);
    }
    let cancelled = false;
    const sessionId = detail.session.sessionId;
    void api<SessionStorageReport>(`/api/sessions/${sessionId}/storage`)
      .then((report) => {
        if (!cancelled) setStorage(report);
      })
      .catch(() => {
        if (!cancelled) setStorage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [
    tab,
    detail?.session.sessionId,
    detail?.session.status,
    detail?.audio.state,
    detail?.reviewAudio.length,
    detail?.counts.outputs,
    notesSignature
  ]);

  useEffect(() => {
    if (!worldInitialized.current && props.worlds.length > 0) {
      worldInitialized.current = true;
      const preferred =
        props.worlds.find((world) => world.system === "starwarsffg") ??
        props.worlds.find((world) => world.id === "swffg-cartel") ??
        props.worlds[0]!;
      setWorldId(preferred.id);
    }
  }, [props.worlds]);

  const session = detail?.session ?? null;
  const foundryPromptFresh =
    detail?.consentPrompt != null && Date.now() - detail.consentPrompt.promptedAtMs < 24 * 60 * 60_000;
  const canStart =
    Boolean(session) &&
    ["draft", "error"].includes(session!.status) &&
    (session!.consent.confirmed || foundryPromptFresh) &&
    props.botReady &&
    !busy;
  const canProcess = Boolean(session) && !["draft", "joining", "recording", "stopping"].includes(session!.status);

  const addBlankParticipant = () => {
    participantKey.current += 1;
    setParticipants((current) => [
      ...current,
      {
        key: `manual-${participantKey.current}`,
        discordName: "",
        discordUserId: "",
        character: "",
        role: "player",
        consentStatus: "assumed"
      }
    ]);
  };

  const updateParticipant = (index: number, patch: Partial<NewParticipant>) => {
    setParticipants((current) => current.map((person, at) => (at === index ? { ...person, ...patch } : person)));
  };

  const removeParticipant = (index: number) => {
    setParticipants((current) => current.filter((_person, at) => at !== index));
  };

  const copyFromSession = async (sourceId: string) => {
    if (!sourceId) return;
    setCopyingSession(true);
    setCopyNote(null);
    try {
      const source = await api<SessionDetail>(`/api/sessions/${sourceId}`);
      const gm = source.people.find((person) => person.role === "gm");
      if (gm) {
        setGmName(gm.discordName ?? gm.character ?? "GM");
        setGmDiscordId(gm.discordUserId ?? "");
      }
      const copied = source.people
        .filter((person) => person.role !== "gm")
        .map((person) => ({
          key: `copy-${person.personId}-${participantKey.current++}`,
          discordName: person.discordName ?? person.character ?? "",
          discordUserId: person.discordUserId ?? "",
          character: person.character ?? "",
          role: person.role,
          consentStatus: person.consentStatus ?? (person.consent === false ? "opted_out" : "assumed")
        })) satisfies NewParticipant[];
      setParticipants(copied);
      if (source.session.world.id && props.worlds.some((world) => world.id === source.session.world.id)) {
        setWorldId(source.session.world.id);
      }
      setCampaign(source.session.campaign ?? source.session.world.title);
      if (
        source.session.guild?.id &&
        source.session.guild.id === props.guildId &&
        source.session.voiceChannel &&
        props.channels.some((channel) => channel.id === source.session.voiceChannel!.id)
      ) {
        props.onChannel(source.session.voiceChannel.id);
      }
      setCopyNote(
        `Copied ${copied.length} ${copied.length === 1 ? "player" : "players"} and the game details from “${source.session.title}”. Change any character below.`
      );
    } catch (error) {
      setCopyNote(humanMessage(error, "Could not copy that session. Try again."));
    } finally {
      setCopyingSession(false);
    }
  };

  const addSavedPlayer = (key: string) => {
    const entry = directory.find((person) => person.key === key);
    if (!entry) return;
    if (entry.discordUserId && participants.some((person) => person.discordUserId === entry.discordUserId)) {
      setCopyNote(`${entry.discordName ?? "That player"} is already at the table.`);
      return;
    }
    participantKey.current += 1;
    setParticipants((current) => [
      ...current,
      {
        key: `saved-${key}-${participantKey.current}`,
        discordName: entry.discordName ?? entry.foundryUserName ?? entry.characters[0] ?? "",
        discordUserId: entry.discordUserId ?? "",
        character: entry.characters[0] ?? "",
        role: entry.roles.includes("gm") ? "gm" : entry.roles[0] ?? "player",
        consentStatus: entry.consent
      }
    ]);
    setCopyNote(`Added ${entry.discordName ?? "saved player"} from the directory.`);
  };

  const create = async () => {
    const participantPayload: Array<Record<string, unknown>> = [];
    if (gmDiscordId.trim() || gmName.trim()) {
      participantPayload.push({
        discordUserId: gmDiscordId.trim() || undefined,
        discordName: gmName.trim() || "GM",
        role: "gm",
        consent: true
      });
    }
    for (const person of participants) {
      const name = person.discordName.trim() || person.character.trim();
      if (!name) continue;
      participantPayload.push({
        discordUserId: person.discordUserId.trim() || undefined,
        discordName: name,
        character: person.character.trim() || undefined,
        role: person.role,
        consent: person.consentStatus !== "opted_out",
        consentStatus: person.consentStatus
      });
    }
    const created = await props.onCreate({
      title: title.trim() || undefined,
      campaign: campaign.trim() || undefined,
      worldId: worldId || undefined,
      guildId: props.guildId || undefined,
      voiceChannelId: props.channelId || undefined,
      guildName: props.guilds.find((guild) => guild.id === props.guildId)?.name,
      voiceChannelName: props.channels.find((channel) => channel.id === props.channelId)?.name,
      participants: participantPayload,
      consent: { confirmed: consent, confirmedBy: consentBy, notes: "Consent recorded from the dashboard." },
      notes
    });
    if (created === false) return;
    setShowCreate(false);
    setTitle("");
    setCampaign("");
    setParticipants([]);
    setCopyNote(null);
    setNotes("");
    setConsent(false);
  };

  const saveMapping = async () => {
    if (!detail) return;
    const updated = await props.onSavePeople(detail.session.sessionId, people);
    if (updated) setPeople(updated);
  };

  const applyRoster = (index: number, profileId: string) => {
    const profile = props.roster.find((item) => item.profileId === profileId);
    if (!profile) return;
    const next = [...people];
    const current = next[index];
    if (!current) return;
    next[index] = {
      ...current,
      role: profile.role,
      discordUserId: profile.discordUserId,
      discordName: profile.discordName,
      foundryUserId: profile.foundryUserId,
      foundryUserName: profile.foundryUserName,
      character: profile.character,
      aliases: profile.aliases
    };
    setPeople(next);
  };

  const addVoiceMember = (member: VoiceMember) => {
    if (people.some((person) => person.discordUserId === member.userId)) return;
    const profile = props.roster.find((item) => item.discordUserId === member.userId);
    setPeople([
      ...people,
      {
        personId: "",
        role: profile?.role ?? "player",
        discordUserId: member.userId,
        discordName: profile?.discordName ?? member.displayName,
        foundryUserId: profile?.foundryUserId ?? null,
        foundryUserName: profile?.foundryUserName ?? null,
        character: profile?.character ?? null,
        aliases: profile?.aliases ?? [],
        consent: true
      }
    ]);
  };

  const foundryUsers = detail?.foundryLive?.roster?.users ?? [];
  const foundryActors = detail?.foundryLive?.roster?.actors ?? [];

  const applyFoundryUser = (index: number, userId: string) => {
    const user = foundryUsers.find((item) => item.id === userId);
    if (!user) return;
    const next = [...people];
    const current = next[index];
    if (!current) return;
    next[index] = {
      ...current,
      foundryUserId: user.id,
      foundryUserName: user.name,
      character: user.characterName ?? current.character
    };
    setPeople(next);
  };

  const matchFoundryNames = () => {
    const normalize = (value: string | null) => (value ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    let matched = 0;
    const next = people.map((person) => {
      if (person.foundryUserId || !person.discordName) return person;
      const target = normalize(person.discordName);
      const user = foundryUsers.find((item) => {
        const candidate = normalize(item.name);
        return candidate.length >= 3 && (candidate === target || candidate.includes(target) || target.includes(candidate));
      });
      if (!user) return person;
      matched += 1;
      return {
        ...person,
        foundryUserId: user.id,
        foundryUserName: user.name,
        character: user.characterName ?? person.character
      };
    });
    setPeople(next);
    setFoundryMatchMessage(
      matched === 0
        ? "No clear matches. Pick a Foundry user from the lookup column instead."
        : `Matched ${matched} ${matched === 1 ? "person" : "people"} by name. Check the result and save.`
    );
  };

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
        .slice(0, 40)
    : [];

  const sessionLengthMs =
    session?.startedAtMs && session?.stoppedAtMs ? session.stoppedAtMs - session.startedAtMs : 0;
  const builtAtMs = props.outputs.length > 0 ? Math.max(...props.outputs.map((file) => file.modifiedAtMs)) : null;
  const notesFresh = props.outputs.length > 0 && !detail?.outputsStale;
  const grouped = FILE_GROUPS.map((group) => ({
    ...group,
    present: group.files.filter(([name]) => props.outputs.some((file) => file.name === name))
  }));
  const knownNames = new Set(FILE_GROUPS.flatMap((group) => group.files.map(([name]) => name)));
  const otherFiles = props.outputs.filter((file) => !knownNames.has(file.name));
  const optedOut = detail?.people.filter(personIsOptedOut) ?? [];
  const SPEAKER_COLORS = ["#45d6c3", "#f5b942", "#a78bfa", "#60a5fa", "#f472b6", "#34d399", "#fb923c", "#94a3b8"];
  const speakerColorByUser = new Map<string, string>();
  if (detail) {
    for (const person of detail.people) {
      if (person.discordUserId && !speakerColorByUser.has(person.discordUserId)) {
        speakerColorByUser.set(person.discordUserId, SPEAKER_COLORS[speakerColorByUser.size % SPEAKER_COLORS.length]!);
      }
    }
    for (const utterance of detail.utterances) {
      if (!speakerColorByUser.has(utterance.discordUserId)) {
        speakerColorByUser.set(utterance.discordUserId, SPEAKER_COLORS[speakerColorByUser.size % SPEAKER_COLORS.length]!);
      }
    }
  }
  const reviewStartMs = detail?.session.startedAtMs ?? detail?.utterances[0]?.startMs ?? 0;
  const reviewSegments = (detail?.utterances ?? [])
    .map((utterance) => ({
      startMs: utterance.startMs - reviewStartMs,
      endMs: utterance.endMs - reviewStartMs,
      color: speakerColorByUser.get(utterance.discordUserId) ?? SPEAKER_COLORS[0]!,
      label: utterance.displayName
    }))
    .filter((segment) => segment.endMs > 0);
  const markerColors: Record<string, string> = {
    scene: "#f5b942",
    break: "#60a5fa",
    combat: "#f472b6",
    note: "#a78bfa",
    mental_note: "#34d399"
  };
  const reviewMarkers = (detail?.markers ?? [])
    .map((marker) => ({
      offsetMs: marker.tsMs - reviewStartMs,
      label: marker.label || marker.kind,
      kind: marker.kind,
      color: markerColors[marker.kind] ?? "#94a3b8"
    }))
    .filter((marker) => marker.offsetMs >= 0);
  const reviewLegend = detail
    ? [...speakerColorByUser.entries()].map(([userId, color]) => ({
        userId,
        color,
        name:
          detail.people.find((person) => person.discordUserId === userId)?.discordName ??
          detail.utterances.find((utterance) => utterance.discordUserId === userId)?.displayName ??
          userId
      }))
    : [];
  const campaignOf = (item: SessionSummary): string =>
    item.campaign?.trim() || item.world.title?.trim() || "Unsorted";
  const campaignNames = [...new Set(props.sessions.map(campaignOf))].sort((a, b) => a.localeCompare(b));
  const visibleSessions =
    campaignFilter === "all" ? props.sessions : props.sessions.filter((item) => campaignOf(item) === campaignFilter);
  const campaignGroups = new Map<string, SessionSummary[]>();
  for (const item of visibleSessions) {
    const key = campaignOf(item);
    const list = campaignGroups.get(key) ?? [];
    list.push(item);
    campaignGroups.set(key, list);
  }
  const availableDirectory = directory.filter(
    (entry) => !entry.discordUserId || !participants.some((person) => person.discordUserId === entry.discordUserId)
  );
  const renderSessionRow = (item: SessionSummary) => (
    <button
      key={item.sessionId}
      className={`session-row ${props.selectedId === item.sessionId ? "active" : ""}`}
      onClick={() => {
        setMobilePane("detail");
        props.onSelect(item.sessionId);
      }}
    >
      <div>
        <strong>{item.title}</strong>
        <div className="muted tiny">
          {formatDate(item.createdAtMs)} · {systemName(item.system.id)}
          {item.startedAtMs && item.stoppedAtMs ? ` · ${formatLength(item.stoppedAtMs - item.startedAtMs)}` : ""}
        </div>
      </div>
      <div className="button-row">
        {item.archived && <Pill tone="idle">archived</Pill>}
        <Pill tone={statusTone(item.status)}>{sessionStatusLabel(item.status)}</Pill>
      </div>
    </button>
  );

  return (
    <div className="page">
      <div className="page-heading">
        <div>
          <h1>Sessions</h1>
          <p className="muted">Every recording, with its people, rolls, and notes.</p>
        </div>
        <Button variant="primary" onClick={() => setShowCreate((value) => !value)}>
          {showCreate ? "Close" : "New session"}
        </Button>
      </div>

      {showCreate && (
        <Card title="New session" subtitle="One session per recording. Fill in less, reuse more.">
          <div className="session-starter">
            <div>
              <strong>Start from a previous session</strong>
              <p className="muted small">
                Copies the game, world, and table so you can keep the same group and change only the character that changed.
              </p>
            </div>
            <select
              value=""
              disabled={copyingSession}
              aria-label="Start from a previous session"
              onChange={(event) => void copyFromSession(event.target.value)}
            >
              <option value="">{copyingSession ? "Loading players…" : "Choose a past session…"}</option>
              {props.sessions.map((item) => (
                <option key={item.sessionId} value={item.sessionId}>
                  {item.title} — {campaignOf(item)}
                </option>
              ))}
            </select>
            {copyNote && <p className={copyNote.startsWith("Copied") || copyNote.startsWith("Added") ? "muted small" : "bad-text small"}>{copyNote}</p>}
          </div>

          <div className="form-grid">
            <Field label="Title" hint="Leave empty to use the world name and today's date.">
              <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Session 7" />
            </Field>
            <Field label="Foundry world" hint={props.worlds.length === 0 ? "Choose your Foundry folder in Setup first." : undefined}>
              <select value={worldId} onChange={(event) => setWorldId(event.target.value)}>
                <option value="">No world</option>
                {props.worlds.map((world) => (
                  <option key={world.id} value={world.id}>
                    {world.title} — {world.system} {world.systemVersion}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="Game / campaign" hint="Sessions with the same name are grouped together. Leave blank to use the world title.">
              <input value={campaign} onChange={(event) => setCampaign(event.target.value)} placeholder="Game or campaign" />
            </Field>
            <Field label="Discord server">
              <select value={props.guildId} onChange={(event) => props.onGuild(event.target.value)}>
                <option value="">No server</option>
                {props.guilds.map((guild) => (
                  <option key={guild.id} value={guild.id}>{guild.name}</option>
                ))}
              </select>
            </Field>
            <Field label="Voice channel">
              <select value={props.channelId} onChange={(event) => props.onChannel(event.target.value)}>
                <option value="">No channel</option>
                {props.channels.map((channel) => (
                  <option key={channel.id} value={channel.id}>{channel.name}</option>
                ))}
              </select>
            </Field>
          </div>

          <section className="create-people">
            <div className="create-people-head">
              <div>
                <h3>Players at the table</h3>
                <p className="muted small">
                  Pick a saved player or copy a past session. Change a character where the player swapped; the Discord ID stays matched.
                </p>
              </div>
              <Button variant="ghost small" disabled={Boolean(busy)} onClick={addBlankParticipant}>
                Add blank row
              </Button>
            </div>

            <div className="form-grid">
              <Field label="GM name">
                <input value={gmName} onChange={(event) => setGmName(event.target.value)} placeholder="Your name" />
              </Field>
              <Field label="GM Discord ID" hint="Optional. It helps match your voice to you.">
                <input value={gmDiscordId} onChange={(event) => setGmDiscordId(event.target.value)} placeholder="123456789012345678" />
              </Field>
            </div>

            {participants.length === 0 ? (
              <p className="muted small participant-empty">
                No players added yet. Copy a past session above, add a saved player, or use a blank row.
              </p>
            ) : (
              <div className="participant-editor">
                <div className="participant-header" aria-hidden="true">
                  <span>Name</span>
                  <span>Discord ID (optional)</span>
                  <span>Character</span>
                  <span>Role</span>
                  <span />
                </div>
                {participants.map((person, index) => (
                  <div className="participant-row" key={person.key}>
                    <input
                      value={person.discordName}
                      onChange={(event) => updateParticipant(index, { discordName: event.target.value })}
                      placeholder="Name"
                      aria-label={`Name for player ${index + 1}`}
                    />
                    <input
                      value={person.discordUserId}
                      onChange={(event) => updateParticipant(index, { discordUserId: event.target.value })}
                      placeholder="Optional"
                      aria-label={`Discord ID for player ${index + 1}`}
                      className="mono"
                    />
                    <input
                      value={person.character}
                      onChange={(event) => updateParticipant(index, { character: event.target.value })}
                      placeholder="Character"
                      aria-label={`Character for player ${index + 1}`}
                    />
                    <select
                      value={person.role}
                      onChange={(event) => updateParticipant(index, { role: event.target.value as Person["role"] })}
                      aria-label={`Role for player ${index + 1}`}
                    >
                      <option value="player">Player</option>
                      <option value="observer">Observer</option>
                      <option value="gm">GM</option>
                    </select>
                    <Button variant="ghost small" title="Remove from this session" onClick={() => removeParticipant(index)}>
                      ×
                    </Button>
                  </div>
                ))}
              </div>
            )}

            <div className="participant-add">
              <select
                value=""
                disabled={Boolean(busy) || availableDirectory.length === 0}
                aria-label="Add a saved player"
                onChange={(event) => addSavedPlayer(event.target.value)}
              >
                <option value="">
                  {directory.length === 0 ? "No saved players yet" : availableDirectory.length === 0 ? "Everyone saved is already here" : "Add a saved player…"}
                </option>
                {availableDirectory.map((entry) => (
                  <option key={entry.key} value={entry.key}>
                    {entry.discordName ?? entry.foundryUserName ?? entry.characters[0] ?? "Unnamed"}{entry.characters[0] ? ` — ${entry.characters[0]}` : ""}{entry.consent === "opted_out" ? " (opted out)" : ""}
                  </option>
                ))}
              </select>
              <span className="muted tiny">
                Saved players come from People and earlier sessions. You can also add people from the voice channel after recording starts.
              </span>
            </div>
          </section>

          <Field label="Notes">
            <textarea rows={2} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="Premise, house rules, anything to remember." />
          </Field>

          <div className="consent-line">
            <label className="checkbox">
              <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
              <span>I have shown players the recording notice and they are happy to be recorded unless they opt out.</span>
            </label>
            <div className="consent-line-detail">
              <Field label="Recorded by" hint="Your name, for the consent record.">
                <input value={consentBy} onChange={(event) => setConsentBy(event.target.value)} />
              </Field>
              <Disclosure summary="Read the notice">
                <p className="small">{CONSENT_NOTICE_TEXT}</p>
              </Disclosure>
            </div>
          </div>

          <div className="button-row">
            <Button variant="primary" disabled={Boolean(busy)} onClick={() => void create()}>Create session</Button>
            <span className="muted small">
              {consent ? "The notice will be recorded with this session." : "You can confirm the notice before you start recording."}
            </span>
          </div>
        </Card>
      )}

      <div className={`sessions-layout ${mobilePane === "list" ? "show-list" : "show-detail"}`}>
        <Card
          title="Games"
          subtitle={`${campaignNames.length} ${campaignNames.length === 1 ? "game" : "games"} · ${props.sessions.length} recordings`}
          className="session-list-card"
        >
          {props.sessions.length === 0 ? (
            <Empty title="No sessions yet">Create a session, or run <code>npm run demo</code> for sample data.</Empty>
          ) : (
            <>
              <label className="field session-filter">
                <span>Filter</span>
                <select value={campaignFilter} onChange={(event) => setCampaignFilter(event.target.value)}>
                  <option value="all">All games ({props.sessions.length})</option>
                  {campaignNames.map((name) => (
                    <option key={name} value={name}>
                      {name} ({props.sessions.filter((item) => campaignOf(item) === name).length})
                    </option>
                  ))}
                </select>
              </label>
              {[...campaignGroups.entries()].map(([name, items]) => (
                <details className="session-group" key={name} open>
                  <summary>
                    <strong>{name}</strong>
                    <span className="muted tiny">{items.length}</span>
                  </summary>
                  <div className="session-list">{items.map((item) => renderSessionRow(item))}</div>
                </details>
              ))}
            </>
          )}
        </Card>

        <div className="session-detail">
          <button className="pane-back" onClick={() => setMobilePane("list")}>← All games</button>
          {!session || !detail ? (
            <Card title="Session"><Empty title="Select a session" /></Card>
          ) : (
            <Card
              title={session.title}
              subtitle={`${session.campaign?.trim() || session.world.title} · ${formatDate(session.createdAtMs, session.timeZone)} · ${detail.people.length} ${detail.people.length === 1 ? "person" : "people"}`}
              actions={
                <div className="button-row">
                  <Pill tone={statusTone(session.status)}>{sessionStatusLabel(session.status)}</Pill>
                  {storage && <Pill tone="idle">{formatBytes(storage.totalBytes)}</Pill>}
                  {detail.outputsStale && <Pill tone="warn">files out of date</Pill>}
                  {["recording", "joining"].includes(session.status) ? (
                    <Button variant="danger" disabled={Boolean(busy)} onClick={() => props.onStop(session.sessionId)}>Stop and save</Button>
                  ) : ["draft", "error"].includes(session.status) ? (
                    <Button variant="primary" disabled={!canStart} onClick={() => props.onStart(session.sessionId)}>Start recording</Button>
                  ) : session.status === "processing" ? (
                    <span className="muted small">Processing…</span>
                  ) : session.status === "stopping" ? (
                    <span className="muted small">Saving…</span>
                  ) : notesFresh ? (
                    <Button variant="ghost" onClick={() => void fetch(`/api/sessions/${session.sessionId}/open-folder`, { method: "POST" })}>Open folder</Button>
                  ) : (
                    <Button variant="primary" disabled={!canProcess || Boolean(busy)} onClick={() => props.onEnqueue(session.sessionId, "run_all")}>Build notes</Button>
                  )}
                  <Button variant="ghost" onClick={() => void navigator.clipboard.writeText(session.sessionId).catch(() => undefined)} title="Copy this ID for the Foundry module">
                    Copy ID
                  </Button>
                  <Button variant="ghost" onClick={() => props.onArchive(session.sessionId, !session.archived)}>
                    {session.archived ? "Restore" : "Archive"}
                  </Button>
                </div>
              }
            >
              <div className="tabs">
                {(["overview", "stats", "people", "rolls", "files", "activity"] as SessionsTab[]).map((item) => (
                  <button key={item} className={tab === item ? "active" : ""} onClick={() => props.onTab(item)}>
                    {item === "rolls" ? "Rolls" : item.charAt(0).toUpperCase() + item.slice(1)}
                  </button>
                ))}
              </div>
              {["draft", "error"].includes(session.status) && !canStart && (
                <p className="muted small">
                  {!props.botReady
                    ? "Start needs the Discord bot. Check Setup."
                    : !(session.consent.confirmed || foundryPromptFresh)
                      ? "Show players the recording notice first, then confirm it under Recording consent."
                      : !session.voiceChannel
                        ? "Choose a voice channel for this session before starting."
                        : "Starting is unavailable right now."}
                </p>
              )}

              {tab === "overview" && (
                <div className="tab-body">
                  {!notesFresh && ["ready", "processing"].includes(session.status) && (
                    <div className="callout">
                      <div>
                        <strong>{props.outputs.length === 0 ? "Notes have not been built yet." : "Notes are out of date."}</strong>
                        <p className="small">
                          {props.outputs.length === 0
                            ? "Build them from the recording and the Foundry rolls."
                            : (detail.outputsStaleReason ?? "The session has changed since the notes were written.")}
                        </p>
                      </div>
                      <Button variant="primary" disabled={!canProcess || Boolean(busy)} onClick={() => props.onEnqueue(session.sessionId, "run_all")}>
                        Build notes
                      </Button>
                    </div>
                  )}

                  <div className="session-facts">
                    <Stat label="Recorded" value={sessionLengthMs > 0 ? formatLength(sessionLengthMs) : "—"} sub={session.startedAtMs ? formatDateTime(session.startedAtMs, session.timeZone) : undefined} />
                    <Stat label="People" value={detail.people.length} sub={optedOut.length > 0 ? `${optedOut.length} not recorded` : undefined} />
                    <Stat label="Rolls" value={detail.foundryLive?.messageCount ?? detail.foundrySummary?.rollCount ?? 0} sub={detail.foundryLive ? "live from Foundry" : detail.foundrySummary ? "from the export" : undefined} />
                    <Stat
                      label="Notes"
                      value={notesFresh ? "Built" : props.outputs.length > 0 ? "Out of date" : "Not built"}
                      sub={props.outputs.length > 0 ? `${formatBytes(notesBytes)}${builtAtMs ? ` · ${formatRelative(builtAtMs)}` : ""}` : builtAtMs ? formatRelative(builtAtMs) : undefined}
                    />
                  </div>
                  <p className="muted small session-data">
                    {detail.counts.utterances.toLocaleString()} clips · {detail.counts.transcriptRecords.toLocaleString()} transcripts ·{" "}
                    {detail.counts.foundryEvents.toLocaleString()} Foundry events · {detail.counts.timelineEvents.toLocaleString()} timeline events ·{" "}
                    {formatBytes(detail.counts.audioBytes)} audio
                  </p>

                  {props.llmEnabled && (
                    <div className="ai-summary-panel">
                      <div className="ai-summary-panel-head">
                        <div>
                          <strong>AI summary</strong>
                          <p className="muted small">Optional. Saved separately from the notes files.</p>
                        </div>
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
                        {props.llmScope === "recent" && (
                          <label className="field compact-field">
                            <span>Window</span>
                            <select
                              aria-label="Summary window"
                              value={props.recentSeconds}
                              onChange={(event) => props.onRecentSeconds(Number(event.target.value))}
                            >
                              {SUMMARY_WINDOWS.map((seconds) => (
                                <option key={seconds} value={seconds}>{summaryWindowLabel(seconds)}</option>
                              ))}
                            </select>
                          </label>
                        )}
                        <Button
                          variant="primary"
                          disabled={Boolean(busy) || !props.llmConfigured || ["draft", "joining", "stopping"].includes(session.status)}
                          title={!props.llmConfigured ? "Configure an AI provider in Setup first" : undefined}
                          onClick={() => props.onLlmSummary(session.sessionId, props.recentSeconds)}
                        >
                          {busy === "llm" ? "Summarizing…" : "Summarize"}
                        </Button>
                      </div>
                      {props.llmScope !== "recent" && (
                        <p className="muted small">Uses the selected scope. No window applies.</p>
                      )}
                      {!props.llmConfigured && (
                        <p className="warn-text small">Configure an AI provider and model in Setup, then reload this session.</p>
                      )}
                      {props.llmSummaries.length > 0 && (
                        <Disclosure summary={`Saved summaries (${props.llmSummaries.length})`}>
                          <div className="llm-history">
                            {props.llmSummaries.map((item) => (
                              <button className="llm-history-row" key={item.summaryId} onClick={() => props.onOpenLlmSummary(item)}>
                                <span>
                                  <strong>{summaryPresetLabel(item.preset)}</strong>
                                  <span className="muted tiny"> · {item.window.label}</span>
                                </span>
                                <span className="muted tiny">
                                  {item.model} · {formatRelative(item.createdAtMs)}
                                  {item.chunks > 1 ? ` · ${item.chunks} portions` : item.trimmed ? " · trimmed" : ""}
                                </span>
                              </button>
                            ))}
                          </div>
                        </Disclosure>
                      )}
                    </div>
                  )}

                  {storage ? (
                    <div className="storage-summary">
                      <div className="storage-summary-head">
                        <div>
                          <strong>Session {formatBytes(storage.totalBytes)}</strong>
                          <span className="muted small">
                            {" "}
                            on disk · {storage.totalFiles.toLocaleString()} files
                          </span>
                        </div>
                        <span className="muted small">
                          Notes {formatBytes(storage.categories.find((category) => category.id === "outputs")?.bytes ?? notesBytes)}
                        </span>
                      </div>
                      <div className="storage-bar" role="img" aria-label="Session storage by category">
                        {storage.categories
                          .filter((category) => category.bytes > 0)
                          .map((category) => (
                            <span
                              key={category.id}
                              style={{
                                width: `${Math.max(1, (category.bytes / Math.max(1, storage.totalBytes)) * 100)}%`,
                                background: STORAGE_COLORS[category.id] ?? STORAGE_COLORS.other
                              }}
                              title={`${category.label}: ${formatBytes(category.bytes)}`}
                            />
                          ))}
                      </div>
                      <div className="storage-legend">
                        {storage.categories
                          .filter((category) => category.bytes > 0)
                          .map((category) => (
                            <span key={category.id}>
                              <i style={{ background: STORAGE_COLORS[category.id] ?? STORAGE_COLORS.other }} />
                              {category.label} <strong>{formatBytes(category.bytes)}</strong>
                            </span>
                          ))}
                      </div>
                    </div>
                  ) : (
                    <p className="muted small">Measuring session size…</p>
                  )}

                  <h3>Recording consent</h3>
                  <div className="consent-summary">
                    <p className="small">
                      Everyone at the table is recorded unless they opt out.{" "}
                      {session.consent.confirmed
                        ? `Confirmed by ${session.consent.confirmedBy ?? "the GM"} on ${formatDateTime(session.consent.confirmedAtMs, session.timeZone)}${session.consent.method === "foundry" ? " after the Foundry notice." : "."}`
                        : foundryPromptFresh
                          ? `The Foundry notice was sent on ${formatDateTime(detail.consentPrompt?.promptedAtMs, session.timeZone)}.`
                          : "Not yet confirmed."}
                    </p>
                    {optedOut.length > 0 && (
                      <div className="consent-optouts">
                        <strong>Not recorded:</strong>
                        {optedOut.map((person) => (
                          <span key={person.personId}>
                            {displayPerson(person)} — {personConsentStatus(person)}
                          </span>
                        ))}
                      </div>
                    )}
                    <div className="button-row">
                      {!session.consent.confirmed && (
                        <Button
                          variant="small"
                          onClick={() =>
                            props.onUpdate(session.sessionId, {
                              consent: {
                                confirmed: true,
                                confirmedBy: session.consent.confirmedBy ?? "GM",
                                notes: session.consent.notes,
                                method: "gm_tick",
                                noticeVersion: "2026-11-01"
                              }
                            })
                          }
                        >
                          I have shown the notice
                        </Button>
                      )}
                      <Disclosure summary="Read the full notice">
                        <p className="small">{CONSENT_NOTICE_TEXT}</p>
                        {session.consent.notes && <p className="muted small">{session.consent.notes}</p>}
                      </Disclosure>
                    </div>
                  </div>

                  <Disclosure summary="Speech around rolls" className="inline-settings">
                    <p className="muted small">
                      When the notes are built, speech near a roll is attached to it. Changing this only affects the next build.
                    </p>
                    <div className="form-grid">
                      <Field label="Speech before a roll (seconds)" hint="How much speech before a roll is attached to it.">
                        <input type="number" min={0} max={300} value={rollBefore} onChange={(event) => setRollBefore(Number(event.target.value))} />
                      </Field>
                      <Field label="Speech after a roll (seconds)" hint="How much speech after a roll is attached to it.">
                        <input type="number" min={0} max={300} value={rollAfter} onChange={(event) => setRollAfter(Number(event.target.value))} />
                      </Field>
                    </div>
                    <div className="button-row">
                      <Button variant="small" disabled={Boolean(busy)} onClick={() => props.onMergeSettings(session.sessionId, Math.round(rollBefore * 1000), Math.round(rollAfter * 1000))}>
                        Save roll timing
                      </Button>
                    </div>
                  </Disclosure>

                  <h3>Your notes</h3>
                  <Field label="Session notes" hint="Written into the session and included in the notes.">
                    <textarea
                      rows={5}
                      value={notesDraft}
                      onChange={(event) => setNotesDraft(event.target.value)}
                      placeholder="NPCs, clues, rulings, what to follow up next time…"
                    />
                  </Field>
                  <div className="button-row">
                    <Button variant="small" disabled={Boolean(busy) || notesDraft === (session.notes ?? "")} onClick={() => props.onUpdate(session.sessionId, { notes: notesDraft })}>
                      Save notes
                    </Button>
                  </div>

                  <h3>Moments</h3>
                  <MarkerBar
                    label={props.markerLabel}
                    onLabelChange={props.onMarkerLabel}
                    disabled={Boolean(busy)}
                    onAdd={(kind, mentalNote) => props.onMarker(session.sessionId, kind, mentalNote)}
                  />
                  <MomentList
                    moments={moments.slice(0, 15)}
                    timeZone={session.timeZone}
                    onDelete={(markerId) => props.onDeleteMarker(session.sessionId, markerId)}
                    empty="No moments marked yet."
                  />

                  <Disclosure summary="Advanced settings and danger zone" className="advanced-block">
                    <div className="form-grid">
                      {["draft", "error"].includes(session.status) && (
                        <Field label="Session title" hint="Shown in the recording list.">
                          <div className="token-row">
                            <input value={titleDraft} onChange={(event) => setTitleDraft(event.target.value)} maxLength={200} />
                            <Button
                              variant="small"
                              disabled={Boolean(busy) || !titleDraft.trim() || titleDraft === session.title}
                              onClick={() => props.onUpdate(session.sessionId, { title: titleDraft })}
                            >
                              Save
                            </Button>
                          </div>
                        </Field>
                      )}
                      <Field label="Foundry version">
                        <input readOnly value={session.foundryVersion ?? "unknown"} />
                      </Field>
                    </div>
                    <div className="form-grid">
                      <Field label="Game / campaign" hint="Sessions with the same name are grouped in the list.">
                        <div className="token-row">
                          <input
                            value={campaignDraft}
                            onChange={(event) => setCampaignDraft(event.target.value)}
                            maxLength={120}
                          />
                          <Button
                            variant="small"
                            disabled={Boolean(busy) || !campaignDraft.trim() || campaignDraft === (session.campaign ?? session.world.title)}
                            onClick={() => props.onUpdate(session.sessionId, { campaign: campaignDraft })}
                          >
                            Save
                          </Button>
                        </div>
                      </Field>
                    </div>
                    <div className="form-grid">
                      <Field label="Session ID" hint="Used to target this session from the Foundry module.">
                        <div className="token-row">
                          <input className="mono" readOnly value={session.sessionId} onFocus={(event) => event.target.select()} />
                          <Button variant="small" onClick={() => void navigator.clipboard.writeText(session.sessionId).catch(() => undefined)}>Copy</Button>
                        </div>
                      </Field>
                    </div>
                    <div className="danger-zone">
                      <div>
                        <strong>Delete this session</strong>
                        <p className="muted small">Removes the recording, transcripts, and notes from this computer. This cannot be undone.</p>
                      </div>
                      <Button variant="small danger" onClick={() => props.onDelete(session.sessionId)}>Delete session</Button>
                    </div>
                  </Disclosure>
                </div>
              )}

              {tab === "stats" && (
                <div className="tab-body">
                  <SessionStatsView detail={detail} />
                </div>
              )}

              {tab === "people" && (
                <div className="tab-body">
                  <p className="muted small">
                    Everyone here is recorded unless you untick <strong>Record</strong>. People are matched to their Discord account, which is how their speech is recognised.
                  </p>
                  <label className="checkbox mapping-toggle">
                    <input type="checkbox" checked={showMapping} onChange={(event) => setShowMapping(event.target.checked)} />
                    <span>Show Discord and Foundry IDs</span>
                  </label>
                  <div className="table-wrap">
                    <table className="people-table">
                      <thead>
                        <tr>
                          <th>Person</th>
                          <th>Character</th>
                          {showMapping && <th>Discord name</th>}
                          {showMapping && <th>Discord ID</th>}
                          <th>Foundry user</th>
                          {showMapping && <th>Foundry ID</th>}
                          <th>Role</th>
                          <th>Record</th>
                          <th />
                        </tr>
                      </thead>
                      <tbody>
                        {people.map((person, index) => {
                          const currentProfileId =
                            props.roster.find((profile) => profile.discordUserId === person.discordUserId)?.profileId ?? "";
                          return (
                            <tr key={person.personId || index}>
                              <td>
                                <select
                                  value={currentProfileId}
                                  aria-label="Person"
                                  onChange={(event) => applyRoster(index, event.target.value)}
                                >
                                  <option value={currentProfileId}>
                                    {person.discordName ?? "Unnamed"}{!currentProfileId ? " (not in roster)" : ""}
                                  </option>
                                  {props.roster
                                    .filter((profile) => profile.profileId !== currentProfileId)
                                    .map((profile) => (
                                      <option key={profile.profileId} value={profile.profileId}>
                                        {profile.discordName ?? profile.discordUserId}
                                        {profile.character ? ` — ${profile.character}` : ""}
                                      </option>
                                    ))}
                                </select>
                              </td>
                              <td>
                                <input
                                  value={person.character ?? ""}
                                  list={foundryActors.length > 0 ? `foundry-actors-${index}` : undefined}
                                  placeholder={foundryActors.length > 0 ? "Pick or type" : "Character"}
                                  onChange={(event) => {
                                    const next = [...people];
                                    next[index] = { ...person, character: event.target.value || null };
                                    setPeople(next);
                                  }}
                                />
                                {foundryActors.length > 0 && (
                                  <datalist id={`foundry-actors-${index}`}>
                                    {foundryActors.map((actor) => (
                                      <option key={actor.id} value={actor.name}>
                                        {actor.type}
                                        {actor.hasPlayerOwner ? " · player-owned" : ""}
                                      </option>
                                    ))}
                                  </datalist>
                                )}
                              </td>
                              {showMapping && (
                                <td>
                                  <input
                                    value={person.discordName ?? ""}
                                    onChange={(event) => {
                                      const next = [...people];
                                      next[index] = { ...person, discordName: event.target.value || null };
                                      setPeople(next);
                                    }}
                                  />
                                </td>
                              )}
                              {showMapping && (
                                <td>
                                  <input
                                    value={person.discordUserId ?? ""}
                                    onChange={(event) => {
                                      const next = [...people];
                                      next[index] = { ...person, discordUserId: event.target.value || null };
                                      setPeople(next);
                                    }}
                                  />
                                </td>
                              )}
                              <td>
                                <select
                                  value={person.foundryUserId ?? ""}
                                  disabled={foundryUsers.length === 0}
                                  aria-label="Foundry user"
                                  onChange={(event) => applyFoundryUser(index, event.target.value)}
                                >
                                  <option value="">{foundryUsers.length === 0 ? "No Foundry directory" : "— pick user —"}</option>
                                  {foundryUsers.map((user) => (
                                    <option key={user.id} value={user.id}>
                                      {user.name}
                                      {user.characterName ? ` — ${user.characterName}` : ""}
                                      {user.isGM ? " (GM)" : ""}
                                    </option>
                                  ))}
                                </select>
                              </td>
                              {showMapping && (
                                <td>
                                  <input
                                    value={person.foundryUserId ?? ""}
                                    onChange={(event) => {
                                      const next = [...people];
                                      next[index] = { ...person, foundryUserId: event.target.value || null };
                                      setPeople(next);
                                    }}
                                  />
                                </td>
                              )}
                              <td>
                                <select
                                  value={person.role}
                                  aria-label="Role"
                                  onChange={(event) => {
                                    const next = [...people];
                                    next[index] = { ...person, role: event.target.value as Person["role"] };
                                    setPeople(next);
                                  }}
                                >
                                  <option value="gm">GM</option>
                                  <option value="player">Player</option>
                                  <option value="observer">Observer</option>
                                </select>
                              </td>
                              <td>
                                <label className="checkbox" title={personIsOptedOut(person) ? "Opted out — not recorded" : "Recording"}>
                                  <input
                                    type="checkbox"
                                    checked={!personIsOptedOut(person)}
                                    onChange={(event) => {
                                      const next = [...people];
                                      const enabled = event.target.checked;
                                      next[index] = {
                                        ...person,
                                        consent: enabled,
                                        consentStatus: enabled ? "assumed" : "opted_out",
                                        consentSource: "dashboard",
                                        consentUpdatedAtMs: Date.now()
                                      };
                                      setPeople(next);
                                    }}
                                  />
                                  <span className="tiny">{personIsOptedOut(person) ? "opted out" : ""}</span>
                                </label>
                              </td>
                              <td>
                                <Button variant="ghost small" onClick={() => setPeople(people.filter((_, i) => i !== index))} title="Remove this person">×</Button>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>

                  {foundryUsers.length > 0 && (
                    <div className="foundry-directory-row">
                      <span className="muted small">
                        Foundry directory: {foundryUsers.length} {foundryUsers.length === 1 ? "user" : "users"} · {foundryActors.length}{" "}
                        {foundryActors.length === 1 ? "character" : "characters"}
                        {detail.foundryLive?.lastSeenAtMs ? ` · last update ${formatRelative(detail.foundryLive.lastSeenAtMs)}` : ""}
                      </span>
                      <Button variant="small" onClick={matchFoundryNames}>Match names</Button>
                    </div>
                  )}
                  {showMapping && foundryUsers.length === 0 && (
                    <p className="muted small">The Foundry directory has not arrived yet. Keep the GM client open with the module enabled.</p>
                  )}
                  {foundryMatchMessage && <p className="muted small">{foundryMatchMessage}</p>}

                  <div className="voice-people">
                    <div className="card-head">
                      <div>
                        <h3>People in the voice channel</h3>
                        <p className="muted small">Add anyone who was missed. Saved people become options for future sessions.</p>
                      </div>
                      <Button variant="small" disabled={Boolean(busy)} onClick={() => props.onLoadVoiceMembers(session.sessionId)}>
                        {busy === "voice-members" ? "Checking…" : "Refresh"}
                      </Button>
                    </div>
                    {props.voiceMembers.length === 0 ? (
                      <p className="muted small">No one loaded yet. Join the channel, then refresh.</p>
                    ) : (
                      <div className="voice-people-list">
                        {props.voiceMembers.map((member) => {
                          const mapped = people.some((person) => person.discordUserId === member.userId);
                          return (
                            <div className="voice-person" key={member.userId}>
                              <span>{member.displayName}</span>
                              <Button variant="small" disabled={mapped} onClick={() => addVoiceMember(member)}>
                                {mapped ? "Added" : "Add"}
                              </Button>
                            </div>
                          );
                        })}
                      </div>
                    )}
                  </div>

                  <div className="button-row">
                    <Button
                      variant="small"
                      onClick={() =>
                        setPeople([
                          ...people,
                          {
                            personId: "",
                            role: "player",
                            discordUserId: null,
                            discordName: null,
                            foundryUserId: null,
                            foundryUserName: null,
                            character: null,
                            aliases: [],
                            consent: true
                          }
                        ])
                      }
                    >
                      Add person
                    </Button>
                    <Button variant="primary" disabled={Boolean(busy)} onClick={() => void saveMapping()}>
                      Save people
                    </Button>
                  </div>
                </div>
              )}

              {tab === "rolls" && (
                <div className="tab-body">
                  <div className="button-row">
                    <a className="btn" href="/api/foundry/macro">Download the Foundry macro</a>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".json,application/json"
                      style={{ display: "none" }}
                      onChange={(event) => {
                        const file = event.target.files?.[0];
                        if (!file) return;
                        setImporting(true);
                        void Promise.resolve(props.onImport(session.sessionId, file)).finally(() => setImporting(false));
                        event.target.value = "";
                      }}
                    />
                    <Button disabled={Boolean(busy) || importing} onClick={() => fileRef.current?.click()}>
                      {importing ? "Importing…" : "Import Foundry export"}
                    </Button>
                  </div>
                  <p className="muted small">
                    If the live module is connected, rolls arrive on their own. Otherwise run the macro in Foundry after the
                    last roll and import the file it downloads.
                  </p>

                  {detail.foundrySummary ? (
                    <>
                      <div className="session-facts">
                        <Stat label="Rolls" value={detail.foundrySummary.rollCount} />
                        <Stat label="Roll messages" value={detail.foundrySummary.rollMessageCount} />
                        <Stat label="Chat lines" value={detail.foundrySummary.messageCount} />
                        <Stat label="Outside the session" value={detail.foundrySummary.outOfWindowCount} />
                        <Stat label="Imported" value={formatRelative(detail.foundrySummary.importedAtMs)} />
                      </div>
                      {detail.foundrySummary.warnings.length > 0 && (
                        <div className="warnings">
                          {detail.foundrySummary.warnings.map((warning, index) => (
                            <div className="warning" key={index} title={warning.code}>
                              <span>{warning.message}</span>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  ) : (
                    <Empty title="No Foundry export imported">The macro export keeps FFG narrative-dice symbols intact.</Empty>
                  )}

                  {detail.foundryLive && (
                    <div className="live-foundry">
                      <h3>Live from Foundry</h3>
                      <div className="session-facts">
                        <Stat label="Last update" value={formatRelative(detail.foundryLive.lastSeenAtMs)} />
                        <Stat label="Events" value={detail.foundryLive.messageCount} />
                        <Stat label="Scene" value={detail.foundryLive.scene?.name ?? "—"} />
                        <Stat label="Combat" value={detail.foundryLive.combat?.name ?? "—"} />
                        <Stat label="Module" value={detail.foundryLive.moduleVersion ?? "—"} sub="running client" />
                      </div>
                    </div>
                  )}
                </div>
              )}

              {tab === "files" && (
                <div className="tab-body">
                  {detail.outputsStale && (
                    <div className="callout">
                      <div>
                        <strong>These files are out of date.</strong>
                        <p className="small">{detail.outputsStaleReason ?? "The session changed after they were written."}</p>
                      </div>
                      <Button variant="primary" disabled={!canProcess || Boolean(busy)} onClick={() => props.onEnqueue(session.sessionId, "run_all")}>
                        Rebuild
                      </Button>
                    </div>
                  )}

                  {props.outputs.length === 0 ? (
                    <Empty title="No files yet">Build the notes to create the transcript, roll list, and summaries.</Empty>
                  ) : (
                    grouped.map((group) =>
                      group.present.length === 0 ? null : (
                        <section className="file-group" key={group.id}>
                          <div className="file-group-head">
                            <h3>{group.title}</h3>
                            <p className="muted small">{group.description}</p>
                          </div>
                          {group.present.map(([name, description]) => {
                            const file = props.outputs.find((item) => item.name === name);
                            if (!file) return null;
                            return (
                              <div className="file-row" key={name}>
                                <div>
                                  <strong>{name}</strong>
                                  <div className="muted small">{description}</div>
                                  <div className="muted tiny">{formatBytes(file.sizeBytes)} · {formatRelative(file.modifiedAtMs)}</div>
                                </div>
                                <div className="button-row">
                                  {file.previewable && file.sizeBytes <= 1_500_000 ? (
                                    <Button variant="small" onClick={() => props.onPreview(session.sessionId, name)}>Read</Button>
                                  ) : (
                                    <a className="btn small" href={`/api/sessions/${session.sessionId}/outputs/${name}`} target="_blank" rel="noreferrer">
                                      Open
                                    </a>
                                  )}
                                  <a className="btn small" href={`/api/sessions/${session.sessionId}/outputs/${name}?download=1`} download={name}>
                                    Download
                                  </a>
                                </div>
                              </div>
                            );
                          })}
                        </section>
                      )
                    )
                  )}

                  {otherFiles.length > 0 && (
                    <Disclosure summary={`Other files (${otherFiles.length})`}>
                      {otherFiles.map((file) => (
                        <div className="file-row" key={file.name}>
                          <div>
                            <strong>{file.name}</strong>
                            <div className="muted tiny">{formatBytes(file.sizeBytes)} · {formatRelative(file.modifiedAtMs)}</div>
                          </div>
                          <div className="button-row">
                            <a className="btn small" href={`/api/sessions/${session.sessionId}/outputs/${file.name}`} target="_blank" rel="noreferrer">
                              Open
                            </a>
                            <a className="btn small" href={`/api/sessions/${session.sessionId}/outputs/${file.name}?download=1`} download={file.name}>
                              Download
                            </a>
                          </div>
                        </div>
                      ))}
                    </Disclosure>
                  )}

                  <section className="storage-panel">
                    <div className="card-head">
                      <div>
                        <h3>Storage & cleanup</h3>
                        <p className="muted small">
                          Session folder {storage ? formatBytes(storage.totalBytes) : "…"} · notes {formatBytes(notesBytes)}. Per-clip WAVs are the largest files; compact or remove them after the review mix is saved.
                        </p>
                      </div>
                      <Pill tone={detail.audio.state === "removed" ? "warn" : detail.audio.state === "compacted" ? "ok" : "idle"}>
                        {detail.audio.state === "removed" ? "removed" : detail.audio.state === "compacted" ? "compacted" : "original"}
                      </Pill>
                    </div>
                    <div className="session-facts">
                      <Stat label="Clips" value={detail.audio.clipCount} sub={formatBytes(detail.audio.bytes)} />
                      <Stat
                        label="Review tracks"
                        value={detail.reviewAudio.length}
                        sub={formatBytes(detail.reviewAudio.reduce((sum, file) => sum + file.sizeBytes, 0))}
                      />
                      <Stat
                        label="Transcript"
                        value={detail.counts.transcriptRecords}
                        sub={detail.audio.state === "removed" ? "kept; reused on rebuild" : "kept"}
                      />
                      <Stat label="Notes" value={props.outputs.length} sub={formatBytes(notesBytes)} />
                    </div>
                    {storage && (
                      <>
                        <div className="storage-chips">
                          <strong>Session folder {formatBytes(storage.totalBytes)}</strong>
                          {storage.categories
                            .filter((category) => category.bytes > 0)
                            .map((category) => (
                              <span key={category.id}>{category.label} {formatBytes(category.bytes)}</span>
                            ))}
                        </div>
                        <p className="muted small">
                          {detail.audio.state === "available"
                            ? `Compacting clips would save about ${formatBytes(
                                (storage.categories.find((category) => category.id === "clips")?.bytes ?? 0) * (5 / 6)
                              )}.`
                            : detail.audio.state === "compacted"
                              ? "Clips are compacted; review tracks and transcripts are the remaining large items."
                              : "Clip audio is removed; review tracks and transcripts remain."}
                        </p>
                      </>
                    )}
                    {detail.audio.state === "removed" ? (
                      <p className="muted small">
                        The per-clip audio is gone. The master and per-speaker review tracks are the audio source; rebuilding
                        notes reuses the existing transcript, or cuts windows from those tracks if the transcript is missing.
                      </p>
                    ) : detail.audio.clipCount === 0 ? (
                      <p className="muted small">No per-clip audio is stored for this session.</p>
                    ) : (
                      <>
                        <p className="muted small">
                          Compacting converts clips to 16 kHz mono WAV (about 6x smaller) and keeps playback and
                          transcription working. Removing deletes them entirely; the master and speaker tracks stay.
                        </p>
                        <div className="button-row">
                          {detail.audio.state === "available" && (
                            <Button
                              variant="small"
                              disabled={Boolean(busy)}
                              onClick={() => {
                                if (
                                  !window.confirm(
                                    `Convert ${detail.audio.clipCount.toLocaleString()} clips to 16 kHz mono? This is roughly 6x smaller, and the full-quality review tracks stay available.${detail.reviewAudio.length === 0 ? " The review mix will be built first, which can take a few minutes." : ""}`
                                  )
                                ) {
                                  return;
                                }
                                props.onCompactAudio(session.sessionId);
                              }}
                            >
                              Compact clips
                            </Button>
                          )}
                          <Button
                            variant="small danger"
                            disabled={Boolean(busy)}
                            onClick={() => {
                              if (
                                !window.confirm(
                                  `Delete ${detail.audio.clipCount.toLocaleString()} clip files? The master and per-speaker review tracks are kept, and transcripts/notes remain. This cannot be undone.${detail.reviewAudio.length === 0 ? " The review mix will be built first, which can take a few minutes." : ""}`
                                )
                              ) {
                                return;
                              }
                              props.onRemoveAudio(session.sessionId);
                            }}
                          >
                            Delete clips
                          </Button>
                        </div>
                      </>
                    )}
                  </section>

                  <div className="review-audio">
                    <div className="card-head">
                      <div>
                        <h3>Listen back</h3>
                        <p className="muted small">Built automatically after transcription. The original clips are kept separately.</p>
                      </div>
                      <Button
                        variant="small"
                        disabled={Boolean(busy) || detail.audio.state === "removed"}
                        title={detail.audio.state === "removed" ? "Clip audio was removed; the review tracks are kept" : undefined}
                        onClick={() => {
                          if (
                            detail.counts.utterances > 500 &&
                            !window.confirm(
                              `This session has ${detail.counts.utterances.toLocaleString()} clips. Building review audio can take several minutes and use a lot of disk and CPU. It is processed in batches, but keep the dashboard open. Continue?`
                            )
                          ) {
                            return;
                          }
                          props.onBuildReviewAudio(session.sessionId);
                        }}
                      >
                        {busy === "review-audio" ? "Mixing…" : "Build review audio"}
                      </Button>
                    </div>
                    {detail.counts.utterances > 500 && (
                      <p className="warn-text small">
                        Large session ({detail.counts.utterances.toLocaleString()} clips). The mix is assembled in batches of
                        500, which can take several minutes and use significant disk and CPU. Only the 20 most recent clips
                        are loaded below.
                      </p>
                    )}
                    {detail.reviewAudio.length === 0 ? (
                      <p className="muted small">
                        {detail.audio.state === "removed"
                          ? "The clip audio was removed before a review mix was built; no player tracks are available."
                          : "No review mix yet. It is built automatically after transcription; use the button above to rebuild."}
                      </p>
                    ) : (
                      <>
                        <p className="muted tiny">
                          Master colours follow the active speaker; bookmarks mark scenes, breaks, combat, and notes. Click the waveform or a bookmark to seek.
                        </p>
                        {reviewLegend.length > 0 && (
                          <div className="waveform-legend">
                            {reviewLegend.map((item) => (
                              <span key={item.userId}>
                                <i style={{ background: item.color }} />
                                {item.name}
                              </span>
                            ))}
                          </div>
                        )}
                        <div className="review-tracks">
                          {detail.reviewAudio.map((file) => (
                            <WaveformPlayer
                              key={file.name}
                              src={`/api/sessions/${session.sessionId}/review-audio/${file.name}`}
                              label={file.label}
                              detail={`${formatLength(file.durationMs)} · ${formatBytes(file.sizeBytes)} · ${file.kind === "master" ? "mixed master" : "one speaker"}`}
                              durationMs={file.durationMs}
                              color={file.kind === "master" ? "#45d6c3" : speakerColorByUser.get(file.speakerId ?? "") ?? "#f5b942"}
                              waveformSrc={`/api/sessions/${session.sessionId}/review-audio/${file.name}/waveform`}
                              segments={file.kind === "master" ? reviewSegments : undefined}
                              markers={reviewMarkers}
                            />
                          ))}
                        </div>
                      </>
                    )}
                  </div>

                  <Disclosure summary={`Individual clips (${detail.utterances.length})`} className="clip-block">
                    {detail.utterances.length > 500 && (
                      <p className="warn-text small">
                        Large session. Only the 20 most recent clips are loaded here; open the session folder for the rest.
                        Loading many clips at once can make the browser slow.
                      </p>
                    )}
                    {detail.utterances.length === 0 ? (
                      <p className="muted small">
                        {detail.audio.state === "removed"
                          ? "The per-clip audio was removed; use the review tracks above."
                          : "No clips were captured."}
                      </p>
                    ) : (
                      <>
                        <p className="muted tiny">The 20 most recent clips. Use Open folder for everything.</p>
                        <div className="audio-list">
                          {detail.utterances.slice(-20).reverse().map((utterance) => (
                            <div className="audio-row" key={utterance.utteranceId}>
                              <div>
                                <strong>{utterance.displayName}</strong>
                                <div className="muted tiny">
                                  {formatDateTime(utterance.startMs, session.timeZone)} · {formatLength(utterance.durationMs)} · {formatBytes(utterance.bytes)}
                                </div>
                              </div>
                              <audio controls preload="none" src={`/api/sessions/${session.sessionId}/audio/${utterance.utteranceId}`} />
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </Disclosure>

                  <div className="button-row">
                    <Button variant="ghost" onClick={() => void fetch(`/api/sessions/${session.sessionId}/open-folder`, { method: "POST" })}>Open session folder</Button>
                  </div>
                </div>
              )}

              {tab === "activity" && (
                <div className="tab-body">
                  <JobPanel
                    jobs={props.jobs}
                    canProcess={canProcess}
                    busy={busy}
                    onEnqueue={(type) => props.onEnqueue(session.sessionId, type)}
                    onCancel={props.onCancel}
                    onRetry={props.onRetry}
                    onLogs={props.onLogs}
                  />
                </div>
              )}
            </Card>
          )}
        </div>
      </div>
    </div>
  );
}

