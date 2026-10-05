// The reader account: reads groups and channels you do not run, through a Telegram USER account
// over MTProto (the protocol the official apps use). A bot cannot do this: a bot only gets into a
// group when an admin adds it.
//
// Public groups and channels (with an @username) are read without joining, the way the apps show
// a preview before you tap Join, so the account does not appear in the member list. Private
// groups must be joined first, by a person, in the Telegram app (that is also where any "I am not
// a robot" check gets answered). The reader is read-only: it never posts, reacts or joins.

import type { Config } from './config.ts';
import type { ChatRow, StoredMessage, Store } from './store.ts';
import type { Window } from './transcript.ts';

// The GramJS objects the reader touches, duck-typed by `className` so tests can pass plain objects.
export interface MtEntity {
  className: string;
  id: unknown;
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  bot?: boolean;
  megagroup?: boolean;
  broadcast?: boolean;
  participantsCount?: number;
}

export interface MtMessage {
  className?: string;
  id: number;
  date: number;
  message?: string;
  editDate?: number;
  action?: unknown;
  sender?: MtEntity;
  senderId?: unknown;
  replyTo?: { replyToMsgId?: number; replyToTopId?: number; forumTopic?: boolean };
  fwdFrom?: { fromName?: string; fromId?: { className: string } };
  forward?: { chat?: MtEntity };
  media?: {
    className: string;
    emoticon?: string;
    poll?: { question?: { text?: string } | string };
    document?: {
      attributes?: { className: string; alt?: string; voice?: boolean; duration?: number; title?: string; roundMessage?: boolean; fileName?: string }[];
    };
  };
  reactions?: { results?: { count?: number }[] };
}

/** The part of a GramJS TelegramClient the reader uses. */
export interface MtClient {
  getEntity(ref: string | number): Promise<MtEntity>;
  /** The account's own chats (also teaches GramJS the access hashes of private groups it has joined). */
  getDialogs(params: { limit?: number }): Promise<{ entity?: MtEntity; title?: string }[]>;
  getMessages(entity: MtEntity, params: { limit?: number; offsetId?: number; minId?: number; ids?: number[] }): Promise<(MtMessage | undefined)[]>;
}

export interface SourceInfo {
  chatId: number;
  title: string;
  username: string | null;
  type: 'supergroup' | 'channel' | 'group';
  /** What the reader uses to find it again: @username, or the -100… id. */
  ref: string;
  members: number | null;
}

/** A problem worth showing to the person who asked (not a crash). */
export class ReaderError extends Error {
  readonly retryAfter: number;
  constructor(message: string, retryAfter = 0) {
    super(message);
    this.name = 'ReaderError';
    this.retryAfter = retryAfter;
  }
}

const big = (x: unknown): number => Number(String(x));

/** The Bot-API-style id (-100… for supergroups and channels), so watched chats and bot chats share one id space. */
export function chatIdOf(e: MtEntity): number {
  if (e.className === 'Channel' || e.className === 'ChannelForbidden') return -(1_000_000_000_000 + big(e.id));
  if (e.className === 'Chat' || e.className === 'ChatForbidden') return -big(e.id);
  return big(e.id);
}

export type Ref = { kind: 'username'; value: string } | { kind: 'id'; value: number } | { kind: 'invite'; hash: string };

/** Accepts @name, name, t.me/name, https://t.me/name/123, a -100… id, or an invite link (t.me/+hash, t.me/joinchat/hash). */
export function parseRef(input: string): Ref | null {
  let s = input.trim().replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '');
  const invite = /^(?:\+|joinchat\/)([A-Za-z0-9_-]{8,})/i.exec(s) ?? /^tg:\/\/join\?invite=([A-Za-z0-9_-]{8,})/i.exec(input.trim());
  if (invite) return { kind: 'invite', hash: invite[1] };
  if (/^\+|^joinchat\//i.test(s)) return null;
  s = s.replace(/^@/, '').replace(/^s\//, '').replace(/[/?#].*$/, '');
  if (/^-?\d+$/.test(s)) return { kind: 'id', value: Number(s) };
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) return { kind: 'username', value: s };
  return null;
}

/** Turns Telegram's error codes into something the owner can act on. */
export function explain(err: unknown): ReaderError {
  if (err instanceof ReaderError) return err;
  const e = err as { errorMessage?: string; message?: string; seconds?: number };
  const code = e.errorMessage ?? e.message ?? String(err);
  if (typeof e.seconds === 'number' || /FLOOD_WAIT/.test(code)) {
    const s = e.seconds ?? Number(/FLOOD_WAIT_(\d+)/.exec(code)?.[1] ?? 60);
    return new ReaderError(`Telegram asked the reader account to slow down for ${s}s`, s);
  }
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|No user has|Cannot find any entity/i.test(code)) {
    return new ReaderError('no public group or channel has that username');
  }
  if (/CHANNEL_PRIVATE|CHANNEL_INVALID|CHAT_ADMIN_REQUIRED|CHAT_FORBIDDEN|PEER_ID_INVALID/.test(code)) {
    return new ReaderError('the reader account cannot see it: join it first in the Telegram app (private groups need an invite)');
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED|AUTH_KEY_DUPLICATED/.test(code)) {
    return new ReaderError('the reader account session is no longer valid: run `npm run login` again');
  }
  return new ReaderError(code.slice(0, 200));
}

const duration = (s: number) => `${Math.floor(s / 60)}:${String(Math.round(s) % 60).padStart(2, '0')}`;

/** The same one-line form the bot stores for live messages. */
export function describeMtMessage(m: MtMessage): string | null {
  const parts: string[] = [];
  if (m.fwdFrom) {
    const source = m.fwdFrom.fromId?.className === 'PeerChannel' ? m.forward?.chat?.title : undefined;
    parts.push(source ? `[forwarded from ${source}]` : '[forwarded]');
  }
  const media = m.media;
  if (media) {
    const attrs = media.document?.attributes ?? [];
    const has = (name: string) => attrs.find((a) => a.className === name);
    switch (media.className) {
      case 'MessageMediaPhoto':
        parts.push('[photo]');
        break;
      case 'MessageMediaDocument': {
        const sticker = has('DocumentAttributeSticker');
        const audio = has('DocumentAttributeAudio');
        const video = has('DocumentAttributeVideo');
        const file = has('DocumentAttributeFilename');
        if (sticker) parts.push(sticker.alt ? `[sticker ${sticker.alt}]` : '[sticker]');
        else if (audio?.voice) parts.push(`[voice ${duration(audio.duration ?? 0)}]`);
        else if (audio) parts.push(audio.title ? `[audio: ${audio.title}]` : '[audio]');
        else if (video?.roundMessage) parts.push('[video note]');
        else if (has('DocumentAttributeAnimated')) parts.push('[gif]');
        else if (video) parts.push('[video]');
        else parts.push(file?.fileName ? `[document: ${file.fileName}]` : '[document]');
        break;
      }
      case 'MessageMediaPoll': {
        const q = media.poll?.question;
        parts.push(`[poll: ${typeof q === 'string' ? q : (q?.text ?? '')}]`);
        break;
      }
      case 'MessageMediaGeo':
      case 'MessageMediaGeoLive':
      case 'MessageMediaVenue':
        parts.push('[location]');
        break;
      case 'MessageMediaContact':
        parts.push('[contact]');
        break;
      case 'MessageMediaDice':
        parts.push(`[dice ${media.emoticon ?? ''}]`.replace(' ]', ']'));
        break;
      case 'MessageMediaWebPage':
      case 'MessageMediaEmpty':
        break; // the link is already in the text
      default:
        parts.push(`[${media.className.replace(/^MessageMedia/, '').toLowerCase()}]`);
    }
  }
  const text = (m.message ?? '').trim();
  if (text) parts.push(text);
  return parts.length ? parts.join(' ') : null;
}

export interface Author {
  id: number;
  name: string;
  username: string | null;
}

/** A pulled message in the store's shape, or null for service messages, bots and empty ones. */
export function toStored(m: MtMessage, chatId: number): { message: StoredMessage; author: Author } | null {
  if (m.className === 'MessageService' || m.action) return null;
  const text = describeMtMessage(m);
  if (!text) return null;
  const s = m.sender;
  let author: Author;
  if (s && s.className === 'User') {
    if (s.bot) return null; // price alerts, captcha bots, …
    author = { id: big(s.id), name: [s.firstName, s.lastName].filter(Boolean).join(' ') || s.username || 'someone', username: s.username ?? null };
  } else if (s && (s.className === 'Channel' || s.className === 'Chat')) {
    author = { id: chatIdOf(s), name: s.title ?? 'channel', username: s.username ?? null };
  } else if (m.senderId !== undefined && m.senderId !== null) {
    author = { id: big(m.senderId), name: 'someone', username: null };
  } else {
    author = { id: chatId, name: 'channel', username: null }; // a channel post without a sender
  }
  const r = m.replyTo;
  // In forum groups every message "replies" to its topic's first message; only a reply inside a topic is a real reply.
  const replyTo = r ? (r.forumTopic ? (r.replyToTopId ? (r.replyToMsgId ?? null) : null) : (r.replyToMsgId ?? null)) : null;
  const threadId = r?.forumTopic ? (r.replyToTopId ?? r.replyToMsgId ?? null) : null;
  return {
    author,
    message: {
      chatId,
      messageId: m.id,
      threadId,
      userId: author.id,
      date: m.date,
      text,
      replyTo,
      reactions: (m.reactions?.results ?? []).reduce((sum, x) => sum + (x.count ?? 0), 0),
      edited: Boolean(m.editDate),
    },
  };
}

export interface ReaderDeps {
  client: MtClient;
  store: Store;
  config: Config;
  log: (line: string) => void;
  now: () => number;
}

const PAGE = 100;
const MAX_PAGES_PER_PULL = 50;

export class Reader {
  private readonly deps: ReaderDeps;
  private readonly entities = new Map<number, MtEntity>();

  constructor(deps: ReaderDeps) {
    this.deps = deps;
  }

  /** Finds a group or channel by @username, t.me link, id, or the name of a group the reader account has joined. */
  async resolve(input: string): Promise<SourceInfo> {
    const ref = parseRef(input);
    if (ref?.kind === 'invite') {
      throw new ReaderError('an invite link cannot be watched directly: join the group with the reader account in the Telegram app, then watch it by its name');
    }
    if (!ref) return this.info(await this.byTitle(input));
    if (ref.kind === 'id') return this.info(await this.byId(ref.value).catch((err) => Promise.reject(explain(err))));
    try {
      return this.info(await this.deps.client.getEntity(ref.value));
    } catch (err) {
      // A bare word may be a joined private group's name rather than a username.
      const notFound = explain(err);
      if (/^@|t(elegram)?\.me\//i.test(input.trim())) throw notFound;
      try {
        return this.info(await this.byTitle(input));
      } catch (byName) {
        throw /several/.test((byName as Error).message) ? byName : notFound;
      }
    }
  }

  /** A private group the account has joined, by its name in the account's chat list. */
  private async byTitle(input: string): Promise<MtEntity> {
    const q = input.trim().toLowerCase();
    const dialogs = (await this.deps.client.getDialogs({ limit: 500 }).catch((err) => {
      throw explain(err);
    })).filter((d): d is { entity: MtEntity; title?: string } => Boolean(d.entity) && d.entity!.className !== 'User');
    const title = (d: { entity: MtEntity; title?: string }) => (d.title ?? d.entity.title ?? '').toLowerCase();
    const exact = dialogs.filter((d) => title(d) === q);
    const found = exact.length ? exact : dialogs.filter((d) => title(d).includes(q));
    if (found.length === 1) return found[0].entity;
    if (found.length === 0) {
      throw new ReaderError(`"${input}" is not a @username or t.me link, and the reader account has joined no group or channel with that name`);
    }
    throw new ReaderError(`several of the reader account's chats match "${input}": ${found.slice(0, 5).map((d) => d.title ?? d.entity.title).join(' · ')}`);
  }

  /** By id: works for chats GramJS has seen; after a restart, loading the chat list teaches it the private ones. */
  private async byId(id: number): Promise<MtEntity> {
    try {
      return await this.deps.client.getEntity(id);
    } catch {
      await this.deps.client.getDialogs({ limit: 500 });
      return this.deps.client.getEntity(id);
    }
  }

  private info(e: MtEntity): SourceInfo {
    if (e.className === 'User') throw new ReaderError('that is a person, not a group or channel');
    const chatId = chatIdOf(e);
    this.entities.set(chatId, e);
    return {
      chatId,
      title: e.title ?? String(chatId),
      username: e.username ?? null,
      type: e.className === 'Channel' ? (e.broadcast ? 'channel' : 'supergroup') : 'group',
      ref: e.username ? `@${e.username}` : String(chatId),
      members: e.participantsCount ?? null,
    };
  }

  private async entity(chat: ChatRow): Promise<MtEntity> {
    const hit = this.entities.get(chat.chatId);
    if (hit) return hit;
    const ref = parseRef(chat.readerRef ?? String(chat.chatId));
    const e = await (ref?.kind === 'username' ? this.deps.client.getEntity(ref.value) : this.byId(chat.chatId)).catch((err) => {
      throw explain(err);
    });
    this.entities.set(chat.chatId, e);
    return e;
  }

  /**
   * Stores the messages posted since the last pull, newest page first down to the cursor.
   * The first pull of a chat goes back 24 hours.
   */
  async pull(chat: ChatRow): Promise<number> {
    const { client, store } = this.deps;
    const entity = await this.entity(chat);
    const cursor = chat.readerCursor ?? 0;
    const floor = this.deps.now() - 86_400;
    const fresh: MtMessage[] = [];
    let newest = cursor;
    let offsetId = 0;
    for (let page = 0; page < MAX_PAGES_PER_PULL; page++) {
      const batch = (await client.getMessages(entity, { limit: PAGE, offsetId, minId: cursor }).catch((err) => {
        throw explain(err);
      })).filter((m): m is MtMessage => Boolean(m));
      if (batch.length === 0) break;
      newest = Math.max(newest, ...batch.map((m) => m.id));
      let reachedFloor = false;
      for (const m of batch) {
        if (m.id <= cursor) continue;
        if (cursor === 0 && m.date < floor) {
          reachedFloor = true;
          break;
        }
        fresh.push(m);
      }
      if (reachedFloor || batch.length < PAGE) break;
      offsetId = Math.min(...batch.map((m) => m.id));
    }

    let saved = 0;
    store.transaction(() => {
      for (const m of fresh.sort((a, b) => a.id - b.id)) {
        const s = toStored(m, chat.chatId);
        if (!s) continue;
        store.upsertUser(chat.chatId, s.author.id, s.author.name, s.author.username);
        store.saveMessage(s.message);
        saved++;
      }
      if (newest > cursor) store.updateChat(chat.chatId, { readerCursor: newest });
    });
    return saved;
  }

  async pullNow(chatId: number): Promise<number> {
    const chat = this.deps.store.getChat(chatId);
    return chat ? this.pull(chat) : 0;
  }

  /** Refreshes reaction counts and edits of a window's messages just before its digest is written. */
  async refresh(chat: ChatRow, window: Window): Promise<void> {
    const ids = this.deps.store.messages(chat.chatId, window.start, window.end).map((m) => m.messageId);
    if (ids.length === 0) return;
    const entity = await this.entity(chat);
    for (let i = 0; i < ids.length; i += PAGE) {
      const batch = await this.deps.client.getMessages(entity, { ids: ids.slice(i, i + PAGE) }).catch((err) => {
        throw explain(err);
      });
      for (const m of batch) {
        if (!m) continue; // deleted since
        const s = toStored(m, chat.chatId);
        if (!s) continue;
        this.deps.store.setReactions(chat.chatId, m.id, s.message.reactions);
        if (m.editDate) this.deps.store.editMessage(chat.chatId, m.id, s.message.text);
      }
    }
  }

  /** Polls every watched chat, one after another, every `readerPollSeconds` (±15%). Returns a stop function. */
  start(): () => void {
    const { store, config, log } = this.deps;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let wake: (() => void) | null = null;
    const sleep = (ms: number) =>
      new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(resolve, ms);
      });
    const loop = async () => {
      while (!stopped) {
        for (const chat of store.listChats(true).filter((c) => c.kind === 'watched')) {
          if (stopped) break;
          try {
            const n = await this.pull(chat);
            if (chat.readerError) store.updateChat(chat.chatId, { readerError: null });
            if (n > 0) log(`reader: ${n} new message${n === 1 ? '' : 's'} from ${chat.title}`);
          } catch (err) {
            const e = explain(err);
            store.updateChat(chat.chatId, { readerError: e.message.slice(0, 300) });
            log(`reader: ${chat.title}: ${e.message}`);
            if (e.retryAfter) await sleep(e.retryAfter * 1000);
          }
        }
        if (!stopped) await sleep(config.readerPollSeconds * 1000 * (0.85 + Math.random() * 0.3));
      }
    };
    void loop();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }
}
