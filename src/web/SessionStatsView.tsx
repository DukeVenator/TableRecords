import { useMemo, type CSSProperties } from "react";
import type { SessionDetail } from "./types";
import { computeSessionStats, type SpeakerStats } from "./sessionStats";
import { Card, Empty, Pill, Stat } from "./components";
import { formatDuration, formatLength } from "./format";

const COLORS = ["#45d6c3", "#f5b942", "#a78bfa", "#60a5fa", "#f472b6", "#34d399", "#fb923c", "#94a3b8"];
const BUCKETS = 28;

function percent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.round(value * 100)}%`;
}

export function SessionStatsView({ detail }: { detail: SessionDetail }) {
  const stats = useMemo(
    () =>
      computeSessionStats({
        utterances: detail.utterances,
        people: detail.people,
        startedAtMs: detail.session.startedAtMs,
        stoppedAtMs: detail.session.stoppedAtMs,
        rollCount: detail.foundryLive?.messageCount ?? detail.foundrySummary?.rollCount ?? 0,
        mentalNotes: detail.mentalNotes.length
      }),
    [detail]
  );
  const colorByKey = useMemo(() => {
    const map = new Map<string, string>();
    stats.speakers.forEach((speaker, index) => map.set(speaker.key, COLORS[index % COLORS.length]!));
    return map;
  }, [stats.speakers]);
  const colorFor = (speaker: SpeakerStats) => colorByKey.get(speaker.key) ?? COLORS[0]!;

  const pulse = useMemo(() => {
    if (!stats.startMs || !stats.endMs || stats.durationMs <= 0) return [];
    const bucketMs = stats.durationMs / BUCKETS;
    const rows = Array.from({ length: BUCKETS }, (_, index) => ({
      index,
      startMs: stats.startMs! + index * bucketMs,
      endMs: stats.startMs! + (index + 1) * bucketMs,
      totalMs: 0,
      bySpeaker: new Map<string, { speaker: SpeakerStats; talkMs: number }>()
    }));
    for (const utterance of detail.utterances) {
      const start = Math.max(utterance.startMs, stats.startMs);
      const end = Math.min(utterance.endMs, stats.endMs);
      if (end <= start) continue;
      const speaker = stats.speakers.find((item) => item.discordUserId === utterance.discordUserId);
      if (!speaker) continue;
      const first = Math.max(0, Math.min(BUCKETS - 1, Math.floor((start - stats.startMs) / bucketMs)));
      const last = Math.max(0, Math.min(BUCKETS - 1, Math.floor((end - stats.startMs) / bucketMs)));
      for (let bucket = first; bucket <= last; bucket += 1) {
        const row = rows[bucket]!;
        const overlap = Math.max(0, Math.min(end, row.endMs) - Math.max(start, row.startMs));
        if (overlap <= 0) continue;
        const current = row.bySpeaker.get(speaker.key) ?? { speaker, talkMs: 0 };
        current.talkMs += overlap;
        row.bySpeaker.set(speaker.key, current);
        row.totalMs += overlap;
      }
    }
    return rows.map((row) => {
      const dominant = [...row.bySpeaker.values()].sort((a, b) => b.talkMs - a.talkMs)[0];
      return {
        ...row,
        dominant: dominant?.speaker ?? null,
        dominantMs: dominant?.talkMs ?? 0
      };
    });
  }, [detail.utterances, stats]);

  if (stats.utterances === 0) {
    return (
      <Empty title="No speech to analyse yet">
        Stats appear once this recording has transcribed utterances. Audio that was opted out is excluded.
      </Empty>
    );
  }

  return (
    <div className="stats-view">
      <div className="session-facts">
        <Stat label="Session" value={formatLength(stats.durationMs)} sub={stats.endMs ? "start to stop" : "in progress"} />
        <Stat label="Speech" value={percent(stats.speechShare)} sub={`${formatLength(stats.speechMs)} with someone talking`} />
        <Stat label="Talk time" value={formatLength(stats.combinedTalkMs)} sub="combined across speakers" />
        <Stat label="Words" value={stats.words.toLocaleString()} sub={stats.wordsPerMinute != null ? `${stats.wordsPerMinute} per min of speech` : undefined} />
        <Stat label="Turns" value={stats.turns.toLocaleString()} sub={stats.turns > 0 ? `${formatLength(stats.speechMs / stats.turns)} average` : undefined} />
        <Stat label="Rolls" value={stats.rollCount.toLocaleString()} sub={`${stats.mentalNotes} mental note${stats.mentalNotes === 1 ? "" : "s"}`} />
      </div>

      <div className="stats-highlights">
        <div>
          <span className="stat-label">Most talkative</span>
          <strong>{stats.mostTalkative ? stats.mostTalkative.name : "—"}</strong>
          <small>{stats.mostTalkative ? `${percent(stats.mostTalkative.share)} · ${formatLength(stats.mostTalkative.talkMs)}` : "No speech"}</small>
        </div>
        <div>
          <span className="stat-label">Longest turn</span>
          <strong>{stats.longestTurn ? stats.longestTurn.speaker.name : "—"}</strong>
          <small>
            {stats.longestTurn
              ? `${formatLength(stats.longestTurn.durationMs)}${stats.startMs ? ` · at ${formatDuration(stats.longestTurn.atMs - stats.startMs)}` : ""}`
              : "No turn"}
          </small>
        </div>
        <div>
          <span className="stat-label">Quietest</span>
          <strong>{stats.quietest ? stats.quietest.name : "—"}</strong>
          <small>{stats.quietest ? `${formatLength(stats.quietest.talkMs)} · ${stats.quietest.utterances} clips` : "Only one active speaker"}</small>
        </div>
        <div>
          <span className="stat-label">Overlap</span>
          <strong>{formatLength(stats.overlapMs)}</strong>
          <small>{stats.overlapMs > 0 ? "two or more voices at once" : "clean hand-offs"}</small>
        </div>
      </div>

      {pulse.length > 0 && (
        <Card title="Talk over time" subtitle={`${BUCKETS} slices · colour is the dominant speaker`}>
          <div className="stats-pulse" role="img" aria-label="Speech activity over the session">
            {pulse.map((slot) => {
              const height = Math.max(4, Math.min(100, Math.round((slot.totalMs / (stats.durationMs / BUCKETS)) * 100)));
              return (
                <span
                  key={slot.index}
                  className="stats-pulse-bar"
                  style={{
                    height: `${height}%`,
                    background: slot.dominant ? colorFor(slot.dominant) : "#182430",
                    opacity: slot.totalMs > 0 ? 1 : 0.35
                  }}
                  title={
                    slot.dominant
                      ? `${formatDuration(slot.startMs - (stats.startMs ?? 0))} · ${slot.dominant.name} · ${formatLength(slot.dominantMs)}`
                      : `${formatDuration(slot.startMs - (stats.startMs ?? 0))} · quiet`
                  }
                />
              );
            })}
          </div>
          <div className="stats-pulse-labels">
            <span>{formatDuration(0)}</span>
            <span>{formatLength(stats.durationMs)}</span>
          </div>
        </Card>
      )}

      <Card title="Speakers" subtitle="Sorted by talk time · shares use combined talk time">
        <div className="stats-speakers">
          {stats.speakers.map((speaker) => {
            const style = { "--speaker-color": colorFor(speaker) } as CSSProperties;
            return (
              <div className="stats-speaker" key={speaker.key} style={style}>
                <div className="stats-speaker-head">
                  <div>
                    <strong>{speaker.name}</strong>
                    <span className="muted small">
                      {speaker.character ? ` · ${speaker.character}` : ""}
                      {speaker.role === "gm" ? " · GM" : speaker.role === "observer" ? " · observer" : ""}
                    </span>
                  </div>
                  <div className="button-row">
                    {speaker.consentStatus === "opted_out" && <Pill tone="warn">not recorded</Pill>}
                    <span className="stats-share-label">{percent(speaker.share)}</span>
                  </div>
                </div>
                <div className="stats-share" aria-hidden="true">
                  <span style={{ width: `${Math.max(0, Math.min(100, speaker.share * 100))}%` }} />
                </div>
                <div className="stats-speaker-facts">
                  <div><span>Talk time</span><strong>{formatLength(speaker.talkMs)}</strong></div>
                  <div><span>Speech lines</span><strong>{speaker.utterances.toLocaleString()}</strong></div>
                  <div><span>Words</span><strong>{speaker.words.toLocaleString()}</strong></div>
                  <div><span>Turns</span><strong>{speaker.turns.toLocaleString()}</strong></div>
                  <div><span>Longest turn</span><strong>{formatLength(speaker.longestTurnMs)}</strong></div>
                  <div><span>Avg speech line</span><strong>{formatLength(speaker.averageUtteranceMs)}</strong></div>
                  <div><span>Words/min</span><strong>{speaker.wordsPerMinute ?? "—"}</strong></div>
                  <div><span>Short clips</span><strong>{speaker.shortUtterances}</strong></div>
                </div>
                {speaker.firstAtMs != null && speaker.lastAtMs != null && stats.startMs != null && (
                  <p className="muted tiny stats-span">
                    Heard from {formatDuration(speaker.firstAtMs - stats.startMs)} to {formatDuration(speaker.lastAtMs - stats.startMs)}
                    {speaker.talkMs === 0 ? " · no recorded speech" : ""}
                  </p>
                )}
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
}
