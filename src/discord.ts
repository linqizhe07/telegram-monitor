// Reading Discord: every text or announcement channel the owner's bot can see becomes a source,
// like a Telegram group. New messages arrive through the gateway as they are posted; what was posted
// while the service was off (or before a channel was switched on, at most 24 hours back) is fetched
// over REST. Only reads: the bot asks Discord for nothing but servers, roles, channels and messages
// (src/discord-client.ts has no way to post).
//
// Announcement channels of other servers reach the owner's server by Discord's "Follow": their
// posts arrive in a channel of the owner's server, where the bot reads them like any message.
//
// A channel's place (`last_id`) is where its history is complete up to: catching up moves it, and a
// live message moves it only while nothing before it is missing. So a message that arrives while a
// channel waits to catch up is stored, and the catch-up still fetches what came before it.

import type { Activity } from './activity.ts';
import {
  DiscordError,
  DiscordGateway,
  DiscordRest,
  READABLE_TYPES,
  READ_PERMISSIONS,
  discordText,
  isTalk,
  newer,
  snowflakeAt,
  type DiscordCall,
  type DiscordChannel,
  type DiscordMessage,
  type DiscordUser,
  type GatewayState,
} from './discord-client.ts';
import type { ChatDefaults, ChatRow, DiscordChannelRow, Store, StoredMessage } from './store.ts';

const VIEW_CHANNEL = 1n << 10n;
const READ_HISTORY = 1n << 16n;
const ADMINISTRATOR = 1n << 3n;
const ALL = (1n << 64n) - 1n;
/** At most this many pages of 100 per catch-up of one channel; the rest comes with the next one. */
const PAGES = 20;
/** Servers, roles and channels are looked at again this often (a role given to the bot, say). */
const RECHECK_MS = 3_600_000;
const NO_HISTORY = 'the bot can see it but not read its history: only new messages arrive';

interface Overwrite {
  id: string;
  type: number;
  allow: string;
  deny: string;
}
type Channel = DiscordChannel & { permission_overwrites?: Overwrite[] };
interface GuildFull {
  id: string;
  name: string;
  owner_id?: string;
  unavailable?: boolean;
  roles?: { id: string; permissions: string }[];
  members?: { user?: { id: string }; roles: string[] }[];
  channels?: Channel[];
}

/**
 * The bot's permissions in a channel, by Discord's own rules: the server's owner and administrators
 * have them all; otherwise @everyone's and the bot's roles' permissions, then the channel's
 * overwrites for @everyone, for the roles, and for the bot itself. Null when the server did not say
 * enough to tell.
 */
export function permissionsIn(guild: GuildFull, channel: { permission_overwrites?: Overwrite[] }, botId: string): bigint | null {
  if (guild.owner_id === botId) return ALL;
  const me = guild.members?.find((m) => m.user?.id === botId);
  const everyone = guild.roles?.find((r) => r.id === guild.id);
  if (!me || !everyone) return null;
  const roles = new Map((guild.roles ?? []).map((r) => [r.id, BigInt(r.permissions)]));
  let p = BigInt(everyone.permissions);
  for (const id of me.roles) p |= roles.get(id) ?? 0n;
  if (p & ADMINISTRATOR) return ALL;
  const ow = channel.permission_overwrites ?? [];
  const all = ow.find((o) => o.id === guild.id);
  if (all) p = (p & ~BigInt(all.deny)) | BigInt(all.allow);
  let allow = 0n;
  let deny = 0n;
  for (const o of ow) {
    if (o.type === 0 && me.roles.includes(o.id)) {
      allow |= BigInt(o.allow);
      deny |= BigInt(o.deny);
    }
  }
  p = (p & ~deny) | allow;
  const mine = ow.find((o) => o.type === 1 && o.id === botId);
  if (mine) p = (p & ~BigInt(mine.deny)) | BigInt(mine.allow);
  return p;
}

/** Whether the bot can see a channel; null when the server did not say enough to tell. */
export function canSee(guild: GuildFull, channel: { permission_overwrites?: Overwrite[] }, botId: string): boolean | null {
  const p = permissionsIn(guild, channel, botId);
  return p === null ? null : (p & VIEW_CHANNEL) !== 0n;
}

export interface DiscordStatus {
  /** DISCORD_BOT_TOKEN is set. */
  configured: boolean;
  state: GatewayState;
  error: string | null;
  bot: { id: string; name: string } | null;
  /** The link that adds the bot to a server, asking only to view channels and read their history. */
  invite: string | null;
  servers: { id: string; name: string; channels: number; on: number }[];
}

export interface DiscordDeps {
  token: string;
  store: Store;
  activity?: Activity;
  now: () => number;
  log: (line: string) => void;
  /** Where digests of its channels go. Null: no channel becomes a source (as with Telegram). */
  reportTo: number | null;
  defaults: ChatDefaults;
  /** Whether a channel seen for the first time is read at once (the console's auto-watch switch). */
  autoWatch: () => boolean;
  maxMessageChars: number;
  /** How far back a catch-up after time offline may go: what is kept anyway. */
  retentionDays: number;
  /** Messages just stored (the news radar matches them). */
  onStored?: (chatId: number, messages: StoredMessage[]) => void;
  rest?: DiscordRest;
  gateway?: (onDispatch: (event: string, data: unknown) => void, onState: (state: GatewayState, error: string | null) => void) => DiscordGateway;
  /** Timers, replaceable in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
}

type ReadResult = 'done' | 'more' | 'failed';

export class DiscordReader {
  private readonly d: DiscordDeps;
  private readonly rest: DiscordRest;
  private readonly gateway: DiscordGateway;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private bot: DiscordUser | null = null;
  private stateError: string | null = null;
  private stopped = false;
  private retryTimer: unknown = null;
  private recheckTimer: unknown = null;
  /** Servers the bot is in: what they said last (roles, the bot's roles, channels). */
  private readonly guilds = new Map<string, GuildFull>();
  /** Channels whose stored history reaches the present: their live messages move their place. */
  private readonly current = new Set<number>();
  /** Channels the bot sees but may not read the history of: only new messages arrive. */
  private readonly noHistory = new Set<number>();
  /** Channels waiting to be caught up, one at a time, and the one being read. */
  private readonly queue: number[] = [];
  private readonly reading = new Set<number>();
  private draining = false;
  /** Catch-ups that failed, tried again later (and how many times so far). */
  private readonly retries = new Map<number, { timer: unknown; tries: number }>();
  /** New messages per source, announced in the activity log a few seconds at a time. */
  private readonly pending = new Map<number, StoredMessage[]>();
  private flushTimer: unknown = null;
  /** When a live message last said a channel is up to date (written at most once a minute). */
  private readonly stamped = new Map<number, number>();

  constructor(d: DiscordDeps) {
    this.d = d;
    this.setTimer = d.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = d.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.rest = d.rest ?? new DiscordRest(d.token, { record: (call) => this.recordCall(call) });
    const gateway = d.gateway ?? ((onDispatch, onState) => new DiscordGateway(d.token, { onDispatch, onState, log: d.log }));
    this.gateway = gateway(
      (event, data) => {
        try {
          this.onDispatch(event, data);
        } catch (err) {
          d.log(`discord: ${event}: ${(err as Error).message}`);
        }
      },
      (state, error) => this.onState(state, error),
    );
  }

  /**
   * Checks the token, then connects: nothing is read before the token is known to work. A refused
   * token waits for the owner; anything else (no network yet) is tried again, less and less often.
   */
  async start(tries = 0): Promise<void> {
    this.stopped = false;
    if (this.d.reportTo === null) {
      this.stateError = 'Set PULSE_OWNER_IDS (or PULSE_REPORT_TO) in .env so digests have somewhere to go: until then no Discord channel is added';
      this.d.log(`discord: ${this.stateError}`);
      return;
    }
    try {
      this.bot = await this.rest.me();
    } catch (err) {
      this.stateError = err instanceof DiscordError ? err.reason : (err as Error).message;
      this.d.log(`discord: ${this.stateError}`);
      if (tries === 0) this.d.activity?.event('discord', 'not connected', 'Discord', this.stateError, false);
      if (!(err instanceof DiscordError && err.status === 401) && !this.stopped) {
        this.retryTimer = this.setTimer(() => void this.start(tries + 1), Math.min(300_000, 15_000 * 2 ** tries));
      }
      return;
    }
    if (this.stopped) return; // stopped while the token was being checked
    this.stateError = null;
    this.d.log(`discord: signed in as bot ${this.bot.username}`);
    this.gateway.start();
    this.scheduleRecheck();
  }

  stop(): void {
    this.stopped = true;
    this.clearTimer(this.retryTimer);
    this.clearTimer(this.recheckTimer);
    for (const r of this.retries.values()) this.clearTimer(r.timer);
    this.retries.clear();
    this.gateway.stop();
    this.flush();
  }

  online(): boolean {
    return this.gateway.state === 'online';
  }

  status(): DiscordStatus {
    const channels = this.d.store.discordChannels();
    const on = new Set(this.d.store.listChats(true).map((c) => c.chatId));
    return {
      configured: true,
      state: this.bot ? this.gateway.state : 'stopped',
      error: this.gateway.error ?? this.stateError,
      bot: this.bot ? { id: this.bot.id, name: this.bot.username } : null,
      invite: this.bot ? `https://discord.com/oauth2/authorize?client_id=${this.bot.id}&scope=bot&permissions=${READ_PERMISSIONS}` : null,
      servers: [...this.guilds.values()].map((g) => {
        const mine = channels.filter((c) => c.guildId === g.id);
        return { id: g.id, name: g.name, channels: mine.length, on: mine.filter((c) => on.has(c.chatId)).length };
      }),
    };
  }

  /**
   * Catches a source up now (switched on, or before a digest): true when it reached the present.
   * Whatever is left (more than one pass holds, or a failure) is caught up in the background.
   */
  async catchUp(chat: ChatRow): Promise<boolean> {
    const ch = this.d.store.discordChannel({ chatId: chat.chatId });
    if (!ch) return false;
    // One read at a time per channel: a catch-up already running is waited for.
    while (this.reading.has(chat.chatId)) await new Promise((r) => setTimeout(r, 50));
    this.reading.add(chat.chatId);
    let r: ReadResult;
    try {
      r = await this.read(chat.chatId);
    } finally {
      this.reading.delete(chat.chatId);
    }
    if (r === 'more') this.catchUpSoon(chat.chatId);
    return r === 'done';
  }

  /** Queues a catch-up (a channel switched on, a new session, a page cap reached); one being read already reads to the present. */
  catchUpSoon(chatId: number): void {
    this.current.delete(chatId);
    if (!this.queue.includes(chatId) && !this.reading.has(chatId)) this.queue.push(chatId);
    void this.drain();
  }

  private onState(state: GatewayState, error: string | null): void {
    if (state === 'online') {
      this.d.activity?.event('discord', 'connected', this.bot?.username ?? 'Discord', 'new messages arrive as they are posted');
      // Back (resumed: Discord replays what it missed): channels not known to be complete catch up.
      for (const ch of this.d.store.discordChannels()) {
        if (!this.current.has(ch.chatId) && this.d.store.getChat(ch.chatId)?.enabled) this.catchUpSoon(ch.chatId);
      }
    }
    if (state === 'stopped' && error) this.d.activity?.event('discord', 'stopped', 'Discord', error, false);
    // Stopped: whatever is posted from now on is missed. (Reconnecting keeps them: a resume replays
    // the gap, and a new session starts over with READY.)
    if (state === 'stopped' || state === 'off') this.current.clear();
  }

  private onDispatch(event: string, data: unknown): void {
    switch (event) {
      case 'READY':
        return this.onReady(data as { guilds: { id: string }[] });
      case 'GUILD_CREATE':
        return this.onGuild(data as GuildFull);
      case 'GUILD_UPDATE': {
        const g = data as GuildFull;
        const known = this.guilds.get(g.id);
        if (!known) return;
        this.guilds.set(g.id, { ...known, name: g.name, owner_id: g.owner_id ?? known.owner_id, roles: g.roles ?? known.roles });
        // A rename: the titles follow.
        for (const ch of this.d.store.discordChannels()) {
          if (ch.guildId === g.id) this.d.store.addDiscordChannel({ channelId: ch.channelId, guildId: g.id, guildName: g.name, name: ch.name, type: ch.type }, this.d.reportTo, false, this.d.defaults);
        }
        return this.recheck(g.id);
      }
      case 'GUILD_DELETE': {
        const g = data as { id: string; unavailable?: boolean };
        // An outage says unavailable; otherwise the bot was taken out of the server.
        if (!g.unavailable) this.dropGuild(g.id, 'the bot is no longer in the server');
        return;
      }
      case 'GUILD_ROLE_CREATE':
      case 'GUILD_ROLE_UPDATE': {
        const { guild_id, role } = data as { guild_id: string; role: { id: string; permissions: string } };
        const g = this.guilds.get(guild_id);
        if (!g) return;
        g.roles = [...(g.roles ?? []).filter((r) => r.id !== role.id), role];
        return this.recheck(guild_id);
      }
      case 'GUILD_ROLE_DELETE': {
        const { guild_id, role_id } = data as { guild_id: string; role_id: string };
        const g = this.guilds.get(guild_id);
        if (!g) return;
        g.roles = (g.roles ?? []).filter((r) => r.id !== role_id);
        return this.recheck(guild_id);
      }
      case 'GUILD_MEMBER_UPDATE': {
        const m = data as { guild_id: string; user: { id: string }; roles: string[] };
        const g = this.guilds.get(m.guild_id);
        if (!g || !this.bot || m.user?.id !== this.bot.id) return;
        g.members = [...(g.members ?? []).filter((x) => x.user?.id !== m.user.id), { user: m.user, roles: m.roles }];
        return this.recheck(m.guild_id);
      }
      case 'CHANNEL_CREATE':
      case 'CHANNEL_UPDATE': {
        const c = data as Channel;
        const g = c.guild_id ? this.guilds.get(c.guild_id) : undefined;
        if (!g) return;
        g.channels = [...(g.channels ?? []).filter((x) => x.id !== c.id), c];
        return this.consider(g, c);
      }
      case 'CHANNEL_DELETE': {
        const c = data as DiscordChannel;
        const g = c.guild_id ? this.guilds.get(c.guild_id) : undefined;
        if (g) g.channels = (g.channels ?? []).filter((x) => x.id !== c.id);
        const known = this.d.store.discordChannel({ channelId: c.id });
        if (known) this.drop(known, 'the channel was deleted');
        return;
      }
      case 'MESSAGE_CREATE':
        return this.onMessage(data as DiscordMessage);
      case 'MESSAGE_UPDATE':
        return this.onEdit(data as DiscordMessage);
    }
  }

  /** A new session: the servers the bot is in now. Ones it was taken out of while away go. */
  private onReady(d: { guilds: { id: string }[] }): void {
    this.current.clear();
    const now = new Set((d.guilds ?? []).map((g) => g.id));
    for (const ch of this.d.store.discordChannels()) {
      if (!now.has(ch.guildId)) this.drop(ch, 'the bot is no longer in the server');
    }
  }

  private onGuild(g: GuildFull): void {
    if (g.unavailable) return;
    this.guilds.set(g.id, g);
    const here = new Set((g.channels ?? []).map((c) => c.id));
    // Channels deleted while the bot was not connected.
    for (const ch of this.d.store.discordChannels()) {
      if (ch.guildId === g.id && !here.has(ch.channelId)) this.drop(ch, 'the channel was deleted');
    }
    for (const c of g.channels ?? []) this.consider(g, c);
    // What was posted while the bot was not connected: every channel that is on catches up.
    for (const ch of this.d.store.discordChannels()) {
      if (ch.guildId === g.id && this.d.store.getChat(ch.chatId)?.enabled) this.catchUpSoon(ch.chatId);
    }
  }

  /** Every channel of a server, looked at again (its roles or the bot's roles changed). */
  private recheck(guildId: string): void {
    const g = this.guilds.get(guildId);
    if (g) for (const c of g.channels ?? []) this.consider(g, c);
  }

  /**
   * A channel the bot was told about: a source when it is a readable kind and the bot can see it.
   * What the server said can be out of date, so a source is never removed on its word alone: Discord
   * is asked about the channel first.
   */
  private consider(g: GuildFull, c: Channel): void {
    if (!READABLE_TYPES.has(c.type) || !c.name || this.d.reportTo === null) return;
    const known = this.d.store.discordChannel({ channelId: c.id });
    const p = this.bot ? permissionsIn(g, c, this.bot.id) : null;
    if (p !== null && !(p & VIEW_CHANNEL)) {
      if (known) void this.confirmGone(known);
      return;
    }
    const on = known ? false : this.d.autoWatch();
    const { chat, created } = this.d.store.addDiscordChannel({ channelId: c.id, guildId: g.id, guildName: g.name, name: c.name, type: c.type }, this.d.reportTo, on, this.d.defaults);
    if (p !== null && !(p & READ_HISTORY)) {
      this.noHistory.add(chat.chatId);
      this.d.store.updateChat(chat.chatId, { readerError: NO_HISTORY });
    } else if (this.noHistory.delete(chat.chatId)) this.d.store.updateChat(chat.chatId, { readerError: null });
    if (!created) return;
    if (!on) this.d.store.setKv(`reader_off_reason:${chat.chatId}`, 'auto-watch off');
    this.d.activity?.event(
      'discord',
      'new channel',
      chat.title,
      on ? 'the bot can read it: reading it from 24 hours back (switch it off in the console)' : 'the bot can read it; auto-watch is off, so it is listed switched off',
    );
    if (on) this.catchUpSoon(chat.chatId);
  }

  /** The server says the bot cannot see a source any more: gone only if Discord says so too. */
  private async confirmGone(ch: DiscordChannelRow): Promise<void> {
    try {
      await this.rest.channel(ch.channelId);
    } catch (err) {
      if (err instanceof DiscordError && (err.status === 403 || err.status === 404)) this.drop(ch, err.status === 404 ? 'the channel was deleted' : 'the bot cannot see it any more');
    }
  }

  private dropGuild(guildId: string, why: string): void {
    this.guilds.delete(guildId);
    for (const ch of this.d.store.discordChannels()) if (ch.guildId === guildId) this.drop(ch, why);
  }

  /** A source that is gone, with the messages stored for it (as a Telegram chat the account left). */
  private drop(ch: DiscordChannelRow, why: string): void {
    const title = this.d.store.getChat(ch.chatId)?.title ?? `#${ch.name}`;
    this.current.delete(ch.chatId);
    const r = this.retries.get(ch.chatId);
    if (r) this.clearTimer(r.timer);
    this.retries.delete(ch.chatId);
    if (!this.d.store.removeSource(ch.chatId)) return;
    this.d.activity?.event('discord', 'source removed', title, `${why}: taken off Sources, and the messages stored for it deleted`);
  }

  private channelName(id: string): string | null {
    for (const g of this.guilds.values()) {
      const c = g.channels?.find((x) => x.id === id);
      if (c?.name) return c.name;
    }
    return null;
  }

  private onMessage(m: DiscordMessage): void {
    const { store } = this.d;
    const ch = store.discordChannel({ channelId: m.channel_id });
    if (!ch) return;
    const chat = store.getChat(ch.chatId);
    if (!chat?.enabled) return;
    const stored = store.savepoint(() => this.save(ch, m));
    // Its place moves only while nothing before this message is missing.
    if (this.current.has(ch.chatId) && newer(m.id, ch.lastId)) {
      store.updateDiscordChannel(ch.chatId, { lastId: m.id });
      const t = this.d.now();
      if (t - (this.stamped.get(ch.chatId) ?? 0) >= 60) {
        this.stamped.set(ch.chatId, t);
        store.setKv(`reader_caught_up:${ch.chatId}`, String(t));
      }
    }
    if (stored) this.announce(chat.chatId, [stored]);
  }

  private onEdit(m: Partial<DiscordMessage> & { id: string; channel_id: string }): void {
    if (typeof m.content !== 'string') return; // an embed loading, not an edit
    const ch = this.d.store.discordChannel({ channelId: m.channel_id });
    if (!ch) return;
    const id = this.d.store.knownDiscordMessage(ch.chatId, m.id);
    if (id === null) return;
    const text = discordText(m as DiscordMessage, (x) => this.channelName(x)).slice(0, this.d.maxMessageChars);
    if (text.trim()) this.d.store.editMessage(ch.chatId, id, text);
  }

  /** One message into the store, as the Telegram reader stores one; null when it is not talk or already stored. */
  private save(ch: DiscordChannelRow, m: DiscordMessage): StoredMessage | null {
    if (!isTalk(m)) return null;
    // Everything that can fail on what the message says comes before anything is written.
    const text = discordText(m, (x) => this.channelName(x)).slice(0, this.d.maxMessageChars);
    if (!text.trim()) return null;
    const date = Math.floor(Date.parse(m.timestamp) / 1000) || this.d.now();
    const name = m.member?.nick || m.author.global_name || m.author.username;
    const { store } = this.d;
    const { id, created } = store.discordMessageId(ch.chatId, m.id);
    if (!created) return null;
    const userId = store.discordUserId(m.author.id);
    store.upsertUser(ch.chatId, userId, name, null);
    // A reply names the message it answers; a forward, or a post from a followed channel, names its source instead.
    const ref = m.message_reference;
    const replyTo = ref?.message_id && (ref.type ?? 0) === 0 && (ref.channel_id ?? m.channel_id) === m.channel_id ? store.knownDiscordMessage(ch.chatId, ref.message_id) : null;
    const msg: StoredMessage = {
      chatId: ch.chatId,
      messageId: id,
      threadId: null,
      userId,
      date,
      text,
      replyTo,
      reactions: (m.reactions ?? []).reduce((t, r) => t + (r.count || 0), 0),
      edited: Boolean(m.edited_timestamp),
    };
    store.saveMessage(msg);
    if (m.webhook_id && !ch.feed) store.updateDiscordChannel(ch.chatId, { feed: true });
    return msg;
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length && !this.stopped) {
        const chatId = this.queue.shift()!;
        if (!this.d.store.getChat(chatId)?.enabled) continue;
        while (this.reading.has(chatId)) await new Promise((r) => setTimeout(r, 50));
        this.reading.add(chatId);
        let r: ReadResult;
        try {
          r = await this.read(chatId);
        } finally {
          this.reading.delete(chatId);
        }
        if (r === 'more') this.queue.push(chatId); // more than one pass holds: the rest after the others
      }
    } finally {
      this.draining = false;
    }
  }

  /**
   * What was posted since the channel's place, going forward a page at a time. From 24 hours back
   * on a first read; after time offline from where it stopped, as far back as messages are kept;
   * switched on again, at most 24 hours back. 'done' when it reached the present.
   */
  private async read(chatId: number): Promise<ReadResult> {
    const { store, now } = this.d;
    const ch = store.discordChannel({ chatId });
    const chat = store.getChat(chatId);
    if (!ch || !chat) return 'done';
    if (this.gateway.fatalCode === 4014) {
      // Without the Message Content intent every message comes back empty: reading would skip them.
      store.updateChat(chatId, { readerError: 'the Message Content intent is off, so nothing is read: switch it on in the developer portal, then restart' });
      return 'failed';
    }
    if (this.noHistory.has(chatId)) {
      // Discord would answer with nothing: new messages are all there is.
      if (this.online()) this.current.add(chatId);
      return 'done';
    }
    const kept = now() - this.d.retentionDays * 86_400;
    const floor = Number(store.getKv(`reader_floor:${chatId}`) ?? 0) || (ch.lastId ? kept : now() - 86_400);
    const start = snowflakeAt(Math.max(floor, kept));
    let after = ch.lastId && newer(ch.lastId, start) ? ch.lastId : start;
    const fresh: StoredMessage[] = [];
    try {
      for (let page = 0; page < PAGES; page++) {
        const batch = await this.rest.messages(ch.channelId, { after });
        batch.sort((a, b) => (newer(a.id, b.id) ? 1 : -1));
        const saved: StoredMessage[] = [];
        if (batch.length) {
          const last = batch[batch.length - 1].id;
          store.transaction(() => {
            for (const m of batch) {
              try {
                const s = store.savepoint(() => this.save(ch, m));
                if (s) saved.push(s);
              } catch (err) {
                this.d.log(`discord: a message in ${chat.title} was not stored: ${(err as Error).message}`);
              }
            }
            const placed = store.discordChannel({ chatId })?.lastId ?? null;
            if (newer(last, placed)) store.updateDiscordChannel(chatId, { lastId: last });
          });
          fresh.push(...saved);
          after = last;
        }
        if (batch.length < 100) {
          this.reached(chat, fresh);
          return 'done';
        }
      }
      if (fresh.length) this.announce(chatId, fresh);
      return 'more';
    } catch (err) {
      if (fresh.length) this.announce(chatId, fresh);
      return this.failed(chat, err);
    }
  }

  /** Caught up: the error goes, the time is noted, live messages move its place from now on. */
  private reached(chat: ChatRow, fresh: StoredMessage[]): void {
    const { store } = this.d;
    if (store.getChat(chat.chatId)?.readerError && !this.noHistory.has(chat.chatId)) store.updateChat(chat.chatId, { readerError: null });
    store.setKv(`reader_caught_up:${chat.chatId}`, String(this.d.now()));
    store.setKv(`reader_floor:${chat.chatId}`, '');
    const r = this.retries.get(chat.chatId);
    if (r) this.clearTimer(r.timer);
    this.retries.delete(chat.chatId);
    if (this.online()) this.current.add(chat.chatId);
    if (fresh.length) this.announce(chat.chatId, fresh);
  }

  /**
   * A catch-up that failed: the reason shows on the source. A channel that is gone goes; the bot
   * not allowed in waits for a change (the hourly look); anything else is tried again later.
   */
  private failed(chat: ChatRow, err: unknown): ReadResult {
    const { store } = this.d;
    const ch = store.discordChannel({ chatId: chat.chatId });
    if (err instanceof DiscordError && err.status === 404 && ch) {
      this.drop(ch, 'the channel was deleted');
      return 'failed';
    }
    const reason = err instanceof DiscordError ? err.reason : (err as Error).message;
    store.updateChat(chat.chatId, { readerError: reason.slice(0, 300) });
    this.d.log(`discord: ${chat.title}: ${reason}`);
    if (err instanceof DiscordError && err.status === 403) return 'failed';
    const tries = (this.retries.get(chat.chatId)?.tries ?? 0) + 1;
    const timer = this.setTimer(() => this.catchUpSoon(chat.chatId), Math.min(900_000, 30_000 * 2 ** (tries - 1)));
    this.retries.set(chat.chatId, { timer, tries });
    return 'failed';
  }

  /** Servers, roles and channels once an hour from REST: what the gateway may not have said (the bot's own roles changing). */
  private scheduleRecheck(): void {
    this.clearTimer(this.recheckTimer);
    this.recheckTimer = this.setTimer(() => {
      void this.recheckAll().finally(() => {
        if (!this.stopped) this.scheduleRecheck();
      });
    }, RECHECK_MS);
  }

  private async recheckAll(): Promise<void> {
    if (!this.bot) return;
    for (const g of [...this.guilds.values()]) {
      try {
        const [roles, member, channels] = await Promise.all([this.rest.roles(g.id), this.rest.member(g.id, this.bot.id), this.rest.channels(g.id)]);
        const full: GuildFull = { ...g, roles, members: [{ user: { id: this.bot.id }, roles: member.roles }], channels };
        this.guilds.set(g.id, full);
        this.recheck(g.id);
        // Sources that failed for want of access are tried again: it may have been granted.
        for (const ch of this.d.store.discordChannels()) {
          if (ch.guildId === g.id && this.d.store.getChat(ch.chatId)?.enabled && this.d.store.getChat(ch.chatId)?.readerError) this.catchUpSoon(ch.chatId);
        }
      } catch (err) {
        this.d.log(`discord: looking at ${g.name} again failed: ${(err as Error).message}`);
      }
    }
  }

  /** New messages: to the news radar at once, to the activity log a few seconds at a time. */
  private announce(chatId: number, msgs: StoredMessage[]): void {
    this.d.onStored?.(chatId, msgs);
    this.pending.set(chatId, [...(this.pending.get(chatId) ?? []), ...msgs]);
    if (!this.flushTimer) this.flushTimer = this.setTimer(() => this.flush(), 2000);
  }

  private flush(): void {
    this.clearTimer(this.flushTimer);
    this.flushTimer = null;
    for (const [chatId, msgs] of this.pending) {
      const title = this.d.store.getChat(chatId)?.title;
      if (title) this.d.activity?.event('discord', 'stored', title, `${msgs.length} new message${msgs.length === 1 ? '' : 's'}`);
    }
    this.pending.clear();
  }

  /** Every request to Discord in the activity log, as reads, named by the source it is about. */
  private recordCall(call: DiscordCall): void {
    const channel = /^\/channels\/(\d+)/.exec(call.path)?.[1];
    const ch = channel ? this.d.store.discordChannel({ channelId: channel }) : null;
    this.d.activity?.record({
      actor: 'discord',
      kind: 'read',
      method: `GET ${call.path.replace(/\d{15,}/g, '{id}')}`,
      target: ch ? (this.d.store.getChat(ch.chatId)?.title ?? '') : '',
      detail: call.error ?? `HTTP ${call.status}`,
      ok: !call.error,
      ms: call.ms,
    });
  }
}
