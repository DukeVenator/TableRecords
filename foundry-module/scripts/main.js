/*
 * TableRecords Bridge — Foundry VTT module (v0.4.1)
 *
 * The GM client posts live chat/roll messages, scene and combat state, and
 * optional mental notes to a local TableRecords dashboard. When the Break Time
 * module is active, it also mirrors break starts and ends. The dashboard is the
 * only receiver; the bridge token is stored in world settings and is sent in a
 * request header. No socket server, cloud service, or module relay is used.
 *
 * Compatibility: Foundry VTT 12–14. The module deliberately uses small,
 * defensive API access so a missing optional API does not break play.
 */
(() => {
  const MODULE_ID = "table-records-bridge";
  const VERSION = "0.4.1";
  const CONSENT_VERSION = "2026-11-01";
  const CONSENT_NOTICE = [
    "TableRecords records each Discord speaker separately for local tabletop note-taking.",
    "Audio is transcribed on the GM's machine. It is not shared off your local network and is not sent to any provider, cloud transcription service, or other third party.",
    "The optional local LLM is used only to summarize session notes. Recordings and transcripts are not used as training data.",
    "Consent is assumed unless you opt out. If you opt out, your voice is not recorded or processed, and the transcript notes that you did not want to be recorded."
  ].join(" ");
  const MAX_QUEUE = 300;
  const DEFAULTS = {
    dashboardUrl: "http://127.0.0.1:17300",
    bridgeToken: "",
    sessionId: "",
    enabled: true,
    pushChat: true,
    pushRolls: true,
    publishRoster: true,
    promptConsent: true,
    followBreakTime: true,
    setupSeen: false,
    setupComplete: false,
    heartbeatSeconds: 30
  };

  const queue = [];
  let flushTimer = null;
  let heartbeatTimer = null;
  let stateTimer = null;
  let flushing = false;
  let lastWarningAt = 0;
  let lastResult = null;
  let lastReason = null;
  let breakMarkerActive = false;
  let breakMarkerStartedAtMs = null;

  function setting(key) {
    try {
      const value = game.settings.get(MODULE_ID, key);
      return value === undefined || value === null ? DEFAULTS[key] : value;
    } catch {
      return DEFAULTS[key];
    }
  }

  function log(...args) {
    console.log("TableRecords Bridge |", ...args);
  }

  function warn(message, force = false) {
    const now = Date.now();
    if (!force && now - lastWarningAt < 60_000) return;
    lastWarningAt = now;
    try {
      ui.notifications.warn(`TableRecords Bridge: ${message}`);
    } catch {
      // Notifications are optional in test/headless contexts.
    }
    console.warn("TableRecords Bridge |", message);
  }

  function moduleVersion() {
    try {
      return game.modules?.get(MODULE_ID)?.version ?? VERSION;
    } catch {
      return VERSION;
    }
  }

  function worldPayload() {
    return {
      id: game.world?.id ?? "unknown",
      title: game.world?.title ?? game.world?.name ?? game.world?.id ?? "Unknown World"
    };
  }

  function systemPayload() {
    return {
      id: game.system?.id ?? "generic",
      version: game.system?.version ?? null
    };
  }

  function currentState() {
    let scene = null;
    try {
      const active = game.scenes?.current ?? null;
      if (active) scene = { id: active.id ?? null, name: active.name ?? null };
    } catch {
      scene = null;
    }
    let combat = null;
    try {
      const active = game.combat;
      if (active) {
        combat = {
          id: active.id,
          name: active.name ?? "Combat",
          round: typeof active.round === "number" ? active.round : null,
          active: active.started !== false
        };
      }
    } catch {
      combat = null;
    }
    return {
      scene,
      combat,
      paused: Boolean(game.paused),
      userId: game.user?.id ?? null,
      userName: game.user?.name ?? null
    };
  }

  function currentRoster() {
    if (setting("publishRoster") === false) return null;
    let users = [];
    let actors = [];
    try {
      const source = game.users?.contents ?? Array.from(game.users ?? []);
      users = source
        .filter((user) => user && user.id && user.name)
        .slice(0, 200)
        .map((user) => {
          const character = user.character ?? null;
          return {
            id: user.id,
            name: user.name,
            isGM: Boolean(user.isGM),
            characterId: character?.id ?? null,
            characterName: character?.name ?? null
          };
        });
    } catch {
      users = [];
    }
    try {
      const source = game.actors?.contents ?? Array.from(game.actors ?? []);
      const userActorIds = new Set(users.map((user) => user.characterId).filter(Boolean));
      actors = source
        .filter((actor) => actor && actor.id && actor.name)
        .filter((actor) => actor.type === "character" && (actor.hasPlayerOwner === true || userActorIds.has(actor.id)))
        .slice(0, 500)
        .map((actor) => ({
          id: actor.id,
          name: actor.name,
          type: actor.type ?? "character",
          hasPlayerOwner: Boolean(actor.hasPlayerOwner)
        }));
    } catch {
      actors = [];
    }
    return { users, actors };
  }

  function serializeMessage(message) {
    let rolls = [];
    let rollParseError = null;
    try {
      rolls = (message.rolls ?? []).map((roll) => (typeof roll.toJSON === "function" ? roll.toJSON() : roll));
    } catch (error) {
      rollParseError = String(error?.message ?? error);
      try {
        rolls = (message._source?.rolls ?? []).map((raw) => (typeof raw === "string" ? JSON.parse(raw) : raw));
      } catch (fallbackError) {
        rollParseError += ` | fallback failed: ${String(fallbackError?.message ?? fallbackError)}`;
        rolls = [];
      }
    }
    const author = message.author ?? game.users?.get?.(message._source?.author) ?? null;
    const actor =
      message.speakerActor ??
      (message.speaker?.actor && game.actors?.get ? game.actors.get(message.speaker.actor) : null) ??
      null;
    let scene = null;
    let token = null;
    try {
      if (message.speaker?.scene) scene = game.scenes?.get?.(message.speaker.scene) ?? null;
      if (scene && message.speaker?.token) token = scene.tokens?.get?.(message.speaker.token) ?? null;
    } catch {
      scene = null;
      token = null;
    }
    const rollsRaw = Array.isArray(message._source?.rolls) ? message._source.rolls : [];
    return {
      messageId: message.id,
      timestampMs: message.timestamp ?? Date.now(),
      author: {
        id: author?.id ?? message._source?.author ?? null,
        name: author?.name ?? null
      },
      speaker: {
        scene: message.speaker?.scene ?? null,
        token: message.speaker?.token ?? null,
        actor: message.speaker?.actor ?? null,
        alias: message.speaker?.alias ?? null
      },
      speakerName: message.alias ?? message.speaker?.alias ?? null,
      actorId: actor?.id ?? message.speaker?.actor ?? null,
      actorName: actor?.name ?? null,
      tokenName: token?.name ?? null,
      style: message.style,
      type: message.type,
      flavor: message.flavor,
      content: message.content,
      whisper: Array.isArray(message.whisper) ? message.whisper : [],
      blind: message.blind === true,
      flags: message.flags ?? {},
      rolls,
      rollsRaw,
      rollParseError
    };
  }

  function payload(messages, note, events) {
    const targetSession = String(setting("sessionId") || "").trim();
    return {
      schema: "tablerecords.foundry-live/v1",
      sentAtMs: Date.now(),
      moduleVersion: moduleVersion(),
      foundryVersion: game.version ?? null,
      world: worldPayload(),
      system: systemPayload(),
      state: currentState(),
      roster: currentRoster(),
      messages: Array.isArray(messages) ? messages : [],
      ...(targetSession ? { sessionId: targetSession } : {}),
      ...(note ? { note } : {}),
      ...(Array.isArray(events) && events.length > 0 ? { events } : {})
    };
  }

  function bridgeBase() {
    return String(setting("dashboardUrl") || "").trim().replace(/\/+$/, "");
  }

  function bridgeConfigured() {
    return Boolean(bridgeBase() && String(setting("bridgeToken") || "").trim());
  }

  async function post(payloadValue, timeoutMs = 12_000) {
    const base = bridgeBase();
    const token = String(setting("bridgeToken") || "").trim();
    if (!base || !token) {
      return { ok: false, reason: "not_configured", status: 0 };
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetch(`${base}/api/foundry/live`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-tablerecords-token": token
        },
        body: JSON.stringify(payloadValue),
        signal: controller ? controller.signal : undefined
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          reason: body?.error?.code ?? "http_error",
          message: body?.error?.message ?? `${response.status} ${response.statusText}`
        };
      }
      return { ok: true, status: response.status, body };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        reason: error?.name === "AbortError" ? "timeout" : "network_error",
        message: String(error?.message ?? error)
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function scheduleFlush(delay = 1200) {
    if (flushTimer) return;
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, delay);
  }

  const NO_RETRY_REASONS = new Set(["session_not_found", "session_not_ready", "world_mismatch", "system_mismatch"]);

  async function flush(force = false) {
    if (flushing) return lastResult;
    if (!setting("enabled")) return null;
    if (queue.length === 0 && !force) return null;
    flushing = true;
    const batch = queue.splice(0, Math.min(queue.length, 100));
    try {
      const result = await post(payload(batch));
      lastResult = result;
      if (!result.ok) {
        if (result.reason === "no_active_session") {
          lastReason = result.reason;
          return result;
        }
        if (result.reason === "not_configured") {
          lastReason = result.reason;
          warn("set the dashboard URL and bridge token in Module Settings.", true);
          if (batch.length > 0) queue.unshift(...batch.slice(0, MAX_QUEUE));
          return result;
        }
        if (NO_RETRY_REASONS.has(result.reason)) {
          lastReason = result.reason;
          warn(result.message ?? result.reason, true);
          return result;
        }
        // Keep the messages for a retry; drop the oldest if the queue is capped.
        if (batch.length > 0) queue.unshift(...batch.slice(0, MAX_QUEUE));
        while (queue.length > MAX_QUEUE) queue.shift();
        warn(result.message ?? result.reason ?? "push failed");
        scheduleFlush(5000);
        return result;
      }
      lastReason = result.body?.reason ?? null;
      if (result.body?.reason === "no_active_session" && batch.length > 0) {
        warn("no active TableRecords session; the bridge is connected but not recording.", true);
      }
      return result;
    } finally {
      flushing = false;
    }
  }

  function enqueue(message) {
    if (!setting("enabled")) return;
    const hasRolls = Array.isArray(message.rolls) && message.rolls.length > 0;
    if (hasRolls) {
      if (!setting("pushRolls")) return;
    } else if (!setting("pushChat")) {
      return;
    }
    queue.push(serializeMessage(message));
    while (queue.length > MAX_QUEUE) queue.shift();
    scheduleFlush();
  }

  function sendState(delay = 0) {
    if (stateTimer) return;
    stateTimer = setTimeout(() => {
      stateTimer = null;
      void (async () => {
        if (!setting("enabled")) return;
        const result = await post(payload([]));
        lastResult = result;
        if (!result.ok) lastReason = result.reason ?? null;
        else lastReason = result.body?.reason ?? null;
      })();
    }, delay);
  }

  async function sendMentalNote(text) {
    const note = String(text ?? "").trim().slice(0, 500);
    if (!note) return { ok: false, reason: "empty_note" };
    if (!setting("enabled")) {
      warn("enable the bridge in TableRecords module settings first.", true);
      return { ok: false, reason: "disabled" };
    }
    const result = await post(payload([], note));
    lastResult = result;
    if (!result.ok) {
      warn(result.message ?? result.reason ?? "could not send the mental note");
    } else if (result.body?.noteAccepted) {
      try {
        ui.notifications.info("TableRecords: mental note saved.");
      } catch {
        // ignore
      }
    } else if (result.body?.reason === "no_active_session") {
      warn("no active TableRecords session; start recording first.", true);
    }
    return result;
  }

  function escapeHtml(value) {
    return String(value ?? "").replace(/[&<>"']/g, (character) => {
      switch (character) {
        case "&":
          return "&amp;";
        case "<":
          return "&lt;";
        case ">":
          return "&gt;";
        case '"':
          return "&quot;";
        default:
          return "&#39;";
      }
    });
  }

  function setupProgress(step) {
    const names = ["Welcome", "Connection", "Test"];
    return `<div class="tr-setup-progress">${names
      .map((name, index) => {
        const number = index + 1;
        const state = number === step ? "active" : number < step ? "done" : "";
        return `<span class="${state}">${number}. ${name}</span>`;
      })
      .join("")}</div>`;
  }

  function checked(value) {
    return value ? " checked" : "";
  }

  function setupUrlLooksValid(value) {
    return /^https?:\/\/\S+$/i.test(String(value ?? "").trim());
  }

  async function showSetupWelcome(DialogV2) {
    return DialogV2.wait({
      window: { title: "TableRecords setup", icon: "fas fa-wand-magic-sparkles" },
      modal: true,
      position: { width: 560 },
      content: `<div class="table-records-setup">
        ${setupProgress(1)}
        <h2>Connect this world</h2>
        <p>TableRecords records Discord audio and combines it with Foundry chat, rolls, scenes, and breaks. This wizard connects this Foundry world to the dashboard on this machine.</p>
        <ul class="tr-setup-list">
          <li>Live chat and rolls are attached to the session as you play.</li>
          <li>Scene, combat, and Break Time markers land on the session timeline.</li>
          <li>Players see the recording consent notice with an opt-out.</li>
          <li>GM tools can draft a recap, names, or clues for players; nothing posts until you review it.</li>
        </ul>
        <p class="notes">The dashboard needs to be running before you finish. You can change these settings later.</p>
      </div>`,
      buttons: [
        { action: "start", label: "Get started", default: true, callback: () => "start" },
        { action: "later", label: "Not now", callback: () => "later" }
      ],
      rejectClose: false
    });
  }

  async function showSetupConnection(DialogV2, state) {
    const breakTimeAvailable = breakTimeModuleActive();
    return DialogV2.wait({
      window: { title: "TableRecords setup", icon: "fas fa-wand-magic-sparkles" },
      modal: true,
      position: { width: 620 },
      content: `<div class="table-records-setup">
        ${setupProgress(2)}
        <h2>Dashboard connection</h2>
        <div class="form-group">
          <label for="tr-setup-dashboard">Dashboard address</label>
          <div class="form-fields">
            <input id="tr-setup-dashboard" type="text" name="dashboardUrl" value="${escapeHtml(state.dashboardUrl)}" autocomplete="off" spellcheck="false">
          </div>
          <p class="hint">Usually http://127.0.0.1:17300.</p>
        </div>
        <div class="form-group">
          <label for="tr-setup-token">Bridge token</label>
          <div class="form-fields">
            <input id="tr-setup-token" type="password" name="bridgeToken" value="${escapeHtml(state.bridgeToken)}" autocomplete="off" spellcheck="false">
          </div>
          <p class="hint">Copy it from TableRecords → Setup → Foundry live bridge.</p>
        </div>
        <div class="tr-setup-checks">
          <label class="checkbox"><input type="checkbox" name="enabled"${checked(state.enabled)}> Enable the live bridge</label>
          <label class="checkbox"><input type="checkbox" name="promptConsent"${checked(state.promptConsent)}> Prompt players for recording consent</label>
          <label class="checkbox"><input type="checkbox" name="publishRoster"${checked(state.publishRoster)}> Publish player and character names</label>
          ${breakTimeAvailable ? `<label class="checkbox"><input type="checkbox" name="followBreakTime"${checked(state.followBreakTime)}> Follow Break Time breaks</label>` : ""}
        </div>
        <details class="tr-setup-advanced">
          <summary>Advanced</summary>
          <div class="form-group">
            <label for="tr-setup-session">Session ID</label>
            <div class="form-fields">
              <input id="tr-setup-session" type="text" name="sessionId" value="${escapeHtml(state.sessionId)}" autocomplete="off" spellcheck="false">
            </div>
            <p class="hint">Leave blank to follow whichever session is recording.</p>
          </div>
        </details>
      </div>`,
      buttons: [
        {
          action: "next",
          label: "Save and test",
          default: true,
          callback: (_event, button) => {
            const form = button?.form ?? button?.closest?.("form");
            if (!form?.elements) return "invalid";
            state.dashboardUrl = String(form.elements.dashboardUrl?.value ?? "").trim();
            state.bridgeToken = String(form.elements.bridgeToken?.value ?? "").trim();
            state.sessionId = String(form.elements.sessionId?.value ?? "").trim();
            state.enabled = form.elements.enabled?.checked === true;
            state.promptConsent = form.elements.promptConsent?.checked === true;
            state.publishRoster = form.elements.publishRoster?.checked === true;
            if (form.elements.followBreakTime) state.followBreakTime = form.elements.followBreakTime.checked === true;
            return "next";
          }
        },
        { action: "back", label: "Back" }
      ],
      rejectClose: false
    });
  }

  async function saveSetupSettings(state) {
    try {
      await game.settings.set(MODULE_ID, "dashboardUrl", state.dashboardUrl);
      await game.settings.set(MODULE_ID, "bridgeToken", state.bridgeToken);
      await game.settings.set(MODULE_ID, "sessionId", state.sessionId);
      await game.settings.set(MODULE_ID, "enabled", state.enabled);
      await game.settings.set(MODULE_ID, "promptConsent", state.promptConsent);
      await game.settings.set(MODULE_ID, "publishRoster", state.publishRoster);
      await game.settings.set(MODULE_ID, "followBreakTime", state.followBreakTime);
      return true;
    } catch (error) {
      console.warn("TableRecords Bridge |", error);
      warn("the setup could not be saved. Try again.", true);
      return false;
    }
  }

  function setupResultText(result) {
    if (result.ok) {
      if (result.body?.reason === "no_active_session") {
        return "The dashboard is connected. No session is recording yet, so start a recording in TableRecords before play.";
      }
      return "The dashboard accepted the bridge token and is ready.";
    }
    switch (result.reason) {
      case "not_configured":
        return "The dashboard address or bridge token is missing.";
      case "network_error":
        return "The dashboard did not answer. Check that TableRecords is running and the address is right.";
      case "timeout":
        return "The dashboard did not answer in time. Check that TableRecords is running and the address is right.";
      case "invalid_bridge_token":
        return "The dashboard rejected the bridge token. Copy the current token from TableRecords and paste it again.";
      case "live_disabled":
        return "The live bridge is turned off in TableRecords. Turn it on in Setup, then test again.";
      case "world_mismatch":
      case "system_mismatch":
        return "The dashboard is connected to a different Foundry world. Clear the Session ID or check the target world.";
      case "session_not_found":
        return "That Session ID was not found. Clear it to follow the active recording, or paste the right ID.";
      case "session_not_ready":
        return "That session is not ready for live events. Clear the Session ID or start recording.";
      default:
        return "The dashboard rejected the connection. Check the address and token, then try again.";
    }
  }

  async function showSetupResult(DialogV2, result) {
    const connected = result.ok === true;
    const liveEnabled = setting("enabled") !== false;
    const disabledNotice = connected && !liveEnabled
      ? `<p class="notes">The live bridge is off. Turn it on in Module Settings before play.</p>`
      : "";
    const title = connected ? "Connection works" : "Connection needs attention";
    const breakLine = breakTimeModuleActive() ? "<li>Break Time starts and ends now appear as break markers.</li>" : "";
    const nextSteps = connected
      ? `${disabledNotice}<ul class="tr-setup-list">
          <li>Start a TableRecords recording before play.</li>
          <li>Keep the Foundry GM client open while you play.</li>
          ${breakLine}
        </ul>`
      : `<p class="notes">Fix the connection, then choose Test again. You can close setup and return later from Module Settings.</p>`;
    return DialogV2.wait({
      window: { title: "TableRecords setup", icon: "fas fa-wand-magic-sparkles" },
      modal: true,
      position: { width: 560 },
      content: `<div class="table-records-setup">
        ${setupProgress(3)}
        <h2>${title}</h2>
        <div class="tr-setup-result ${connected ? "ok" : "bad"}">
          <p>${escapeHtml(setupResultText(result))}</p>
        </div>
        ${nextSteps}
      </div>`,
      buttons: [
        { action: "finish", label: connected ? "Finish setup" : "Close setup", default: true },
        { action: "retest", label: "Test again" },
        { action: "back", label: "Back" }
      ],
      rejectClose: false
    });
  }

  async function openSetupWizard() {
    if (!game.user?.isGM) {
      warn("only a GM can run setup.", true);
      return { ok: false, reason: "gm_only" };
    }
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (!DialogV2?.wait) {
      warn("this Foundry version has no setup dialog; set the dashboard address and bridge token in module settings.", true);
      return { ok: false, reason: "no_dialog" };
    }
    if (setting("setupSeen") !== true) {
      try {
        await game.settings.set(MODULE_ID, "setupSeen", true);
      } catch {
        // The wizard still runs for this session.
      }
    }
    const state = {
      dashboardUrl: String(setting("dashboardUrl") || DEFAULTS.dashboardUrl),
      bridgeToken: String(setting("bridgeToken") || ""),
      sessionId: String(setting("sessionId") || ""),
      enabled: setting("enabled") !== false,
      promptConsent: setting("promptConsent") !== false,
      publishRoster: setting("publishRoster") !== false,
      followBreakTime: setting("followBreakTime") !== false
    };
    let step = 1;
    let lastTest = null;
    while (true) {
      if (step === 1) {
        const choice = await showSetupWelcome(DialogV2);
        if (choice !== "start") return { ok: false, reason: "dismissed" };
        step = 2;
        continue;
      }
      if (step === 2) {
        const choice = await showSetupConnection(DialogV2, state);
        if (choice === "back") {
          step = 1;
          continue;
        }
        if (choice === "invalid") {
          warn("the setup form could not be read. Try again.", true);
          continue;
        }
        if (choice !== "next") return { ok: false, reason: "dismissed" };
        const url = String(state.dashboardUrl ?? "").trim().replace(/\/+$/, "");
        if (!setupUrlLooksValid(url)) {
          warn("enter the dashboard address, starting with http:// or https://.", true);
          continue;
        }
        if (!String(state.bridgeToken ?? "").trim()) {
          warn("paste the bridge token from TableRecords.", true);
          continue;
        }
        state.dashboardUrl = url;
        if (!(await saveSetupSettings(state))) continue;
        step = 3;
        lastTest = null;
        continue;
      }
      if (!lastTest) {
        try {
          ui.notifications.info("TableRecords: testing the connection.");
        } catch {
          // optional
        }
        const targetSession = String(setting("sessionId") || "").trim();
        lastTest = await post(
          {
            schema: "tablerecords.foundry-live/v1",
            sentAtMs: Date.now(),
            moduleVersion: moduleVersion(),
            foundryVersion: game.version ?? null,
            world: worldPayload(),
            system: systemPayload(),
            messages: [],
            ...(targetSession ? { sessionId: targetSession } : {})
          },
          6000
        );
      }
      const choice = await showSetupResult(DialogV2, lastTest);
      if (choice === "back") {
        step = 2;
        lastTest = null;
        continue;
      }
      if (choice === "retest") {
        lastTest = null;
        continue;
      }
      if (choice === "finish") {
        try {
          await game.settings.set(MODULE_ID, "setupComplete", lastTest.ok === true);
        } catch {
          // The test result is still the useful part.
        }
        if (lastTest.ok) {
          try {
            ui.notifications.info("TableRecords: bridge connected.");
          } catch {
            // optional
          }
        } else {
          warn("setup was saved, but the bridge did not connect. Fix the connection and run the wizard again.", true);
        }
        return { ok: lastTest.ok === true, reason: lastTest.reason ?? null };
      }
      return { ok: false, reason: "dismissed" };
    }
  }

  async function promptSetupIfNeeded() {
    if (!game.user?.isGM) return;
    const token = String(setting("bridgeToken") || "").trim();
    if (token) {
      if (setting("setupSeen") !== true) {
        try {
          await game.settings.set(MODULE_ID, "setupSeen", true);
        } catch {
          // The bridge already works; setup state is only a prompt.
        }
      }
      if (setting("setupComplete") !== true) {
        try {
          await game.settings.set(MODULE_ID, "setupComplete", true);
        } catch {
          // The bridge already works; setup state is only a prompt.
        }
      }
      return;
    }
    if (setting("setupSeen") === true) return;
    try {
      await game.settings.set(MODULE_ID, "setupSeen", true);
    } catch {
      // The prompt can still open.
    }
    setTimeout(() => {
      void openSetupWizard();
    }, 1200);
  }

  function registerSetupMenu() {
    const Base = globalThis.foundry?.applications?.api?.ApplicationV2;
    if (typeof Base !== "function" || typeof game.settings.registerMenu !== "function") return;
    class SetupWizardMenu extends Base {
      static DEFAULT_OPTIONS = {
        id: "table-records-setup-menu",
        window: { title: "TableRecords setup" }
      };

      async render() {
        void openSetupWizard();
        return this;
      }
    }
    try {
      game.settings.registerMenu(MODULE_ID, "setupWizard", {
        name: "TableRecords setup",
        label: "Open setup wizard",
        hint: "Connect this world to the local TableRecords dashboard.",
        icon: "fas fa-wand-magic-sparkles",
        type: SetupWizardMenu,
        restricted: true
      });
    } catch {
      // Older Foundry versions may not support menu registration; the console API remains.
    }
  }

  function breakTimeModuleActive() {
    try {
      return game.modules?.get?.("breaktime")?.active === true;
    } catch {
      return false;
    }
  }

  function breakTimeSetting(key, fallback) {
    try {
      const value = game.settings.get("breaktime", key);
      return value === undefined || value === null ? fallback : value;
    } catch {
      return fallback;
    }
  }

  function breakTimePaused() {
    return breakTimeSetting("paused", false) === true;
  }

  function breakTimeStartedAtMs() {
    const value = breakTimeSetting("start", null);
    if (typeof value === "number" && Number.isFinite(value) && value > 0) return value;
    if (value && typeof value.getTime === "function") {
      const time = value.getTime();
      if (Number.isFinite(time) && time > 0) return time;
    }
    return null;
  }

  async function sendBreakEvent(phase, options = {}) {
    if (!setting("enabled")) {
      return { ok: false, reason: "disabled" };
    }
    const atMs = Number.isFinite(options.atMs) ? Math.trunc(options.atMs) : Date.now();
    const startedAtMs = Number.isFinite(options.startedAtMs) ? Math.trunc(options.startedAtMs) : null;
    const event = {
      eventId: `break-${phase}-${atMs}-${Math.random().toString(36).slice(2, 8)}`,
      kind: "break",
      phase,
      atMs,
      actor: {
        id: game.user?.id ?? null,
        name: game.user?.name ?? null
      },
      ...(startedAtMs != null ? { startedAtMs } : {}),
      source: "breaktime"
    };
    const result = await post(payload([], null, [event]));
    lastResult = result;
    if (!result.ok) {
      warn(result.message ?? result.reason ?? "could not send the break marker");
      return result;
    }
    if (Number(result.body?.eventsAccepted ?? 0) > 0) {
      try {
        ui.notifications.info(phase === "start" ? "TableRecords: break started." : "TableRecords: break ended.");
      } catch {
        // optional
      }
    } else if (result.body?.reason === "no_active_session") {
      warn("no active TableRecords session; the break was not saved.", true);
    }
    return result;
  }

  function handleBreakTimePause(paused) {
    if (setting("enabled") !== true) return;
    if (setting("followBreakTime") === false) return;
    if (!breakTimeModuleActive()) return;
    if (paused === true) {
      if (breakMarkerActive) return;
      breakMarkerActive = true;
      breakMarkerStartedAtMs = breakTimeStartedAtMs() ?? Date.now();
      void sendBreakEvent("start", { atMs: breakMarkerStartedAtMs });
      return;
    }
    if (!breakMarkerActive) return;
    const startedAtMs = breakMarkerStartedAtMs;
    breakMarkerActive = false;
    breakMarkerStartedAtMs = null;
    void sendBreakEvent("end", { atMs: Date.now(), startedAtMs });
  }

  function syncBreakTimeState() {
    if (setting("enabled") !== true) return;
    if (setting("followBreakTime") === false) return;
    if (!breakTimeModuleActive()) return;
    if (breakTimePaused()) {
      if (!breakMarkerActive) {
        breakMarkerActive = true;
        breakMarkerStartedAtMs = breakTimeStartedAtMs() ?? Date.now();
        void sendBreakEvent("start", { atMs: breakMarkerStartedAtMs });
      }
      return;
    }
    if (breakMarkerActive) handleBreakTimePause(false);
  }

  function consentStorageKey() {
    const world = game.world?.id ?? "world";
    return `tr-consent:${world}:${CONSENT_VERSION}`;
  }

  function hasAcknowledgedConsent() {
    try {
      return globalThis.localStorage?.getItem(consentStorageKey()) === "1";
    } catch {
      return false;
    }
  }

  function markConsentAcknowledged() {
    try {
      globalThis.localStorage?.setItem(consentStorageKey(), "1");
    } catch {
      // Storage may be unavailable in a sandboxed iframe; the dialog still works.
    }
  }

  async function postConsent(extra) {
    if (!setting("enabled")) {
      warn("enable the bridge in TableRecords module settings first.", true);
      return { ok: false, reason: "disabled" };
    }
    const result = await post({
      ...payload([]),
      consent: {
        noticeVersion: CONSENT_VERSION,
        promptedBy: game.user?.name ?? null,
        ...extra
      }
    });
    lastResult = result;
    return result;
  }

  function consentResponsePayload(optOut) {
    return {
      foundryUserId: game.user?.id ?? null,
      foundryUserName: game.user?.name ?? null,
      optOut: optOut === true,
      atMs: Date.now(),
      noticeVersion: CONSENT_VERSION
    };
  }

  async function sendConsentResponse(optOut) {
    const response = consentResponsePayload(optOut);
    markConsentAcknowledged();
    if (game.user?.isGM) {
      const result = await postConsent({ responses: [response] });
      if (result.ok) {
        try {
          ui.notifications.info(
            optOut
              ? "TableRecords: you are opted out. Your voice will not be recorded."
              : "TableRecords: you are recorded. You can opt out any time."
          );
        } catch {
          // notifications are optional
        }
      } else {
        warn(result.message ?? result.reason ?? "could not record your consent choice");
      }
      return result;
    }
    const ChatMessageClass = globalThis.ChatMessage;
    if (!ChatMessageClass?.create) {
      warn("Foundry chat is unavailable; tell your GM that you opted out.", true);
      return { ok: false, reason: "no_chat" };
    }
    const gmIds = (game.users?.contents ?? Array.from(game.users ?? []))
      .filter((user) => user?.isGM)
      .map((user) => user.id)
      .filter(Boolean);
    if (gmIds.length === 0) {
      warn("No GM client is connected; tell your GM that you opted out.", true);
      return { ok: false, reason: "no_gm" };
    }
    await ChatMessageClass.create({
      content: `<p><strong>TableRecords consent:</strong> ${optOut ? "I opt out of being recorded." : "I consent to being recorded for local notes."}</p>`,
      whisper: gmIds,
      flags: {
        [MODULE_ID]: {
          consentResponse: response
        }
      }
    });
    try {
      ui.notifications.info("TableRecords: your consent choice was sent to the GM.");
    } catch {
      // optional
    }
    return { ok: true, queued: true };
  }

  function openConsentDialog(options = {}) {
    if (!options.force && hasAcknowledgedConsent()) return;
    const content = `
      <div class="table-records-consent">
        <p><strong>Before this session is recorded</strong></p>
        <p>${CONSENT_NOTICE}</p>
        <p class="notes">Closing this window is treated as consent, but you can opt out at any time by opening it again or telling the GM.</p>
        <p class="notes"><strong>Opting out</strong> means your voice is not recorded or processed, and the transcript will say that you did not want to be recorded.</p>
      </div>`;
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (DialogV2?.wait) {
      void DialogV2.wait({
        window: { title: "TableRecords recording consent" },
        content,
        modal: true,
        buttons: [
          {
            action: "record",
            label: "Continue — record me",
            default: true,
            callback: () => false
          },
          {
            action: "optout",
            label: "Opt out of recording",
            callback: () => true
          }
        ],
        close: () => null,
        rejectClose: false
      })
        .then((choice) => {
          if (choice === true) void sendConsentResponse(true);
          else if (choice === false) void sendConsentResponse(false);
          else markConsentAcknowledged();
        })
        .catch((error) => warn(String(error?.message ?? error), true));
      return;
    }
    const DialogClass = globalThis.Dialog;
    if (typeof DialogClass !== "function") {
      markConsentAcknowledged();
      warn("this Foundry version has no supported consent dialog; ask your GM to record your choice.", true);
      return;
    }
    new DialogClass({
      title: "TableRecords recording consent",
      content,
      buttons: {
        record: {
          label: "Continue — record me",
          callback: () => {
            void sendConsentResponse(false);
          }
        },
        optout: {
          label: "Opt out of recording",
          callback: () => {
            void sendConsentResponse(true);
          }
        }
      },
      default: "record",
      close: () => markConsentAcknowledged()
    }).render(true);
  }

  async function forwardConsentResponse(response) {
    if (!response || !response.foundryUserId) return { ok: false, reason: "invalid_response" };
    const result = await postConsent({ responses: [response] });
    if (result.ok) {
      try {
        ui.notifications.info(
          `TableRecords: ${response.foundryUserName ?? "player"} ${response.optOut ? "opted out" : "consented"}.`
        );
      } catch {
        // optional
      }
    } else {
      warn(result.message ?? result.reason ?? "could not forward the consent response");
    }
    return result;
  }

  async function broadcastConsentMessage() {
    const ChatMessageClass = globalThis.ChatMessage;
    if (ChatMessageClass?.create) {
      await ChatMessageClass.create({
        content: "<p><strong>TableRecords:</strong> the GM has sent the recording consent notice. Open the TableRecords consent dialog to continue or opt out.</p>",
        flags: {
          [MODULE_ID]: {
            consentPrompt: true,
            noticeVersion: CONSENT_VERSION
          }
        }
      });
    }
  }

  async function promptAllPlayers() {
    if (!game.user?.isGM) {
      warn("only a GM can send the consent prompt.", true);
      return { ok: false, reason: "gm_only" };
    }
    const result = await postConsent({ promptSent: true });
    await broadcastConsentMessage();
    if (result.ok) {
      try {
        ui.notifications.info("TableRecords consent prompt sent. Consent is assumed unless a player opts out.");
      } catch {
        // optional
      }
    } else {
      warn(result.message ?? result.reason ?? "could not mark the consent prompt as sent");
    }
    return result;
  }

  async function handleBridgeCommand(command) {
    if (command?.type !== "prompt_consent") return;
    await broadcastConsentMessage();
    try {
      ui.notifications.info("TableRecords: recording consent notice sent to players.");
    } catch {
      // optional
    }
  }

  let commandPollTimer = null;
  let commandPolling = false;
  async function pollCommands() {
    if (commandPolling || !game.user?.isGM || !setting("enabled")) return;
    const base = bridgeBase();
    const token = String(setting("bridgeToken") || "").trim();
    if (!base || !token) return;
    commandPolling = true;
    try {
      const response = await fetch(`${base}/api/foundry/commands`, {
        method: "GET",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: { "x-tablerecords-token": token }
      });
      if (!response.ok) return;
      const body = await response.json();
      for (const command of body?.commands ?? []) await handleBridgeCommand(command);
    } catch {
      // The heartbeat already reports connection problems; polling stays quiet.
    } finally {
      commandPolling = false;
    }
  }

  function startCommandPolling() {
    if (commandPollTimer) return;
    commandPollTimer = setInterval(() => void pollCommands(), 3000);
    setTimeout(() => void pollCommands(), 900);
  }

  function installConsentHooks() {
    Hooks.on("createChatMessage", (message) => {
      const flags = message?.flags?.[MODULE_ID];
      if (!flags) return;
      if (flags.consentPrompt && !game.user?.isGM) {
        openConsentDialog({ force: true });
        return;
      }
      if (flags.consentResponse && game.user?.isGM) {
        void forwardConsentResponse(flags.consentResponse);
      }
    });
  }

  function scanStoredConsentResponses() {
    const messages = game.messages?.contents ?? [];
    for (const message of messages.slice(-100)) {
      const flags = message?.flags?.[MODULE_ID];
      if (!flags?.consentResponse || flags.consentForwarded) continue;
      void forwardConsentResponse(flags.consentResponse).then((result) => {
        if (result?.ok && typeof message.update === "function") {
          void message.update({ [`flags.${MODULE_ID}.consentForwarded`]: true });
        }
      });
    }
  }

  function readDialogValue(html) {
    try {
      if (html && typeof html.querySelector === "function") {
        return html.querySelector("textarea[name='note']")?.value ?? "";
      }
      if (html && typeof html.find === "function") {
        return html.find("textarea[name='note']").val() ?? "";
      }
    } catch {
      // fall through
    }
    return "";
  }

  function openMentalNote() {
    if (!setting("enabled")) {
      warn("enable the bridge in TableRecords module settings first.", true);
      return;
    }
    const content = `
      <form>
        <p class="notes">A GM mental note is saved to the active session with the current timestamp.</p>
        <textarea name="note" rows="4" style="width:100%;box-sizing:border-box" placeholder="Remember the hidden door, the NPC name, a ruling..."></textarea>
      </form>`;
    const DialogV2 = globalThis.foundry?.applications?.api?.DialogV2;
    if (DialogV2?.prompt) {
      void DialogV2.prompt({
        window: { title: "TableRecords mental note" },
        content,
        ok: {
          label: "Save note",
          callback: (event, button) => {
            const form = button?.form ?? button?.closest?.("form") ?? globalThis.document?.querySelector?.("dialog form");
            const value = form?.elements?.note?.value ?? form?.querySelector?.("textarea[name='note']")?.value ?? "";
            return sendMentalNote(value);
          }
        },
        rejectClose: false
      }).catch((error) => warn(String(error?.message ?? error), true));
      return;
    }
    const DialogClass = globalThis.Dialog;
    if (typeof DialogClass !== "function") {
      warn("this Foundry version does not expose a supported dialog API; use the module's sendMentalNote() API.", true);
      return;
    }
    new DialogClass({
      title: "TableRecords mental note",
      content,
      buttons: {
        save: {
          icon: '<i class="fas fa-save"></i>',
          label: "Save note",
          callback: (html) => void sendMentalNote(readDialogValue(html))
        },
        cancel: { icon: '<i class="fas fa-times"></i>', label: "Cancel" }
      },
      default: "save",
      close: () => undefined
    }).render(true);
  }

  function startHeartbeat() {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    const seconds = Math.max(10, Math.min(120, Number(setting("heartbeatSeconds")) || 30));
    heartbeatTimer = setInterval(() => sendState(0), seconds * 1000);
    sendState(0);
  }

  const PLAYER_POST_LABELS = {
    recap: "AI-assisted recap",
    names: "AI-assisted names list",
    clues: "AI-assisted clues list"
  };
  let gmToolsOverlay = null;
  let activeDraft = null;

  async function requestRecordingControl(action) {
    const base = bridgeBase();
    const token = String(setting("bridgeToken") || "").trim();
    if (!base || !token) {
      return { ok: false, reason: "not_configured", message: "Set the dashboard address and bridge token first." };
    }
    try {
      const response = await fetch(`${base}/api/foundry/control`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-tablerecords-token": token
        },
        body: JSON.stringify({
          action,
          sessionId: String(setting("sessionId") || "").trim() || undefined,
          promptPlayers: true
        })
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!response.ok) {
        return {
          ok: false,
          state: body?.capture?.state ?? null,
          message: body?.error?.message ?? body?.message ?? "The recording command failed."
        };
      }
      return {
        ok: true,
        state: body?.state ?? body?.capture?.state ?? null,
        sessionId: body?.sessionId ?? body?.session?.currentId ?? null
      };
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : "The dashboard did not answer."
      };
    }
  }

  async function requestPlayerDraft(kind, windowSeconds) {
    const base = bridgeBase();
    const token = String(setting("bridgeToken") || "").trim();
    if (!base || !token) {
      return {
        ok: false,
        reason: "not_configured",
        message: "Set the dashboard address and bridge token in the TableRecords module settings."
      };
    }
    const controller = typeof AbortController === "function" ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), 180_000) : null;
    try {
      const response = await fetch(`${base}/api/foundry/player-drafts`, {
        method: "POST",
        mode: "cors",
        credentials: "omit",
        cache: "no-store",
        headers: {
          "content-type": "application/json",
          "x-tablerecords-token": token
        },
        body: JSON.stringify({
          schema: "tablerecords.player-draft-request/v1",
          world: worldPayload(),
          sessionId: String(setting("sessionId") || "").trim() || undefined,
          kind,
          windowSeconds
        }),
        signal: controller ? controller.signal : undefined
      });
      const text = await response.text();
      let body = null;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = null;
      }
      if (!response.ok) {
        return {
          ok: false,
          status: response.status,
          reason: body?.error?.code ?? "http_error",
          message: body?.error?.message ?? `${response.status} ${response.statusText}`
        };
      }
      return { ok: true, draft: body };
    } catch (error) {
      return {
        ok: false,
        status: 0,
        reason: error?.name === "AbortError" ? "timeout" : "network_error",
        message:
          error?.name === "AbortError"
            ? "The dashboard did not answer within three minutes. Check that the model is running."
            : String(error?.message ?? error)
      };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async function publishPlayerPost(draft, text) {
    if (!game.user?.isGM) {
      return { ok: false, reason: "not_gm", message: "Only the GM can post TableRecords recaps." };
    }
    const ChatMessageClass = globalThis.ChatMessage;
    if (!ChatMessageClass?.create || !draft) {
      return { ok: false, reason: "chat_unavailable", message: "Foundry chat is not available." };
    }
    const cleaned = String(text || "").trim();
    if (!cleaned) {
      return { ok: false, reason: "empty", message: "Write something before posting." };
    }
    const label = PLAYER_POST_LABELS[draft.kind] ?? "AI-assisted notes";
    const body = escapeHtml(cleaned)
      .replace(/\n/g, "<br>")
      .replace(/@/g, "@\u200B")
      .replace(/\[\[/g, "[\u200B[");
    try {
      await ChatMessageClass.create({
        content: `<div class="tr-player-post"><p class="tr-player-post-label"><em>${label}, reviewed by the GM.</em></p><div>${body}</div></div>`,
        speaker: { alias: "TableRecords" },
        flags: {
          [MODULE_ID]: {
            playerPost: true,
            draftId: draft.draftId,
            kind: draft.kind,
            windowStartMs: draft.window?.startMs ?? null,
            windowEndMs: draft.window?.endMs ?? null
          }
        }
      });
      return { ok: true };
    } catch (error) {
      return { ok: false, reason: "chat_failed", message: String(error?.message ?? error) };
    }
  }

  function closeGmTools() {
    if (gmToolsOverlay) {
      gmToolsOverlay.remove();
      gmToolsOverlay = null;
    }
    activeDraft = null;
  }

  function openGmTools() {
    if (!game.user?.isGM) return;
    if (gmToolsOverlay) return;
    const overlay = document.createElement("div");
    overlay.className = "tr-gm-overlay";
    overlay.innerHTML = `
      <div class="tr-gm-panel" role="dialog" aria-modal="true" aria-labelledby="tr-gm-title">
        <div class="tr-gm-head">
          <div>
            <h2 id="tr-gm-title">TableRecords GM tools</h2>
            <p class="tr-gm-muted">Draft player-facing text from the last few minutes. Nothing is posted until you review it.</p>
          </div>
          <button type="button" class="tr-gm-close" aria-label="Close TableRecords GM tools" title="Close">
            <i class="fa-solid fa-xmark" aria-hidden="true"></i>
          </button>
        </div>
        <label class="tr-gm-field">Window
          <select class="tr-gm-window">
            <option value="180">Last 3 minutes</option>
            <option value="300">Last 5 minutes</option>
            <option value="900">Last 15 minutes</option>
          </select>
        </label>
        <div class="tr-gm-transport" role="group" aria-label="Recording controls">
          <span class="tr-gm-capture-state" role="status">Checking recording…</span>
          <div class="tr-gm-transport-buttons">
            <button type="button" data-tr-control="start" aria-label="Start recording" title="Start recording" data-tooltip="Start recording">
              <i class="fa-solid fa-play" aria-hidden="true"></i>
              <span class="tr-visually-hidden">Start recording</span>
            </button>
            <button type="button" data-tr-control="pause" aria-label="Pause recording" title="Pause recording" data-tooltip="Pause recording">
              <i class="fa-solid fa-pause" aria-hidden="true"></i>
              <span class="tr-visually-hidden">Pause recording</span>
            </button>
            <button type="button" data-tr-control="stop" aria-label="Stop recording" title="Stop recording" data-tooltip="Stop recording">
              <i class="fa-solid fa-stop" aria-hidden="true"></i>
              <span class="tr-visually-hidden">Stop recording</span>
            </button>
          </div>
        </div>
        <div class="tr-gm-actions" role="group" aria-label="Draft type">
          <button type="button" data-tr-kind="recap" aria-label="Recap" title="Recap" data-tooltip="Recap">
            <i class="fa-solid fa-scroll" aria-hidden="true"></i>
            <span class="tr-visually-hidden">Recap</span>
          </button>
          <button type="button" data-tr-kind="names" aria-label="Important names" title="Important names" data-tooltip="Important names">
            <i class="fa-solid fa-users" aria-hidden="true"></i>
            <span class="tr-visually-hidden">Important names</span>
          </button>
          <button type="button" data-tr-kind="clues" aria-label="Clues mentioned" title="Clues mentioned" data-tooltip="Clues mentioned">
            <i class="fa-solid fa-magnifying-glass" aria-hidden="true"></i>
            <span class="tr-visually-hidden">Clues mentioned</span>
          </button>
        </div>
        <p class="tr-gm-status" role="status"></p>
        <div class="tr-gm-preview" hidden>
          <div class="tr-gm-preview-head">
            <strong class="tr-gm-preview-title"></strong>
            <span class="tr-gm-preview-meta"></span>
          </div>
          <p class="tr-gm-warning"></p>
          <textarea class="tr-gm-text" rows="14" aria-label="Player post text"></textarea>
          <div class="tr-gm-publish-row">
            <button type="button" class="tr-gm-post"><i class="fa-solid fa-comment-dots" aria-hidden="true"></i> Post to players</button>
            <button type="button" class="tr-gm-regenerate"><i class="fa-solid fa-rotate" aria-hidden="true"></i> Regenerate</button>
            <button type="button" class="tr-gm-discard"><i class="fa-solid fa-trash-can" aria-hidden="true"></i> Discard</button>
          </div>
        </div>
      </div>`;
    document.body.append(overlay);
    gmToolsOverlay = overlay;

    const panel = overlay.querySelector(".tr-gm-panel");
    const status = overlay.querySelector(".tr-gm-status");
    const preview = overlay.querySelector(".tr-gm-preview");
    const title = overlay.querySelector(".tr-gm-preview-title");
    const meta = overlay.querySelector(".tr-gm-preview-meta");
    const warning = overlay.querySelector(".tr-gm-warning");
    const textarea = overlay.querySelector(".tr-gm-text");
    const windowSelect = overlay.querySelector(".tr-gm-window");
    const actionButtons = [...overlay.querySelectorAll("[data-tr-kind]")];
    const publishButton = overlay.querySelector(".tr-gm-post");
    const regenerateButton = overlay.querySelector(".tr-gm-regenerate");
    const discardButton = overlay.querySelector(".tr-gm-discard");
    const transportState = overlay.querySelector(".tr-gm-capture-state");
    const transportButtons = [...overlay.querySelectorAll("[data-tr-control]")];
    let lastKind = "recap";
    let edited = false;
    let captureState = "unknown";
    let transportBusy = false;

    const setTransportState = (next) => {
      captureState = next || "unknown";
      const paused = captureState === "paused";
      const active = captureState === "recording" || paused;
      const pauseButton = overlay.querySelector('[data-tr-control="pause"]');
      const startButton = overlay.querySelector('[data-tr-control="start"]');
      const stopButton = overlay.querySelector('[data-tr-control="stop"]');
      pauseButton.innerHTML = paused
        ? '<i class="fa-solid fa-play" aria-hidden="true"></i><span class="tr-visually-hidden">Resume recording</span>'
        : '<i class="fa-solid fa-pause" aria-hidden="true"></i><span class="tr-visually-hidden">Pause recording</span>';
      pauseButton.setAttribute("aria-label", paused ? "Resume recording" : "Pause recording");
      pauseButton.title = paused ? "Resume recording" : "Pause recording";
      pauseButton.dataset.tooltip = pauseButton.title;
      startButton.disabled = transportBusy || active || captureState === "stopping";
      pauseButton.disabled = transportBusy || !(active || captureState === "unknown");
      stopButton.disabled = transportBusy || !(active || captureState === "unknown");
      transportState.textContent = transportBusy
        ? "Sending command…"
        : captureState === "recording"
          ? "Recording"
          : paused
            ? "Recording paused"
            : captureState === "stopping"
              ? "Saving recording"
              : captureState === "unknown"
                ? "Recording state unavailable"
                : "Not recording";
    };

    const sendTransport = async (action) => {
      if (transportBusy) return;
      transportBusy = true;
      setTransportState(captureState);
      const result = await requestRecordingControl(action);
      transportBusy = false;
      if (result.ok) {
        setTransportState(result.state || (action === "pause" ? "paused" : action === "stop" ? "idle" : "recording"));
        status.textContent = action === "start"
          ? "Recording started."
          : action === "pause"
            ? "Recording paused."
            : action === "resume"
              ? "Recording resumed."
              : "Recording stopped and saved.";
        status.className = "tr-gm-status";
      } else {
        setTransportState(result.state || captureState);
        status.textContent = result.message || "The recording command failed.";
        status.className = "tr-gm-status tr-gm-error";
      }
    };

    for (const button of transportButtons) {
      button.addEventListener("click", () => {
        const action = button.dataset.trControl;
        void sendTransport(action === "pause" && captureState === "paused" ? "resume" : action);
      });
    }
    void requestRecordingControl("status").then((result) => {
      if (result.ok) setTransportState(result.state || "unknown");
      else setTransportState("unknown");
    });

    const setBusy = (message) => {
      status.textContent = message;
      for (const button of [...actionButtons, publishButton, regenerateButton]) button.disabled = Boolean(message);
    };
    const showError = (message) => {
      status.textContent = message;
      status.className = "tr-gm-status tr-gm-error";
      for (const button of actionButtons) button.disabled = false;
      publishButton.disabled = !activeDraft;
      regenerateButton.disabled = !activeDraft;
    };
    const showDraft = (draft) => {
      activeDraft = draft;
      edited = false;
      const windowLabel = draft.window?.label ?? "recent window";
      title.textContent = draft.label;
      meta.textContent = `${windowLabel} · ${draft.provider} · ${draft.model}`;
      warning.textContent = (draft.warnings ?? []).join(" ");
      warning.hidden = !warning.textContent;
      textarea.value = draft.text;
      preview.hidden = false;
      for (const button of actionButtons) button.disabled = false;
      publishButton.disabled = false;
      regenerateButton.disabled = false;
      status.textContent = "Review the draft, edit it, then post.";
      status.className = "tr-gm-status";
    };
    const generate = async (kind) => {
      lastKind = kind;
      const seconds = Number(windowSelect.value) || 180;
      if (edited && !window.confirm("Replace your edits with a new draft?")) return;
      setBusy("Generating a draft on the local model. This can take up to a minute.");
      const result = await requestPlayerDraft(kind, seconds);
      if (!result.ok) {
        showError(result.message || "The draft could not be generated.");
        return;
      }
      showDraft(result.draft);
    };

    for (const button of actionButtons) {
      button.addEventListener("click", () => void generate(button.dataset.trKind));
    }
    textarea.addEventListener("input", () => {
      edited = true;
      publishButton.disabled = textarea.value.trim().length === 0;
    });
    regenerateButton.addEventListener("click", () => void generate(lastKind));
    discardButton.addEventListener("click", () => {
      activeDraft = null;
      preview.hidden = true;
      status.textContent = "Draft discarded. Nothing was posted.";
      status.className = "tr-gm-status";
    });
    publishButton.addEventListener("click", async () => {
      if (!activeDraft) return;
      publishButton.disabled = true;
      status.textContent = "Posting the reviewed text to players…";
      status.className = "tr-gm-status";
      const result = await publishPlayerPost(activeDraft, textarea.value);
      if (!result.ok) {
        showError(result.message || "The post could not be created.");
        publishButton.disabled = false;
        return;
      }
      try {
        ui.notifications.info("TableRecords posted the reviewed text to players.");
      } catch {
        // Optional notification.
      }
      closeGmTools();
    });
    overlay.querySelector(".tr-gm-close").addEventListener("click", closeGmTools);
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) closeGmTools();
    });
    panel.addEventListener("keydown", (event) => {
      if (event.key === "Escape") closeGmTools();
    });
    textarea.focus();
  }

  function installGmToolsButton() {
    if (!game.user?.isGM || typeof document === "undefined") return;
    if (document.querySelector(".tr-gm-tools-launch")) return;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "tr-gm-tools-launch";
    button.setAttribute("aria-label", "TableRecords GM tools");
    button.title = "TableRecords GM tools";
    button.dataset.tooltip = "TableRecords GM tools";
    button.innerHTML = '<i class="fa-solid fa-book-open" aria-hidden="true"></i><span class="tr-visually-hidden">TableRecords GM tools</span>';
    button.addEventListener("click", () => {
      if (!bridgeConfigured()) {
        void openSetupWizard();
        return;
      }
      openGmTools();
    });
    const controls = document.querySelector("#chat-controls");
    if (controls) {
      controls.prepend(button);
      return;
    }
    button.classList.add("tr-gm-tools-floating");
    document.body.append(button);
  }

  function installBridgeHooks() {
    Hooks.on("createChatMessage", (message) => {
      if (!game.user?.isGM) return;
      const flags = message?.flags?.[MODULE_ID];
      if (flags?.consentPrompt || flags?.consentResponse || flags?.playerPost) return;
      enqueue(message);
    });
    for (const hook of [
      "canvasReady",
      "updateScene",
      "createCombat",
      "updateCombat",
      "deleteCombat",
      "pauseGame",
      "updateUser",
      "createActor",
      "updateActor",
      "deleteActor"
    ]) {
      Hooks.on(hook, () => sendState(500));
    }
    Hooks.on("updateSetting", (settingValue) => {
      if (settingValue?.key?.startsWith(`${MODULE_ID}.`)) {
        startHeartbeat();
        scheduleFlush(500);
        if (settingValue.key === `${MODULE_ID}.followBreakTime` || settingValue.key === `${MODULE_ID}.enabled`) {
          syncBreakTimeState();
        }
      }
      if (settingValue?.key === "breaktime.paused") {
        handleBreakTimePause(settingValue.value === true || settingValue.value === "true");
      }
    });
  }

  function registerSettings() {
    game.settings.register(MODULE_ID, "dashboardUrl", {
      name: "TableRecords dashboard URL",
      hint: "Loopback URL of the local dashboard, for example http://127.0.0.1:17300.",
      scope: "world",
      config: true,
      type: String,
      default: DEFAULTS.dashboardUrl
    });
    game.settings.register(MODULE_ID, "bridgeToken", {
      name: "Bridge token",
      hint: "Copy this from TableRecords → Setup → Foundry live bridge. Stored in world settings.",
      scope: "world",
      config: true,
      type: String,
      default: ""
    });
    game.settings.register(MODULE_ID, "sessionId", {
      name: "Session ID (optional)",
      hint: "Leave blank to follow whichever session is recording. Paste a session ID here to target a specific finalized session.",
      scope: "world",
      config: true,
      type: String,
      default: ""
    });
    game.settings.register(MODULE_ID, "enabled", {
      name: "Enable live bridge",
      hint: "The GM client pushes new chat and rolls to the local dashboard.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MODULE_ID, "pushChat", {
      name: "Push chat messages",
      hint: "Include ordinary Foundry chat messages, not just rolls.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MODULE_ID, "pushRolls", {
      name: "Push rolls",
      hint: "Include roll messages and their prepared roll JSON.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MODULE_ID, "publishRoster", {
      name: "Publish player/character directory",
      hint: "Send Foundry user names and player-owned character names to the local dashboard for People-tab dropdowns.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MODULE_ID, "promptConsent", {
      name: "Prompt players for recording consent",
      hint: "Players see a local notice and can opt out. Consent is assumed unless they opt out. The GM can re-open it with game.tableRecords.promptConsent().",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MODULE_ID, "followBreakTime", {
      name: "Follow Break Time breaks",
      hint: "When the Break Time module starts or ends a break, add a break marker to the active TableRecords session. Leave this on unless you use a different break timer.",
      scope: "world",
      config: true,
      type: Boolean,
      default: true
    });
    game.settings.register(MODULE_ID, "setupSeen", {
      scope: "world",
      config: false,
      type: Boolean,
      default: false
    });
    game.settings.register(MODULE_ID, "setupComplete", {
      scope: "world",
      config: false,
      type: Boolean,
      default: false
    });
    game.settings.register(MODULE_ID, "heartbeatSeconds", {
      name: "Heartbeat seconds",
      hint: "How often scene, combat, and connection state are sent while Foundry is open.",
      scope: "world",
      config: true,
      type: Number,
      range: { min: 10, max: 120, step: 5 },
      default: 30
    });
    registerSetupMenu();
  }

  Hooks.once("init", () => {
    registerSettings();
    log(`initialising v${VERSION}`);
  });

  Hooks.once("ready", () => {
    installConsentHooks();
    if (!game.user?.isGM) {
      if (setting("promptConsent") !== false) {
        setTimeout(() => openConsentDialog(), 1200);
      }
      game.tableRecords = {
        version: VERSION,
        openConsentDialog: () => openConsentDialog({ force: true }),
        consentVersion: CONSENT_VERSION
      };
      log("player client: consent prompt enabled; live bridge inactive");
      return;
    }
    installBridgeHooks();
    installGmToolsButton();
    startHeartbeat();
    syncBreakTimeState();
    startCommandPolling();
    setTimeout(() => scanStoredConsentResponses(), 2500);
    if (!String(setting("bridgeToken") || "").trim()) {
      if (setting("setupSeen") !== true) void promptSetupIfNeeded();
      else warn("set the bridge token in Module Settings to connect.", true);
    } else {
      void promptSetupIfNeeded();
      log("GM bridge active", setting("dashboardUrl"));
    }
    try {
      game.keybindings.register(MODULE_ID, "mentalNote", {
        name: "TableRecords mental note",
        hint: "Open a mental-note prompt for the active session.",
        editable: [{ key: "KeyM", modifiers: ["Alt"] }],
        restricted: true,
        onDown: () => {
          openMentalNote();
          return true;
        }
      });
    } catch {
      // Older Foundry versions may not expose keybindings; the macro still works.
    }
    game.tableRecords = {
      version: VERSION,
      status: () => lastResult,
      reason: () => lastReason,
      queueStatus: () => ({ pending: queue.length, flushing, lastResult, lastReason }),
      flush: () => flush(true),
      sendMentalNote,
      openMentalNote,
      openSetup: () => openSetupWizard(),
      breakState: () => ({ active: breakMarkerActive, startedAtMs: breakMarkerStartedAtMs }),
      promptConsent: promptAllPlayers,
      openConsentDialog: () => openConsentDialog({ force: true }),
      openGmTools,
      generatePlayerDraft: requestPlayerDraft,
      publishPlayerPost
    };
  });
})();
