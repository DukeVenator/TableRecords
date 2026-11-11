# Features

I built TableRecords for my home table. These are the parts I use, in the order a session touches them.

## Capture

- One WAV for each speaking burst, per Discord user, with an absolute timestamp.
- Pauses shorter than 2.4 seconds stay inside the utterance. Silent bursts are kept for review and skipped by STT.
- A 60-second capture test before the real session.
- Live speaker list, bytes, utterances, decrypt errors, and last-packet age while recording.
- Break Time starts and ends become break markers when the Foundry module is connected.
- The dashboard stays on `127.0.0.1`; there is no LAN mode and no hosted relay.

## Transcription

- Parrot (Parakeet) by default, or faster-whisper and Whisper.
- CUDA or CPU.
- Word timestamps, absolute offsets, per-user transcripts, and a JSONL job log.
- Language, model, device, compute type, beam size, VAD, no-speech threshold, log-probability threshold, compression ratio, prompt, and hotwords are settings.
- Transcripts stay local.
- A quick **Transcribe & brief** action processes the last 1, 3, 5, 10, or 15 minutes without an AI provider.

## Foundry bridge

We recommend the bridge. It sends chat, rolls, scene and combat state, mental notes, and Break Time while you play.

- The module has a first-run wizard for a fresh world: dashboard address, token, connection test, and consent/directory/Break Time switches.
- GM-only player posts. The dashboard drafts a recap, important names, or clues from public speech, chat, and rolls. You edit the draft in a private preview, then choose **Post to players**. Whispers, blind rolls, mental notes, and earlier generated posts are excluded.
- FFG narrative dice, SFRPG, and a generic formula/total fallback.
- Live events and the macro fallback deduplicate by message ID.
- If you want a lighter setup, use the macro export instead.

## Sessions

- Record, Sessions, People, and Setup screens.
- Session folders with `session.json`, `people.json`, transcript, Foundry events, markers, timeline, outputs, and audio.
- Seven outputs: `transcript.md`, `chronology.md`, `rolls.csv`, `roll-sync.md`, `mental-notes.md`, `stats.md`, `notes-ready.md`.
- Stats for length, speech coverage, talk time, words, turns, rolls, per-player share, longest turn, words per minute, and first/last heard.
- Search, status filters, game grouping, archive, and guarded delete.
- Output freshness checks, so an old build is labelled instead of passed off as current.
- Crash recovery and a persisted job queue with retry and cancellation.

## Review audio

- A timestamp-aligned master mix and one track per speaker.
- Waveform previews and byte-range audio streaming.
- Compact clips to 16 kHz mono, about six times smaller, or delete clips after the mix is saved.
- The master and speaker tracks stay available for review.

## People and consent

- A cross-session People directory with game, character, role, consent, and appearance history.
- A reusable world roster feeds Discord name, Foundry user, character, and role dropdowns.
- The consent notice is a recorded artefact. Opted-out players are never recorded, transcribed, merged, rendered, or summarized.
- The notice is echoed into session outputs and included in privacy notes.

## AI summaries, optional

This part is off by default and never writes into the canonical outputs.

- Providers: managed llama.cpp, Ollama, another local OpenAI-compatible server, or DeepSeek cloud. DeepSeek needs both the cloud switch and an API key.
- Scopes: recent, current scene, whole session.
- Presets: session recap, GM prep, clue board, rules log.
- Model discovery and a connection test that does not send session text.
- Saved history under `llm/summaries.jsonl`.
- A floating progress panel: preparing, portion N of M, reduction rounds, final, done.
- Long sessions split into density-aware portions. The final prompt also gets the GM notes, a deterministic ledger of rolls, markers, mental notes, and people, and a per-portion index of names, places, items, clues, decisions, and questions.
- GM prep writes each heading separately, then checks the draft against the ledger, notes headings, and extracted facts. Up to three repair passes, then facts are placed under the relevant heading.
- The tested deep path is Qwen3.5 35B-A3B on llama.cpp at 64k context. On my machine a 3-hour-51-minute session took 474 seconds, used 3 portions, produced 12,882 characters, and ended with 185 facts checked and none missing.
- The 27B Ollama path is faster on some recaps but less stable on a full session. The deep summary button in Setup sets 35B, 64k, 100k input, and thinking off.

## Platform

- Windows only.
- Node 24 or newer.
- Python 3.12 for the faster-whisper sidecar.
- Local SQLite via `node:sqlite`, plus plain JSONL and Markdown files.
- No OBS, no mixed-audio safety recording, no diarization, no cloud fallback.

## Status

The local suite has 141 tests across 44 files. Playwright adds 11 browser checks and one opt-in live Ollama check. GitHub Actions runs a 121-test non-LLM selection, typecheck, web build, and docs check.

Planned work is in [ROADMAP.md](ROADMAP.md).
