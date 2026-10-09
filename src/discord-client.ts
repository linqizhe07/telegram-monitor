// Discord, read-only, through a bot the owner adds to their own servers. (Discord does not allow
// automating a person's own account, so the monitor reads Discord the way Discord allows: a bot.)
//
// Two parts: the REST API, GET only (this module has no way to send, edit or delete anything), and
// the gateway, which pushes new messages as they are posted. The gateway session identifies with
// three intents: GUILDS (servers and their channels), GUILD_MESSAGES and MESSAGE_CONTENT (the text
// of messages, a privileged intent the owner switches on in the developer portal). Nothing else is
// ever sent on it but heartbeats and a resume after a dropped connection.

export const API = 'https://discord.com/api/v10';
export const GATEWAY = 'wss://gateway.discord.gg';
export const INTENTS = (1 << 0) | (1 << 9) | (1 << 15);
/** What the bot asks for when it is added to a server: View Channels and Read Message History. */
export const READ_PERMISSIONS = (1 << 10) | (1 << 16);
/** Text and announcement channels: the ones with conversations to read. */
export const READABLE_TYPES = new Set([0, 5]);

export interface DiscordUser {
  id: string;
  username: string;
  global_name?: string | null;
  bot?: boolean;
}
export interface DiscordChannel {
  id: string;
  type: number;
  name?: string;
  guild_id?: string;
  parent_id?: string | null;
  position?: number;
}
export interface DiscordGuild {
  id: string;
  name: string;
  channels?: DiscordChannel[];
  unavailable?: boolean;
}
export interface DiscordMessage {
  id: string;
  channel_id: string;
  guild_id?: string;
  author: DiscordUser;
  member?: { nick?: string | null };
  content: string;
  timestamp: string;
  edited_timestamp?: string | null;
  type: number;
  webhook_id?: string;
  /** A reply (type 0) or a forward (type 1: the forwarded message is in message_snapshots). */
  message_reference?: { type?: number; message_id?: string; channel_id?: string; guild_id?: string };
  message_snapshots?: { message: Partial<Pick<DiscordMessage, 'content' | 'embeds' | 'attachments' | 'sticker_items' | 'mentions'>> }[];
  mentions?: DiscordUser[];
  mention_roles?: string[];
  attachments?: { filename: string; content_type?: string }[];
  embeds?: { title?: string; description?: string; url?: string }[];
  sticker_items?: { name: string }[];
  reactions?: { count: number }[];
}

/** One request to Discord, for the activity log. */
export interface DiscordCall {
  method: string;
  path: string;
  status: number;
  ms: number;
  error?: string;
}

export class DiscordError extends Error {
  readonly status: number;
  readonly code: number | null;
  constructor(status: number, code: number | null, message: string) {
    super(message);
    this.name = 'DiscordError';
    this.status = status;
    this.code = code;
  }
  /** What it means for the owner, in a few words. */
  get reason(): string {
    if (this.status === 401) return 'the bot token is not valid';
    if (this.code === 50001 || this.code === 50013) return 'the bot cannot see this channel';
    if (this.status === 404) return 'it no longer exists';
    return this.message;
  }
}

type Fetch = (url: string, init?: { headers?: Record<string, string> }) => Promise<{ status: number; headers: { get(name: string): string | null }; json(): Promise<unknown>; text(): Promise<string> }>;

export interface RestOptions {
  fetch?: Fetch;
  record?: (call: DiscordCall) => void;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
}

/**
 * Discord's REST API, GET only. It keeps to Discord's rate limits: it waits out a route whose
 * bucket is empty, and on a 429 waits what Discord says (at most three times).
 */
export class DiscordRest {
  private readonly fetch: Fetch;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  /** Per route: when its bucket refills, once it is empty. */
  private readonly emptyUntil = new Map<string, number>();
  private globalUntil = 0;
  private readonly token: string;
  private readonly opts: RestOptions;

  constructor(token: string, opts: RestOptions = {}) {
    this.token = token;
    this.opts = opts;
    this.fetch = opts.fetch ?? (globalThis.fetch as unknown as Fetch);
    this.sleep = opts.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.now = opts.now ?? Date.now;
  }

  async get<T>(path: string, query: Record<string, string | number | undefined> = {}): Promise<T> {
    const q = Object.entries(query).filter(([, v]) => v !== undefined);
    const url = `${API}${path}${q.length ? `?${q.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join('&')}` : ''}`;
    // Rate limits are kept per route: the path with its ids, less the query.
    const route = path;
    for (let attempt = 0; ; attempt++) {
      const wait = Math.max(this.globalUntil, this.emptyUntil.get(route) ?? 0) - this.now();
      if (wait > 0) await this.sleep(wait);
      const started = this.now();
      let res;
      try {
        res = await this.fetch(url, { headers: { Authorization: `Bot ${this.token}`, 'User-Agent': 'DiscordBot (https://github.com/linqizhe07/telegram-monitor, 1.0)' } });
      } catch (err) {
        this.opts.record?.({ method: 'GET', path, status: 0, ms: this.now() - started, error: (err as Error).message });
        throw err;
      }
      const remaining = res.headers.get('x-ratelimit-remaining');
      const resetAfter = Number(res.headers.get('x-ratelimit-reset-after'));
      if (remaining === '0' && Number.isFinite(resetAfter)) this.emptyUntil.set(route, this.now() + resetAfter * 1000);
      if (res.status === 429) {
        const body = (await res.json().catch(() => ({}))) as { retry_after?: number; global?: boolean };
        const after = Math.max(0.05, Number(body.retry_after ?? res.headers.get('retry-after') ?? 1)) * 1000;
        this.opts.record?.({ method: 'GET', path, status: 429, ms: this.now() - started, error: `rate limited for ${Math.round(after)} ms` });
        if (body.global) this.globalUntil = this.now() + after;
        else this.emptyUntil.set(route, this.now() + after);
        if (attempt >= 2) throw new DiscordError(429, null, 'Discord kept asking to wait');
        continue;
      }
      if (res.status >= 400) {
        const body = (await res.json().catch(() => ({}))) as { code?: number; message?: string };
        const err = new DiscordError(res.status, typeof body.code === 'number' ? body.code : null, body.message || `HTTP ${res.status}`);
        this.opts.record?.({ method: 'GET', path, status: res.status, ms: this.now() - started, error: err.reason });
        throw err;
      }
      this.opts.record?.({ method: 'GET', path, status: res.status, ms: this.now() - started });
      return (await res.json()) as T;
    }
  }

  me(): Promise<DiscordUser> {
    return this.get('/users/@me');
  }
  guilds(): Promise<DiscordGuild[]> {
    return this.get('/users/@me/guilds');
  }
  channels(guildId: string): Promise<DiscordChannel[]> {
    return this.get(`/guilds/${guildId}/channels`);
  }
  /** Up to 100 messages, newest first: after a message id (going forward) or before one (going back). */
  messages(channelId: string, page: { after?: string; before?: string; limit?: number }): Promise<DiscordMessage[]> {
    return this.get(`/channels/${channelId}/messages`, { limit: page.limit ?? 100, after: page.after, before: page.before });
  }
  /** One channel: answers only if the bot can see it. */
  channel(channelId: string): Promise<DiscordChannel> {
    return this.get(`/channels/${channelId}`);
  }
  roles(guildId: string): Promise<{ id: string; permissions: string }[]> {
    return this.get(`/guilds/${guildId}/roles`);
  }
  member(guildId: string, userId: string): Promise<{ user?: { id: string }; roles: string[] }> {
    return this.get(`/guilds/${guildId}/members/${userId}`);
  }
}

/** Snowflakes compared as numbers (they outgrow a double). */
export const newer = (a: string, b: string | null | undefined): boolean => !b || BigInt(a) > BigInt(b);
/** The time a snowflake was made, unix seconds. */
export const snowflakeTime = (id: string): number => Number((BigInt(id) >> 22n) + 1420070400000n) / 1000;
/** The snowflake for a moment (unix seconds): `after` it means "posted since then". */
export const snowflakeAt = (seconds: number): string => String((BigInt(Math.max(0, Math.floor(seconds * 1000) - 1420070400000)) << 22n));

/** The socket the gateway needs (the global WebSocket is one). */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason?: string }) => void) | null;
  onerror: ((ev: unknown) => void) | null;
}

export type GatewayState = 'off' | 'connecting' | 'online' | 'stopped';

export interface GatewayOptions {
  connect?: (url: string) => GatewaySocket;
  onDispatch: (event: string, data: unknown) => void;
  onState?: (state: GatewayState, error: string | null) => void;
  log?: (line: string) => void;
  /** Timers, replaceable in tests. */
  setTimer?: (fn: () => void, ms: number) => unknown;
  clearTimer?: (t: unknown) => void;
  random?: () => number;
}

/** Close codes after which reconnecting cannot help, with what the owner has to do. */
const FATAL: Record<number, string> = {
  4004: 'Discord refused the bot token: copy it again from the developer portal (Bot → Reset Token) into DISCORD_BOT_TOKEN',
  4010: 'Discord refused the shard settings',
  4011: 'the bot is in too many servers for one connection',
  4012: 'Discord refused the API version',
  4013: 'Discord refused the intents',
  4014: 'the Message Content intent is off: switch it on in the developer portal (Bot → Privileged Gateway Intents → Message Content Intent)',
};

/**
 * The gateway: identify (or resume), heartbeat, and hand every event to `onDispatch`. A dropped
 * connection is resumed where it left off; a heartbeat that goes unanswered counts as dropped.
 */
export class DiscordGateway {
  state: GatewayState = 'off';
  error: string | null = null;
  /** The close code that stopped it for good (4004 the token, 4014 the Message Content intent…). */
  fatalCode: number | null = null;
  user: DiscordUser | null = null;
  private socket: GatewaySocket | null = null;
  private seq: number | null = null;
  private sessionId: string | null = null;
  private resumeUrl: string | null = null;
  private beat: unknown = null;
  private acked = true;
  private retry = 0;
  private reconnectTimer: unknown = null;
  private readonly setTimer: (fn: () => void, ms: number) => unknown;
  private readonly clearTimer: (t: unknown) => void;
  private readonly random: () => number;
  private readonly token: string;
  private readonly opts: GatewayOptions;

  constructor(token: string, opts: GatewayOptions) {
    this.token = token;
    this.opts = opts;
    this.setTimer = opts.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = opts.clearTimer ?? ((t) => clearTimeout(t as ReturnType<typeof setTimeout>));
    this.random = opts.random ?? Math.random;
  }

  start(): void {
    if (this.state === 'connecting' || this.state === 'online') return;
    this.error = null;
    this.open();
  }

  stop(): void {
    this.setState('off', null);
    this.clearTimer(this.reconnectTimer);
    this.stopBeat();
    const s = this.socket;
    this.socket = null;
    s?.close(1000);
  }

  private setState(state: GatewayState, error: string | null): void {
    this.state = state;
    this.error = error;
    this.opts.onState?.(state, error);
  }

  private open(): void {
    this.setState('connecting', null);
    const url = `${this.resumeUrl && this.sessionId ? this.resumeUrl : GATEWAY}/?v=10&encoding=json`;
    const connect = this.opts.connect ?? ((u: string) => new WebSocket(u) as unknown as GatewaySocket);
    let socket: GatewaySocket;
    try {
      socket = connect(url);
    } catch (err) {
      this.opts.log?.(`discord: cannot connect: ${(err as Error).message}`);
      return this.later();
    }
    this.socket = socket;
    socket.onmessage = (ev) => {
      if (this.socket !== socket) return;
      let msg: { op: number; d: unknown; s: number | null; t: string | null };
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : String(ev.data));
      } catch {
        return;
      }
      this.onMessage(msg);
    };
    socket.onclose = (ev) => {
      if (this.socket !== socket) return;
      this.socket = null;
      this.stopBeat();
      if (this.state === 'off') return;
      const fatal = FATAL[ev.code];
      if (fatal) {
        this.opts.log?.(`discord: stopped (${ev.code}): ${fatal}`);
        this.fatalCode = ev.code;
        return this.setState('stopped', fatal);
      }
      // A session Discord no longer knows starts over.
      if (ev.code === 4007 || ev.code === 4009) this.sessionId = null;
      this.later();
    };
    socket.onerror = () => {
      // The close that follows does the rest.
    };
  }

  /** Try again after a pause that grows with each failure: 1 s, 2 s, 5 s, 10 s, 30 s. */
  private later(): void {
    const steps = [1000, 2000, 5000, 10_000, 30_000];
    const ms = steps[Math.min(this.retry, steps.length - 1)];
    this.retry++;
    this.setState('connecting', this.error);
    this.clearTimer(this.reconnectTimer);
    this.reconnectTimer = this.setTimer(() => {
      if (this.state !== 'off') this.open();
    }, ms);
  }

  private send(payload: unknown): void {
    this.socket?.send(JSON.stringify(payload));
  }

  private stopBeat(): void {
    if (this.beat) this.clearTimer(this.beat);
    this.beat = null;
  }

  private heartbeat(): void {
    if (!this.acked) {
      // The last heartbeat was never answered: the connection is dead even if it looks open.
      this.opts.log?.('discord: no answer to a heartbeat, reconnecting');
      const s = this.socket;
      this.socket = null;
      this.stopBeat();
      s?.close(4000);
      return this.later();
    }
    this.acked = false;
    this.send({ op: 1, d: this.seq });
  }

  private onMessage(msg: { op: number; d: unknown; s: number | null; t: string | null }): void {
    if (msg.s !== null && msg.s !== undefined) this.seq = msg.s;
    switch (msg.op) {
      case 10: {
        const every = (msg.d as { heartbeat_interval: number }).heartbeat_interval;
        this.acked = true;
        const schedule = (ms: number) => {
          this.beat = this.setTimer(() => {
            this.heartbeat();
            if (this.socket) schedule(every);
          }, ms);
        };
        schedule(every * this.random());
        if (this.sessionId && this.seq !== null) this.send({ op: 6, d: { token: this.token, session_id: this.sessionId, seq: this.seq } });
        else this.send({ op: 2, d: { token: this.token, intents: INTENTS, properties: { os: process.platform, browser: 'tg-pulse', device: 'tg-pulse' } } });
        return;
      }
      case 11:
        this.acked = true;
        return;
      case 1:
        this.send({ op: 1, d: this.seq });
        return;
      case 7: {
        // Discord asks for a reconnect: resume on a new connection.
        const s = this.socket;
        this.socket = null;
        this.stopBeat();
        s?.close(4000);
        this.retry = 0;
        return this.later();
      }
      case 9: {
        if (!msg.d) {
          this.sessionId = null;
          this.seq = null;
        }
        const s = this.socket;
        this.socket = null;
        this.stopBeat();
        s?.close(4000);
        this.retry = Math.max(this.retry, 1);
        return this.later();
      }
      case 0: {
        if (msg.t === 'READY') {
          const d = msg.d as { session_id: string; resume_gateway_url: string; user: DiscordUser };
          this.sessionId = d.session_id;
          this.resumeUrl = d.resume_gateway_url;
          this.user = d.user;
          this.retry = 0;
          this.setState('online', null);
        } else if (msg.t === 'RESUMED') {
          this.retry = 0;
          this.setState('online', null);
        }
        if (msg.t) this.opts.onDispatch(msg.t, msg.d);
        return;
      }
    }
  }
}

/**
 * What a message says, as the monitor stores text: mentions by name, custom emoji as :name:,
 * embeds' titles and descriptions (announcements are often only that), and media as the
 * placeholders the Telegram reader writes ("[photo]", "[sticker name]").
 */
export function discordText(m: DiscordMessage, channelName: (id: string) => string | null = () => null): string {
  // A forward carries the forwarded message instead of its own.
  const fwd = m.message_reference?.type === 1 ? m.message_snapshots?.[0]?.message : undefined;
  if (fwd && !(m.content ?? '').trim()) {
    const inner = discordText({ ...m, content: fwd.content ?? '', embeds: fwd.embeds, attachments: fwd.attachments, sticker_items: fwd.sticker_items, mentions: fwd.mentions, message_reference: undefined, message_snapshots: undefined }, channelName);
    return inner ? `[forwarded] ${inner}` : '';
  }
  const people = new Map((m.mentions ?? []).map((u) => [u.id, u.global_name || u.username]));
  let text = (m.content ?? '')
    .replace(/<@!?(\d+)>/g, (_, id: string) => `@${people.get(id) ?? 'someone'}`)
    .replace(/<#(\d+)>/g, (_, id: string) => `#${channelName(id) ?? 'channel'}`)
    .replace(/<@&\d+>/g, '@role')
    .replace(/<a?:(\w+):\d+>/g, ':$1:')
    .replace(/<t:(\d+)(?::\w)?>/g, (whole: string, s: string) => {
      // Anyone can write a time out of any calendar's range: such a one stays as written.
      const d = new Date(Number(s) * 1000);
      return Number.isFinite(d.getTime()) ? `${d.toISOString().slice(0, 16).replace('T', ' ')} UTC` : whole;
    });
  const parts = [text.trim()];
  for (const e of m.embeds ?? []) {
    const bits = [e.title, e.description].filter((x): x is string => Boolean(x && x.trim()));
    if (bits.length) parts.push(bits.join('\n'));
  }
  for (const a of m.attachments ?? []) {
    const type = a.content_type ?? '';
    parts.push(type.startsWith('image/') ? '[photo]' : type.startsWith('video/') ? '[video]' : type.startsWith('audio/') ? '[voice]' : `[file ${a.filename}]`);
  }
  for (const s of m.sticker_items ?? []) parts.push(`[sticker ${s.name}]`);
  text = parts.filter(Boolean).join('\n');
  return text;
}

/** Whether a message is talk worth keeping: people (and posts that arrive from a followed announcement channel), not bots or service notices. */
export function isTalk(m: DiscordMessage): boolean {
  if (m.type !== 0 && m.type !== 19) return false;
  if (m.author?.bot && !m.webhook_id) return false;
  return true;
}
