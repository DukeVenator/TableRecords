/*
 * TableRecords Foundry export macro (v1)
 *
 * HOW TO USE
 *  1. Foundry VTT 14.x, GM client, desired world open.
 *  2. Create a Script Macro named "TableRecords Export" and paste this whole file.
 *  3. Run it after a session.
 *  4. Upload the downloaded JSON in the TableRecords dashboard (Sessions -> Foundry import).
 *
 * OPTIONAL
 *  Set SINCE to an epoch-ms value to export only messages at/after that time.
 *  0 exports the whole chat log; the dashboard also filters by the session window.
 *
 * PRIVACY
 *  The GM sees whispers and blind/private rolls. This export includes them when present.
 *  Get informed consent before running it for a session.
 *
 * SYSTEM SUPPORT
 *  The export is system-agnostic. Prepared rolls preserve subclass data; FFG's
 *  RollFFG.toJSON() includes `ffg`, `hasFFG`, `hasStandard`, `data`, `addedResults`,
 *  and `flavorText`.
 *
 * VALIDATION
 *  Test against your Foundry/system versions after upgrades. The dashboard parser reports
 *  malformed/missing roll data instead of silently dropping it.
 */
(() => {
  const SINCE = 0; // optional epoch-ms cutoff; 0 = all messages

  const messages = [];
  for (const m of game.messages.contents) {
    if (SINCE && typeof m.timestamp === "number" && m.timestamp < SINCE) continue;

    let rolls = [];
    let rollParseError = null;
    try {
      rolls = m.rolls.map((r) => r.toJSON());
    } catch (err) {
      rollParseError = String(err?.message ?? err);
      try {
        rolls = (m._source.rolls ?? []).map((raw) =>
          typeof raw === "string" ? JSON.parse(raw) : raw
        );
      } catch (fallbackErr) {
        rollParseError += ` | fallback failed: ${String(fallbackErr?.message ?? fallbackErr)}`;
        rolls = [];
      }
    }

    const author = m.author ?? game.users.get(m._source.author) ?? null;
    const actor =
      m.speakerActor ??
      (m.speaker?.actor ? game.actors.get(m.speaker.actor) ?? null : null);
    const scene = m.speaker?.scene ? game.scenes.get(m.speaker.scene) : null;
    const token =
      scene && m.speaker?.token ? scene.tokens.get(m.speaker.token) ?? null : null;
    const speakerAlias = m.alias ?? m.speaker?.alias ?? null;
    const rollsRaw = Array.isArray(m._source.rolls) ? m._source.rolls : [];

    messages.push({
      messageId: m.id,
      timestampMs: m.timestamp,
      author: {
        id: author?.id ?? m._source.author ?? null,
        name: author?.name ?? null
      },
      speaker: {
        scene: m.speaker?.scene ?? null,
        token: m.speaker?.token ?? null,
        actor: m.speaker?.actor ?? null,
        alias: m.speaker?.alias ?? null
      },
      speakerName: speakerAlias,
      actorId: actor?.id ?? m.speaker?.actor ?? null,
      actorName: actor?.name ?? null,
      tokenName: token?.name ?? null,
      style: m.style,
      type: m.type,
      system: m.system,
      flavor: m.flavor,
      content: m.content,
      whisper: m.whisper,
      blind: m.blind,
      flags: m.flags,
      rolls,
      rollsRaw,
      rollParseError
    });
  }

  const payload = {
    schema: "tablerecords.foundry-export/v1",
    exportedAtMs: Date.now(),
    exportedBy: { id: game.user.id, name: game.user.name },
    foundryVersion: game.version,
    world: {
      id: game.world.id,
      title: game.world.title ?? game.world.name ?? game.world.id
    },
    system: {
      id: game.system.id,
      version: game.system.version
    },
    messages,
    warnings: messages
      .filter((m) => m.rollParseError)
      .map((m) => ({
        code: "roll_parse_error",
        messageId: m.messageId,
        message: m.rollParseError
      }))
  };

  const save = foundry.utils?.saveDataToFile ?? globalThis.saveDataToFile;
  if (typeof save !== "function") {
    ui.notifications.error(
      "TableRecords: saveDataToFile is unavailable in this Foundry version."
    );
    return;
  }

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const filename = `tablerecords-foundry-${game.world.id}-${stamp}.json`;
  save(JSON.stringify(payload), "application/json", filename);

  console.log(
    `TableRecords: exported ${messages.length} messages from ${game.world.id} (${game.system.id} ${game.system.version})`
  );
  ui.notifications.info(`TableRecords export: ${messages.length} messages -> ${filename}`);
})();
