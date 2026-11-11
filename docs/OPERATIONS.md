# Operations runbook

## Scope and hard constraints

This runbook covers a TableRecords session from setup through outputs.

- Discord audio is captured **per user by the TableRecords bot**. There is no
  mixed recording.
- **OBS is out of scope. There is no safety recording and no mixed-audio
  fallback.** If the bot fails to capture, that session has no audio. Do not
  start a real session until the capture test passes.
- We recommend the loopback **live bridge** for Foundry capture. It streams chat,
  rolls, and scene state during play. If you want a lighter setup, or the bridge
  cannot reach the dashboard, use the **pasteable GM macro export** instead.
  There is no socket relay, cloud bridge, or direct LevelDB reader, and both
  paths deduplicate by message ID.
- The dashboard can transcribe the last 1/3/5/10/15 minutes and produce a
  copyable GM brief for an external assistant. That brief is deterministic. The
  optional AI summaries run only after an explicit click; the feature is off by
  default.
- Live Discord validation requires a bot token you supply and a voice channel
  test. The application cannot create a Discord account or bot application.
- Processing is local by default. Ollama and local OpenAI-compatible summaries
  stay on loopback. The optional DeepSeek provider is the only cloud path and
  stays off unless both the cloud switch and a key are configured.

## Implemented verification path (no Discord required)

Use this to validate the local pipeline before a live session:

```powershell
npm run demo
npm run dashboard
```

Open `http://127.0.0.1:17300`. The demo session contains synthetic WAVs, a fixture
transcript, FFG narrative dice rolls, markers, mental notes, `merged/timeline.jsonl`,
and all seven outputs. This proves import/merge/render and the dashboard, but
**not** Discord voice receive. The live capture test below remains mandatory.

## Pre-session checklist

Do this in order, before anyone expects recording to be active.

### 1. Bot token and basic setup

- [ ] A dedicated Discord application/bot exists for TableRecords.
- [ ] A bot token is in `.env` as `DISCORD_TOKEN=...` (never paste it into chat
      or a screenshot).
- [ ] The bot is invited to the guild with `bot` scope and at least:
      **View Channel**, **Connect**, **Speak** on the voice channel to be used.
      The invite link is generated in **Setup → Discord bot**.
      The client uses the **Guilds** and **GuildVoiceStates** intents; no
      privileged message-content intent is required for capture.
- [ ] The bot is not a self-bot and does not automate a normal user account.
- [ ] The dashboard is running at `http://127.0.0.1:17300` (or the configured
      loopback port) and the Setup/Health page shows the bot logged in.

If the token is missing or invalid, stop here. Everything downstream depends on
the bot being able to join voice.

### 2. Health checks

- [ ] Dashboard/API is reachable.
- [ ] SQLite and the sessions directory are writable.
- [ ] Foundry data path is correct; the intended world is listed with its
      system and version.
- [ ] Discord dependency report has the DAVE and Opus libraries expected by the
      pinned client.
- [ ] Setup → **Run audio test** joins a populated channel, listens for 10
      seconds, and asks **Did you talk?**. Confirm only after clips were
      captured. Use the **tested** checkbox only if you already verified audio
      another way.
- [ ] Python venv exists and `stt_health` reports either working CUDA or an
      explicitly selected CPU mode (needed for Whisper).
- [ ] The chosen STT engine is ready in **Setup → Transcription**: Parrot
      (nemo-speech + GGUF) by default, or Whisper. The other engine can be
      selected if the chosen one is missing.
- [ ] The chosen STT model is cached, or you have time/network for a one-time
      download before play.
- [ ] Free disk space is sufficient for WAV audio, the model cache, and outputs.
- [ ] Port 17300 is free (or the configured port).

### 3. Capture test (mandatory)

- [ ] Create a temporary capture-test session in the dashboard.
- [ ] Select the exact voice channel to be used for play.
- [ ] Join with the bot, start the test, and have each participant speak for
      roughly 10–15 seconds (including overlapping speech once).
- [ ] Confirm the dashboard shows, per user: speaking activity, at least one
      completed utterance, bytes/timing, and no decryption/receive errors.
- [ ] Stop the test. Confirm each WAV opens and contains audible speech, and the
      manifest timestamps are plausible.
- [ ] If audio is missing, silent, truncated, or `DecryptionFailed` appears:
      **do not start the real session**. Follow the troubleshooting matrix.
      There is no OBS backup to fall back to.

### 4. Foundry capture test

- [ ] Open the intended Foundry world as GM. Confirm the system is FFG narrative dice
      (first supported system) or SFRPG (next).
- [ ] **Macro path:** install/copy the dashboard-provided macro into a script
      macro.
- [ ] **Live module path:** in **Setup → Foundry**, enable the live bridge, copy the
      token, install the module into the detected Foundry data path, and paste
      the URL/token into the module settings. Confirm the dashboard pill shows
      `Foundry live`.
- [ ] On the first GM load in a fresh world, complete the module's setup wizard:
      dashboard address, bridge token, connection test, then **Finish setup**. A
      world that already has a token skips the wizard. Reopen it from Module Settings
      if the address or token changes.
- [ ] On Record, confirm the **Prompt players in Foundry when recording starts** tick appears while
      the bridge is live. The dashboard sends the consent notice through the module; the manual
      `game.tableRecords.promptConsent()` command is only a fallback.
- [ ] Create one test roll (FFG: a roll that produces `ffg` symbols).
- [ ] Macro path: run the macro once; a JSON file downloads. Import it and
      confirm the right system/world, recent time range, at least one
      message/roll, and non-zero FFG values.
- [ ] Live path: confirm the dashboard session shows a live event and the scene
      name. Press Alt+M in Foundry and confirm the mental note appears.
- [ ] If **Break Time** is installed and active, start a short break and end it. Confirm the
      session timeline shows **Break time called** and **Break time over after …**. The bridge
      setting **Follow Break Time breaks** must stay on. If the module is not installed, this
      check does not apply.
- [ ] Remove or ignore the test roll when reviewing session outputs. The import
      is filtered to the session time window by default.

If the macro/module fails, fix it before play. The macro remains the fallback if
the live bridge cannot reach loopback.

### 5. Consent

- [ ] Read/show the canonical notice in `PRIVACY.md` before recording.
- [ ] Explicitly state that audio is recorded **per Discord account**, not as a
      mixed call, and transcribed locally.
- [ ] Explicitly state that Foundry chat/roll export includes private and blind
      rolls visible to the GM.
- [ ] State that the optional AI summaries are for summaries only and are **not
      used as training data**. Local providers stay on this machine; DeepSeek
      cloud is off unless you deliberately enable it.
- [ ] Agree on retention and who has access.
- [ ] Use the Foundry player prompt (`game.tableRecords.promptConsent()`) or the
      dashboard GM fallback tick. Consent is assumed unless a player opts out.
- [ ] If anyone opts out, mark them in **Sessions → People → Record**. Do not
      record or process them; transcripts/recaps will say they did not want to
      be recorded. If they decline before recording starts, do not subscribe.

### 6. Create the session

- [ ] Choose title/date, system, Foundry world, voice channel, and participants.
- [ ] Confirm the character mapping (Discord person → character) used for speech.
- [ ] Confirm the capture-test artifacts are not mixed into the real session.
- [ ] Verify the session directory was created and is writable.

## During-session workflow

1. Open the dashboard and confirm bot/voice status is healthy.
2. Select the guild and voice channel.
3. Click **Join** (or **Join & Start**). Wait until voice status is Ready.
4. Start recording only after the voice channel is populated and the status is
   healthy.
5. Confirm the live speaker panel shows activity when people speak. If a
   participant never appears, stop and investigate; do not assume the audio
   exists later.
6. Use **Markers** for scene changes, breaks, combat start/end, or other useful
   anchors. Use **★ mental note** (or say “mental note: …”, “note to self: …”) for
   reminders that should survive the session.
7. When you need outside help, open **GM assist — recent context**, choose the
   last 3 minutes, click **Transcribe & build**, then copy or download the brief.
   It contains the tail transcript, rolls, mental notes, markers, and roll↔voice
   context. If summaries are enabled, choose a scope and preset, then press
   **Summarize**; review the result before use.
8. Do not close the dashboard server process while recording. Closing the
   browser tab is fine; stopping the Node process stops the bot and capture.
9. Do not move the bot between voice channels mid-session. If it disconnects or
   is moved, stop capture, note the gap, rejoin, and start a new capture segment
   or session. There is no OBS safety net.
10. At the end, wait for the final roll/chat to land in Foundry, then **stop
    recording**. Wait for the dashboard to report `captured`/finalized before
    closing anything.

## Post-session workflow

### 1. Capture Foundry data

**Macro path:**

- Run the TableRecords macro in Foundry as GM **after the last roll/chat of the
  session**.
- Save the downloaded JSON outside the browser's temporary area.
- Open the session in the dashboard, use **Foundry → Import**, and upload the
  JSON.
- Review the import summary: system, world, message count, roll count, time
  range, and warnings. Fix an obviously wrong system/time window before
  processing.

**Live path:** confirm the bridge shows a recent heartbeat and the live event
count matches the rolls you expect. A macro import afterwards is safe; merge
deduplicates by message ID.

### 2. Process

Run **Build notes** from the session page, or from **Record** once the recording is saved. It runs
these steps in order (the individual steps remain as **Speech only / Rolls only / Files only** in the
Activity tab):

1. **Transcribe** — the selected local engine (Parrot/Parakeet by default, or Whisper)
   reads the recorded clips and writes `stt/transcript.jsonl` plus errors.
2. **Merge** — Node combines accepted speech, Foundry events (macro and live),
   and markers in epoch-ms order, detects spoken mental notes, and attaches
   roll↔voice context.
3. **Render** — Node produces human-readable Markdown, CSV, roll-sync and
   mental-note files, stats, and the future `notes-ready.md` handoff.

After transcription succeeds, the review audio (master plus per-speaker timelines) is assembled in
the background. Clips are streamed in batches of 500 (`REVIEW_AUDIO_BATCH_CLIPS`); multi-thousand
clip sessions are stitched without the old 500-clip limit. Speaker tracks are dynamically normalized
(peak target -1 dB, up to +40 dB gain) before mixing (`REVIEW_AUDIO_NORMALIZE=0` disables it).
Waveform PNGs are generated
by ffmpeg on first view and cached in `review/waveforms/`; the browser never decodes the full MP3.
Rebuilding a large mix from the session asks for confirmation and can take several minutes.

Partial processing is valid:

- Rolls can be reviewed/rendered even if STT failed.
- Speech can be transcribed even if the Foundry export is late.

Never claim a complete session record when a job failed. The dashboard must show
failed/cancelled jobs and rejected utterances; review them before treating
outputs as final.

### 3. Review outputs

Expected files under the session directory:

```text
sessions/<session-id>/
  session.json                  # metadata, state, consent, people mapping
  consent.md                    # consent record/script snapshot
  discord/
    manifest.jsonl              # one line per captured utterance
    audio/<discord-user-id>/
      <start-ms>-<utterance-id>.wav
  foundry/
    export.json                 # exact uploaded macro export
    events.jsonl                # normalized macro import events
    live-events.jsonl           # optional live-module events (deduped by id)
    live-state.json             # last live scene/combat heartbeat
    import-summary.json         # import counts/warnings/time-range summary
  stt/
    jobs.jsonl                  # job contract sent to Python
    prompt.txt                  # session initial prompt
    hotwords.txt                # session hotword list
    transcript.jsonl            # per-utterance speech records
    transcript-errors.jsonl     # per-utterance failures
    recent-*.jsonl             # optional tail transcription scratch/output
  merged/
    timeline.jsonl              # canonical chronological events
  outputs/
    transcript.md
    chronology.md
    rolls.csv
    roll-sync.md                # speech around each roll + confidence
    mental-notes.md             # spoken and manual notes
    stats.md
    notes-ready.md              # future LLM-phase input; no generated prose
  jobs/<job-id>.log             # process logs for each job
```

Review:

- `chronology.md` for the chronological session, mental-note labels, and
  system-specific dice.
- `roll-sync.md` for the speech around each roll (high/medium/low confidence).
- `mental-notes.md` for every spoken/manual note.
- `transcript.md` for per-utterance speech and timestamps.
- `rolls.csv` for one row per roll, including voice-context columns.
- `stats.md` for talk time, utterance/word counts, rolls with nearby speech,
  mental-note count, and system symbol totals.
- `review/master.mp3` and per-speaker timelines, built automatically after
  transcription. These are timestamp-aligned listening mixes; the per-utterance WAVs
  remain the STT source.
- Rejected utterances and import warnings in the dashboard before using the
  outputs as canon.

### 4. Retention

Follow `PRIVACY.md`. At minimum, record what was retained, for how long, and who
can access it. Deleting raw audio does not delete transcripts, Foundry exports,
or backups elsewhere; handle each data class explicitly.

The Sessions detail has **Archive/Restore** for hiding a session without deleting
it. **Delete** permanently removes the session folder and DB row, but refuses
active recordings and queued/running jobs, and requires typing the exact session
ID. It is not a secure erase; check backups and sync clients separately.

The Files tab has **Clip storage**:
- **Compact clips** rewrites each per-clip WAV to 16 kHz mono (about 6x smaller).
  Playback, transcription, and review rebuilds still work.
- **Delete clips** removes the per-clip WAVs after the master and speaker tracks
  are on disk. Transcripts, Foundry events, markers, and outputs are untouched.
  Rebuilding notes reuses the existing transcript; if the transcript is also
  missing, it cuts 2-minute windows from the saved speaker tracks.
- Both actions require the review mix; if it is missing or older than the clip
  manifest, it is built first (which can take minutes on a long session).

## Troubleshooting matrix

| Symptom | Likely cause | Action |
| --- | --- | --- |
| Bot never appears logged in; Setup shows auth error | Missing/invalid `DISCORD_TOKEN`, wrong bot, token revoked | Put a dedicated token in `.env`, restart the server, check the Setup page. Do not screenshot/paste the token. |
| Bot cannot join channel | Missing View Channel/Connect/Speak, wrong channel type, bot not in guild | Fix channel permissions and invite; use a normal voice channel; re-run health check. |
| Bot joins but zero utterances / silence | Discord receive/DAVE regression, wrong client version, `selfDeaf` inadvertently on, Opus library issue | Run capture test. Check dependency report/version pins. Do not start the session. Update the pinned voice client in a controlled test; no OBS fallback exists. |
| `DecryptionFailed(...)` or repeated decrypt errors | DAVE/MLS transition problem or unsupported receive path | Stop. Record the exact error and dependency report. Retry in a test channel; if it persists, treat capture as unavailable. |
| One participant missing while others record | That user not speaking, not in channel, or a per-user subscribe failure | Ask them to speak; check live panel; restart capture if needed. Do not assume silence means no audio. |
| Audio files exist but are silent/truncated | Decoder/WAV finalization or receive gap | Open several WAVs, compare manifest duration/bytes, rerun capture test. Note the loss; no mixed backup. |
| Voice disconnects/moves mid-session | Network change, channel move, Discord/server event | Stop capture, note gap, rejoin, and start a new capture segment/session; don't pretend it was continuous. |
| `python` / venv missing | Setup not run or wrong Python path | Run setup in `STT.md`; set `PYTHON_PATH`; verify `stt_health`. Or switch to Parrot in Setup → Transcription. |
| Parrot (Parakeet) unavailable | nemo-speech or GGUF missing, wrong path/device | Run **Run checks**; fix the runtime/model in Setup → Transcription, or switch to Whisper for this session. |
| CUDA not available / DLL load failure | Missing cuDNN 9, wrong DLL path, driver issue | Install `nvidia-cudnn-cu12==9.*`, add cuDNN/CUDA bin dirs via `os.add_dll_directory` and `PATH` before native imports; rerun health. Otherwise retry CPU mode explicitly. |
| Model missing / offline failure | Not downloaded, wrong cache path, offline flags | First run with network to populate `models/faster-whisper`; verify cache; then set offline flags. |
| Transcription very slow | CPU fallback or oversized model | Switch to `small.en`/`medium.en` CPU or fix GPU; check job mode in transcript metadata. |
| Whisper invents phrases / bad names | Noise, short clips, missing vocabulary hints | Review quality flags; add names to prompt/hotwords; apply logged substitution; don't silently rewrite raw text. |
| Foundry import rejected/malformed | Wrong file, old macro, system/roll shape change, truncated download | Re-run the current macro in Foundry; verify JSON parses; inspect summary warnings; upload the exact file. |
| Foundry import has no rolls | Macro run before rolls, wrong world/time filter, empty chat | Check export time range and session times; re-export after the final roll. |
| Live bridge says waiting | Bridge disabled, wrong token/URL, Foundry page cannot reach loopback, CSP blocked fetch | Enable in Setup, copy the current token into module settings, open the dashboard URL in the Foundry browser, check the browser console; use the macro fallback if the client is remote. |
| Live bridge connected but no events | Session is draft/not recording, module `pushRolls`/`pushChat` disabled, roll made before enable | Start recording, check module settings, make a test roll; inspect `foundry/live-events.jsonl`. |
| Automatic scene/combat markers missing | Session not recording, auto-markers disabled, or state unchanged | Enable auto-markers and wait for the next transition; the first heartbeat during a recording now records the starting scene/combat once. |
| Recent-context transcribe fails | Python missing/CUDA error, or another transcription is active | Run the normal transcribe job first, check `stt_health`, retry after the active job; see the toast/job log. |
| Recent-context shows no speech | No captured utterance in the window yet, or all records filtered as noise | Wait for speech, choose a larger window, or run a full transcribe and inspect rejected flags. |
| AI summaries button missing | Feature off in Setup | Enable summaries, choose a provider and model, then save; off is the default. |
| Summaries say not configured | Missing address/model, DeepSeek key absent, or cloud switch off | Run **Check models** and **Test connection** in Setup; for DeepSeek, set the key and turn on both switches. |
| Summary timeout/unreachable | Model server not running, wrong port/model, or prompt too large | Start Ollama/LM Studio, check the address and model, lower the input limit or raise the timeout. |
| Whole-session summary is incomplete | Brief exceeded the configured input limit and hit the portion cap | Raise the input limit, lower it so more portions fit, or use the current-scene scope. |
| Disk full | Long WAVs/model cache/old sessions | Free space; archive/delete per retention; do not start a capture that cannot be written. |
| Port 17300 in use | Another dashboard/server instance | Stop the other process or set `PORT`; verify only one recorder owns the bot token. |
| Job crashes/cancelled | Python process error, OOM, manual cancel, server restart | Read `jobs/<id>.log`; retry the job. Interrupted jobs are marked failed on restart, not auto-resumed. |
| Dashboard crash during recording | Node process died | Restart. The bot connection drops; session should be marked interrupted. Inspect manifest/WAVs, finalize what exists, and note the gap. There is no OBS recording to recover. |
| Outputs unexpectedly empty | Missing transcript/import, rejected records, time filter | Check job states, rejected list, `foundry/events.jsonl`, and session start/stop times. Partial outputs are expected when one source is absent. |
| Outputs look old after adding audio/mapping/events | Render older than a source file | The session shows **outputs stale**; click **Rebuild outputs** (or run merge then render) and confirm the timestamp changes. |
| Interrupted recording after restart | App recovers WAVs, then auto-runs `run_all` | Check the Jobs tab; if STT fails, fix Python/CUDA and retry. The stale banner remains until a successful render. |

## Recovery after a dashboard/server crash

1. Do not immediately start a new recording in the same session.
2. Restart the dashboard/server and open the session.
3. Treat any session still marked `recording` as **interrupted**; the bot
   connection is gone and no further audio was captured.
4. Inspect `discord/manifest.jsonl` and each WAV in `discord/audio/`; keep
   complete files and note truncated/failed ones. Do not fabricate missing
   utterances.
5. If the app offers a finalize/reconcile action, run it to close open records
   and mark the session `captured`/interrupted. If not, process from the
   manifest and document the gap.
6. Import Foundry data and run processing; outputs should carry the interruption
   warning.
7. Start any continuation as a new capture segment/session with its own start
   time.

## Explicit exclusions

- **No OBS.** No OBS steps, controls, or mixed-track recording.
- **No mixed-audio fallback.** No diarization; the per-user Discord tracks are
  the only speech source.
- **No socket/cloud Foundry relay.** The live bridge is loopback-only and
  token-gated. The pasteable GM macro is the lighter option.
- **No automatic AI call.** The recent-context brief is a deterministic extract.
  The optional summarizer runs only when the GM presses **Summarize**. Local
  providers stay on loopback; DeepSeek cloud stays off unless both switches and a
  key are configured.



