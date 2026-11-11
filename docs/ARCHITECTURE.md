# TableRecords architecture

## Context and constraints

- Windows single-user local deployment; Foundry VTT and the Discord client run on the same PC.
- 3–4 remote players in Discord voice, FFG narrative dice first, SFRPG next.
- Fully local processing after package/model downloads; Discord itself is hosted and unavoidable.
- No OBS, no mixed-audio fallback, no diarization in the primary path.
- Discord voice reception is a beta/undocumented capability; it must fail loudly, not silently.
- The dashboard is the primary control surface; CLI/unit-level fallbacks exist for recovery and testing.

## Data flow

```text
Discord voice channel
  │  DAVE / Opus packets, sender identified by Discord user ID
  ▼
Discord bot process (inside Fastify server) ──► per-user utterance WAV + manifest.jsonl
  │                                               (absolute epoch-ms start/end)
  │
  ├── live status / speaker stats ──────────────► SSE ─► React dashboard
  │
  ▼
Session folder
  ├── discord/audio/<user_id>/<timestamp>-<utterance>.wav
  ├── discord/manifest.jsonl
  ├── foundry/export.json ──(GM macro; upload/import)──► foundry/events.jsonl
  ├── foundry/live-events.jsonl ◄──(optional GM module, loopback fetch)── live-state.json
  ├── stt/jobs.jsonl ──► Python faster-whisper batch ──► stt/transcript.jsonl
  ├── stt/recent-*.jsonl ──► same sidecar for the GM recent-context window
  └── merged/timeline.jsonl ──► outputs/{transcript,chronology,rolls,roll-sync,mental-notes,stats,notes-ready}.{md,csv}
```

No component writes to a remote service. Python only reads/writes the session job/transcript files.

## Components

### 1. Fastify server (`src/server`)

Single long-lived Node 26 LTS process on `127.0.0.1:17300`. Responsibilities:

- Load `.env`, validate config, serve the built React app and API.
- Own the Discord client, voice connection, recorder, session state, and job runner.
- Persist sessions/people/jobs/markers/settings in `node:sqlite`.
- Stream status/logs to the dashboard over SSE.
- Spawn Python STT as a child process; never expose the bot token to the browser.
- Reconcile interrupted state on restart; never pretend a recording is active after a crash.

Why one process: the dashboard must directly control the live voice connection and recorder. A separate recorder daemon would require IPC and duplicate lifecycle management for little benefit in a single-user local app.

### 2. Discord service and recorder (`src/server/discord`, `src/server/recorder`)

- `DiscordService`: login, guild/voice-channel discovery, permission checks, join/leave, state events, member name resolution.
- `RecorderService` state machine: `idle → joining → recording → stopping → idle | error`; active session id; subscriptions keyed by Discord user ID.
- On `speaking.start`: subscribe with `AfterSilence` ~1 s; decode Opus to 48 kHz stereo PCM; stream to a WAV writer; finalize on stream end; append manifest record.
- Capture diagnostics: dependency report, DAVE privacy code, per-user utterance count/bytes/last activity, error counters, voice connection state, channel membership.
- Unexpected disconnect: surface error; attempt one rejoin; if audio cannot be trusted, stop the session and mark it interrupted rather than continue silently.

### 3. Dashboard (`src/web` + API/SSE)

React 19/Vite SPA served by Fastify. Views: Dashboard, Sessions/session detail, Foundry import, Setup/Health. It displays live state and sends commands over REST; SSE delivers status/log updates. Full specification: [DASHBOARD.md](DASHBOARD.md).

### 4. Python STT sidecar (`python/`)

- Hosts faster-whisper and CTranslate2; model loaded once per batch.
- Input: JSONL jobs (audio path, utterance id, absolute start/end, speaker, prompt/hotwords config).
- Output: `transcript.jsonl`, with segment/word offsets converted to absolute epoch-ms; progress lines to stdout.
- Python is not allowed to touch SQLite, the Discord client, Foundry data, or the merge.
- Setup/health details: [STT.md](STT.md).

### 5. Foundry capture (`foundry-macros`, `foundry-module`, `src/core/foundry`)

- **Macro path:** the GM runs a pasteable script macro after the session; it exports ChatMessages with **prepared** Roll JSON (`RollFFG.toJSON()` includes `ffg`) and metadata. The dashboard validates, filters, and writes normalized `foundry/events.jsonl`.
- **Live path (optional):** the GM client runs a small Foundry module that POSTs new messages and scene/combat state to the loopback bridge with a dedicated token. A first-run wizard connects a fresh world and tests the token. The module writes `foundry/live-events.jsonl` and `foundry/live-state.json`, can create automatic scene/combat markers, saves Alt+M GM mental notes, and mirrors Break Time start/end state as break markers. A GM-only player-post panel requests a private draft from `POST /api/foundry/player-drafts`; public speech, chat, and rolls are filtered before the model call, and the GM client publishes only the reviewed text.
- Merge combines both event files and deduplicates by Foundry message id.
- Adapters select by system ID: `starwarsffg`, `sfrpg`, generic.
- No socket relay, cloud bridge, or direct LevelDB read. See [FOUNDRY.md](FOUNDRY.md) and [foundry-module/README.md](../foundry-module/README.md).

### 6. Merge and render (`src/core/merge`, `src/core/recent`, `src/core/render`)

- Join speech, rolls/chat, and markers by epoch-ms.
- Detect spoken mental notes at utterance starts and carry manual mental-note markers.
- Attach up to three speech lines before/after each roll with a confidence based on the nearest speech gap (high ≤3 s, medium ≤10 s, low otherwise).
- Resolve speech identity from Discord user ID → session person → character; rolls retain actor/alias/author labels.
- Render system-aware dice (FFG net symbols; SFRPG formula/total) into Markdown/CSV/stats, plus `roll-sync.md`, `mental-notes.md`, and the recent-context brief.
- `notes-ready.md` is a readable event log for a future LLM or GM: cast, consent, scene/break/combat sections, and clean speech/roll/chat lines. No invented prose and no raw debug fields.

### 7. Optional AI summaries (`src/server/llm`)

`LlmService` takes an already-built deterministic brief and sends it to one configured
provider: Ollama's native `/api/chat`, a local OpenAI-compatible `/chat/completions`, or
the opt-in DeepSeek cloud API. The feature is off by default and only runs when the GM
presses **Summarize**. It has no tools, no automatic retries, no fallback between
providers, and does not write to `outputs/`. Summaries are saved in a per-session
`llm/summaries.jsonl` sidecar with their model, preset, scope, and prompt version.
Long briefs are split into portions rather than silently dropping the middle. The
deterministic files remain the source of truth.

## Time and identity model

- **Timebase:** Unix epoch milliseconds everywhere. Recorder captures `Date.now()` at `speaking.start`; duration is derived from PCM byte count; Foundry `ChatMessage.timestamp` is server-generated epoch-ms. Same-PC clock assumption (Foundry local). Session start/stop bounds filter Foundry messages.
- **Utterance timing:** `startMs` absolute; `endMs = startMs + PCM frames / (rate × channels × 2) × 1000`; trailing silence may be included.
- **Identity:** Discord user ID is authoritative for speech. Foundry author/actor/alias are authoritative for rolls. The session mapping joins them explicitly; no fuzzy name matching. Character labels are per-system.

## Storage

- `sessions/<session_id>/` holds session metadata, WAVs, manifests, exports, jobs, transcripts, merged timeline, outputs.
- SQLite stores lightweight state/indexes only; large artifacts live on disk.
- No audio or transcript is stored outside the project data root (configurable via `SESSIONS_DIR`).
- Model cache under `models/`; gitignored.

## Security and trust boundaries

- Bind `127.0.0.1` only; optional `DASHBOARD_TOKEN` for shared machines. No LAN exposure in v1.
- Bot token read server-side from `.env`; never returned by API, rendered in UI, or logged.
- Upload limits and path validation for Foundry imports/audio routes; no arbitrary filesystem reads.
- The live bridge is a single token-authenticated, CORS-enabled endpoint; it does not use dashboard cookies and is rejected while disabled. The module installer copies only the server's own module directory into the configured Foundry modules path.
- CSRF-safe same-origin JSON API for the dashboard; confirmation before stopping an active session; no automatic destructive actions.
- Local-only processing by default; no external transcription or storage. Ollama and local OpenAI-compatible summaries stay on loopback. The optional DeepSeek provider is the one cloud exception and stays off unless both the cloud switch and a key are configured. Package/model downloads are setup-time only.

## Alternatives considered

| Choice | Decision and reason |
|---|---|
| OBS/mixed recording + diarization | **Rejected and excluded.** Mixed remote audio loses per-user identity and requires diarization; user explicitly declined OBS. |
| Discord bot per-user capture | Chosen. Speaker identity comes from Discord; no diarization. Risk: beta receive/DAVE, mitigated by capture test/diagnostics. |
| Self-hosted Craig | Viable fallback but heavier (Docker/Postgres/Redis, recording-container reconstruction). Not in MVP. |
| Foundry module + socket + GM relay | Partially adopted. A **loopback** GM module now streams live data over token-authenticated HTTP; a socket relay/cloud bridge is still rejected as unnecessary moving parts. The macro remains the fallback. |
| Direct Foundry LevelDB extraction | Deferred. Zero-click potential, but undocumented internal format and lock/compaction risk. |
| Python faster-whisper | Chosen for GPU speed and `initial_prompt`/hotwords/word timestamps. Node's `nodejs-whisper` retained as fallback only. |
| Electron desktop app | Rejected. Local web dashboard is simpler, debuggable in a browser, and needs no packaging. |
| better-sqlite3 | Rejected for MVP. Built-in `node:sqlite` avoids a native dependency. |

## Failure domains

| Domain | Behavior |
|---|---|
| Token/auth/permissions | Bot stays offline or join fails; dashboard explains the fix; no session starts. |
| Voice receive/DAVE | Zero/partial audio, decrypt counters, disconnected state; capture test and live health expose it. |
| No audio backup | If receive fails, the session audio is lost; user accepted this by rejecting OBS. |
| Python/CUDA/model | STT job fails cleanly with logs; CPU/other-model retry path; merge can still use rolls. |
| Foundry export | Invalid/missing file blocks only Foundry events; dashboard shows validation errors; speech can still merge. |
| Foundry live module | Offline/disabled/token failures are visible and retried with a bounded queue; the macro fallback still captures the session. |
| Dashboard crash | Recorder stops with the server; WAVs/manifest already written are recoverable; session marked interrupted on restart. |
| Disk/port | Startup/preflight checks and job errors; no silent overwrites. |

## External gates

1. Dedicated bot token + invite; user joins voice for the 60-second live test.
2. User enables the Foundry bridge in a world; the macro fallback is validated by fixtures and sandbox tests.
3. First-run faster-whisper model download and CUDA/cuDNN validation; CPU fallback.

See [FEATURES.md](../FEATURES.md) for the current surface and [ROADMAP.md](../ROADMAP.md) for planned work.

