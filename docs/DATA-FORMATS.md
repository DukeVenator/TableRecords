# TableRecords data formats

This document is the canonical contract between the dashboard/server, the Discord recorder, the Python STT sidecar, the Foundry macro/importers, and the merge/render stages. Implementations must follow the field names and units here; unknown fields are ignored for forward compatibility.

## Conventions

- **Schemas are versioned.** Every persisted object has a `schema` string such as `tablerecords.session/v1`. Additive fields may appear inside a version; breaking changes require a new `/v2` schema.
- **All timestamps are absolute Unix epoch milliseconds (UTC), integers, named `*Ms`.** ISO strings are for display only and are never used for sorting or joining. There is no local-time timestamp in machine data.
- **Paths in persisted JSON/JSONL are relative to the session directory**, using forward slashes. Absolute paths are allowed only in process arguments and are validated by the server.
- **JSONL files are UTF-8, one object per line, LF endings, no BOM.** Raw capture artifacts (`discord/manifest.jsonl`, `foundry/events.jsonl`, `stt/transcript.jsonl`) are append-only; derived files may be regenerated.
- **IDs:** session IDs look like `2026-01-01-demo-world-demo-session`; prefixed IDs are used for `utteranceId` (`u_`), `sttJobId` (`stt_`), `jobId` (`job_`), `markerId` (`m_`), and `personId` (`p_`).
- **A session is captured once.** Re-recording starts a new session directory. Jobs may be re-run against the same captured artifacts.
- **FFG narrative dice first, SFRPG second, generic fallback.** Raw roll JSON is always preserved; adapters only add derived summaries.

## Session directory layout

```text
sessions/
  <sessionId>/
    session.json
    people.json
    consent.md
    markers.jsonl
    discord/
      manifest.jsonl
      manifest.removed.jsonl        # only after clips are deleted
      audio-removed.json            # only after clips are deleted
      audio-compacted.json          # only after compaction
      audio/
        <discordUserId>/
          <startMs>-<utteranceId>.wav
    foundry/
      export.json
      events.jsonl
      live-events.jsonl
      live-state.json
      import-summary.json
    stt/
      jobs.jsonl
      transcript.jsonl
      transcript-errors.jsonl
      recent-jobs.jsonl
      recent-transcript.jsonl
      recent-transcript-errors.jsonl
    merged/
      timeline.jsonl
    outputs/
      transcript.md
      chronology.md
      rolls.csv
      roll-sync.md
      mental-notes.md
      stats.md
      notes-ready.md
    jobs/
      <jobId>.log
```

`data/tablerecords.db` (SQLite) is the operational index for the dashboard; the files above are the portable, inspectable artifacts. On startup the server reconciles sessions found under `sessions/` into the DB when the DB row is missing, using `session.json` as the source of truth.

## `session.json` — `tablerecords.session/v1`

Written atomically at creation/transitions (temporary file + rename).

```json
{
  "schema": "tablerecords.session/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "title": "Demo World",
  "status": "captured",
  "archived": false,
  "campaign": "Demo Campaign",
  "system": {"id": "starwarsffg", "version": "2.0"},
  "world": {"id": "swffg-cartel", "title": "[redacted world]"},
  "foundryVersion": "14.369.0",
  "timeZone": "UTC",
  "createdAtMs": 1793430000000,
  "startedAtMs": 1793430360000,
  "stoppedAtMs": 1793444760000,
  "guild": {"id": "111111111111111111", "name": "Table"},
  "voiceChannel": {"id": "222222222222222222", "name": "FFG"},
  "consent": {
    "confirmed": true,
    "confirmedAtMs": 1793430300000,
    "confirmedBy": "Foundry player consent prompt",
    "participants": ["241234567890123456", "392345678901234567", "483456789012345678"],
    "notes": "Players answered the Foundry notice; consent assumed for non-responses.",
    "method": "foundry",
    "noticeVersion": "2026-11-01",
    "promptedAtMs": 1793430290000
  },
  "merge": {"filterMarginMs": 300000, "rollContextBeforeMs": 20000, "rollContextAfterMs": 10000},
  "recording": {
    "utteranceCount": 214,
    "totalBytes": 812345678,
    "decryptionFailures": 0,
    "reconnectCount": 0,
    "nodeVersion": "26.13.0",
    "discordJsVersion": "14.28.0",
    "voiceVersion": "0.19.2",
    "daveyVersion": "0.1.12"
  },
  "files": {
    "manifest": "discord/manifest.jsonl",
    "foundryExport": "foundry/export.json",
    "transcript": "stt/transcript.jsonl",
    "timeline": "merged/timeline.jsonl",
    "outputsDir": "outputs/"
  }
}
```

- `status` is one of `draft`, `joining`, `recording`, `stopping`, `captured`, `processing`, `ready`, `error`.
- `archived` hides a session from the default dashboard flow without deleting its folder. Archived sessions can be restored.
- `campaign` is the game/folder label used to group sessions. New sessions default to the Foundry world title; older sessions without the field are grouped by world title, then “Unsorted.”
- `startedAtMs`/`stoppedAtMs` are set by the server, not inferred from audio.
- `merge.filterMarginMs` defaults to 300000 and is copied into merge job requests.
- `merge.rollContextBeforeMs`/`rollContextAfterMs` are the per-session snapshot of the configured roll↔voice window. Older sessions may omit them; merge falls back to 20000/10000.
- `consent.method` is `foundry` when the Foundry player prompt established consent, or `gm_tick` for the dashboard fallback. `promptedAtMs` records when the Foundry prompt was sent.
- A person's `consentStatus` is `assumed` (default), `opted_in`, or `opted_out`. `consent` remains for older readers: it is false only when the player opted out. `consentSource` is `foundry`, `gm`, or `dashboard`.

## `review/` — listening mixes

After transcription the server builds `review/master.mp3`, `review/<speaker>-<discordId>.mp3`, and
`review/manifest.json` automatically; `POST /api/sessions/:id/review-audio` rebuilds them on demand.
The builder places each captured utterance at its absolute offset from `startedAtMs`, streams clips
in batches of 500 (`REVIEW_AUDIO_BATCH_CLIPS`), and stitched speaker timelines are mixed into the
master. Opted-out speakers are excluded. Builds use a temporary `.review-tmp/` directory and swap it
into place when complete. It is deliberately separate from the per-utterance WAVs, which remain the
STT input. FFmpeg is used only for this export (`FFMPEG_PATH` defaults to `ffmpeg`).

```json
{
  "schema": "tablerecords.review-audio/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "generatedAtMs": 1793430500000,
  "durationMs": 54197,
  "files": [
    {"name":"master.mp3","label":"Master mix","kind":"master","durationMs":54197,"sizeBytes":868269},
    {"name":"alice-123.mp3","label":"Alice","kind":"speaker","speakerId":"123","speakerName":"Alice","durationMs":54197,"sizeBytes":868269}
  ]
}
```

### Clip storage markers

`discord/audio-compacted.json` records a successful compaction: `{schema:"tablerecords.audio-compacted/v1", sessionId, compactedAtMs, clipCount, bytesBefore, bytesAfter}`. Compacted clips stay 16 kHz mono PCM WAV and the manifest is rewritten with the new `sampleRate`, `channels`, `bytes`, and `durationMs`.

`discord/audio-removed.json` records a full clip deletion: `{schema:"tablerecords.audio-removed/v1", sessionId, removedAtMs, clipCount, bytes}`. The original manifest is moved to `discord/manifest.removed.jsonl`, and `review/` keeps the master and speaker tracks. On a later transcribe, existing `stt/transcript.jsonl` is reused; if it is missing, the speaker tracks are cut into 2-minute windows and transcribed as synthetic utterances with absolute timestamps.

## `people.json` — `tablerecords.people/v1`


Explicit mapping only; never infer identity from fuzzy name/voice matching.

```json
{
  "schema": "tablerecords.people/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "people": [
    {
      "personId": "p_alice-7f3a",
      "role": "player",
      "discordUserId": "241234567890123456",
      "discordName": "Alice",
      "foundryUserId": "UUSIcnoUf4hSzHDE",
      "foundryUserName": "Alice",
      "character": "Veyra Sol",
      "aliases": ["Al"],
      "consent": true,
      "consentStatus": "assumed",
      "consentSource": "foundry",
      "consentUpdatedAtMs": 1793430290000
    },
    {
      "personId": "p_bob-91de",
      "role": "player",
      "discordUserId": "392345678901234567",
      "discordName": "Bob",
      "foundryUserId": "F_BOB",
      "foundryUserName": "Bob",
      "character": "Korrin",
      "aliases": [],
      "consent": false,
      "consentStatus": "opted_out",
      "consentSource": "foundry",
      "consentUpdatedAtMs": 1793430295000
    },
    {
      "personId": "p_gm-2c1b",
      "role": "gm",
      "discordUserId": "999999999999999999",
      "discordName": "GM",
      "foundryUserId": null,
      "foundryUserName": "GM",
      "character": null,
      "aliases": [],
      "consent": true,
      "consentStatus": "assumed",
      "consentSource": "dashboard"
    }
  ]
}
```

Mapping rules:

- The **Discord user ID** is authoritative for speech; the display name is cosmetic and may change.
- The **Foundry actor/alias/author** is authoritative for roll display; a person's `character` is used for speech labels and may differ per campaign/session.
- `foundryUserId` is optional. If present, roll author IDs can be matched to the person; roll labels still prefer the actor/alias from the message.
- `role` is `gm`, `player`, or `observer`.
- `aliases` are for search/display only, never identity resolution.
- Unresolved speech is labeled `Unknown (<discordUserId>)`; unresolved rolls use actor name, then alias, then author name.
- `personId` values are globally unique within a session; implementations append a short random suffix when creating a person. Do not rely on a name-derived ID being reusable across sessions.
- Changing people/character mapping after rendering marks outputs stale; re-run `merge` then `render`.

## `people_roster` (SQLite)

A world-scoped roster supplies the People-tab dropdowns and current voice-member
shortcuts. It is keyed by `(world_id, discord_user_id)` so the same Discord
player can have different characters in different Foundry worlds. Saving a
session's people table upserts each non-null Discord ID into the roster. Existing
sessions seed the roster on first startup; later edits update it.

```sql
CREATE TABLE people_roster (
  profile_id        TEXT PRIMARY KEY,
  world_id          TEXT NOT NULL,
  discord_user_id   TEXT NOT NULL,
  discord_name      TEXT,
  foundry_user_id   TEXT,
  foundry_user_name TEXT,
  character_name    TEXT,
  aliases_json      TEXT NOT NULL DEFAULT '[]',
  role              TEXT NOT NULL,
  updated_at_ms     INTEGER NOT NULL,
  UNIQUE (world_id, discord_user_id)
);
```

The roster is a convenience layer: session `people.json` remains the authoritative
snapshot for that session.

The live module also publishes an ephemeral `roster` in each heartbeat
(`users[]` with optional `characterId`/`characterName`, and player-owned
`actors[]`). The dashboard stores it in `foundry/live-state.json` for the People
tab lookup. It is a directory hint, not a permanent record; the GM still confirms
the mapping and saves it into `people.json`.

## `discord/manifest.jsonl` — `tablerecords.discord-utterance/v1`

One line per finalized WAV/utterance. Append-only; the manifest is the canonical speech index.

```json
{"schema":"tablerecords.discord-utterance/v1","sessionId":"2026-01-01-demo-world-demo-session","utteranceId":"u_01J9Z3K7QF","discordUserId":"241234567890123456","displayName":"Alice","file":"discord/audio/241234567890123456/1793430364128-u_01J9Z3K7QF.wav","startMs":1793430364128,"endMs":1793430367050,"durationMs":2922,"sampleRate":48000,"channels":2,"format":"wav","encoding":"pcm_s16le","bytes":561024,"streamEnd":"silence","decryptionFailures":0,"voicedMs":2480,"peakDbfs":-3,"rmsDbfs":-24,"silent":false,"trimmedMs":2140,"createdAtMs":1793430367100}
```

- `startMs` is the speaking-start/first-audio timestamp captured on the server clock.
- `endMs = startMs + durationMs`, where duration is derived from decoded PCM frames, not wall-clock time. Leading audio is preserved; trailing silence beyond the trim padding is removed after finalize.
- `streamEnd` is `silence`, `manual`, `stop`, or `error`.
- `voicedMs`, `peakDbfs`, `rmsDbfs`, `silent`, and `trimmedMs` come from the capture voice-activity meter. Older manifests omit them. `silent:true` means the clip is retained for review but skipped by STT.
- If the process dies before writing a line, the server may reconstruct a record by reading the WAV header/size and pairing it with the file-name timestamp; reconstructed records use the same schema and omit the VAD fields.

## `stt/jobs.jsonl` — `tablerecords.stt-job/v1`

Per-utterance work item generated by the Node server for one `transcribe` batch job.

```json
{"schema":"tablerecords.stt-job/v1","sttJobId":"stt_01J9Z3N2AA","batchJobId":"job_01J9Z3MZQ1","sessionId":"2026-01-01-demo-world-demo-session","utteranceId":"u_01J9Z3K7QF","audioFile":"discord/audio/241234567890123456/1793430364128-u_01J9Z3K7QF.wav","discordUserId":"241234567890123456","speakerLabel":"Alice","character":"Veyra Sol","language":"en","startMs":1793430364128,"endMs":1793430367050,"model":"large-v3-turbo","device":"cuda","computeType":"float16","beamSize":5,"wordTimestamps":true,"vadFilter":false,"prompt":"FFG narrative dice campaign: Veyra Sol, Korrin, Dr. Ix, Absalom Station.","hotwords":["Veyra Sol","Korrin","Dr. Ix","Triumph","Despair"]}
```

`audioFile` is resolved under the session root and rejected if it escapes it.

After a successful `transcribe` with no per-clip errors, the server deletes `stt/jobs.jsonl`,
`stt/transcript-raw.jsonl`, and `stt/transcript-raw-jobs.jsonl`; `stt/transcript.jsonl` carries the
same STT metadata and is the canonical record. If there were errors, the job spec and
`transcript-raw-errors.jsonl` are kept for diagnosis.

## `stt/transcript.jsonl` — `tablerecords.transcript/v1`

One line per successfully transcribed utterance.

```json
{"schema":"tablerecords.transcript/v1","sessionId":"2026-01-01-demo-world-demo-session","utteranceId":"u_01J9Z3K7QF","sttJobId":"stt_01J9Z3N2AA","batchJobId":"job_01J9Z3MZQ1","discordUserId":"241234567890123456","speaker":"Alice","character":"Veyra Sol","text":"I'll try the engineering check.","rawText":"I'll try the engineering check.","corrections":[],"startMs":1793430365128,"endMs":1793430367050,"words":[{"word":"I'll","startMs":1793430365128,"endMs":1793430365480,"probability":0.94},{"word":"try","startMs":1793430365480,"endMs":1793430365860,"probability":0.91}],"stt":{"engine":"faster-whisper","engineVersion":"1.2.1","model":"large-v3-turbo","device":"cuda","computeType":"float16","language":"en","languageProbability":1.0,"avgLogprob":-0.31,"noSpeechProb":0.01},"flags":[],"createdAtMs":1793430368000}
```

- `startMs`/`endMs` and every word timestamp are **absolute**: `utterance.startMs + round(relativeSeconds * 1000)`, clamped to the utterance window.
- `text` is the display text after deterministic vocabulary corrections; `rawText` is the model output; `corrections` records `{from,to,rule}` entries.
- `words` may be empty when word timestamps are unavailable.
- `flags` may include `low_confidence`, `empty`, `vocabulary_corrected`, `offset_clamped`.
- Per-utterance failures go to `stt/transcript-errors.jsonl`:

```json
{"schema":"tablerecords.transcript-error/v1","sessionId":"2026-01-01-demo-world-demo-session","utteranceId":"u_01J9Z3K7QF","sttJobId":"stt_01J9Z3N2AA","batchJobId":"job_01J9Z3MZQ1","code":"audio_decode_failed","message":"PyAV could not decode the WAV","createdAtMs":1793430369000}
```

### Recent-window transcription

`POST /api/sessions/:id/context/recent` and the queued `context` job select manifest utterances that overlap the window and have no transcript record. The job writes `stt/recent-raw.jsonl` / `stt/recent-raw-errors.jsonl`, then merges the new records into the canonical `stt/transcript.jsonl` by `utteranceId` (newest wins, sorted by `startMs`). Existing records are reused, so the full-session transcript is never replaced by a short window. `windowSeconds` is clamped to 15..1800. The job result is written to `context/recent-<jobId>.json`; the legacy endpoint long-polls the same job. A per-session transcription lock prevents an inline transcription and a queued job from racing on the GPU. The configured engine (Parakeet or faster-whisper) applies to both paths.

## `foundry/export.json` — `tablerecords.foundry-export/v1`

Produced by the pasteable GM script macro. It is the raw import, replaced on each import.

```json
{
  "schema": "tablerecords.foundry-export/v1",
  "exportedAtMs": 1793444900000,
  "foundryVersion": "14.369.0",
  "world": {"id": "swffg-cartel", "title": "[redacted world]"},
  "system": {"id": "starwarsffg", "version": "2.0"},
  "messages": [
    {
      "messageId": "62Q5MoMOKIUL152k",
      "timestampMs": 1793430369144,
      "author": {"id": "UUSIcnoUf4hSzHDE", "name": "Alice"},
      "speaker": {"scene": "GfqHJ2buQyT5NzU5", "token": "mfSExRsgNlkMpeOd", "actor": "nBujFlZuMSKSSpXz", "alias": "Veyra Sol"},
      "speakerName": "Veyra Sol",
      "actorId": "nBujFlZuMSKSSpXz",
      "actorName": "Veyra Sol",
      "tokenName": "Veyra Sol",
      "style": 0,
      "flavor": "Laser rifle attack",
      "content": "<div class=\"ffg-roll\">…</div>",
      "whisper": [],
      "blind": false,
      "flags": {"starwarsffg": {"uuid": "Actor.nBujFlZuMSKSSpXz.Item.abc123"}},
      "rolls": [
        {
          "class": "RollFFG",
          "formula": "2eP+1eA+1eB",
          "total": 0,
          "options": {"rollOptions": {}},
          "dice": [],
          "terms": [],
          "evaluated": true,
          "ffg": {"success": 2, "failure": 0, "advantage": 1, "threat": 0, "triumph": 1, "despair": 0, "light": 0, "dark": 0},
          "hasFFG": true,
          "hasStandard": false,
          "data": {"name": "Laser rifle", "uuid": "Actor.nBujFlZuMSKSSpXz.Item.abc123"},
          "addedResults": [],
          "flavorText": "Laser rifle attack"
        }
      ],
      "rollsRaw": ["{\"class\":\"RollFFG\",\"formula\":\"2eP+1eA+1eB\"}"]
    }
  ],
  "warnings": []
}
```

- The macro must export **prepared `message.rolls.map(r => r.toJSON())`**, because a stored `ChatMessage._source.rolls` array contains JSON strings. `rollsRaw` is optional audit data; `rolls` is authoritative when present.
- Base Roll fields (`options`, `dice`, `terms`, `evaluated`, etc.) are preserved verbatim by the macro. The example abbreviates `terms` for readability; adapters must not discard it.
- `style` follows Foundry `CHAT_MESSAGE_STYLES`: `0` other, `1` OOC, `2` IC, `3` emote.
- `content` is raw HTML; `contentText` is derived by the importer for display.
- `author`, `speakerName`, `actorName`, and `tokenName` are resolved on the GM client before export.
- The macro exports all messages; the importer filters to the session window and reports out-of-window counts.

### FFG narrative dice `RollFFG` rules

- `ffg` is the authoritative narrative-dice aggregate; `total` is not meaningful for pure FFG rolls.
- The system adds `triumph` into `success` and `despair` into `failure` during evaluation. Preserve values exactly; render triumph/despair separately and describe `success` as the net pool without double-counting.
- `addedResults` contains manually added symbols; `hasStandard`/`hasFFG` distinguish mixed/standard terms; `data` is item metadata; `flavorText` is a label.
- `terms`/`dice` are preserved for audit and future adapters but are not required for the basic render.

### SFRPG `_SFRPGRoll` example

```json
{
  "class": "_SFRPGRoll",
  "formula": "1d20 + 19 + 2",
  "total": 34,
  "options": {"rollOptions": {}, "sfrpgRollSuccess": true},
  "dice": [],
  "terms": [{"class": "Die", "faces": 20, "number": 1, "results": [{"result": 12, "active": true}], "evaluated": true}, {"class": "OperatorTerm", "operator": "+"}, {"class": "NumericTerm", "number": 21}],
  "evaluated": true
}
```

For SFRPG, `total` is authoritative (`12 + 21 = 33` above); `formula`, `terms`, and `dice` are preserved. A message may contain multiple rolls (for example attack and damage).

## `foundry/events.jsonl` — `tablerecords.foundry-event/v1`

One line per normalized Foundry message after import/time filtering. Raw roll objects are preserved in `rolls`.

```json
{"schema":"tablerecords.foundry-event/v1","sessionId":"2026-01-01-demo-world-demo-session","eventId":"62Q5MoMOKIUL152k","type":"roll","timestampMs":1793430369144,"author":{"id":"UUSIcnoUf4hSzHDE","name":"Alice"},"speaker":{"alias":"Veyra Sol","actorId":"nBujFlZuMSKSSpXz","actorName":"Veyra Sol","tokenName":"Veyra Sol"},"system":"starwarsffg","systemVersion":"2.0","flavor":"Laser rifle attack","contentText":"Laser rifle attack","visibility":{"whisper":[],"blind":false},"rolls":[{"class":"RollFFG","formula":"2eP+1eA+1eB","total":0,"ffg":{"success":2,"failure":0,"advantage":1,"threat":0,"triumph":1,"despair":0,"light":0,"dark":0},"hasFFG":true,"hasStandard":false,"data":{"name":"Laser rifle"},"addedResults":[],"flavorText":"Laser rifle attack"}],"source":{"kind":"macro","file":"foundry/export.json"}}
```

For SFRPG the same envelope carries:

```json
{"schema":"tablerecords.foundry-event/v1","sessionId":"2026-11-01-sfrpg-1","eventId":"m_goal_01","type":"roll","timestampMs":1792817725070,"author":{"id":"ExNuG2lDDCE6vczk","name":"Ben"},"speaker":{"alias":"Demo Character","actorId":"nBujFlZuMSKSSpXz","actorName":"Demo Character","tokenName":"Demo Character"},"system":"sfrpg","systemVersion":"14.0.2","flavor":"Skill Check - Diplomacy","contentText":"Skill Check - Diplomacy","visibility":{"whisper":[],"blind":false},"rolls":[{"class":"_SFRPGRoll","formula":"1d20 + 19 + 2","total":33,"terms":[],"dice":[]}],"source":{"kind":"macro","file":"foundry/export.json"}}
```

Import deduplicates by `eventId` (Foundry message ID); a new import replaces `foundry/events.jsonl` rather than appending duplicates.

## `foundry/live-events.jsonl` — `tablerecords.foundry-event/v1`

The optional Foundry module writes the same event envelope to `foundry/live-events.jsonl`, with `source.kind` set to `module`:

```json
{"schema":"tablerecords.foundry-event/v1","sessionId":"2026-01-01-demo-world-demo-session","eventId":"62Q5MoMOKIUL152k","type":"roll","timestampMs":1793430369144,"author":{"id":"UUSIcnoUf4hSzHDE","name":"Alice"},"speaker":{"alias":"Veyra Sol","actorId":"nBujFlZuMSKSSpXz","actorName":"Veyra Sol","tokenName":"Veyra Sol"},"system":"starwarsffg","systemVersion":"2.0","flavor":"Laser rifle attack","contentText":"Laser rifle attack","visibility":{"whisper":[],"blind":false},"rolls":[{"class":"RollFFG","formula":"2eP+1eA","total":0,"ffg":{"success":2,"failure":0,"advantage":1,"threat":0,"triumph":1,"despair":0,"light":0,"dark":0}}],"source":{"kind":"module","file":"foundry/live-events.jsonl"}}
```

- The bridge accepts `POST /api/foundry/live` with header `x-tablerecords-token` and body schema `tablerecords.foundry-live/v1`. It is rejected while the bridge is disabled and is exempt from dashboard-cookie auth because the module cannot hold that cookie.
- `messages` is an array of the same shape as a macro export message. The bridge is intentionally tolerant: one bad message is skipped, not a whole batch. `rollsRaw` is used only if the prepared `rolls` array is empty.
- Duplicate message IDs are ignored when appending. Merge combines `events.jsonl` and `live-events.jsonl` and deduplicates again by `eventId`, so importing a macro after a live session does not duplicate rolls.
- `state` may contain `scene`, `combat`, `paused`, `userId`, `userName`. A `note` string (max 500 chars) creates a manual mental-note marker for the active session.
- `events` is an optional array (max 50) of explicit bridge events. The only kind is `break`, with `phase` `start` or `end`, an `atMs`, and an optional `actor`/`label`. An end may also carry `startedAtMs` so the duration survives a dashboard restart. A start creates a `break` marker labelled `Break time called by <GM>`; an end creates `Break time over after <duration>`. The bridge's Break Time integration sends these when the `breaktime` module starts or ends a break. Duplicate starts for the same open break, and duplicate ends within five seconds, are ignored.

```json
{"eventId":"break-start-1793508249843-a1b2c3","kind":"break","phase":"start","atMs":1793508249843,"actor":{"id":"UUSIcnoUf4hSzHDE","name":"Gamemaster"}}
```

## `foundry/live-state.json` — `tablerecords.foundry-live-state/v1`

Last heartbeat and scene/combat snapshot for one session:

```json
{
  "schema": "tablerecords.foundry-live-state/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "lastSeenAtMs": 1793430500000,
  "moduleVersion": "0.1.0",
  "foundryVersion": "14.369.0",
  "world": {"id": "swffg-cartel", "title": "Cartel"},
  "system": {"id": "starwarsffg", "version": "2.0"},
  "scene": {"id": "GfqHJ2buQyT5NzU5", "name": "Cantina"},
  "combat": {"id": "c1", "name": "Hangar fight", "round": 2, "active": true},
  "paused": false,
  "messageCount": 41,
  "updatedAtMs": 1793430500000
}
```

Server-side automatic markers are created only while the session is `recording` and the `foundry_live_markers` setting is true. Scene changes and combat start/end are recorded as ordinary markers; the first heartbeat during a recording also records the starting scene/combat once. A message-only/note request without a `state` object never implies that combat ended or the scene changed.

## `foundry/import-summary.json` — `tablerecords.foundry-import-summary/v1`

```json
{"schema":"tablerecords.foundry-import-summary/v1","sessionId":"2026-01-01-demo-world-demo-session","importedAtMs":1793445000000,"sourceFile":"foundry/export.json","foundryVersion":"14.369.0","world":{"id":"swffg-cartel","title":"[redacted world]"},"system":{"id":"starwarsffg","version":"2.0"},"messageCount":412,"rollMessageCount":87,"rollCount":91,"firstTimestampMs":1793430369144,"lastTimestampMs":1793444600000,"outOfWindowCount":18,"warnings":[{"code":"outside_window","message":"18 messages outside the session window were excluded."}]}
```

## `merged/timeline.jsonl` — `tablerecords.timeline/v1`

Canonical derived chronology. One line per speech/roll/chat/marker event.

```json
{"schema":"tablerecords.timeline/v1","sessionId":"2026-01-01-demo-world-demo-session","seq":1,"tsMs":1793430365128,"type":"speech","sourceId":"u_01J9Z3K7QF","actor":{"discordUserId":"241234567890123456","foundryUserId":null,"name":"Alice","character":"Veyra Sol","role":"player"},"text":"I'll try the engineering check.","speech":{"utteranceId":"u_01J9Z3K7QF","endMs":1793430367050,"flags":[]},"source":"transcript"}
{"schema":"tablerecords.timeline/v1","sessionId":"2026-01-01-demo-world-demo-session","seq":2,"tsMs":1793430369144,"type":"roll","sourceId":"62Q5MoMOKIUL152k","actor":{"discordUserId":null,"foundryUserId":"UUSIcnoUf4hSzHDE","name":"Alice","character":"Veyra Sol","role":"player"},"roll":{"system":"starwarsffg","formula":"2eP+1eA+1eB","summary":"2 success (1 triumph), 1 advantage","ffg":{"success":2,"failure":0,"advantage":1,"threat":0,"triumph":1,"despair":0,"light":0,"dark":0},"raw":{"class":"RollFFG"}},"source":"foundry"}
{"schema":"tablerecords.timeline/v1","sessionId":"2026-01-01-demo-world-demo-session","seq":3,"tsMs":1793430380000,"type":"marker","sourceId":"m_01J9Z4","marker":{"kind":"scene","label":"Cantina back room"},"source":"marker"}
```

- `seq` is assigned **after** sorting and filtering; it is dense and stable for a given timeline file.
- Sort key: `(tsMs ASC, typePriority ASC, sourceId ASC)` with priority `marker=0`, `roll=1`, `speech=2`, `chat=3`.
- `type` is `speech`, `roll`, `chat`, or `marker`.
- Raw and derived files retain their original timestamps; merge never mutates them.
- A speech or marker event may carry `mentalNote: {text, source: "spoken"|"manual", speaker?, character?, markerId?}`. Spoken detection is start-only: after optional filler, an utterance must begin with `mental note`, `note to self`, `gm note`, `dm note`, or `remind me later/that/to`. Ordinary mid-sentence use does not trigger.
- A roll carries `voiceContext: {beforeMs, afterMs, before[], after[], nearestSpeechGapMs, confidence}`. Up to three speech lines on each side of the roll are included. Confidence is `high` when the nearest speech edge is ≤3000 ms away, `medium` ≤10000 ms, `low` otherwise, and `none` when there is no speech in the configured windows. `beforeMs`/`afterMs` come from the session merge settings (defaults 20000/10000).

## `POST /api/sessions/:id/context/recent` — `tablerecords.recent-context/v1`

Returns a deterministic brief for copying into an external assistant. No LLM call is made.

```json
{
  "schema": "tablerecords.recent-context/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "window": {"seconds": 180, "startMs": 1793430300000, "endMs": 1793430480000, "label": "last 3 min"},
  "generatedAtMs": 1793430481000,
  "counts": {"events": 23, "speech": 18, "rolls": 2, "chat": 1, "markers": 2, "mentalNotes": 1, "rollsWithVoiceContext": 2},
  "transcription": {"requested": true, "candidates": 4, "transcribed": 2, "alreadyPresent": 2, "failed": 0, "errors": []},
  "markdown": "# GM context — ...\n"
}
```

`markdown` includes the session/world/system header, cast, last marker and latest roll, in-window mental notes, a chronological timeline with roll voice context, and warnings. The UI offers Copy and Download `.md`. For a finished session the window ends at `stoppedAtMs`; for a live session it ends at request time.

## `POST /api/sessions/:id/llm/summarize` — `tablerecords.llm-summary/v1`

Optional phase-2 path. Disabled by default; only a loopback OpenAI-compatible
endpoint is accepted.

```json
{
  "schema": "tablerecords.llm-summary/v1",
  "sessionId": "2026-01-01-demo-world-demo-session",
  "window": {"seconds": 180, "startMs": 1793430300000, "endMs": 1793430480000, "label": "last 3 min"},
  "summary": "## Current situation\n...",
  "model": "llama3.1:8b",
  "elapsedMs": 8421,
  "generatedAtMs": 1793430482000
}
```

The request body is `{windowSeconds?}`. The server builds the deterministic
recent-context brief and sends it to `{llmBaseUrl}/chat/completions`. It does not
transcribe missing audio, does not write the response to `outputs/`, and does not
change `merged/timeline.jsonl`. The model response is a convenience summary, not a
canonical record. See [FEATURES.md](../FEATURES.md).

## `markers.jsonl` — `tablerecords.marker/v1`

Mirrors the SQLite marker rows for portability.

```json
{"schema":"tablerecords.marker/v1","markerId":"m_01J9Z4","sessionId":"2026-01-01-demo-world-demo-session","tsMs":1793430380000,"kind":"scene","label":"Cantina back room","mentalNote":false,"createdAtMs":1793430381000}
```

`kind` is `scene`, `break`, `combat`, `note`, or `other`. `label` is user text, trimmed to 500 characters. A manual mental note sets `kind:"note"` and `mentalNote:true`; the marker is also included in the merged timeline and `mental-notes.md`. Foundry live automatic markers use the same schema with labels prefixed `Foundry scene:` / `Combat:`. Break Time markers use `kind:"break"` with labels beginning `Break time called` / `Break time over`.

## `llm/summaries.jsonl` — `tablerecords.llm-summary/v2`

AI summaries are saved per session as a sidecar. They are deliberately not written into `outputs/`.

```json
{"schema":"tablerecords.llm-summary/v2","summaryId":"llm_01J9Z5","sessionId":"2026-01-01-demo-world-demo-session","provider":"ollama","model":"qwen3.5:0.8b","preset":"gm-prep","scope":"scene","window":{"seconds":900,"startMs":1793430300000,"endMs":1793431200000,"label":"current scene"},"promptVersion":"2026-11-02.1","briefChars":18420,"estimatedTokens":4605,"trimmed":false,"chunks":2,"summary":"## Current situation\n...","structured":null,"elapsedMs":8421,"createdAtMs":1793430482000}
```

- `provider` is `ollama`, `local`, or `deepseek`.
- `preset` is `recap`, `gm-prep`, `clue-board`, or `rules`.
- `scope` is `recent`, `scene`, or `session`.
- `chunks` is the number of portion summaries used to build a long brief. `trimmed` is true when the original brief exceeded the configured input budget.
- `structured` holds the validated clue-board object when the preset requests JSON.
- History is read back through `GET /api/sessions/:id/llm/summaries`; the canonical session files remain authoritative.

## Jobs — `tablerecords.job/v1`

A dashboard job is a batch operation (`transcribe`, `merge`, `render`, `run_all`, `context`), distinct from per-utterance `sttJobId`s. Persisted in SQLite and returned by the API.

```json
{"schema":"tablerecords.job/v1","jobId":"job_01J9Z3MZQ1","sessionId":"2026-01-01-demo-world-demo-session","type":"run_all","status":"running","progress":{"phase":"transcribe","completed":40,"total":214,"percent":13,"detail":"Transcribing 40/214 · Alice","stageIndex":1,"stageTotal":3,"elapsedMs":35200,"etaMs":153000},"request":{"filterMarginMs":300000},"result":null,"error":null,"logFile":"jobs/job_01J9Z3MZQ1.log","createdAtMs":1793435000000,"startedAtMs":1793435001000,"finishedAtMs":null}
```

- `status`: `queued`, `running`, `done`, `failed`, `cancelled`.
- `progress.phase` is `transcribe`, `merge`, `render`, or `context`. For `run_all`, percent is stage-weighted (0–70, 70–90, 90–100) so it never jumps backwards.
- `progress.detail` is the human-readable current step. `progress.queuePosition` (1-based) is present only while queued. `progress.elapsedMs` and `progress.etaMs` are refreshed while running.
- Logs are plain text, one line per record; the API exposes `{seq, tsMs, level, line}` and the same lines are emitted over SSE.
- Retry creates a new `jobId`; the failed record remains for audit. A server restart marks previously `running` jobs as `failed` with error code `interrupted`.

## SQLite schema

Database: `data/tablerecords.db`. Apply `PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;`.

```sql
CREATE TABLE sessions (
  session_id       TEXT PRIMARY KEY,
  title            TEXT NOT NULL,
  system_id        TEXT NOT NULL,
  system_version   TEXT,
  world_id         TEXT,
  world_title      TEXT,
  foundry_version  TEXT,
  status           TEXT NOT NULL,
  created_at_ms    INTEGER NOT NULL,
  started_at_ms    INTEGER,
  stopped_at_ms    INTEGER,
  dir              TEXT NOT NULL UNIQUE,       -- sessionId, relative to SESSIONS_DIR
  guild_id         TEXT,
  voice_channel_id TEXT,
  consent_json     TEXT NOT NULL DEFAULT '{}',
  metadata_json    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE people (
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

CREATE TABLE consent_prompt (
  world_id       TEXT PRIMARY KEY,
  prompted_at_ms INTEGER NOT NULL,
  notice_version TEXT NOT NULL,
  prompted_by    TEXT
);

CREATE TABLE consent_preferences (
  world_id        TEXT NOT NULL,
  foundry_user_id TEXT NOT NULL,
  display_name    TEXT,
  opt_out         INTEGER NOT NULL,
  notice_version  TEXT,
  updated_at_ms   INTEGER NOT NULL,
  PRIMARY KEY (world_id, foundry_user_id)
);

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

CREATE TABLE markers (
  marker_id     TEXT PRIMARY KEY,
  session_id    TEXT NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ts_ms         INTEGER NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('scene','break','combat','note','other')),
  label         TEXT NOT NULL DEFAULT '',
  mental_note   INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL
);

CREATE TABLE settings (
  key           TEXT PRIMARY KEY,
  value_json    TEXT NOT NULL,
  updated_at_ms INTEGER NOT NULL
);

CREATE INDEX idx_jobs_session_created ON jobs(session_id, created_at_ms);
CREATE INDEX idx_markers_session_ts   ON markers(session_id, ts_ms);
CREATE INDEX idx_people_session       ON people(session_id);
CREATE INDEX idx_sessions_created     ON sessions(created_at_ms);
```

`settings` stores non-secret operational values, for example: `db_schema_version`, `foundry_data_path`, `default_guild_id`, `default_voice_channel_id`, `stt_model`, `stt_device`, `stt_compute_type`, `stt_model_dir`, `stt_language`, `roll_context_before_ms`, `roll_context_after_ms`, `recent_context_seconds`, `foundry_live_enabled`, `foundry_live_markers`, `foundry_live_status`, `foundry_bridge_token`, `capture_test_max_seconds`. `DISCORD_TOKEN` and `DASHBOARD_TOKEN` live only in `.env`. The **bridge token** is an intentional exception: it is generated on first use and stored in `settings` (or fixed with `FOUNDRY_BRIDGE_TOKEN`) so the GM can copy it into the Foundry module. It authenticates only the loopback live-bridge endpoint; it is not the Discord token or dashboard token.

Migrations are additive and run on `Store` construction. Existing databases gain `markers.mental_note` with a default of 0 without rewriting sessions or markers.

## Timestamp and session-filter rules

1. **One clock on one host.** Discord capture and Foundry timestamps are expected to come from the same Windows machine clock. The recorder stamps utterances with `Date.now()`; Foundry messages carry the server-generated `timestamp` in ms. If Foundry runs on another host, timestamps may skew; this version warns but does not auto-correct.
2. **Foundry filtering window.** After capture, imported Foundry messages are included when `timestampMs >= startedAtMs - filterMarginMs` and `timestampMs <= stoppedAtMs + filterMarginMs`. Default margin is 300000 ms (5 minutes). Messages outside the window stay in `foundry/export.json` but are excluded from `foundry/events.jsonl` and reported in the import summary.
3. **Speech filtering.** An utterance is included when its `startMs` falls inside the same window. Speech timestamps are never rewritten to the Foundry clock.
4. **Missing/invalid timestamps.** A Foundry message with a null or non-numeric timestamp is excluded with a warning; it is not guessed from `_stats` in v1.
5. **Sorting.** The merger sorts by `(tsMs, typePriority, sourceId)` as specified above; it never sorts by file order or string timestamps.
6. **STT offsets.** Transcript and word timestamps are absolute: `utterance.startMs + round(relativeSeconds * 1000)`. Values are clamped to `[utterance.startMs, utterance.endMs]` and flagged `offset_clamped` if changed.
7. **Markers** use their own absolute `tsMs` and are merged like any other event.
8. **Display.** The session `timeZone` (for example `UTC`) is used only to render `HH:MM:SS` and ISO display strings in Markdown/CSV; all persisted times remain epoch ms.
9. **Re-import/re-run.** Re-importing replaces normalized Foundry events; re-running merge/render regenerates downstream artifacts. Raw capture and raw export files are never overwritten by merge/render.

## Derived outputs

- `outputs/transcript.md`: timestamped speech, grouped by speaker or chronology as configured.
- `outputs/chronology.md`: chronological speech, rolls, chat, and markers with system-specific summaries; mental notes are labelled and speech notes are annotated.
- `outputs/rolls.csv`: flat roll table (`timestampMs`, player, character, system, flavor, formula, total, FFG aggregates, source message ID, `voiceBefore`, `voiceAfter`, `nearestSpeechGapMs`, `syncConfidence`).
- `outputs/roll-sync.md`: one section per roll with before/after speech, nearest gap, and confidence.
- `outputs/mental-notes.md`: spoken and manual mental notes in timestamp order.
- `outputs/stats.md`: talk time, utterance/word counts, roll counts, rolls with nearby speech, mental-note count, and system-specific symbol totals.
- `outputs/notes-ready.md`: compact readable event log for a GM or a later LLM summarization phase: cast and consent, scene/break/combat sections, then clean speech, roll, and chat lines. Short backchannels are omitted (the full verbatim transcript stays in `transcript.md`), and raw event IDs, types, and sync debug fields are intentionally omitted; no generated prose is written.




