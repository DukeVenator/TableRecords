import { EventEmitter } from "node:events";
import {
  ActivityType,
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  PermissionFlagsBits,
  type Guild,
  type VoiceBasedChannel
} from "discord.js";
import {
  VoiceConnectionStatus,
  entersState,
  joinVoiceChannel,
  type VoiceConnection
} from "@discordjs/voice";
import type { AppConfig } from "./config.js";

export type BotState = "not_configured" | "connecting" | "ready" | "error" | "offline";

export interface BotStatus {
  configured: boolean;
  state: BotState;
  userId: string | null;
  username: string | null;
  displayName: string | null;
  activity: string | null;
  gatewayPingMs: number | null;
  error: string | null;
}

export interface ActivityContext {
  recording: boolean;
  testing: boolean;
  processing: boolean;
  title: string | null;
  channel: string | null;
}

export interface VoiceStatus {
  state: "disconnected" | "connecting" | "ready" | "error";
  guildId: string | null;
  guildName: string | null;
  channelId: string | null;
  channelName: string | null;
  privacyCode: string | null;
  daveEnabled: boolean;
  error: string | null;
}

export interface VoiceChannelInfo {
  id: string;
  name: string;
  parentName: string | null;
  memberCount: number;
  userLimit: number;
  permissions: { viewChannel: boolean; connect: boolean; speak: boolean };
}

export interface GuildInfo {
  id: string;
  name: string;
}

export interface VoiceMemberInfo {
  userId: string;
  displayName: string;
  username: string;
  isBot: boolean;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export class DiscordService extends EventEmitter {
  readonly config: AppConfig;
  private client: Client | null = null;
  private connection: VoiceConnection | null = null;
  private currentGuild: { id: string; name: string } | null = null;
  private currentChannel: { id: string; name: string } | null = null;
  private botState: BotState = "not_configured";
  private botError: string | null = null;
  private voiceError: string | null = null;
  private starting: Promise<void> | null = null;
  private activityContext: ActivityContext = {
    recording: false,
    testing: false,
    processing: false,
    title: null,
    channel: null
  };
  private lastActivityKey: string | null = null;

  constructor(config: AppConfig) {
    super();
    this.config = config;
  }

  get configured(): boolean {
    return Boolean(this.config.discordToken);
  }

  get clientReady(): boolean {
    return this.botState === "ready" && this.client?.isReady() === true;
  }

  get voiceConnection(): VoiceConnection | null {
    return this.connection;
  }

  /** Update the bot presence from recorder/job/voice state. Cheap when unchanged. */
  updateActivityContext(context: Partial<ActivityContext>): void {
    this.activityContext = { ...this.activityContext, ...context };
    this.applyActivity();
  }

  /** Re-apply nickname and activity after settings change or login. */
  async refreshPresence(): Promise<void> {
    await this.applyNickname();
    this.lastActivityKey = null;
    this.applyActivity();
  }

  private activityText(): string {
    const base = this.config.discordActivityText.trim();
    if (!this.config.discordActivityDynamic) return base;
    if (this.activityContext.testing) return "the microphone";
    if (this.activityContext.recording) {
      return this.activityContext.title ? `“${this.activityContext.title}”` : "every adventure";
    }
    if (this.activityContext.processing) return "the notes being written";
    if (this.activityContext.channel) return this.activityContext.channel;
    return base;
  }

  private applyActivity(): void {
    const user = this.client?.user;
    if (!this.client?.isReady() || !user) return;
    const name = this.activityText();
    if (!name) {
      if (this.lastActivityKey !== "none") {
        this.lastActivityKey = "none";
        user.setPresence({ activities: [], status: "online" });
      }
      return;
    }
    const type =
      this.config.discordActivityType === "listening"
        ? ActivityType.Listening
        : this.config.discordActivityType === "watching"
          ? ActivityType.Watching
          : this.config.discordActivityType === "competing"
            ? ActivityType.Competing
            : ActivityType.Playing;
    const key = `${type}:${name.slice(0, 128)}`;
    if (key === this.lastActivityKey) return;
    this.lastActivityKey = key;
    user.setPresence({
      status: "online",
      activities: [{ name: name.slice(0, 128), type }]
    });
  }

  private async applyNickname(): Promise<void> {
    const name = this.config.discordBotName.trim().slice(0, 32);
    if (!name || !this.client?.isReady()) return;
    await Promise.all(
      [...this.client.guilds.cache.values()].map(async (guild) => {
        const me = guild.members.me;
        if (!me || me.nickname === name) return;
        await me.setNickname(name).catch((error: unknown) => {
          console.warn(`[discord] could not set nickname in ${guild.name}: ${errorMessage(error)}`);
        });
      })
    );
  }

  async start(): Promise<void> {
    if (!this.config.discordToken) {
      this.botState = "not_configured";
      this.botError = "DISCORD_TOKEN is not configured in .env";
      this.emit("status");
      return;
    }
    if (this.starting) return this.starting;
    this.starting = this.startInternal();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  private async startInternal(): Promise<void> {
    this.botState = "connecting";
    this.botError = null;
    this.emit("status");
    const client = new Client({
      intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates]
    });
    this.client = client;
    client.on(Events.Error, (error) => {
      this.botError = errorMessage(error);
      this.emit("status");
    });
    client.on(Events.Warn, (message) => {
      console.warn(`[discord] ${message}`);
    });
    client.on(Events.VoiceStateUpdate, () => this.emit("voiceState"));
    client.on(Events.ClientReady, () => {
      this.botState = "ready";
      this.botError = null;
      this.emit("status");
      console.log(`[discord] logged in as ${client.user?.tag ?? "unknown"}`);
      void this.refreshPresence().catch((error: unknown) => {
        console.warn(`[discord] could not apply presence: ${errorMessage(error)}`);
      });
    });
    try {
      await client.login(this.config.discordToken!);
      await new Promise<void>((resolve) => {
        if (client.isReady()) {
          resolve();
          return;
        }
        const timer = setTimeout(resolve, 20_000);
        timer.unref?.();
        client.once(Events.ClientReady, () => {
          clearTimeout(timer);
          resolve();
        });
      });
      if (!client.isReady()) {
        this.botState = "error";
        this.botError = "Discord client did not become ready within 20 seconds.";
      }
    } catch (error) {
      this.botState = "error";
      this.botError = errorMessage(error);
      try {
        client.destroy();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.emit("status");
  }

  async stop(): Promise<void> {
    this.leave();
    if (this.client) {
      try {
        this.client.destroy();
      } catch {
        // ignore
      }
      this.client = null;
    }
    this.botState = this.configured ? "offline" : "not_configured";
    this.emit("status");
  }

  botStatus(): BotStatus {
    return {
      configured: this.configured,
      state: this.botState,
      userId: this.client?.user?.id ?? null,
      username: this.client?.user?.username ?? null,
      displayName: this.client?.isReady() ? this.config.discordBotName : null,
      activity: this.client?.isReady() ? this.activityText() || null : null,
      gatewayPingMs: this.client?.ws.ping ?? null,
      error: this.botError
    };
  }

  voiceStatus(): VoiceStatus {
    let state: VoiceStatus["state"] = "disconnected";
    if (this.connection) {
      switch (this.connection.state.status) {
        case VoiceConnectionStatus.Ready:
          state = "ready";
          break;
        case VoiceConnectionStatus.Connecting:
        case VoiceConnectionStatus.Signalling:
          state = "connecting";
          break;
        case VoiceConnectionStatus.Disconnected:
          state = "error";
          break;
        case VoiceConnectionStatus.Destroyed:
          state = "disconnected";
          break;
      }
    }
    let privacyCode: string | null = null;
    if (this.connection?.state.status === VoiceConnectionStatus.Ready) {
      try {
        privacyCode = this.connection.voicePrivacyCode ?? null;
      } catch {
        privacyCode = null;
      }
    }
    return {
      state,
      guildId: this.currentGuild?.id ?? null,
      guildName: this.currentGuild?.name ?? null,
      channelId: this.currentChannel?.id ?? null,
      channelName: this.currentChannel?.name ?? null,
      privacyCode,
      daveEnabled: Boolean(privacyCode),
      error: this.voiceError
    };
  }

  async listGuilds(): Promise<GuildInfo[]> {
    if (!this.client?.isReady()) return [];
    const cached = [...this.client.guilds.cache.values()].map((guild) => ({ id: guild.id, name: guild.name }));
    if (cached.length > 0) return cached.sort((a, b) => a.name.localeCompare(b.name));
    const fetched = await this.client.guilds.fetch();
    return [...fetched.values()].map((guild) => ({ id: guild.id, name: guild.name })).sort((a, b) => a.name.localeCompare(b.name));
  }

  private async getGuild(guildId: string): Promise<Guild> {
    if (!this.client?.isReady()) throw new Error("Discord bot is not ready; configure DISCORD_TOKEN and restart.");
    const guild = this.client.guilds.cache.get(guildId) ?? (await this.client.guilds.fetch(guildId).catch(() => null));
    if (!guild) throw new Error(`Guild not found or bot is not a member: ${guildId}`);
    if (!guild.members.me) await guild.members.fetchMe().catch(() => undefined);
    return guild;
  }

  async listVoiceChannels(guildId: string): Promise<VoiceChannelInfo[]> {
    const guild = await this.getGuild(guildId);
    const channels = await guild.channels.fetch();
    const me = guild.members.me;
    const out: VoiceChannelInfo[] = [];
    for (const channel of channels.values()) {
      if (!channel) continue;
      if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) continue;
      const permissions = me ? channel.permissionsFor(me) : null;
      out.push({
        id: channel.id,
        name: channel.name,
        parentName: channel.parent?.name ?? null,
        memberCount: channel.members.size,
        userLimit: "userLimit" in channel ? channel.userLimit : 0,
        permissions: {
          viewChannel: permissions?.has(PermissionFlagsBits.ViewChannel) ?? false,
          connect: permissions?.has(PermissionFlagsBits.Connect) ?? false,
          speak: permissions?.has(PermissionFlagsBits.Speak) ?? false
        }
      });
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
  }

  async listChannelMembers(channelId: string): Promise<VoiceMemberInfo[]> {
    if (!this.client?.isReady()) return [];
    for (const guild of this.client.guilds.cache.values()) {
      const channel = guild.channels.cache.get(channelId);
      if (!channel || !("members" in channel)) continue;
      const members: VoiceMemberInfo[] = [];
      for (const member of (channel as VoiceBasedChannel).members.values()) {
        members.push({
          userId: member.id,
          displayName: member.displayName,
          username: member.user.username,
          isBot: member.user.bot
        });
      }
      return members;
    }
    return [];
  }

  async memberName(userId: string): Promise<string> {
    if (!this.client?.isReady()) return userId;
    for (const guild of this.client.guilds.cache.values()) {
      const member = guild.members.cache.get(userId) ?? (await guild.members.fetch(userId).catch(() => null));
      if (member) return member.displayName || member.user.username;
    }
    const user = await this.client.users.fetch(userId).catch(() => null);
    return user ? user.globalName ?? user.username : userId;
  }

  async join(guildId: string, channelId: string): Promise<VoiceStatus> {
    const guild = await this.getGuild(guildId);
    const channel = await guild.channels.fetch(channelId).catch(() => null);
    if (!channel) throw new Error(`Voice channel not found: ${channelId}`);
    if (channel.type !== ChannelType.GuildVoice && channel.type !== ChannelType.GuildStageVoice) {
      throw new Error("Selected channel is not a voice channel");
    }
    const me = guild.members.me;
    const permissions = me ? channel.permissionsFor(me) : null;
    for (const [name, flag] of [
      ["View Channel", PermissionFlagsBits.ViewChannel],
      ["Connect", PermissionFlagsBits.Connect],
      ["Speak", PermissionFlagsBits.Speak]
    ] as const) {
      if (!permissions?.has(flag)) throw new Error(`Bot is missing the ${name} permission on ${channel.name}`);
    }

    if (this.connection && this.connection.state.status !== VoiceConnectionStatus.Destroyed) {
      if (this.currentChannel?.id === channelId && this.currentGuild?.id === guildId) return this.voiceStatus();
      this.leave();
    }

    this.voiceError = null;
    this.currentGuild = { id: guild.id, name: guild.name };
    this.currentChannel = { id: channel.id, name: channel.name };
    const connection = joinVoiceChannel({
      channelId: channel.id,
      guildId: guild.id,
      adapterCreator: guild.voiceAdapterCreator,
      selfDeaf: false,
      selfMute: true,
      debug: true
    });
    this.connection = connection;
    connection.on("error", (error) => {
      this.voiceError = errorMessage(error);
      this.emit("voice");
    });
    connection.on("debug", (message) => {
      if (/decrypt/i.test(message)) this.emit("decryptDebug", message);
    });
    const receiverDebug = connection.receiver as unknown as Partial<EventEmitter>;
    if (typeof receiverDebug.on === "function") {
      receiverDebug.on("debug", (message: string) => {
        if (/decrypt/i.test(message)) this.emit("decryptDebug", message);
      });
    }
    connection.on("stateChange", (_oldState, newState) => {
      if (newState.status === VoiceConnectionStatus.Ready) this.voiceError = null;
      this.emit("voice");
    });
    this.emit("voice");
    try {
      await entersState(connection, VoiceConnectionStatus.Ready, 25_000);
    } catch (error) {
      const message = `Voice connection did not become ready: ${errorMessage(error)}`;
      this.voiceError = message;
      this.emit("voice");
      this.leave();
      throw new Error(message);
    }
    return this.voiceStatus();
  }

  leave(): void {
    if (this.connection) {
      try {
        this.connection.destroy();
      } catch {
        // ignore
      }
    }
    this.connection = null;
    this.currentGuild = null;
    this.currentChannel = null;
    this.voiceError = null;
    this.emit("voice");
  }

  channelName(): string | null {
    return this.currentChannel?.name ?? null;
  }

  guildName(): string | null {
    return this.currentGuild?.name ?? null;
  }

  channelId(): string | null {
    return this.currentChannel?.id ?? null;
  }

  guildId(): string | null {
    return this.currentGuild?.id ?? null;
  }

  connectionReady(): boolean {
    return this.connection?.state.status === VoiceConnectionStatus.Ready;
  }
}
