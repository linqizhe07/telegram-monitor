// What the owner can do from the console that writes to Telegram, each on one click: join a group
// or channel, and answer the check a group's bot puts to a new member (press its button, or type the
// answer it asks for). Each write gets through the request door only because of that click: a
// one-shot permit matching that exact request (src/reader-client.ts). Claude's token reaches none of
// this (src/console/server.ts), and nothing here runs by itself.
//
// What stays in the Telegram app, and why:
//  - Groups that approve members one by one. A request sent from here cannot be taken back, and a
//    group's guard bot may answer it with a page that only the session that sent it can open.
//  - Checks that are a page inside Telegram (Mini Apps), a login, a phone or location request, or a
//    payment. This client speaks an older version of Telegram's protocol (GramJS, layer 198), which
//    cannot show those pages; the owner's app can.
// Joins are rationed (a few an hour), likely scams are refused, and the owner's choice is sent as
// is: nothing is guessed, ranked or retried.

import { Api, type TelegramClient } from 'telegram';
import { generateRandomLong } from 'telegram/Helpers.js';
import type { Activity } from './activity.ts';
import { keyOf } from './invite-rules.ts';
import type { InviteTracker, Requester } from './invites.ts';
import type { PermitWrite } from './reader-client.ts';
import { chatIdOf, explain, FOLDER_LINK, parseRef, peerOf, type MtEntity, type MtMessage } from './reader.ts';
import type { Store } from './store.ts';

export interface OwnerActionDeps {
  raw: TelegramClient;
  permit: PermitWrite;
  store: Store;
  activity: Activity;
  tracker: InviteTracker;
  now: () => number;
  /** Chats the latest searches judged likely scams. */
  likelyScams?: () => Set<number>;
}

export interface JoinResult {
  ok: boolean;
  message: string;
  chatId?: number;
  /** joined; already (a member before); app (do it in the Telegram app: `open` opens it there); requested. */
  state?: 'joined' | 'already' | 'app' | 'requested';
  open?: string;
}

export const JOINS = { perHour: 3, perDay: 10 };
/** A typed answer: one line, as long as checks ask for (digits, a word, a short sum). */
export const ANSWER_MAX = 64;
const OWNER: Requester = { actor: 'owner', via: '' };
const KV = 'owner_joins';

export class OwnerActions {
  private readonly d: OwnerActionDeps;
  /** Per check message (`chatId:msgId`): presses and typed answers sent, and when the last of each went. */
  private readonly sent = new Map<string, { presses: number; answers: number; lastPress: number; lastAnswer: number }>();
  private readonly photos = new Map<string, Buffer>();

  constructor(d: OwnerActionDeps) {
    this.d = d;
  }

  // ── joining ──────────────────────────────────────────────────────────────

  private joins(): { at: number[]; blockedUntil: number; why: string } {
    try {
      const v = JSON.parse(this.d.store.getKv(KV) ?? '') as { at: number[]; blockedUntil: number; why: string };
      if (Array.isArray(v.at)) return v;
    } catch {
      // first join
    }
    return { at: [], blockedUntil: 0, why: '' };
  }

  /** Whether a join may go now: a few an hour and a day, none while Telegram has asked the account to hold back. */
  joinBudget(): { ok: boolean; message: string; usedHour: number; usedDay: number } {
    const now = this.d.now();
    const j = this.joins();
    const usedHour = j.at.filter((t) => t > now - 3600).length;
    const usedDay = j.at.filter((t) => t > now - 86_400).length;
    const at = (t: number) => new Date(t * 1000).toISOString().slice(11, 16);
    if (j.blockedUntil > now) return { ok: false, usedHour, usedDay, message: `No joins until ${at(j.blockedUntil)} UTC: ${j.why}` };
    if (usedHour >= JOINS.perHour) return { ok: false, usedHour, usedDay, message: `${JOINS.perHour} joins in the last hour already: joining fast is what gets accounts limited. The next can go at ${at(Math.min(...j.at.filter((t) => t > now - 3600)) + 3600)} UTC.` };
    if (usedDay >= JOINS.perDay) return { ok: false, usedHour, usedDay, message: `${JOINS.perDay} joins in the last day already. The next can go at ${at(Math.min(...j.at.filter((t) => t > now - 86_400)) + 86_400)} UTC.` };
    return { ok: true, usedHour, usedDay, message: '' };
  }

  private spentJoin(): void {
    const now = this.d.now();
    const j = this.joins();
    j.at = [...j.at.filter((t) => t > now - 86_400), now];
    this.d.store.setKv(KV, JSON.stringify(j));
  }

  private holdJoins(seconds: number, why: string): void {
    const j = this.joins();
    j.blockedUntil = Math.max(j.blockedUntil, this.d.now() + seconds);
    j.why = why;
    this.d.store.setKv(KV, JSON.stringify(j));
  }

  /** Joins a group or channel by @username, t.me link or invite link, on the owner's click. */
  async join(target: string): Promise<JoinResult> {
    const ref = parseRef(target);
    if (!ref || ref.kind === 'id') return { ok: false, message: 'Give a @username, a t.me link or an invite link.' };
    if (ref.kind === 'chatlist') return { ok: false, message: FOLDER_LINK };
    const budget = this.joinBudget();
    if (!budget.ok) return { ok: false, message: budget.message };
    return ref.kind === 'invite' ? this.joinByInvite(target, ref.hash) : this.joinByName(ref.value);
  }

  private async joinByName(username: string): Promise<JoinResult> {
    const { raw, tracker } = this.d;
    const open = `tg://resolve?domain=${username}`;
    let e: MtEntity;
    try {
      e = (await raw.getEntity(username)) as unknown as MtEntity;
    } catch (err) {
      return { ok: false, message: explain(err).message };
    }
    if (e.className !== 'Channel') return { ok: false, message: `@${username} is not a group or channel.` };
    const chatId = chatIdOf(e);
    const title = e.title ?? username;
    const refused = this.refusal(e, chatId, title);
    if (refused) return refused;
    const chat = { chatId, peer: peerOf(e), entity: e };
    if (!e.left) {
      await tracker.afterJoin(chat, OWNER);
      return { ok: true, state: 'already', chatId, message: `The account is already in «${title}»: reading it.` };
    }
    if (e.joinRequest) {
      return { ok: false, state: 'app', open, chatId, message: `«${title}» approves new members one by one: send the request from your Telegram app. A request sent from here could not be taken back, and the group's bot may answer it with a page only the app can open.` };
    }
    this.d.permit('channels.JoinChannel', (r) => r.channel === e);
    try {
      await raw.invoke(new Api.channels.JoinChannel({ channel: e as unknown as Api.Channel }));
    } catch (err) {
      const r = this.failed(err, title, open, chatId);
      if (r.state !== 'already') return r;
    }
    this.spentJoin();
    return this.joined(chat, title, null);
  }

  private async joinByInvite(target: string, hash: string): Promise<JoinResult> {
    const { raw, tracker, store } = this.d;
    const open = `tg://join?invite=${hash}`;
    const preview = await tracker.preview(target, 'owner');
    if (!('invite' in preview) || !preview.invite) return { ok: false, message: ('error' in preview && preview.error) || 'The invite link could not be checked.' };
    const inv = preview.invite;
    const title = inv.title || 'the group';
    if (inv.verdict === 'member') {
      const r = await tracker.watchMember(hash, OWNER);
      return { ok: r.ok, state: 'already', chatId: r.chatId, message: r.ok ? `The account is already in «${title}»: reading it.` : r.message };
    }
    if (inv.verdict === 'dead') return { ok: false, message: 'This invite link no longer works.' };
    if (inv.verdict === 'refused') return { ok: false, message: `Telegram marks «${title}» as a scam or fake: not joined.` };
    if (inv.verdict === 'paid') return { ok: false, state: 'app', open, message: `«${title}» charges for membership. This page never pays: decide in your Telegram app.` };
    if (inv.verdict === 'request') {
      return { ok: false, state: 'app', open, message: `«${title}» approves new members one by one: send the request from your Telegram app. A request sent from here could not be taken back, and the group's bot may answer it with a page only the app can open.` };
    }
    this.d.permit('messages.ImportChatInvite', (r) => r.hash === hash);
    let chat: MtEntity | null = null;
    try {
      const res = (await raw.invoke(new Api.messages.ImportChatInvite({ hash }))) as unknown as { chats?: MtEntity[] };
      chat = (res.chats ?? []).find((c) => c.className === 'Channel' || c.className === 'Chat') ?? null;
    } catch (err) {
      const r = this.failed(err, title, open, undefined);
      if (r.state === 'requested' && inv.id) tracker.confirm(inv.id, 'requested');
      if (r.state !== 'already') return r;
      const w = await tracker.watchMember(hash, OWNER);
      return { ok: w.ok, state: 'already', chatId: w.chatId, message: w.ok ? `The account is already in «${title}»: reading it.` : w.message };
    }
    this.spentJoin();
    if (!chat) {
      if (inv.id) tracker.confirm(inv.id, 'joined');
      return { ok: true, state: 'joined', message: `Joined «${title}». It shows up under Sources within a minute.` };
    }
    const chatId = chatIdOf(chat);
    store.updateInvite(inv.id, { said: 'joined', saidAt: this.d.now() });
    return this.joined({ chatId, peer: peerOf(chat), entity: chat }, chat.title ?? title, inv.id);
  }

  /** Why a join is refused before anything is sent, or null. */
  private refusal(e: MtEntity, chatId: number, title: string): JoinResult | null {
    if (e.scam || e.fake) return { ok: false, chatId, message: `Telegram marks «${title}» as ${e.scam ? 'SCAM' : 'FAKE'}: not joined.` };
    if (this.d.likelyScams?.().has(chatId)) return { ok: false, chatId, message: `The latest search judged «${title}» a likely scam: not joined.` };
    if ((e.restrictionReason ?? []).some((r) => r.platform === 'all')) return { ok: false, chatId, message: `Telegram restricts «${title}» for every client: not joined.` };
    return null;
  }

  private async joined(chat: { chatId: number; peer: string | null; entity: MtEntity }, title: string, inviteId: number | null): Promise<JoinResult> {
    const { tracker, activity } = this.d;
    activity.event('owner', 'joined', title, 'from the console, on the owner\'s click');
    await tracker.afterJoin(chat, OWNER, inviteId).catch(() => false);
    return {
      ok: true,
      state: 'joined',
      chatId: chat.chatId,
      message: `Joined «${title}», and reading it. If it checks new members, the check shows at the top of this page within a few seconds: answer it there, in the time it gives.`,
    };
  }

  /** What a refused join means for the owner (and for further joins). */
  private failed(err: unknown, title: string, open: string, chatId: number | undefined): JoinResult {
    const e = explain(err);
    const code = e.code || (err as { errorMessage?: string }).errorMessage || '';
    if (/USER_ALREADY_PARTICIPANT/.test(code)) return { ok: true, state: 'already', chatId, message: '' };
    if (/INVITE_REQUEST_SENT/.test(code)) {
      this.spentJoin();
      this.d.activity.event('owner', 'join request sent', title, 'Telegram turned the join into a request for the admins');
      return { ok: true, state: 'requested', chatId, message: `Telegram turned this into a request to «${title}»'s admins (it cannot be taken back). When it is approved, the group shows up under Sources by itself.` };
    }
    if (/CHANNELS_TOO_MUCH/.test(code)) return { ok: false, chatId, message: 'The account is in as many groups and channels as Telegram allows: leave some in the app first.' };
    if (/PEER_FLOOD/.test(code)) {
      this.holdJoins(86_400, 'Telegram limits this account for now (it suspects spam). Check @SpamBot in your Telegram app.');
      return { ok: false, chatId, message: 'Telegram limits this account for now (it suspects spam): no joins from here for a day. Check @SpamBot in your Telegram app.' };
    }
    if (e.retryAfter > 0) {
      this.holdJoins(e.retryAfter, `Telegram asked the account to wait ${e.retryAfter}s.`);
      return { ok: false, chatId, message: `Telegram asked the account to wait ${e.retryAfter}s before joining again.` };
    }
    if (/USER_BANNED_IN_CHANNEL|CHANNEL_BANNED|USER_KICKED/.test(code)) return { ok: false, chatId, message: `The account is banned from «${title}».` };
    if (/INVITE_HASH_EXPIRED|INVITE_HASH_INVALID/.test(code)) return { ok: false, chatId, message: 'This invite link no longer works.' };
    return { ok: false, state: 'app', open, chatId, message: `Telegram did not let the account join «${title}» from here (${e.message}). Try it in your Telegram app.` };
  }

  // ── answering a check ────────────────────────────────────────────────────

  private check(chatId: number, msgId: number): { m: MtMessage; peer: unknown; title: string } | { error: string } {
    const m = this.d.tracker.checkMessage(chatId, msgId);
    if (!m) return { error: 'That check is not open here any more (answered, deleted, or its time is over). Open the group in your Telegram app to see it.' };
    const peer = this.d.tracker.inputPeerOf(chatId);
    if (!peer) return { error: 'No saved address for this chat: answer it in your Telegram app.' };
    return { m, peer, title: this.d.store.getChat(chatId)?.title ?? 'the group' };
  }

  private pace(key: string, kind: 'presses' | 'answers'): string | null {
    const s = this.sent.get(key) ?? { presses: 0, answers: 0, lastPress: 0, lastAnswer: 0 };
    const now = Date.now();
    if (kind === 'presses' && s.presses >= 10) return 'Ten presses on this check already: finish it in your Telegram app.';
    if (kind === 'answers' && s.answers >= 5) return 'Five answers to this check already: finish it in your Telegram app.';
    const last = kind === 'answers' ? s.lastAnswer : s.lastPress;
    if (now - last < (kind === 'answers' ? 5000 : 1500)) return 'One moment: the last one went just now.';
    s[kind]++;
    if (kind === 'answers') s.lastAnswer = now;
    else s.lastPress = now;
    this.sent.set(key, s);
    return null;
  }

  /** Presses one of a check's buttons, the one the owner picked (a plain callback button only). */
  async press(chatId: number, msgId: number, row: number, col: number): Promise<{ ok: boolean; message: string }> {
    const c = this.check(chatId, msgId);
    if ('error' in c) return { ok: false, message: c.error };
    const b = c.m.replyMarkup?.rows?.[row]?.buttons?.[col];
    const key = b ? keyOf(b, row, col) : null;
    if (!b || !key) return { ok: false, message: 'That button is not on the check any more.' };
    if (key.kind !== 'press') return { ok: false, message: key.kind === 'telegram' ? 'That button opens Telegram: use the link next to it.' : 'That button cannot be pressed from here: use your Telegram app.' };
    const slow = this.pace(`${chatId}:${msgId}`, 'presses');
    if (slow) return { ok: false, message: slow };
    this.d.permit('messages.GetBotCallbackAnswer', (r) => Number(r.msgId) === msgId);
    let answer: { message?: string; url?: string; alert?: boolean };
    try {
      answer = (await this.d.raw.invoke(new Api.messages.GetBotCallbackAnswer({ peer: c.peer as Api.TypeInputPeer, msgId, data: Buffer.from(b.data ?? new Uint8Array()) }))) as unknown as typeof answer;
    } catch (err) {
      const e = explain(err);
      if (/BOT_RESPONSE_TIMEOUT/.test(e.code)) {
        this.d.tracker.answered(chatId, msgId, `pressed «${key.label}» (the bot did not reply in time; it may still have counted it)`);
        return { ok: true, message: `Pressed «${key.label}». The bot did not reply in time; it may still have counted it. The account's standing is checked again in a few seconds.` };
      }
      return { ok: false, message: /MESSAGE_ID_INVALID|DATA_INVALID/.test(e.code) ? 'The bot has removed or changed that check: look for a new one.' : e.message };
    }
    const said = (answer.message ?? '').trim().slice(0, 300);
    const page = answer.url ? ` It also wants to open a page (${hostOf(answer.url)}): do that in your Telegram app if you trust it.` : '';
    this.d.tracker.answered(chatId, msgId, `pressed «${key.label}»${said ? `; the bot said «${said}»` : ''}`);
    this.d.activity.event('owner', 'answered a check', c.title, `pressed «${key.label}»`);
    return { ok: true, message: `Pressed «${key.label}».${said ? ` The bot said: ${said}` : ''}${page}` };
  }

  /** Sends the owner's typed answer, as a reply to the check (it posts in the group: everyone there sees it). */
  async answer(chatId: number, msgId: number, text: string): Promise<{ ok: boolean; message: string }> {
    const c = this.check(chatId, msgId);
    if ('error' in c) return { ok: false, message: c.error };
    const t = text.replace(/\s+/g, ' ').trim();
    if (!t) return { ok: false, message: 'Type the answer first.' };
    if (t.length > ANSWER_MAX) return { ok: false, message: `Checks ask for short answers: at most ${ANSWER_MAX} characters.` };
    const slow = this.pace(`${chatId}:${msgId}`, 'answers');
    if (slow) return { ok: false, message: slow };
    this.d.permit('messages.SendMessage', (r) => r.message === t);
    try {
      await this.d.raw.invoke(
        new Api.messages.SendMessage({ peer: c.peer as Api.TypeInputPeer, message: t, replyTo: new Api.InputReplyToMessage({ replyToMsgId: msgId }), randomId: generateRandomLong() }),
      );
    } catch (err) {
      const e = explain(err);
      if (/CHAT_WRITE_FORBIDDEN|CHAT_SEND_PLAIN_FORBIDDEN|USER_BANNED_IN_CHANNEL/.test(e.code)) return { ok: false, message: 'The account cannot post there yet: this check is answered somewhere else (often in the bot\'s private chat). Use your Telegram app.' };
      if (/SLOWMODE_WAIT/.test(e.code)) return { ok: false, message: 'The group has slow mode on: wait a little, then send it again.' };
      if (/ALLOW_PAYMENT_REQUIRED|PAYMENT/.test(e.code)) return { ok: false, message: 'Posting there costs Stars. This page never pays: answer it in your Telegram app.' };
      return { ok: false, message: e.message };
    }
    this.d.tracker.answered(chatId, msgId, `answered «${t}»`);
    this.d.activity.event('owner', 'answered a check', c.title, `typed an answer (${t.length} characters)`);
    return { ok: true, message: `Sent «${t}» as a reply to the check. The account's standing is checked again in a few seconds.` };
  }

  /** The check's picture (a captcha image, often), read once and kept in memory. */
  async photo(chatId: number, msgId: number): Promise<Buffer | null> {
    const key = `${chatId}:${msgId}`;
    const kept = this.photos.get(key);
    if (kept) return kept;
    const m = this.d.tracker.checkMessage(chatId, msgId);
    if (!m || m.media?.className !== 'MessageMediaPhoto') return null;
    try {
      const buf = await this.d.raw.downloadMedia(m as unknown as Api.Message, {});
      if (!(buf instanceof Buffer) || buf.length === 0) return null;
      this.photos.set(key, buf);
      if (this.photos.size > 20) this.photos.delete(this.photos.keys().next().value as string);
      return buf;
    } catch {
      return null;
    }
  }
}

function hostOf(url: string): string {
  try {
    return new URL(url).host || 'a link';
  } catch {
    return 'a link';
  }
}
