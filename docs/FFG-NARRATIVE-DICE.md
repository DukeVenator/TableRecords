# TableRecords FFG narrative-dice adapter (first system)

## Compatibility

- Foundry VTT 14.369.0 (installed).
- FFG narrative-dice system 2.0, compatibility `minimum: 13`, `verified: 14`, `maximum: 14`.
- The macro uses generic ChatMessage/Roll APIs plus the system's own `RollFFG.toJSON()` extras; no system-specific module hooks are required.

## Roll structure

`RollFFG` extends `foundry.dice.Roll`. When the macro calls `roll.toJSON()`, the system appends:

```json
{
  "class": "RollFFG",
  "formula": "2eP+1eA+1eB",
  "total": 0,
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
  "data": {},
  "addedResults": [],
  "flavorText": "Laser rifle attack"
}
```

Notes:

- `ffg` values are already net-cancelled for success/failure and advantage/threat by the system.
- Triumph also contributes to success and Despair to failure during evaluation, but they remain separately counted in `ffg`; render them separately and do not double-count.
- `ForceDie` results use `light`/`dark` pips; do not treat them as success/failure.
- `addedResults` contains manually added symbols from the roll builder (type, symbol, value, negative).
- `hasStandard` indicates mixed standard dice in the roll; preserve them but do not map them into FFG symbols.
- Numeric `total` is not a meaningful success/failure value for FFG rolls. Never render it as the outcome.
- `data`/`flavorText` may carry item/attack context; include `data.name`/`uuid` when present.
- Private rolls may hide content in the UI while the GM export still contains the roll data; consent accordingly.

## Rendering rules

Output is a compact, deterministic string:

1. Use net `ffg` counts; omit zero values.
2. Order: Success, Failure, Advantage, Threat, Triumph, Despair, Light, Dark.
3. Pluralize naturally (`1 Success`, `2 Advantages`).
4. Append added results that are not already represented in `ffg`.
5. Keep formula, flavor/attack name, actor/alias, and raw JSON link in the timeline data; the Markdown line may show only symbols + context.
6. If `ffg` is absent but an FFG roll is detected, preserve raw JSON and fall back to formula + a warning; do not fabricate symbols.

Examples:

```text
[20:26:09] ROLL — Veyra Sol — Laser rifle attack — 2 Successes, 1 Advantage, 1 Triumph
[20:27:40] ROLL — Korrin — Coordination — 1 Failure, 2 Threats, 1 Despair
[20:31:02] ROLL — Dr. Ix — Force power — 2 Light, 1 Dark
```

## STT vocabulary (FFG)

Use these as `initial_prompt`/`hotwords` and as a post-transcription correction lexicon:

- Dice/symbols: Success, Failure, Advantage, Threat, Triumph, Despair, Light side, Dark side, Force die, Proficiency, Ability, Boost, Setback, Difficulty, Challenge.
- System terms: Destiny Points, Destiny Pool, strain, wounds, soak, defense, Obligation, Duty, Morality, Conflict, Force rating, Force power, talent, specialization, career, species.
- Setting terms: campaign locations, factions, species, ships, and character names. Keep those in the session vocabulary, not in generic code.

Campaign-specific names (players, PCs, NPCs, ships, locations) belong in the session vocabulary file and/or the STT prompt, not in generic code. Correct known names deterministically after STT; never let STT invent lore.

## Session mapping

- Speech is labeled with the Discord user's character for the selected system.
- Rolls are labeled from Foundry's actor/alias; if the actor is missing, use the author and mark it.
- Keep the Discord name visible for troubleshooting and OOC speech: e.g. `Alice (Veyra Sol)`.
- A player may have different characters across systems; mapping is per-session/per-system.

## Fixtures/tests required

- A constructed `RollFFG` export with multiple dice, net cancellation, triumph/despair, light/dark, addedResults, and mixed standard dice.
- A no-roll chat message, a whisper/blind message, and an OOC message.
- Golden Markdown/CSV timeline output for the above.
- A warning case with `ffg` missing but formula present.

## Next adapter

SFRPG uses standard d20 rolls (`_SFRPGRoll`) with formula/total/dice; its adapter should preserve multiple rolls per message and fall back to generic rendering when custom fields are absent. See [FOUNDRY.md](FOUNDRY.md).
