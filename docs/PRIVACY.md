# Privacy, consent, and data handling

This is operational guidance, not legal advice. Recording and sharing
conversations can create legal obligations that differ by location. If you plan
to publish, stream, or distribute recordings or transcripts, get local legal
advice before doing so.

## Consent notice (read/show before recording)

The canonical text lives in `src/core/consent.ts` (`CONSENT_NOTICE_TEXT`). The Foundry module and the
dashboard use it verbatim:

> TableRecords records each Discord speaker separately for local tabletop note-taking. Audio is
> transcribed on the GM's machine. It is not shared off your local network and is not sent to any
> provider, cloud transcription service, or other third party. The optional local LLM is used only to
> summarize session notes. Recordings and transcripts are not used as training data. Consent is
> assumed unless you opt out. If you opt out, your voice is not recorded or processed, and the
> transcript notes that you did not want to be recorded.

The intended flow:

1. **With the Foundry module:** players receive the automatic prompt on load, and the GM can tick
   **Prompt players in Foundry when recording starts** on Record. The dashboard records the prompt,
   queues a bridge command, and starts recording; players who opt out are dropped. No console command
   is required. The prompt itself (or any player response) unlocks start without a separate GM tick.
2. **Without the module:** the GM ticks the dashboard fallback box:
   "I have shown players this notice… consent is assumed unless a player opts out."
3. **Any time:** the GM can mark a player opted out in **Sessions → People → Record**. Opted-out
   players are never subscribed to, transcribed, merged, rendered, or summarized. `transcript.md`,
   `chronology.md`, `stats.md`, `notes-ready.md`, and the GM-context brief explicitly say
   "player did not want to be recorded."

Do not record first and ask later. If a player opts out mid-session, stop capturing them immediately
and re-run merge/render so their prior records are excluded. Previously captured WAVs are not
automatically deleted; decide with the player whether to remove them.

## What is captured and disclosed

Be explicit about all of these before play:

- **Per-user voice audio.** Each Discord account's speaking bursts are recorded
  separately. There is no mixed-call recording.
- **Local speech-to-text.** Audio is decoded and transcribed on the GM's
  machine with a local Whisper model. No cloud STT/LLM is used by default.
- **Optional AI summaries.** Off by default. Ollama and other local
  OpenAI-compatible servers stay on `127.0.0.1`, `localhost`, or `::1`. The
  optional DeepSeek provider is cloud-hosted and stays off unless the cloud
  switch is on and a key is configured. It sends the deterministic session brief,
  never audio. Summaries are saved in `llm/summaries.jsonl` for history and are
  not written into the canonical outputs.
- **Foundry chat and rolls.** The GM macro export or optional live module
  includes chat messages, dice rolls, speaker/actor metadata, flags, and
  **private/blind rolls** visible to the GM. It may include whispers and content
  players did not see in chat.
- **GM mental notes.** Notes you type or speak (“mental note: …”) are stored with
  the session and included in `mental-notes.md` and recent-context briefs.
- **Recent-context briefs.** The GM-assist button produces a local Markdown
  extract. Copying it into an external assistant sends that text to the service
  you choose; the app itself only calls the AI provider when you press
  **Summarize** and summaries are enabled.
- **Derived records.** Timestamps, transcripts, speaker/character mappings,
  merged timelines, CSV/Markdown output, roll↔voice context, stats, and a
  `notes-ready.md` handoff file are retained.
- **Metadata.** Discord user IDs/display names, Foundry user/actor/token IDs,
  timestamps, file paths, and job/server logs may be retained.
- **No OBS/mixed recording.** The per-user Discord tracks are the only audio
  source.

Explain who can access the session directory and whether any of it will be
shared, streamed, or published. If the answer is "not without separate consent,"
say that explicitly.

## Data inventory

| Data class | Examples | Sensitivity | Default location |
| --- | --- | --- | --- |
| Per-user audio | `discord/audio/<user-id>/*.wav` | High: voices, personal conversation, background sounds | Session directory |
| Discord manifest | `discord/manifest.jsonl` (IDs, names, times, bytes) | Medium–high: participation/behavior records | Session directory |
| Transcripts | `stt/transcript.jsonl`, words, confidence, quality flags | High: content of speech | Session directory |
| Foundry export | `foundry/export.json` (chat, rolls, whispers, flags, actor data) | Medium–high: private in-game info and player identities | Session directory |
| Live Foundry events | `foundry/live-events.jsonl`, `foundry/live-state.json` | Medium–high: same content streamed during play, plus scene/combat state | Session directory |
| Normalized events | `foundry/events.jsonl`, `merged/timeline.jsonl` | Medium–high: reconstructed session | Session directory |
| Outputs | `outputs/*.md`, `*.csv`, including mental notes and roll-sync context | Medium–high: may summarize private content | Session directory |
| Recent-context brief | clipboard/download only; not persisted by the app | High when copied: may contain the full tail transcript and private rolls | Clipboard/external destination chosen by GM |
| AI summary history | `llm/summaries.jsonl` (summary text, model, preset, scope, timing) | High when it contains private session details | Session directory |
| Consent/mapping | `session.json`, `consent.md`, people/character mapping | Medium: identifies participants and consent | Session directory |
| Consent preferences | `consent_prompt`, `consent_preferences` in `data/tablerecords.db` | Medium: Foundry user IDs/names and opt-out status | Local app database |
| Job/server logs | `jobs/*.log`, dashboard logs | Medium: may include file paths, IDs, errors, occasional content | Session directory/log directory |
| Model cache | local Whisper model files | Low: no session data | `models/faster-whisper` |
| App database | sessions, people, jobs, markers, settings | Medium: metadata and consent state | Local app data/DB |

No embeddings, voiceprints, or diarization profiles are produced in the MVP.

## Retention and deletion

Decide retention **before** recording and tell participants. Suggested defaults
(adjust to the group's preference, not a legal rule):

- Raw per-user audio: delete after the transcript has been reviewed, or within
  14–30 days.
- Transcripts, Foundry export, merged timeline, and outputs: keep for the
  campaign or a stated period (for example, one year).
- Job/server logs: 30 days.
- Consent record: retain while the recordings/outputs are retained, so consent
  can be demonstrated.

Deletion procedure:

1. Identify the session and stop any running jobs. The dashboard can archive a
   session without deleting it, or delete it after typing the exact session ID;
   delete refuses active recordings and live jobs.
2. If you only want to reclaim disk space, use **Files → Clip storage**. Compacting keeps smaller
   16 kHz mono clips; deleting removes the per-clip WAVs but keeps `review/master.mp3` and the
   per-speaker tracks, which still contain the recorded voices. Delete those review files too if no
   audio should remain.
3. Delete the audio files and the manifest entries that reference them, or the
   whole session directory if all derived data is also being removed.
4. Update retention/consent notes to record what was deleted and when.
5. Empty the Recycle Bin/trash and check backup/sync locations. A normal file
   delete may leave recoverable remnants on SSDs; for sensitive material, use
   full-disk encryption from the start and, where required, an appropriate
   secure-erase procedure.
6. Do not delete only the visible output files and assume the audio is gone;
   check model/job logs, temp files, backups, and any copies made for review.

If a participant withdraws consent: stop recording them immediately (the recorder will ignore their
Discord user after the opt-out is set), do not publish anything derived from them, and discuss whether
their individual audio and transcript records can be deleted. The merge/render pipeline excludes their
transcripts and adds a "player did not want to be recorded" note; a full re-transcribe removes their
transcript records. Per-user tracks make selective deletion possible for audio/transcripts, but derived
summaries or Foundry rolls may be harder to separate. Document what could and could not be removed.
Previously captured WAVs are not automatically deleted; decide with the player and use the retention
procedure above.

## Local-only processing

- Discord voice necessarily traverses Discord's hosted service. After the bot
  receives the audio, decoding, recording, transcription, merging, and rendering
  happen on the GM's computer.
- No audio or transcript is sent to a cloud transcription or LLM provider.
- The optional local LLM is off by default and only accepts loopback endpoints.
  Enabling it sends the recent-context brief to that local process. Do not configure
  a proxy that forwards the request to a cloud service.
- The one-time local model download from Hugging Face is a model artifact
  transfer, not session audio. After it is cached, run with
  `HF_HUB_OFFLINE=1` and `TRANSFORMERS_OFFLINE=1`.
- The dashboard binds to loopback only. Do not expose it to the LAN or internet,
  and do not port-forward it.
- The live Foundry bridge is also loopback-only and token-gated; the Foundry
  browser must be on the same machine as the dashboard.
- Copying a recent-context brief into an external assistant is a separate
  disclosure. Tell players if session content may be sent outside your machine.
  The local LLM toggle only permits a loopback endpoint.
- Exclude the sessions/models directories from OneDrive, Dropbox, Google Drive,
  or any other sync client. A "local" file in a synced folder is cloud data.
- Avoid remote-support sessions, screen sharing of raw audio, or pasting
  transcripts into external services unless everyone separately agrees.
- Check any antivirus/backup tooling that may upload files to a vendor cloud.

## Discord terms and bot rules

- Use a **registered Discord bot application** and a bot token. Do not use a
  self-bot or automate a normal user account; Discord prohibits that and it can
  result in account termination.
- Keep the bot token secret. Do not paste it into the dashboard UI, chat,
  screenshots, logs, or source control. Rotate it immediately if exposed.
- Invite the bot with least privilege: View Channel, Connect, Speak for the voice
  channel used; do not grant Administrator.
- Do not run a public recording bot with this configuration. Keep it restricted
  to the campaign guild/channel and trusted operators.
- Follow Discord's Terms of Service, Community Guidelines, and any server rules
  about recording, privacy, and bots. Server-owner permission does not replace
  participant consent.
- Do not publish or distribute recordings/transcripts without the separate
  agreement of the people involved.

## Queensland legal nuance (not legal advice)

Queensland's *Invasion of Privacy Act 1971* (Qld) generally prohibits using a
listening device to record a private conversation, with an exception where the
person using the device is a party to that conversation. The Act also contains
separate provisions concerning communicating or publishing recordings, or
statements prepared from them, which can apply even when the recording itself was
party-authorised. Penalties and exceptions can be fact-specific.

Practical consequences:

- Obtain informed consent from every participant before recording, even if you
  believe the party exception applies.
- Do not assume consent to record also means consent to publish, stream, or
  share; ask separately.
- Participants may be in other regions or overseas, with different
  rules. The safest baseline is explicit consent from everyone.
- If participants include minors, obtain guardian consent and take legal advice
  before recording or sharing.
- Get legal advice for publication, distribution, or any disputed use.

This section is a summary, not legal advice, and does not replace advice from a
qualified lawyer in the relevant jurisdiction.

## Storage and access control

- Keep the project on a drive protected by full-disk encryption (for example,
  BitLocker) and restrict Windows account/NTFS permissions to the operator.
- Use an encrypted backup if backups are needed; do not put session data in an
  unencrypted cloud-synced folder.
- Protect the `.env` file containing the bot token with filesystem permissions
  and never commit it.
- Bind the dashboard to `127.0.0.1`; if a dashboard access token is configured,
  keep it secret and do not share URLs.
- Lock the machine when unattended, especially while audio/transcripts are
  present.
- Store consent records with the session so access and retention decisions can
  be audited.
- On a shared machine, treat the session directory as readable by anyone who can
  access that Windows account; create a separate account or encrypted container
  if that is not acceptable.
