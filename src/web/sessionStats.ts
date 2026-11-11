import type { Person } from "./types";

const TURN_GAP_MS = 3_000;

export interface StatsUtteranceInput {
  utteranceId: string;
  discordUserId: string;
  displayName: string;
  startMs: number;
  endMs: number;
  durationMs: number;
  words?: number;
}

export interface StatsPersonInput {
  personId: string;
  discordUserId: string | null;
  discordName: string | null;
  character: string | null;
  role: Person["role"];
  consentStatus?: Person["consentStatus"];
  consent?: boolean;
}

export interface SpeakerStats {
  key: string;
  discordUserId: string | null;
  name: string;
  character: string | null;
  role: Person["role"];
  consentStatus: "assumed" | "opted_in" | "opted_out";
  utterances: number;
  words: number;
  talkMs: number;
  share: number;
  wordsPerMinute: number | null;
  averageUtteranceMs: number;
  turns: number;
  averageTurnMs: number;
  longestTurnMs: number;
  longestTurnAtMs: number | null;
  shortUtterances: number;
  firstAtMs: number | null;
  lastAtMs: number | null;
}

export interface SessionStats {
  startMs: number | null;
  endMs: number | null;
  durationMs: number;
  speechMs: number;
  silenceMs: number;
  overlapMs: number;
  speechShare: number;
  combinedTalkMs: number;
  utterances: number;
  words: number;
  turns: number;
  wordsPerMinute: number | null;
  speakers: SpeakerStats[];
  mostTalkative: SpeakerStats | null;
  quietest: SpeakerStats | null;
  longestTurn: { speaker: SpeakerStats; durationMs: number; atMs: number } | null;
  rollCount: number;
  mentalNotes: number;
}

interface Interval {
  start: number;
  end: number;
}

function unionAndOverlap(intervals: Interval[]): { unionMs: number; overlapMs: number } {
  const usable = intervals.filter((item) => item.end > item.start).sort((a, b) => a.start - b.start);
  if (usable.length === 0) return { unionMs: 0, overlapMs: 0 };
  let unionMs = 0;
  let overlapMs = 0;
  let currentStart = usable[0]!.start;
  let currentEnd = usable[0]!.end;
  for (const interval of usable.slice(1)) {
    if (interval.start >= currentEnd) {
      unionMs += currentEnd - currentStart;
      currentStart = interval.start;
      currentEnd = interval.end;
    } else {
      currentEnd = Math.max(currentEnd, interval.end);
    }
  }
  unionMs += currentEnd - currentStart;

  const events: Array<{ at: number; delta: number }> = [];
  for (const interval of usable) {
    events.push({ at: interval.start, delta: 1 });
    events.push({ at: interval.end, delta: -1 });
  }
  events.sort((a, b) => a.at - b.at || a.delta - b.delta);
  let count = 0;
  let previous = events[0]?.at ?? 0;
  for (const event of events) {
    if (count >= 2) overlapMs += Math.max(0, event.at - previous);
    count += event.delta;
    previous = event.at;
  }
  return { unionMs, overlapMs };
}

export function computeSessionStats(input: {
  utterances: StatsUtteranceInput[];
  people: StatsPersonInput[];
  startedAtMs: number | null;
  stoppedAtMs: number | null;
  rollCount?: number;
  mentalNotes?: number;
}): SessionStats {
  const utterances = [...input.utterances].sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
  const firstUtteranceMs = utterances[0]?.startMs ?? null;
  const lastUtteranceMs = utterances.reduce<number | null>(
    (latest, utterance) => (latest == null ? utterance.endMs : Math.max(latest, utterance.endMs)),
    null
  );
  const startMs = input.startedAtMs ?? firstUtteranceMs;
  const endMs = input.stoppedAtMs ?? lastUtteranceMs;
  const durationMs = startMs != null && endMs != null ? Math.max(0, endMs - startMs) : 0;

  const speakers = new Map<string, SpeakerStats>();
  const speakerForDiscordId = new Map<string, SpeakerStats>();
  const ensureSpeaker = (key: string, seed: Partial<SpeakerStats> = {}): SpeakerStats => {
    const existing = speakers.get(key);
    if (existing) return existing;
    const next: SpeakerStats = {
      key,
      discordUserId: null,
      name: "Unknown speaker",
      character: null,
      role: "player",
      consentStatus: "assumed",
      utterances: 0,
      words: 0,
      talkMs: 0,
      share: 0,
      wordsPerMinute: null,
      averageUtteranceMs: 0,
      turns: 0,
      averageTurnMs: 0,
      longestTurnMs: 0,
      longestTurnAtMs: null,
      shortUtterances: 0,
      firstAtMs: null,
      lastAtMs: null,
      ...seed
    };
    speakers.set(key, next);
    if (next.discordUserId) speakerForDiscordId.set(next.discordUserId, next);
    return next;
  };

  for (const person of input.people) {
    const key = person.discordUserId ? `discord:${person.discordUserId}` : `person:${person.personId}`;
    ensureSpeaker(key, {
      discordUserId: person.discordUserId,
      name: person.discordName ?? person.character ?? "Unnamed player",
      character: person.character,
      role: person.role,
      consentStatus: person.consentStatus ?? (person.consent === false ? "opted_out" : "assumed")
    });
  }

  let combinedTalkMs = 0;
  let totalWords = 0;
  const intervals: Interval[] = [];
  for (const utterance of utterances) {
    const key = `discord:${utterance.discordUserId}`;
    const speaker =
      speakerForDiscordId.get(utterance.discordUserId) ??
      ensureSpeaker(key, {
        discordUserId: utterance.discordUserId,
        name: utterance.displayName || utterance.discordUserId
      });
    if (!speaker.discordUserId) speaker.discordUserId = utterance.discordUserId;
    const talkMs = Math.max(0, utterance.endMs - utterance.startMs);
    const words = Math.max(0, Math.trunc(utterance.words ?? 0));
    speaker.utterances += 1;
    speaker.talkMs += talkMs;
    speaker.words += words;
    if (talkMs < 1_000) speaker.shortUtterances += 1;
    if (speaker.firstAtMs == null || utterance.startMs < speaker.firstAtMs) speaker.firstAtMs = utterance.startMs;
    if (speaker.lastAtMs == null || utterance.endMs > speaker.lastAtMs) speaker.lastAtMs = utterance.endMs;
    combinedTalkMs += talkMs;
    totalWords += words;
    intervals.push({ start: utterance.startMs, end: utterance.endMs });
  }

  // A turn is consecutive speech by one person, with short gaps merged.
  let turnCount = 0;
  let turnTotalMs = 0;
  let current: { speaker: SpeakerStats; start: number; end: number } | null = null;
  const flushTurn = () => {
    if (!current) return;
    turnCount += 1;
    const duration = Math.max(0, current.end - current.start);
    turnTotalMs += duration;
    current.speaker.turns += 1;
    if (duration > current.speaker.longestTurnMs) {
      current.speaker.longestTurnMs = duration;
      current.speaker.longestTurnAtMs = current.start;
    }
    current = null;
  };
  for (const utterance of utterances) {
    const speaker =
      speakerForDiscordId.get(utterance.discordUserId) ??
      ensureSpeaker(`discord:${utterance.discordUserId}`, {
        discordUserId: utterance.discordUserId,
        name: utterance.displayName || utterance.discordUserId
      });
    if (!current || current.speaker.key !== speaker.key || utterance.startMs - current.end > TURN_GAP_MS) {
      flushTurn();
      current = { speaker, start: utterance.startMs, end: utterance.endMs };
    } else {
      current.end = Math.max(current.end, utterance.endMs);
    }
  }
  flushTurn();

  const { unionMs, overlapMs } = unionAndOverlap(intervals);
  const list = [...speakers.values()];
  for (const speaker of list) {
    speaker.share = combinedTalkMs > 0 ? speaker.talkMs / combinedTalkMs : 0;
    speaker.averageUtteranceMs = speaker.utterances > 0 ? speaker.talkMs / speaker.utterances : 0;
    speaker.averageTurnMs = speaker.turns > 0 ? speaker.talkMs / speaker.turns : 0;
    speaker.wordsPerMinute = speaker.talkMs > 0 ? Math.round((speaker.words / speaker.talkMs) * 60_000) : null;
  }
  list.sort((a, b) => b.talkMs - a.talkMs || a.name.localeCompare(b.name));
  const active = list.filter((speaker) => speaker.utterances > 0);
  const mostTalkative = active[0] ?? null;
  const quietest = active.length > 1 ? active[active.length - 1]! : null;
  const longestTurn = active.reduce<{ speaker: SpeakerStats; durationMs: number; atMs: number } | null>(
    (best, speaker) =>
      speaker.longestTurnMs > 0 && speaker.longestTurnAtMs != null && (!best || speaker.longestTurnMs > best.durationMs)
        ? { speaker, durationMs: speaker.longestTurnMs, atMs: speaker.longestTurnAtMs }
        : best,
    null
  );

  return {
    startMs,
    endMs,
    durationMs,
    speechMs: unionMs,
    silenceMs: Math.max(0, durationMs - unionMs),
    overlapMs,
    speechShare: durationMs > 0 ? unionMs / durationMs : 0,
    combinedTalkMs,
    utterances: utterances.length,
    words: totalWords,
    turns: turnCount,
    wordsPerMinute: unionMs > 0 ? Math.round((totalWords / unionMs) * 60_000) : null,
    speakers: list,
    mostTalkative,
    quietest,
    longestTurn,
    rollCount: input.rollCount ?? 0,
    mentalNotes: input.mentalNotes ?? 0
  };
}
