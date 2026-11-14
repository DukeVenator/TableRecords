# TableRecords Foundry capture

## Approach

We recommend the bridge. If you want a lighter setup, use the macro export instead.

1. **Live bridge** (recommended): a small Foundry module on the GM client. It POSTs new chat, rolls, scene/combat state, and mental notes to the loopback dashboard while play is happening. When the **Break Time** module is active, it also mirrors break starts and ends.
2. **Macro export** (lighter option): a pasteable GM script macro runs after the session and the JSON is imported into the local dashboard. Use it when the bridge cannot reach loopback, or when you want one export after the session.

Both paths produce the same `tablerecords.foundry-event/v1` envelope and deduplicate by Foundry message ID, so a macro export can still be imported after a live session.

Why keep the macro:

- A macro uses documented Foundry APIs, works for every system, and is a single deliberate GM action.
- Exporting **prepared `message.rolls`** preserves system-specific roll classes. Foundry stores `_source.rolls` as JSON **strings**; a naive `message.toJSON()` alone can lose the structured shape needed by adapters.
- A live module adds browser/CORS and module-version failure modes. The bridge is loopback-only and token-gated; the macro remains the recovery path.

## GM workflow (bridge, recommended)

1. Start the dashboard and open **Setup → Foundry**.
2. Enable the bridge and copy the generated token. (It can be rotated; `FOUNDRY_BRIDGE_TOKEN` in `.env` fixes it.)
3. Click **Install module into Foundry** if the Foundry data path is configured; otherwise copy [`foundry-module/`](../foundry-module/README.md) to `Data/modules/table-records-bridge/`.
4. In Foundry, enable **TableRecords Bridge**.
5. Join as GM. In a fresh world, the setup wizard opens and asks for the dashboard address and token, then tests the connection. It also sets the consent, directory, live-bridge, and Break Time switches. For an existing token, the wizard is skipped.
6. The dashboard pill changes to `Foundry: live`; scene and combat changes can create automatic markers while recording.
7. On Record, tick **Prompt players in Foundry when recording starts**. The dashboard queues the consent prompt through the bridge; players see the notice within a few seconds. This replaces the old `game.tableRecords.promptConsent()` step.
8. Press **Alt+M** (or run a macro using `game.tableRecords.openMentalNote()`) to save a GM mental note. A ready-made one-line macro is in [`foundry-macros/table-records-mental-note.js`](../foundry-macros/table-records-mental-note.js).
9. Use the compact book icon above chat, labelled **TableRecords GM tools**. If the bridge is not configured yet, the icon opens the setup wizard. Once it is configured, the panel has play, pause, and stop controls for the current session; start also sends the player consent prompt. The pause button becomes resume while capture is paused. Use the draft controls to create a **recap**, **important names**, or **clues mentioned** from the last 3, 5, or 15 minutes. The draft buttons are icons with hover labels. Review and edit the private preview, then choose **Post to players**. The module never posts the draft without that action.
10. If the [Break Time](https://foundryvtt.com/packages/breaktime) module is active, start and end breaks with it as usual. The bridge writes **Break time called** and **Break time over after …** markers; no macro or chat command is needed.

Reopen the wizard from **Configure Settings → TableRecords Bridge → Open setup wizard**, or run `game.tableRecords.openSetup()`. The prompt is recorded once per world, so **Not now** does not make it reappear on every load.

Reload the world after updating the bridge. Foundry keeps the previous module script in memory until the page is refreshed, and the dashboard keeps reporting that old version until then.

The live endpoint is `POST /api/foundry/live`, authenticated by `x-tablerecords-token`. CORS is limited to the live, command-polling, and player-draft routes. Dashboard cookies are not accepted there. The bridge is rejected while disabled and accepts at most 500 messages and 50 events per request.

Player drafts use `POST /api/foundry/player-drafts` with `{world, sessionId?, kind, windowSeconds?, endMs?, transcribe?}`. The server resolves the world's active or most recent session, reads only public speech/chat/rolls, and returns `tablerecords.player-draft/v1`. It never writes to Foundry chat; the GM client creates the public message after review. One draft generates at a time, and a missing model or active processing job returns a named error.

**GPU note:** with Foundry open, the 27B model can fail to load because the client and model share the same card. On Windows, Ollama 0.40.13 can also fail while allocating the non-offloaded host buffer even when some RAM is free. The live test used the 0.8B model to finish the UI flow. Use a 9B model for live play with Foundry open, or close GPU-heavy clients before using the 27B. See [qa/AB-35B.md](qa/AB-35B.md).

### Break Time detection

The bridge watches the Break Time module's world setting `breaktime.paused` and its `breaktime.start` timestamp. It does not treat an ordinary game pause as a break. A start writes a `break` marker labelled **Break time called by …** at the recorded start time; the end writes **Break time over after 12 minutes**. A reload during an active break sends the start once at the original start time, and the server ignores a duplicate start while that break is still open. The bridge setting **Follow Break Time breaks** turns this off. No dependency is added: if Break Time is absent or inactive, the bridge ignores the setting.

## GM workflow (macro fallback)

1. Create a Foundry **script macro** named e.g. `TableRecords Export`.
2. Paste the contents of [`foundry-macros/table-records-export.js`](../foundry-macros/table-records-export.js) and save.
3. Run it after the session, on the GM client, with the relevant world open.
4. The macro downloads `tablerecords-foundry-<world>-<timestamp>.json`.
5. In the TableRecords dashboard, open the session, choose **Foundry → Import export**, and upload the JSON.
6. The dashboard validates, filters to the session window, and normalizes events. Review counts/warnings before running merge/render.

The macro exports all messages by default. Set `const SINCE = <epoch-ms>` at the top of the copied macro if you want a narrower export. The dashboard also filters by session start/stop times.

## Export payload (v1)

The canonical schema is defined in [DATA-FORMATS.md](DATA-FORMATS.md). Summary:

```json
{
  "schema": "tablerecords.foundry-export/v1",
  "exportedAtMs": 1793444900000,
  "exportedBy": {"id": "UUSIcnoUf4hSzHDE", "name": "GM"},
  "foundryVersion": "14.369.0",
  "world": {"id": "swffg-cartel", "title": "[redacted world]"},
  "system": {"id": "starwarsffg", "version": "2.0"},
  "messages": [
    {
      "messageId": "62Q5MoMOKIUL152k",
      "timestampMs": 1793430369144,
      "author": {"id": "UUSIcnoUf4hSzHDE", "name": "Alice"},
      "speaker": {
        "scene": "GfqHJ2buQyT5NzU5",
        "token": "mfSExRsgNlkMpeOd",
        "actor": "nBujFlZuMSKSSpXz",
        "alias": "Veyra Sol"
      },
      "speakerName": "Veyra Sol",
      "actorId": "nBujFlZuMSKSSpXz",
      "actorName": "Veyra Sol",
      "tokenName": "Veyra Sol",
      "style": 0,
      "type": "base",
      "system": {},
      "flavor": "Laser rifle attack",
      "content": "<div class=\"ffg-roll\">…</div>",
      "whisper": [],
      "blind": false,
      "flags": {},
      "rolls": [
        {
          "class": "RollFFG",
          "formula": "2eP+1eA+1eB",
          "total": 0,
          "terms": [],
          "ffg": {
            "success": 2,
            "failure": 0,
            "advantage": 1,
            "threat": 0,
            "triumph": 1,
            "despair": 0,
            "light": 0,
            "dark": 0
          },
          "hasFFG": true,
          "hasStandard": false,
          "data": {"name": "Laser rifle"},
          "addedResults": [],
          "flavorText": "Laser rifle attack"
        }
      ],
      "rollsRaw": ["{\"class\":\"RollFFG\",\"formula\":\"2eP+1eA+1eB\"}"],
      "rollParseError": null
    }
  ],
  "warnings": []
}
```

- `rolls` is authoritative when present; `rollsRaw` preserves the stored `_source.rolls` audit data.
- `rollParseError` is set when prepared rolls fail to serialize and the macro falls back to parsing raw roll strings.
- Base Roll fields (`options`, `dice`, `terms`, `evaluated`, etc.) are preserved verbatim; examples abbreviate `terms`.
- `style` follows Foundry `CHAT_MESSAGE_STYLES`: `0` other, `1` OOC, `2` IC, `3` emote.
- The macro resolves author/speaker/actor/token names on the GM client before export. `content` is raw HTML; the importer derives `contentText`.

## Important Foundry/roll facts

- `ChatMessage.timestamp` is numeric epoch-ms and is the canonical event time.
- `ChatMessage` schema fields include `author`, `timestamp`, `flavor`, `content`, `speaker{alias,actor,token}`, `whisper`, `blind`, `rolls`, `flags`, `style`.
- `ChatMessage.alias` resolves to the token/actor name for in-character messages and the user name for OOC messages.
- Stored `message._source.rolls` are JSON strings; prepared `message.rolls` are Roll instances whose `toJSON()` is the structured representation. Use prepared rolls.
- Private/blind rolls and whispers are exported when the GM runs the macro. This is intentional and must be disclosed in consent.
- FFG `RollFFG.toJSON()` adds `ffg`, `hasFFG`, `hasStandard`, `data`, `addedResults`, and `flavorText`; see [FFG-NARRATIVE-DICE.md](FFG-NARRATIVE-DICE.md).
- Other systems may use custom Roll subclasses; the generic adapter preserves formula/total/terms and raw JSON rather than discarding unknown fields.

## Import and normalization

1. Validate the top-level export schema and metadata.
2. Reject/flag unknown schema versions; accept unknown message fields.
3. Filter messages to `session.startedAtMs`/`stoppedAtMs` with `merge.filterMarginMs` (default 300000).
4. Normalize each message to a Foundry event per [DATA-FORMATS.md](DATA-FORMATS.md):
   - `type: "roll"` when structured rolls exist, else `"chat"`.
   - Copy identity from `author`/`speaker`/`actorName`/`tokenName`.
   - Preserve each roll object (`class`, `formula`, `total`, `ffg`/system fields, `terms`, raw JSON).
   - Preserve visibility (`whisper`, `blind`), flags, and content text.
5. Write `foundry/events.jsonl` and `foundry/import-summary.json`; report counts, time range, system, and warnings.
6. Keep the original upload as `foundry/export.json` for audit/reprocessing. Imports replace `events.jsonl` and deduplicate by Foundry message ID.
7. The live module writes `foundry/live-events.jsonl` and `foundry/live-state.json`. Merge reads both `events.jsonl` and `live-events.jsonl` and deduplicates by `eventId`; a later macro import therefore does not duplicate live rolls. `live-state.json` is the last scene/combat heartbeat, not the canonical event log.

Import failures are scoped to Foundry data; a missing/invalid export does not block speech transcription, but merge will show rolls as absent.

## Adapters

- **starwarsffg (primary):** render net success/failure/advantage/threat/triumph/despair and light/dark force pips; include added results and item/flavor context. Never use numeric `total` as the outcome.
- **sfrpg (next):** standard d20 formula/total/dice; preserve attack/damage flavor and multiple rolls per message.
- **generic:** formula/total/dice; fall back to raw JSON if structure is unknown.

Adapter rules and fixtures live under `src/core/foundry/` and `tests/fixtures/foundry/` once implementation starts.

## Private rolls, consent, and privacy

- The macro and live module see all messages visible to the GM, including whispers/blind rolls.
- Tell players before recording that private/self/blind rolls will be captured and can appear in local notes/reports.
- Module **0.3.1+** shows players the recording/LLM notice with **Continue — record me** and **Opt out of recording**. Consent is assumed unless they opt out. Player opt-outs travel as a GM whisper and are forwarded to the dashboard; the bridge data itself still comes only from the GM client.
- The GM can tick **Prompt players in Foundry when recording starts** on Record; the dashboard records the prompt and queues a bridge command. `game.tableRecords.promptConsent()` remains available for a manual re-prompt. The prompt (or any player response) is enough to confirm consent for a draft session; the dashboard GM tick remains the no-module fallback.
- Opted-out players are not subscribed to, transcribed, merged, rendered, or summarized. Transcripts and recaps say they did not want to be recorded.
- Foundry content may include player names, character names, and game text; keep session data local and follow the retention policy in [PRIVACY.md](PRIVACY.md).

## Deferred options

- **Socket/cloud relay:** a hosted relay or `game.socket` bridge is intentionally not used. It would add a cloud dependency and another credential; the loopback module covers the live use case without it.
- **Direct world DB import:** copy `Data/worlds/<world>/data/messages` and read with `classic-level` after Foundry closes. Zero-click but internal/undocumented; a validation spike is required before relying on it.

Neither deferred option changes the canonical Foundry event/import contract.


