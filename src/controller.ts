// The controller: the console's pad, the owner's hands on Telegram. Every press that writes (a
// reply, a new message, a reaction, saving to Saved Messages, marking read, muting, leaving,
// pressing a bot's button) is one owner click: a one-shot permit lets that one request through the
// door (src/reader-client.ts). Claude's token reaches none of it (src/console/server.ts), and
// nothing here runs by itself.
//
// Each kind of write is paced and counted (PAD_LIMITS): an account that posts, reacts or presses
// fast is what Telegram's spam filters look for. On PEER_FLOOD, everything other people would see
// stops for a day. What the pad may do in a chat right now (post? which reactions? slow mode?
// muted?) is one read per chat, kept two minutes. Callback data never leaves the service: the
// page names a bot's button by its row and column.

import { Api, type TelegramClient } from 'telegram';
import { generateRandomLong, returnBigInt } from 'telegram/Helpers.js';
import type { Activity } from './activity.ts';
import { keyOf, type ChallengeKey } from './invite-rules.ts';
import { inputPeer, slowModeSeconds, type SavedPeer, type PermitWrite } from './reader-client.ts';
import { explain, type MtMessage } from './reader.ts';
import type { ChatRow, Store } from './store.ts';

export interface ControllerDeps {
  raw: TelegramClient;
  permit: PermitWrite;
  store: Store;
  activity: Activity;
  now: () => number;
  /** Reads a chat again shortly (after a post), so what was sent shows on the page. */
  pullSoon?: (chatId: number) => void;
  /** Checks the account's chat list soon (after leaving one). */
  listSoon?: () => void;
  /** Until when (ms epoch) Telegram has asked the account to wait (FLOOD_WAIT); 0 = not waiting. */
  held?: () => number;
  /** Whether the connection to Telegram is up. */
  online?: () => boolean;
}

export type PadWrite = 'send' | 'react' | 'save' | 'read' | 'mute' | 'leave' | 'press';

/** Seconds between two of a kind, and how many an hour and a day: a person's pace, not a script's. */
export const PAD_LIMITS: Record<PadWrite, { gap: number; perHour: number; perDay: number }> = {
  send: { gap: 2, perHour: 30, perDay: 200 },
  react: { gap: 1, perHour: 60, perDay: 300 },
  save: { gap: 1, perHour: 60, perDay: 300 },
  read: { gap: 1, perHour: 120, perDay: 1000 },
  mute: { gap: 1, perHour: 30, perDay: 100 },
  leave: { gap: 2, perHour: 5, perDay: 10 },
  press: { gap: 2, perHour: 30, perDay: 200 },
};
/** What other people see: stopped for a day when Telegram says PEER_FLOOD (joining too, see owner-actions.ts). */
const SEEN: PadWrite[] = ['send', 'react', 'press'];
/** The day's hold after PEER_FLOOD, shared with joining (src/owner-actions.ts). */
export const SPAM_HOLD = 'spam_hold';
const NOUN: Record<PadWrite, string> = { send: 'posts', react: 'reactions', save: 'saves', read: 'marks', mute: 'mute changes', leave: 'leaves', press: 'button presses' };
/** Telegram's limit for one message. */
export const TEXT_MAX = 4096;
const LOOK_S = 120;
const KEYS_S = 600;
const KV = 'pad_writes';
/** The same post again this soon is a double press, not a second message. */
const REPOST_S = 30;
const FOREVER = 2_147_483_647;

export interface PadChat {
  chatId: number;
  title: string;
  type: ChatRow['type'];
  username: string | null;
  /** The account is in it (a public chat can be read, and often reacted to, from outside). */
  member: boolean;
  /** Why the account cannot post here now, or null when it can. */
  sendBlock: string | null;
  /** The reactions it allows: null = every standard one, [] = none. */
  reactions: string[] | null;
  slowmode: number;
  /** With slow mode on: when the account may post again (unix seconds); 0 = now. */
  nextSendAt: number;
  muted: boolean;
  unread: number | null;
  /** Protected content: nothing can be forwarded or saved. */
  noforwards: boolean;
  members: number | null;
  /** When this was read from Telegram (unix seconds). */
  at: number;
}

export type PadResult = { ok: boolean; message: string; chat?: PadChat };

type Rights = { sendMessages?: boolean; sendPlain?: boolean; untilDate?: number } | null | undefined;
interface ChatLike {
  id?: unknown;
  title?: string;
  username?: string;
  left?: boolean;
  deactivated?: boolean;
  broadcast?: boolean;
  creator?: boolean;
  adminRights?: { postMessages?: boolean } | null;
  bannedRights?: Rights;
  defaultBannedRights?: Rights;
  noforwards?: boolean;
  participantsCount?: number;
}
/** A chat's notification settings as Telegram keeps them (muting sends them all back, changed only in muteUntil). */
interface NotifyLike {
  muteUntil?: number;
  showPreviews?: boolean;
  silent?: boolean;
  otherSound?: Api.TypeNotificationSound;
  storiesMuted?: boolean;
  storiesHideSender?: boolean;
  storiesOtherSound?: Api.TypeNotificationSound;
}
interface FullLike {
  availableReactions?: { className: string; reactions?: { className: string; emoticon?: string }[] };
  slowmodeSeconds?: number;
  slowmodeNextSendDate?: number;
  notifySettings?: NotifyLike;
  unreadCount?: number;
  participantsCount?: number;
}
interface Target {
  chat: ChatRow;
  saved: SavedPeer;
  input: Api.TypeInputPeer;
}

const hhmm = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
const fail = (message: string): PadResult => ({ ok: false, message });
/** The owner's own words, shortened for the log. */
const preview = (s: string) => {
  const one = s.replace(/\s+/g, ' ').trim();
  return one.length > 80 ? `${one.slice(0, 79)}…` : one;
};
/** One emoji (a reaction), not text. */
const EMOJI = /^(?:\p{Extended_Pictographic}|\p{Regional_Indicator})[\p{Extended_Pictographic}\p{Regional_Indicator}‍️\u{1F3FB}-\u{1F3FF}]{0,7}$/u;

/** Why the account cannot post in a chat now (from its own rights there), or null. */
export function sendBlock(c: ChatLike | undefined, now: number): string | null {
  if (!c) return null;
  if (c.left) return 'The account is not in this chat: join it first (More → Join).';
  if (c.deactivated) return 'This group is closed (it was upgraded, or deleted).';
  if (c.broadcast && !(c.creator || c.adminRights?.postMessages)) return 'A channel: only its admins post. You can react, save it or open it in Telegram.';
  const own = c.bannedRights;
  if (own && (own.sendMessages || own.sendPlain) && (!own.untilDate || own.untilDate > now)) {
    return `The group's admins have restricted the account from posting${own.untilDate && own.untilDate - now < 366 * 86_400 ? ` until ${new Date(own.untilDate * 1000).toISOString().slice(0, 16).replace('T', ' ')} UTC` : ''}.`;
  }
  const all = c.defaultBannedRights;
  if (!(c.creator || c.adminRights) && all && (all.sendMessages || all.sendPlain)) return 'Only admins can post here right now.';
  return null;
}

/** The reactions a chat allows: null = every standard one, [] = none. */
export function reactionsOf(r: FullLike['availableReactions']): string[] | null {
  if (!r || r.className === 'ChatReactionsAll') return null;
  if (r.className === 'ChatReactionsNone') return [];
  return (r.reactions ?? []).filter((x) => x.className === 'ReactionEmoji' && x.emoticon).map((x) => x.emoticon!);
}

export class Controller {
  private readonly d: ControllerDeps;
  private readonly looks = new Map<number, PadChat>();
  /** Messages whose buttons the owner opened (`chatId:msgId`): pressed from here, so the data stays here. */
  private readonly keys = new Map<string, { m: MtMessage; at: number }>();
  /** Writes on their way (a press can wait at the door): the same one is never sent twice meanwhile. */
  private readonly flying = new Set<string>();
  /** Posts that went out, by chat and text: the same one again within REPOST_S is a double press. */
  private readonly posted = new Map<string, number>();
  private readonly notify = new Map<number, NotifyLike>();

  constructor(d: ControllerDeps) {
    this.d = d;
  }

  // ── where ────────────────────────────────────────────────────────────────

  private target(chatId: number): Target | { error: string } {
    const chat = this.d.store.getChat(chatId);
    if (!chat || chat.kind !== 'watched') return { error: 'Pick one of your sources first.' };
    let saved: SavedPeer | null = null;
    try {
      saved = chat.readerPeer ? (JSON.parse(chat.readerPeer) as SavedPeer) : null;
    } catch {
      saved = null;
    }
    if (!saved) return { error: `No saved address for «${chat.title}» yet (it has not been read once): open it in Telegram instead.` };
    return { chat, saved, input: inputPeer(saved) as Api.TypeInputPeer };
  }

  /** What the pad may do in a chat right now: one read, kept two minutes (`fresh` reads it again). */
  async look(chatId: number, fresh = false): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    const kept = this.looks.get(chatId);
    if (!fresh && kept && this.d.now() - kept.at < LOOK_S) return { ok: true, message: '', chat: kept };
    try {
      const chat = t.saved.type === 'channel' ? await this.lookChannel(t) : await this.lookGroup(t);
      this.looks.set(chatId, chat);
      return { ok: true, message: '', chat };
    } catch (err) {
      return fail(this.refused(err, 'look', t.chat.title));
    }
  }

  private async lookChannel(t: Target): Promise<PadChat> {
    const res = (await this.d.raw.invoke(new Api.channels.GetFullChannel({ channel: t.input }))) as unknown as { fullChat: FullLike; chats: ChatLike[] };
    const c = res.chats.find((x) => String(x.id) === t.saved.id) ?? res.chats[0];
    return this.padChat(t, c, res.fullChat);
  }

  private async lookGroup(t: Target): Promise<PadChat> {
    const res = (await this.d.raw.invoke(new Api.messages.GetFullChat({ chatId: returnBigInt(t.saved.id) }))) as unknown as { fullChat: FullLike; chats: ChatLike[] };
    const c = res.chats.find((x) => String(x.id) === t.saved.id) ?? res.chats[0];
    return this.padChat(t, c, res.fullChat);
  }

  private padChat(t: Target, c: ChatLike | undefined, f: FullLike): PadChat {
    const now = this.d.now();
    if (f.notifySettings) this.notify.set(t.chat.chatId, f.notifySettings);
    const slowmode = f.slowmodeSeconds ?? 0;
    return {
      chatId: t.chat.chatId,
      title: c?.title ?? t.chat.title,
      type: t.chat.type,
      username: c?.username ?? t.chat.username ?? null,
      member: !c?.left,
      sendBlock: sendBlock(c, now),
      reactions: reactionsOf(f.availableReactions),
      slowmode,
      nextSendAt: slowmode && (f.slowmodeNextSendDate ?? 0) > now ? f.slowmodeNextSendDate! : 0,
      muted: (f.notifySettings?.muteUntil ?? 0) > now,
      unread: typeof f.unreadCount === 'number' ? f.unreadCount : null,
      noforwards: Boolean(c?.noforwards),
      members: f.participantsCount ?? c?.participantsCount ?? null,
      at: now,
    };
  }

  /** The pad's view of a chat after a write, without asking Telegram again. */
  private patch(chatId: number, change: Partial<PadChat>): PadChat | undefined {
    const kept = this.looks.get(chatId);
    if (!kept) return undefined;
    const next = { ...kept, ...change };
    this.looks.set(chatId, next);
    return next;
  }

  // ── pace ─────────────────────────────────────────────────────────────────

  private ration(): { at: Partial<Record<PadWrite, number[]>>; hold: { until: number; why: string } } {
    try {
      const v = JSON.parse(this.d.store.getKv(KV) ?? '') as ReturnType<Controller['ration']>;
      if (v && typeof v.at === 'object' && v.hold) return v;
    } catch {
      // nothing written yet
    }
    return { at: {}, hold: { until: 0, why: '' } };
  }

  /** Whether one more of this kind may go now, or why not. */
  budget(kind: PadWrite): string | null {
    const now = this.d.now();
    const r = this.ration();
    const hold = this.spamHold();
    if (SEEN.includes(kind) && hold.until > now) return `Nothing other people would see goes out until ${hhmm(hold.until)} UTC: ${hold.why}`;
    const L = PAD_LIMITS[kind];
    const at = r.at[kind] ?? [];
    if (at.length && now - at[at.length - 1] < L.gap) return 'One moment: the last one went just now.';
    const hour = at.filter((t) => t > now - 3600);
    if (hour.length >= L.perHour) return `${L.perHour} ${NOUN[kind]} in the last hour already: going this fast is what gets accounts limited. The next can go at ${hhmm(hour[0] + 3600)} UTC.`;
    const day = at.filter((t) => t > now - 86_400);
    if (day.length >= L.perDay) return `${L.perDay} ${NOUN[kind]} in the last day already. The next can go at ${hhmm(day[0] + 86_400)} UTC.`;
    return null;
  }

  private spend(kind: PadWrite): void {
    const now = this.d.now();
    const r = this.ration();
    r.at[kind] = [...(r.at[kind] ?? []).filter((t) => t > now - 86_400), now];
    this.d.store.setKv(KV, JSON.stringify(r));
  }

  private spamHold(): { until: number; why: string } {
    try {
      const v = JSON.parse(this.d.store.getKv(SPAM_HOLD) ?? '') as { until: number; why: string };
      if (typeof v.until === 'number') return v;
    } catch {
      // none
    }
    return { until: 0, why: '' };
  }

  private hold(seconds: number, why: string): void {
    const until = Math.max(this.spamHold().until, this.d.now() + seconds);
    this.d.store.setKv(SPAM_HOLD, JSON.stringify({ until, why }));
  }

  /** Nothing is written while Telegram has the account waiting, or while the connection is down. */
  private blocked(): string | null {
    const held = this.d.held?.() ?? 0;
    if (held > Date.now()) return `Telegram asked the account to wait until ${new Date(held).toISOString().slice(11, 19)} UTC: nothing is sent until then.`;
    if (this.d.online && !this.d.online()) return 'Telegram is not reachable right now: nothing is sent. Try again when the connection is back.';
    return null;
  }

  /** Runs one write at most once at a time: a press that is still on its way is not sent again. */
  private async once<T>(key: string, run: () => Promise<T>): Promise<T | PadResult> {
    if (this.flying.has(key)) return fail('The last press for this is still on its way (Telegram is slow, or asked the account to wait). It may still go through: it is not sent twice.');
    this.flying.add(key);
    try {
      return await run();
    } finally {
      this.flying.delete(key);
    }
  }

  /** What a refusal from Telegram means, in the owner's words (and, for PEER_FLOOD, a day's hold). */
  private refused(err: unknown, kind: PadWrite | 'look', title: string): string {
    const slowFor = slowModeSeconds(err);
    if (slowFor !== null) return `«${title}» has slow mode on: the account can post again in ${slowFor}s.`;
    const e = explain(err);
    const code = e.code || (err as { errorMessage?: string }).errorMessage || '';
    if (/PERMIT_EXPIRED/.test(code)) return 'Not sent: Telegram had the account waiting, and a press is for now, not for later. Press again if you still want it.';
    if (/OFFLINE/.test(code)) return 'Not sent: the connection to Telegram dropped. Press again when it is back.';
    if (/PEER_FLOOD/.test(code)) {
      this.hold(86_400, 'Telegram limits this account for now (it suspects spam). Check @SpamBot in your Telegram app.');
      return 'Telegram limits this account for now (it suspects spam): nothing other people would see goes out from here for a day. Check @SpamBot in your Telegram app.';
    }
    if (e.retryAfter > 0) return `Telegram asked the account to wait ${e.retryAfter}s: every request waits until then.`;
    if (/CHAT_WRITE_FORBIDDEN|CHAT_SEND_PLAIN_FORBIDDEN|CHAT_RESTRICTED/.test(code)) return `The account cannot post in «${title}».`;
    if (/USER_BANNED_IN_CHANNEL|CHANNEL_BANNED|USER_KICKED/.test(code)) return `The account is banned from «${title}».`;
    if (/CHAT_ADMIN_REQUIRED/.test(code)) return `Only «${title}»'s admins can do that.`;
    if (/USER_NOT_PARTICIPANT/.test(code)) return `The account is not in «${title}».`;
    if (/CHANNEL_PRIVATE|CHANNEL_INVALID|PEER_ID_INVALID|CHAT_ID_INVALID/.test(code)) return `The account cannot reach «${title}» (it left, was removed, or the chat is private).`;
    if (/ALLOW_PAYMENT_REQUIRED|PAYMENT_REQUIRED/.test(code)) return `Posting in «${title}» costs Stars. This page never pays: post from your Telegram app.`;
    if (/REACTION_INVALID|REACTION_EMPTY/.test(code)) return `«${title}» does not allow that reaction.`;
    if (/CHAT_FORWARDS_RESTRICTED/.test(code)) return `«${title}» protects its content: nothing can be forwarded or saved from it.`;
    if (/MESSAGE_ID_INVALID|MSG_ID_INVALID/.test(code)) return 'That message is gone (deleted, or out of reach).';
    if (/MESSAGE_TOO_LONG/.test(code)) return `Too long: Telegram takes at most ${TEXT_MAX} characters.`;
    if (/TOPIC_CLOSED/.test(code)) return 'That topic is closed.';
    if (/BOT_RESPONSE_TIMEOUT/.test(code)) return 'The bot did not answer in time; it may still have counted the press.';
    return `Telegram refused ${kind === 'look' ? 'the look' : 'it'}: ${e.message}`;
  }

  // ── writing ──────────────────────────────────────────────────────────────

  /** Posts the owner's message in a chat, or replies to one of its messages (everyone there sees it). */
  async send(chatId: number, text: string, replyTo: number | null = null): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    const message = text.replace(/\r\n?/g, '\n').trim();
    if (!message) return fail('Type the message first.');
    if (message.length > TEXT_MAX) return fail(`Too long: Telegram takes at most ${TEXT_MAX} characters (this is ${message.length}).`);
    if (replyTo !== null && !(Number.isInteger(replyTo) && replyTo > 0)) return fail('Which message? Pick it again.');
    const key = `send|${chatId}|${message}`;
    const before = this.posted.get(key);
    if (before && this.d.now() - before < REPOST_S) return fail('You posted exactly this here a moment ago: it is not posted twice. Change it to post again.');
    const off = this.blocked();
    if (off) return fail(off);
    const look = await this.look(chatId);
    if (look.chat?.sendBlock) return fail(look.chat.sendBlock);
    if (look.chat && look.chat.nextSendAt > this.d.now()) return fail(`«${t.chat.title}» has slow mode on: the account can post again in ${look.chat.nextSendAt - this.d.now()}s.`);
    const busy = this.budget('send');
    if (busy) return fail(busy);
    return this.once(key, async () => {
      const peer = t.input;
      this.d.permit('messages.SendMessage', (r) => r.peer === peer && r.message === message);
      this.spend('send');
      try {
        await this.d.raw.invoke(
          new Api.messages.SendMessage({ peer, message, randomId: generateRandomLong(), ...(replyTo ? { replyTo: new Api.InputReplyToMessage({ replyToMsgId: replyTo }) } : {}) }),
        );
      } catch (err) {
        this.looks.delete(chatId);
        return fail(this.refused(err, 'send', t.chat.title));
      }
      this.posted.set(key, this.d.now());
      if (this.posted.size > 100) this.posted.delete(this.posted.keys().next().value as string);
      const chat = look.chat?.slowmode ? this.patch(chatId, { nextSendAt: this.d.now() + look.chat.slowmode }) : look.chat;
      this.d.activity.event('owner', replyTo ? 'replied' : 'posted', t.chat.title, `${replyTo ? `to #${replyTo} · ` : ''}«${preview(message)}» · from the pad`);
      this.d.pullSoon?.(chatId);
      return { ok: true, message: replyTo ? `Replied to #${replyTo} in «${t.chat.title}».` : `Posted in «${t.chat.title}».`, chat };
    });
  }

  /** Reacts to a message with one emoji, or takes the account's reaction back (null). */
  async react(chatId: number, msgId: number, emoji: string | null): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    if (!(Number.isInteger(msgId) && msgId > 0)) return fail('Which message? Pick it again.');
    if (emoji !== null && !EMOJI.test(emoji)) return fail('A reaction is one emoji.');
    const off = this.blocked();
    if (off) return fail(off);
    const look = await this.look(chatId);
    const allowed = look.chat?.reactions;
    if (emoji && allowed && allowed.length === 0) return fail(`«${t.chat.title}» allows no reactions.`);
    if (emoji && allowed && !allowed.includes(emoji)) return fail(`«${t.chat.title}» allows only these reactions: ${allowed.join(' ')}`);
    const busy = this.budget('react');
    if (busy) return fail(busy);
    return this.once(`react|${chatId}|${msgId}`, async () => {
      const peer = t.input;
      const same = (r: Record<string, unknown>) => {
        const list = (r.reaction as { emoticon?: string }[] | undefined) ?? [];
        return emoji === null ? list.length === 0 : list.length === 1 && list[0].emoticon === emoji;
      };
      this.d.permit('messages.SendReaction', (r) => r.peer === peer && Number(r.msgId) === msgId && same(r));
      this.spend('react');
      try {
        await this.d.raw.invoke(new Api.messages.SendReaction({ peer, msgId, reaction: emoji ? [new Api.ReactionEmoji({ emoticon: emoji })] : [], addToRecent: Boolean(emoji) }));
      } catch (err) {
        return fail(this.refused(err, 'react', t.chat.title));
      }
      this.d.activity.event('owner', emoji ? 'reacted' : 'took a reaction back', t.chat.title, `${emoji ?? ''} on #${msgId} · from the pad`.trim());
      return { ok: true, message: emoji ? `Reacted ${emoji} to #${msgId}.` : `Took the reaction on #${msgId} back.`, chat: look.chat };
    });
  }

  /** Forwards a message to the account's own Saved Messages (only the owner sees it there). */
  async save(chatId: number, msgId: number): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    if (!(Number.isInteger(msgId) && msgId > 0)) return fail('Which message? Pick it again.');
    const off = this.blocked();
    if (off) return fail(off);
    const look = await this.look(chatId);
    if (look.chat?.noforwards) return fail(`«${t.chat.title}» protects its content: nothing can be forwarded or saved from it.`);
    const busy = this.budget('save');
    if (busy) return fail(busy);
    return this.once(`save|${chatId}|${msgId}`, async () => {
      const from = t.input;
      const self = new Api.InputPeerSelf();
      this.d.permit('messages.ForwardMessages', (r) => r.fromPeer === from && r.toPeer === self && Array.isArray(r.id) && r.id.length === 1 && Number(r.id[0]) === msgId);
      this.spend('save');
      try {
        await this.d.raw.invoke(new Api.messages.ForwardMessages({ fromPeer: from, id: [msgId], randomId: [generateRandomLong()], toPeer: self }));
      } catch (err) {
        return fail(this.refused(err, 'save', t.chat.title));
      }
      this.d.activity.event('owner', 'saved to Saved Messages', t.chat.title, `#${msgId} · from the pad`);
      return { ok: true, message: `Saved #${msgId} to your Saved Messages.`, chat: look.chat };
    });
  }

  /** Marks a chat read up to its newest stored message (clears the unread count on every device). */
  async markRead(chatId: number): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    const maxId = this.d.store.newestMessageId(chatId);
    if (!maxId) return fail(`Nothing stored for «${t.chat.title}» yet.`);
    const off = this.blocked();
    if (off) return fail(off);
    const look = await this.look(chatId);
    if (look.chat && !look.chat.member) return fail(`The account is not in «${t.chat.title}»: there is nothing to mark.`);
    const busy = this.budget('read');
    if (busy) return fail(busy);
    return this.once(`read|${chatId}`, async () => {
      const peer = t.input;
      this.spend('read');
      try {
        if (t.saved.type === 'channel') {
          this.d.permit('channels.ReadHistory', (r) => r.channel === peer && Number(r.maxId) === maxId);
          await this.d.raw.invoke(new Api.channels.ReadHistory({ channel: peer, maxId }));
        } else {
          this.d.permit('messages.ReadHistory', (r) => r.peer === peer && Number(r.maxId) === maxId);
          await this.d.raw.invoke(new Api.messages.ReadHistory({ peer, maxId }));
        }
      } catch (err) {
        return fail(this.refused(err, 'read', t.chat.title));
      }
      this.d.activity.event('owner', 'marked read', t.chat.title, `up to #${maxId} · from the pad`);
      return { ok: true, message: `Marked «${t.chat.title}» read, up to #${maxId}.`, chat: this.patch(chatId, { unread: 0 }) };
    });
  }

  /**
   * Mutes a chat's notifications for good, or turns them back on (on every device). Telegram keeps
   * what is sent as the whole setting, so the chat's sound, previews and stories go back as they were.
   */
  async mute(chatId: number, on: boolean): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    const off = this.blocked();
    if (off) return fail(off);
    if (!this.notify.has(chatId)) {
      const look = await this.look(chatId, true);
      if (!look.ok) return fail(look.message);
    }
    const busy = this.budget('mute');
    if (busy) return fail(busy);
    return this.once(`mute|${chatId}`, async () => {
      const peer = t.input;
      const until = on ? FOREVER : 0;
      const was = this.notify.get(chatId) ?? {};
      const settings = new Api.InputPeerNotifySettings({
        muteUntil: until,
        ...(was.showPreviews !== undefined ? { showPreviews: was.showPreviews } : {}),
        ...(was.silent !== undefined ? { silent: was.silent } : {}),
        ...(was.otherSound ? { sound: was.otherSound } : {}),
        ...(was.storiesMuted !== undefined ? { storiesMuted: was.storiesMuted } : {}),
        ...(was.storiesHideSender !== undefined ? { storiesHideSender: was.storiesHideSender } : {}),
        ...(was.storiesOtherSound ? { storiesSound: was.storiesOtherSound } : {}),
      });
      this.d.permit('account.UpdateNotifySettings', (r) => (r.peer as { peer?: unknown } | undefined)?.peer === peer && r.settings === settings);
      this.spend('mute');
      try {
        await this.d.raw.invoke(new Api.account.UpdateNotifySettings({ peer: new Api.InputNotifyPeer({ peer }), settings }));
      } catch (err) {
        return fail(this.refused(err, 'mute', t.chat.title));
      }
      this.notify.set(chatId, { ...was, muteUntil: until });
      this.d.activity.event('owner', on ? 'muted' : 'unmuted', t.chat.title, 'notifications, on every device · from the pad');
      return { ok: true, message: on ? `Muted «${t.chat.title}».` : `Notifications for «${t.chat.title}» are back on.`, chat: this.patch(chatId, { muted: on }) };
    });
  }

  /** Leaves a group or channel. The chat-list check then takes it off Sources, with its stored messages. */
  async leave(chatId: number): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    const off = this.blocked();
    if (off) return fail(off);
    const look = await this.look(chatId, true);
    if (look.chat && !look.chat.member) return fail(`The account is not in «${t.chat.title}».`);
    const busy = this.budget('leave');
    if (busy) return fail(busy);
    return this.once(`leave|${chatId}`, async () => {
      const peer = t.input;
      this.spend('leave');
      try {
        if (t.saved.type === 'channel') {
          this.d.permit('channels.LeaveChannel', (r) => r.channel === peer);
          await this.d.raw.invoke(new Api.channels.LeaveChannel({ channel: peer }));
        } else {
          const self = new Api.InputUserSelf();
          this.d.permit('messages.DeleteChatUser', (r) => String(r.chatId) === t.saved.id && r.userId === self);
          await this.d.raw.invoke(new Api.messages.DeleteChatUser({ chatId: returnBigInt(t.saved.id), userId: self }));
        }
      } catch (err) {
        return fail(this.refused(err, 'leave', t.chat.title));
      }
      this.looks.delete(chatId);
      this.d.activity.event('owner', 'left', t.chat.title, 'from the pad, on the owner\'s click');
      this.d.listSoon?.();
      return { ok: true, message: `Left «${t.chat.title}». It goes off Sources, with its stored messages, at the next chat-list check (within a minute).` };
    });
  }

  // ── a bot's buttons ──────────────────────────────────────────────────────

  /** The buttons under a message (read once): what each may do here. No callback data leaves the service. */
  async buttons(chatId: number, msgId: number): Promise<{ ok: boolean; message: string; rows?: ChallengeKey[][] }> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    if (!(Number.isInteger(msgId) && msgId > 0)) return fail('Which message? Pick it again.');
    let m: MtMessage | undefined;
    try {
      const id = [new Api.InputMessageID({ id: msgId })];
      const res = (await this.d.raw.invoke(t.saved.type === 'channel' ? new Api.channels.GetMessages({ channel: t.input, id }) : new Api.messages.GetMessages({ id }))) as unknown as { messages?: MtMessage[] };
      m = res.messages?.find((x) => x.id === msgId);
    } catch (err) {
      return fail(this.refused(err, 'look', t.chat.title));
    }
    if (!m || m.className === 'MessageEmpty') return fail('That message is gone (deleted, or out of reach).');
    const rows = m.replyMarkup?.className === 'ReplyInlineMarkup' ? (m.replyMarkup.rows ?? []).map((r, i) => r.buttons.map((b, j) => keyOf(b, i, j))) : [];
    if (rows.length === 0) return fail('That message has no buttons.');
    const key = `${chatId}:${msgId}`;
    this.keys.set(key, { m, at: this.d.now() });
    if (this.keys.size > 50) this.keys.delete(this.keys.keys().next().value as string);
    return { ok: true, message: '', rows };
  }

  /** Presses one button the owner picked: a plain callback button only, with its exact data. */
  async press(chatId: number, msgId: number, row: number, col: number): Promise<PadResult> {
    const t = this.target(chatId);
    if ('error' in t) return fail(t.error);
    const kept = this.keys.get(`${chatId}:${msgId}`);
    if (!kept || this.d.now() - kept.at > KEYS_S) return fail('Open the message\'s buttons again: they may have changed.');
    const b = kept.m.replyMarkup?.rows?.[row]?.buttons?.[col];
    const key = b ? keyOf(b, row, col) : null;
    if (!b || !key) return fail('That button is not there any more.');
    if (key.kind !== 'press') return fail(key.kind === 'telegram' ? 'That button opens Telegram: use its link.' : 'That button cannot be pressed from here: use your Telegram app.');
    const off = this.blocked();
    if (off) return fail(off);
    const busy = this.budget('press');
    if (busy) return fail(busy);
    return this.once(`press|${chatId}|${msgId}|${row}|${col}`, () => this.pressNow(t, msgId, b, key));
  }

  private async pressNow(t: Target, msgId: number, b: NonNullable<MtMessage['replyMarkup']>['rows'] extends (infer R)[] | undefined ? R extends { buttons: (infer B)[] } ? B : never : never, key: ChallengeKey): Promise<PadResult> {
    const peer = t.input;
    this.d.permit('messages.GetBotCallbackAnswer', (r) => r.peer === peer && Number(r.msgId) === msgId);
    this.spend('press');
    let answer: { message?: string; url?: string };
    try {
      answer = (await this.d.raw.invoke(new Api.messages.GetBotCallbackAnswer({ peer, msgId, data: Buffer.from(b.data ?? new Uint8Array()) }))) as unknown as typeof answer;
    } catch (err) {
      return fail(this.refused(err, 'press', t.chat.title));
    }
    const said = (answer.message ?? '').trim().slice(0, 300);
    let page = '';
    if (answer.url) {
      try {
        page = ` It also wants to open a page (${new URL(answer.url).host}): do that in your Telegram app if you trust it.`;
      } catch {
        page = ' It also wants to open a page: do that in your Telegram app if you trust it.';
      }
    }
    this.d.activity.event('owner', 'pressed a button', t.chat.title, `«${key.label}» on #${msgId} · from the pad`);
    return { ok: true, message: `Pressed «${key.label}».${said ? ` The bot said: ${said}` : ''}${page}` };
  }
}
