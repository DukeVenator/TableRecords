# TableRecords dashboard

The dashboard is the local control surface for TableRecords. It runs beside the Discord bot and recorder, shows live capture health, and drives the post-session pipeline.

**OBS and mixed-audio fallback are out of scope and are not used.** The only audio capture path is the Discord bot receiving per-user voice packets.

## Runtime topology

- One Node 26 LTS / TypeScript process runs:
  - the Fastify HTTP server on `http://127.0.0.1:17300` (loopback only);
  - the Discord bot client and the per-utterance recorder;
  - the job runner that spawns short-lived child processes (Python STT, filesystem work).
- React 19 + Vite builds a static SPA into `dist/web`; Fastify serves it with `@fastify/static`.
- Live state and job logs use **Server-Sent Events** (`GET /api/events`). Commands use JSON REST calls.
- Operational state is stored in `node:sqlite` at `data/tablerecords.db`; session artifacts live under `sessions/<sessionId>/` (see [DATA-FORMATS.md](DATA-FORMATS.md)).
- Speech-to-text runs locally for `transcribe` and `context` jobs: **Parrot (Parakeet)** through NeMo-Speech by default, or Python faster-whisper/Whisper. The engine, readiness of both stacks, and fine-tuning live in **Setup → Transcription**; the choice is saved to SQLite and applies to the next transcription. The dashboard never receives or displays the bot token.
- No external CDN, font, analytics, or cloud service is loaded by the UI. Discord itself remains a hosted service.

## Views

The interface has four screens: **Record** (live), **Sessions** (review), **People** (identity and
mapping), and **Setup** (connections and diagnostics). The same object has one canonical home: live
state and the last few moments on Record, everything else on the session page, cross-session identity
on People, and technical detail in Setup.

URLs are deep-linkable and kept in sync without reloading: `/`, `/sessions`, `/people`, and
`/setup`. The selected session is `?session=<id>` on any screen; the Sessions tab is
`&tab=overview|stats|people|rolls|files|activity`; the selected People row is `?person=<key>`. A
refresh or browser back/forward restores the screen, session, subtab, and selected person.

### 1. Record (`/`)

The default landing view, designed to fit on one screen while a session is running.

- **Status strip:** recording timer, audio health (`ok | warning | error` with the decrypt-error or
  skipped-silent count), how many people are in voice, when the last speech was heard, and how many
  rolls Foundry has captured.
- **Session card:** title, date, world, status, and four facts (started, length, consent, notes).
  The primary action follows the state: **Start recording**, **Stop and save**, **Open session**,
  or **Build notes** when the notes are missing or out of date. When the Foundry bridge is live, a
  **Prompt players in Foundry when recording starts** tick sends the consent notice through the
  bridge (checked whenever the bridge is live; untick to skip); the dashboard records the prompt and
  starts immediately, dropping anyone who opts out. A pre-flight panel explains any other blocker
  inline (bot not connected, notice not shown, no voice channel) with the action that clears it.
- **Voice channel:** server and channel pickers, **Join**, **Leave**, and **Test audio**. A test
  reports clips and bytes per person, decryption errors, and the test ID, and names the likely fix
  when no audio arrives. **Connection details** exposes DAVE state, the voice privacy code,
  decryption failures, reconnects, speaking events, the test ID, server/channel IDs, and the bot
  identity.
- **Mark a moment:** an optional label plus **Scene**, **Break**, **Combat**, **Note**, and
  **★ Note to self**. The last eight markers and spoken notes are listed together with their time;
  markers can be removed.
- **Who is being heard:** participants currently known from Discord, with character, recorded
  length and bytes, clip count, and last-heard time. A decryption-error column appears only when a
  speaker has errors, so a DAVE regression is visible without adding noise to a healthy session.
- **Session brief:** choose 1/3/5/10/15 minutes and queue a brief. Progress, queue position, and
  failures are shown inline. When AI summaries are configured, choose a **Scope** (recent, current
  scene, whole session), a **Preset** (GM prep, session recap, clue board, rules log), and press
  **Summarize**. A floating progress panel shows the current phase, portion number, and a bar while
  the summary runs; a long session shows each portion and reduction step. The summary history lists
  earlier results with model, scope, and time.
  “What goes in the brief?” explains the contents without pipeline jargon.
- **Files:** when notes exist, shows when they were built and offers direct downloads of the
  transcript, AI-ready notes, and rolls, plus **All files** (opens Sessions). No per-file button
  grid here.
- Warnings appear above the cards; a running job appears in a banner with progress and ETA.

Disk space, the active engine/model, and bot/version details live in **Setup**; DAVE and privacy
codes live in **Connection details** on this page. Nothing is removed from the app, only moved to
where it is useful.

### 2. Sessions (`/sessions`)

- **Recording list:** grouped by **game/campaign** (the session's stored label, falling back to the
  Foundry world title, then “Unsorted”), with a filter to show one game. Each group is collapsible
  and shows its recording count; rows show title, date, system, length, and status.
- **New session:** **Start from a previous session** copies its world, game/campaign, and player
  table in one choice; edit an individual character when a player swaps. The table is a row editor
  (name, optional Discord ID, character, role) with **Add a saved player** from People and previous
  sessions, **Add blank row**, and remove. The GM has separate name/ID fields. Title, server, voice
  channel, notes, and consent are below. No `name | id | character` text is required.
- **Session header:** date, length, and people count, the current status, a contextual primary
  action (**Start recording**, **Stop and save**, **Build notes**, or **Open folder**), **Copy ID**,
  and **Archive**. An out-of-date file set is badged in the header.

Tabs:

- **Overview:** a callout when notes are missing or stale (with **Build notes**), four facts
  (recorded, people, rolls, notes), a compact data line (clips, transcripts, Foundry events,
  timeline events, audio size), a **Session X on disk** summary with a stacked storage bar and
  category legend (per-clip audio, review tracks, STT, notes/outputs, Foundry, context, jobs, other)
  plus an explicit **Notes X** figure, an **AI summary** panel with **Scope**, **Preset**, a window
  for recent scope, **Summarize**, and the saved-summary list, a one-line consent summary with the
  opt-out list and a **Read the full notice** disclosure, **Speech around rolls**, the session notes
  editor, the moments list, and an **Advanced settings and danger zone** disclosure containing the
  game/campaign label, title, Foundry version, session ID with copy, and delete.
- On screens narrower than 1000 px, the recording list and the selected session share one column.
  Choosing a recording opens its detail, and **← All games** returns to the list. People uses the
  same list/detail pattern with **← All people**.
- **Stats:** session totals (length, speech coverage, combined talk time, words, turns, rolls,
  mental notes), highlight cards (most talkative, longest turn, quietest active speaker, overlap),
  a 28-slice **Talk over time** pulse coloured by the dominant speaker, and per-speaker cards with
  talk share, utterances, words, turns, longest turn, average utterance, words/minute, short clips,
  and first/last heard offsets. Words come from the transcript records; opted-out people appear as
  **not recorded** with zero talk time.
- **People:** person, character, **Foundry user**, role, and **Record** by default. A **Show Discord
  and Foundry IDs** switch adds the raw ID columns. The Foundry directory count and **Match names**
  helper are visible whenever the live module has published a directory. Unticking **Record** opts
  someone out. People currently in the voice channel can be added in one click, and saved people
  become roster options for future sessions.
- **Rolls:** download the macro and import its export, or read the live snapshot (last update,
  events, scene, combat, module version). Live pushes refresh this tab without a manual reload; the
  People tab's Foundry directory refreshes from the same push.
- **Storage & cleanup:** shows clip count/bytes, review-track count/bytes, transcript count, notes
  count/bytes, and the total session-folder size grouped by category (clips, review, STT,
  notes/outputs, Foundry, context, logs, other). **Compact
  clips** rewrites each WAV to 16 kHz mono (about 6x smaller; playback and transcription keep
  working). **Delete clips** removes the per-clip WAVs entirely after the review mix exists, moving
  the manifest to `manifest.removed.jsonl` and leaving a marker. Both actions require the master and
  speaker tracks, and both ask for confirmation. After deletion, rebuilding notes reuses the
  existing transcript, or cuts windows from the saved speaker tracks if the transcript is missing.
- **Files:** grouped by purpose, each file with a one-line description and **Read** / **Download**
  (**Open** for files too large to preview). **Read** on a `.md` file opens a rendered Markdown view
  (headings, lists, tables, code, links) with a **Preview / Markdown source** toggle and a navigation
  sidebar: **Contents** lists every document heading, **Session moments** lists scene/break/combat/note
  markers with times and colours. Clicking a heading scrolls the pane; clicking a moment finds that
  timestamp and flashes it. CSV and other
  non-Markdown files stay as raw text. The renderer is local, dependency-free, and escapes raw HTML.
  Groups: *read after the session* (transcript,
  notes-ready, chronology), *rolls* (rolls.csv, roll-sync), *reference* (mental notes, stats), then
  *listen back* (review audio waveforms) and *individual clips* (the 20 most recent, behind a
  disclosure). The review mix is assembled automatically after transcription; a large session shows
  a warning and asks for confirmation before a manual rebuild. Clips are streamed in batches of 500
  (`REVIEW_AUDIO_BATCH_CLIPS`), then stitched into the speaker tracks and master, so the old
  500-clip limit is gone. Each speaker track is dynamically normalized (peak target -1 dB, up to
  +40 dB gain) before the master mix (disable with `REVIEW_AUDIO_NORMALIZE=0`). Waveforms are small
  white PNGs generated once by
  ffmpeg and cached under `review/waveforms/`; the browser never decodes the multi-hour MP3. The
  master waveform is tinted by the active speaker using the utterance timeline, and scene/break/
  combat/note markers appear as clickable bookmarks on every track. Native range streaming lets
  playback and seeking work on files over 100 MB; failures show the browser media error and a
  download fallback. A stale-output callout offers
  **Rebuild**.
- **Activity:** **Build notes** plus visible **Speech only**, **Rolls only**, and **Files only**
  actions, the latest build, and earlier builds under a disclosure. Each build has **Details**
  (log), **Stop**, and **Run again**.

### 3. People (`/people`)

Cross-session identity and mapping. The directory is the union of people recorded in any session
plus saved game roster profiles; people who opted out sort first.

- **Directory:** search by name, character, or game, filter by game, and select a person. Each row
  shows names, characters, game count, recording count, and consent badges.
- **Person card:** recordings, games, characters, and roles; Discord name/ID and Foundry user;
  saved game profiles under a disclosure. Read-only identity fields are intentionally edited on the
  session that owns the mapping.
- **Career stats:** loads every appearance on selection and aggregates sessions, games, characters,
  talk time, share of table talk, utterances, words, words/minute, and speaker review-audio bytes.
  **Characters played** and **Games spotted in** show their own session/talk/word totals; first and
  last appearance and opted-out session count sit below. Each recording row also shows that
  session’s talk, words, and review-audio size.
- **Recordings:** grouped by game. Each appearance has role, character, and **recorded/opted out**;
  **Save** writes only that session’s `people.json` and roster profile, and **×** removes the
  mapping without deleting the recording or transcript.
- **Add to a recording:** pick any session that does not already include the person.
- **Add to a whole game:** adds the person to every recording in that game that does not already
  include them, after a confirmation. This is the bulk way to map a regular player into a campaign.

People with no Discord ID can be viewed but not added elsewhere until an ID is set on one of their
recordings; this prevents creating a second, unmatched identity.

### 4. Setup (`/setup`)

- **Status:** a compact strip (disk free, active engine and state, DAVE state, version) above the
  checks. Only warnings and errors are listed first, each with its hint; everything healthy is
  collapsed under “The other checks passed”. **Run checks** and **Refresh** rerun the doctor.
- **Setup checklist:** the old static “manual gates” list is now live. Each row reflects real state
  (token, invite, audio test, speech-to-text, Foundry folder, bridge), shows done/optional, and
  carries its own action: open the Discord developer portal, open the invite, run the guided audio
  test, focus the Foundry folder, or install the module. Foundry rows are marked optional. The audio
  test opens a modal that chooses the server and a populated voice channel, has the bot join, listens
  for 10 seconds, then asks **Did you talk?**; it only marks the step done when you confirm speech
  and clips were captured. A **tested** checkbox marks it manually. The result is remembered in this
  browser for 24 hours; a failed test clears it.
- **Discord bot:** the application ID derived from the bot token (the token itself is never shown),
  the generated **invite link** with View Channel + Connect + Speak, **Copy** / **Open**, and a
  **Check again** button. The link is regenerated from the token at startup, so it works before the
  bot has ever connected.
- **Bot personality:** Scribblespark's server nickname (default **Scribblespark**), activity type
  (default Watching), base activity text (default “every adventure (and slowly destroying this
  computer)”), and a **Live activity** switch. With live activity on, the presence follows the
  current session, microphone test, note processing, or voice channel; with it off, the base text
  stays. Saving applies the nickname and presence to the connected Discord client immediately.
- **Setup wizard:** a guided version of the checklist with one card per step, a required-step
  progress bar, and the same actions. It opens automatically on first run when no
  `DISCORD_TOKEN` is configured, can be dismissed, and is always available from **Setup → Setup
  wizard**. The Foundry steps can be skipped; we recommend the bridge, and the macro export is a
  lighter option. The audio step runs the same guided test and offers
  **I already tested**; the speech step offers the engine choice and a **Use Whisper instead**
  shortcut when Parrot is not ready.
- **Transcription:** engine selector (**Parrot (Parakeet)** default, or **Whisper**), spoken
  language, and a readiness line from the active engine. Parrot exposes model/runtime paths, device,
  and concurrency. Whisper exposes model, device, precision, beam size, and a **Whisper fine tuning**
  disclosure for no-speech/log-probability/compression thresholds and Silero VAD. A **Vocabulary
  hints** disclosure adds an extra Whisper prompt and hotwords shared with Parrot. **Run checks**
  reruns the doctor.
- **Notes:** speech before/after a roll, and the default brief length.
- **Foundry:** the bridge setup, with the Foundry folder, module install, connection state, token
  (copy/rotate), live-roll toggles, and a bridge setup disclosure. A separate macro disclosure
  explains the lighter export path.
- **AI summary (optional):** off by default, loopback address, model, timeout.
- **Advanced:** this computer's paths and versions, token configuration, one-time setup notes, and
  the Discord server list.
- **How recording works:** three short paragraphs on capture, transcription, and privacy.

Environment paths and package versions stay in the Advanced disclosure. The `.env` file is named
only where a setting cannot be changed in the app (the bot and dashboard tokens).
Speech-to-text engine and tuning are app settings now.

Settings saved to SQLite: the Foundry folder, speech-to-text engine and both engines' tuning
(model, device, precision, beam, VAD, thresholds, prompt/hotwords), speech around rolls, brief
length, live-bridge enable/marker switches, and the AI summary provider/model/timeout/input budget.
Default guild and voice channel are stored by the API for other clients but
are not exposed in this form. `DISCORD_TOKEN` and `DASHBOARD_TOKEN` stay in `.env`; the generated
Foundry bridge token is shown because the GM must paste it into the module. The DeepSeek key also
stays in `.env`; the dashboard shows only whether it is configured.

## Record wireframe

```text
+---------------------------------------------------------------------------------------------+
| TableRecords      [Record] [Sessions] [Setup]        Discord connected  Voice off  Foundry  |
+---------------------------------------------------------------------------------------------+
| Recording      | Audio         | In voice     | Last heard | Rolls                          |
| Not recording  | Good          | 4 people     | 12s ago    | 117 captured live              |
| Ready          | 0 errors      | Comms        | 3 heard    |                                |
+----------------+---------------+--------------+------------+--------------------------------+
| [redacted campaign] — 2026-11-01            SAVED   | Voice channel                          |
| 01 Nov 2026 · FFG narrative dice · Cartel              | The bot only listens.                  |
| Started 12:39  Length 3h51m  Consent  Notes       | [[redacted server] v] [Comms v]                |
| [Start recording] / [Stop and save]               | [Join] [Leave] [Test audio]            |
|                                                   | ▸ Connection details (DAVE, code, …)   |
+---------------------------------------------------+----------------------------------------+
| Mark a moment                                     | Who is being heard                     |
| [label…………] [Scene] [Break] [Combat] [Note] [★]   | ● [redacted GM]  GM  1h12m 312  2m ago  |
| SCENE   [redacted scene]                14:07    | ○ The G.O.A.T  48m   140  4m ago       |
+---------------------------------------------------+----------------------------------------+
| Session brief                                     | Files                                  |
| [Last 3 minutes v] [Generate brief] [Open latest] | Last built 01 Nov 2026, 17:00          |
| ▸ What goes in the brief?                         | Session transcript          [Download] |
|                                                   | Notes for your AI           [Download] |
|                                                   | Rolls                       [Download] |
+---------------------------------------------------+----------------------------------------+
```



## API

All endpoints are under `/api`, return JSON unless noted, and use integer epoch-ms timestamps. Errors:

```json
{"error":{"code":"invalid_state","message":"Recording is already active","details":{}}}
```

| Method | Path | Purpose | Request | Response |
|---|---|---|---|---|
| GET | `/api/status` | Full current status | — | `StatusSnapshot` |
| GET | `/api/events` | SSE stream | — | `text/event-stream` |
| POST | `/api/auth` | Exchange optional dashboard token for session cookie | `{token}` | 204 + `Set-Cookie` |
| DELETE | `/api/auth` | Clear dashboard session | — | 204 |
| GET | `/api/health` | Fast health checks | — | `{checks: Check[]}` |
| POST | `/api/doctor/run` | Deep checks (bot, STT, Foundry, disk) | — | `{checks: Check[], ranAtMs}` |
| GET | `/api/settings` | Operational settings, AI summary status, Foundry bridge token/status, environment status | — | `{settings, llm, foundryBridge, env}` |
| PUT | `/api/settings` | Update settings | `{foundryDataPath?, defaultGuildId?, defaultVoiceChannelId?, sttModel?, sttDevice?, sttComputeType?, sttLanguage?, rollContextBeforeMs?, rollContextAfterMs?, recentContextSeconds?, llmEnabled?, llmProvider?, llmCloudEnabled?, llmBaseUrl?, llmModel?, llmTimeoutMs?, llmMaxInputChars?, llmContextTokens?, llmGpuLayers?, llamacppNcpuMoe?, llamacppKvCache?, llamacppFlashAttn?, llamacppExe?, llamacppModelPath?, llamacppPort?, llamacppAutostart?, llmThinkingEffort?, foundryLiveEnabled?, foundryLiveMarkers?}` | `{settings, llm, llamacpp, foundryBridge, env}` |
| GET | `/api/discord/guilds` | Bot guilds | — | `{configured, guilds:[{id,name}]}` |
| GET | `/api/discord/guilds/:guildId/channels` | Voice channels plus bot permissions | — | `{voiceChannels:[{id,name,parentName,memberCount,userLimit,permissions:{viewChannel,connect,speak}}]}` |
| GET | `/api/people` | Cross-session people directory with game/recording appearances and roster profiles | — | `{people:[...],games:[...]}` |
| GET | `/api/people/roster?worldId=...` | World-scoped reusable player/character mappings | — | `{profiles}` |
| GET | `/api/discord/channels/:channelId/members` | Members currently in a voice channel | — | `{members:[{userId,displayName,username,isBot}]}` |
| POST | `/api/discord/join` | Bot joins a voice channel | `{guildId, channelId}` | `StatusSnapshot`; 409 if recording |
| POST | `/api/discord/leave` | Bot leaves voice | — | `StatusSnapshot`; 409 if recording |
| POST | `/api/capture-test/start` | Start a temporary capture test | `{guildId, channelId}` | `{testId, startedAtMs}` |
| POST | `/api/capture-test/stop` | Finish the test and return diagnostics | — | `{testId, utteranceCount, totalBytes, decryptionFailures, speakers, warnings}` |
| GET | `/api/foundry/worlds` | Installed Foundry worlds | — | `{worlds:[{id,title,system,systemVersion,foundryVersion}]}` |
| GET | `/api/foundry/macro` | Macro source as a download | — | `text/javascript` attachment |
| POST | `/api/foundry/module/install` | Copy the optional Foundry module into the configured data path | — | `{installedTo, modulesDir, note}` |
| POST | `/api/foundry/bridge/rotate` | Rotate the live-bridge token (refused when `FOUNDRY_BRIDGE_TOKEN` is set) | — | `{token}` |
| GET | `/api/foundry/live/status` | Live bridge connection/scene/combat status | — | `{status}` |
| POST | `/api/foundry/live` | Foundry module ingress (CORS, token header, no cookie); also accepts `consent.promptSent`, `consent.responses`, and `events` (break markers) | `tablerecords.foundry-live/v1` | `{accepted, acceptedMessages, skippedMessages, duplicateMessages, noteAccepted?, eventsAccepted?, eventsSkipped?, consentAccepted?, consentResponses?, consentSessionId?, sessionId, status}` |
| POST | `/api/foundry/control` | Start, pause, resume, or stop the current recording from the bridge (CORS, token header); `action: "status"` reads the capture state | `{action, sessionId?, promptPlayers?}` | `Status` or `{ok, state, sessionId}` |
| POST | `/api/foundry/player-drafts` | Generate a private, player-safe draft for the connected world (CORS, token header, no dashboard cookie). The server never posts to Foundry chat; the GM client publishes the reviewed text. | `{world:{id,title?}, kind, windowSeconds?, endMs?, transcribe?}` where `kind` is `recap`, `names`, or `clues` | `tablerecords.player-draft/v1`; 409 while another draft or processing job is active |
| GET | `/api/sessions` | Session summaries | — | `{sessions: SessionSummary[]}` |
| POST | `/api/sessions` | Create a draft session | `{title?, date?, worldId?, voiceChannelId?, guildId?, participants?, consent?, notes?}` | 201 `SessionDetail` |
| GET | `/api/sessions/:id` | Full session detail | — | `SessionDetail` |
| PATCH | `/api/sessions/:id` | Edit title/consent while draft/error; notes are editable in any status | subset of create fields | `SessionDetail` |
| PUT | `/api/sessions/:id/merge-settings` | Set this session's roll-context before/after values | `{rollContextBeforeMs, rollContextAfterMs}` | `SessionDetail` |
| POST | `/api/sessions/:id/archive` | Archive or restore a session (not while recording) | `{archived?}` | `SessionDetail` |
| DELETE | `/api/sessions/:id?confirm=<id>` | Permanently delete a session and its folder | exact session ID in `confirm` | 204; 409 if active/live job |
| PUT | `/api/sessions/:id/people` | Replace speaker/character mapping | `{people:[{discordUserId?,foundryUserId?,character?,role?,consent?,aliases?}]}` | `SessionDetail` |
| POST | `/api/sessions/:id/start` | Join (if needed) and start recording | — | `StatusSnapshot`; 409 if active |
| POST | `/api/sessions/:id/stop` | Stop, finalize WAVs/manifest, leave voice | — | `StatusSnapshot`; 409 if not recording |
| POST | `/api/sessions/:id/markers` | Add a marker or mental note | `{tsMs?, kind, label?, mentalNote?}` | 201 `Marker` |
| DELETE | `/api/sessions/:id/markers/:markerId` | Delete a marker | — | 204 |
| POST | `/api/sessions/:id/foundry/import` | Upload a macro export | multipart `file` (`.json`, ≤64 MiB) | `FoundryImportSummary` |
| POST | `/api/sessions/:id/context/recent` | Queue a GM-context job and wait for its brief (legacy long-poll) | `{windowSeconds?, transcribe?, endMs?, queue?}` | `RecentContext`; `{job}` with 202 when `queue:true` |
| POST | `/api/sessions/:id/context/jobs` | Queue a GM-context job immediately | `{windowSeconds?, transcribe?, endMs?}` | 202 `Job` |
| POST | `/api/sessions/:id/llm/summarize` | Build a brief and save an AI summary | `{preset?, scope?, windowSeconds?, endMs?}` | `LlmSummaryRecord`; 409 when disabled/unconfigured |
| GET | `/api/sessions/:id/llm/summaries` | Saved summary history for a session | — | `{summaries: LlmSummaryRecord[]}` |
| GET | `/api/sessions/:id/llm/summaries/:summaryId` | One saved summary | — | `LlmSummaryRecord` |
| GET | `/api/llm/models` | List models from the configured provider | — | `{provider, models}` |
| POST | `/api/llm/test` | Test the configured provider without sending session text | — | `{ok, provider, latencyMs, models}` |
| GET | `/api/llamacpp/status` | Managed llama.cpp server state, health, PID, and log tail | — | `LlamaCppStatus` |
| POST | `/api/llamacpp/browse` | Open the local executable or GGUF picker | `{kind: "exe" \| "model"}` | `{path}` |
| POST | `/api/llamacpp/start` | Start the configured `llama-server` (refused when another server already answers) | — | `LlamaCppStatus`; 502 with the launch error |
| POST | `/api/llamacpp/restart` | Stop and start the managed server so saved launch settings apply | — | `LlamaCppStatus` |
| POST | `/api/llamacpp/stop` | Stop the managed `llama-server` | — | `LlamaCppStatus` |
| GET | `/api/sessions/:id/jobs` | Jobs for a session | — | `{jobs: Job[]}` |
| POST | `/api/sessions/:id/jobs` | Queue a processing job | `{type:"transcribe"|"merge"|"render"|"run_all"|"context"}` | 202 `Job` |
| GET | `/api/jobs/:jobId` | Job detail | — | `Job` |
| POST | `/api/jobs/:jobId/cancel` | Cancel queued/running job | — | `Job` |
| POST | `/api/jobs/:jobId/retry` | New job with same type/request | — | 202 `Job` |
| GET | `/api/jobs/:jobId/logs` | Log tail | `?afterSeq=&limit=` | `{jobId, lines:[{seq,tsMs,level,line}]}` |
| GET | `/api/sessions/:id/outputs` | Output file list | — | `{outputs:[{name,sizeBytes,modifiedAtMs,previewable}]}` |
| GET | `/api/sessions/:id/outputs/:fileName` | Preview/download output | `?download=1` forces an attachment | text/markdown, text/csv, text/plain |
| POST | `/api/sessions/:id/review-audio` | Build timestamp-aligned review audio | — | `ReviewAudioManifest` |
| GET | `/api/sessions/:id/storage` | Session-folder size grouped by category | — | `{totalBytes,totalFiles,categories,audio}` |
| GET | `/api/foundry/commands` | GM module polls for queued commands (consent prompt) | `x-tablerecords-token` | `{commands, serverTimeMs}` |
| POST | `/api/sessions/:id/audio/compact` | Rewrite clips as 16 kHz mono WAV after ensuring review audio | — | `{before, after, converted}` |
| POST | `/api/sessions/:id/audio/remove` | Delete per-clip WAVs, keep review tracks/transcripts | — | `{before, after}` |
| GET | `/api/sessions/:id/review-audio/:fileName` | Stream a review mix | — | `audio/mpeg` |
| GET | `/api/sessions/:id/audio/:utteranceId` | Play a captured utterance | — | `audio/wav` |
| POST | `/api/sessions/:id/open-folder` | Open session directory in Explorer | — | 204 |

Auth rules are described in **Security**. `StatusSnapshot`, `SessionDetail`, `Job`, `Marker`, and `FoundryImportSummary` shapes are defined in the SSE section and in [DATA-FORMATS.md](DATA-FORMATS.md).

## SSE event model

`GET /api/events` returns `text/event-stream`; each event has an `id` and an `event` name. Every new connection immediately receives a `status` event. Events are best-effort: clients refetch `GET /api/status` after reconnect and fetch job logs through the logs endpoint.

| Event | Data | When |
|---|---|---|
| `status` | Full `StatusSnapshot` | On connect; on state change; every 1 s while recording or a job is running; every 10 s when idle |
| `session.updated` | `{sessionId, status, summary}` | Session state transitions and metadata/mapping changes |
| `utterance.completed` | `DiscordUtterance` | A WAV and manifest line are finalized |
| `job.updated` | `Job` | Enqueue, start, progress, done, failed, cancelled |
| `job.log` | `{jobId, seq, tsMs, level, line}` | New log line (also persisted in the job log) |
| `marker.created` | `Marker` | Marker added |
| `foundry.imported` | `FoundryImportSummary` | Successful macro import |
| `foundry.live` | `FoundryLiveStatus` | Live module heartbeat, messages, scene/combat, connection state |
| `recent.context` | `{sessionId, generatedAtMs, counts, transcribed}` | A recent-window brief was built |
| `llm.progress` | `{progressId, sessionId, phase, completed, total, label}` | A summary is preparing, chunking, reducing, or finishing |
| `warning` | `{code, message}` | Recoverable condition (import window, clock skew, etc.) |
| `heartbeat` | `{tsMs}` | Every 15 s |

### Status snapshot

```json
{
  "schema": "tablerecords.status/v1",
  "generatedAtMs": 1793430374000,
  "server": {"version": "0.1.0", "startedAtMs": 1793420000000, "uptimeMs": 10374000},
  "bot": {"configured": true, "state": "ready", "userId": "241234567890123456", "username": "TableRecords", "gatewayPingMs": 42, "error": null},
  "voice": {"state": "ready", "guildId": "111", "guildName": "Table", "channelId": "222", "channelName": "FFG", "privacyCode": "482 913", "daveEnabled": true, "error": null},
  "capture": {
    "state": "recording",
    "sessionId": "2026-01-01-demo-world-demo-session",
    "startedAtMs": 1793430360000,
    "elapsedMs": 14000,
    "health": "ok",
    "utteranceCount": 3,
    "totalBytes": 842240,
    "decryptionFailures": 0,
    "reconnectCount": 0,
    "speakers": [
      {"discordUserId": "241234567890123456", "displayName": "Alice", "character": "Veyra Sol", "speaking": true, "capturedMs": 121000, "utteranceCount": 2, "bytes": 614400, "lastUtteranceAtMs": 1793430371000, "decryptionFailures": 0}
    ]
  },
  "session": {"currentId": "2026-01-01-demo-world-demo-session", "title": "Demo Campaign", "system": "starwarsffg", "worldId": "swffg-cartel", "status": "recording"},
  "foundry": {"imported": false, "messageCount": 0, "rollCount": 0, "importedAtMs": null, "warnings": [], "live": {"enabled": true, "markers": true, "connected": true, "lastSeenAtMs": 1793430370000, "moduleVersion": "0.1.0", "foundryVersion": "14.369.0", "world": {"id": "swffg-cartel", "title": "Cartel"}, "system": {"id": "starwarsffg", "version": "2.0"}, "scene": {"id": "s1", "name": "Cantina"}, "combat": null, "paused": false, "targetSessionId": "2026-01-01-demo-world-demo-session", "eventCount": 3, "lastError": null}},
  "jobs": {"queued": 0, "running": 1, "failed": 0, "active": {"jobId": "job_7f2", "type": "transcribe", "status": "running", "progress": {"phase": "transcribe", "completed": 40, "total": 214, "percent": 18.7}}},
  "stt": {"available": true, "device": "cuda", "model": "large-v3-turbo", "modelPresent": true, "state": "ready", "error": null},
  "disk": {"freeBytes": 87200000000},
  "warnings": []
}
```

Health rules for the `capture.health` badge:

- `error`: recording and the voice state is not connected; **or** a decryption failure was observed in the last 60 s; **or** speaking events were observed but zero audio bytes arrived for 30 s.
- `warning`: a reconnect occurred during this capture; **or** no utterance has arrived for 10 minutes while members are present; **or** one isolated decryption failure.
- `ok`: otherwise (including “waiting for first speech”).

## State machines

### Session

```text
draft --start--> joining --ready--> recording --stop--> stopping --> captured
  |                  |                 |                  |
  |                  +--failure--> error                  +--> processing --> ready
  |                                                              |
  +--PATCH allowed                                               +--> error
```

- `draft`: metadata and people editable. Start requires consent confirmed (GM tick or a fresh Foundry player prompt), a selected voice channel, and no other active capture.
- `joining`: bot is joining/waiting for voice Ready. No edits, join, or leave.
- `recording`: no metadata edits; people/markers may be changed; stop is the only terminal action.
- `stopping`: streams closing and WAV headers/manifest being finalized. No commands except status reads.
- `captured`: capture finalized; Foundry import and jobs allowed. A new recording requires a new session.
- `processing`: at least one job is queued/running. Jobs may be cancelled; merge/render can be re-run.
- `ready`: outputs exist and no job is active. Jobs can be re-run.
- `error`: the last transition failed; message is shown. Start may be retried only if no capture exists; otherwise create a new session. Jobs may still run on existing artifacts.
- Every transition writes `session.json` atomically (temp file + rename) and updates SQLite, then emits `session.updated`/`status`.

### Job

```text
queued --start--> running --success--> done
  |                  |--failure--> failed
  +--cancel--> cancelled <--cancel--+
```

- One job runs at a time globally (the Python/GPU stage and merge/render are serialized). Queue is FIFO; queued jobs carry a 1-based `progress.queuePosition` and their detail says where they are waiting.
- Retry creates a new `jobId` with the same type/request; old records are retained.
- Restart recovery: jobs left `running` are marked `failed` with code `interrupted`; no automatic resume.
- `transcribe` requires at least one manifest utterance and an available Python sidecar. Success requires at least one transcript record; per-utterance failures are listed in `stt/transcript-errors.jsonl` and reported as job warnings. Clips marked `silent` by the capture VAD are skipped and reported in the result/log.
- `merge` requires a transcript **or** imported Foundry events; it writes `merged/timeline.jsonl`. Same-speaker transcript gaps up to `STITCH_GAP_MS` (default 2 s) are joined; short backchannel-only records are excluded.
- `render` requires a timeline; it writes the seven output files.
- `run_all` runs `transcribe` (skipped with a warning when there are no utterances), then `merge`, then `render`, under one job with stage-weighted progress (0–70 transcribe, 70–90 merge, 90–100 render).
- `context` runs a recent-window transcription (only missing utterances) and builds the GM brief. It is allowed while recording, does not change session status, and writes `context/recent-<jobId>.json`. It uses the same STT engine as a full transcribe.
- Cancel kills the child process, finalizes a cancelled status, and leaves partial derived files (they are regenerable). It never deletes raw audio or exported Foundry JSON.

## Security and local-only rules

- **Binding:** server listens on `127.0.0.1:17300` only. A non-loopback bind is refused. No LAN or remote mode in this version.
- **Auth:** `DASHBOARD_TOKEN` is optional. When unset, loopback access is trusted (single-user assumption) and the UI states this. When set, all `/api` routes require a valid `tr_session` cookie obtained by `POST /api/auth`; the cookie is `HttpOnly`, `SameSite=Strict`, `Path=/`, and not `Secure` because the transport is loopback HTTP. Auth attempts are rate-limited (5/minute) and the token is compared in constant time. `DELETE /api/auth` clears it.
- **Secrets:** `DISCORD_TOKEN` and `DASHBOARD_TOKEN` are read from `.env` only. They are never written to SQLite, session files, logs, API responses, or browser storage. The UI may show only `configured: true/false`. The **public application/client ID** is derived from the token at startup and exposed in settings so the dashboard can build the bot invite link; the token itself is not derivable from it. Child processes receive only the environment variables they need. The **Foundry bridge token** is generated/stored separately because the GM must paste it into the module; it authorizes `/api/foundry/live`, `/api/foundry/commands`, `/api/foundry/control`, and `/api/foundry/player-drafts`, is compared in constant time, and can be rotated in Setup (or fixed via `FOUNDRY_BRIDGE_TOKEN`). The token is stored as a Foundry world setting, so other clients can read it. That is acceptable only for the current loopback trust model. The Phase 2 split in [../ROADMAP.md](../ROADMAP.md) separates the recording-control secret and restricts CORS before remote access is supported.
- **Token UI:** when auth is enabled, the UI shows a token prompt, stores the resulting cookie, and never persists the token itself.
- **CSRF/CORS:** state-changing dashboard requests require JSON content type and a same-origin `Origin` header; the auth cookie is `SameSite=Strict`. No CORS headers are emitted for dashboard APIs. The Foundry bridge routes are the exception: `/api/foundry/live`, `/api/foundry/commands`, `/api/foundry/control`, and `/api/foundry/player-drafts` use explicit `OPTIONS` handlers, emit `Access-Control-Allow-Origin: *`, and use the bridge token header instead of cookies. They do not accept credentialed requests.
- **Path validation:** audio, outputs, logs, and session directories are resolved from database/manifest IDs, not raw user paths. Any resolved path must remain inside `SESSIONS_DIR`. Symlink escapes are rejected. `open-folder` accepts only a session ID and opens that session's known directory. Uploads are written to the session's `foundry/` directory with a generated name.
- **Uploads:** exactly one file, `.json` only, maximum **64 MiB**, multipart limits enforced before parsing. JSON request bodies are limited to **1 MiB**. The live bridge accepts at most 500 messages and 50 events per request, and a 500-character note. No archive extraction.
- **AI summaries:** off by default. Ollama and the local OpenAI-compatible provider accept only loopback hosts; credentials in the URL are rejected. The optional DeepSeek provider uses a fixed `https://api.deepseek.com` endpoint, requires both the cloud switch and `DEEPSEEK_API_KEY`, and never sends audio. No automatic retry or cloud fallback occurs.
- **Installer:** `POST /api/foundry/module/install` copies the server's own `foundry-module/` directory only, and only into the modules directory resolved from the user-configured Foundry data path. It never accepts a source/destination from the request body.
- **Outputs:** output file names come from a server-side allowlist (`transcript.md`, `chronology.md`, `rolls.csv`, `roll-sync.md`, `mental-notes.md`, `stats.md`, `notes-ready.md`); no arbitrary file serving.
- **Headers/CSP:** `Content-Security-Policy: default-src 'self'; img-src 'self' data:; media-src 'self'; connect-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'`. No external CDNs, fonts, or analytics. `X-Content-Type-Options: nosniff`.
- **Logging:** request logs redact cookies, authorization headers, tokens, and absolute user paths where practical. Discord debug output is captured only when explicitly enabled and never includes the token.
- **Destructive actions:** stop recording, cancel job, delete marker, archive, and delete session are confirmed in the UI. Session delete requires the exact session ID and refuses active recordings or queued/running jobs. The folder is moved into `sessions/.trash` before the DB row is removed, then cleaned up.

## MVP vs deferred

**MVP**

- Bot status/login, guild and voice-channel pickers, join/leave, capture test.
- Session creation, consent, people/character mapping, start/stop recording, markers, mental notes, per-session roll context, archive/restore, guarded delete.
- Live speaker/capture-health status via SSE, per-speaker bytes/utterances, DAVE/decryption visibility.
- Mental notes (manual + spoken) surfaced in session detail, with the deterministic files still authoritative.
- Foundry macro download, JSON import, validation summary, roll preview.
- Optional Foundry live module: chat/roll push, scene/combat state, auto markers, GM mental notes, and Break Time start/end markers.
- Mental-note markers and spoken-note detection; roll↔voice context with confidence.
- Recent-context transcription and copyable GM brief (1/3/5/10/15-minute windows).
- Jobs: transcribe, merge, render, run_all, context with queue position, per-clip detail, elapsed/ETA, logs, cancel, retry.
- Outputs preview/download/open-folder, utterance audio playback.
- Setup/health checks, settings, optional dashboard token, live-bridge token/install controls.

**Deferred**

- Direct LevelDB world import and a socket-relay/cloud Foundry bridge (the loopback module is the supported live path).
- Discord slash commands.
- Transcript correction editor and in-place text review.
- Remote/LAN access, TLS, multi-user accounts, role permissions.
- Scheduled retention/deletion automation and encrypted-at-rest management.
- Waveforms/audio analytics, charts, advanced reporting.
- AI summaries (Ollama, local OpenAI-compatible, and opt-in DeepSeek) with presets, scopes, structured clue boards, and saved history; the deterministic files remain canonical.





