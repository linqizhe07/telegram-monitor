// The reader account: reads groups and channels you do not run, through a Telegram USER account
// over MTProto (the protocol the official apps use). A bot cannot do this: a bot only gets into a
// group when an admin adds it.
//
// Public groups and channels (with an @username) are read without joining, the way the apps show
// a preview before you tap Join, so the account does not appear in the member list. Private
// groups must be joined first, by a person, in the Telegram app (that is also where any "I am not
// a robot" check gets answered). The reader is read-only: it never posts, reacts or joins.

import type { Activity } from './activity.ts';
import type { Config } from './config.ts';
import type { ChatDefaults, ChatRow, StoredMessage, Store } from './store.ts';
import type { Window } from './transcript.ts';

// The GramJS objects the reader touches, duck-typed by `className` so tests can pass plain objects.
export interface MtEntity {
  className: string;
  id: unknown;
  accessHash?: unknown;
  /** A "min" entity carries an access hash that only works in the context it came from. */
  min?: boolean;
  /** The account is no longer in it (basic groups keep a dialog after you leave). */
  left?: boolean;
  /** A basic group that was upgraded to a supergroup. */
  deactivated?: boolean;
  restrictionReason?: { platform: string; reason: string; text: string }[];
  title?: string;
  username?: string;
  firstName?: string;
  lastName?: string;
  bot?: boolean;
  megagroup?: boolean;
  broadcast?: boolean;
  participantsCount?: number;
  verified?: boolean;
  scam?: boolean;
  fake?: boolean;
  /** Joining needs an admin's approval. */
  joinRequest?: boolean;
}

/** A button under a message, as far as the private-group flow reads it (labels; never pressed). */
export interface MtButton {
  className: string;
  text?: string;
  data?: Uint8Array;
  url?: string;
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
  /** The account was mentioned (or replied to) in this message. */
  mentioned?: boolean;
  entities?: { className: string; userId?: unknown }[];
  replyMarkup?: { className: string; rows?: { buttons: MtButton[] }[] };
  /** Posted by a person through an inline bot ("via @bot"). */
  viaBotId?: unknown;
}

/** The part of a GramJS TelegramClient the reader uses. */
export interface MtClient {
  getEntity(ref: string | number): Promise<MtEntity>;
  /** The account's own chats (also teaches GramJS the access hashes of private groups it has joined). */
  getDialogs(params: { limit?: number }): Promise<{ entity?: MtEntity; title?: string }[] & { total?: number }>;
  /**
   * messages.getHistory through GramJS: newest first by default; with `reverse`, oldest first
   * starting after `minId`; with `offsetDate`, the newest messages sent before that time.
   */
  /** Builds an input peer from a saved address, with no request (see reader-client.ts). */
  inputPeer?(p: { type: 'channel' | 'chat'; id: string; accessHash?: string }): MtEntity;
  getMessages(
    entity: MtEntity,
    params: { limit?: number; offsetId?: number; minId?: number; ids?: number[]; reverse?: boolean; offsetDate?: number },
  ): Promise<(MtMessage | undefined)[]>;
}

export interface SourceInfo {
  chatId: number;
  title: string;
  username: string | null;
  type: 'supergroup' | 'channel' | 'group';
  /** What the reader uses to find it again: @username, or the -100… id. */
  ref: string;
  members: number | null;
  /** Its saved address (JSON), so it is never resolved by name again; null when not usable. */
  peer: string | null;
}

/** A problem worth showing to the person who asked (not a crash). */
export class ReaderError extends Error {
  readonly retryAfter: number;
  /** Telegram's own error code (CHANNEL_PRIVATE, FLOOD_WAIT, …), when there was one. */
  readonly code: string;
  constructor(message: string, retryAfter = 0, code = '') {
    super(message);
    this.name = 'ReaderError';
    this.retryAfter = retryAfter;
    this.code = code;
  }
}

const big = (x: unknown): number => Number(String(x));

/** The Bot-API-style id (-100… for supergroups and channels), so watched chats and bot chats share one id space. */
export function chatIdOf(e: MtEntity): number {
  if (e.className === 'Channel' || e.className === 'ChannelForbidden') return -(1_000_000_000_000 + big(e.id));
  if (e.className === 'Chat' || e.className === 'ChatForbidden') return -big(e.id);
  return big(e.id);
}

/** The address to save for an entity (channels need a full, non-min access hash). */
export function peerOf(e: MtEntity): string | null {
  if (e.className === 'Channel' && e.accessHash !== undefined && e.accessHash !== null && !e.min) {
    return JSON.stringify({ type: 'channel', id: String(e.id), accessHash: String(e.accessHash) });
  }
  if (e.className === 'Chat') return JSON.stringify({ type: 'chat', id: String(e.id) });
  return null;
}

export type Ref =
  | { kind: 'username'; value: string }
  | { kind: 'id'; value: number }
  | { kind: 'invite'; hash: string }
  /** A folder link (t.me/addlist/…): a bundle of chats, opened only in the Telegram app. */
  | { kind: 'chatlist'; slug: string };

/**
 * Accepts @name, name, t.me/name, https://t.me/name/123, a -100… id, an invite link (t.me/+hash,
 * t.me/joinchat/hash, tg://join?invite=hash), a members-only message link (t.me/c/123/45), or a
 * folder link (t.me/addlist/slug).
 */
export function parseRef(input: string): Ref | null {
  const raw = input.trim();
  let s = raw.replace(/^https?:\/\//i, '').replace(/^(www\.)?(t|telegram)\.me\//i, '');
  const invite = /^(?:\+|joinchat\/)([A-Za-z0-9_-]{8,})/i.exec(s) ?? /^tg:\/\/join\?invite=([A-Za-z0-9_-]{8,})/i.exec(raw);
  if (invite) return { kind: 'invite', hash: invite[1] };
  if (/^\+|^joinchat\//i.test(s)) return null;
  const folder = /^addlist\/([A-Za-z0-9_-]+)/i.exec(s) ?? /^tg:\/\/addlist\?slug=([A-Za-z0-9_-]+)/i.exec(raw);
  if (folder) return { kind: 'chatlist', slug: folder[1] };
  const members = /^c\/(\d+)(?:[/?#]|$)/i.exec(s) ?? /^tg:\/\/privatepost\?channel=(\d+)/i.exec(raw);
  if (members) return { kind: 'id', value: -(1_000_000_000_000 + Number(members[1])) };
  s = s.replace(/^@/, '').replace(/^s\//, '').replace(/[/?#].*$/, '');
  if (/^-?\d+$/.test(s)) return { kind: 'id', value: Number(s) };
  if (/^[A-Za-z][A-Za-z0-9_]{3,31}$/.test(s)) return { kind: 'username', value: s };
  return null;
}

export const FOLDER_LINK =
  'This is a folder link (a bundle of chats). Open it in your Telegram app and add only the group you want; it then appears under Sources by itself. Nothing was looked up.';

/** Turns Telegram's error codes into something the owner can act on. */
export function explain(err: unknown): ReaderError {
  if (err instanceof ReaderError) return err;
  const e = err as { errorMessage?: string; message?: string; seconds?: number };
  const code = e.errorMessage ?? e.message ?? String(err);
  const raw = /^[A-Z][A-Z0-9_]+$/.test(code) ? code : '';
  const r = (message: string, retryAfter = 0) => new ReaderError(message, retryAfter, raw);
  if (typeof e.seconds === 'number' || /FLOOD_WAIT/.test(code)) {
    const s = e.seconds ?? Number(/FLOOD_WAIT_(\d+)/.exec(code)?.[1] ?? 60);
    return new ReaderError(`Telegram asked the reader account to slow down for ${s}s`, s, 'FLOOD_WAIT');
  }
  if (/WRITE_BLOCKED/.test(code)) {
    return new ReaderError('refused here: this build is read-only (it never joins, posts, presses buttons or marks anything read)', 0, 'WRITE_BLOCKED');
  }
  if (/FROZEN_METHOD_INVALID|FROZEN_PARTICIPANT_MISSING/.test(code)) {
    return r('Telegram has FROZEN the reader account: it can only appeal. Open Telegram on the phone and follow the appeal link it shows; do not retry from here');
  }
  if (/USER_DEACTIVATED_BAN/.test(code)) {
    return r('Telegram BANNED the reader account. Logging in again will not help: appeal through recover@telegram.org or @SpamBot');
  }
  if (/AUTH_KEY_DUPLICATED/.test(code)) {
    return r('the reader session was used by two processes at once and Telegram revoked it: stop the other process (another `npm start` or `npm run probe`), then run `npm run login` again');
  }
  if (/AUTH_KEY_UNREGISTERED|SESSION_REVOKED|SESSION_EXPIRED|USER_DEACTIVATED/.test(code)) {
    return r('the reader account session is no longer valid (logged out or terminated): run `npm run login` again');
  }
  if (/PEER_FLOOD|USER_RESTRICTED/.test(code)) {
    return r('Telegram has limited the reader account (spam restriction): stop joining and contacting; check @SpamBot');
  }
  if (/CHANNELS_TOO_MUCH/.test(code)) {
    return r('the reader account is in too many groups and channels (Telegram caps this): leave some first');
  }
  if (/CHANNEL_PUBLIC_GROUP_NA/.test(code)) {
    return r('this public group is not available to the account (Telegram restricts it)');
  }
  if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID|INVITE_HASH_EMPTY/.test(code)) {
    return r('this invite link no longer works (expired, revoked or mistyped)');
  }
  if (/USERNAME_NOT_OCCUPIED|USERNAME_INVALID|No user has/i.test(code)) {
    return r('no public group or channel has that username');
  }
  if (/Cannot find any entity/i.test(code)) {
    return r('Telegram did not return that chat to this account (unknown name, or not visible to it)');
  }
  if (/CHANNEL_PRIVATE/.test(code)) {
    return r('the account cannot see this chat: for a private group it must join first; for a PUBLIC group this usually means the account was banned from it (joining again will not help)');
  }
  if (/CHANNEL_INVALID|PEER_ID_INVALID/.test(code)) {
    return r('the saved address of this chat no longer works; it will be looked up again on the next read');
  }
  if (/CHAT_FORBIDDEN/.test(code)) {
    return r('the account is not allowed in this chat (removed or never a member)');
  }
  return r(code.slice(0, 200));
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
  /** Pause between history pages (default 250ms), so a big first pull does not hammer Telegram. */
  pageDelayMs?: number;
  /** Where pulls and their failures are shown (the console). */
  activity?: Activity | null;
  /** Opens a fresh connection when a pull hangs (the watchdog). */
  reconnect?: () => Promise<void>;
  /** How long one pull may take before the watchdog steps in (default 3 minutes). */
  pullTimeoutMs?: number;
  /**
   * Following the account's own chat list: groups and channels it joins become sources, ones it
   * leaves stop. Without this, sources are only what someone added by hand.
   */
  discovery?: {
    /** Start reading newly joined chats right away (otherwise they are listed, switched off). */
    autoWatch: () => boolean;
    /** Where their digests go. */
    reportTo: number | null;
    defaults: ChatDefaults;
    /**
     * How often to re-check the chat list even without a membership notice (default 1 hour).
     * Loading the chat list again and again is what Telegram punishes with the longest waits, so
     * joins are picked up from Telegram's own notices instead, and this is only the safety net.
     */
    everyMs?: number;
    /** The shortest gap between two checks a notice triggers (default 1 minute). */
    noticeGapMs?: number;
    /** Told what each check found; `first` is the first check after start (the whole backlog). */
    onReconciled?: (r: Reconciled, first: boolean) => void;
  };
  /** Every history page fetched, before it is stored (the private-group flow looks for checks addressed to the account). */
  onBatch?: (chatId: number, batch: MtMessage[]) => void;
  /** A pull failed because the account cannot see the chat any more (CHANNEL_PRIVATE / CHAT_FORBIDDEN). */
  onAccessLost?: (chatId: number, err: ReaderError) => Promise<void>;
}

/** What one chat-list check changed: chats new to the list, sources the account left, and ones it came back to. */
export interface Reconciled {
  added: SourceInfo[];
  left: ChatRow[];
  back: SourceInfo[];
}

/** A notice that something about the account's own membership changed, with what Telegram sent along. */
export interface MembershipNotice {
  /** The chat it is about (-100… / -id), when the notice names one. */
  chatId: number | null;
  /** The chat object Telegram bundled with the notice, if any (it can be a "min" copy: a hint, not proof). */
  entity: MtEntity | null;
}

/** Rejects with a ReaderError if `p` takes longer than `ms`. */
export function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ReaderError(`${what} took longer than ${Math.round(ms / 1000)}s (connection stuck?)`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const PAGE = 100;
// Pages per pull. A pull that stops at the cap is not lost: the cursor is committed page by page
// and the next pull continues from it (a busy group passed 8,000 messages a day on 2026-10-05).
const MAX_PAGES_PER_PULL = 100;

/**
 * What a source is, from the chat object Telegram returned. Refuses people, and chats Telegram
 * restricts for every client (those are not read at all).
 */
export function toSourceInfo(e: MtEntity): SourceInfo {
  if (e.className === 'User') throw new ReaderError('that is a person, not a group or channel');
  const everywhere = (e.restrictionReason ?? []).filter((r) => r.platform === 'all');
  if (everywhere.length) {
    throw new ReaderError(`Telegram restricts this chat for every client (${everywhere.map((r) => r.reason).join(', ')}: ${everywhere[0].text.slice(0, 120)}); it is not read`);
  }
  const chatId = chatIdOf(e);
  return {
    chatId,
    title: e.title ?? String(chatId),
    username: e.username ?? null,
    type: e.className === 'Channel' ? (e.broadcast ? 'channel' : 'supergroup') : 'group',
    ref: e.username ? `@${e.username}` : String(chatId),
    members: e.participantsCount ?? null,
    peer: peerOf(e),
  };
}

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
      throw new ReaderError('an invite link cannot be watched directly: check it first (the console shows how to join it in your Telegram app)');
    }
    if (ref?.kind === 'chatlist') throw new ReaderError(FOLDER_LINK);
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

  /**
   * The groups and channels the account itself is in (its chat list, archived ones included), never
   * people. `complete` is false when the list may have been cut short, so absence proves nothing.
   */
  async membership(): Promise<{ chats: SourceInfo[]; complete: boolean; skipped: string[] }> {
    const LIMIT = 1000;
    // Not GramJS's ignoreMigrated: in 2.26.22 that test is inverted (client/dialogs.js:132 keeps only
    // entities that HAVE a migratedTo field, so every supergroup and channel is dropped). Upgraded
    // basic groups are skipped below instead, by their `deactivated` flag.
    const dialogs = await this.deps.client.getDialogs({ limit: LIMIT }).catch((err) => {
      throw explain(err);
    });
    const chats: SourceInfo[] = [];
    const skipped: string[] = [];
    for (const d of dialogs) {
      const e = d.entity;
      if (!e || (e.className !== 'Channel' && e.className !== 'Chat')) continue; // people, bots, forbidden (kicked)
      if (e.left || e.deactivated) continue;
      try {
        chats.push(this.info(e));
      } catch (err) {
        skipped.push(`${e.title ?? String(e.id)}: ${(err as Error).message}`); // e.g. restricted for every client
      }
    }
    const total = typeof dialogs.total === 'number' ? dialogs.total : dialogs.length;
    return { chats, complete: dialogs.length < LIMIT && total <= dialogs.length, skipped };
  }

  async joined(): Promise<SourceInfo[]> {
    return (await this.membership()).chats;
  }

  private lastReconcile = 0;
  private reconcileCount = 0;
  private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
  private reconciling: Promise<Reconciled> | null = null;
  /** Chats a notice already sent to a chat-list check, and when (so one chat cannot keep triggering it). */
  private readonly noticed = new Map<number, number>();

  /**
   * Brings the sources in line with the account's chat list:
   *  - a group or channel the account is in but that is not a source yet becomes one, switched on
   *    when auto-watch is on (it starts 24 hours back);
   *  - a source found this way that the account is no longer in is switched off (it left, or was
   *    removed); joining it again switches it back on, unless the owner switched it off by hand;
   *  - an owner's on/off choice is never overridden, and renames are picked up.
   */
  reconcile(): Promise<Reconciled> {
    this.reconciling ??= this.reconcileOnce().finally(() => {
      this.reconciling = null;
    });
    return this.reconciling;
  }

  private async reconcileOnce(): Promise<Reconciled> {
    const d = this.deps.discovery;
    const { store, activity } = this.deps;
    if (!d) return { added: [], left: [], back: [] };
    this.lastReconcile = Date.now();
    const { chats, complete, skipped } = await this.membership();
    const added: SourceInfo[] = [];
    const left: ChatRow[] = [];
    const back: SourceInfo[] = [];
    const inList = new Set(chats.map((c) => c.chatId));
    for (const c of chats) {
      const row = store.getChat(c.chatId);
      if (row && (row.kind === 'group' || row.kind === 'report')) continue; // the bot's own chats
      if (!row) {
        if (d.reportTo === null) continue;
        const on = d.autoWatch();
        store.watchChat({ ...c }, d.reportTo, null, d.defaults);
        store.updateChat(c.chatId, { readerOrigin: 'dialog', ...(on ? {} : { enabled: false }) });
        if (!on) store.setKv(`reader_off_reason:${c.chatId}`, 'auto-watch off');
        added.push(c);
        activity?.event(
          'reader',
          'new chat',
          c.title,
          on
            ? `the account is in this ${c.type} now: reading it from 24 hours back (switch it off in the console)`
            : `the account is in this ${c.type} now; auto-watch is off, so it is listed switched off`,
        );
        continue;
      }
      // Known: pick up renames and the origin; a chat it had left and rejoined comes back on.
      store.upsertChat({ chatId: c.chatId, title: c.title, username: c.username, type: row.type }, d.defaults);
      // A private chat (no @username) can only be read as a member, so it follows the chat list. A
      // public one added before this existed stays readable from outside even if the account leaves.
      if (!c.username && row.readerOrigin !== 'dialog') store.updateChat(c.chatId, { readerOrigin: 'dialog' });
      else if (!row.readerOrigin) store.updateChat(c.chatId, { readerOrigin: 'manual' });
      if (c.peer && !row.readerPeer) store.updateChat(c.chatId, { readerPeer: c.peer });
      if (!row.enabled && store.getKv(`reader_off_reason:${c.chatId}`) === 'left') {
        store.updateChat(c.chatId, { enabled: true, readerError: null });
        store.setKv(`reader_off_reason:${c.chatId}`, '');
        store.setKv(`reader_floor:${c.chatId}`, String(this.deps.now() - 86_400));
        back.push(c);
        activity?.event('reader', 'rejoined', c.title, 'the account is back in this chat: reading again (from up to 24 hours back)');
      }
    }
    // Sources the account is not in were added by name (read from outside): never stopped by this check.
    for (const row of store.listChats(false)) {
      if (row.kind === 'watched' && !row.readerOrigin && !inList.has(row.chatId)) store.updateChat(row.chatId, { readerOrigin: 'manual' });
    }
    if (complete) {
      for (const row of store.listChats(true)) {
        if (row.kind !== 'watched' || row.readerOrigin !== 'dialog' || inList.has(row.chatId)) continue;
        store.updateChat(row.chatId, { enabled: false, readerError: 'the account is no longer in this chat (left or removed in Telegram): reading stopped' });
        store.setKv(`reader_off_reason:${row.chatId}`, 'left');
        this.entities.delete(row.chatId);
        left.push(row);
        activity?.event('reader', 'left chat', row.title, 'the account is no longer in it: reading stopped. If it is public, switch it on to read it from outside');
      }
    }
    for (const note of skipped) activity?.event('reader', 'not added', note.split(':')[0], note);
    for (const c of added) {
      if (store.getChat(c.chatId)?.enabled) void this.pull(store.getChat(c.chatId)!).catch(() => undefined); // its first 24 hours, now
    }
    try {
      d.onReconciled?.({ added, left, back }, this.reconcileCount === 0);
    } catch (err) {
      this.deps.log(`reader: after the chat list check: ${(err as Error).message}`);
    }
    this.reconcileCount++;
    return { added, left, back };
  }

  /** A membership notice arrived (joined, left, removed): re-check the chat list shortly. */
  reconcileSoon(): void {
    if (!this.deps.discovery || this.reconcileTimer) return;
    const gap = this.deps.discovery.noticeGapMs ?? 60_000;
    const wait = Math.max(Math.min(3_000, gap), gap - (Date.now() - this.lastReconcile)); // at most once a minute
    this.reconcileTimer = setTimeout(() => {
      this.reconcileTimer = null;
      void this.reconcile().catch((err) => this.deps.log(`reader: chat list check failed: ${(err as Error).message}`));
    }, wait);
    this.reconcileTimer.unref?.();
  }

  /**
   * Telegram said something changed about the account's membership somewhere. Telegram sends
   * these for routine changes too (a group's photo, its title), so the chat list is only loaded
   * when the notice can mean a join, a leave or a removal:
   *  - a chat that is not a source yet (most likely just joined);
   *  - a source the notice shows the account is no longer in (left, kicked, banned);
   *  - a source that was off because the account had left, and that it is now in again;
   *  - a notice that names no chat, or a source with no chat object bundled (cannot tell).
   * The same chat triggers at most one check an hour; the hourly check covers anything missed.
   */
  membershipNotice(n: MembershipNotice): void {
    const { store } = this.deps;
    if (!this.deps.discovery) return;
    if (n.chatId === null) return this.reconcileSoon();
    const row = store.getChat(n.chatId);
    const e = n.entity;
    const gone = Boolean(e && (e.className === 'ChannelForbidden' || e.className === 'ChatForbidden' || e.left || e.deactivated));
    let why: string | null = null;
    if (!row || row.kind !== 'watched') why = gone ? null : 'a chat that is not a source yet';
    else if (gone) why = row.readerOrigin === 'dialog' && row.enabled ? 'the account may have left or been removed' : null;
    else if (!row.enabled && store.getKv(`reader_off_reason:${n.chatId}`) === 'left') why = 'the account may be back in it';
    else if (!e) why = row.readerOrigin === 'dialog' ? 'no details came with the notice' : null;
    if (!why) return;
    const last = this.noticed.get(n.chatId) ?? 0;
    if (Date.now() - last < 3_600_000) return;
    this.noticed.set(n.chatId, Date.now());
    this.reconcileSoon();
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
    const info = toSourceInfo(e);
    this.entities.set(info.chatId, e);
    return info;
  }

  private async entity(chat: ChatRow): Promise<MtEntity> {
    const hit = this.entities.get(chat.chatId);
    if (hit) return hit;
    // The saved address: no name resolution after a restart (resolving is the scarcest budget).
    if (chat.readerPeer && this.deps.client.inputPeer) {
      try {
        const e = this.deps.client.inputPeer(JSON.parse(chat.readerPeer));
        this.entities.set(chat.chatId, e);
        return e;
      } catch {
        // unreadable: resolve below and save a fresh one
      }
    }
    const ref = parseRef(chat.readerRef ?? String(chat.chatId));
    const e = await (ref?.kind === 'username' ? this.deps.client.getEntity(ref.value) : this.byId(chat.chatId)).catch((err) => {
      throw explain(err);
    });
    this.entities.set(chat.chatId, e);
    const peer = peerOf(e);
    if (peer) this.deps.store.updateChat(chat.chatId, { readerPeer: peer });
    return e;
  }

  /** Forgets a chat's address (it went stale): the next read resolves it again. */
  forgetPeer(chatId: number): void {
    this.entities.delete(chatId);
    this.deps.store.updateChat(chatId, { readerPeer: null });
  }

  /** Chats whose last pull stopped before reaching the newest message (a long time offline). */
  private readonly behind = new Set<number>();
  private lastReconnect = 0;
  /** Chats being caught up after a gap (offline, asleep, stopped): since when, and how much came back. */
  private readonly recovering = new Map<number, { since: number; saved: number }>();
  /** Recoveries finished during the current poll round, summed up in one line at its end. */
  private roundRecovered: { chats: number; quiet: number; messages: number; since: number } | null = null;
  private readonly locks = new Map<number, Promise<unknown>>();

  /** Bumped by every reconnect: a pull from before it (stuck on the dead connection) must not commit. */
  private epoch = 0;

  /**
   * One pull at a time per chat, so two pulls never race over the cursor. A pull stuck on a dead
   * connection holds the turn for at most the pull timeout; after that the next one goes ahead.
   */
  private locked<T>(chatId: number, task: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(chatId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(task);
    this.locks.set(chatId, withTimeout(next, this.deps.pullTimeoutMs ?? 180_000, 'previous pull').catch(() => undefined));
    return next;
  }

  isBehind(chatId: number): boolean {
    return this.behind.has(chatId);
  }

  /**
   * Stores every message posted after the cursor, OLDEST FIRST, committing the cursor after each
   * page. So whatever was posted while the service was off (asleep, stopped, offline) is fetched
   * when it comes back, by the messages' own timestamps; a pull cut short (page cap, error, crash)
   * resumes exactly where it stopped and never skips a gap.
   *
   * The first pull of a chat starts 24 hours back. A cursor older than the retention period is
   * moved up to it: those messages would be deleted on arrival anyway.
   */
  pull(chat: ChatRow): Promise<number> {
    return this.locked(chat.chatId, () => this.pullLocked(chat.chatId));
  }

  private async pullLocked(chatId: number): Promise<number> {
    const { client, store, config } = this.deps;
    const epoch = this.epoch;
    const chat = store.getChat(chatId);
    if (!chat) return 0;
    const entity = await this.entity(chat);
    const now = this.deps.now();
    // A gap: the last time this chat was caught up is well over one poll ago (the service was off,
    // the computer asleep, or the network down). Count what comes back, and say so when done.
    const lastCaughtUp = Number(store.getKv(`reader_caught_up:${chatId}`) ?? 0);
    const gapAfter = Math.max(300, config.readerPollSeconds * 2.5);
    if (!this.recovering.has(chatId) && lastCaughtUp > 0 && now - lastCaughtUp > gapAfter) {
      this.recovering.set(chatId, { since: lastCaughtUp, saved: 0 });
    }
    const fail = (err: unknown): never => {
      // A saved address can go stale (CHANNEL_INVALID): forget it, so the next pull resolves afresh.
      const code = (err as { errorMessage?: string }).errorMessage ?? '';
      if (/CHANNEL_INVALID|PEER_ID_INVALID/.test(code) && chat.readerPeer) this.forgetPeer(chatId);
      throw explain(err);
    };

    let cursor = chat.readerCursor;
    const cursorDate = Number(store.getKv(`reader_cursor_date:${chatId}`) ?? NaN);
    // Switched back on after a while: start no more than 24 hours back (the owner's floor).
    const ownerFloor = Number(store.getKv(`reader_floor:${chatId}`) || 0);
    const floor = Math.max(cursor === null ? now - 86_400 : now - config.retentionDays * 86_400, ownerFloor);
    if (ownerFloor) store.setKv(`reader_floor:${chatId}`, '');
    // How far in time the capture is known to be complete: the newest message read, or the last time
    // it was caught up, whichever is later (a quiet channel's newest message can be weeks old).
    const covered = Math.max(Number.isFinite(cursorDate) ? cursorDate : 0, lastCaughtUp);
    if (cursor === null || covered < floor) {
      // The newest message from before the floor: everything after it gets fetched.
      const [before] = (await client.getMessages(entity, { limit: 1, offsetDate: floor }).catch(fail)).filter((m): m is MtMessage => Boolean(m));
      const anchor = before?.id ?? 0;
      if (cursor !== null && anchor > cursor) {
        this.deps.activity?.event('reader', 'skipped', chat.title, `messages older than ${config.retentionDays} days (retention) were not fetched`);
      }
      if (cursor === null || anchor > cursor) {
        cursor = anchor;
        store.updateChat(chatId, { readerCursor: cursor });
        store.setKv(`reader_cursor_date:${chatId}`, String(before?.date ?? floor));
      }
    }

    let saved = 0;
    let caughtUp = false;
    for (let page = 0; page < MAX_PAGES_PER_PULL; page++) {
      const from: number = cursor;
      const batch = (await client.getMessages(entity, { limit: PAGE, minId: from, reverse: true }).catch(fail))
        .filter((m): m is MtMessage => Boolean(m) && m!.id > from)
        .sort((a, b) => a.id - b.id);
      if (batch.length === 0) {
        caughtUp = true;
        break;
      }
      try {
        this.deps.onBatch?.(chatId, batch);
      } catch {
        // looking for checks addressed to the account must never stop the capture
      }
      const last = batch[batch.length - 1];
      if (epoch !== this.epoch) throw new ReaderError('pull abandoned: the connection was replaced while it was waiting');
      store.transaction(() => {
        for (const m of batch) {
          const s = toStored(m, chatId);
          if (!s) continue;
          store.upsertUser(chatId, s.author.id, s.author.name, s.author.username);
          store.saveMessage(s.message);
          saved++;
        }
        // Forward only: a late pull never moves the cursor back.
        if (last.id > (store.getChat(chatId)?.readerCursor ?? 0)) {
          store.updateChat(chatId, { readerCursor: last.id });
          store.setKv(`reader_cursor_date:${chatId}`, String(last.date));
        }
      });
      cursor = last.id;
      if (batch.length < PAGE) {
        caughtUp = true;
        break;
      }
      const pause = this.deps.pageDelayMs ?? 250;
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
    const gap = this.recovering.get(chatId);
    if (gap) gap.saved += saved;
    if (caughtUp) {
      this.behind.delete(chatId);
      store.setKv(`reader_caught_up:${chatId}`, String(now));
      if (gap) {
        this.recovering.delete(chatId);
        const minutes = Math.round((now - gap.since) / 60);
        const at = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ');
        if (gap.saved > 0) {
          this.deps.activity?.event(
            'reader',
            'recovered',
            chat.title,
            `${gap.saved} message${gap.saved === 1 ? '' : 's'} posted while it was not reading (${at(gap.since)} → ${at(now)} UTC, ${minutes} min), now stored; up to date`,
          );
        }
        const r = (this.roundRecovered ??= { chats: 0, quiet: 0, messages: 0, since: gap.since });
        r.chats++;
        r.messages += gap.saved;
        if (gap.saved === 0) r.quiet++;
        r.since = Math.min(r.since, gap.since);
      }
    } else {
      this.behind.add(chatId);
    }
    return saved;
  }

  /**
   * Checks the capture against Telegram itself: lists what Telegram has for the window (newest
   * first, independently of the cursor) and compares it with what is stored. Every message is
   * either stored, or skipped for a stated reason; anything else is reported as missing.
   */
  async audit(chat: ChatRow, since: number): Promise<{ checked: number; stored: number; bots: number; service: number; empty: number; missing: number[]; newerThanCursor: number }> {
    const { client, store } = this.deps;
    const entity = await this.entity(chat);
    const cursor = store.getChat(chat.chatId)?.readerCursor ?? 0;
    const out = { checked: 0, stored: 0, bots: 0, service: 0, empty: 0, missing: [] as number[], newerThanCursor: 0 };
    let offsetId = 0;
    for (let page = 0; page < 50; page++) {
      const batch = (await client.getMessages(entity, { limit: PAGE, offsetId }).catch((err) => {
        throw explain(err);
      })).filter((m): m is MtMessage => Boolean(m));
      if (batch.length === 0) break;
      const ids = batch.map((m) => m.id);
      const have = new Set(store.messages(chat.chatId, since - 1, this.deps.now() + 86_400).map((m) => m.messageId));
      let done = false;
      for (const m of batch) {
        if (m.date < since) {
          done = true;
          continue;
        }
        if (m.id > cursor) {
          out.newerThanCursor++; // posted after the last pull: the next pull takes it
          continue;
        }
        out.checked++;
        if (m.className === 'MessageService' || m.action) out.service++;
        else if (m.sender?.className === 'User' && m.sender.bot) out.bots++;
        else if (!describeMtMessage(m)) out.empty++;
        else if (have.has(m.id)) out.stored++;
        else out.missing.push(m.id);
      }
      if (done || batch.length < PAGE) break;
      offsetId = Math.min(...ids);
      const pause = this.deps.pageDelayMs ?? 250;
      if (pause > 0) await new Promise((r) => setTimeout(r, pause));
    }
    return out;
  }

  /** Pulls until the chat is caught up (or `budgetMs` runs out). True when caught up. */
  async catchUp(chat: ChatRow, budgetMs = 10 * 60_000): Promise<boolean> {
    const deadline = Date.now() + budgetMs;
    do {
      await this.pull(chat);
      if (!this.behind.has(chat.chatId)) return true;
    } while (Date.now() < deadline);
    return false;
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
        let retrySoon = false;
        // The chat list: on the first round, then hourly (Telegram's notices of a join trigger it sooner).
        if (this.deps.discovery && Date.now() - this.lastReconcile >= (this.deps.discovery.everyMs ?? 3_600_000)) {
          await withTimeout(this.reconcile(), 120_000, 'checking the chat list').catch((err) => log(`reader: chat list check failed: ${(err as Error).message}`));
        }
        for (const chat of store.listChats(true).filter((c) => c.kind === 'watched')) {
          if (stopped) break;
          try {
            const n = await withTimeout(this.pull(chat), this.deps.pullTimeoutMs ?? 180_000, `reading ${chat.title}`);
            if (chat.readerError) store.updateChat(chat.chatId, { readerError: null });
            if (n > 0) {
              log(`reader: ${n} new message${n === 1 ? '' : 's'} from ${chat.title}`);
              this.deps.activity?.event('reader', 'stored', chat.title, `${n} new message${n === 1 ? '' : 's'}`);
            }
          } catch (err) {
            const e = explain(err);
            store.updateChat(chat.chatId, { readerError: e.message.slice(0, 300) });
            log(`reader: ${chat.title}: ${e.message}`);
            this.deps.activity?.event('reader', 'pull failed', chat.title, e.message, false);
            if (/^(CHANNEL_PRIVATE|CHAT_FORBIDDEN)$/.test(e.code)) await this.deps.onAccessLost?.(chat.chatId, e).catch(() => undefined);
            if (e.retryAfter) await sleep(e.retryAfter * 1000);
            else if (/took longer than|Not connected|disconnected|TIMEOUT/i.test(e.message) && this.deps.reconnect) {
              // The watchdog: a hung request means a dead connection; open a new one (at most once a minute).
              const now = Date.now();
              if (now - this.lastReconnect > 60_000) {
                this.lastReconnect = now;
                this.epoch++;
                await withTimeout(this.deps.reconnect(), 120_000, 'reconnecting').catch((err) => log(`reader: reconnect failed: ${(err as Error).message}`));
              }
              retrySoon = true;
              break; // start the round again on the new connection
            }
          }
        }
        const back = this.roundRecovered;
        if (back) {
          this.roundRecovered = null;
          const minutes = Math.round((this.deps.now() - back.since) / 60);
          this.deps.activity?.event(
            'reader',
            'recovered',
            'all sources',
            `back after ${minutes} min: ${back.messages} message${back.messages === 1 ? '' : 's'} recovered across ${back.chats - back.quiet} chat${back.chats - back.quiet === 1 ? '' : 's'}; ${back.quiet} had nothing new${this.behind.size ? `; still catching up on ${this.behind.size}` : '; everything is up to date'}`,
          );
        }
        // Still catching up somewhere (back from a long time offline): go again soon.
        if (!stopped) await sleep(retrySoon ? 5_000 : this.behind.size > 0 ? 2_000 : config.readerPollSeconds * 1000 * (0.85 + Math.random() * 0.3));
      }
    };
    void loop();
    return () => {
      stopped = true;
      if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
      if (timer) clearTimeout(timer);
      wake?.();
    };
  }
}
