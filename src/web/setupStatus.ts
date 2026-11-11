import type { Guild, SettingsPayload, Status, World } from "./types";
import { sttStateLabel } from "./format";
import { FOUNDRY_CONSENT_COMMAND_VERSION, versionAtLeast } from "../core/version.js";

/** View Channel + Connect + Speak. The bot does not need message permissions. */
export const DISCORD_BOT_PERMISSIONS = 3_146_752;
export const DISCORD_DEVELOPER_PORTAL = "https://discord.com/developers/applications";

export function botInviteUrl(clientId: string | null): string | null {
  if (!clientId || !/^\d{17,20}$/.test(clientId)) return null;
  return `https://discord.com/oauth2/authorize?client_id=${clientId}&scope=bot&permissions=${DISCORD_BOT_PERMISSIONS}`;
}

export type SetupAction = "portal" | "invite" | "record" | "audio" | "ai" | "foundry" | "module" | "recheck" | "none";

export interface SetupStep {
  id: "token" | "invite" | "audio" | "foundry" | "module" | "speech" | "ai";
  title: string;
  detail: string;
  done: boolean;
  optional?: boolean;
  action: SetupAction;
}

export function buildSetupSteps(input: {
  settings: SettingsPayload | null;
  status: Status | null;
  guilds: Guild[];
  worlds: World[];
  captureTestPassed: boolean;
}): SetupStep[] {
  const { settings, status, guilds, worlds, captureTestPassed } = input;
  const token = Boolean(settings?.env.discordTokenConfigured);
  const botReady = status?.bot.state === "ready";
  const engine = status?.stt.engine === "parakeet" ? "Parrot" : "Whisper";
  const speechReady = status?.stt.state === "ready";
  const moduleVersion = settings?.foundryBridge.status.moduleVersion;
  const moduleConnected = Boolean(settings?.foundryBridge.status.connected);
  const moduleReady = moduleConnected && versionAtLeast(moduleVersion, FOUNDRY_CONSENT_COMMAND_VERSION);
  const llm = settings?.llm;
  const llmReady = Boolean(llm?.enabled && llm.configured);
  const llmProvider = llm?.provider === "deepseek" ? "DeepSeek cloud" : llm?.provider === "ollama" ? "Ollama" : llm?.provider === "llamacpp" ? "llama.cpp" : "a local server";
  return [
    {
      id: "token",
      title: "Discord bot token",
      detail: token ? "Token found in .env." : "Create a bot and put DISCORD_TOKEN in .env.",
      done: token,
      action: token ? "none" : "portal"
    },
    {
      id: "invite",
      title: "Bot invited to your server",
      detail:
        guilds.length > 0
          ? `Visible in ${guilds.length} ${guilds.length === 1 ? "server" : "servers"}.`
          : "Use the invite link, then pick the server and voice channel.",
      done: botReady && guilds.length > 0,
      action: "invite"
    },
    {
      id: "audio",
      title: "Audio test",
      detail: captureTestPassed
        ? "Audio test is complete."
        : "Run the guided test; the bot joins your voice channel and checks for speech.",
      done: captureTestPassed,
      action: "audio"
    },
    {
      id: "speech",
      title: "Speech to text",
      detail: speechReady ? `${engine} is ready.` : `${engine} is not ready: ${sttStateLabel(status?.stt.state)}.`,
      done: speechReady,
      action: "recheck"
    },
    {
      id: "ai",
      title: "AI summaries",
      detail: !llm?.enabled
        ? "Optional. Turn it on when you want recaps; sessions and audio stay local."
        : llmReady
          ? `${llmProvider} is configured with ${llm.model ?? "its default model"}.`
          : "Enabled, but no model is selected yet.",
      done: llmReady,
      optional: true,
      action: "ai"
    },
    {
      id: "foundry",
      title: "Foundry folder",
      detail:
        worlds.length > 0
          ? `${worlds.length} ${worlds.length === 1 ? "world" : "worlds"} found.`
          : "Point TableRecords at your Foundry data folder.",
      done: worlds.length > 0,
      optional: true,
      action: "foundry"
    },
    {
      id: "module",
      title: "Foundry bridge",
      detail: moduleReady
        ? `Connected${moduleVersion ? ` (module ${moduleVersion})` : ""}.`
        : moduleConnected
          ? `Module ${moduleVersion ?? "unknown"} is out of date; refresh Foundry after installing ${FOUNDRY_CONSENT_COMMAND_VERSION}.`
          : "We recommend the bridge for live rolls and scenes. The macro is a lighter option.",
      done: moduleReady,
      optional: true,
      action: "module"
    }
  ];
}

export function setupProgress(steps: SetupStep[]): { done: number; total: number } {
  const required = steps.filter((step) => !step.optional);
  return { done: required.filter((step) => step.done).length, total: required.length };
}
