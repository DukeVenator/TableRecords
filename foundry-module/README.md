# TableRecords bridge (Foundry VTT module)

Optional live bridge from Foundry VTT to the local TableRecords dashboard. It removes the
"run the macro, download JSON, upload" loop while preserving the macro path as a fallback.

## What it does

- First-run setup wizard for a fresh world: connects the dashboard, tests the token, and explains the switches before play starts.
- Pushes new Foundry chat messages and prepared rolls from the GM client to the local dashboard.
- Sends scene, combat, and pause state so the dashboard can mark scene changes and combat starts/ends.
- Mirrors **Break Time** starts and ends as break markers when the `breaktime` module is active. It reads that module's own paused state, so the dashboard records a real break even though the game may be paused for other reasons.
- Publishes a roster of Foundry users and player-owned/character actors so the dashboard's People tab can offer a **Foundry lookup** and character suggestions. This is controlled by the world setting **Publish player/character directory** (default on).
- Adds a GM mental-note prompt (`Alt+M` by default, or via `game.tableRecords.openMentalNote()`).
- Adds GM-only player-post tools in the chat sidebar: a recap, important names, or clues from the last 3, 5, or 15 minutes. Each opens in a private, editable preview; nothing reaches player chat until the GM presses **Post to players**.
- Shows players a recording-consent notice with an opt-out; consent is assumed unless they opt out.
- Polls the dashboard for small GM commands (currently “prompt players for consent”), so starting a recording can
  send the notice without a console command.
  Opt-out responses travel as a GM whisper and are forwarded to the local dashboard.
- Keeps a bounded offline queue and retries transient/network failures with a short backoff. Permanent target errors (unknown/mismatched session) are surfaced and dropped instead of looping forever.
- Does **not** use a cloud service, socket relay, or another project's Discord bot.

## Target session

Leave **Session ID** blank to follow whichever TableRecords session is currently recording. Paste a session ID if you need to attach late events or a mental note to a specific finalized session. The dashboard API accepts an explicit `sessionId`; when one is supplied it validates the session, world, and system before writing.

## Install (local)

1. Start the dashboard (`npm run dashboard`) and open **Setup → Foundry**.
2. Enable the bridge there and copy the bridge token.
3. Copy this `foundry-module` folder into your Foundry data directory:
   `<FoundryVTT data>/Data/modules/table-records-bridge/` (the folder must contain `module.json`).
4. In Foundry: **Manage Modules → TableRecords Bridge**, enable it, then **Configure Settings → TableRecords Bridge**.
5. Set the dashboard URL (default `http://127.0.0.1:17300`), paste the bridge token, and optionally set a session ID.
6. Join the world as GM. The dashboard shows `connected` after the first heartbeat.

If Foundry runs on the same machine, the default loopback URL is correct. The browser must be
able to reach `127.0.0.1`; a Foundry client on another machine cannot reach your local dashboard
and should keep using the macro export instead.

Reload the world after updating the bridge. Foundry keeps the old module script in memory until the
page is refreshed, so the dashboard continues to report the old module version until then.



## First-time setup

A fresh world gets a setup wizard the first time the GM opens it:

1. **Welcome** explains what the bridge sends and that the dashboard must be running.
2. **Connection** asks for the dashboard address and bridge token. It opens with `http://127.0.0.1:17300`
   already filled in. Find the token in TableRecords under **Setup → Foundry live bridge**.
3. **Test** saves the settings and sends a heartbeat. A success message means the dashboard accepted the
   token; a failure names the likely cause and offers **Test again** and **Back**.

The wizard asks once per world. Choosing **Not now** records that the prompt was seen; it does not keep
opening on every load. Reopen it from **Configure Settings → TableRecords Bridge → Open setup wizard**,
or run `game.tableRecords.openSetup()` from a macro. A world that already has a token is treated as set
up and does not see the prompt.

The wizard also sets the consent, directory, and live-bridge switches, plus the Break Time switch when that module is active, so the fresh world is ready before the first session.

For development, the module folder can be a directory junction to this project's
`foundry-module/` instead of a copied install. The dashboard's module installer
detects a junction and leaves it in place, so edits show up after a Foundry refresh.

## Mental notes

- Press **Alt+M** (configurable in Foundry's keybinding settings) and type a note.
- Or use a script macro: `game.tableRecords.openMentalNote()` or `game.tableRecords.sendMentalNote("text")`.
- The note becomes a `mentalNote` marker at the current timestamp and appears in `mental-notes.md`.

## GM player posts

The GM client gets a compact book icon above the chat controls. Hover it for **TableRecords GM tools**. If the dashboard URL or bridge token is missing, clicking it opens the setup wizard instead. Once configured, compact play, pause, and stop buttons control the current TableRecords session. The pause button changes to resume while capture is paused, and starting from Foundry sends the player consent prompt.

The panel also has draft controls. Choose a window and one of:

- **Recap**: a short account of what the players just experienced.
- **Important names**: people, places, and groups named in the public record.
- **Clues mentioned**: clues and open questions, with uncertain claims marked.

The dashboard generates a draft from the current session for the connected world. The draft buttons use icons with hover labels: a scroll for **Recap**, people for **Important names**, and a magnifying glass for **Clues mentioned**. A private preview opens in Foundry with the text in an editable box. **Post to players** creates a public chat message with the edited text and an AI-assisted label; **Discard** leaves chat untouched. **Regenerate** replaces the draft after a warning if you have edited it.

The draft uses only public speech, public chat, and public rolls from the selected window. Whispers, blind rolls, mental notes, and earlier generated posts are excluded. Spoken audio can still contain spoilers, so review every draft before posting. The dashboard and a local model must be running; nothing is posted by the server.

The same helpers are available to GM macros as `game.tableRecords.generatePlayerDraft(kind, seconds)` and `game.tableRecords.publishPlayerPost(draft, text)`. `game.tableRecords.openGmTools()` opens the panel.

## Break Time integration

When the **Break Time** module (`breaktime`, by IronMonk) is installed and active, the bridge follows its
break state automatically:

- Starting a break with Break Time writes **Break time called** at the break's real start time.
  It works from the players-list button, the default **Shift+Home** shortcut, or `game.BreakTime.startBreak()`.
- Ending the break writes **Break time over after 12 minutes**. Closing the Break Time window ends the break
  for the GM; `game.BreakTime.endBreak()` does the same from a macro.
- The marker records the GM client's user as its actor. The marker is an ordinary `break` marker, so it
  appears in session moments, the waveform, and the generated notes alongside scene and combat markers.
- The bridge does not depend on Break Time. If the module is missing or inactive, the bridge ignores this
  path and nothing changes. Turn off **Follow Break Time breaks** in the bridge's module settings if you use
  a different break timer.
- The bridge reads Break Time's `paused` and `start` world settings. It does not use the game pause flag, so
  an ordinary game pause is not recorded as a break.
- If the GM reloads Foundry during a break, the bridge notices the still-active break and sends the start
  marker at the original break start time. A reload during the same break does not create a second start
  marker.

The automatic bridge event is separate from a manual **Break** marker on the dashboard. You can still add a
manual marker when you want to annotate a break with your own label.

## Privacy and consent

The module has a player-facing recording-consent notice in **0.3.1+**. On load, each player sees the local
recording/LLM disclosure and can choose **Continue — record me** or **Opt out of recording**. The GM can also
tick **Prompt players in Foundry when recording starts** on the dashboard Record screen; the dashboard queues
the prompt through the bridge, so no console command is needed. Consent is assumed unless the player opts out.
An opt-out is sent to the GM through a whispered chat message, and the GM client forwards it to the local
dashboard. Opted-out players are not subscribed to, transcribed, merged, rendered, or summarized; the session
transcript/recap notes that they did not want to be recorded.

The GM client sends only messages your GM client can see. Whisper/blind metadata is preserved, so the
dashboard can flag visibility just like the macro export. The same notice and disclosure are in
`docs/PRIVACY.md` and the dashboard's session consent panel.

## Consent commands

- GM: tick **Prompt players in Foundry when recording starts** on Record. The dashboard records the prompt and
  queues a bridge command; the GM client picks it up within a few seconds. `game.tableRecords.promptConsent()`
  remains available for a manual re-prompt.
- Player: the module prompts automatically on load; `game.tableRecords.openConsentDialog()` re-opens it.
- If no player responds, consent is assumed. The GM can still use the dashboard fallback tick.
- Keep the GM Foundry client open during play so player responses can be forwarded.

## Compatibility and limits

- Foundry VTT 12–14 are targeted; the code uses defensive feature checks because module APIs move.
- The GM client owns the live bridge; player clients only show the consent dialog and send a whispered
  response to the GM. Player clients never receive the bridge token.
- If the dashboard is offline, the bridge keeps at most 300 messages and retries with a short backoff. There is no disk queue, so a full browser close can still lose pending messages.
- `pushChat` and `pushRolls` are independent. Turning off ordinary chat still allows rolls; turning off rolls drops roll messages rather than sending them as plain chat.
- The module-level **Enable live bridge** switch also disables Alt+M notes. The dashboard's own bridge toggle is a second gate.
- The live path writes to `foundry/live-events.jsonl`, which merge combines with a later macro import by message id, so running both does not duplicate rolls.
- If your Foundry page's Content Security Policy blocks loopback `fetch`, use the macro fallback.
